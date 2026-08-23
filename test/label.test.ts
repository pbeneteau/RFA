/**
 * The labelling sitting (spec 20.4) as one pass: a worksheet prepared from the
 * review queue, three human fields filled, one apply that writes the feedback
 * rows and promotes. Exercised through `rfa evals label` from a directory that
 * is not a hub, with --db and --out, so the test never touches a live store.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import YAML from "yaml";
import { nodeArgsFor } from "../src/proc.js";
import { ObsStore } from "../src/obs.js";
import { applySitting, applyWorksheet, flagForReview, prepareWorksheet, reviewQueue, reviewQueueCounts } from "../src/evals/label.js";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli", "main.ts");

const run = (cwd: string, args: string[]): string =>
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "evals", "label", ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
const cli = (cwd: string, args: string[]): string =>
  execFileSync(process.execPath, [...nodeArgsFor(CLI), ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

/** A store holding one flagged trace, shaped as the resident records them. */
function storeWithFlaggedTrace(dir: string): string {
  const file = path.join(dir, "obs.db");
  const obs = new ObsStore(file);
  const now = Date.now();
  obs.record({
    id: "run_flagged01", name: "serve:pm-agent", run_type: "agent_span",
    start_time: now - 20_000, end_time: now - 5_000, group_id: "r_room",
    inputs: { from: "asker", seq: 10, text: "what are the annual fees?" },
    outputs: { text: "The knowledge does not document the fee.", chars: 39 },
    extra: { conversation: "c_conv" }, cost_usd: 0.04,
  });
  obs.markReview("run_flagged01", true);
  obs.close();
  return file;
}

