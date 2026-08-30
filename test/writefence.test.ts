/**
 * The two-door write fence (RFA-0.8 sect. 9, rung 5): door one's path guard and
 * claim fence, door two's policy shape, the shadowing checks, the loud refusal
 * when the sandbox cannot establish itself, and the startup deny probe's three
 * verdicts.
 *
 * Everything here is the DETERMINISTIC half. The live half (a real model, a real
 * Seatbelt sandbox, a real Bash escape attempt) is the throwaway-pack proof in
 * `docs/LEDGER.md` and probes F-J in the live-probe note; a stress or live model
 * call has no business in the trust anchor.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseAgentMd } from "../src/agentdef.js";
import { agentPosture } from "../src/posture.js";
import {
  claimFence,
  contains,
  guardedBuiltinsOf,
  hasWriteSurface,
  isGuardedBuiltin,
  parseShadowWarning,
  pathGuard,
  realResolve,
  sandboxAvailable,
  sandboxPolicy,
  shadowingFailures,
  writeTargets,
  type SandboxProbe,
} from "../src/writefence.js";
import { guardedToProbe, probeGuardedBuiltin, probeIsFatal } from "../src/fenceprobe.js";

const writingPack = (extra: string[] = [], tools = "[Read, Grep, Write, Edit]") =>
  parseAgentMd(
    [
      "---",
      "rfa_agent: 1",
      "name: filer",
      "description: d",
      "tools:",
      `  allow: ${tools}`,
      "  allow_subagents: false",
      ...extra,
      "---",
      "prompt",
    ].join("\n"),
  ).def;

// ---------------------------------------------------------------- the declaration

test("a pack that declares a write-shaped built-in has a write surface, and Bash is not one", () => {
  assert.deepEqual(guardedBuiltinsOf(writingPack()), ["Write", "Edit"]);
  assert.equal(hasWriteSurface(writingPack()), true);
  // Bash is door two's alone: its write set cannot be traced from its arguments,
  // so calling it "guarded" would promise an interception nobody can perform.
  assert.equal(hasWriteSurface(writingPack([], "[Read, Bash]")), false);
  assert.equal(isGuardedBuiltin("Bash"), false);
  assert.equal(isGuardedBuiltin("NotebookEdit"), true);
});

test("the guarded built-ins are in the SDK base tool set and OUT of allowedTools", () => {
  const p = agentPosture(writingPack());
  assert.deepEqual(p.guarded, ["Write", "Edit"]);
  assert.deepEqual(p.builtins, ["Read", "Grep", "Write", "Edit"], "declared built-ins are the base set, so nothing else exists at all");
  assert.deepEqual(p.allowedTools, ["Read", "Grep"], "a bare allowedTools entry auto-approves BEFORE canUseTool, which is what switches door one off");
  // The regression this pins: before rung 5 a declared Write was bare in
  // allowedTools, so the callback never fired and the pack could write the
  // whole hub directory while reporting a `read-only` posture.
  assert.equal(p.allowedTools.includes("Write"), false);
});

test("a SPECIFIER declaration is the same declaration: Write(scratch/**) is guarded, out of allowedTools, and named by its head", () => {
  // The defect this pins (audit 2026-08-30, rank 1): isGuardedBuiltin compared
  // exact strings while fenceApplies head-matched, so this grammar - which the
  // validator accepts and RFA-0.9 sect. 3.1 blesses - produced a pack the
  // coverage predicate called FENCED while guardedBuiltinsOf returned []. The
  // entry then sat bare in allowedTools, auto-approved before canUseTool, with
  // door one off and every fail-closed check handed an empty guarded set.
  const spec = writingPack([], "['Read', 'Write(scratch/**)', 'Edit(src/**)', 'Write']");
  assert.deepEqual(guardedBuiltinsOf(spec), ["Write", "Edit"], "heads, deduplicated: Write(scratch/**) and Write are ONE declaration");
  assert.equal(hasWriteSurface(spec), true);
  assert.equal(isGuardedBuiltin("Write(scratch/**)"), true);
  const p = agentPosture(spec);
  assert.deepEqual(p.guarded, ["Write", "Edit"]);
  assert.deepEqual(p.allowedTools, ["Read"], "no guarded-headed entry may land in allowedTools, specifier form included");
  assert.deepEqual(p.builtins, ["Read", "Write", "Edit"], "the SDK base tool set takes NAMES, so specifier entries collapse to their head");
  // and the startup assert sees a scoped entry as the shadow it is
  const fails = shadowingFailures({ guarded: ["Write"], allowedTools: ["Write(scratch/**)"] });
  assert.equal(fails.length, 1);
  assert.match(fails[0], /Write\(scratch\/\*\*\).*bare in allowedTools/);
});

test("a guarded built-in the pack ALSO gates is both, and stays out of allowedTools for both reasons", () => {
  // The interaction door one must not get wrong: a pack that names Write in
  // `interrupt_on` has asked for a human card on every write. The fence narrows
  // WHERE a write may land; it never widens who may authorize one, so the
  // resident's callback runs its guards and then falls through to the card path
  // instead of returning `allow`. Both exclusions land on the same tool here,
  // which is what makes that fall-through reachable at all.
  const gated = parseAgentMd(
    [
      "---",
      "rfa_agent: 1",
      "name: filer",
      "description: d",
      "tools:",
      "  allow: [Read, Write]",
      "  allow_subagents: false",
      "interrupt_on:",
      '  "Write":',
      "    allowed_decisions: [approve, edit, reject]",
      "offers:",
      "  - id: write-a-file",
      "    description: writes",
      "---",
      "prompt",
    ].join("\n"),
  ).def;
  const p = agentPosture(gated);
  assert.deepEqual(p.guarded, ["Write"]);
  assert.deepEqual(p.acting, ["Write"], "the pack asked for a card on it, so it is an acting tool too");
  assert.deepEqual(p.allowedTools, ["Read"], "excluded twice over, and once would have been enough");
  assert.equal(p.mode, "ask", "a pack with an acting tool is not read-only, whatever the tool is");
});

test("a definition that would shadow the callback is refused at parse, not at boot", () => {
  assert.throws(
    () => writingPack(["sandbox:", "  permission_mode: acceptEdits"]),
    /acceptEdits/,
    "acceptEdits auto-accepts exactly the two tools door one exists to intercept",
  );
  assert.throws(() => writingPack(["sandbox:", "  permission_mode: bypassPermissions"]), /cannot be fenced/);
  // A pack with no write surface is untouched by the rule: there is no door one
  // to shadow.
  assert.doesNotThrow(() => writingPack(["sandbox:", "  permission_mode: acceptEdits"], "[Read, Grep]"));
});

test("shadowingFailures names the bare entry and the mode separately", () => {
  const both = shadowingFailures({ guarded: ["Write"], allowedTools: ["Read", "Write"], permissionMode: "acceptEdits" });
  assert.equal(both.length, 2);
  assert.match(both[0], /Write is listed bare in allowedTools/);
  assert.match(both[1], /acceptEdits/);
  assert.deepEqual(shadowingFailures({ guarded: ["Write"], allowedTools: ["Read"], permissionMode: "default" }), []);
});

test("the SDK's shadowing warning is parsed, because most of them are ours on purpose", () => {
  // Verbatim from probe A, so a change in the SDK's wording fails here rather
  // than silently turning the check into a no-op.
  const named = parseShadowWarning(
    "canUseTool will not be invoked for: Write, mcp__rfa__roster. Bare allowedTools entries auto-approve the whole tool " +
      "before the callback is consulted. To gate every tool call, use a PreToolUse hook; or remove the bare names from " +
      "allowedTools so they fall through to canUseTool. Allow rules from settings files can also shadow the callback but are not visible here.",
  );
  assert.deepEqual(named, ["Write", "mcp__rfa__roster"]);
  // Every resident query already emits this warning naming the MCP tools this
  // platform pre-approves deliberately: "any warning is fatal" would be a boot
  // loop, and the intersection with the guarded set is the real check.
  assert.deepEqual(
    parseShadowWarning("canUseTool will not be invoked for: mcp__rfa__roster, mcp__memory__view. Bare allowedTools entries auto-approve.").filter((t) =>
      ["Write", "Edit"].includes(t),
    ),
    [],
  );
  assert.deepEqual(parseShadowWarning("some unrelated node warning"), []);
});

// ---------------------------------------------------------------- door one: the path guard

test("realResolve resolves through a symlinked ancestor for a file that does not exist yet", () => {
  const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-fence-real-"));
  const link = path.join(fs.realpathSync(os.tmpdir()), `rfa-fence-link-${process.pid}`);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(real, link);
  try {
    // The file is not created: a Write's target never exists yet, which is why a
    // plain realpathSync throws and the nearest EXISTING ancestor is resolved
    // instead.
    assert.equal(realResolve(path.join(link, "sub", "new.txt"), real), path.join(real, "sub", "new.txt"));
    // Traversal is normalized before any comparison happens.
    assert.equal(realResolve(path.join(real, "a", "..", "..", "escape.txt"), real), path.join(path.dirname(real), "escape.txt"));
    // A relative path resolves against the run's own surface, not the process cwd.
    assert.equal(realResolve("out.txt", real), path.join(real, "out.txt"));
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("the path guard allows inside the run's surface and refuses everything else", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-fence-guard-"));
  const scratch = path.join(root, "pack", "scratch", "run_1");
  const otherRun = path.join(root, "pack", "scratch", "run_2");
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(otherRun, { recursive: true });
  fs.writeFileSync(path.join(root, "pack", "agent.md"), "x");
  try {
    const inside = pathGuard({ toolName: "Write", input: { file_path: path.join(scratch, "note.txt") }, scratchDir: scratch });
    assert.equal(inside.allow, true);

    for (const [what, target] of [
      ["the pack tree", path.join(root, "pack", "agent.md")],
      ["another run's surface", path.join(otherRun, "note.txt")],
      ["a traversal out of the surface", path.join(scratch, "..", "..", "agent.md")],
      ["somewhere else entirely", path.join(root, "elsewhere.txt")],
    ] as const) {
      const v = pathGuard({ toolName: "Edit", input: { file_path: target }, scratchDir: scratch });
      assert.equal(v.allow, false, `${what} must be refused`);
      if (!v.allow) assert.match(v.message, /writable surface/, `${what}: the refusal has to tell the model where it MAY write`);
    }

    // A symlink planted inside the surface that points out of it. String-prefix
    // containment says yes; the filesystem says no, and this repository has
    // already paid once for believing the string.
    const trap = path.join(scratch, "trap.txt");
    fs.symlinkSync(path.join(root, "pack", "agent.md"), trap);
    const viaLink = pathGuard({ toolName: "Edit", input: { file_path: trap }, scratchDir: scratch });
    assert.equal(viaLink.allow, false, "a symlinked target resolves OUT of the surface and is refused");

    // NotebookEdit writes through a different field, and a guarded tool whose
    // target cannot be established is refused rather than allowed.
    assert.equal(pathGuard({ toolName: "NotebookEdit", input: { notebook_path: path.join(scratch, "n.ipynb") }, scratchDir: scratch }).allow, true);
    const blind = pathGuard({ toolName: "Write", input: { content: "x" }, scratchDir: scratch });
    assert.equal(blind.allow, false);
    if (!blind.allow) assert.match(blind.message, /cannot be established/);
    assert.equal(writeTargets("Bash", { command: "rm -rf /" }).ok, false, "Bash is never traced from its arguments");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("contains is directory containment, not a string prefix", () => {
  assert.equal(contains("/a/b", "/a/b"), true);
  assert.equal(contains("/a/b", "/a/b/c"), true);
  assert.equal(contains("/a/b", "/a/bc"), false, "a sibling whose name starts with the root's is not inside it");
});

// ---------------------------------------------------------------- door one: the claim fence

test("the claim fence tells re-claim from abandon, which is the point of reading all three fields", () => {
  const held = { taskId: "t_1", attempt: 1, owner: "m_me" };
  assert.equal(claimFence(held, { current_attempt: 1, current_owner: "m_me", task_state: "working" }).ok, true);

  const reclaimed = claimFence(held, { current_attempt: 2, current_owner: "m_other", task_state: "working" });
  assert.equal(reclaimed.ok, false);
  if (!reclaimed.ok) assert.match(reclaimed.message, /RE-CLAIM/);

  const abandoned = claimFence(held, { current_attempt: 1, current_owner: null, task_state: "submitted" });
  assert.equal(abandoned.ok, false);
  if (!abandoned.ok) assert.match(abandoned.message, /ABANDON/);

  const done = claimFence(held, { current_attempt: 1, current_owner: "m_me", task_state: "completed" });
  assert.equal(done.ok, false);
  if (!done.ok) assert.match(done.message, /already completed/);

  const stolen = claimFence(held, { current_attempt: 1, current_owner: "m_other", task_state: "working" });
  assert.equal(stolen.ok, false);
});

// ---------------------------------------------------------------- door two

test("door two's policy allows the run's surface and never carves it out", () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-fence-policy-"));
  const pack = path.join(root, "agents", "filer");
  const scratch = path.join(pack, "scratch", "run_1");
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(path.join(pack, "state"), { recursive: true });
  fs.mkdirSync(path.join(pack, "knowledge"), { recursive: true });
  fs.mkdirSync(path.join(root, ".rfa"), { recursive: true });
  try {
    const policy = sandboxPolicy({
      scratchDir: scratch,
      denyWrite: [path.join(pack, "state"), path.join(pack, "knowledge"), path.join(root, ".rfa"), pack],
    });
    assert.equal(policy.enabled, true);
    // Probe J: the default leaves the Bash tool's dangerouslyDisableSandbox
    // parameter live, and a model used it to write into the pack tree.
    assert.equal(policy.allowUnsandboxedCommands, false);
    assert.equal(policy.failIfUnavailable, true, "a host that loses its primitives must fail the query, not run it unfenced");
    assert.deepEqual(policy.filesystem.allowWrite, [fs.realpathSync(scratch)]);

    // The trap, measured as probe H case G: srt's model is allow-only and
    // denyWrite is a carve-out WITHIN it that beats allow, so naming the pack
    // tree would deny the scratch inside it. Any ancestor of the allow root is
    // dropped; the pack tree needs no deny because allow-only already refuses it.
    assert.equal(policy.filesystem.denyWrite.includes(fs.realpathSync(pack)), false, "an ancestor of the allow root would fence the run out of its own workspace");
    assert.deepEqual(policy.filesystem.denyWrite.sort(), [fs.realpathSync(path.join(pack, "knowledge")), fs.realpathSync(path.join(pack, "state")), fs.realpathSync(path.join(root, ".rfa"))].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A probe whose dependency checks pass; the establishment half is what each case varies. */
