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
import { EFFECTIVE_DEFAULT_CAP } from "./hubdir.js";

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

/**
 * The effective account concurrency default (RFA-0.8 sect. 5 item 8), re-exported
 * from the manifest schema that owns it: the supervisor writes
 * `agents.max_inflight` into the ledger at start, and every resident reads it
 * back through `cap()`. One number, one home.
 *
 * The distinction below is not pedantry: it is load-bearing in the freeze
 * analysis of sect. 6.3, where two blocked turns at cap 2 own the operator's
 * entire account at zero model cost. Two research notes cited 3 as the effective
 * cap and were wrong.
 */
export { EFFECTIVE_DEFAULT_CAP };

/**
 * The fallback when NO supervisor has ever written the cap: a bare
 * `AccountLedger` on a fresh runs.db, a test, an `rfa` subcommand opening the
 * store in process. Deliberately not the same number as the supervised default
 * and deliberately not silent about it: an unsupervised ledger has no sweep
 * behind it either, so its cap is a different fact about a different setup, not
 * a second opinion about the same one.
 *
 * If you are reading this to answer "what is the cap here", the answer is
 * `cap()`: whatever the supervisor wrote, else this.
 */
export const UNSUPERVISED_CAP = 3;

/** A lease outlives one long turn but not a killed process. Renew from the caller's keepalive. */
const LEASE_TTL_MS = 120_000;
/**
 * How long a returning turn waits for a genuine slot before taking its lent one
 * back over the cap (sect. 6.3). Short on purpose: this is the tail of a turn
 * that has already spent money, and the alternative to a brief overshoot is a
 * long stall on a human who is waiting for the answer. Long enough that an
 * ordinary turn finishing frees a slot first, which is the common case.
 */
const UNPARK_GRACE_MS = 5_000;
/** Minimum account-wide hold after a provider rate limit; the supervisor escalates from here. */
export const RATE_LIMIT_PAUSE_FLOOR_MS = 60_000;
/**
 * The viability floor of v0.5 sect. 18.1, moved here because admission is now
 * the place that applies it (RFA-0.8 sect. 5 item 1). Not `> 0`: the SDK
 * enforces its cap BETWEEN model requests, so a two-cent remainder buys one real
 * request and returns a truncated answer. Refusing at pickup is cheaper and more
 * honest than delivering one.
 */
export const VIABLE_BUDGET_USD = 0.05;
/** How long a maintenance marker (the sect. 7 drain barrier) holds admissions off before it lapses. */
const MAINTENANCE_TTL_MS = 120_000;

/**
 * What the caller knows about its own ceiling at admission. `perDayUsd` null
 * means the pack declared none, in which case there is nothing to reserve
 * against and admission is a pure slot question - which is exactly why
 * `concurrency > 1` is gated on a declared `per_day_usd` (sect. 5 item 7).
 */
export interface BudgetRequest {
  perDayUsd?: number | null;
  perTaskUsd?: number | null;
  /** The spend day, `YYYY-MM-DD`. Injectable so a test does not depend on the wall clock. */
  day?: string;
  viableUsd?: number;
}

export function spendDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export interface Lease {
  lease_id: string;
  agent: string;
  lane: Lane;
  run_id: string | null;
  pid: number;
  acquired_at: string;
  expires_at: string;
  /**
   * When this lease PARKED its slot (RFA-0.8 sect. 6.3), else null. A parked
   * lease is a turn that is alive and blocked but is not using a model slot, so
   * it counts for nothing at admission and still counts for the sweep.
   */
  parked_at: string | null;
  /** Why it parked, for the operator's meter: `ask` or `approval`. */
  parked_reason: string | null;
  /**
   * The money this lease has RESERVED for its turn and has not settled yet
   * (RFA-0.8 sect. 5 item 1). The reservation rides the lease, so the sweep that
   * reclaims a dead resident's slot reclaims its money in the same DELETE.
   */
  reserved_usd: number;
  /** The day the reservation is drawn from, `YYYY-MM-DD`, or null when nothing was reserved. */
  spend_day: string | null;
  /**
   * `lease` for a counted slot, `maintenance` for the pack-scoped drain barrier
   * of sect. 7. Three kinds of row live in this table now (live leases, parked
   * leases, and markers) and every query says which it means.
   */
  kind: "lease" | "maintenance";
}

