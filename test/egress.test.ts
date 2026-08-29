/**
 * RFA-0.9 (egress and the declared surface), rung by rung.
 *
 * The deterministic half only. The live half - a real sandbox, a real model, a
 * real host reached or refused - is `npm run egress-proof` (spec sect. 10.2),
 * which is deliberately out of `npm test`: nondeterminism in a trust anchor
 * erodes it (sect. 12 item 1).
 *
 * Every refusal asserted here has been shown to FAIL when flipped to an
 * acceptance (sect. 12 item 3). A test that has not been shown to fail is not a
 * test, and this repository has shipped one.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPack, parseAgentMd, resolvePackCwd } from "../src/agentdef.js";
import { BUILTIN_CLASSES, classifyBuiltin, declaredOfClass, fenceApplies, GUARDED_BUILTINS, platformInjectedTools, reachableToolSurface, toolCountWarning } from "../src/toolclass.js";
import { deprecatedOffers, selectOffers } from "../src/offers.js";
import { artifactDrift } from "../src/artifacts.js";
import { surfaceReport } from "../src/surface.js";
import { isWrappableServer, mcpServerPolicy, shellQuote } from "../src/mcpsandbox.js";
import { hasWriteSurface, sandboxAvailable, sandboxPolicy, type SandboxProbe } from "../src/writefence.js";
import { classifyDenial, egressBackstopMessage, egressPolicy, postureView } from "../src/egress.js";
import { dropNestedKey, editPack } from "../src/cli/agentmd.js";
import { inertNetworkKeys } from "../src/cli/commands/doctor.js";
import { consolidationQueryOptions, llmOnce, withIsolatedCwd } from "../src/consolidate.js";
import { importsSdkQuery, siteDeclarationFailures, unlistedQueryModules } from "../src/querysites.js";

// ---------------------------------------------------------------- rung 1 (sect. 4.6)

const pack = (sandbox: string[] = []) =>
  ["---", "rfa_agent: 1", "name: x", "description: d", ...(sandbox.length ? ["sandbox:", ...sandbox] : []), "---", "prompt"].join("\n") + "\n";

// Rung 1 refused `allowlist` BY NAME "until 4.1 to 4.5 and 4.7 ship" (sect. 4.6).
// Rung 4 shipped them, so the refusal it replaces is now conditional and the
// tests that own it live in the rung 4 block below. What rung 1 owns
// permanently is here: `none` still parses, the scaffold stops writing the key,
// and the cleanup reaches packs already on disk.

test("rung 1: `network: open` is refused BY NAME and permanently", () => {
  assert.throws(
    () => parseAgentMd(pack(["  network: open"])),
    (err: Error) => {
      assert.match(err.message, /sandbox\.network/);
      assert.match(err.message, /deniedDomains/, "the ground is the runtime's own allowlist grammar, not a policy preference");
      assert.match(err.message, /permanently/);
      return true;
    },
  );
});

test("rung 1: `none` still parses, or every pack on disk stops booting", () => {
  // Every pack `rfa agent new` wrote before this rung carries the line. sect.
  // 4.6 keeps it legal for exactly that reason.
  assert.equal(parseAgentMd(pack(["  isolation: none", "  permission_mode: default", "  network: none"])).def.sandbox?.network, "none");
  // And a pack that never wrote it reads the same, which is why the doctor
  // check below cannot use the parsed definition.
  assert.equal(parseAgentMd(pack(["  isolation: none"])).def.sandbox?.network, "none");
});

test("rung 1: the scaffold no longer writes the line it could not read", () => {
  const src = fs.readFileSync(new URL("../src/cli/scaffold.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /^\s*network: none$/m, "sect. 4.6: rfa agent new stops writing `network:` in the same change that refuses its other values");
});

test("rung 1: --drop-network strips the inert lines and leaves every other byte alone", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-egress-"));
  const file = path.join(dir, "agent.md");
  const before = [
    "---",
    "rfa_agent: 1",
    "name: x",
    "description: d   # a comment the operator wrote",
    "sandbox:",
    "  isolation: none     # the only implemented value",
    "                      # and its continuation line",
    "  permission_mode: default",
    "  network: none",
    "---",
    "",
    "prompt body",
    "",
  ].join("\n");
  fs.writeFileSync(file, before);
  const r = editPack(file, { dropNetwork: true });
  const after = fs.readFileSync(file, "utf8");
  assert.notEqual(r.before, r.after, "removing a line rotates the definition hash");
  assert.deepEqual(r.changed, ["sandbox.network (inert, removed)"]);
  assert.doesNotMatch(after, /network:/);
  assert.match(after, /isolation: none {5}# the only implemented value/, "the operator's comment survives");
  assert.match(after, /# and its continuation line/, "and so does a continuation comment that belongs to another key");
  assert.match(after, /description: d {3}# a comment the operator wrote/);
  assert.match(after, /permission_mode: default/);
  assert.equal(parseAgentMd(after).def.sandbox?.permission_mode, "default", "and the result still loads");
  // Re-running is a no-op rather than an error: doctor names the fix and an
  // operator may run it twice.
  assert.equal(editPack(file, { dropNetwork: true }).changed.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rung 1: emptying the sandbox block removes the header, or the pack stops loading", () => {
  const text = ["---", "rfa_agent: 1", "name: x", "description: d", "sandbox:", "  network: none", "budgets:", "  max_turns: 4", "---", "prompt", ""].join("\n");
  const out = dropNestedKey(text, "sandbox", "network");
  assert.doesNotMatch(out, /^sandbox:$/m, "`sandbox:` with nothing under it is YAML null, which the schema refuses");
  assert.match(out, /max_turns: 4/, "the block after it is untouched");
  assert.doesNotThrow(() => parseAgentMd(out));
});

test("rung 1: doctor reads the FILE, because the parsed definition cannot tell a default from a declaration", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-egress-doc-"));
  fs.writeFileSync(path.join(dir, "agent.md"), pack(["  isolation: none", "  network: none"]));
  assert.deepEqual(inertNetworkKeys(dir), ["network"]);
  fs.writeFileSync(path.join(dir, "agent.md"), pack(["  isolation: none"]));
  assert.deepEqual(inertNetworkKeys(dir), [], "zod fills `network: none` in for this pack too; only the raw frontmatter knows the operator never wrote it");
  fs.writeFileSync(path.join(dir, "agent.md"), "not a pack at all");
  assert.deepEqual(inertNetworkKeys(dir), [], "an unparseable pack is the pack check's problem, not this one's");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- rung 2 (sect. 6)

// `fileURLToPath`, never `.pathname`: a checkout whose absolute path contains a
// space arrives here percent-encoded, and `unlistedQueryModules` would then walk
// a directory that does not exist and return [] - a green tick over a property
// nobody checked, which is the exact shape RFA-0.9 exists to remove.
const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("rung 2: every module reaching the SDK's query is in the inventory", () => {
  assert.deepEqual(
    unlistedQueryModules(REPO),
    [],
    "sect. 6.3: a requirement to keep an inventory that no test enforces is a wish. Add the module to QUERY_SITES in src/querysites.ts, with what it declares",
  );
});

test("rung 2: no listed site has quietly lost a declaration sect. 6.1 requires", () => {
  assert.deepEqual(siteDeclarationFailures(REPO), []);
});

test("rung 2: the check is anchored on the IMPORT, never on the text `query(`", () => {
  // sect. 6.3 names the reason: `query(` matches a GraphQL literal and two prose
  // comments in this repository, so a text anchor would be red on arrival.
  assert.equal(importsSdkQuery('import { query } from "@anthropic-ai/claude-agent-sdk";'), true);
  assert.equal(importsSdkQuery('import {\n  createSdkMcpServer,\n  query,\n  tool,\n} from "@anthropic-ai/claude-agent-sdk";'), true);
  assert.equal(importsSdkQuery('import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";'), true);
  assert.equal(importsSdkQuery('import { tool } from "@anthropic-ai/claude-agent-sdk";'), false, "importing something else from the SDK is not reaching query");
  assert.equal(importsSdkQuery('import { query } from "./mystore.js";\n// const q = query({ ... })'), false, "a query from somewhere else is somebody else's problem");
  assert.equal(importsSdkQuery('const gql = `query { rooms { id } }`;\n// see query( above'), false, "the text anchor sect. 6.3 forbids would have matched both of these");
});

test("rung 2: the consolidation lane's own options, measured rather than read off a comment", () => {
  const opts = consolidationQueryOptions("/tmp/whatever", "system", "haiku");
  assert.deepEqual(opts.tools, [], "sect. 6.1: a lane needing no tools passes `tools: []`, which makes every built-in ABSENT");
  assert.deepEqual(opts.allowedTools, [], "and the permission-layer form too, which is what it had and what was not enough");
  assert.deepEqual(opts.settings, { disableClaudeAiConnectors: true }, "the operator's connectors ride the login, not settingSources");
  assert.deepEqual(opts.settingSources, []);
  assert.equal(opts.maxTurns, 1);
});

test("rung 2: the lane cannot be pointed at the hub root, because it takes no cwd at all", async () => {
  // sect. 6.2. The lane used to be handed `hubdir.root`; E9 measured Read
  // succeeding there and E12 measured it executing under maxTurns: 1. The fix
  // that holds for every future caller is removing the choice.
  const seen: string[] = [];
  const cwd = await withIsolatedCwd(async (dir) => {
    seen.push(dir);
    assert.deepEqual(fs.readdirSync(dir), [], "an empty directory: there is nothing under it to read even if a tool came back");
    return dir;
  });
  assert.equal(fs.existsSync(cwd), false, "and it is gone afterwards");
  assert.equal(llmOnce.length, 3, "systemPrompt, prompt, model: no cwd parameter for a caller to get wrong");
  assert.doesNotMatch(seen[0], /rfa[/\\]acme/, "never a hub directory");
});

// ---------------------------------------------------------------- rung 3 (sect. 3)

const toolPack = (allow: string, extra: string[] = []) =>
  ["---", "rfa_agent: 1", "name: x", "description: d", "tools:", `  allow: [${allow}]`, ...extra, "---", "prompt"].join("\n") + "\n";

test("rung 3: the class table matches on the tool HEAD, so a specifier classifies with its base", () => {
  assert.equal(classifyBuiltin("Bash"), "command");
  assert.equal(classifyBuiltin("Bash(git:*)"), "command", "sect. 3.1: the substring before the first `(`");
  assert.equal(classifyBuiltin("Task(explore)"), "subagent");
  assert.equal(classifyBuiltin("Write"), "guarded");
  assert.equal(classifyBuiltin("WebFetch"), "reach");
  assert.equal(classifyBuiltin("Glob"), "read");
  assert.equal(classifyBuiltin("mcp__rfa__ask"), null, "an MCP name is not a built-in; 3.2 checks it against the declared servers instead");
  assert.equal(classifyBuiltin("Sudo"), null);
  // One source of truth for the guarded set: the fence re-exports the table's.
  for (const g of GUARDED_BUILTINS) assert.equal(BUILTIN_CLASSES[g], "guarded", `${g} must classify as guarded, or the fence and the table disagree`);
});

test("rung 3: an unclassified tools.allow entry is refused at definition load", () => {
  assert.throws(() => parseAgentMd(toolPack("Read, Sudo")), (err: Error) => {
    assert.match(err.message, /`Sudo` is not a classified built-in/);
    assert.match(err.message, /sect\. 3\.2|sect\. 3\.1/);
    return true;
  });
  // Every shape sect. 3.2 names, each landing verbatim in the SDK's base tool set today.
  assert.throws(() => parseAgentMd(toolPack('Read, ""')), /an empty entry/);
  assert.throws(() => parseAgentMd(toolPack("Read, Read")), /listed twice/);
  assert.throws(() => parseAgentMd(toolPack("Read, mcp__nosuch__do")), /does not declare/);
  // And the legal grammar still parses.
  assert.ok(parseAgentMd(toolPack("Read, Grep, Glob, Bash(git:*), mcp__rfa__ask, mcp__memory__view")));
  assert.ok(parseAgentMd(toolPack("Read, mcp__linear__save_document", ["mcp_servers:", "  linear:", "    builtin: linear"])));
});

test("rung 3: the coverage predicate is guarded OR command, which is what a Bash-only pack was missing", () => {
  assert.equal(fenceApplies({ tools: { allow: ["Read", "Grep"] } }), false);
  assert.equal(fenceApplies({ tools: { allow: ["Read", "Write"] } }), true, "a writing pack, as before");
  assert.equal(fenceApplies({ tools: { allow: ["Read", "Bash"] } }), true, "sect. 3.3: the case that used to get NO door at all");
  assert.equal(fenceApplies({ tools: { allow: ["Read", "Bash(git:*)"] } }), true, "and a specifier form is the same pack");
  assert.equal(hasWriteSurface({ tools: { allow: ["Read", "Bash"] } }), false, "and it is still not a WRITING pack: door one has nothing to guard");
  assert.deepEqual(declaredOfClass(["Read", "Bash(git:*)", "Bash(npm:*)"], "command"), ["Bash"], "deduplicated by head");
});

test("rung 3: a command-only pack gets a writing pack's door-two policy", () => {
  // sect. 3.4: allowWrite is this run's scratch, and the deny list never carves
  // the run out of its own surface. The policy is the SAME function, which is
  // the point: there is no second, weaker policy for a command-only pack.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-cmdpack-"));
  const scratch = path.join(dir, "scratch", "run1");
  fs.mkdirSync(scratch, { recursive: true });
  const policy = sandboxPolicy({ scratchDir: scratch, denyWrite: [path.join(dir, "state"), dir] });
  assert.deepEqual(policy.filesystem.allowWrite, [fs.realpathSync(scratch)]);
  assert.equal(policy.allowUnsandboxedCommands, false, "the default is TRUE, which leaves dangerouslyDisableSandbox live");
  assert.equal(policy.failIfUnavailable, true);
  assert.equal(policy.filesystem.denyWrite.includes(fs.realpathSync(dir)), false, "an ancestor of the allow root would carve the run out of its own workspace");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rung 3: sandbox.cwd must resolve inside the pack directory", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-cwd-"));
  const packDir = path.join(dir, "agents", "x");
  fs.mkdirSync(path.join(packDir, "work"), { recursive: true });
  const write = (cwd: string) => {
    fs.writeFileSync(path.join(packDir, "agent.md"), toolPack("Read, Grep", ["sandbox:", `  cwd: ${JSON.stringify(cwd)}`]));
    return () => loadPack(packDir);
  };
  // The escapes, each naming the read-surface reason sect. 3.4b gives.
  assert.throws(write("../.."), (err: Error) => {
    assert.match(err.message, /outside this pack's own directory/);
    assert.match(err.message, /never reaches canUseTool/, "the refusal names the READ-surface reason, per sect. 3.4b");
    return true;
  });
  assert.throws(write("/etc"), /outside this pack's own directory/);
  assert.throws(write("../y"), /outside this pack's own directory/);
  // Inside is legal, and `.` is now the PACK, not the hub root. That is the
  // whole defect: `.` used to resolve against the hub root, where
  // `.rfa/secrets.json` sits, and a Read there never reaches the callback.
  assert.equal(write("work")().def.sandbox?.cwd, "work");
  assert.deepEqual(resolvePackCwd(packDir, "work"), { ok: true, path: path.join(packDir, "work") });
  assert.deepEqual(resolvePackCwd(packDir, "."), { ok: true, path: packDir });
  assert.equal(resolvePackCwd(packDir, ".").ok && resolvePackCwd(packDir, ".").path === dir, false, "and never the hub directory above it");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rung 3: sandbox.cwd on a FENCED pack is refused, never silently overridden", () => {
  // sect. 3.4b: a fenced run's working directory IS its scratch surface, so
  // honouring the key would be a lie and ignoring it would be a different one.
  assert.throws(() => parseAgentMd(toolPack("Read, Bash", ["sandbox:", '  cwd: "work"'])), (err: Error) => {
    assert.match(err.message, /is FENCED/);
    assert.match(err.message, /Bash/);
    assert.match(err.message, /refused here rather than silently overridden/);
    return true;
  });
  assert.throws(() => parseAgentMd(toolPack("Read, Write", ["sandbox:", '  cwd: "work"'])), /is FENCED/);
  assert.ok(parseAgentMd(toolPack("Read, Grep", ["sandbox:", '  cwd: "work"'])), "an unfenced pack may still point it inside itself");
});

test("rung 3: the prose that reads as coverage was moved with the predicate (sect. 3.6)", () => {
  const spec8 = fs.readFileSync(new URL("../spec/RFA-0.8-concurrency.md", import.meta.url), "utf8");
  const claude = fs.readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
  for (const [name, text] of [["RFA-0.8 sect. 9 item 2", spec8], ["CLAUDE.md", claude]] as const) {
    assert.match(text, /ONLY door for Bash/, `${name} still states the mechanism`);
    assert.match(text, /RFA-0\.9 sect\. 3\.(3|6)/, `${name} must also say a pack declaring Bash is fenced for that reason`);
  }
});

// ---------------------------------------------------------------- rung 4 (sect. 4, 10.2)

const netPack = (allow: string, sandbox: string[]) =>
  ["---", "rfa_agent: 1", "name: x", "description: d", "tools:", `  allow: [${allow}]`, "sandbox:", ...sandbox, "---", "prompt"].join("\n") + "\n";

test("rung 4: allowlist is accepted where it governs something, and refused where it cannot act", () => {
  // Accepted: a pack with a sandboxed command surface and hosts named.
  const ok = parseAgentMd(netPack("Read, Bash", ["  network: allowlist", "  allowed_domains: [api.example.com, files.example.com]"]));
  assert.equal(ok.def.sandbox?.network, "allowlist");
  // sect. 4.4: inapplicability is REFUSED, not decorated.
  assert.throws(() => parseAgentMd(netPack("Read, Grep", ["  network: allowlist", "  allowed_domains: [a.com]"])), (err: Error) => {
    assert.match(err.message, /nothing to govern on this pack/);
    assert.match(err.message, /no built-in of class `command`/);
    return true;
  });
  // sect. 4.2: an allowlist with nothing on it MUST NOT be silently read as `none`.
  assert.throws(() => parseAgentMd(netPack("Read, Bash", ["  network: allowlist"])), /needs a non-empty/);
  assert.throws(() => parseAgentMd(netPack("Read, Bash", ["  network: allowlist", "  allowed_domains: []"])), /needs a non-empty/);
  // sect. 4.2: `allowed_domains` beside any other posture reads as a policy and is not one.
  assert.throws(() => parseAgentMd(netPack("Read, Bash", ["  network: none", "  allowed_domains: [a.com]"])), /nothing reads it/);
  // sect. 4.2: `open` stays refused by name, permanently, with both grounds.
  assert.throws(() => parseAgentMd(netPack("Read, Bash", ["  network: open"])), (err: Error) => {
    assert.match(err.message, /deniedDomains/);
    assert.match(err.message, /E10a/);
    assert.match(err.message, /permanently/);
    return true;
  });
});

test("rung 4: strictAllowlist is not optional, on any posture", () => {
  // sect. 4.3. E3 measured the alternative: without it the denial reason is
  // `user denied`, and E10a measured that same shape returning HTTP:200.
  const none = egressPolicy({ sandbox: { network: "none" } });
  assert.deepEqual(none, { allowedDomains: [], deniedDomains: [], strictAllowlist: true });
  const list = egressPolicy({ sandbox: { network: "allowlist", allowed_domains: ["a.com"] } });
  assert.deepEqual(list, { allowedDomains: ["a.com"], deniedDomains: [], strictAllowlist: true });
  // And a pack with no sandbox block at all is `none`, not "omit the key",
  // which is the ask path E1 and E10 measured.
  assert.deepEqual(egressPolicy({}), { allowedDomains: [], deniedDomains: [], strictAllowlist: true });
  // Door two's policy carries it through, and cannot be built without it.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-egr-"));
  const policy = sandboxPolicy({ scratchDir: dir, denyWrite: [], network: { allowedDomains: ["a.com"], deniedDomains: [], strictAllowlist: true } });
  assert.equal(policy.network.strictAllowlist, true);
  assert.deepEqual(policy.network.allowedDomains, ["a.com"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rung 4: a posture is never rendered without its scope, and an inapplicable one says so", () => {
  const inForce = postureView({ tools: { allow: ["Read", "Bash"] }, sandbox: { network: "allowlist", allowed_domains: ["a.com"] } });
  assert.equal(inForce.inert, false);
  assert.deepEqual(inForce.governs, ["Bash"]);
  assert.match(inForce.summary, /a\.com/);
  assert.match(inForce.scope, /SANDBOXED COMMAND surface only/);
  assert.match(inForce.scope, /MCP servers/, "sect. 4.1: the scope names what the posture does NOT cover");
  assert.match(inForce.scope, /WebFetch/);
  const inert = postureView({ tools: { allow: ["Read", "Grep"] }, sandbox: { network: "none" } });
  assert.equal(inert.inert, true);
  assert.match(inert.summary, /INERT on this pack/, "sect. 4.2: on a pack with no command surface it MUST be rendered as inert, not as a posture in force");
});

test("rung 4: the denial reason is the property, and the two are told apart", () => {
  // sect. 4.3 and 4.5. E2 versus E3, in one function.
  assert.equal(classifyDenial("deny network-outbound x:443 (host is not on the allow list)", false), "allowlist");
  assert.equal(classifyDenial("deny network-outbound x:443 (user denied)", false), "no-approver");
  assert.equal(classifyDenial("", true), "reached");
  assert.equal(classifyDenial("curl: (7) something else", false), "unclear", '"we could not tell" is not "it is fenced"');
});

test("rung 4: an interrupt_on rule on the egress name is refused at definition load", () => {
  // sect. 4.7: it would convert a fail-closed backstop into an approval path,
  // and probe E10a measured that exact shape returning HTTP:200.
  const withRule = (pattern: string) =>
    ["---", "rfa_agent: 1", "name: x", "description: d", "tools:", "  allow: [Read, Bash]", "interrupt_on:", `  "${pattern}": true`, "---", "prompt"].join("\n") + "\n";
  assert.throws(() => parseAgentMd(withRule("SandboxNetworkAccess")), (err: Error) => {
    assert.match(err.message, /interrupt_on. rule matches/);
    assert.match(err.message, /E10a/);
    return true;
  });
  assert.throws(() => parseAgentMd(withRule("Sandbox*")), /interrupt_on. rule matches/, "a glob that reaches the name is the same rule");
  assert.throws(() => parseAgentMd(withRule("*")), /interrupt_on. rule matches/, "and so is a catch-all");
});

test("rung 4: door one's backstop names the host and never decides from the posture", () => {
  const alarm = egressBackstopMessage("files.example.com", true);
  assert.match(alarm, /files\.example\.com/, "the log line said nothing about WHAT was refused before this rung");
  assert.match(alarm, /strictAllowlist/);
  assert.match(alarm, /failed rather than continued/, "sect. 4.7: its arrival is itself the alarm");
  const plain = egressBackstopMessage("", false);
  assert.match(plain, /named no host/);
  assert.match(plain, /refuses by default/);
  // It never says "allowed": there is no shape of this branch that permits egress.
  for (const m of [alarm, plain]) assert.doesNotMatch(m, /\ballow(ed)?\b/i);
});

test("rung 4: the boot establishment asks for the pack's OWN policy and reads the reason", async () => {
  // sect. 4.5. The old call passed `network: {}` - no policy - so it established
  // the filesystem half and proved nothing about the half the posture carries.
  const seen: unknown[] = [];
  const probe = (denial: string, stdout = "HTTP:000"): SandboxProbe => ({
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({}),
    initialize: async (config) => void seen.push(config),
    wrapWithSandbox: async (c) => c,
    wrapWithSandboxArgv: async () => ({ argv: ["/bin/echo", "x"], env: {} }),
    waitForNetworkInitialization: async () => true,
    annotateStderrWithSandboxFailures: () => denial,
    reset: async () => {},
  });
  /**
   * A runner standing in for a WORKING sandbox: the write inside the allow root
   * lands, the one outside it does not. Both halves matter - the filesystem
   * establishment runs before the network one, and faking it as "ok" without
   * creating the witness would make every case below fail for the wrong reason.
   */
  const fsRun = (cmd: string): { ok: boolean; detail: string } => {
    if (cmd.includes("canary")) return { ok: false, detail: "sandbox denied a write outside the allow root" };
    execFileSync("/bin/sh", ["-c", cmd]);
    return { ok: true, detail: "" };
  };
  const policy = { allowedDomains: ["api.example.com"], deniedDomains: [], strictAllowlist: true as const };

  // The `(user denied)` refusal is NOT accepted: it is the ask path, and E10a
  // measured it resolving as an allow under a callback that says yes.
  const asked = await sandboxAvailable(probe("deny network-outbound x:443 (user denied)"), fsRun, policy, async () => ({ stdout: "HTTP:000", stderr: "" }));
  assert.equal(asked.ok, false);
  assert.match(asked.detail, /strictAllowlist is not being honoured/);
  // A host that was REACHED fails too, loudly.
  const reached = await sandboxAvailable(probe(""), fsRun, policy, async () => ({ stdout: "HTTP:200", stderr: "" }));
  assert.equal(reached.ok, false);
  assert.match(reached.detail, /was REACHED/);
  // An unrecognized outcome fails closed rather than passing.
  const unclear = await sandboxAvailable(probe("curl: (7) couldn't connect"), fsRun, policy, async () => ({ stdout: "HTTP:000", stderr: "" }));
  assert.equal(unclear.ok, false);
  assert.match(unclear.detail, /neither reached it nor was refused/);
  // The allow-list reason is the one that establishes.
  const good = await sandboxAvailable(probe("deny network-outbound x:443 (host is not on the allow list)"), fsRun, policy, async () => ({ stdout: "HTTP:000", stderr: "" }));
  assert.equal(good.ok, true, good.detail);
  assert.match(good.detail, /egress denied by the allow list/);
  // And the policy srt was initialized with is the PACK's, never `{}`.
  assert.deepEqual((seen.at(-1) as { network: unknown }).network, policy);
  // A pack with no command surface skips the network half and still establishes
  // the filesystem one: there is nothing for the posture to govern (sect. 4.2).
  const noSurface = await sandboxAvailable(probe(""), fsRun, null, async () => ({ stdout: "HTTP:200", stderr: "" }));
  assert.equal(noSurface.ok, true);
  assert.doesNotMatch(noSurface.detail, /egress/);
  assert.deepEqual((seen.at(-1) as { network: unknown }).network, {});
});