const healthyProbe = (): SandboxProbe => ({
  isSupportedPlatform: () => true,
  checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
  initialize: async () => {},
  wrapWithSandbox: async (cmd) => cmd,
});

test("the sandbox refusal is loud on every way it can be unavailable", async () => {
  const unsupported = await sandboxAvailable({ ...healthyProbe(), isSupportedPlatform: () => false });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.detail, /does not support/);

  // What bubblewrap missing inside an unprivileged container looks like: srt's
  // own dependency check reports it, and this platform refuses rather than
  // degrading to one door.
  const missing = await sandboxAvailable({
    ...healthyProbe(),
    checkDependenciesAsync: async () => ({ errors: ["bubblewrap (bwrap) is not installed"] }),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /bubblewrap/);

  // A check that THROWS is not a pass either: "we could not tell" and "it is
  // fenced" are different sentences and only one of them is safe to boot on.
  const threw = await sandboxAvailable({
    ...healthyProbe(),
    checkDependenciesAsync: async () => {
      throw new Error("something went wrong");
    },
  });
  assert.equal(threw.ok, false);
  assert.match(threw.detail, /could not be established/);

  /**
   * The case the dependency checks CANNOT see, and the reason the establishment
   * step exists at all. Measured 2026-08-26 (probe K): inside an
   * already-sandboxed macOS context `isSupportedPlatform()` returns true and
   * `checkDependenciesAsync()` returns zero errors, and the first wrapped command
   * then dies on a nested `sandbox-exec`.
   */
  const nested = await sandboxAvailable(healthyProbe(), () => ({ ok: false, detail: "sandbox-exec: nested sandboxes are not permitted" }));
  assert.equal(nested.ok, false);
  assert.match(nested.detail, /a sandboxed command could not run/);
  assert.match(nested.detail, /ALREADY-SANDBOXED/, "the message has to name the cause an operator will actually be in");

  // And the inverse failure, which the positive half alone would pass: a sandbox
  // that establishes and then permits everything.
  const permissive = await sandboxAvailable(healthyProbe(), (cmd) => {
    // Both writes "succeed": the witness lands and so does the canary.
    const m = /echo (?:ok|x) > "([^"]+)"/.exec(cmd);
    if (m) fs.writeFileSync(m[1], "x");
    return { ok: true, detail: "" };
  });
  assert.equal(permissive.ok, false);
  assert.match(permissive.detail, /wrote OUTSIDE its allowWrite root/);

  // The whole thing passing: the witness lands, the canary does not.
  const fine = await sandboxAvailable(healthyProbe(), (cmd) => {
    const m = /echo ok > "([^"]+)"/.exec(cmd);
    if (m) {
      fs.writeFileSync(m[1], "ok");
      return { ok: true, detail: "" };
    }
    return { ok: false, detail: "operation not permitted" };
  });
  assert.equal(fine.ok, true);
  assert.equal(fine.detail, "established");
});

