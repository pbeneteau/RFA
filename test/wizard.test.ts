/**
 * The agent walkthrough's pure parts (step order, the defaults a kind brings),
 * the environment checks against a described machine, the scaffold taking a
 * capability and budgets, and the edit engine behind `rfa agent edit`: one
 * line or block per setting, the rest byte for byte, validated before a write.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parseAgentMd } from "../src/agentdef.js";
import { editPack, yamlScalar } from "../src/cli/agentmd.js";
import { checkEnvironment, environmentBlocks, type Probe } from "../src/cli/environment.js";
import { builtinTool, renderAgentMd } from "../src/cli/scaffold.js";
import { changesOf, draftFor } from "../src/cli/tui/agentedit.js";
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

  // The missing model credential is a real ✖ and NOT a provisioning blocker:
  // headless init has always proceeded past it, and the onboarding once
  // dead-ended here with only "check again" and "quit" to press.
  const credless = checkEnvironment(machine({ which: (cmd) => (cmd === "git" ? `/usr/bin/${cmd}` : null) }));
  assert.equal(byId(credless).claude.verdict, "fail", "said as a ✖, honestly");
  assert.equal(environmentBlocks(credless), false, "and still not a blocker: the screen must offer continue");
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

test("editPack rewrites one line or block per setting, keeps the rest byte for byte, and validates before it writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-edit-"));
  const file = path.join(dir, "agent.md");
  fs.writeFileSync(file, renderAgentMd({ name: "pm", kind: "answerer", room: "r_aaaa111111" }));
  const before = fs.readFileSync(file, "utf8");
  const r = editPack(file, {
    description: "Answers fee questions: plans, fees, who to ask.",
    model: "sonnet",
    offer: { id: "answer-fee-question", description: "Answers fee questions from the handbook, citing the page." },
    budgets: { per_day_usd: 10 },
    room: "r_bbbb222222",
    knowledge: ["../handbook/**/*.md"],
  });
  assert.deepEqual(r.changed, ["description", "model", "capability", "budgets", "room", "knowledge"]);
  assert.notEqual(r.before, r.after);
  const after = fs.readFileSync(file, "utf8");
  const def = parseAgentMd(after).def;
  assert.equal(def.model, "sonnet");
  assert.equal(def.description, "Answers fee questions: plans, fees, who to ask.");
  assert.ok(after.includes('description: "Answers fee questions: plans, fees, who to ask."'), "a colon in the sentence is quoted so the YAML stays valid");
  assert.deepEqual(def.offers?.map((o) => o.id), ["answer-fee-question"]);
  assert.deepEqual(def.budgets, { max_turns: 8, per_task_usd: 0.25, per_day_usd: 10 }, "the ceilings not named survive the block rewrite");
  assert.equal(def.rooms?.[0].room, "r_bbbb222222");
  assert.equal(def.rooms?.[0].presence_ttl_s, 180, "the binding's other fields are kept");
  assert.deepEqual(def.knowledge, ["knowledge/**/*.md", "../handbook/**/*.md"], "knowledge is added to, never replaced");
  assert.equal(after.split("\n---\n")[1], before.split("\n---\n")[1], "the prompt body is untouched");
  for (const line of ["  allow: [Read, Grep, Glob]   # reading knowledge; no side effects. Add mcp__rfa__ask for a voice", "  gate: memory-gate   # peer content cannot become memory unexamined", "secrets: [RFA_TOKEN]", "# RFA_TOKEN: the bearer that reaches the hub; residents join their room with it."]) {
    assert.ok(after.includes(line), `kept byte for byte: ${line}`);
  }
  assert.ok(after.includes("  # What this agent advertises in the room."), "the scaffold's reason for a block survives the block's rewrite");

  const again = editPack(file, { model: "sonnet", budgets: { per_day_usd: 10 }, description: "Answers fee questions: plans, fees, who to ask." });
  assert.deepEqual(again.changed, [], "the same values again are a no-op");
  assert.equal(again.before, again.after);

  const snapshot = fs.readFileSync(file, "utf8");
  assert.throws(() => editPack(file, { mode: "plan" }), /no acting tool/, "an answerer has nothing a mode would change");
  assert.throws(() => editPack(file, { budgets: { max_turns: 0 } }), /agent\.md definition invalid/, "the schema refuses it before anything is written");
  assert.equal(fs.readFileSync(file, "utf8"), snapshot, "a refused edit leaves the file as it was");

  const toolFile = path.join(dir, "tool.md");
  fs.writeFileSync(toolFile, renderAgentMd({ name: "scribe", kind: "tool", room: null, tool: builtinTool("linear") }));
  assert.deepEqual(editPack(toolFile, { mode: "plan" }).changed, ["mode"]);
  assert.equal(parseAgentMd(fs.readFileSync(toolFile, "utf8")).def.mode, "plan");
  assert.deepEqual(editPack(toolFile, { room: "r_cccc333333" }).changed, ["room"], "a pack with no binding gets one where the placeholder was");
  assert.equal(parseAgentMd(fs.readFileSync(toolFile, "utf8")).def.rooms?.[0].room, "r_cccc333333");

  assert.equal(yamlScalar("Plain words, a sentence."), "Plain words, a sentence.");
  assert.equal(yamlScalar("a: b"), '"a: b"');
  assert.equal(yamlScalar("yes"), '"yes"', "a YAML boolean word is quoted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the edit walkthrough's draft mirrors the pack, and its diff is the changes editPack takes plus the rows the review shows", () => {
  const text = renderAgentMd({ name: "pm", kind: "answerer", room: "r_aaaa111111" });
  const parsed = parseAgentMd(text);
  const pack = { name: "pm", dir: "/nowhere", def: parsed.def, prompt: parsed.prompt, definitionHash: parsed.definitionHash };
  const rooms = [{ alias: "product", handle: "r_aaaa111111" }, { alias: "design", handle: "r_bbbb222222" }];
  const base = draftFor(pack, rooms);
  assert.equal(base.model, "haiku");
  assert.equal(base.mode, null, "an answerer has no acting tool: no mode to edit");
  assert.deepEqual(base.room, { handle: "r_aaaa111111", alias: "product" });
  assert.deepEqual(base.budgets, { per_task_usd: 0.25, per_day_usd: 5, max_turns: 8 });
  assert.deepEqual(changesOf(base, base).rows, [], "an untouched draft changes nothing");

  const d = { ...base, model: "sonnet", budgets: { ...base.budgets, per_day_usd: 10 }, room: { handle: "r_bbbb222222", alias: "design" }, knowledge: { type: "git" as const, value: "git@host:org/handbook.git", docs: "docs" } };
  const diff = changesOf(base, d);
  assert.deepEqual(diff.changes, { model: "sonnet", budgets: { per_task_usd: 0.25, per_day_usd: 10, max_turns: 8 }, room: "r_bbbb222222" });
  assert.deepEqual(diff.rows.map((r) => r[0]), ["model", "budgets", "room", "knowledge"]);
  assert.equal(diff.rows[0][1], "haiku → sonnet");
  assert.deepEqual(diff.knowledge, { source: "git@host:org/handbook.git", docs: "docs" }, "a clone is made at apply time, then its globs are added");
  assert.equal(diff.newRoom, null);
  const created = changesOf(base, { ...base, room: { create: { alias: "ops2", topic: "t" } } });
  assert.deepEqual(created.newRoom, { alias: "ops2", topic: "t" });
  assert.equal(created.changes.room, undefined, "a room to create is made first, then bound by its handle");
  assert.equal(created.rows[0][1], "product → a new room, ops2");
});
