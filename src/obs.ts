/**
 * Local observability store (RFA v0.4 spec section 7.1): the LangSmith run
 * shape and its one universal feedback record, in SQLite. Traces stay on this
 * machine; any future export to a vendor is a config change, never a schema
 * change.
 *
 * - `dotted_order` (one indexed string column: `<start>Z<id>` segments joined
 *   by "."): lexicographic sort = depth-first trace traversal, no recursion.
 * - One feedback record for every writer (humans, judges, code checks),
 *   discriminated by source_type: api|app|evaluator|model|human.
 * - Serve runs reuse the ENGINE run id, so feedback written against the
 *   run_id an answer carries lands on the right row with zero mapping.
 */
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { AUTH_FAILURE_MARKERS } from "./account.js";

export type RunType = "agent_span" | "generation_span" | "function_span" | "guardrail_span" | "handoff_span" | "tool";

export interface ObsRunInput {
  id?: string;
  trace_id?: string;
  parent_run_id?: string | null;
  parent_dotted_order?: string | null;
  name: string;
  run_type: RunType;
  status?: "success" | "error";
  error?: string | null;
  start_time: number; // ms epoch
  end_time: number;
  project?: string;
  group_id?: string | null; // room / thread
  inputs?: unknown;
  outputs?: unknown;
  tags?: string[];
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  extra?: Record<string, unknown>;
}

export interface ObsRun extends Omit<ObsRunInput, "parent_dotted_order"> {
  id: string;
  trace_id: string;
  dotted_order: string;
  status: "success" | "error";
  needs_review: 0 | 1;
}

export interface Feedback {
  run_id: string;
  key: string;
  score: number | null;
  value?: string | null;
  comment?: string | null;
  correction?: string | null;
  source_type: "api" | "app" | "evaluator" | "model" | "human";
  /** REQUIRED when source_type is "model" (spec 20.1): the rubric the verdict was made against. */
  rubric_hash?: string | null;
}

export interface ObsSummary {
  window_ms: number;
  runs: number;
  errors: number;
  error_pct: number;
  avg_latency_ms: number;
  feedback_count: number;
  avg_feedback: number | null;
  cost_usd: number;
  /**
   * Runs in the window that failed because an agent could not authenticate to its
   * model provider. Counted separately from `errors` because it is not a rate: see
   * `evaluateAlerts`.
   */
  auth_errors: number;
}

export interface Alert {
  kind: "error_pct" | "latency" | "feedback" | "credential";
  message: string;
}

