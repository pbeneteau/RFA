/**
 * The account layer (RFA v0.4 spec 7.4 layer 3, v0.5 spec 18.6): ONE
 * subscription feeds every resident, every background pass and the operating
 * human's own sessions, so the concurrency cap and the rate-limit pause are
 * ACCOUNT-WIDE, never per-resident.
 *
 * Mechanism, and why this one over `data/supervisor-state.json`: residents are
 * separate processes, so admission needs a check-and-insert that two of them
 * cannot both win. `data/runs.db` is already shared by the supervisor and every
 * resident (WAL + busy_timeout) and a SQLite IMMEDIATE transaction is exactly
 * that atomicity. supervisor-state.json has a single writer by design, so it
 * can carry a pause flag but cannot hold leases the residents write without a
 * second writer and a lockfile. The pause flag lives in the same file as the
 * leases so ONE transaction decides admission, rather than two sources that can
 * disagree about whether work may start.
 *
 * The supervisor is the authority: it sets the cap, sweeps leases whose owner
 * died, and owns how long a pause lasts. It is deliberately not in the
 * admission path; an RPC to the supervisor per model turn buys nothing on one
 * laptop and adds a process that can wedge. Callers consult the table it owns.
 *
 * A lease covers one `query()` call, which is what "a model turn in flight"
 * means from outside the SDK: a query holds at most one model request open at
 * any instant, so concurrent leases are concurrent turns.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

/** Admission classes, in the priority order of v0.4 section 7.4 layer 3. */
export type Lane = "serve" | "schedule" | "background";
export const LANES: readonly Lane[] = ["serve", "schedule", "background"];

/**
 * Priority without a scheduler: the lower the priority, the more of the cap a
 * lane must leave free. `serve` (pending approvals and human-facing answers)
 * may fill the cap; `schedule` must leave one slot for a human; consolidation,
 * evals and judges must leave two. There is no queue: a denied caller retries,
 * which is what the serve loop and the background timers already do.
 */
const RESERVE: Record<Lane, number> = { serve: 0, schedule: 1, background: 2 };

/** One operator's laptop: the cap is small on purpose. Override with RFA_ACCOUNT_MAX_INFLIGHT. */
export const DEFAULT_CAP = 3;

/** A lease outlives one long turn but not a killed process. Renew from the caller's keepalive. */
const LEASE_TTL_MS = 120_000;
/** Minimum account-wide hold after a provider rate limit; the supervisor escalates from here. */
export const RATE_LIMIT_PAUSE_FLOOR_MS = 60_000;

export interface Lease {
  lease_id: string;
  agent: string;
  lane: Lane;
  run_id: string | null;
  pid: number;
  acquired_at: string;
  expires_at: string;
}

export interface Admission {
  ok: boolean;
  lease: Lease | null;
  /** Set when `ok` is false; both map to the `overloaded` refusal of spec 18.3. */
  reason?: "account_paused" | "cap_reached";
  detail?: string;
  retry_after_s?: number;
}

export interface RateLimitReport {
  id: number;
  agent: string;
  run_id: string | null;
  detail: string;
  at: string;
}

export interface AccountSnapshot {
  cap: number;
  in_flight: number;
  by_lane: Record<Lane, number>;
  by_agent: Record<string, number>;
  paused_until: string | null;
  pause_reason: string | null;
  leases: Lease[];
}

/**
 * A provider rate limit, which is an account fact and not a run fact: the next
 * run of any resident hits the same wall. Deliberately NOT matched here: 529
 * `overloaded_error` is provider capacity, which the SDK already retries and
 * which pausing the account does not help.
 */
const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests|usage limit reached|quota exceeded/i;

export function isRateLimitError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { code?: unknown }).code ?? "")}` : String(err);
  return RATE_LIMIT_RE.test(text);
}

/**
 * A credential failure: the agent cannot authenticate to its model provider.
 *
 * A different class of thing from a rate limit, and the distinction is the whole
 * point. A rate limit is a clock, so waiting fixes it; this is a state, and no
 * amount of retrying touches it. It lives beside `isRateLimitError` because one
 * module should own "what kind of provider failure is this": the resident needs it
 * to choose a refusal reason, and the observability alerts need it to notice an
 * outage that produces no statistical signal.
 *
 * Deliberately narrow. A false positive turns a transient blip into a refusal
 * nobody retries and an alert nobody can clear, which is the opposite failure and
 * just as bad, so it matches only phrasings a provider actually emits for a bad or
 * expired credential.
 */
const AUTH_FAILURE_RE = /OAuth session expired|could not be refreshed|failed to authenticate|invalid[_ ]api[_ ]key|authentication[_ ]error/i;

export function isAuthError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { code?: unknown }).code ?? "")}` : String(err);
  return AUTH_FAILURE_RE.test(text);
}

