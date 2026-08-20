/**
 * Per-answer forensics (RFA-0.6 sect. 4.4, rung v0.6.4): the retrieval set and the
 * gate verdict, recorded per answer, FORENSICS ONLY and no detector claim.
 *
 * It earned its place the hard way. Diagnosing the 6.3% eval flake meant reading
 * answer PROSE to work out that the agent had opened `offre/plan-a.md` instead of
 * `offre/enveloppes.md`. That took hours and should have been a lookup.
 *
 * The retrieval extractor is exercised through the store's records rather than
 * directly, because what matters is the shape that lands in obs.db.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObsStore } from "../src/obs.js";

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-forensics-"));
  return { dir, obs: new ObsStore(path.join(dir, "obs.db")) };
}

test("a run's retrieval set survives a round trip and keeps its order", () => {
  // The ORDER is the diagnostic: which file it opened FIRST is what told us the
  // agent was going to the decoy before it gave up.
  const { dir, obs } = fresh();
  const now = Date.now();
  const retrieved = [
    "agents/pm-agent/knowledge/handbook/offre/plan-a.md",
    "grep:frais de gestion in agents/pm-agent/knowledge",
    "agents/pm-agent/knowledge/handbook/offre/enveloppes.md",
  ];
  obs.record({
    id: "run_r1", name: "serve:pm-agent", run_type: "agent_span",
    start_time: now - 9000, end_time: now, cost_usd: 0.04,
    outputs: { text: "1 % par an", chars: 10 },
    extra: { retrieved, num_turns: 3 },
  });

  const back = obs.get("run_r1")!;
  const extra = back.extra as { retrieved: string[] };
  assert.deepEqual(extra.retrieved, retrieved, "same set, same order");
  assert.equal(extra.retrieved[0], "agents/pm-agent/knowledge/handbook/offre/plan-a.md", "the decoy is visibly first");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the flake investigation becomes a query", () => {
  // The actual question that took hours: of the answers to this question, which
  // ones never opened the file the fee actually lives in?
  const { dir, obs } = fresh();
  const now = Date.now();
  const FEE_FILE = "agents/pm-agent/knowledge/handbook/offre/enveloppes.md";
  const DECOY = "agents/pm-agent/knowledge/handbook/offre/plan-a.md";
  const runs: [string, string[]][] = [
    ["run_good1", [FEE_FILE]],
    ["run_bad1", [DECOY, "grep:frais in agents/pm-agent/knowledge"]],
    ["run_good2", [DECOY, FEE_FILE]],
    ["run_bad2", [DECOY]],
  ];
  for (const [id, retrieved] of runs) {
    obs.record({
      id, name: "serve:pm-agent", run_type: "agent_span",
      start_time: now - 5000, end_time: now, extra: { retrieved },
    });
  }

  const missedTheFee = runs
    .map(([id]) => obs.get(id)!)
    .filter((r) => !((r.extra as { retrieved: string[] }).retrieved ?? []).includes(FEE_FILE))
    .map((r) => r.id);
  assert.deepEqual(missedTheFee.sort(), ["run_bad1", "run_bad2"], "one filter answers what took hours of reading prose");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the retrieval set records what was LOOKED AT, never what came back", () => {
  // Storing results would put knowledge content into a database with a different
  // retention policy and no business holding it.
  const { dir, obs } = fresh();
  obs.record({
    id: "run_arg", name: "serve:pm-agent", run_type: "agent_span",
    start_time: Date.now() - 1000, end_time: Date.now(),
    extra: { retrieved: ["grep:frais de gestion in agents/pm-agent/knowledge"] },
  });
  const extra = obs.get("run_arg")!.extra as { retrieved: string[] };
  assert.equal(extra.retrieved.length, 1);
  assert.match(extra.retrieved[0], /^grep:/, "the pattern is the record, because two greps are two different events");
  assert.ok(!extra.retrieved[0].includes("1 %"), "no file content, ever");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a gate ALERT is recorded, which is the half that used to be invisible", () => {
  // A refusal was always visible: the call throws and the span records
  // policy_refused. An alert delivered the message normally and left only a system
  // event in the room log, so the interesting half of the gate's opinion was the
  // one nobody could query.
  const { dir, obs } = fresh();
  const now = Date.now();
  obs.record({
    id: "span_alert", name: "rfa.room_send", run_type: "tool",
    start_time: now - 30, end_time: now, group_id: "r_x",
    extra: { "mcp.tool.name": "room_send", gate_verdict: "alert", gate_check: "injection-alert" },
  });
  obs.record({
    id: "span_quiet", name: "rfa.room_send", run_type: "tool",
    start_time: now - 20, end_time: now, group_id: "r_x",
    extra: { "mcp.tool.name": "room_send" },
  });

  const alert = obs.get("span_alert")!.extra as { gate_verdict?: string; gate_check?: string };
  assert.equal(alert.gate_verdict, "alert");
  assert.equal(alert.gate_check, "injection-alert", "which rule fired, not just that one did");

  const quiet = obs.get("span_quiet")!.extra as { gate_verdict?: string };
  assert.equal(quiet.gate_verdict, undefined, "absent when the gate said nothing: the common case costs nothing to read");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