/** LangSmith's dotted_order segment: sortable start time + the run id. */
export function dottedSegment(startMs: number, id: string): string {
  const d = new Date(startMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}Z${id}`
  );
}

export class ObsStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        parent_run_id TEXT,
        dotted_order TEXT NOT NULL,
        name TEXT NOT NULL,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'success',
        error TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        project TEXT NOT NULL DEFAULT 'rfa',
        group_id TEXT,
        inputs_json TEXT,
        outputs_json TEXT,
        tags_json TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd REAL,
        needs_review INTEGER NOT NULL DEFAULT 0,
        extra_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_obs_dotted ON runs(dotted_order);
      CREATE INDEX IF NOT EXISTS idx_obs_trace ON runs(trace_id);
      CREATE INDEX IF NOT EXISTS idx_obs_time ON runs(end_time);
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        key TEXT NOT NULL,
        score REAL,
        value TEXT,
        comment TEXT,
        correction TEXT,
        source_type TEXT NOT NULL CHECK (source_type IN ('api','app','evaluator','model','human')),
        -- SHA-256 of evals/rubric.md as read at judge time (spec 20.1). REQUIRED
        -- when source_type = 'model', NULL otherwise: without it a rubric edit
        -- is indistinguishable from a movement in agent quality.
        rubric_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fb_run ON feedback(run_id);
    `);
    // Additive migration for databases created before 0.5.4.
    const fbCols = new Set((this.db.prepare("PRAGMA table_info(feedback)").all() as { name: string }[]).map((c) => c.name));
    if (!fbCols.has("rubric_hash")) this.db.exec("ALTER TABLE feedback ADD COLUMN rubric_hash TEXT");
  }

  close(): void {
    this.db.close();
  }

  /** Record a finished run (most writers know the whole run at end). */
  record(input: ObsRunInput): ObsRun {
    const id = input.id ?? `obs_${randomBytes(8).toString("hex")}`;
    const traceId = input.trace_id ?? randomBytes(16).toString("hex");
    const dotted = input.parent_dotted_order
      ? `${input.parent_dotted_order}.${dottedSegment(input.start_time, id)}`
      : dottedSegment(input.start_time, id);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs
         (id, trace_id, parent_run_id, dotted_order, name, run_type, status, error, start_time, end_time,
          project, group_id, inputs_json, outputs_json, tags_json, input_tokens, output_tokens, cost_usd, extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        traceId,
        input.parent_run_id ?? null,
        dotted,
        input.name,
        input.run_type,
        input.status ?? (input.error ? "error" : "success"),
        input.error ?? null,
        Math.round(input.start_time),
        Math.round(input.end_time),
        input.project ?? "rfa",
        input.group_id ?? null,
        json(input.inputs),
        json(input.outputs),
        json(input.tags),
        input.input_tokens ?? null,
        input.output_tokens ?? null,
        input.cost_usd ?? null,
        json(input.extra),
      );
    return this.get(id)!;
  }

  get(id: string): ObsRun | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? hydrate(row) : null;
  }

  /** Depth-first trace traversal: ORDER BY the one indexed string column. */
  trace(traceId: string): ObsRun[] {
    const rows = this.db.prepare(`SELECT * FROM runs WHERE trace_id = ? ORDER BY dotted_order`).all(traceId) as RunRow[];
    return rows.map(hydrate);
  }

  runs(filter: { group_id?: string; run_type?: RunType; needs_review?: boolean; limit?: number } = {}): ObsRun[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.group_id) (where.push("group_id = ?"), params.push(filter.group_id));
    if (filter.run_type) (where.push("run_type = ?"), params.push(filter.run_type));
    if (filter.needs_review !== undefined) (where.push("needs_review = ?"), params.push(filter.needs_review ? 1 : 0));
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY end_time DESC LIMIT ?`)
      .all(...params, filter.limit ?? 100) as RunRow[];
    return rows.map(hydrate);
  }

  /**
   * The rows one agent's answer path produced inside a window, for the eval
   * harness's honest run resolution (wire 14 item 12, `src/evals/runresolve.ts`).
   *
   * Narrow on purpose. The harness used to key its writes on a run id the
   * SUBJECT reported in its own answer body, which is a self-report driving an
   * automated decision; this is the query that lets it check that claim against
   * the store the write targets instead. A resident names its rows
   * `<kind>:<pack>`, so the suffix match is what identifies the agent, and the
   * window is the ask's own send-to-reply span.
   */
  runsForAgent(agent: string, from: number, to: number): { id: string; name: string; group_id: string | null; status: string; start_time: number; end_time: number }[] {
    return this.db
      .prepare(
        `SELECT id, name, group_id, status, start_time, end_time FROM runs
          WHERE run_type = 'agent_span' AND name LIKE ('%:' || ?) AND start_time >= ? AND start_time <= ?
          ORDER BY start_time`,
      )
      .all(agent, from, to) as { id: string; name: string; group_id: string | null; status: string; start_time: number; end_time: number }[];
  }

  /**
   * Has this agent EVER recorded a run here? (wire 14 item 12,
   * `src/evals/runresolve.ts`.)
   *
   * It separates a locally hosted resident - whose every refusal path writes a
   * run row with `status: 'error'` before the refusal reaches the asker - from a
   * member hosted elsewhere, which records nothing in this store. Without that
   * distinction an absent row is ambiguous; with it, an absent row for a local
   * resident contradicts a declared refusal.
   */
  recordsRunsFor(agent: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM runs WHERE run_type = 'agent_span' AND name LIKE ('%:' || ?) LIMIT 1`).get(agent);
    return row !== undefined;
  }

  markReview(id: string, needs: boolean): void {
    this.db.prepare(`UPDATE runs SET needs_review = ? WHERE id = ?`).run(needs ? 1 : 0, id);
  }

  feedback(f: Feedback): void {
    if (f.source_type === "model" && !f.rubric_hash) {
      throw new Error("a model-sourced feedback row requires rubric_hash (spec 20.1): without it a rubric edit reads as a quality change");
    }
    this.db
      .prepare(
        `INSERT INTO feedback (run_id, key, score, value, comment, correction, source_type, rubric_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.run_id, f.key, f.score, f.value ?? null, f.comment ?? null, f.correction ?? null, f.source_type, f.rubric_hash ?? null, Date.now());
  }

  feedbackFor(runId: string): (Feedback & { created_at: number })[] {
    return this.db
      .prepare(`SELECT run_id, key, score, value, comment, correction, source_type, rubric_hash, created_at FROM feedback WHERE run_id = ?`)
      .all(runId) as never;
  }

  /** The three-alert summary window (agent/generation runs only: tool spans would drown the signal). */
  summary(windowMs: number, now: number = Date.now()): ObsSummary {
    const since = now - windowMs;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, SUM(status = 'error') AS errors, AVG(end_time - start_time) AS avg_ms, SUM(COALESCE(cost_usd, 0)) AS cost
         FROM runs WHERE end_time >= ? AND run_type IN ('agent_span', 'generation_span')`,
      )
      .get(since) as { runs: number; errors: number | null; avg_ms: number | null; cost: number | null };
    const f = this.db
      .prepare(`SELECT COUNT(*) AS n, AVG(score) AS avg FROM feedback WHERE created_at >= ? AND score IS NOT NULL`)
      .get(since) as { n: number; avg: number | null };
    // Matched in SQL rather than by pulling every error row into JS. The
    // disjunction is GENERATED from AUTH_FAILURE_MARKERS in src/account.ts, the
    // same list `isAuthError` derives its regex from, so the resident's refusal
    // reason and this alert counter cannot drift apart; the test in
    // test/obs.test.ts additionally pins the two derivations' semantics
    // (LIKE `_`/`%` versus the regex translation) over real error strings.
    const authErrors = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs
           WHERE end_time >= ? AND status = 'error' AND error IS NOT NULL
             AND run_type IN ('agent_span', 'generation_span')
             AND (${AUTH_FAILURE_MARKERS.map((m) => `error LIKE '%${m}%'`).join(" OR ")})`,
        )
        .get(since) as { n: number }
    ).n;
    return {
      window_ms: windowMs,
      runs: r.runs,
      errors: r.errors ?? 0,
      error_pct: r.runs > 0 ? (100 * (r.errors ?? 0)) / r.runs : 0,
      avg_latency_ms: r.avg_ms ?? 0,
      feedback_count: f.n,
      avg_feedback: f.n > 0 ? f.avg : null,
      cost_usd: r.cost ?? 0,
      auth_errors: authErrors,
    };
  }

  /**
   * The two review queues of spec 20.5, as counts.
   *
   * Queue 1 is work a human should look at: a run flagged `needs_review`, or one
   * carrying feedback at or below zero. Queue 2 is the expensive-or-slow tail,
   * cost or latency above the window's own p90.
   *
   * Note what queue 2 IS, because the digest must not overstate it: p90 taken
   * over the same window it filters makes the count mechanically about a tenth
   * of the runs, so it is a top-decile review lane and NOT an anomaly detector.
   * It also means the queue cannot be empty once the window holds ten runs, so
   * section 23's "non-empty for three consecutive weeks" trigger for a console
   * review lane can only ever rest on queue 1.
   *
   * `run_type` is filtered to the two span kinds `summary` uses, so the two
   * numbers in one digest are over the same population.
   */
  reviewQueues(windowMs: number, now: number = Date.now()): ReviewQueues {
    const since = now - windowMs;
    const rows = this.db
      .prepare(
        `SELECT id, cost_usd, (end_time - start_time) AS latency_ms, needs_review
         FROM runs WHERE end_time >= ? AND run_type IN ('agent_span', 'generation_span')`,
      )
      .all(since) as { id: string; cost_usd: number | null; latency_ms: number; needs_review: 0 | 1 }[];

    const negative = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT run_id FROM feedback WHERE created_at >= ? AND score IS NOT NULL AND score <= 0`,
          )
          .all(since) as { run_id: string }[]
      ).map((r) => r.run_id),
    );
    const flagged = rows.filter((r) => r.needs_review === 1 || negative.has(r.id));

    // p90 by nearest-rank on the sorted sample. Under ten runs there is no tenth
    // decile to speak of, so the queue is reported as empty rather than as the
    // single largest run, which would make any quiet window look anomalous.
    const p90 = (values: number[]): number | null => {
      const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
      if (v.length < 10) return null;
      return v[Math.min(v.length - 1, Math.ceil(0.9 * v.length) - 1)];
    };
    const p90Cost = p90(rows.map((r) => r.cost_usd ?? 0));
    const p90Latency = p90(rows.map((r) => r.latency_ms));
    const topDecile = rows.filter(
      (r) => (p90Cost !== null && (r.cost_usd ?? 0) > p90Cost) || (p90Latency !== null && r.latency_ms > p90Latency),
    );

    return {
      window_ms: windowMs,
      runs: rows.length,
      flagged: flagged.length,
      flagged_run_ids: flagged.slice(0, 5).map((r) => r.id),
      top_decile: topDecile.length,
      p90_cost_usd: p90Cost,
      p90_latency_ms: p90Latency,
    };
  }

  /** Retention (v0.4 3.9): prune old runs UNLESS they carry feedback or need review. Returns pruned count. */
  prune(keepDays: number, now: number = Date.now()): number {
    const cutoff = now - keepDays * 86_400_000;
    const res = this.db
      .prepare(
        `DELETE FROM runs WHERE end_time < ? AND needs_review = 0
         AND id NOT IN (SELECT DISTINCT run_id FROM feedback)`,
      )
      .run(cutoff);
    return res.changes;
  }
}