// ---------------------------------------------------------------- rung 5 (sect. 7)

test("rung 5: one function computes the TOTAL reachable surface, platform tools included", () => {
  // sect. 7.1: no such function existed, which is why no check could be written
  // against the total. `posture.builtins` answered about built-ins and
  // `allowedTools` about pre-approval; the injected servers were counted nowhere.
  const s = reachableToolSurface({ tools: { allow: ["Read", "Grep", "Bash(git:*)", "mcp__linear__save_document"] } });
  assert.deepEqual(s.builtins, ["Read", "Grep", "Bash"], "by HEAD: a specifier form is one tool");
  assert.deepEqual(s.mcp, ["mcp__linear__save_document"]);
  assert.deepEqual(s.platform, platformInjectedTools({}), "sect. 5.2: registered whether the pack asked or not");
  assert.equal(s.total, s.builtins.length + s.mcp.length + s.platform.length);
  // A pack that ALSO declares an injected verb reaches one tool, not two.
  const dup = reachableToolSurface({ tools: { allow: ["mcp__memory__view"] } });
  assert.equal(dup.all.filter((t) => t === "mcp__memory__view").length, 1);
  // The destructive verbs are injected only for a pack that names them.
  assert.equal(platformInjectedTools({}).includes("mcp__memory__delete"), false);
  assert.equal(platformInjectedTools({ tools: { allow: ["mcp__memory__delete"] } }).includes("mcp__memory__delete"), true);
});

