/**
 * The labelling sitting (spec 20.4), as one pass instead of four campaigns.
 *
 * 20.4 says labelling is the scarce resource and requires ONE pass over the same
 * traces producing the binary label, the gold source reference and the
 * promotion with provenance TOGETHER. Pricing those as three campaigns was called
 * the wave's most expensive unpriced assumption, so the instrument makes them one
 * action: the review queue is read with all the fetching and formatting done, so
 * the sitting is only judgement, and applying it writes the human feedback rows
 * and cuts the promoted cases by delegating to `promoteCase`, so there is one
 * implementation of a slice and not two.
 *
 * Two front ends, one implementation: `rfa evals label --prepare|--apply` goes
 * through a YAML worksheet (`prepareWorksheet`, `applyWorksheet`); the
 * dashboard's Evals tab holds the same traces in memory and applies them with
 * the same `applySitting`, so the rows it writes cannot differ from the
 * command's.
 *
 * Was scripts/label.ts; now `rfa evals label` and the Evals tab.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { promoteCase } from "./promote.js";

export interface Trace {
  run_id: string;
  agent: string;
  when: string;
  flagged_because: string;
  question: string;
  answer: string;
  cited: string[];
  room: string | null;
  conversation: string | null;
  /** Set when the stored answer is a 300-char excerpt, so a labeller is never judging a fragment unknowingly. */
  answer_truncated?: string;
  label: string | null;
  gold_source: string | null;
  failure_mode: string | null;
  promote: boolean;
}

/** Knowledge paths the answer cited, which is what a gold source is compared against. */
function citations(answer: string): string[] {
  return [...new Set(answer.match(/[\w./-]*(?:knowledge|spec)\/[\w./-]+\.mdx?/g) ?? [])];
}

/** The review queue of spec 20.5: flagged `needs_review`, or carrying feedback at or below zero. */
const QUEUE_WHERE = `run_type IN ('agent_span','generation_span') AND (needs_review = 1 OR id IN (SELECT run_id FROM feedback WHERE score IS NOT NULL AND score <= 0))`;
const HUMAN_LABELLED = `SELECT DISTINCT run_id FROM feedback WHERE source_type = 'human' AND key = 'label'`;

export interface QueueCounts {
  /** Traces in the review queue that carry no human label yet: the size of the next sitting. */
  queued: number;
  /** Traces that already carry one: labelling is never spent twice on a trace. */
  labelled: number;
}

