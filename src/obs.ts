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
}

export interface Alert {
  kind: "error_pct" | "latency" | "feedback";
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
    return {
      window_ms: windowMs,
      runs: r.runs,
      errors: r.errors ?? 0,
      error_pct: r.runs > 0 ? (100 * (r.errors ?? 0)) / r.runs : 0,
      avg_latency_ms: r.avg_ms ?? 0,
      feedback_count: f.n,
      avg_feedback: f.n > 0 ? f.avg : null,
      cost_usd: r.cost ?? 0,
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