test("rung 5: above the threshold it WARNS, names the count, and says whose number it is", () => {
  const many = Array.from({ length: 24 }, (_, i) => `mcp__srv__tool_${i}`);
  const def = { tools: { allow: ["Read", ...many] }, mcp_servers: { srv: { command: "/bin/true" } } };
  const w = toolCountWarning(def);
  assert.ok(w, "24 MCP tools + Read + 6 injected is over 25");
  assert.match(w!, new RegExp(String(reachableToolSurface(def).total)), "the count is named");
  assert.match(w!, /W6 sect\. 2\.6/, "sect. 7.2: the warning text MUST say the number is a vendor observation");
  assert.match(w!, /never a refusal/);
  assert.equal(toolCountWarning({ tools: { allow: ["Read", "Grep"] } }), null);
  // And it really is a warning: the definition still loads.
  const md = ["---", "rfa_agent: 1", "name: x", "description: d", "tools:", `  allow: [Read, ${many.join(", ")}]`, "mcp_servers:", "  srv:", "    command: /bin/true", "---", "prompt"].join("\n");
  const parsed = parseAgentMd(md);
  assert.equal(parsed.def.name, "x");
  assert.equal(parsed.warnings.length, 1, "and it rides out to whoever can print it");
  assert.match(parsed.warnings[0], /above the 25-tool threshold/);
});

