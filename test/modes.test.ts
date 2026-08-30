/**
 * Agent modes (RFA-0.4 sect. 3.1 amendment): the pure mapping from a pack's
 * mode to what the resident hands the SDK, the one line in agent.md the CLI
 * owns for it, and the scaffold writing it for a tool user only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseAgentMd } from "../src/agentdef.js";
import { agentPosture, effectiveMode } from "../src/posture.js";
import { setAgentMode, setTopScalar } from "../src/cli/agentmd.js";
import { renderAgentMd } from "../src/cli/scaffold.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const toolPack = (mode?: string) => parseAgentMd([
  "---",
  "rfa_agent: 1",
  "name: scribe",
  "description: d",
  ...(mode ? [`mode: ${mode}`] : []),
  "tools:",
  "  allow: [Read, Grep, mcp__linear__search_project, mcp__linear__save_document]",
  "  allow_subagents: false",
  // RFA-0.9 sect. 3.2: an `mcp__` name for a server the pack does not declare is
  // refused now, so the fixture declares the server it names.
  "mcp_servers:",
  "  linear:",
  "    builtin: linear",
  // RFA-0.9 sect. 5.4: a server this platform spawns declares its own sandbox.
  "    sandbox:",
  "      network: allowlist",
  "      allowed_domains: [api.linear.app]",
  "interrupt_on:",
  '  "mcp__linear__save_document":',
  "    allowed_decisions: [approve, edit, reject]",
  "offers:",
  "  - id: scribe-action",
  "    description: acts",
  "---",
  "prompt",
].join("\n")).def;

test("ask is the default for a tool user; read-only for a pack with nothing to gate", () => {
  const ask = agentPosture(toolPack());
  assert.equal(ask.mode, "ask");
  assert.equal(ask.permissionMode, "default");
  assert.deepEqual(ask.acting, ["mcp__linear__save_document"], "the acting tools are what interrupt_on names, among what the pack may call");
  assert.deepEqual(ask.allowedTools, ["Read", "Grep", "mcp__linear__search_project"], "the acting tool is kept OUT of the SDK allow list so it reaches canUseTool");
  assert.equal(ask.onActing, "card");
  const reader = parseAgentMd("---\nrfa_agent: 1\nname: pm\ndescription: d\ntools:\n  allow: [Read, Grep]\n  allow_subagents: false\noffers:\n  - id: answer\n    description: a\n---\nprompt\n").def;
  assert.equal(effectiveMode(reader), "read-only");
  assert.deepEqual(agentPosture(reader).allowedTools, ["Read", "Grep"]);
});

test("plan proposes and never acts; bypass allows the acting tool outright; auto is no longer a mode", () => {
  const plan = agentPosture(toolPack("plan"));
  assert.equal(plan.permissionMode, "default", "our plan mode is not the SDK's: that one wants a plan file and ExitPlanMode, which a room has no use for");
  assert.equal(plan.onActing, "refuse-plan");
  assert.ok(!plan.allowedTools.includes("mcp__linear__save_document"), "the acting tool is still not pre-allowed in plan mode");
  assert.throws(() => toolPack("auto"), /mode/, "auto was withdrawn: the SDK's classifier approved a gated call with no card");
  const bypass = agentPosture(toolPack("bypass"));
  assert.notEqual(bypass.permissionMode, "bypassPermissions", "the SDK's bypassPermissions auto-approves EVERY reachable tool before canUseTool: a bypass resident used the operator's claude.ai Linear connector through it (found live 2026-08-24)");
  assert.equal(bypass.permissionMode, "default");
  assert.equal(bypass.onActing, "allow");
  assert.ok(!bypass.allowedTools.includes("mcp__linear__save_document"), "the acting tool routes through canUseTool even in bypass, where onActing allow answers without a card and every UNDECLARED tool still dies at the deny-by-default door");
  assert.throws(() => toolPack("yolo"), /mode/, "an unknown mode is refused by the schema");
});

test("the SDK's base tool set is what the pack declared: harness-internal tools are ABSENT, not merely denied", () => {
  // canUseTool is never consulted for harness-internal tools, so the
  // deny-by-default callback is not a fence for them. Found live 2026-08-24
  // under bypass: a resident ran ToolSearch, listed the operator's other Claude
  // Code sessions with ListAgents and messaged one with SendMessage - none
  // declared by the pack, none ever reaching the callback.
  for (const mode of ["ask", "plan", "bypass"] as const) {
    const p = agentPosture(toolPack(mode));
    assert.deepEqual(p.builtins, ["Read", "Grep"], `${mode}: exactly the built-ins the pack declared, MCP names filtered out`);
    for (const internal of ["ToolSearch", "ListAgents", "SendMessage", "Task", "Bash", "WebFetch"]) {
      assert.ok(!p.builtins.includes(internal), `${mode}: ${internal} is not in the base set, so the model never sees it`);
    }
    assert.ok(!p.builtins.some((t) => t.startsWith("mcp__")), "MCP tools are not built-ins: they ride mcpServers and the allow list");
  }
  const bare = agentPosture({ rfa_agent: 1, name: "x", description: "d" } as never);
  assert.deepEqual(bare.builtins, [], "a pack that declares no tools gets NO built-ins: the SDK's default preset is never inherited by accident");
});

test("the mode line is replaced in place or inserted before sandbox:, and the rest of agent.md is kept byte for byte", () => {
  const text = "---\nrfa_agent: 1\nname: x\ndescription: d   # keep me\nsandbox:\n  isolation: none\n---\nbody\n";
  const added = setTopScalar(text, "mode", "mode: plan");
  assert.equal(added, "---\nrfa_agent: 1\nname: x\ndescription: d   # keep me\nmode: plan\nsandbox:\n  isolation: none\n---\nbody\n");
  const replaced = setTopScalar(added, "mode", "mode: auto   # note");
  assert.ok(replaced.includes("\nmode: auto   # note\nsandbox:") && !replaced.includes("mode: plan"));
  const noSandbox = setTopScalar("---\nrfa_agent: 1\nname: x\n---\nbody\n", "mode", "mode: ask");
  assert.equal(noSandbox, "---\nrfa_agent: 1\nname: x\nmode: ask\n---\nbody\n", "without a sandbox block the line goes last");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-mode-"));
  const file = path.join(dir, "agent.md");
  fs.writeFileSync(file, [
    "---", "rfa_agent: 1", "name: scribe", "description: d", "tools:", "  allow: [Read, mcp__l__save]", "  allow_subagents: false",
    "mcp_servers:", "  l:", "    command: /bin/true", "    sandbox:", "      network: none",
    "interrupt_on:", '  "mcp__l__save": true', "offers:", "  - id: act", "    description: a", "---", "prompt", "",
  ].join("\n"));
  const r = setAgentMode(file, "bypass");
  assert.notEqual(r.before, r.after, "a mode change rotates the definition, so the supervisor drains and respawns");
  assert.equal(parseAgentMd(fs.readFileSync(file, "utf8")).def.mode, "bypass");
  const same = setAgentMode(file, "bypass");
  assert.equal(same.before, same.after, "setting the mode it already has changes nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the scaffold writes a mode line for a tool user only, ask unless told otherwise", () => {
  const tool = renderAgentMd({ name: "t", kind: "tool", room: null, tool: { server: "linear", builtin: "linear", tool: "save_document", envSecrets: ["LINEAR_API_KEY"] } });
  assert.match(tool, /^mode: ask /m);
  assert.equal(parseAgentMd(tool).def.mode, "ask");
  const planned = renderAgentMd({ name: "t", kind: "tool", room: null, mode: "plan", tool: { server: "linear", builtin: "linear", tool: "save_document" } });
  assert.equal(parseAgentMd(planned).def.mode, "plan");
  const answerer = renderAgentMd({ name: "a", kind: "answerer", room: null });
  assert.ok(!/^mode:/m.test(answerer), "an answerer has nothing a mode would change");
});

test("a specifier-scoped acting tool is still ACTING: Bash(gh:*) under interrupt_on Bash cards, never auto-approves", () => {
  // Found live 2026-08-30 on the first fenced pack a real org built: the
  // interrupt key `Bash` did not claim the allow entry `Bash(gh:*)`, so
  // actingTools was empty, the posture read-only, and the entry sat BARE in
  // allowedTools - six gh/curl commands ran with zero approval cards. Same
  // defect class as the guarded-builtin exact-match (audit rank 1), one
  // predicate over.
  const def = parseAgentMd(
    [
      "---",
      "rfa_agent: 1",
      "name: gher",
      "description: d",
      "tools:",
      "  allow: ['Read', 'Bash(gh:*)']",
      "  allow_subagents: false",
      "interrupt_on:",
      "  Bash: true",
      "---",
      "prompt",
    ].join("\n"),
  ).def;
  const p = agentPosture(def);
  assert.equal(p.mode, "ask", "an interruptible tool means the pack ACTS");
  assert.deepEqual(p.acting, ["Bash(gh:*)"]);
  assert.deepEqual(p.allowedTools, ["Read"], "the specifier entry must NOT sit bare in allowedTools");
  assert.equal(p.onActing, "card");
});
