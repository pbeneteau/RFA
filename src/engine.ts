/**
 * The durable engine (RFA v0.4 spec section 4.3): runs, steps, and schedules
 * in one SQLite file (WAL). Field names and enums are adopted from LangGraph
 * so a later Postgres swap is a driver change on identical schemas; the step
 * journal follows Inngest/Restate replay semantics (a step id runs its
 * function once, ever; replays return the journaled result); schedules copy
 * Cloudflare's Agents API verbatim.
 *
 * Multi-process safe: WAL + busy_timeout; the supervisor and every resident
 * may share the file. Durable runs only wait and spawn; side effects live in
 * journaled steps (Hatchet's doctrine, spec 4.3).
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { Cron } from "croner";
import { pidAlive } from "./account.js";
import { effectClassOf, mayRetryUnsettled } from "./actionid.js";

export type RunStatus = "pending" | "running" | "error" | "success" | "timeout" | "interrupted";
export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";
export type MultitaskStrategy = "reject" | "interrupt" | "rollback" | "enqueue";
export type ScheduleKind = "scheduled" | "delayed" | "cron" | "interval";

export interface Run {
  run_id: string;
  thread_id: string;
  agent: string;
  status: RunStatus;
  kind: string;
  attempt: number;
  input: unknown;
  output: unknown;
  error: string | null;
  checkpoint: Checkpoint | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  /** The pid that owns this run while it is `running`; NULL once it settles, or on a pre-0.8 row. */
  owner_pid: number | null;
}

/**
 * One consumption record for one canonical action identity (RFA-0.8 sect. 6.4).
 * The row IS the ledger the human used to be.
 */
export interface ActionClaim {
  identity: string;
  idempotency_key: string;
  agent: string;
  tool_name: string;
  scope: string;
  effect_class: string;
  request_id: string | null;
  run_id: string | null;
  pid: number;
  state: "claimed" | "settled" | "failed";
  claimed_at: string;
  settled_at: string | null;
  outcome: string | null;
}

export type ActionClaimRefusal = "already_consumed" | "in_flight" | "unsettled_irreversible";

export type ActionClaimResult =
  | { ok: true; idempotency_key: string; reclaimed: "after_failure" | "after_dead_holder" | null }
  | { ok: false; reason: ActionClaimRefusal; existing: ActionClaim; idempotency_key: string };