/** LangSmith's prebuilt alert triad, as a pure function over a summary (thresholds from R 3.5). */
export function evaluateAlerts(
  s: ObsSummary,
  thresholds = { min_runs: 5, error_pct: 20, latency_ms: 30_000, min_feedback: 3, feedback_score: 0.5 },
): Alert[] {
  const alerts: Alert[] = [];
  if (s.runs >= thresholds.min_runs && s.error_pct > thresholds.error_pct) {
    alerts.push({ kind: "error_pct", message: `error rate ${s.error_pct.toFixed(0)}% over ${s.runs} runs (window ${Math.round(s.window_ms / 60000)}m)` });
  }
  if (s.runs >= thresholds.min_runs && s.avg_latency_ms > thresholds.latency_ms) {
    alerts.push({ kind: "latency", message: `avg latency ${(s.avg_latency_ms / 1000).toFixed(1)}s over ${s.runs} runs` });
  }
  if (s.feedback_count >= thresholds.min_feedback && (s.avg_feedback ?? 1) < thresholds.feedback_score) {
    alerts.push({ kind: "feedback", message: `avg feedback ${(s.avg_feedback ?? 0).toFixed(2)} over ${s.feedback_count} records` });
  }
  // NO minimum-volume guard, and that is the point.
  //
  // The three checks above are RATES, so a minimum run count stops one unlucky
  // failure from paging an operator. A credential failure is a STATE: the agent
  // cannot work at all and no amount of retrying changes that, so a single
  // occurrence is complete evidence. Applying the volume guard to it produced
  // exactly the silence it was supposed to prevent: measured 2026-08-19, an expired
  // OAuth session gave `runs=1 errors=1 error_pct=100%` in the supervisor's
  // 15-minute window and raised NOTHING, because 1 < min_runs. A quiet room is
  // where an outage is least likely to be noticed and most likely to persist.
  if (s.auth_errors > 0) {
    alerts.push({
      kind: "credential",
      message:
        `${s.auth_errors} run(s) failed to authenticate to the model provider in the last ` +
        `${Math.round(s.window_ms / 60000)}m: no agent can answer until the operator re-authenticates. Retrying does not help`,
    });
  }
  return alerts;
}