test("the real sandbox runtime answers on this host, whatever the answer is", async () => {
  // Not an assertion that the sandbox IS available: on a host where it is not,
  // the correct behaviour is a refusal, and this pins that the check returns a
  // verdict with a reason instead of throwing out of the boot path. It also
  // exercises the real establishment step, so a host that cannot sandbox says so
  // here rather than at a resident's first turn.
  const check = await sandboxAvailable();
  assert.equal(typeof check.ok, "boolean");
  assert.ok(check.detail.length > 0);
});

// ---------------------------------------------------------------- the startup deny probe

/** A fake `query` that plays one scripted outcome, so the probe's verdicts are testable without a model. */
function fakeQuery(script: { calls: boolean; intercept: boolean; write?: (dir: string) => void }) {
  return (input: { prompt: string; options: Record<string, unknown> }) => {
    const dir = String(input.options.cwd);
    const tool = (input.options.tools as string[])[0];
    return (async function* () {
      if (script.calls) {
        if (script.intercept) {
          await (input.options.canUseTool as (t: string, i: unknown) => Promise<unknown>)(tool, {});
        }
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: tool }] } } as Record<string, unknown>;
        script.write?.(dir);
      }
      yield { type: "result", total_cost_usd: 0.0011 } as Record<string, unknown>;
    })();
  };
}

