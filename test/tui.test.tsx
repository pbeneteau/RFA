/**
 * The front door's pure parts and its components rendered headless
 * (ink-testing-library): the wordmark, the palette's search and argument form,
 * the onboarding's screen order, completion candidates, did-you-mean.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Router, type CommandDef } from "../src/cli/router.js";
import { complete } from "../src/cli/commands/completion.js";
import { suggestCommands } from "../src/cli/suggest.js";
import { describeVerdict, EvalsTab, evidenceWord, fmtDeadline, sittingSummary, TasksTab, verdictMark, type Verdict } from "../src/cli/tui/dashboard.js";
import type { RfaTask } from "../src/model.js";
import type { GateView } from "../src/cli/tui/data.js";
import type { Trace } from "../src/evals/label.js";
import { Wordmark } from "../src/cli/tui/logo.js";
import { Palette, paletteItems, requiredArgs, searchPalette } from "../src/cli/tui/palette.js";
import { applicable, nextScreen } from "../src/cli/tui/onboarding.js";
import { gradientAt, sparkline, WORDMARK } from "../src/cli/tui/theme.js";
import type { InitAnswers } from "../src/cli/commands/init.js";

const noop = async () => {};
const defs: CommandDef[] = [
  { path: ["init"], summary: "Create a hub directory here", run: noop },
  { path: ["status"], summary: "What is running", run: noop },
  { path: ["ask"], summary: "Ask an agent by capability", usage: '"<question>" [--room <alias|handle>]', run: noop },
  { path: ["agent", "new"], summary: "Scaffold a pack", usage: "<name> [--kind answerer|tool|spec-expert]", options: { kind: { type: "string" } }, run: noop },
  { path: ["agent", "restart"], summary: "Restart a resident through the supervisor", usage: "<name>", run: noop },
  { path: ["agent", "retire"], summary: "Stop, leave, evict, archive, deregister", usage: "<name>", run: noop },
  { path: ["room", "show"], summary: "A room's roster", usage: "<alias|handle>", run: noop },
  { path: ["room", "inject"], summary: "Speak as the supervisor", usage: '<alias|handle> "<text>" [--to <member>]', run: noop },
  { path: ["__complete"], summary: "hidden", hidden: true, run: noop },
];
const strip = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

test("the wordmark renders every row of the mark through the gradient, and the gradient is monotone", () => {
  const { lastFrame } = render(<Wordmark version="0.7.0" />);
  const frame = strip(lastFrame());
  for (const row of WORDMARK) assert.ok(frame.includes(row.trimEnd()), `row missing: ${row}`);
  assert.ok(frame.includes("Rooms for Agents") && frame.includes("0.7.0"));
  assert.equal(gradientAt(0), "#7df9ff");
  assert.equal(gradientAt(1), "#ff7dd4");
  assert.notEqual(gradientAt(0.5), gradientAt(0.51), "a gradient, not a step");
  assert.equal(sparkline([0, 1, 2, 4, 8]).length, 5);
  assert.equal(sparkline([0, 0, 0]), "▁▁▁", "all-zero stays on the floor rather than dividing by zero");
});

test("the palette searches by path and summary, lists the required arguments, and hides hidden commands", () => {
  const items = paletteItems(defs);
  assert.ok(!items.some((i) => i.id === "__complete"), "hidden commands never show");
  assert.deepEqual(requiredArgs('<alias|handle> "<text>" [--to <member>]'), ["alias|handle", "text"]);
  assert.deepEqual(requiredArgs("[--judged] [--room <alias>]"), [], "an optional first token means nothing is required");
  assert.equal(searchPalette(items, "agnt rest")[0]?.id, "agent restart", "fuzzy on the path");
  assert.equal(searchPalette(items, "capability")[0]?.id, "ask", "fuzzy on the summary");
  assert.equal(searchPalette(items, "").length, Math.min(12, items.length), "no query lists everything, capped");
});

test("the palette runs a command with no required argument on enter, and asks for arguments in place otherwise", async () => {
  const ran: string[][] = [];
  const items = paletteItems(defs);
  const { stdin, lastFrame } = render(<Palette items={items} onRun={(argv) => ran.push(argv)} onClose={() => ran.push(["closed"])} />);
  await tick();
  stdin.write("status");
  await tick();
  assert.ok(strip(lastFrame()).includes("runs: rfa status"), "the footer shows the command line before it runs");
  stdin.write("\r");
  await tick();
  assert.deepEqual(ran, [["status"]]);

  const second = render(<Palette items={items} initialQuery="agent restart" onRun={(argv) => ran.push(argv)} onClose={() => ran.push(["closed"])} />);
  await tick();
  assert.ok(strip(second.lastFrame()).includes("<name>"), "the footer names what the command still needs");
  second.stdin.write("\r");
  await tick();
  assert.ok(strip(second.lastFrame()).includes("name:"), "enter on a command with a required argument opens its field");
  second.stdin.write("pm-agent");
  await tick();
  second.stdin.write("\r");
  await tick();
  assert.deepEqual(ran.at(-1), ["agent", "restart", "pm-agent"]);
});

test("the onboarding asks only the questions that apply, in order, and steps back over the ones it skipped", () => {
  const base: InitAnswers = { mode: "hub", name: "x", port: 8790, human: "paul", agentKind: "spec-expert", agentName: "spec-expert", room: "main", topic: "t", start: true };
  assert.equal(nextScreen("welcome", base, false), "checks", "the machine is checked before any question");
  assert.equal(nextScreen("checks", base, false), "mode");
  assert.equal(nextScreen("name", base, false), "port", "a local hub asks for a port");
  assert.equal(nextScreen("name", { ...base, mode: "remote" }, false), "remote", "a remote one asks for the URL and the bearer");
  assert.equal(nextScreen("agent", { ...base, agentKind: "none" }, false), "start", "no agent: no name, no knowledge, no room");
  assert.equal(nextScreen("agentName", { ...base, agentKind: "answerer" }, false), "knowledge", "an answerer is asked what it reads");
  assert.equal(nextScreen("agentName", base, false), "room", "a spec-expert is not");
  assert.equal(nextScreen("agentName", { ...base, agentKind: "tool" }, false), "toolServer", "a tool user names the server it acts through");
  assert.equal(nextScreen("toolServer", { ...base, agentKind: "tool" }, false), "room");
  assert.equal(nextScreen("checks", base, true), "human", "an existing directory skips mode, name and port");
  assert.equal(nextScreen("room", base, false, -1), "agentName", "back skips the same screens");
  assert.ok(!applicable("knowledge", base, false) && applicable("knowledge", { ...base, agentKind: "answerer" }, false));
});

test("completion offers groups, then commands, then what the directory holds; options when a dash is typed", () => {
  const r = new Router();
  r.register(...defs);
  const dyn = { packs: ["pm-agent", "scribe"], rooms: ["product", "ops"], tokens: ["operator", "laptop"] };
  assert.ok(complete(r, [""], dyn).some((c) => c.value === "agent"), "top level: the groups");
  assert.deepEqual(complete(r, ["agent", ""], dyn).map((c) => c.value), ["new", "restart", "retire"]);
  assert.deepEqual(complete(r, ["agent", "restart", ""], dyn).map((c) => c.value), ["pm-agent", "scribe"], "a pack name from the directory");
  assert.deepEqual(complete(r, ["room", "show", ""], dyn).map((c) => c.value), ["product", "ops"]);
  assert.deepEqual(complete(r, ["ask", "--room", ""], dyn).map((c) => c.value), ["product", "ops"], "the value of --room is a room");
  const opts = complete(r, ["agent", "new", "x", "--"], dyn).map((c) => c.value);
  assert.ok(opts.includes("--kind") && opts.includes("--json") && !opts.includes("--help"), "own flags plus the global ones");
  assert.deepEqual(complete(r, ["agent", "restart", ""], {}), [], "with no hub directory there is nothing to offer, not a crash");
});

test("did you mean: a typo, a wrong order and a hyphenated guess all land on the command", () => {
  assert.equal(suggestCommands(["agnet", "restrt"], defs)[0], "agent restart");
  assert.equal(suggestCommands(["restart-agent"], defs)[0], "agent restart");
  assert.deepEqual(suggestCommands(["zzzzzz"], defs), [], "nothing close means no suggestion");
});

const trace: Trace = {
  run_id: "run_fee000001", agent: "pm-agent", when: new Date().toISOString(), flagged_because: "parity = 0: missing 1 %",
  question: "what are the annual fees?", answer: "The fee is not documented.\nSee knowledge/offre/plans.md.", cited: ["knowledge/offre/plans.md"],
  room: "r_room", conversation: "c_conv", label: null, gold_source: null, failure_mode: null, promote: false,
};
const gate: GateView = {
  cases: [{ id: "pm-fee-wrong-file", kind: "replay", subject: "answer-question", where: "evals/cases/pm-fee-wrong-file", failure_mode: "retrieval-wrong-file", baseline: 1, last: { score: 0.75, passk: 0.5, trials: [true, true, true, false], refused: 0, blocked: null, note: "" } }],
  gate: { k: 4, band: 0.15 },
  lastRun: { ts: "2026-08-23T09-17-16", at: 0, judged: false },
  corpusVersion: null,
};

test("the Evals tab shows the queue with each verdict, the selected trace, and the gate; empty and unread states say why", () => {
  const verdict: Verdict = { label: "fail", gold_source: "offre/plans.md#PlanA", failure_mode: "retrieval-wrong-file", promote: true };
  // ink-testing-library paints 100 columns wide; told 80, the tab stacks its panels and each gets the full width.
  const ran = { ...gate, lastRun: { ...gate.lastRun!, at: Date.now() - 89_800 } }; // "1m 30s ago" for the half-second the render takes
  const { lastFrame } = render(<EvalsTab queue={{ traces: [trace], alreadyLabelled: 2, total: 1, loaded: true, error: null }} verdicts={{ [trace.run_id]: verdict }} selected={0} gate={ran} aliasOf={(h) => (h === "r_room" ? "product" : (h ?? "-"))} columns={80} height={34} />);
  const frame = strip(lastFrame());
  assert.ok(frame.includes("review queue (1)") && frame.includes("1 to label · 2 labelled"), "the two numbers of the sitting");
  assert.ok(frame.includes("✖ g c"), "the verdict column: fail, a gold source, a case to cut");
  assert.ok(frame.includes("fail: retrieval-wrong-file · gold source offre/plans.md#PlanA · cut into a case"), "the selected trace's verdict in words");
  assert.ok(frame.includes("parity = 0: missing 1 %") && frame.includes("product"), "why it was flagged, and the room by its alias");
  assert.ok(frame.includes("1 judged · enter applies the sitting"));
  assert.ok(frame.includes("pm-fee-wrong-file") && frame.includes("✔✔✔✖") && frame.includes("last run 1m 30s ago"), "the gate: the case, its last trials, when");

  const empty = strip(render(<EvalsTab queue={{ traces: [], alreadyLabelled: 3, total: 0, loaded: true, error: null }} verdicts={{}} selected={0} gate={{ ...gate, cases: [], lastRun: null }} aliasOf={(h) => h ?? "-"} columns={80} height={34} />).lastFrame());
  assert.ok(empty.includes("nothing to label: the review queue is empty") && empty.includes("3 already carry a human label"));
  assert.ok(empty.includes("no cases yet") && empty.includes("no run yet"));
  const unread = strip(render(<EvalsTab queue={{ traces: [], alreadyLabelled: 0, total: 0, loaded: true, error: "no observability store yet: residents write .rfa/data/obs.db on their first answer" }} verdicts={{}} selected={0} gate={null} aliasOf={(h) => h ?? "-"} columns={80} height={30} />).lastFrame());
  assert.ok(unread.includes("no observability store yet"), "a missing store is said, at 80 columns too");
});

test("the sitting's pure parts: the verdict mark, its words, and the confirm text that says what will be written", () => {
  assert.equal(verdictMark(undefined), "·");
  assert.equal(verdictMark({ label: "pass", gold_source: null, failure_mode: null, promote: false }), "✔");
  assert.equal(verdictMark({ label: "fail", gold_source: "x", failure_mode: null, promote: true }), "✖ g c");
  assert.equal(describeVerdict(undefined), "none yet: p pass · f fail");
  assert.equal(describeVerdict({ label: "fail", gold_source: null, failure_mode: null, promote: false }), "fail (no failure mode named)");
  assert.equal(sittingSummary([trace], {}), null, "nothing judged, nothing to apply");
  const second: Trace = { ...trace, run_id: "run_fee000002" };
  const s = sittingSummary([trace, second], { [trace.run_id]: { label: "pass", gold_source: "a#b", failure_mode: null, promote: false } });
  assert.deepEqual({ labels: s?.labels, passes: s?.passes, fails: s?.fails, golds: s?.golds, cuts: s?.cuts }, { labels: 1, passes: 1, fails: 0, golds: 1, cuts: 0 });
  assert.match(s?.text ?? "", /1 label \(1 pass, 0 fail\), 1 gold source, 0 cases to cut/);
  assert.match(s?.text ?? "", /no rubric hash: a person judged these/);
  assert.match(s?.text ?? "", /1 unjudged trace is left for a later sitting/);
});

const taskOf = (over: Partial<RfaTask>): RfaTask => ({
  id: "t_1", room: "r_room", title: "draft the release note", description: null, state: "working", created_by: "m_paul", owner: "m_pm", parent_id: null, conversation_id: null,
  blocks: [], blocked_by: [], reply_by: null, evidence_required: true, evidence: null, verification: { pending: false, verifier: null, verdict: null, note: null },
  note: null, created_at: "2026-08-23T10:00:00.000Z", updated_at: "2026-08-23T10:05:00.000Z", ...over,
});

test("the Tasks tab lists the board with owners by name and the evidence each task waits on, and says what an empty board is", () => {
  const members = [{ id: "m_pm", name: "pm-agent", origin: "agent", state: "ready" }, { id: "m_paul", name: "paul", origin: "human", state: "ready" }];
  const pending = taskOf({ id: "t_2", title: "collect the fee table", state: "working", evidence: { summary: "table attached", artifacts: ["fees.csv"] }, verification: { pending: true, verifier: null, verdict: null, note: null }, reply_by: new Date(Date.now() + 30 * 60_000).toISOString() });
  const tasks = [taskOf({}), pending];
  const room = { alias: "product", handle: "r_room", topic: "t", join_secret: "js", operator: { member_id: "m_paul", membership_token: "mt", name: "paul", role: "participant" as const, host: true }, created_at: "" };
  const { lastFrame } = render(<TasksTab state={{ board: { tasks, members }, loaded: true, error: null, at: 1 }} tasks={tasks} selected={1} room={room as never} allStates={false} hubUp columns={94} />); // 94: told less, the table shrinks its evidence column under "to verify"
  const frame = strip(lastFrame());
  assert.ok(frame.includes("tasks · product") && frame.includes("2 open"), "the room and its open count");
  assert.ok(frame.includes("pm-agent") && !frame.includes("m_pm "), "owners by name, not by member id");
  assert.ok(frame.includes("to verify") && frame.includes("required"), "what each task's evidence waits on");
  assert.ok(frame.includes("in 29m") || frame.includes("in 30m"), "the deadline as a countdown");
  assert.ok(frame.includes("collect the fee table") && frame.includes("table attached") && frame.includes("fees.csv"), "the selected task in full, evidence included");
  assert.ok(frame.includes("waiting for a verdict: y accept · r reject"));
  const empty = strip(render(<TasksTab state={{ board: { tasks: [], members }, loaded: true, error: null, at: 1 }} tasks={[]} selected={0} room={room as never} allStates={false} hubUp={false} columns={80} />).lastFrame());
  assert.ok(empty.includes("no tasks in product yet") && empty.includes("hub down: read once, R rereads"));
  assert.equal(evidenceWord(taskOf({ evidence_required: false })), "-");
  assert.equal(evidenceWord(taskOf({ verification: { pending: false, verifier: "m_paul", verdict: "reject", note: null, rejections: 2 } })), "sent back ×2");
  assert.equal(fmtDeadline(null), "-");
  assert.match(fmtDeadline(new Date(Date.now() - 120_000).toISOString()), /^2m \d+s late$/);
});

function tick(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
