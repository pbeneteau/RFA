/**
 * The labelling sitting (spec 20.4), as one pass instead of four campaigns.
 *
 *   npx tsx scripts/label.ts --prepare              # write a worksheet of review-queue traces
 *   npx tsx scripts/label.ts --prepare --limit 20 --out reports/sitting.yaml
 *   npx tsx scripts/label.ts --apply reports/sitting.yaml
 *
 * 20.4 says labelling is the scarce resource in this release and requires ONE pass
 * over the same traces producing the binary label, the gold source reference and
 * the promotion with provenance TOGETHER. Pricing those as three campaigns was
 * called the wave's most expensive unpriced assumption, so the instrument has to
 * make them one action or the requirement is unmeetable in practice.
 *
 * Hence a worksheet rather than an interactive prompt. Preparing does all the
 * fetching and formatting, so the sitting is only judgement: read the question and
 * the answer, write three fields. Applying then writes the human feedback rows and
 * cuts the promoted cases, with provenance, by delegating to promote-case.ts so
 * there is one implementation of a slice and not two.
 *
 * It also prints the anti-ossification line 20.4 requires when a sitting finds
 * nothing wrong, in the exact words the findings ledger wants, because an
 * all-passing review that leaves no record is indistinguishable from an instrument
 * that has gone blind.
 */
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
// `--db` for the same reason promote-case.ts takes `--log`: the real store is
// live, and a test that wrote human labels into it would poison the corpus the
// judge is calibrated against.
const OBS = process.argv.includes("--db") ? process.argv[process.argv.indexOf("--db") + 1] : path.join(ROOT, "data", "obs.db");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const mode = process.argv.includes("--prepare") ? "prepare" : process.argv.includes("--apply") ? "apply" : null;
if (!mode) {
  console.error("usage: label.ts --prepare [--limit N] [--out file] | --apply <worksheet.yaml>");
  process.exit(2);
}
if (!fs.existsSync(OBS)) {
  console.error(`no observability store at ${OBS}`);
  process.exit(1);
}

type Trace = {
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
};

/** Knowledge paths the answer cited, which is what a gold source is compared against. */
function citations(answer: string): string[] {
  return [...new Set(answer.match(/[\w./-]*(?:knowledge|spec)\/[\w./-]+\.mdx?/g) ?? [])];
}

if (mode === "prepare") {
  const limit = Number(flag("--limit") ?? 25);
  const out = flag("--out") ?? path.join(ROOT, "reports", `labelling-${new Date().toISOString().slice(0, 10)}.yaml`);
  const db = new Database(OBS, { readonly: true });
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
    .all(limit) as {
    id: string; name: string; end_time: number; inputs_json: string | null;
    outputs_json: string | null; extra_json: string | null; group_id: string | null; needs_review: 0 | 1;
  }[];

  const already = new Set(
    (db.prepare(`SELECT DISTINCT run_id FROM feedback WHERE source_type = 'human' AND key = 'label'`).all() as { run_id: string }[])
      .map((r) => r.run_id),
  );
  const traces: Trace[] = rows
    .filter((r) => !already.has(r.id))
    .map((r) => {
      const inputs = JSON.parse(r.inputs_json ?? "{}") as { text?: string; from?: string };
      const outputs = JSON.parse(r.outputs_json ?? "{}") as { text?: string };
      const extra = JSON.parse(r.extra_json ?? "{}") as { conversation?: string };
      const answer = outputs.text ?? "";
      const fullChars = (outputs as { chars?: number }).chars ?? answer.length;
      const negative = db
        .prepare(`SELECT key, score, comment FROM feedback WHERE run_id = ? AND score <= 0 LIMIT 1`)
        .get(r.id) as { key: string; score: number; comment: string | null } | undefined;
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
        // fragment as if it were the whole thing is how a labelling sitting
        // produces anchors that are subtly wrong, so say so and say where the rest is.
        ...(fullChars > answer.length
          ? { answer_truncated: `EXCERPT: ${answer.length} of ${fullChars} chars. Full text: room ${r.group_id} conversation ${extra.conversation ?? "?"} (npm run tail -- data/rooms/${r.group_id}.ndjson)` }
          : {}),
        label: null,
        gold_source: null,
        failure_mode: null,
        promote: false,
      };
    });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const doc = {
    prepared_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    rubric: "evals/rubric.md",
    how_to_fill:
      "For each trace set label (pass|fail), gold_source (the file#section that SHOULD be cited), " +
      "failure_mode (free text, only when fail, the same words you will use in the findings ledger), " +
      "and promote (true to cut it into an eval case). Leave a trace's label empty to skip it.",
    traces,
  };
  fs.writeFileSync(out, YAML.stringify(doc));
  console.log(`worksheet: ${path.relative(ROOT, out)} (${traces.length} unlabelled trace(s) from the review queue)`);
  if (rows.length > traces.length) console.log(`  ${rows.length - traces.length} already carry a human label and were left out`);
  if (traces.length === 0) console.log("  nothing to label: the review queue is empty or fully labelled");
  db.close();
  process.exit(0);
}