/** The two numbers a dashboard shows before anything is read: what waits, what was judged. */
export function reviewQueueCounts(obsDb: string): QueueCounts {
  const db = new Database(obsDb, { readonly: true });
  try {
    const queued = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE ${QUEUE_WHERE} AND id NOT IN (${HUMAN_LABELLED})`).get() as { n: number }).n;
    const labelled = (db.prepare(`SELECT COUNT(*) AS n FROM (${HUMAN_LABELLED})`).get() as { n: number }).n;
    return { queued, labelled };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- the full answer

/**
 * Residents record a 300-char EXCERPT of an answer in obs.db; the room log holds
 * the whole of it, in the response message that carries the run id in its json
 * part. A sitting that judges the fragment as if it were the answer produces
 * anchors that are subtly wrong, so when the log is at hand the queue reads the
 * answer from it and the excerpt note disappears.
 */
export interface AnswerIndex {
  byRun: Map<string, string>;
  /** `<conversation id>|<agent name>` -> the last response text, for logs written before run ids were stamped. */
  byConversation: Map<string, string>;
}

export function indexAnswers(logFile: string): AnswerIndex {
  const index: AnswerIndex = { byRun: new Map(), byConversation: new Map() };
  if (!fs.existsSync(logFile)) return index;
  for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; envelope?: { kind?: string; conversation_id?: string | null; from?: { name?: string }; body?: { type: string; text?: string; value?: unknown }[] } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "message" || e.envelope?.kind !== "response") continue;
    const env = e.envelope;
    const text = (env.body ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("\n");
    if (!text) continue;
    for (const p of env.body ?? []) {
      if (p.type === "json" && p.value && typeof p.value === "object" && typeof (p.value as { run_id?: unknown }).run_id === "string") index.byRun.set((p.value as { run_id: string }).run_id, text);
    }
    if (env.conversation_id && env.from?.name) index.byConversation.set(`${env.conversation_id}|${env.from.name}`, text);
  }
  return index;
}

export function fullAnswer(index: AnswerIndex, t: { run_id: string; conversation: string | null; agent: string }): string | null {
  return index.byRun.get(t.run_id) ?? (t.conversation ? index.byConversation.get(`${t.conversation}|${t.agent}`) : undefined) ?? null;
}

// ---------------------------------------------------------------- the queue

export interface QueueOptions {
  obsDb: string;
  /** Newest first; the CLI's worksheet and the dashboard both read the same default. */
  limit?: number;
  /** Where a room's log is, so the full answer replaces the excerpt; without it the excerpt note says where the rest is. */
  roomLogFile?: (room: string) => string;
  tailHint?: (room: string) => string;
}

export interface Queue {
  traces: Trace[];
  /** Among the newest `limit` queued runs, how many already carry a human label and were left out. */
  alreadyLabelled: number;
  /** Every queued run without a human label, beyond the limit too. */
  total: number;
}

/**
 * The review queue (spec 20.5, newest first: the same population the #ops digest
 * counts, so a sitting works through exactly what the digest reported), with
 * the three human fields empty and everything else fetched.
 */
export function reviewQueue(o: QueueOptions): Queue {
  const db = new Database(o.obsDb, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, name, end_time, inputs_json, outputs_json, extra_json, group_id, needs_review
         FROM runs WHERE ${QUEUE_WHERE} ORDER BY end_time DESC LIMIT ?`,
      )
      .all(o.limit ?? 25) as { id: string; name: string; end_time: number; inputs_json: string | null; outputs_json: string | null; extra_json: string | null; group_id: string | null; needs_review: 0 | 1 }[];
    const already = new Set((db.prepare(HUMAN_LABELLED).all() as { run_id: string }[]).map((r) => r.run_id));
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE ${QUEUE_WHERE} AND id NOT IN (${HUMAN_LABELLED})`).get() as { n: number }).n;
    const negativeOf = db.prepare(`SELECT key, score, comment FROM feedback WHERE run_id = ? AND score <= 0 LIMIT 1`);
    const logs = new Map<string, AnswerIndex>();
    const logFor = (room: string): AnswerIndex => {
      let idx = logs.get(room);
      if (!idx) {
        idx = o.roomLogFile ? indexAnswers(o.roomLogFile(room)) : { byRun: new Map(), byConversation: new Map() };
        logs.set(room, idx);
      }
      return idx;
    };
    const traces: Trace[] = rows
      .filter((r) => !already.has(r.id))
      .map((r) => {
        const inputs = JSON.parse(r.inputs_json ?? "{}") as { text?: string; from?: string };
        const outputs = JSON.parse(r.outputs_json ?? "{}") as { text?: string; chars?: number };
        const extra = JSON.parse(r.extra_json ?? "{}") as { conversation?: string };
        const agent = r.name.replace(/^serve:/, "");
        const excerpt = outputs.text ?? "";
        const fullChars = outputs.chars ?? excerpt.length;
        const conversation = extra.conversation ?? null;
        const fromLog = r.group_id && fullChars > excerpt.length ? fullAnswer(logFor(r.group_id), { run_id: r.id, conversation, agent }) : null;
        const answer = fromLog ?? excerpt;
        const negative = negativeOf.get(r.id) as { key: string; score: number; comment: string | null } | undefined;
        return {
          run_id: r.id,
          agent,
          when: new Date(r.end_time).toISOString(),
          flagged_because: negative ? `${negative.key} = ${negative.score}${negative.comment ? `: ${negative.comment.slice(0, 120)}` : ""}` : "needs_review",
          question: inputs.text ?? "",
          answer,
          cited: citations(answer),
          room: r.group_id,
          conversation,
          // Only when the log did not yield the whole answer: say so, and say where the rest is.
          ...(fullChars > answer.length ? { answer_truncated: `EXCERPT: ${answer.length} of ${fullChars} chars. Full text: room ${r.group_id} conversation ${conversation ?? "?"} (${o.tailHint ? o.tailHint(r.group_id ?? "?") : `rfa room tail ${r.group_id}`})` } : {}),
          label: null,
          gold_source: null,
          failure_mode: null,
          promote: false,
        };
      });
    return { traces, alreadyLabelled: rows.length - traces.length, total };
  } finally {
    db.close();
  }
}

export function prepareWorksheet(o: QueueOptions & { out: string; rubric?: string }): { out: string; traces: number; alreadyLabelled: number } {
  const q = reviewQueue(o);
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(
    o.out,
    YAML.stringify({
      prepared_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      rubric: o.rubric ?? "evals/rubric.md",
      how_to_fill: "For each trace set label (pass|fail), gold_source (the file#section that SHOULD be cited), failure_mode (free text, only when fail, the same words you will use in the findings ledger), and promote (true to cut it into an eval case). Leave a trace's label empty to skip it.",
      traces: q.traces,
    }),
  );
  return { out: o.out, traces: q.traces.length, alreadyLabelled: q.alreadyLabelled };
}

// ---------------------------------------------------------------- applying

export interface ApplyResult {
  labelled: number;
  golds: number;
  promoted: string[];
  /** Where each promoted case landed and what promote asks to be edited, in promote's own words. */
  promotedNotes: { caseId: string; dir: string; notes: string[] }[];
  failures: string[];
  /** The anti-ossification line spec 20.4 requires for an all-passing review, when it applies. */
  ledgerLine: string | null;
  problems: string[];
}

export interface ApplyOptions {
  obsDb: string;
  roomLogFile: (room: string) => string;
  outRoot: string;
  now?: () => number;
}

/**
 * The sitting, applied: one human `label` row per judged trace (pass 1, fail 0,
 * the failure mode as its comment), one `gold_source` row where a source was
 * named (as a correction: here is what it should have cited), and a case cut by
 * `promoteCase` where promotion was asked. A trace without `pass` or `fail` is
 * skipped, never written.
 */
export function applySitting(o: ApplyOptions & { traces: Trace[] }): ApplyResult {
  const filled = o.traces.filter((t) => t.label === "pass" || t.label === "fail");
  if (filled.length === 0) throw new Error("no trace in this sitting has label: pass or label: fail");
  const db = new Database(o.obsDb);
  // Residents write this store while a sitting is applied; wait for them rather than fail.
  db.pragma("busy_timeout = 5000");
  const result: ApplyResult = { labelled: 0, golds: 0, promoted: [], promotedNotes: [], failures: [], ledgerLine: null, problems: [] };
  try {
    const insert = db.prepare(`INSERT INTO feedback (run_id, key, score, value, comment, correction, source_type, rubric_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, 'human', NULL, ?)`);
    for (const t of filled) {
      const now = o.now ? o.now() : Date.now();
      // The binary label (20.1): a human row carries no rubric_hash, which is the
      // schema's way of saying a person judged this and not a model reading a rubric.
      insert.run(t.run_id, "label", t.label === "pass" ? 1 : 0, t.label, t.failure_mode ?? null, null, now);
      result.labelled++;
      if (t.gold_source) {
        insert.run(t.run_id, "gold_source", null, t.gold_source, null, t.gold_source, now);
        result.golds++;
      }
      if (t.label === "fail" && t.failure_mode) result.failures.push(t.failure_mode);
      if (!t.promote) continue;
      if (!t.room || !t.conversation) {
        result.problems.push(`cannot promote ${t.run_id}: the sitting has no room/conversation for it`);
        continue;
      }
      const caseId = `${t.agent}-${t.failure_mode ? t.failure_mode.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 32) : "labelled"}-${t.run_id.slice(-6)}`;
      try {
        const p = promoteCase({ logFile: o.roomLogFile(t.room), room: t.room, conversation: t.conversation, caseId, outRoot: o.outRoot, failureMode: t.failure_mode ?? undefined });
        result.promoted.push(caseId);
        result.promotedNotes.push({ caseId, dir: p.dir, notes: p.notes });
      } catch (err) {
        result.problems.push(`promotion failed for ${t.run_id}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    db.close();
  }
  const passes = filled.filter((t) => t.label === "pass").length;
  if (passes === filled.length) result.ledgerLine = `reviewed ${filled.length} traces, no new failure modes`;
  return result;
}

