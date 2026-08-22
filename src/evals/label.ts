/**
 * The labelling sitting (spec 20.4), as one pass instead of four campaigns.
 *
 * 20.4 says labelling is the scarce resource and requires ONE pass over the same
 * traces producing the binary label, the gold source reference and the
 * promotion with provenance TOGETHER. Pricing those as three campaigns was called
 * the wave's most expensive unpriced assumption, so the instrument makes them one
 * action: a worksheet is prepared with all the fetching and formatting done, so
 * the sitting is only judgement, and applying it writes the human feedback rows
 * and cuts the promoted cases by delegating to `promoteCase`, so there is one
 * implementation of a slice and not two.
 *
 * Was scripts/label.ts; now `rfa evals label`.
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

export function prepareWorksheet(o: { obsDb: string; out: string; limit?: number; rubric?: string; tailHint?: (room: string) => string }): { out: string; traces: number; alreadyLabelled: number } {
  const db = new Database(o.obsDb, { readonly: true });
  try {
    // The review queue of spec 20.5, newest first: the same population the #ops
    // digest counts, so a sitting works through exactly what the digest reported.
    const rows = db
      .prepare(
        `SELECT id, name, end_time, inputs_json, outputs_json, extra_json, group_id, needs_review
         FROM runs
         WHERE run_type IN ('agent_span','generation_span')
           AND (needs_review = 1 OR id IN (SELECT run_id FROM feedback WHERE score IS NOT NULL AND score <= 0))
         ORDER BY end_time DESC LIMIT ?`,
      )
      .all(o.limit ?? 25) as { id: string; name: string; end_time: number; inputs_json: string | null; outputs_json: string | null; extra_json: string | null; group_id: string | null; needs_review: 0 | 1 }[];
    const already = new Set((db.prepare(`SELECT DISTINCT run_id FROM feedback WHERE source_type = 'human' AND key = 'label'`).all() as { run_id: string }[]).map((r) => r.run_id));
    const traces: Trace[] = rows
      .filter((r) => !already.has(r.id))
      .map((r) => {
        const inputs = JSON.parse(r.inputs_json ?? "{}") as { text?: string; from?: string };
        const outputs = JSON.parse(r.outputs_json ?? "{}") as { text?: string; chars?: number };
        const extra = JSON.parse(r.extra_json ?? "{}") as { conversation?: string };
        const answer = outputs.text ?? "";
        const fullChars = outputs.chars ?? answer.length;
        const negative = db.prepare(`SELECT key, score, comment FROM feedback WHERE run_id = ? AND score <= 0 LIMIT 1`).get(r.id) as { key: string; score: number; comment: string | null } | undefined;
        return {
          run_id: r.id,
          agent: r.name.replace(/^serve:/, ""),
          when: new Date(r.end_time).toISOString(),
          flagged_because: negative ? `${negative.key} = ${negative.score}${negative.comment ? `: ${negative.comment.slice(0, 120)}` : ""}` : "needs_review",
          question: inputs.text ?? "",
          answer,
          cited: citations(answer),
          room: r.group_id,
          conversation: extra.conversation ?? null,
          // obs.db stores a 300-char excerpt of an answer, not the answer. Judging a
          // fragment as if it were the whole thing is how a sitting produces anchors
          // that are subtly wrong, so say so and say where the rest is.
          ...(fullChars > answer.length ? { answer_truncated: `EXCERPT: ${answer.length} of ${fullChars} chars. Full text: room ${r.group_id} conversation ${extra.conversation ?? "?"} (${o.tailHint ? o.tailHint(r.group_id ?? "?") : `rfa room tail ${r.group_id}`})` } : {}),
          label: null,
          gold_source: null,
          failure_mode: null,
          promote: false,
        };
      });
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    fs.writeFileSync(
      o.out,
      YAML.stringify({
        prepared_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        rubric: o.rubric ?? "evals/rubric.md",
        how_to_fill: "For each trace set label (pass|fail), gold_source (the file#section that SHOULD be cited), failure_mode (free text, only when fail, the same words you will use in the findings ledger), and promote (true to cut it into an eval case). Leave a trace's label empty to skip it.",
        traces,
      }),
    );
    return { out: o.out, traces: traces.length, alreadyLabelled: rows.length - traces.length };
  } finally {
    db.close();
  }
}

export interface ApplyResult {
  labelled: number;
  golds: number;
  promoted: string[];
  failures: string[];
  /** The anti-ossification line spec 20.4 requires for an all-passing review, when it applies. */
  ledgerLine: string | null;
  problems: string[];
}

export function applyWorksheet(o: { obsDb: string; file: string; roomLogFile: (room: string) => string; outRoot: string; now?: () => number }): ApplyResult {
  const doc = YAML.parse(fs.readFileSync(o.file, "utf8")) as { traces: Trace[] };
  const filled = (doc.traces ?? []).filter((t) => t.label === "pass" || t.label === "fail");
  if (filled.length === 0) throw new Error("no trace in this worksheet has label: pass or label: fail");
  const db = new Database(o.obsDb);
  const result: ApplyResult = { labelled: 0, golds: 0, promoted: [], failures: [], ledgerLine: null, problems: [] };
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
        result.problems.push(`cannot promote ${t.run_id}: the worksheet has no room/conversation for it`);
        continue;
      }
      const caseId = `${t.agent}-${t.failure_mode ? t.failure_mode.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 32) : "labelled"}-${t.run_id.slice(-6)}`;
      try {
        promoteCase({ logFile: o.roomLogFile(t.room), room: t.room, conversation: t.conversation, caseId, outRoot: o.outRoot, failureMode: t.failure_mode ?? undefined });
        result.promoted.push(caseId);
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
