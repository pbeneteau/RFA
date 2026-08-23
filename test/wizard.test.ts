/**
 * The agent walkthrough's pure parts (step order, the defaults a kind brings),
 * the environment checks against a described machine, and the scaffold taking
 * a capability and budgets.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseAgentMd } from "../src/agentdef.js";
import { checkEnvironment, environmentBlocks, type Probe } from "../src/cli/environment.js";
import { renderAgentMd } from "../src/cli/scaffold.js";
import { applicableStep, defaultDraft, forKind, nextStep } from "../src/cli/tui/agentwizard.js";

test("the walkthrough asks what the kind needs: knowledge for an answerer, server and mode for a tool user, neither for a spec-expert", () => {
  const answerer = forKind({ ...defaultDraft(), name: "pm" }, "answerer");
  assert.equal(nextStep("kind", answerer), "knowledge");
  assert.equal(nextStep("knowledge", answerer), "model", "no server, no mode");
  assert.equal(answerer.offer.id, "answer-question");
  assert.equal(answerer.model, "haiku");
  const tool = forKind({ ...defaultDraft(), name: "scribe" }, "tool");
  assert.equal(nextStep("kind", tool), "server");
  assert.equal(nextStep("server", tool), "mode");
  assert.equal(nextStep("mode", tool), "model");
  assert.equal(tool.offer.id, "scribe-action");
  assert.equal(tool.model, "sonnet", "a tool user composes and acts");
  assert.deepEqual(tool.budgets, { per_task_usd: 1, per_day_usd: 5, max_turns: 20 });
  const spec = forKind({ ...defaultDraft(), name: "spec" }, "spec-expert");
  assert.equal(nextStep("kind", spec), "model");
  assert.ok(!applicableStep("knowledge", spec) && !applicableStep("server", spec));
  assert.equal(nextStep("model", tool, -1), "mode", "back walks the same path");
  assert.equal(nextStep("room", answerer), "review");
  assert.equal(nextStep("review", answerer), "create");
});

test("the environment checks read a described machine: what blocks, what warns, what is merely noted", () => {
  const machine = (over: Partial<Probe>): Probe => ({
    env: {},
    platform: "darwin",
    nodeVersion: "v24.1.0",
    home: "/home/x",
    cwd: "/work",
    which: (cmd) => (["git", "claude", "launchctl"].includes(cmd) ? `/usr/bin/${cmd}` : null),
    exists: () => false,
    version: (cmd) => (cmd === "git" ? "git version 2.45.0" : cmd === "claude" ? "1.0.99 (Claude Code)" : null),
    writable: () => true,
    ...over,
  });
  const good = checkEnvironment(machine({ env: { ANTHROPIC_API_KEY: "sk-ant-x" } }));
  const byId = (checks: ReturnType<typeof checkEnvironment>) => Object.fromEntries(checks.map((c) => [c.id, c]));
  const g = byId(good);
  assert.equal(g.node.verdict, "ok");
  assert.equal(g.git.verdict, "ok");
  assert.equal(g.claude.verdict, "ok", "an API key is a credential");
  assert.equal(g.codex.verdict, "skip", "not installed is noted, not warned: rfa does not use it");
  assert.equal(g.service.verdict, "ok");
  assert.ok(!environmentBlocks(good));

  const bare = byId(checkEnvironment(machine({ which: () => null, nodeVersion: "v20.11.0" })));
  assert.equal(bare.node.verdict, "fail", "Node 20 is below the floor");
  assert.equal(bare.git.verdict, "warn", "git is optional until a knowledge clone is wanted");
  assert.equal(bare.claude.verdict, "fail", "no CLI and no key: agents would refuse every answer");
  assert.match(bare.claude.fix ?? "", /npm install -g @anthropic-ai\/claude-code/);
  assert.equal(bare.service.verdict, "skip");

  const seen = byId(checkEnvironment(machine({ which: (cmd) => (["codex", "gemini", "tailscale", "claude"].includes(cmd) ? `/bin/${cmd}` : null), exists: (f) => f.endsWith(".codex/auth.json"), env: { ANTHROPIC_API_KEY: "k" } })));
  assert.match(seen.codex.text, /installed, logged in; not used by rfa today/);
  assert.match(seen.gemini.text, /installed, not logged in; not used by rfa today/);
  assert.equal(seen.tailscale.verdict, "ok");
  const readonly = byId(checkEnvironment(machine({ writable: () => false, env: { ANTHROPIC_API_KEY: "k" } })));
  assert.equal(readonly.cwd.verdict, "fail");
});

test("the scaffold takes the capability and the budgets the walkthrough chose", () => {
  const text = renderAgentMd({ name: "pm", kind: "answerer", room: null, offer: { id: "answer-product-question", description: "Answers product questions from the handbook." }, budgets: { per_task_usd: 0.5, per_day_usd: 10, max_turns: 12 } });
  const def = parseAgentMd(text).def;
  assert.deepEqual(def.offers?.map((o) => o.id), ["answer-product-question"]);
  assert.equal(def.offers?.[0].description, "Answers product questions from the handbook.");
  assert.equal(def.budgets?.max_turns, 12);
  assert.equal(def.budgets?.per_task_usd, 0.5);
  assert.equal(def.budgets?.per_day_usd, 10);
  const plain = parseAgentMd(renderAgentMd({ name: "pm", kind: "answerer", room: null })).def;
  assert.equal(plain.budgets?.per_task_usd, 0.25, "the defaults are unchanged when nothing is chosen");
});