export function applyWorksheet(o: ApplyOptions & { file: string }): ApplyResult {
  const doc = YAML.parse(fs.readFileSync(o.file, "utf8")) as { traces: Trace[] };
  return applySitting({ ...o, traces: doc.traces ?? [] });
}

// ---------------------------------------------------------------- flagging

/**
 * A person saying "this answer was wrong", from `rfa evals flag` or `!` on the
 * ask box's answer. The run is marked `needs_review` and a human `flag` row at 0
 * keeps the reason, so the next sitting lists the trace with the reason beside
 * it. Evals and parity flag their own failures; before this a person reading a
 * wrong answer had no way into the queue, and the flywheel's only entries were
 * the ones an instrument had already caught.
 */
export function flagForReview(o: { obsDb: string; runId: string; note?: string | null; now?: () => number }): void {
  const db = new Database(o.obsDb);
  db.pragma("busy_timeout = 5000");
  try {
    if (!db.prepare(`SELECT id FROM runs WHERE id = ?`).get(o.runId)) throw new Error(`no run ${o.runId} in ${o.obsDb}: the id is on the answer's json part, and residents record the run when the answer is sent`);
    db.prepare(`UPDATE runs SET needs_review = 1 WHERE id = ?`).run(o.runId);
    db.prepare(`INSERT INTO feedback (run_id, key, score, value, comment, correction, source_type, rubric_hash, created_at) VALUES (?, 'flag', 0, 'flagged', ?, NULL, 'human', NULL, ?)`).run(o.runId, o.note?.trim() || null, o.now ? o.now() : Date.now());
  } finally {
    db.close();
  }
}