export interface Admission {
  ok: boolean;
  lease: Lease | null;
  /**
   * Set when `ok` is false. Every one of these maps to the `overloaded` refusal
   * of spec 18.3 on the wire; `budget_exhausted` in particular is an INTERNAL
   * admission result and never a wire refusal reason (sect. 5 item 4).
   */
  reason?: "account_paused" | "cap_reached" | "budget_exhausted" | "maintenance";
  detail?: string;
  retry_after_s?: number;
  /**
   * The ceiling this admission GRANTED, which the turn passes straight to the
   * SDK as `maxBudgetUsd`. Null when the pack declared no per-day budget, so
   * there is nothing to reserve and nothing to cap. There is deliberately no
   * second computation of this number anywhere: one transaction decides
   * admission, and it decides the ceiling with it.
   */
  granted_usd?: number | null;
}

/** One settled lease, kept after the row is deleted: the attribution of sect. 5 item 6. */
export interface Settlement {
  lease_id: string;
  agent: string;
  lane: Lane;
  run_id: string | null;
  spend_day: string;
  /** What admission granted. Null when the pack had no ceiling. */
  ceiling_usd: number | null;
  /** What the turn actually cost. */
  actual_usd: number;
  acquired_at: string;
  settled_at: string;
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
  /** Turns holding a slot. A parked turn is NOT one of these; see `parked`. */
  in_flight: number;
  /** Turns that are alive and blocked with their slot lent out (sect. 6.3). */
  parked: number;
  by_lane: Record<Lane, number>;
  by_agent: Record<string, number>;
  paused_until: string | null;
  pause_reason: string | null;
  leases: Lease[];
  /** Packs currently held off by a drain barrier (sect. 7 item 1), with why. */
  maintenance: { agent: string; reason: string; since: string; expires_at: string }[];
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
// ONE marker list, in SQL LIKE syntax, shared with ObsStore.summary's auth_errors
// query: `_` matches any single character (so invalid_api_key also matches
// "invalid api key"), `%` is an any-length gap. The regex below is DERIVED from
// this list with the same semantics, so the resident's refusal reason and the
// #ops credential alert cannot classify the same error differently: keeping them
// as two hand-written copies is exactly how they drifted apart before.
export const AUTH_FAILURE_MARKERS = [
  "OAuth session expired",
  "could not be refreshed",
  "failed to authenticate",
  "invalid_api_key",
  "authentication_error",
  // The never-authenticated host: the SDK emits "Not logged in · Please run
  // /login" (or "· Run /login"), measured on a fresh clone 2026-08-21. BOTH
  // phrases are required, in order: either alone is ordinary prose that reaches
  // this classifier through model-authored result text (resident.ts embeds up to
  // 200 chars of msg.result in the brain error), e.g. a gh tool failure saying
  // "not logged in", or the SDK's own upgrade advisory "Run /login after
  // upgrading", and a false positive here is a permanent refusal plus a
  // credential page for a credential that is fine.
  "Not logged in%run /login",
] as const;

const AUTH_FAILURE_RE = new RegExp(
  AUTH_FAILURE_MARKERS.map((m) =>
    m
      .replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
      .replace(/_/g, ".") // LIKE `_` is any single character
      .replace(/%/g, "[\\s\\S]*"), // LIKE `%` is any gap
  ).join("|"),
  "i",
);

export function isAuthError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { code?: unknown }).code ?? "")}` : String(err);
  return AUTH_FAILURE_RE.test(text);
}

/**
 * PID liveness beats a TTL for a local sweep; EPERM is a live process we do not
 * own. Exported because the engine's action-claim takeover asks the same
 * question of the same kind of holder (RFA-0.8 sect. 6.4), and two hand-written
 * copies of this are how a sweep and a claim come to disagree about who is dead.
 */
export function pidAlive(pid: number): boolean {
  // Non-positive pids are not processes, and `process.kill` does NOT treat them
  // as unknown: 0 signals the caller's whole process GROUP and -1 broadcasts, so
  // both return success and read as "alive". Measured while building the action
  // claim, which disowns a holder by writing pid 0: without this guard an
  // abandoned claim looked in-flight forever, and a lease row that ever carried
  // a 0 would never be swept.
  if (!Number.isInteger(pid) || pid <= 0) return false;
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
      -- Named cross-process single-flight (RFA-0.8 sect. 3 item 2). It lives beside
      -- the leases because it is the same kind of authority over the same file: a
      -- read-process-write that spans two model calls needs ONE holder, and the
      -- lease table is where every other cross-process authority in v0.8 lives.
      -- Distinct from a lease: a lease is a counted slot, this is a named mutex.
      CREATE TABLE IF NOT EXISTS account_locks (
        name TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        holder TEXT,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
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
    // Additive column migration for the slot park of RFA-0.8 sect. 6.3, by
    // table_info rather than by `user_version`: the Engine owns `user_version`
    // on THIS SAME FILE (runs.db), and a second counter on one database is two
    // migrators disagreeing about what version means.
    const leaseCols = this.db.prepare("PRAGMA table_info(account_leases)").all() as { name: string }[];
    const hasCol = (n: string) => leaseCols.some((c) => c.name === n);
    if (!hasCol("parked_at")) this.db.exec(`ALTER TABLE account_leases ADD COLUMN parked_at TEXT`);
    if (!hasCol("parked_reason")) this.db.exec(`ALTER TABLE account_leases ADD COLUMN parked_reason TEXT`);
    // The reservation of RFA-0.8 sect. 5 item 1, and the row kind of sect. 7
    // item 1. Same additive `table_info` migration, same reason.
    if (!hasCol("reserved_usd")) this.db.exec(`ALTER TABLE account_leases ADD COLUMN reserved_usd REAL NOT NULL DEFAULT 0`);
    if (!hasCol("spend_day")) this.db.exec(`ALTER TABLE account_leases ADD COLUMN spend_day TEXT`);
    if (!hasCol("kind")) this.db.exec(`ALTER TABLE account_leases ADD COLUMN kind TEXT NOT NULL DEFAULT 'lease'`);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_leases_parked ON account_leases(parked_at) WHERE parked_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_leases_spend ON account_leases(agent, spend_day);
      -- The settled half of the ledger (RFA-0.8 sect. 5 item 1). Admission reads
      -- this plus the live reservations above; nothing else is a source of truth
      -- about what a pack has spent today.
      CREATE TABLE IF NOT EXISTS agent_spend (
        agent TEXT NOT NULL,
        day TEXT NOT NULL,
        settled_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent, day)
      );
      -- Attribution (sect. 5 item 6): lane, granted ceiling and spend day used to
      -- die with the deleted lease row, which is exactly where parallel-overshoot
      -- forensics would have looked. The honesty check is reconciling summed
      -- observability cost against agent_spend.settled_usd; these rows say which
      -- run, lane and day each dollar came from.
      CREATE TABLE IF NOT EXISTS lease_settlements (
        lease_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        lane TEXT NOT NULL,
        run_id TEXT,
        spend_day TEXT NOT NULL,
        ceiling_usd REAL,
        actual_usd REAL NOT NULL,
        acquired_at TEXT NOT NULL,
        settled_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_settlements_day ON lease_settlements(agent, spend_day);
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
    return Number.isInteger(raw) && raw >= 1 ? raw : UNSUPERVISED_CAP;
  }

  /** True while no supervisor has written a cap, so `cap()` is the unsupervised fallback. */
  capIsFallback(): boolean {
    const raw = Number(this.get("max_in_flight"));
    return !(Number.isInteger(raw) && raw >= 1);
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
  acquire(req: { agent: string; lane: Lane; runId?: string | null; budget?: BudgetRequest }): Admission {
    const tx = this.db.transaction((): Admission => {
      const now = Date.now();
      // Expiry takes markers as well as leases: a sync that crashed between
      // `beginMaintenance` and its `finally` must not hold a pack off forever,
      // which is why the marker carries its own short TTL (sect. 7 item 1).
      this.db.prepare(`DELETE FROM account_leases WHERE expires_at <= ?`).run(new Date(now).toISOString());
      const barrier = this.maintenanceRow(req.agent);
      if (barrier) {
        return {
          ok: false,
          lease: null,
          reason: "maintenance",
          detail: `${req.agent} is held for maintenance (${barrier.parked_reason ?? "unspecified"}) until ${barrier.expires_at}`,
          retry_after_s: Math.max(1, Math.ceil((Date.parse(barrier.expires_at) - now) / 1000)),
        };
      }
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
      // Only leases HOLDING a slot count. A parked lease belongs to a turn that
      // is blocked on a nested ask or an approval card and is spending nothing
      // (sect. 6.3): counting it would be the freeze this rung exists to remove.
      const inFlight = this.liveSlotCount();
      if (inFlight >= limit) {
        return {
          ok: false,
          lease: null,
          reason: "cap_reached",
          detail: `account concurrency cap reached for lane ${req.lane} (in_flight=${inFlight} lane_limit=${limit} cap=${cap})`,
          retry_after_s: 5,
        };
      }

      /**
       * The money, decided in the SAME transaction as the slot (RFA-0.8 sect. 5
       * item 1). Before this, the per-day budget was a check at pickup and a
       * debit at completion, so the race window was the width of a whole model
       * call: under N concurrent turns all N admitted against the same stale
       * spend, and a pack with no `per_task_usd` made each run's ceiling the
       * whole day remainder (`per_day_usd: 5` at N=4 admits a 20 dollar day).
       *
       * Reservation-then-settle is the shape, and it is not a stylistic choice:
       * admission CANNOT debit actual cost, because cost is unknown until the
       * SDK's result message.
       */
      const day = req.budget?.day ?? spendDay(new Date(now));
      const perDay = req.budget?.perDayUsd ?? null;
      let granted: number | null = null;
      if (perDay != null && perDay > 0) {
        const viable = req.budget?.viableUsd ?? VIABLE_BUDGET_USD;
        const committed = this.settledUsd(req.agent, day) + this.reservedUsdFor(req.agent, day);
        const remaining = perDay - committed;
        if (remaining < viable) {
          return {
            ok: false,
            lease: null,
            reason: "budget_exhausted",
            detail:
              `daily budget exhausted for ${req.agent} (committed=$${committed.toFixed(4)} of $${perDay.toFixed(2)}, ` +
              `remaining=$${Math.max(0, remaining).toFixed(4)} under the $${viable.toFixed(2)} viability floor)`,
            retry_after_s: secondsToNextDay(now),
            granted_usd: null,
          };
        }
        granted = Math.min(req.budget?.perTaskUsd ?? remaining, remaining);
      }

      const lease: Lease = {
        lease_id: `lse_${randomBytes(6).toString("hex")}`,
        agent: req.agent,
        lane: req.lane,
        run_id: req.runId ?? null,
        pid: process.pid,
        acquired_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.ttlMs).toISOString(),
        parked_at: null,
        parked_reason: null,
        reserved_usd: granted ?? 0,
        spend_day: granted == null ? null : day,
        kind: "lease",
      };
      this.db
        .prepare(
          `INSERT INTO account_leases (lease_id, agent, lane, run_id, pid, acquired_at, expires_at, reserved_usd, spend_day, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'lease')`,
        )
        .run(
          lease.lease_id,
          lease.agent,
          lease.lane,
          lease.run_id,
          lease.pid,
          lease.acquired_at,
          lease.expires_at,
          lease.reserved_usd,
          lease.spend_day,
        );
      return { ok: true, lease, granted_usd: granted };
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
    req: { agent: string; lane: Lane; runId?: string | null; budget?: BudgetRequest },
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<Admission> {
    const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
    let last = this.acquire(req);
    while (!last.ok && Date.now() < deadline) {
      // Two refusals no amount of waiting fixes, so waiting them out would burn
      // the asker's whole deadline for nothing:
      //  - a pause is measured in minutes and is account-wide;
      //  - budget exhaustion clears at midnight (sect. 5 item 5 requires the
      //    immediate return explicitly, exactly as for a paused account).
      // `maintenance` is deliberately NOT here: the drain barrier is short by
      // construction and queueing behind it is the whole point (sect. 7 item 1).
      if (last.reason === "account_paused" || last.reason === "budget_exhausted") return last;
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

  /**
   * Renew EVERY lease the caller still holds, and say which ones are already
   * gone (RFA-0.8 sect. 3 item 3).
   *
   * A keepalive that renews one lease is correct only while a process can hold
   * one. Under two concurrent turns a single current-lease cell means the
   * keepalive renews the newest and the older expires MID-TURN, is swept, and its
   * slot is handed out again: effective concurrency silently rises past the cap,
   * which is the failure the cap exists to prevent. This is what makes overlap
   * legal rather than merely forbidden.
   */
  renewAll(leaseIds: Iterable<string>): { renewed: string[]; lost: string[] } {
    const renewed: string[] = [];
    const lost: string[] = [];
    const stmt = this.db.prepare(`UPDATE account_leases SET expires_at = ? WHERE lease_id = ?`);
    const until = new Date(Date.now() + this.ttlMs).toISOString();
    const tx = this.db.transaction(() => {
      for (const id of leaseIds) {
        if (stmt.run(until, id).changes > 0) renewed.push(id);
        else lost.push(id);
      }
    });
    tx.immediate();
    return { renewed, lost };
  }

  // ---------------------------------------------------------------- the slot park (RFA-0.8 sect. 6.3)

  /**
   * Lend this lease's SLOT while its turn is blocked, keeping the row.
   *
   * A blocked turn holds its account slot today, both across a nested ask and
   * across an approval-card wait, which block identically. That is the whole
   * freeze: at the effective cap of 2 (`EFFECTIVE_DEFAULT_CAP`), two blocked
   * turns own the operator's entire account for the length of a reply window at
   * ZERO model cost. It is also the stated precondition for admitting any remote
   * peer into a room whose local members make nested asks (sect. 13 item 4),
   * because provoking a depth-2 chain costs the peer one request inside its own
   * rate budget and costs the operator everything.
   *
   * DOWNGRADE, NOT RELEASE, and this is the deliberate decision sect. 6.3 leaves
   * open. The SDK enforces its budgets BETWEEN model requests, so a turn that
   * fully released its lease and then had to win a fresh admission on the way
   * back could die on `waitForSlot` AFTER the model had already spent the
   * operator's money: the worst of both, a bill and no answer. Keeping the row
   * makes the return a state flip on a row this process already owns, which
   * cannot be refused. The three alternatives and why not:
   *   - a reserved re-entry (hold a slot back for the returning turn) is just a
   *     slower version of not lending it at all, since the reservation is
   *     exactly the capacity the lend was supposed to free;
   *   - re-acquiring on return is the failure above, priced in tokens;
   *   - accepting the freeze with an honest refusal is what HEAD already does,
   *     and the refusal is honest but the account is still frozen.
   *
   * The price, stated rather than hidden: `unpark` can push the account
   * transiently over the cap (see there). Presence and the heartbeat are NOT
   * touched by any of this. They are a different clock, and a blocked resident
   * that stops renewing looks `gone_quiet`, which was found live in v0.4.6 when
   * a scribe was SIGTERMed 38 seconds after a human approved its save. Only the
   * slot is lent; the keepalive keeps renewing a parked lease exactly as before.
   *
   * Returns false when the row is already gone (swept, or released by the
   * caller), which is not an error: the caller simply has no slot to lend.
   */
  park(leaseId: string, reason: string): boolean {
    return (
      this.db
        .prepare(`UPDATE account_leases SET parked_at = ?, parked_reason = ? WHERE lease_id = ? AND kind = 'lease' AND parked_at IS NULL`)
        .run(new Date().toISOString(), reason.slice(0, 64), leaseId).changes > 0
    );
  }

  /**
   * Take the slot back when the blocked wait returns.
   *
   * This never fails the turn, by construction. Three outcomes:
   *
   *  1. The row is still ours and capacity exists: clear the park, done.
   *  2. The row is still ours and the account is FULL: wait up to `graceMs` for
   *     a genuine slot, then take it anyway and report `overshoot: true`. The
   *     overshoot is real and bounded: at most one park per resident process
   *     while the turn lock holds one turn per process, so the account can sit
   *     at cap + (parked residents returning) for the tail of those turns. That
   *     is a smaller and shorter violation than the freeze it replaces, and it
   *     is visible in `snapshot().parked` and in the caller's log rather than
   *     inferred. Rung 3 narrows the turn lock to one turn per SESSION; when it
   *     does, this bound is the thing it has to keep.
   *  3. The row is GONE (the sweep took it, or the process was out of the table
   *     long enough for its TTL to lapse): try one honest admission for a fresh
   *     lease within the same grace, and if that is refused, return `ok: false`
   *     so the caller proceeds UNSLOTTED with a loud log. A turn that has
   *     already spent tokens is never killed for want of bookkeeping.
   */
  async unpark(
    leaseId: string,
    opts: { graceMs?: number; pollMs?: number; agent?: string; lane?: Lane; runId?: string | null } = {},
  ): Promise<{ ok: boolean; overshoot: boolean; leaseId: string | null; detail?: string }> {
    const row = this.db.prepare(`SELECT * FROM account_leases WHERE lease_id = ?`).get(leaseId) as Lease | undefined;
    if (!row) {
      // Outcome 3: our row is gone. Ask for a new one, honestly, then give up
      // rather than throw.
      if (!opts.agent) return { ok: false, overshoot: false, leaseId: null, detail: "lease gone and no agent given to re-acquire" };
      const again = await this.waitForSlot(
        { agent: opts.agent, lane: opts.lane ?? "serve", runId: opts.runId ?? null },
        { timeoutMs: opts.graceMs ?? UNPARK_GRACE_MS, pollMs: opts.pollMs ?? 250 },
      );
      return again.ok && again.lease
        ? { ok: true, overshoot: false, leaseId: again.lease.lease_id }
        : { ok: false, overshoot: false, leaseId: null, detail: again.detail ?? "no slot after the lease was swept" };
    }
    if (!row.parked_at) return { ok: true, overshoot: false, leaseId };

    const deadline = Date.now() + (opts.graceMs ?? UNPARK_GRACE_MS);
    const limit = this.laneLimit(row.lane);
    while (this.liveSlotCount() >= limit && Date.now() < deadline) {
      await sleep(Math.min(opts.pollMs ?? 250, Math.max(1, deadline - Date.now())));
    }
    const overshoot = this.liveSlotCount() >= limit;
    // Unconditional: the row is ours and the turn has already paid for it.
    this.db.prepare(`UPDATE account_leases SET parked_at = NULL, parked_reason = NULL WHERE lease_id = ?`).run(leaseId);
    return {
      ok: true,
      overshoot,
      leaseId,
      ...(overshoot ? { detail: `resumed over the cap (lane ${row.lane} limit ${limit}); the slot was lent and is being taken back` } : {}),
    };
  }

  // ------------------------------------------------- the two counts, and why they differ

  /**
   * SLOTS in use: what the cap counts. Parked rows are EXCLUDED, because a parked
   * turn is blocked and is spending nothing (sect. 6.3), and markers are excluded
   * because they are not turns.
   *
   * Read this next to `reservedUsdFor` below. The two must disagree about a
   * parked row and one query for both would get one of them wrong: a parked lease
   * has freed its SLOT but not its MONEY, because the turn will resume and spend.
   */
  private liveSlotCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM account_leases WHERE kind = 'lease' AND parked_at IS NULL`).get() as { n: number }).n;
  }

  /**
   * MONEY reserved and not yet settled, for one pack on one day: what admission
   * counts. Parked rows are INCLUDED, for the reason stated above. See
   * `liveSlotCount`; the asymmetry is deliberate and is the sharpest interaction
   * between rungs 2 and 3.
   */
  private reservedUsdFor(agent: string, day: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(reserved_usd), 0) AS usd FROM account_leases WHERE kind = 'lease' AND agent = ? AND spend_day = ?`)
      .get(agent, day) as { usd: number };
    return row.usd;
  }

  /** The maintenance marker holding this pack off, if any (sect. 7 item 1). */
  private maintenanceRow(agent: string): Lease | undefined {
    return this.db
      .prepare(`SELECT * FROM account_leases WHERE kind = 'maintenance' AND agent = ? AND expires_at > ? LIMIT 1`)
      .get(agent, new Date().toISOString()) as Lease | undefined;
  }

  private settledUsd(agent: string, day: string): number {
    const row = this.db.prepare(`SELECT settled_usd FROM agent_spend WHERE agent = ? AND day = ?`).get(agent, day) as
      | { settled_usd: number }
      | undefined;
    return row?.settled_usd ?? 0;
  }

  // ---------------------------------------------------------------- release and settle

  /**
   * Give the slot back and SETTLE the money, in one transaction (sect. 5 item 1).
   *
   * `actualUsd` is what the turn really cost, known only at the SDK's result
   * message. Omitting it settles nothing and simply frees the reservation, which
   * is the right answer for the paths that release a lease without ever having
   * run a turn (shutdown, a drain, an admission that threw before the query).
   * Back-filling a swept lease's cost from `runs.cost_usd` is PARKED
   * (Appendix A), so a killed resident's spend is under-counted until then, and
   * that is visible rather than silent: the settlement row is simply absent.
   *
   * Idempotent: releasing an already-swept lease is not an error, and a second
   * call cannot double-count because the row is gone.
   */
  release(leaseId: string, actualUsd?: number): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM account_leases WHERE lease_id = ?`).get(leaseId) as Lease | undefined;
      if (!row) return;
      const cost = Number.isFinite(actualUsd) ? Math.max(0, actualUsd as number) : 0;
      const day = row.spend_day ?? spendDay();
      if (cost > 0 || row.reserved_usd > 0) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO agent_spend (agent, day, settled_usd, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(agent, day) DO UPDATE SET settled_usd = settled_usd + excluded.settled_usd, updated_at = excluded.updated_at`,
          )
          .run(row.agent, day, cost, now);
        this.db
          .prepare(
            `INSERT OR REPLACE INTO lease_settlements (lease_id, agent, lane, run_id, spend_day, ceiling_usd, actual_usd, acquired_at, settled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(row.lease_id, row.agent, row.lane, row.run_id, day, row.reserved_usd || null, cost, row.acquired_at, now);
      }
      // Deleting the row frees whatever it still reserved: the reservation rides
      // the lease, which is what makes the sweep reclaim money for free.
      this.db.prepare(`DELETE FROM account_leases WHERE lease_id = ?`).run(leaseId);
    });
    tx.immediate();
  }

  /** Every lease an agent holds: the supervisor's drain and retirement path. */
  releaseAgent(agent: string): number {
    return this.db.prepare(`DELETE FROM account_leases WHERE agent = ? AND kind = 'lease'`).run(agent).changes;
  }

  /** What this pack has SETTLED today: the display number, and the honesty check's left-hand side. */
  daySpend(agent: string, day = spendDay()): { settled_usd: number; reserved_usd: number; day: string } {
    return { settled_usd: this.settledUsd(agent, day), reserved_usd: this.reservedUsdFor(agent, day), day };
  }

  /**
   * Spend that never held a lease of its own, added to the same day ledger.
   * There is one caller and it should stay that way: it exists so a cost the
   * account did not admit cannot become a second, disagreeing source of truth
   * about what a pack spent today.
   */
  recordSpend(agent: string, usd: number, day = spendDay()): void {
    if (!(usd > 0)) return;
    this.db
      .prepare(
        `INSERT INTO agent_spend (agent, day, settled_usd, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent, day) DO UPDATE SET settled_usd = settled_usd + excluded.settled_usd, updated_at = excluded.updated_at`,
      )
      .run(agent, day, usd, new Date().toISOString());
  }

  settlements(agent: string, day = spendDay()): Settlement[] {
    return this.db
      .prepare(`SELECT * FROM lease_settlements WHERE agent = ? AND spend_day = ? ORDER BY settled_at`)
      .all(agent, day) as Settlement[];
  }

  // ---------------------------------------------------------------- the drain barrier (sect. 7)

  /**
   * Hold new turn admissions for one pack while an operator action rewrites what
   * its turns are reading (`rfa knowledge sync`, RFA-0.8 sect. 7 item 1).
   *
   * The marker is a row in THIS table because this table is the one cross-process
   * authority on "a turn is in flight"; a second mechanism would have to agree
   * with it, and two authorities that can disagree is the failure this module's
   * header is about. It carries its own short TTL so a sync killed between here
   * and its `finally` cannot wedge the pack: the next `acquire` expires it.
   */
  beginMaintenance(agent: string, reason: string, opts: { ttlMs?: number } = {}): { ok: boolean; token: string | null; detail?: string } {
    const tx = this.db.transaction((): { ok: boolean; token: string | null; detail?: string } => {
      const now = Date.now();
      this.db.prepare(`DELETE FROM account_leases WHERE expires_at <= ?`).run(new Date(now).toISOString());
      const existing = this.maintenanceRow(agent);
      if (existing) return { ok: false, token: null, detail: `${agent} is already held (${existing.parked_reason ?? "unspecified"}) until ${existing.expires_at}` };
      const token = `mnt_${randomBytes(6).toString("hex")}`;
      this.db
        .prepare(
          `INSERT INTO account_leases (lease_id, agent, lane, run_id, pid, acquired_at, expires_at, reserved_usd, spend_day, kind, parked_reason)
           VALUES (?, ?, 'background', NULL, ?, ?, ?, 0, NULL, 'maintenance', ?)`,
        )
        .run(token, agent, process.pid, new Date(now).toISOString(), new Date(now + (opts.ttlMs ?? MAINTENANCE_TTL_MS)).toISOString(), reason.slice(0, 120));
      return { ok: true, token };
    });
    return tx.immediate();
  }

  endMaintenance(agent: string, token: string): void {
    this.db.prepare(`DELETE FROM account_leases WHERE lease_id = ? AND agent = ? AND kind = 'maintenance'`).run(token, agent);
  }

  /** Turns still in flight for this pack: what a drain waits on. Markers are not turns. */
  liveLeasesFor(agent: string): Lease[] {
    return this.db
      .prepare(`SELECT * FROM account_leases WHERE kind = 'lease' AND agent = ? AND expires_at > ? ORDER BY acquired_at`)
      .all(agent, new Date().toISOString()) as Lease[];
  }

  /**
   * Wait for a pack's turns to finish. Bounded, always: a resident that renews a
   * long turn's lease would otherwise hold an operator command open forever, and
   * a crashed one is handled by the TTL rather than by hope. The caller decides
   * what a timeout means; `rfa knowledge sync` skips the pack and says so, which
   * is the honest answer for a command whose whole job is to not tear a corpus.
   */
  async drain(agent: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<{ drained: boolean; remaining: Lease[] }> {
    const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
    let remaining = this.liveLeasesFor(agent);
    while (remaining.length > 0 && Date.now() < deadline) {
      await sleep(Math.min(opts.pollMs ?? 250, Math.max(1, deadline - Date.now())));
      remaining = this.liveLeasesFor(agent);
    }
    return { drained: remaining.length === 0, remaining };
  }

  // ---------------------------------------------------------------- named single-flight

  /**
   * Take a NAMED cross-process lock, or be refused (RFA-0.8 sect. 3 item 2).
   *
   * Consolidation is a read-process-write around two model calls: it reads a
   * watermark, spends money, then writes the watermark back. Two processes doing
   * that at once both pay and both apply; single-flight-by-hope is what the
   * resident's timer and `rfa agent reflect --apply` relied on. Refused rather
   * than queued, because every caller is an idle timer that comes back.
   *
   * Staleness is decided by a DIRECT state check first (is the holder's pid
   * alive) and the TTL only as the backstop, the same order the lease sweep uses:
   * a holder that died must not hold a name for the length of a TTL, and a holder
   * that is alive must not lose one just because a turn ran long.
   */
  takeSingleFlight(name: string, opts: { ttlMs?: number; holder?: string } = {}): { ok: boolean; token: string | null; heldBy?: string; detail?: string } {
    const ttl = opts.ttlMs ?? this.ttlMs;
    const tx = this.db.transaction((): { ok: boolean; token: string | null; heldBy?: string; detail?: string } => {
      const now = Date.now();
      const row = this.db.prepare(`SELECT * FROM account_locks WHERE name = ?`).get(name) as
        | { name: string; token: string; holder: string | null; pid: number; expires_at: string }
        | undefined;
      if (row) {
        const dead = !pidAlive(row.pid);
        const expired = Date.parse(row.expires_at) <= now;
        if (!dead && !expired) {
          return {
            ok: false,
            token: null,
            heldBy: row.holder ?? String(row.pid),
            detail: `${name} is held by pid ${row.pid}${row.holder ? ` (${row.holder})` : ""} until ${row.expires_at}`,
          };
        }
        this.db.prepare(`DELETE FROM account_locks WHERE name = ?`).run(name);
      }
      const token = `sfl_${randomBytes(8).toString("hex")}`;
      this.db
        .prepare(`INSERT INTO account_locks (name, token, holder, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(name, token, opts.holder ?? null, process.pid, new Date(now).toISOString(), new Date(now + ttl).toISOString());
      return { ok: true, token };
    });
    return tx.immediate();
  }

  /** Extend a held name. False means it was taken away (dead pid or lapsed TTL), so the holder must stop. */
  renewSingleFlight(name: string, token: string, ttlMs?: number): boolean {
    return (
      this.db
        .prepare(`UPDATE account_locks SET expires_at = ? WHERE name = ? AND token = ?`)
        .run(new Date(Date.now() + (ttlMs ?? this.ttlMs)).toISOString(), name, token).changes > 0
    );
  }

  /** Idempotent, and token-fenced: a lapsed holder cannot release the name its successor now holds. */
  releaseSingleFlight(name: string, token: string): void {
    this.db.prepare(`DELETE FROM account_locks WHERE name = ? AND token = ?`).run(name, token);
  }

  /**
   * What is actually running. Parked leases are counted separately, not folded
   * in: a meter that reports a blocked turn as in-flight tells the operator the
   * account is busy when it is idle, which is the same lie the freeze told.
   */
  inFlight(rows: Lease[] = this.leases()): { total: number; parked: number; byLane: Record<Lane, number>; byAgent: Record<string, number> } {
    const byLane = { serve: 0, schedule: 0, background: 0 } as Record<Lane, number>;
    const byAgent: Record<string, number> = {};
    let total = 0;
    let parked = 0;
    for (const r of rows) {
      if (r.parked_at) {
        parked++;
        continue;
      }
      total++;
      byLane[r.lane]++;
      byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1;
    }
    return { total, parked, byLane, byAgent };
  }

  /** Live TURNS. Maintenance markers share the table and are not turns; every caller here means turns. */
  leases(): Lease[] {
    return this.db
      .prepare(`SELECT * FROM account_leases WHERE kind = 'lease' AND expires_at > ? ORDER BY acquired_at`)
      .all(new Date().toISOString()) as Lease[];
  }

  /** Live maintenance markers, for the operator's meter. */
  maintenance(): { agent: string; reason: string; since: string; expires_at: string }[] {
    return (
      this.db
        .prepare(`SELECT * FROM account_leases WHERE kind = 'maintenance' AND expires_at > ? ORDER BY acquired_at`)
        .all(new Date().toISOString()) as Lease[]
    ).map((r) => ({ agent: r.agent, reason: r.parked_reason ?? "unspecified", since: r.acquired_at, expires_at: r.expires_at }));
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
      // Named locks whose holder is gone, on the same direct state check. Without
      // this a killed consolidation holds its name until the TTL lapses, and at
      // zero traffic nothing else would ever look.
      for (const row of this.db.prepare(`SELECT name, pid, expires_at FROM account_locks`).all() as { name: string; pid: number; expires_at: string }[]) {
        if (alive(row.pid) && Date.parse(row.expires_at) > Date.now()) continue;
        dropped += this.db.prepare(`DELETE FROM account_locks WHERE name = ?`).run(row.name).changes;
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
    const { total, parked, byLane, byAgent } = this.inFlight(leases);
    const until = this.pausedUntil();
    return {
      cap: this.cap(),
      in_flight: total,
      parked,
      by_lane: byLane,
      by_agent: byAgent,
      paused_until: until ? new Date(until).toISOString() : null,
      pause_reason: until ? this.pauseReason() : null,
      leases,
      maintenance: this.maintenance(),
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

/**
 * How long until the day budget resets. Budget exhaustion IS transient, unlike a
 * bad credential, so the refusal carries an honest hint rather than none: an
 * asker that reads `retry_after_s` learns "tomorrow", which is the truth.
 */
function secondsToNextDay(nowMs: number): number {
  const now = new Date(nowMs);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}