/** The subprocess-resident checkpoint payload (spec 4.3). */
export interface Checkpoint {
  claude_session_id?: string;
  cwd?: string;
  room_cursor?: number;
  custom_state?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Schedule<T = unknown> {
  id: string;
  agent: string;
  kind: ScheduleKind;
  when: string;
  timezone: string | null;
  callback: string;
  payload: T;
  next_fire_at: string | null;
}

const MAX_ATTEMPTS = 3;

export class Engine {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle','busy','interrupted','error')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','running','error','success','timeout','interrupted')),
        kind TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        input_json TEXT,
        output_json TEXT,
        error TEXT,
        checkpoint_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        cost_usd REAL,
        num_turns INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('scheduled','delayed','cron','interval')),
        when_spec TEXT NOT NULL,
        timezone TEXT,
        callback TEXT NOT NULL,
        payload_json TEXT,
        next_fire_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * Schema migrations, additive and idempotent, recorded in `user_version`: the
   * same mechanism the per-pack memory store uses, for the same reason (a
   * supervisor may run an older build against a newer file after a rollback).
   */
  private migrate(): void {
    const current = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (current < 1) {
      // RFA-0.8 sect. 3 item 4: who owns a `running` run. Without it "did the
      // process running this die" is not answerable from the row, so the only
      // sweep possible was `reconcileOrphans` at the one moment the supervisor
      // knows nothing owns a pack (its start), and a run whose resident is never
      // restarted stays `running` and holds its thread `busy` forever. NULL means
      // a pre-0.8 row or a settled run, and is never read as "dead".
      const cols = this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "owner_pid")) this.db.exec(`ALTER TABLE runs ADD COLUMN owner_pid INTEGER`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_owner ON runs(owner_pid) WHERE owner_pid IS NOT NULL`);
      this.db.pragma("user_version = 1");
    }
    if (current < 2) {
      // RFA-0.8 sect. 6.4 item 2: approval-card consumption. The uniqueness
      // constraint IS the mechanism, so the PRIMARY KEY on `identity` is not an
      // index choice, it is the whole design: two processes racing one card
      // identity both reach the INSERT and SQLite decides, which is the only
      // decider that composes. Per-process sequencing measured 10 of 10
      // cross-process double-fires on every durable backend tried, with no
      // ceiling below sixteen racers.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS action_claims (
          identity TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          agent TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          scope TEXT NOT NULL,
          effect_class TEXT NOT NULL,
          request_id TEXT,
          run_id TEXT,
          pid INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('claimed','settled','failed')),
          claimed_at TEXT NOT NULL,
          settled_at TEXT,
          outcome TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_action_claims_scope ON action_claims(scope, claimed_at);
      `);
      this.db.pragma("user_version = 2");
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- runs

  /**
   * Create a run on a thread under the per-thread mutex of 1 (LangGraph
   * semantics): if the thread is busy, `multitask` decides the double-texting
   * outcome. Returns what happened; `enqueue` leaves the run `pending` for
   * `nextPending()` to pick up when the thread frees.
   */
  createRun(args: {
    agent: string;
    threadId: string;
    kind: string;
    input?: unknown;
    multitask?: MultitaskStrategy;
  }): { runId: string; action: "start" | "enqueued" | "rejected" | "interrupted_previous" } {
    const strategy = args.multitask ?? "enqueue";
    const now = iso();
    const runId = `run_${randomBytes(6).toString("hex")}`;
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO threads (thread_id, agent, status, updated_at) VALUES (?, ?, 'idle', ?)
           ON CONFLICT(thread_id) DO NOTHING`,
        )
        .run(args.threadId, args.agent, now);
      const thread = this.db.prepare(`SELECT status FROM threads WHERE thread_id = ?`).get(args.threadId) as {
        status: ThreadStatus;
      };
      let action: "start" | "enqueued" | "rejected" | "interrupted_previous" = "start";
      if (thread.status === "busy") {
        if (strategy === "reject") return { runId: "", action: "rejected" as const };
        if (strategy === "interrupt" || strategy === "rollback") {
          this.db
            .prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, owner_pid = NULL WHERE thread_id = ? AND status = 'running'`)
            .run(now, args.threadId);
          action = "interrupted_previous";
        } else {
          action = "enqueued";
        }
      }
      const starting = action === "start" || action === "interrupted_previous";
      this.db
        .prepare(
          `INSERT INTO runs (run_id, thread_id, agent, status, kind, input_json, created_at, started_at, owner_pid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, args.threadId, args.agent, starting ? "running" : "pending", args.kind, json(args.input), now, starting ? now : null, starting ? process.pid : null);
      if (starting) {
        this.db.prepare(`UPDATE threads SET status = 'busy', updated_at = ? WHERE thread_id = ?`).run(now, args.threadId);
      }
      return { runId, action };
    })();
  }

  /** Pop the oldest pending run on an idle thread (the enqueue drain). */
  /**
   * Runs left `running` by a process that is gone, and the threads they wedge.
   *
   * A run only leaves `running` when its own process settles it, so a resident
   * that is SIGKILLed, crashes, or is drained mid-turn leaves the row behind and
   * its thread `busy` forever. The default multitask strategy is `enqueue`, and
   * the gate only looks at `busy`, so every later run on that conversation is
   * created `pending` and waits for a drain that can only be triggered by the
   * settle that will never come. The conversation is then permanently unservable.
   *
   * Measured on this machine before the fix: 4 threads `busy`, the oldest since
   * 2026-08-17T09:17Z, which is two and a half days. No pending runs had queued
   * behind them yet, so the leak was latent rather than visible, and it is the one
   * anomaly spec 20.6 requires a watchdog invariant to cover.
   *
   * Only the SUPERVISOR may call this, and only as it starts a resident: that is
   * the one moment something knows no other process owns this pack (it refuses to
   * start a duplicate). A resident calling this for itself could not tell its own
   * previous corpse from a live sibling, and a 30-minute approval wait is a
   * legitimately long-running run, so no timeout heuristic is safe either.
   */
  /**
   * Every run whose OWNING PROCESS IS GONE, swept to a terminal state, on a
   * direct state check (RFA-0.8 sect. 3 item 4).
   *
   * The difference from `reconcileOrphans` is when it is safe to call, and that is
   * the whole point. Orphan reconciliation is safe only at the instant the
   * supervisor knows nothing owns a pack (as it starts a resident), so a pack
   * whose resident is retired, disabled, or simply never restarted keeps its
   * `running` rows and its `busy` threads for as long as the hub directory exists
   * (measured before that fix: four threads busy, the oldest for two and a half
   * days). This one asks the operating system whether the recorded owner exists,
   * which is answerable at any moment, from any process, AT ZERO TRAFFIC.
   *
   * Zero traffic is the requirement, not an aside: this is a STATE, and a state
   * needs a direct check. The repository has already paid for the inverse, an
   * error-RATE alert that stayed silent through a total outage because a rate has
   * no denominator on a quiet hub.
   *
   * Rows with a NULL `owner_pid` are LEFT ALONE: a pre-0.8 row carries no evidence
   * about its owner, and inferring death from its age is the timeout heuristic
   * this deliberately avoids (a 30-minute approval wait is a legitimately long
   * run). `reconcileOrphans` still covers those at resident start.
   *
   * Pid reuse can spare a run one sweep, exactly as it can spare an account lease
   * one, and it costs the same nothing: the next pass looks again.
   */
  reconcileDead(opts: { alive?: (pid: number) => boolean; agent?: string } = {}): { runs: string[]; threads: string[] } {
    const alive = opts.alive ?? pidAlive;
    return this.db.transaction(() => {
      const rows = (
        opts.agent
          ? this.db
              .prepare(`SELECT run_id, thread_id, owner_pid FROM runs WHERE status = 'running' AND owner_pid IS NOT NULL AND agent = ?`)
              .all(opts.agent)
          : this.db.prepare(`SELECT run_id, thread_id, owner_pid FROM runs WHERE status = 'running' AND owner_pid IS NOT NULL`).all()
      ) as { run_id: string; thread_id: string; owner_pid: number }[];
      const dead = rows.filter((r) => !alive(r.owner_pid));
      if (dead.length === 0) return { runs: [], threads: [] };
      const now = iso();
      const markRun = this.db.prepare(
        `UPDATE runs SET status = 'interrupted', ended_at = ?, owner_pid = NULL, error = COALESCE(error, ?) WHERE run_id = ?`,
      );
      // `idle`, not `interrupted`: idle is what lets a queued `pending` run be
      // picked up, and making the conversation servable again is the point.
      const freeThread = this.db.prepare(`UPDATE threads SET status = 'idle', updated_at = ? WHERE thread_id = ?`);
      for (const r of dead) {
        markRun.run(now, `orphaned: the process running this (pid ${r.owner_pid}) is gone`, r.run_id);
        freeThread.run(now, r.thread_id);
      }
      return { runs: dead.map((r) => r.run_id), threads: [...new Set(dead.map((r) => r.thread_id))] };
    })();
  }

  reconcileOrphans(agent: string): { runs: string[]; threads: string[] } {
    return this.db.transaction(() => {
      const orphans = this.db
        .prepare(`SELECT run_id, thread_id FROM runs WHERE agent = ? AND status = 'running'`)
        .all(agent) as { run_id: string; thread_id: string }[];
      if (orphans.length === 0) return { runs: [], threads: [] };
      const now = iso();
      const markRun = this.db.prepare(
        `UPDATE runs SET status = 'interrupted', ended_at = ?, owner_pid = NULL, error = COALESCE(error, ?) WHERE run_id = ?`,
      );
      // The thread goes to `idle`, not `interrupted`: idle is what lets a queued
      // `pending` run be picked up, and the point of reconciling is to make the
      // conversation servable again.
      const freeThread = this.db.prepare(`UPDATE threads SET status = 'idle', updated_at = ? WHERE thread_id = ?`);
      for (const o of orphans) {
        markRun.run(now, "orphaned: the process running this never settled it", o.run_id);
        freeThread.run(now, o.thread_id);
      }
      return { runs: orphans.map((o) => o.run_id), threads: [...new Set(orphans.map((o) => o.thread_id))] };
    })();
  }

  nextPending(threadId: string): Run | null {
    return this.db.transaction(() => {
      const thread = this.db.prepare(`SELECT status FROM threads WHERE thread_id = ?`).get(threadId) as
        | { status: ThreadStatus }
        | undefined;
      if (!thread || thread.status === "busy") return null;
      const row = this.db
        .prepare(`SELECT * FROM runs WHERE thread_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1`)
        .get(threadId) as RunRow | undefined;
      if (!row) return null;
      const now = iso();
      // Whoever drains the queue is the process that will run it, so it owns it.
      this.db.prepare(`UPDATE runs SET status = 'running', started_at = ?, owner_pid = ? WHERE run_id = ?`).run(now, process.pid, row.run_id);
      this.db.prepare(`UPDATE threads SET status = 'busy', updated_at = ? WHERE thread_id = ?`).run(now, threadId);
      return this.hydrate({ ...row, status: "running", started_at: now, owner_pid: process.pid });
    })();
  }

  completeRun(runId: string, result: { output?: unknown; costUsd?: number; numTurns?: number; checkpoint?: Checkpoint }): void {
    this.settle(runId, "success", { output: result.output, costUsd: result.costUsd, numTurns: result.numTurns, checkpoint: result.checkpoint });
  }

  /** Fail a run; below MAX_ATTEMPTS it re-queues as pending attempt+1 (idempotent steps make the retry cheap). */
  failRun(runId: string, error: string, opts: { checkpoint?: Checkpoint; retryable?: boolean } = {}): { retried: boolean } {
    const row = this.get(runId);
    if (!row) throw new Error(`no run ${runId}`);
    const retry = (opts.retryable ?? true) && row.attempt < MAX_ATTEMPTS;
    this.db.transaction(() => {
      const now = iso();
      if (retry) {
        // A re-queued run is owned by nobody until something picks it up again.
        this.db
          .prepare(`UPDATE runs SET status = 'pending', attempt = attempt + 1, error = ?, started_at = NULL, owner_pid = NULL, checkpoint_json = COALESCE(?, checkpoint_json) WHERE run_id = ?`)
          .run(error, opts.checkpoint ? json(opts.checkpoint) : null, runId);
      } else {
        this.db
          .prepare(`UPDATE runs SET status = 'error', error = ?, ended_at = ?, owner_pid = NULL, checkpoint_json = COALESCE(?, checkpoint_json) WHERE run_id = ?`)
          .run(error, now, opts.checkpoint ? json(opts.checkpoint) : null, runId);
      }
      this.db
        .prepare(`UPDATE threads SET status = ?, updated_at = ? WHERE thread_id = ?`)
        .run(retry ? "idle" : "error", now, row.thread_id);
    })();
    return { retried: retry };
  }

  interruptRun(runId: string, checkpoint?: Checkpoint): void {
    this.settle(runId, "interrupted", { checkpoint });
  }

  saveCheckpoint(runId: string, checkpoint: Checkpoint): void {
    this.db.prepare(`UPDATE runs SET checkpoint_json = ? WHERE run_id = ?`).run(json(checkpoint), runId);
  }

  get(runId: string): Run | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as RunRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  runs(filter: { agent?: string; threadId?: string; status?: RunStatus; limit?: number } = {}): Run[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.agent) (where.push("agent = ?"), params.push(filter.agent));
    if (filter.threadId) (where.push("thread_id = ?"), params.push(filter.threadId));
    if (filter.status) (where.push("status = ?"), params.push(filter.status));
    const rows = this.db
      .prepare(
        `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, filter.limit ?? 100) as RunRow[];
    return rows.map((r) => this.hydrate(r));
  }

  threadStatus(threadId: string): ThreadStatus {
    const t = this.db.prepare(`SELECT status FROM threads WHERE thread_id = ?`).get(threadId) as
      | { status: ThreadStatus }
      | undefined;
    return t?.status ?? "idle";
  }

  private settle(
    runId: string,
    status: RunStatus,
    extra: { output?: unknown; costUsd?: number; numTurns?: number; checkpoint?: Checkpoint },
  ): void {
    const row = this.get(runId);
    if (!row) throw new Error(`no run ${runId}`);
    this.db.transaction(() => {
      const now = iso();
      this.db
        .prepare(
          `UPDATE runs SET status = ?, output_json = COALESCE(?, output_json), cost_usd = COALESCE(?, cost_usd),
           num_turns = COALESCE(?, num_turns), checkpoint_json = COALESCE(?, checkpoint_json), ended_at = ?, owner_pid = NULL WHERE run_id = ?`,
        )
        .run(status, json(extra.output), extra.costUsd ?? null, extra.numTurns ?? null, extra.checkpoint ? json(extra.checkpoint) : null, now, runId);
      this.db
        .prepare(`UPDATE threads SET status = ?, updated_at = ? WHERE thread_id = ?`)
        .run(status === "interrupted" ? "interrupted" : "idle", now, row.thread_id);
    })();
  }

  private hydrate(row: RunRow): Run {
    return {
      run_id: row.run_id,
      thread_id: row.thread_id,
      agent: row.agent,
      status: row.status,
      kind: row.kind,
      attempt: row.attempt,
      input: parse(row.input_json),
      output: parse(row.output_json),
      error: row.error,
      checkpoint: parse(row.checkpoint_json) as Checkpoint | null,
      created_at: row.created_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
      cost_usd: row.cost_usd,
      num_turns: row.num_turns,
      owner_pid: row.owner_pid ?? null,
    };
  }

  // ---------------------------------------------------------------- steps (memoized side effects)

  /**
   * Run `fn` once, ever, for this (run, step id); replays return the
   * journaled result without re-executing (Inngest semantics). Never nest
   * steps; keep everything nondeterministic or side-effecting inside one.
   */
  async step<T>(runId: string, stepId: string, fn: () => T | Promise<T>): Promise<T> {
    const cached = this.db
      .prepare(`SELECT result_json FROM steps WHERE run_id = ? AND step_id = ?`)
      .get(runId, stepId) as { result_json: string } | undefined;
    if (cached) return JSON.parse(cached.result_json) as T;
    const result = await fn();
    const seq = (this.db.prepare(`SELECT COUNT(*) AS n FROM steps WHERE run_id = ?`).get(runId) as { n: number }).n + 1;
    this.db
      .prepare(`INSERT INTO steps (run_id, step_id, seq, result_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(runId, stepId, seq, JSON.stringify(result ?? null), iso());
    return result;
  }

  steps(runId: string): { step_id: string; seq: number; result: unknown }[] {
    const rows = this.db
      .prepare(`SELECT step_id, seq, result_json FROM steps WHERE run_id = ? ORDER BY seq`)
      .all(runId) as { step_id: string; seq: number; result_json: string }[];
    return rows.map((r) => ({ step_id: r.step_id, seq: r.seq, result: JSON.parse(r.result_json) }));
  }

  // ---------------------------------------------------------------- approval-card consumption (RFA-0.8 sect. 6.4)

  /**
   * Claim the right to execute ONE approved action, exactly once.
   *
   * Placement is the requirement, not the mechanism: the claim is a
   * uniqueness-constraint INSERT in a SHARED durable store, taken at the
   * durable-state read path and BEFORE execution. `steps` above is the wrong
   * table and it is worth saying why, because it looks close enough to reuse: a
   * step is memoized per RUN, and the whole measured failure is a second RUN in
   * a second PROCESS proposing the same action after a restart. Identity, not
   * run id, is the key that survives that.
   *
   * Re-claim policy, which is where the effect class earns its keep:
   *  - `settled`: refused, always. The action happened; that is the whole point.
   *  - `claimed` by a LIVE process: refused. Somebody is executing it right now.
   *  - `claimed` by a DEAD process: the outcome is unknown. An irreversible
   *    action GATES here (refused, surfaced, a human settles it) rather than
   *    compensating after; anything else may be taken over, and takes over the
   *    ORIGINAL idempotency key so a downstream service that dedupes on it still
   *    collapses the two attempts.
   *  - `failed`: a fresh attempt is allowed, on the original key, for the same
   *    reason.
   */
  claimAction(args: {
    identity: string;
    agent: string;
    toolName: string;
    scope: string;
    effectClass: string;
    requestId?: string | null;
    runId?: string | null;
    /** PID liveness for the takeover decision; injectable so tests need not fork. */
    alive?: (pid: number) => boolean;
  }): ActionClaimResult {
    const alive = args.alive ?? pidAlive;
    const tx = this.db.transaction((): ActionClaimResult => {
      const existing = this.db.prepare(`SELECT * FROM action_claims WHERE identity = ?`).get(args.identity) as
        | ActionClaim
        | undefined;
      if (existing) {
        if (existing.state === "settled") {
          return { ok: false, reason: "already_consumed", existing, idempotency_key: existing.idempotency_key };
        }
        if (existing.state === "claimed" && alive(existing.pid)) {
          return { ok: false, reason: "in_flight", existing, idempotency_key: existing.idempotency_key };
        }
        if (existing.state === "claimed" && !mayRetryUnsettled(effectClassOf(existing.effect_class))) {
          return { ok: false, reason: "unsettled_irreversible", existing, idempotency_key: existing.idempotency_key };
        }
        // Takeover or retry: same identity, same key, a new holder.
        this.db
          .prepare(
            `UPDATE action_claims SET state = 'claimed', pid = ?, run_id = ?, request_id = ?, claimed_at = ?, settled_at = NULL, outcome = NULL WHERE identity = ?`,
          )
          .run(process.pid, args.runId ?? null, args.requestId ?? null, iso(), args.identity);
        return {
          ok: true,
          idempotency_key: existing.idempotency_key,
          reclaimed: existing.state === "failed" ? "after_failure" : "after_dead_holder",
        };
      }
      const key = `idem_${randomBytes(12).toString("hex")}`;
      this.db
        .prepare(
          `INSERT INTO action_claims (identity, idempotency_key, agent, tool_name, scope, effect_class, request_id, run_id, pid, state, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)`,
        )
        .run(
          args.identity,
          key,
          args.agent,
          args.toolName,
          args.scope,
          args.effectClass,
          args.requestId ?? null,
          args.runId ?? null,
          process.pid,
          iso(),
        );
      return { ok: true, idempotency_key: key, reclaimed: null };
    });
    // IMMEDIATE: two residents must not both read the absent row and then both insert.
    return tx.immediate();
  }

  /**
   * Record what the acting tool did. `ok: false` leaves the identity claimable
   * again (`failed`), which is correct for a call that never reached the far
   * side; a call whose OUTCOME is unknown must be left `claimed` instead, and
   * the caller does that by simply not settling it.
   */
  settleAction(identity: string, result: { ok: boolean; outcome?: string }): void {
    this.db
      .prepare(`UPDATE action_claims SET state = ?, settled_at = ?, outcome = ? WHERE identity = ?`)
      .run(result.ok ? "settled" : "failed", iso(), (result.outcome ?? "").slice(0, 500), identity);
  }

  /**
   * The holder has stopped watching for this action's outcome (its turn ended
   * without a tool result), but the outcome is still UNKNOWN.
   *
   * Not a settlement and not a failure: pid 0 is never alive, so the row now
   * reads as an unsettled claim whose holder is gone, which is exactly the state
   * the effect class was written to decide. An irreversible action stays gated
   * until a human settles it; anything else may be taken over on the original
   * idempotency key. Without this, a claim would keep this resident's live pid
   * forever and every later proposal of the same action would read `in_flight`.
   */
  disownAction(identity: string): void {
    this.db.prepare(`UPDATE action_claims SET pid = 0 WHERE identity = ? AND state = 'claimed' AND pid = ?`).run(identity, process.pid);
  }

  readAction(identity: string): ActionClaim | null {
    return (this.db.prepare(`SELECT * FROM action_claims WHERE identity = ?`).get(identity) as ActionClaim | undefined) ?? null;
  }

  /** Claims stuck mid-flight: the operator's view of what a crash left unsettled. */
  unsettledActions(opts: { agent?: string } = {}): ActionClaim[] {
    return this.db
      .prepare(
        `SELECT * FROM action_claims WHERE state = 'claimed'${opts.agent ? " AND agent = ?" : ""} ORDER BY claimed_at`,
      )
      .all(...(opts.agent ? [opts.agent] : [])) as ActionClaim[];
  }

  // ---------------------------------------------------------------- schedules (Cloudflare's API shape)

  /**
   * schedule(when, callback, payload): Date = one-shot at that time; number =
   * delayed by N seconds; string = cron expression (with optional IANA
   * timezone). `interval:N` strings create repeating interval schedules.
   */
  schedule<T>(agent: string, when: Date | number | string, callback: string, payload?: T, opts: { timezone?: string } = {}): Schedule<T> {
    let kind: ScheduleKind;
    let whenSpec: string;
    let nextFire: Date;
    const now = Date.now();
    if (when instanceof Date) {
      kind = "scheduled";
      whenSpec = when.toISOString();
      nextFire = when;
    } else if (typeof when === "number") {
      kind = "delayed";
      whenSpec = String(when);
      nextFire = new Date(now + when * 1000);
    } else if (when.startsWith("interval:")) {
      kind = "interval";
      whenSpec = when.slice("interval:".length);
      nextFire = new Date(now + Number(whenSpec) * 1000);
    } else {
      kind = "cron";
      whenSpec = when;
      const next = new Cron(when, { timezone: opts.timezone }).nextRun();
      if (!next) throw new Error(`cron "${when}" never fires`);
      nextFire = next;
    }
    const id = `sch_${randomBytes(5).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO schedules (id, agent, kind, when_spec, timezone, callback, payload_json, next_fire_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, agent, kind, whenSpec, opts.timezone ?? null, callback, json(payload), nextFire.toISOString(), iso());
    return { id, agent, kind, when: whenSpec, timezone: opts.timezone ?? null, callback, payload: payload as T, next_fire_at: nextFire.toISOString() };
  }

  listSchedules(agent?: string): Schedule[] {
    const rows = (
      agent
        ? this.db.prepare(`SELECT * FROM schedules WHERE agent = ? ORDER BY created_at`).all(agent)
        : this.db.prepare(`SELECT * FROM schedules ORDER BY created_at`).all()
    ) as ScheduleRow[];
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      kind: r.kind,
      when: r.when_spec,
      timezone: r.timezone,
      callback: r.callback,
      payload: parse(r.payload_json),
      next_fire_at: r.next_fire_at,
    }));
  }

  cancelSchedule(id: string): boolean {
    return this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Pop every schedule due at `now` (atomically: one-shots delete, repeating
   * ones advance next_fire_at), returning what to run. Callers turn each into
   * a run on the agent's schedule thread.
   */
  dueSchedules(now: Date = new Date(), agent?: string): Schedule[] {
    return this.db.transaction(() => {
      const rows = (
        agent
          ? this.db
              .prepare(`SELECT * FROM schedules WHERE agent = ? AND next_fire_at IS NOT NULL AND next_fire_at <= ?`)
              .all(agent, now.toISOString())
          : this.db
              .prepare(`SELECT * FROM schedules WHERE next_fire_at IS NOT NULL AND next_fire_at <= ?`)
              .all(now.toISOString())
      ) as ScheduleRow[];
      const due: Schedule[] = [];
      for (const r of rows) {
        due.push({ id: r.id, agent: r.agent, kind: r.kind, when: r.when_spec, timezone: r.timezone, callback: r.callback, payload: parse(r.payload_json), next_fire_at: r.next_fire_at });
        if (r.kind === "scheduled" || r.kind === "delayed") {
          this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(r.id);
        } else if (r.kind === "interval") {
          const next = new Date(now.getTime() + Number(r.when_spec) * 1000).toISOString();
          this.db.prepare(`UPDATE schedules SET next_fire_at = ? WHERE id = ?`).run(next, r.id);
        } else {
          const next = new Cron(r.when_spec, { timezone: r.timezone ?? undefined }).nextRun(now);
          this.db.prepare(`UPDATE schedules SET next_fire_at = ? WHERE id = ?`).run(next ? next.toISOString() : null, r.id);
        }
      }
      return due;
    })();
  }
}

interface RunRow {
  run_id: string;
  thread_id: string;
  agent: string;
  status: RunStatus;
  kind: string;
  attempt: number;
  input_json: string | null;
  output_json: string | null;
  error: string | null;
  checkpoint_json: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  owner_pid: number | null;
}

interface ScheduleRow {
  id: string;
  agent: string;
  kind: ScheduleKind;
  when_spec: string;
  timezone: string | null;
  callback: string;
  payload_json: string | null;
  next_fire_at: string | null;
}


const iso = () => new Date().toISOString();
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const parse = (s: string | null) => (s === null ? null : (JSON.parse(s) as unknown));