test("one worksheet produces the label, the gold source and a failure mode together", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-label-"));
  const db = storeWithFlaggedTrace(dir);
  const sheet = path.join(dir, "sitting.yaml");

  const prepared = run(dir, ["--prepare", "--db", db, "--out", sheet]);
  assert.match(prepared, /1 unlabelled trace/);
  const doc = YAML.parse(fs.readFileSync(sheet, "utf8")) as { traces: Record<string, unknown>[] };
  assert.equal(doc.traces.length, 1);
  assert.equal(doc.traces[0].question, "what are the annual fees?", "the sitting is judgement, so preparation does the fetching");
  assert.equal(doc.traces[0].flagged_because, "needs_review");
  assert.equal(doc.traces[0].label, null, "and the human's three fields start empty");

  // The sitting itself: three fields, one pass.
  doc.traces[0].label = "fail";
  doc.traces[0].gold_source = "offre/plans.md#PlanA";
  doc.traces[0].failure_mode = "retrieval-wrong-file";
  fs.writeFileSync(sheet, YAML.stringify(doc));

  const applied = run(dir, ["--apply", sheet, "--db", db, "--out", path.join(dir, "cases")]);
  assert.match(applied, /1 label\(s\), 1 gold source\(s\)/);
  assert.match(applied, /retrieval-wrong-file/, "the failure mode is echoed for the ledger");

  const rows = new Database(db, { readonly: true })
    .prepare("SELECT key, score, value, comment, correction, source_type, rubric_hash FROM feedback ORDER BY key")
    .all() as { key: string; score: number | null; value: string | null; comment: string | null; correction: string | null; source_type: string; rubric_hash: string | null }[];
  assert.deepEqual(rows.map((r) => r.key), ["gold_source", "label"]);
  const label = rows.find((r) => r.key === "label")!;
  assert.equal(label.score, 0, "fail is 0: the judge is binary since 20.1");
  assert.equal(label.source_type, "human");
  assert.equal(label.rubric_hash, null, "a human row carries no rubric hash, which is how it is told from a model's");
  assert.equal(label.comment, "retrieval-wrong-file");
  const gold = rows.find((r) => r.key === "gold_source")!;
  assert.equal(gold.correction, "offre/plans.md#PlanA", "the gold source is a correction: here is what it should have cited");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an all-passing sitting prints the anti-ossification line the ledger requires", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-label-"));
  const db = storeWithFlaggedTrace(dir);
  const sheet = path.join(dir, "sitting.yaml");
  run(dir, ["--prepare", "--db", db, "--out", sheet]);
  const doc = YAML.parse(fs.readFileSync(sheet, "utf8")) as { traces: Record<string, unknown>[] };
  doc.traces[0].label = "pass";
  fs.writeFileSync(sheet, YAML.stringify(doc));

  const applied = run(dir, ["--apply", sheet, "--db", db, "--out", path.join(dir, "cases")]);
  // 20.4's checkable form: the exact words, so it can be pasted rather than paraphrased.
  assert.match(applied, /reviewed 1 traces, no new failure modes/);
  assert.match(applied, /gone blind/, "and the reason it matters, at the moment it is needed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a trace already carrying a human label is not offered again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-label-"));
  const db = storeWithFlaggedTrace(dir);
  const sheet = path.join(dir, "sitting.yaml");
  run(dir, ["--prepare", "--db", db, "--out", sheet]);
  const doc = YAML.parse(fs.readFileSync(sheet, "utf8")) as { traces: Record<string, unknown>[] };
  doc.traces[0].label = "pass";
  fs.writeFileSync(sheet, YAML.stringify(doc));
  run(dir, ["--apply", sheet, "--db", db, "--out", path.join(dir, "cases")]);

  const again = run(dir, ["--prepare", "--db", db, "--out", path.join(dir, "second.yaml")]);
  assert.match(again, /nothing to label/, "labelling is the scarce resource: never spend it twice on one trace");
  assert.match(again, /1 already carry a human label/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unlabelled worksheet is refused rather than silently writing nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-label-"));
  const db = storeWithFlaggedTrace(dir);
  const sheet = path.join(dir, "sitting.yaml");
  run(dir, ["--prepare", "--db", db, "--out", sheet]);
  assert.throws(() => run(dir, ["--apply", sheet, "--db", db, "--out", path.join(dir, "cases")]), /Command failed/, "a no-op apply must not look like a successful sitting");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the queue, the log, the two front ends

const FULL_ANSWER = "The annual fee is 1 % of the balance, taken in January (knowledge/offre/plans.md, section Plan A). There is no fee on the first 10,000 and none for the first year.";

/** A store holding one run shaped as residents record them: an EXCERPT of the answer, and the full length beside it. */
function storeWithExcerpt(dir: string, o: { runId: string; flagged: boolean }): string {
  const file = path.join(dir, "obs.db");
  const obs = new ObsStore(file);
  const now = Date.now();
  obs.record({
    id: o.runId, name: "serve:pm-agent", run_type: "agent_span",
    start_time: now - 20_000, end_time: now - 5_000, group_id: "r_room",
    inputs: { from: "asker", seq: 10, text: "what are the annual fees?" },
    outputs: { text: FULL_ANSWER.slice(0, 40), chars: FULL_ANSWER.length },
    extra: { conversation: "c_conv" }, cost_usd: 0.04,
  });
  if (o.flagged) obs.markReview(o.runId, true);
  obs.close();
  return file;
}

/** The room log the answer came from: a roster snapshot, the question, the response carrying the run id in its json part. */
function roomLogWith(dir: string, o: { runId: string; answer: string }): string {
  const file = path.join(dir, "r_room.ndjson");
  const ts = new Date().toISOString();
  const base = { rfa: "0.1", room: "r_room", to: ["m_asker"], mentions: [], in_reply_to: null, reply_by: null, task: null, chunk: null, refusal: null, _meta: {}, ext: {} };
  const events = [
    { seq: 1, ts, type: "roster", reason: "join", epoch: 1, members: [{ id: "m_pm", name: "pm-agent", state: "ready", role: "participant", card_summary: { skill_ids: ["answer-question"] } }] },
    { seq: 2, ts, type: "message", envelope: { ...base, message_id: "msg_q", seq: 2, ts, from: { id: "m_asker", name: "asker", origin: "human" }, kind: "request", conversation_id: "c_conv", body: [{ type: "text", text: "what are the annual fees?" }] } },
    { seq: 3, ts, type: "message", envelope: { ...base, message_id: "msg_a", seq: 3, ts, from: { id: "m_pm", name: "pm-agent", origin: "agent" }, kind: "response", conversation_id: "c_conv", body: [{ type: "text", text: o.answer }, { type: "json", value: { answered_by: "pm-agent", run_id: o.runId, cost_usd: 0.04 } }] } },
  ];
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

const feedbackRows = (db: string) =>
  new Database(db, { readonly: true }).prepare("SELECT run_id, key, score, value, comment, correction, source_type, rubric_hash, created_at FROM feedback ORDER BY key").all();

test("the queue reads the whole answer from the room log; without the log, the excerpt says what it is and where the rest is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-label-"));
  const db = storeWithExcerpt(dir, { runId: "run_excerpt01", flagged: true });
  const log = roomLogWith(dir, { runId: "run_excerpt01", answer: FULL_ANSWER });

  const withLog = reviewQueue({ obsDb: db, roomLogFile: () => log });
  assert.equal(withLog.traces.length, 1);
  assert.equal(withLog.traces[0].answer, FULL_ANSWER, "the response carrying this run id, whole");
  assert.equal(withLog.traces[0].answer_truncated, undefined, "so there is no excerpt note to read past");
  assert.deepEqual(withLog.traces[0].cited, ["knowledge/offre/plans.md"], "and the citations are taken from the whole answer, not the fragment");
  assert.equal(withLog.total, 1);

  const without = reviewQueue({ obsDb: db });
  assert.equal(without.traces[0].answer, FULL_ANSWER.slice(0, 40));
  assert.match(without.traces[0].answer_truncated ?? "", /^EXCERPT: 40 of \d+ chars\. Full text: room r_room conversation c_conv/, "judging a fragment unknowingly is how a sitting produces wrong anchors");
  assert.deepEqual(reviewQueueCounts(db), { queued: 1, labelled: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the dashboard's apply and the worksheet's apply write the same rows and cut the same case", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-label-"));
  const a = fs.mkdtempSync(path.join(dir, "a-"));
  const b = fs.mkdtempSync(path.join(dir, "b-"));
  const dbA = storeWithExcerpt(a, { runId: "run_twin0001", flagged: true });
  const dbB = storeWithExcerpt(b, { runId: "run_twin0001", flagged: true });
  const log = roomLogWith(dir, { runId: "run_twin0001", answer: FULL_ANSWER });
  const clock = () => 1_700_000_000_000;

  // The tab: the queue in memory, a verdict written onto the trace, applied.
  const queue = reviewQueue({ obsDb: dbA, roomLogFile: () => log });
  const fromTab = applySitting({
    obsDb: dbA, roomLogFile: () => log, outRoot: path.join(a, "cases"), now: clock,
    traces: [{ ...queue.traces[0], label: "fail", gold_source: "offre/plans.md#PlanA", failure_mode: "retrieval-wrong-file", promote: true }],
  });
  // The command: the same queue as a worksheet, the same three fields filled by hand, applied.
  const sheet = path.join(b, "sitting.yaml");
  prepareWorksheet({ obsDb: dbB, out: sheet, roomLogFile: () => log });
  const doc = YAML.parse(fs.readFileSync(sheet, "utf8")) as { traces: Record<string, unknown>[] };
  assert.equal(doc.traces[0].answer, FULL_ANSWER, "the worksheet gets the whole answer too");
  Object.assign(doc.traces[0], { label: "fail", gold_source: "offre/plans.md#PlanA", failure_mode: "retrieval-wrong-file", promote: true });
  fs.writeFileSync(sheet, YAML.stringify(doc));
  const fromSheet = applyWorksheet({ obsDb: dbB, file: sheet, roomLogFile: () => log, outRoot: path.join(b, "cases"), now: clock });

  assert.deepEqual(feedbackRows(dbA), feedbackRows(dbB), "one implementation behind both front ends: the rows cannot differ");
  assert.deepEqual(fromTab.promoted, ["pm-agent-retrieval-wrong-file-in0001"]);
  assert.deepEqual(fromSheet.promoted, fromTab.promoted);
  for (const root of [path.join(a, "cases"), path.join(b, "cases")]) {
    const def = YAML.parse(fs.readFileSync(path.join(root, "pm-agent-retrieval-wrong-file-in0001", "case.yaml"), "utf8")) as Record<string, unknown>;
    assert.equal(def.failure_mode, "retrieval-wrong-file", "the case exists to catch the failure mode the sitting named");
    assert.equal(def.origin_run_id, "run_twin0001", "provenance stamped at promotion (spec 20.2)");
  }
  assert.equal(fromTab.promotedNotes.length, 1);
  assert.match(fromTab.promotedNotes[0].notes[0], /edit case\.yaml/, "promote's own notes travel with the result, so the tab can show them");
  assert.equal(fromTab.ledgerLine, null, "a failing sitting owes no anti-ossification line");
  assert.deepEqual(reviewQueueCounts(dbA), { queued: 0, labelled: 1 });
  assert.equal(reviewQueue({ obsDb: dbA }).alreadyLabelled, 1, "and the trace is never offered again");
  assert.throws(() => applySitting({ obsDb: dbA, roomLogFile: () => log, outRoot: a, traces: queue.traces }), /no trace in this sitting has label/, "an unjudged sitting writes nothing, loudly");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a person flags a wrong answer and the queue lists it with the reason beside it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-label-"));
  const db = storeWithExcerpt(dir, { runId: "run_unflagged1", flagged: false });
  assert.equal(reviewQueue({ obsDb: db }).traces.length, 0, "nothing flagged it: evals and parity only flag their own failures");

  const out = cli(dir, ["evals", "flag", "run_unflagged1", "cited the wrong plan", "--db", db]);
  assert.match(out, /run_unflagged1 flagged for the sitting/);
  const q = reviewQueue({ obsDb: db });
  assert.equal(q.traces.length, 1);
  assert.equal(q.traces[0].flagged_because, "flag = 0: cited the wrong plan", "the reason a person gave, where the sitting reads it");
  assert.deepEqual(reviewQueueCounts(db), { queued: 1, labelled: 0 }, "a flag is not a label: the sitting is still owed");
  assert.throws(() => flagForReview({ obsDb: db, runId: "run_nowhere" }), /no run run_nowhere/, "a typo in the id is said, not written");
  fs.rmSync(dir, { recursive: true, force: true });
});