test("the deny probe passes only when the callback actually fired", async () => {
  const ok = await probeGuardedBuiltin("Write", { query: fakeQuery({ calls: true, intercept: true }), attempts: 1 });
  assert.equal(ok.verdict, "intercepted");
  assert.equal(probeIsFatal(ok), false);
  assert.ok(ok.costUsd > 0, "the probe costs money and says so");
});

test("a built-in that writes without reaching the callback fails the boot", async () => {
  const bypassed = await probeGuardedBuiltin("Write", {
    query: fakeQuery({ calls: true, intercept: false, write: (dir) => fs.writeFileSync(path.join(dir, "note.txt"), "hello\n") }),
    attempts: 1,
  });
  assert.equal(bypassed.verdict, "bypassed");
  assert.equal(probeIsFatal(bypassed), true);
  assert.match(bypassed.detail, /no longer routes it through the callback/);
});

test("a probe the model ignored is INCONCLUSIVE, and inconclusive fails closed", async () => {
  const quiet = await probeGuardedBuiltin("Edit", { query: fakeQuery({ calls: false, intercept: false }), attempts: 2 });
  assert.equal(quiet.verdict, "inconclusive");
  assert.equal(quiet.attempts, 2, "it retries before giving up, because a model that did not feel like calling a tool is not a regression");
  assert.equal(probeIsFatal(quiet), true, "'we could not tell' is not 'it is fenced'");
});