test("rung 5: an unknown key in an offers entry is refused, not silently discarded", () => {
  // sect. 7.3: an operator who mistyped a key got a card missing that field and
  // no error anywhere, which is `z.object`'s default.
  const withKey = (line: string) =>
    ["---", "rfa_agent: 1", "name: x", "description: d", "offers:", "  - id: answer", "    description: a", `    ${line}`, "---", "prompt"].join("\n");
  assert.throws(() => parseAgentMd(withKey("inputSchema: {}")), /offers/, "a camelCase typo of input_schema");
  assert.throws(() => parseAgentMd(withKey("descriptoin: oops")), /offers/);
  assert.ok(parseAgentMd(withKey("input_schema: {}")));
  assert.ok(parseAgentMd(withKey("deprecated: true")), "and the rung 6 keys are known");
});

// ---------------------------------------------------------------- rung 6 (sect. 8)

test("rung 6: a local selector prefers a live offer and names the deprecation when it cannot", () => {
  const offers = [
    { id: "old-way", description: "d", deprecated: true, superseded_by: "new-way" },
    { id: "new-way", description: "d" },
  ];
  const live = selectOffers(offers);
  assert.deepEqual(live.chosen.map((o) => o.id), ["new-way"], "sect. 8.1: never a deprecated offer while a non-deprecated one matches");
  assert.deepEqual(live.notes, []);
  const only = selectOffers([offers[0]]);
  assert.deepEqual(only.chosen.map((o) => o.id), ["old-way"], "it is chosen anyway rather than refused: this is a lifecycle, not a ban");
  assert.match(only.notes[0], /superseded by `new-way`/);
  assert.match(only.notes[0], /the room's roster does not carry this flag/, "sect. 8.1: the blindness MUST be stated wherever the feature is");
  assert.deepEqual(selectOffers([]).chosen, []);
  // The predicate is the caller's; this owns the deprecation rule and nothing else.
  assert.deepEqual(selectOffers(offers, (o) => o.id === "old-way").chosen.map((o) => o.id), ["old-way"]);
  // And doctor's list.
  assert.deepEqual(deprecatedOffers([{ name: "p", def: { offers } }]).map((d) => d.offer.id), ["old-way"]);
});

test("rung 6: generated-artifact drift is measured against what the file was generated FROM", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-artifact-"));
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, "generated");
  const record = {
    files: [file],
    room: "r_1",
    sources: [{ pack: "pm", definition_hash: "sha256:aaaaaaaa" }],
    skipped: ["broken-pack"],
    written_at: "2026-08-29T00:00:00.000Z",
  };
  const drift = artifactDrift([record], [{ name: "pm", definitionHash: "sha256:bbbbbbbb", rooms: ["r_1"] }, { name: "scribe", definitionHash: "sha256:cccccccc", rooms: ["r_1"] }]);
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0].moved.map((m) => m.pack), ["pm"], "the pack's definition moved since the file was written");
  assert.deepEqual(drift[0].added, ["scribe"], "a pack that now binds to the room and is not in the file");
  assert.deepEqual(drift[0].skipped, ["broken-pack"], "sect. 8.2: a pack the tolerant scan skipped was recorded nowhere before this");
  // Unchanged is not drift - except that this record carries a pack that was
  // BROKEN at generation time, which is drift for as long as it is unfixed:
  // whoever reads that file is missing offers and has no way to know.
  const unchanged = artifactDrift([record], [{ name: "pm", definitionHash: "sha256:aaaaaaaa", rooms: ["r_1"] }]);
  assert.deepEqual(unchanged[0].moved, []);
  assert.deepEqual(unchanged[0].added, []);
  assert.deepEqual(unchanged[0].skipped, ["broken-pack"]);
  const clean = { ...record, skipped: [] };
  assert.deepEqual(artifactDrift([clean], [{ name: "pm", definitionHash: "sha256:aaaaaaaa", rooms: ["r_1"] }]), []);
  // A destination the operator deleted is not drift: it is gone, which is an answer.
  fs.rmSync(file);
  assert.deepEqual(artifactDrift([record], [{ name: "pm", definitionHash: "sha256:bbbbbbbb", rooms: ["r_1"] }]), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- rung 7 (sects. 3.5, 5.2, 5.3, 10.1)

test("rung 7: every unconfined surface a pack holds is named, with the mechanism", () => {
  const r = surfaceReport({
    tools: { allow: ["Read", "Grep", "WebFetch", "Bash"], allow_subagents: true },
    mcp_servers: { linear: { builtin: "linear", sandbox: { network: "allowlist", allowed_domains: ["api.linear.app"], allow_write: ["state/drafts"] } }, remote: { url: "https://x.example" } },
    sandbox: { network: "allowlist", allowed_domains: ["a.com"] },
  });
  const kinds = r.surfaces.map((s) => s.kind);
  assert.ok(kinds.includes("read"), "sect. 3.5: a `read` pack is rendered as holding an unconfined read surface");
  assert.ok(kinds.includes("reach"), "sect. 5.3");
  // sect. 5.4 after rung 8: the spawned server is CONFINED and rendered as such;
  // the url form is the residual surface rung 8 could not cover, and naming it is
  // what keeps sect. 5.2's rendering true now that its siblings are confined.
  assert.deepEqual(r.surfaces.filter((s) => s.kind === "mcp-server").map((s) => s.what), ["mcp_servers.remote (url form)"]);
  assert.deepEqual(r.surfaces.filter((s) => s.kind === "mcp-confined").map((s) => s.what), ["mcp_servers.linear (builtin form)"]);
  assert.match(r.surfaces.find((s) => s.kind === "mcp-server")!.why, /not ours to spawn/);
  assert.match(r.surfaces.find((s) => s.kind === "mcp-confined")!.why, /api\.linear\.app/);
  assert.match(r.surfaces.find((s) => s.kind === "mcp-confined")!.why, /ARGUMENTS of the tools the pack declared/, "what stays unconfined is SAID, not implied");
  assert.ok(kinds.includes("platform-tool"), "sect. 5.2: the platform's own injected tools are part of the surface");
  assert.ok(kinds.includes("subagent"), "Appendix B item 8");
  assert.match(r.surfaces.find((s) => s.kind === "read")!.why, /never reaches canUseTool/);
  assert.match(r.surfaces.find((s) => s.kind === "reach")!.why, /NEITHER door/);
  assert.match(r.surfaces.find((s) => s.kind === "platform-tool")!.why, /reaches other organizations/);
  assert.match(r.scope, /SANDBOXED COMMAND surface only/, "sect. 5.2: the surfaces are rendered whenever a posture is, so the posture can never be read as covering them");
  // A read-only answerer still holds the platform's tools, and the rendering says so.
  const plain = surfaceReport({ tools: { allow: ["Read"] } });
  assert.deepEqual(plain.surfaces.map((s) => s.kind), ["read", "platform-tool"]);
});

test("rung 7: a pack declaring a reach built-in must acknowledge it in the definition", () => {
  // sect. 5.3. A command-level confirmation was considered and rejected: nothing
  // owns tools.allow, so a promise at the command line would be unenforceable at
  // the only place the tool can actually arrive.
  const md = (extra: string[] = []) =>
    ["---", "rfa_agent: 1", "name: x", "description: d", "tools:", "  allow: [Read, WebFetch]", ...extra, "---", "prompt"].join("\n");
  assert.throws(() => parseAgentMd(md()), (err: Error) => {
    assert.match(err.message, /WebFetch/);
    assert.match(err.message, /NEITHER door/);
    assert.match(err.message, /unconfined_reach_acknowledged/);
    assert.match(err.message, /acknowledgement, not a control/);
    return true;
  });
  assert.ok(parseAgentMd(md(["unconfined_reach_acknowledged: true"])));
  // And a posture is NOT refused because of it: that would leave a pack
  // declaring WebFetch and no Bash with no legal value of the field at all.
  assert.ok(parseAgentMd(md(["unconfined_reach_acknowledged: true", "sandbox:", "  network: none"])));
});

// ---------------------------------------------------------------- rung 8 (sect. 5.4)

test("rung 8: a server this platform SPAWNS must declare its own sandbox, or the pack is refused", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-mcp-"));
  const packDir = path.join(dir, "agents", "x");
  fs.mkdirSync(packDir, { recursive: true });
  const write = (server: string[]) => {
    fs.writeFileSync(
      path.join(packDir, "agent.md"),
      ["---", "rfa_agent: 1", "name: x", "description: d", "tools:", "  allow: [Read, mcp__srv__do]", "mcp_servers:", "  srv:", ...server, "---", "prompt"].join("\n") + "\n",
    );
    return () => loadPack(packDir);
  };
  // The load-bearing refusal: without it this rung is an option, not a control.
  assert.throws(write(["    command: /bin/true"]), (err: Error) => {
    assert.match(err.message, /declares no `sandbox` block/);
    assert.match(err.message, /probe E5/, "the refusal names what the unwrapped shape was measured doing");
    assert.match(err.message, /allow_write/, "and the exact block to add");
    return true;
  });
  assert.throws(write(["    builtin: linear"]), /declares no `sandbox` block/, "a server this package ships is still a server this platform spawns");
  // The url form is NOT ours to spawn, so it needs no block and is refused one.
  assert.ok(write(["    url: https://x.example"])());
  assert.throws(write(["    url: https://x.example", "    sandbox:", "      network: none"]), (err: Error) => {
    assert.match(err.message, /not ours to spawn/);
    assert.match(err.message, /named as residual/);
    return true;
  });
  // The declared shapes, refused the same way the pack posture is.
  assert.throws(write(["    command: /bin/true", "    sandbox:", "      network: allowlist"]), /allowlist. with no .allowed_domains/);
  assert.throws(write(["    command: /bin/true", "    sandbox:", "      network: open"]), /refused by name and permanently/);
  assert.throws(write(["    command: /bin/true", "    sandbox:", "      network: none", "      allowed_domains: [a.com]"]), /nothing reads it/);
  assert.throws(
    write(["    command: /bin/true", "    sandbox:", "      network: none", '      allow_write: ["../../elsewhere"]']),
    (err: Error) => {
      assert.match(err.message, /outside this pack's own directory/);
      assert.match(err.message, /a hole exactly as wide as the path/);
      return true;
    },
  );
  // And the shape that works.
  assert.ok(write(["    command: /bin/true", "    sandbox:", "      network: allowlist", "      allowed_domains: [api.example.com]", '      allow_write: ["state/drafts"]'])());
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rung 8: the policy handed to the launcher is the SERVER's, resolved against the pack", () => {
  const packDir = "/packs/x";
  const p = mcpServerPolicy(packDir, "srv", { network: "allowlist", allowed_domains: ["api.example.com"], allow_write: ["state/drafts"] });
  assert.deepEqual(p.network, { allowedDomains: ["api.example.com"], deniedDomains: [], strictAllowlist: true }, "sect. 4.3 applies wherever this platform establishes a network policy");
  assert.deepEqual(p.allowWrite, [path.join(packDir, "state", "drafts")], "pack-relative, resolved once, so the launcher never resolves a path against its own cwd");
  assert.equal(p.cwd, packDir);
  // `none` is an EMPTY allowlist, never an omitted key: omitting it is the ask
  // path, and there is no callback in a launcher to answer it.
  assert.deepEqual(mcpServerPolicy(packDir, "srv", { network: "none" }).network, { allowedDomains: [], deniedDomains: [], strictAllowlist: true });
  assert.equal(isWrappableServer({ command: "x" }), true);
  assert.equal(isWrappableServer({ builtin: "linear" }), true);
  assert.equal(isWrappableServer({ url: "https://x" }), false, "sect. 5.4: the url form's process is not ours to wrap");
  // An argument containing a quote must survive the shell string srt wraps.
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("rung 8: the launcher refuses to run a server unconfined", async () => {
  // The same choice RFA-0.8 sect. 9 item 3 makes for the write fence: a sandbox
  // that silently falls back to no sandbox and reports success is the failure
  // mode, and an MCP child is the surface probe E5 measured escaping.
  const launcher = fileURLToPath(new URL("../src/mcplaunch.ts", import.meta.url));
  const run = (env: NodeJS.ProcessEnv, args: string[]) =>
    new Promise<{ code: number; err: string }>((res) => {
      const c = spawn(process.execPath, ["--import", "tsx", launcher, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      c.stderr.on("data", (b: Buffer) => (err += b.toString()));
      c.on("exit", (code) => res({ code: code ?? 1, err }));
    });
  const noPolicy = await run({ RFA_MCP_SANDBOX: "" }, ["--", "/bin/true"]);
  assert.equal(noPolicy.code, 1);
  assert.match(noPolicy.err, /never runs a server unconfined/);
  const noCommand = await run({ RFA_MCP_SANDBOX: JSON.stringify({ server: "s", network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true }, allowWrite: [], cwd: process.cwd() }) }, []);
  assert.equal(noCommand.code, 1);
  assert.match(noCommand.err, /no server command/);
});