interface RunRow {
  id: string;
  trace_id: string;
  parent_run_id: string | null;
  dotted_order: string;
  name: string;
  run_type: RunType;
  status: "success" | "error";
  error: string | null;
  start_time: number;
  end_time: number;
  project: string;
  group_id: string | null;
  inputs_json: string | null;
  outputs_json: string | null;
  tags_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  needs_review: 0 | 1;
  extra_json: string | null;
}

function hydrate(r: RunRow): ObsRun {
  return {
    id: r.id,
    trace_id: r.trace_id,
    parent_run_id: r.parent_run_id,
    dotted_order: r.dotted_order,
    name: r.name,
    run_type: r.run_type,
    status: r.status,
    error: r.error,
    start_time: r.start_time,
    end_time: r.end_time,
    project: r.project,
    group_id: r.group_id,
    inputs: parse(r.inputs_json),
    outputs: parse(r.outputs_json),
    tags: (parse(r.tags_json) as string[] | null) ?? undefined,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cost_usd: r.cost_usd,
    needs_review: r.needs_review,
    extra: (parse(r.extra_json) as Record<string, unknown> | null) ?? undefined,
  };
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const parse = (s: string | null) => (s === null ? null : (JSON.parse(s) as unknown));

/** The counts behind an `#ops` review digest (spec 20.5). */
export interface ReviewQueues {
  window_ms: number;
  runs: number;
  /** Queue 1: flagged `needs_review`, or carrying feedback at or below zero. */
  flagged: number;
  /** A few ids so the digest points somewhere, not just at a number. */
  flagged_run_ids: string[];
  /** Queue 2: cost or latency above the window's own p90. Null p90s mean too few runs to rank. */
  top_decile: number;
  p90_cost_usd: number | null;
  p90_latency_ms: number | null;
}

/**
 * One line per queue, as a digest rather than an alert.
 *
 * It says "top decile" and not "anomalies" on purpose: queue 2 is a percentile
 * lane whose size is a property of the window, and a digest that dressed it up
 * as anomaly detection would be the same defect the spec calls out for the
 * third, inexpressible queue. When there is nothing to review the digest says so
 * in one line, because a silent channel and a dead channel look identical (the
 * #ops channel WAS dead for a day, unnoticed, in exactly that way).
 */
export function formatReviewDigest(q: ReviewQueues): string {
  const hours = Math.round(q.window_ms / 3_600_000);
  const head = `#ops digest (${hours}h): ${q.runs} run${q.runs === 1 ? "" : "s"}`;
  if (q.runs === 0) return `${head}, nothing to review`;
  const lines = [head];
  lines.push(
    q.flagged === 0
      ? "  review queue: empty (no needs_review, no feedback at or below zero)"
      : `  review queue: ${q.flagged} run${q.flagged === 1 ? "" : "s"} (${q.flagged_run_ids.join(", ")}${q.flagged > q.flagged_run_ids.length ? ", ..." : ""})`,
  );
  lines.push(
    q.p90_latency_ms === null
      ? `  top decile: not ranked (under 10 runs in the window)`
      : `  top decile: ${q.top_decile} above p90 (cost $${(q.p90_cost_usd ?? 0).toFixed(4)}, latency ${(q.p90_latency_ms / 1000).toFixed(1)}s)`,
  );
  return lines.join("\n");
}