test("a probe whose query throws, or hangs, fails closed rather than passing", async () => {
  const threw = await probeGuardedBuiltin("Write", {
    query: () =>
      (async function* () {
        throw new Error("the SDK could not start");
      })(),
    attempts: 1,
  });
  assert.equal(threw.verdict, "inconclusive");
  assert.match(threw.detail, /the probe itself failed/);

  const hung = await probeGuardedBuiltin("Write", {
    query: () =>
      (async function* () {
        await new Promise((r) => setTimeout(r, 10_000));
        yield {} as Record<string, unknown>;
      })(),
    attempts: 1,
    timeoutMs: 60,
  });
  assert.equal(hung.verdict, "inconclusive");
  assert.match(hung.detail, /timed out/);
});

test("the probe runs the resident's own configuration, or it proves something else", async () => {
  let seen: Record<string, unknown> = {};
  await probeGuardedBuiltin("Edit", {
    query: (input) => {
      seen = input.options;
      return (async function* () {
        yield { type: "result", total_cost_usd: 0 } as Record<string, unknown>;
      })();
    },
    attempts: 1,
    permissionMode: "default",
  });
  assert.deepEqual(seen.tools, ["Edit", "Read"], "the guarded tool is in the base tool set");
  assert.deepEqual(seen.allowedTools, ["Read"], "and never bare in allowedTools, which is the configuration under test");
  assert.deepEqual(seen.settingSources, [], "no settings file, so a probe machine's allow rules cannot make the probe pass");
  assert.deepEqual(seen.settings, { disableClaudeAiConnectors: true });
});

test("only the guarded built-ins a pack declares are probed", () => {
  assert.deepEqual(guardedToProbe(["Read", "Grep", "Edit"]), ["Edit"]);
  assert.deepEqual(guardedToProbe(["Write", "NotebookEdit", "Bash"]), ["Write", "NotebookEdit"]);
  assert.deepEqual(guardedToProbe(["Read"]), [], "a read-only pack pays nothing at boot");
});
