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

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli", "main.ts");

const run = (cwd: string, args: string[]): string =>
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "evals", "label", ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

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
