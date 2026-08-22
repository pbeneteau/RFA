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
  assert.equal(nextScreen("welcome", base, false), "mode");
  assert.equal(nextScreen("name", base, false), "port", "a local hub asks for a port");
  assert.equal(nextScreen("name", { ...base, mode: "remote" }, false), "remote", "a remote one asks for the URL and the bearer");
  assert.equal(nextScreen("agent", { ...base, agentKind: "none" }, false), "start", "no agent: no name, no knowledge, no room");
  assert.equal(nextScreen("agentName", { ...base, agentKind: "answerer" }, false), "knowledge", "an answerer is asked what it reads");
  assert.equal(nextScreen("agentName", base, false), "room", "a spec-expert is not");
  assert.equal(nextScreen("agentName", { ...base, agentKind: "tool" }, false), "toolServer", "a tool user names the server it acts through");
  assert.equal(nextScreen("toolServer", { ...base, agentKind: "tool" }, false), "room");
  assert.equal(nextScreen("welcome", base, true), "human", "an existing directory skips mode, name and port");
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

function tick(ms = 60): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