/** PID liveness beats a TTL for a local sweep; EPERM is a live process we do not own. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class AccountLedger {
  private db: Database.Database;
  private ttlMs: number;

  constructor(dbPath: string, opts: { leaseTtlMs?: number } = {}) {
    this.ttlMs = opts.leaseTtlMs ?? LEASE_TTL_MS;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_leases (
        lease_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('serve','schedule','background')),
        run_id TEXT,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_leases_expiry ON account_leases(expires_at);
      CREATE TABLE IF NOT EXISTS account_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_rate_limits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        run_id TEXT,
        detail TEXT NOT NULL,
        at TEXT NOT NULL,
        handled INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- the cap (supervisor-owned)

  /** The supervisor writes the cap; residents read it, so there is one number and not one per process. */
  setCap(n: number): void {
    if (!Number.isInteger(n) || n < 1) throw new Error(`account cap must be a positive integer, got ${n}`);
    this.put("max_in_flight", String(n));
  }

  cap(): number {
    const raw = Number(this.get("max_in_flight"));
    return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_CAP;
  }

  /** Per-lane admission ceiling. Clamped to 1 so a cap of 1 still admits every lane, one at a time. */
  laneLimit(lane: Lane, cap = this.cap()): number {
    return Math.max(1, cap - RESERVE[lane]);
  }

  // ---------------------------------------------------------------- leases

  /**
   * Take a slot for one model turn. Non-blocking: a refusal is an answer, and
   * both refusal reasons carry the numbers the `overloaded` refusal of spec 18.3
   * has to report.
   */
  acquire(req: { agent: string; lane: Lane; runId?: string | null }): Admission {
    const tx = this.db.transaction((): Admission => {
      const now = Date.now();
      this.db.prepare(`DELETE FROM account_leases WHERE expires_at <= ?`).run(new Date(now).toISOString());
      const pausedUntil = this.pausedUntilRaw();
      if (pausedUntil > now) {
        return {
          ok: false,
          lease: null,
          reason: "account_paused",
          detail: `account pickup is paused until ${new Date(pausedUntil).toISOString()}${this.get("pause_reason") ? ` (${this.get("pause_reason")})` : ""}`,
          retry_after_s: Math.max(1, Math.ceil((pausedUntil - now) / 1000)),
        };
      }
      const cap = this.cap();
      const limit = this.laneLimit(req.lane, cap);
      const inFlight = (this.db.prepare(`SELECT COUNT(*) AS n FROM account_leases`).get() as { n: number }).n;
      if (inFlight >= limit) {
        return {
          ok: false,
          lease: null,
          reason: "cap_reached",
          detail: `account concurrency cap reached for lane ${req.lane} (in_flight=${inFlight} lane_limit=${limit} cap=${cap})`,
          retry_after_s: 5,
        };
      }
      const lease: Lease = {
        lease_id: `lse_${randomBytes(6).toString("hex")}`,
        agent: req.agent,
        lane: req.lane,
        run_id: req.runId ?? null,
        pid: process.pid,
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.ttlMs).toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO account_leases (lease_id, agent, lane, run_id, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(lease.lease_id, lease.agent, lease.lane, lease.run_id, lease.pid, lease.acquired_at, lease.expires_at);
      return { ok: true, lease };
    });
    // IMMEDIATE: two residents must not both read the count and then both write.
    return tx.immediate();
  }

  /**
   * Poll until a slot frees or the deadline passes. For human-facing work, which
   * should wait for a slot rather than refuse the asker over local contention;
   * background passes use `acquire` and skip until their next tick.
   */
  async waitForSlot(
    req: { agent: string; lane: Lane; runId?: string | null },
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<Admission> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let last = this.acquire(req);
    while (!last.ok && Date.now() < deadline) {
      // A pause is measured in minutes: waiting it out inside a serve turn would
      // burn the asker's whole deadline for nothing.
      if (last.reason === "account_paused") return last;
      await sleep(Math.min(opts.pollMs ?? 1_000, Math.max(1, deadline - Date.now())));
      last = this.acquire(req);
    }
    return last;
  }

  /** Extend a lease held by a long turn. Returns false when the sweep already took it. */
  renew(leaseId: string): boolean {
    return (
      this.db
        .prepare(`UPDATE account_leases SET expires_at = ? WHERE lease_id = ?`)
        .run(new Date(Date.now() + this.ttlMs).toISOString(), leaseId).changes > 0
    );
  }

  /** Idempotent: releasing an already-swept lease is not an error. */
  release(leaseId: string): void {
    this.db.prepare(`DELETE FROM account_leases WHERE lease_id = ?`).run(leaseId);
  }

  /** Every lease an agent holds: the supervisor's drain and retirement path. */
  releaseAgent(agent: string): number {
    return this.db.prepare(`DELETE FROM account_leases WHERE agent = ?`).run(agent).changes;
  }

  inFlight(rows: Lease[] = this.leases()): { total: number; byLane: Record<Lane, number>; byAgent: Record<string, number> } {
    const byLane = { serve: 0, schedule: 0, background: 0 } as Record<Lane, number>;
    const byAgent: Record<string, number> = {};
    for (const r of rows) {
      byLane[r.lane]++;
      byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1;
    }
    return { total: rows.length, byLane, byAgent };
  }

  leases(): Lease[] {
    return this.db
      .prepare(`SELECT * FROM account_leases WHERE expires_at > ? ORDER BY acquired_at`)
      .all(new Date().toISOString()) as Lease[];
  }

  /**
   * Drop leases whose owner is gone. A SIGKILLed resident cannot release its
   * own slot, and a slot nobody is using is a slot the account has lost. PID
   * reuse only costs the lease its remaining TTL.
   */
  sweep(opts: { alive?: (pid: number) => boolean } = {}): number {
    const alive = opts.alive ?? pidAlive;
    const tx = this.db.transaction(() => {
      let dropped = this.db.prepare(`DELETE FROM account_leases WHERE expires_at <= ?`).run(new Date().toISOString()).changes;
      for (const row of this.db.prepare(`SELECT lease_id, pid FROM account_leases`).all() as { lease_id: string; pid: number }[]) {
        if (alive(row.pid)) continue;
        dropped += this.db.prepare(`DELETE FROM account_leases WHERE lease_id = ?`).run(row.lease_id).changes;
      }
      // Handled reports are kept a fortnight so a pattern is still readable.
      this.db
        .prepare(`DELETE FROM account_rate_limits WHERE handled = 1 AND at < ?`)
        .run(new Date(Date.now() - 14 * 86_400_000).toISOString());
      return dropped;
    });
    return tx.immediate();
  }

  // ---------------------------------------------------------------- the account-wide pause

  /** Account-wide, not per-resident (spec 18.6): the next run of any resident hits the same wall. */
  pause(reason: string, ms: number): { paused_until: string } {
    const until = new Date(Math.max(Date.now() + ms, this.pausedUntilRaw())).toISOString();
    const tx = this.db.transaction(() => {
      this.put("paused_until", until);
      this.put("pause_reason", reason);
    });
    tx.immediate();
    return { paused_until: until };
  }

  resume(): void {
    const tx = this.db.transaction(() => {
      this.put("paused_until", "");
      this.put("pause_reason", "");
    });
    tx.immediate();
  }

  /** Epoch ms while paused, 0 while running. */
  pausedUntil(): number {
    const until = this.pausedUntilRaw();
    return until > Date.now() ? until : 0;
  }

  pauseReason(): string | null {
    return this.get("pause_reason") || null;
  }

  /**
   * A provider rate limit, reported by whoever hit it. The report is the
   * supervisor's input: the supervisor owns the duration, escalates a repeat
   * and clears the hold. The floor applied here is a fail-safe, not the policy,
   * so the account is not hammered during the gap before the supervisor's next
   * pass; without it every other resident spends its next pickup on the same
   * wall.
   */
  reportRateLimit(report: { agent: string; runId?: string | null; detail: string }): { paused_until: string } {
    this.db
      .prepare(`INSERT INTO account_rate_limits (agent, run_id, detail, at) VALUES (?, ?, ?, ?)`)
      .run(report.agent, report.runId ?? null, report.detail.slice(0, 500), new Date().toISOString());
    return this.pause(`provider rate limit reported by ${report.agent}`, RATE_LIMIT_PAUSE_FLOOR_MS);
  }

  /** Reports the supervisor has not acted on yet. */
  pendingRateLimits(): RateLimitReport[] {
    return this.db
      .prepare(`SELECT id, agent, run_id, detail, at FROM account_rate_limits WHERE handled = 0 ORDER BY id`)
      .all() as RateLimitReport[];
  }

  markRateLimitsHandled(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE account_rate_limits SET handled = 1 WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
    tx();
  }

  /** The operator-facing view; the supervisor publishes it in supervisor-state.json. */
  snapshot(): AccountSnapshot {
    const leases = this.leases();
    const { total, byLane, byAgent } = this.inFlight(leases);
    const until = this.pausedUntil();
    return {
      cap: this.cap(),
      in_flight: total,
      by_lane: byLane,
      by_agent: byAgent,
      paused_until: until ? new Date(until).toISOString() : null,
      pause_reason: until ? this.pauseReason() : null,
      leases,
    };
  }

  // ---------------------------------------------------------------- key/value

  private put(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO account_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  private get(key: string): string {
    const row = this.db.prepare(`SELECT value FROM account_state WHERE key = ?`).get(key) as { value: string | null } | undefined;
    return row?.value ?? "";
  }

  private pausedUntilRaw(): number {
    const parsed = Date.parse(this.get("paused_until"));
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
