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
}

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
            .prepare(`UPDATE runs SET status = 'interrupted', ended_at = ? WHERE thread_id = ? AND status = 'running'`)
            .run(now, args.threadId);
          action = "interrupted_previous";
        } else {
          action = "enqueued";
        }
      }
      const starting = action === "start" || action === "interrupted_previous";
      this.db
        .prepare(
          `INSERT INTO runs (run_id, thread_id, agent, status, kind, input_json, created_at, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, args.threadId, args.agent, starting ? "running" : "pending", args.kind, json(args.input), now, starting ? now : null);
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
  reconcileOrphans(agent: string): { runs: string[]; threads: string[] } {
    return this.db.transaction(() => {
      const orphans = this.db
        .prepare(`SELECT run_id, thread_id FROM runs WHERE agent = ? AND status = 'running'`)
        .all(agent) as { run_id: string; thread_id: string }[];
      if (orphans.length === 0) return { runs: [], threads: [] };
      const now = iso();
      const markRun = this.db.prepare(
        `UPDATE runs SET status = 'interrupted', ended_at = ?, error = COALESCE(error, ?) WHERE run_id = ?`,
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
      this.db.prepare(`UPDATE runs SET status = 'running', started_at = ? WHERE run_id = ?`).run(now, row.run_id);
      this.db.prepare(`UPDATE threads SET status = 'busy', updated_at = ? WHERE thread_id = ?`).run(now, threadId);
      return this.hydrate({ ...row, status: "running", started_at: now });
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
        this.db
          .prepare(`UPDATE runs SET status = 'pending', attempt = attempt + 1, error = ?, started_at = NULL, checkpoint_json = COALESCE(?, checkpoint_json) WHERE run_id = ?`)
          .run(error, opts.checkpoint ? json(opts.checkpoint) : null, runId);
      } else {
        this.db
          .prepare(`UPDATE runs SET status = 'error', error = ?, ended_at = ?, checkpoint_json = COALESCE(?, checkpoint_json) WHERE run_id = ?`)
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
           num_turns = COALESCE(?, num_turns), checkpoint_json = COALESCE(?, checkpoint_json), ended_at = ? WHERE run_id = ?`,
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
