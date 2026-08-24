/**
 * Reflection (RFA-0.4 sect. 5.4) with an injected model: the plumbing is what
 * must not lie. Incidents are gathered and grouped off the feedback spine, the
 * proposal round-trips (what a human reviewed is exactly what commits), the
 * gate kills a lesson that parrots an asker's words, the watermark is consumed
 * by apply and empty scans but never by propose, and a proposal applies once.
 */
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, test } from "node:test";
import { ObsStore } from "../src/obs.js";
import { gatherIncidents, reflect } from "../src/reflect.js";
import { loadHubDir, type HubDir } from "../src/hubdir.js";
import { EpisodeLog, FactStore } from "../src/memoryfs.js";
import { nodeArgsFor } from "../src/proc.js";
import type { LlmFn } from "../src/consolidate.js";
import { freePort } from "./hubproc.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "src", "cli", "main.ts");

const QUESTION = "what are the annual fees for the premium envelope plan this year?";
const LESSON = "For annual fee questions, read offre/enveloppes.md and cite the section, not offre/plan-a.md.";

let dir: string;
let h: HubDir;

/** The injected model: lessons on the extract pass, ADDs on the reconcile pass; the parroted lesson is the gate's job to kill. */
const fake: LlmFn = async (_cwd, system, _prompt) => {
  if (system.includes("reconcile")) {
    return { text: JSON.stringify({ memory: [{ text: LESSON, event: "ADD", importance: 0.8 }, { text: QUESTION, event: "ADD", importance: 0.4 }] }), cost: 0.001 };
  }
  return { text: JSON.stringify({ lessons: [{ text: LESSON, kind: "retrieval", evidence: ["run_ref_a"] }, { text: QUESTION, kind: "fact", evidence: [] }] }), cost: 0.002 };
};

function rfa(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [...nodeArgsFor(CLI), ...args], { cwd: dir, env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-reflect-"));
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "init", "--yes", "--no-start", "--agent", "none", "--name", "refl", "--port", String(await freePort()), "--human", "paul"], { cwd: dir, encoding: "utf8", env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" } });
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "agent", "new", "pm", "--kind", "answerer"], { cwd: dir, encoding: "utf8", env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" } });
  h = loadHubDir(dir);
});

test("before any judged record exists, the command says so instead of spending a model call", async () => {
  const r = await rfa(["agent", "reflect", "pm", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { deferred?: string };
  assert.match(parsed.deferred ?? "", /no observability store yet/);
  const bad = await rfa(["agent", "reflect", "pm", "--batch", "abc"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--batch takes a whole number/);
});

test("incidents are gathered off the feedback spine, grouped per answer, with the retrieved set beside the judgements", () => {
  const obs = new ObsStore(h.paths.obsDb);
  const now = Date.now();
  obs.record({ id: "run_ref_a", name: "serve:pm", run_type: "agent_span", start_time: now - 9000, end_time: now - 8000, group_id: "r_x", inputs: { text: QUESTION }, outputs: { text: "The fee is 2%.", chars: 14 }, extra: { retrieved: ["knowledge/offre/plan-a.md"] } });
  obs.record({ id: "run_ref_b", name: "serve:pm", run_type: "agent_span", start_time: now - 7000, end_time: now - 6000, inputs: { text: "ok?" }, outputs: { text: "fine" } });
  obs.record({ id: "run_other", name: "serve:linear-agent", run_type: "agent_span", start_time: now - 5000, end_time: now - 4000, inputs: { text: "x" }, outputs: { text: "y" } });
  // The spine: a human label with its failure mode, the gold source, a failed eval trial; a pass and another agent's fail advance the cursor without becoming incidents.
  obs.feedback({ run_id: "run_ref_a", key: "label", score: 0, value: "fail", comment: "retrieval-wrong-file", source_type: "human" });
  obs.feedback({ run_id: "run_ref_a", key: "gold_source", score: null, value: "offre/enveloppes.md#Fees", correction: "offre/enveloppes.md#Fees", source_type: "human" });
  obs.feedback({ run_id: "run_ref_a", key: "eval:pm-fees", score: 0, comment: 'output: missing ["1 %"]', source_type: "evaluator" });
  obs.feedback({ run_id: "run_ref_b", key: "label", score: 1, value: "pass", source_type: "human" });
  obs.feedback({ run_id: "run_other", key: "eval:linear-01", score: 0, comment: "missing", source_type: "evaluator" });
  obs.close();

  const g = gatherIncidents(h.paths.obsDb, "pm", 0);
  assert.equal(g.scanned, 5, "every feedback row is scanned");
  assert.equal(g.incidents.length, 1, "grouped per answer; passes and other agents are not incidents");
  const inc = g.incidents[0];
  assert.equal(inc.run_id, "run_ref_a");
  assert.equal(inc.question, QUESTION);
  assert.deepEqual(inc.retrieved, ["knowledge/offre/plan-a.md"], "what it actually read, beside what it was told");
  assert.deepEqual(inc.signals.map((s) => s.key), ["label", "gold_source", "eval:pm-fees"]);
  assert.match(inc.signals[1].note ?? "", /should have cited offre\/enveloppes\.md#Fees/);
  const again = gatherIncidents(h.paths.obsDb, "pm", g.watermark);
  assert.equal(again.scanned, 0, "the watermark is a complete cursor");
});

test("propose writes the file and consumes nothing; applying the reviewed file commits exactly it, gate first, once", async () => {
  const proposed = await reflect("pm", { hubdir: h, llm: fake });
  assert.equal(proposed.incidents, 1);
  assert.equal(proposed.lessons, 2);
  assert.equal(proposed.applied, null);
  assert.ok(proposed.proposal && fs.existsSync(proposed.proposal));
  const text = fs.readFileSync(proposed.proposal, "utf8");
  assert.ok(text.includes(LESSON) && text.includes("run_ref_a"), "the lesson and its evidence, human-readable");
  assert.ok(text.includes('"origin": "agent"'), "an evaluator signal in the mix means the coarse origin is agent, not human");
  const meta = new EpisodeLog(path.join(h.paths.agents, "pm", "state", "memory.db"));
  assert.equal(meta.getMeta("reflection_watermark"), null, "propose-only consumes nothing: the record waits for a decision");
  meta.close();

  const applied = await reflect("pm", { hubdir: h, llm: fake, apply: true, applyFile: proposed.proposal });
  assert.deepEqual(applied.applied, { added: 1, updated: 0, invalidated: 0, skipped: 1 }, "the real lesson lands; the one parroting the asker's words dies at the gate");
  const facts = new FactStore(path.join(h.paths.agents, "pm", "state", "memory.db"));
  const live = facts.live();
  assert.equal(live.length, 1);
  assert.equal(live[0].text, LESSON);
  assert.equal(live[0].source_origin, "agent");
  assert.ok(facts.retrieve("annual fees premium envelope").some((f) => f.text === LESSON), "retrieved exactly when a fee question arrives");
  facts.close();
  assert.match(fs.readFileSync(proposed.proposal, "utf8"), /applied: .*\+1 added.*1 skipped/, "the commit is an attribution event, stamped in place");

  const twice = await reflect("pm", { hubdir: h, llm: fake, apply: true, applyFile: proposed.proposal });
  assert.match(twice.deferred ?? "", /already applied/, "lessons are spent once, like labels");

  const after = await reflect("pm", { hubdir: h, llm: fake });
  assert.equal(after.incidents, 0, "the applied watermark consumed the record");
  assert.equal(after.watermark, applied.watermark, "and the empty scan stands exactly where the apply left the cursor");
});