// ------------------------------------------------------------------- apply

const file = flag("--apply");
if (!file || !fs.existsSync(file)) {
  console.error(`--apply needs a worksheet file (got ${file ?? "nothing"})`);
  process.exit(2);
}
const doc = YAML.parse(fs.readFileSync(file, "utf8")) as { traces: Trace[] };
const filled = (doc.traces ?? []).filter((t) => t.label === "pass" || t.label === "fail");
if (filled.length === 0) {
  console.error("no trace in this worksheet has label: pass or label: fail");
  process.exit(1);
}

const db = new Database(OBS);
const insert = db.prepare(
  `INSERT INTO feedback (run_id, key, score, value, comment, correction, source_type, rubric_hash, created_at)
   VALUES (?, ?, ?, ?, ?, ?, 'human', NULL, ?)`,
);
let labelled = 0;
let golds = 0;
const promoted: string[] = [];
const failures: string[] = [];

for (const t of filled) {
  const now = Date.now();
  // The binary label (20.1): a human row carries no rubric_hash, which is the
  // schema's way of saying a person judged this and not a model reading a rubric.
  insert.run(t.run_id, "label", t.label === "pass" ? 1 : 0, t.label, t.failure_mode ?? null, null, now);
  labelled++;
  if (t.gold_source) {
    // The gold source reference: what the answer SHOULD have cited. It goes in
    // `correction`, because that is the universal feedback record's field for
    // "here is the right answer", and a later case can assert against it.
    insert.run(t.run_id, "gold_source", null, t.gold_source, null, t.gold_source, now);
    golds++;
  }
  if (t.label === "fail" && t.failure_mode) failures.push(t.failure_mode);

  if (!t.promote) continue;
  if (!t.room || !t.conversation) {
    console.error(`  cannot promote ${t.run_id}: the worksheet has no room/conversation for it`);
    continue;
  }
  const caseId = `${t.agent}-${t.failure_mode ? t.failure_mode.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 32) : "labelled"}-${t.run_id.slice(-6)}`;
  try {
    // Delegated, not reimplemented: promote-case.ts owns slicing and stamps the
    // five provenance keys of 20.2, and two implementations of a slice would drift.
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "scripts", "promote-case.ts"), t.room,
       "--conversation", t.conversation, "--id", caseId,
       ...(t.failure_mode ? ["--failure-mode", t.failure_mode] : [])],
      { cwd: ROOT, encoding: "utf8" },
    );
    promoted.push(caseId);
    console.log(out.trim().split("\n")[0]);
  } catch (err) {
    console.error(`  promotion failed for ${t.run_id}: ${(err as Error).message.split("\n")[0]}`);
  }
}
db.close();

const passes = filled.filter((t) => t.label === "pass").length;
console.log(`\nsitting applied: ${labelled} label(s), ${golds} gold source(s), ${promoted.length} case(s) promoted`);
if (failures.length > 0) {
  console.log(`failure modes recorded: ${[...new Set(failures)].join("; ")}`);
}
// Spec 20.4's anti-ossification requirement, in the exact form the ledger wants.
if (passes === filled.length) {
  console.log(`\nPASTE THIS INTO THE FINDINGS LEDGER (spec 20.4 requires it for an all-passing review):`);
  console.log(`  reviewed ${filled.length} traces, no new failure modes`);
  console.log(`An all-passing review with no such entry is an unaudited instrument: nothing distinguishes`);
  console.log(`an instrument that has finished from one that has gone blind.`);
}
