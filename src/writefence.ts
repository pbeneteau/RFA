/**
 * The two-door write fence (RFA-0.8 sect. 9, rung 5), amending v0.4 sect. 3.12.
 *
 * A pack that declares a write-shaped built-in becomes eligible to run, and to
 * run concurrently, with every write confined to its own per-run scratch
 * surface. Two independent doors hold that line and neither is a substitute for
 * the other:
 *
 *   door one   the `canUseTool` callback, reached by FALL-THROUGH. It hosts the
 *              per-run path guard and the claim-fence attempt check. It is
 *              version-fragile by design (the SDK's built-in behaviour has
 *              already changed once across setups), so the resident re-proves it
 *              at every boot with a live deny probe rather than trusting a
 *              changelog. See `probeGuardedBuiltin` in `src/fenceprobe.ts`.
 *   door two   the OS sandbox, per RUN, through the SDK's own per-`query()`
 *              `sandbox` option. It is the ONLY door for Bash, because a Bash
 *              command's write set cannot be traced from its arguments.
 *
 * The design note is `docs/design/rung5-writefence.md`; the measurements behind
 * every constant here are probes F-J in
 * `research/05-concurrency/notes/07-live-probes.md`. Three of them are worth
 * carrying at the top of this file, because each one is a natural-looking
 * implementation that does not fence anything:
 *
 *  1. srt's write model is ALLOW-ONLY (`allowOnly = defaults + allowWrite`) and
 *     `denyWrite` is a carve-out WITHIN that set which beats it. Naming the pack
 *     tree in `denyWrite` therefore denies the scratch directory inside it. Sect.
 *     9's "denyWrite = the pack tree, the knowledge clones and `.rfa/`" must not
 *     be implemented literally; the pack tree is denied by construction.
 *  2. The CLI grants its own WORKING DIRECTORY. That, and not `allowWrite`, is
 *     what opens the scratch surface, which is why a fenced run's cwd IS its
 *     scratch directory.
 *  3. `allowUnsandboxedCommands` defaults to TRUE, leaving the Bash tool's
 *     `dangerouslyDisableSandbox` parameter live. Probe J watched a model hit
 *     "operation not permitted", set the parameter, and write into the pack tree
 *     on the retry. Every fenced query passes `false`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDef } from "./agentdef.js";

/**
 * The write-shaped built-ins this SDK offers (`sdk-tools.d.ts` on 0.3.233:
 * FileWriteInput, FileEditInput, NotebookEditInput; there is no MultiEdit).
 *
 * `Bash` is deliberately absent. Its write set cannot be traced from its
 * arguments even when the callback fires, so it belongs to door two alone;
 * refusing untraceable shapes rather than pretending to trace them is the
 * surveyed precedent (W5 sect. 2.2).
 */
export const GUARDED_BUILTINS = ["Write", "Edit", "NotebookEdit"] as const;
export type GuardedBuiltin = (typeof GUARDED_BUILTINS)[number];

/** Which input field each guarded built-in writes to. An unlisted one is refused, never allowed. */
const TARGET_FIELD: Record<GuardedBuiltin, string> = {
  Write: "file_path",
  Edit: "file_path",
  NotebookEdit: "notebook_path",
};

export function isGuardedBuiltin(tool: string): tool is GuardedBuiltin {
  return (GUARDED_BUILTINS as readonly string[]).includes(tool);
}

/** The guarded built-ins THIS pack declares: its declared write surface, tool by tool. */
export function guardedBuiltinsOf(def: Pick<AgentDef, "tools">): GuardedBuiltin[] {
  return (def.tools?.allow ?? []).filter(isGuardedBuiltin);
}

/**
 * Is this a WRITING pack?
 *
 * `agentPosture()` calls a pack `read-only` when `interrupt_on` names none of
 * its tools, so a pack declaring the built-in `Write` with no interrupt rule is
 * `read-only` by that definition and could write the whole hub directory - a
 * bare `allowedTools` entry auto-approves it before `canUseTool` is ever
 * consulted. Sect. 10 gate 1 needs the second predicate, and this is it.
 */
export function hasWriteSurface(def: Pick<AgentDef, "tools">): boolean {
  return guardedBuiltinsOf(def).length > 0;
}

/**
 * Permission modes that auto-approve BEFORE the callback, and so switch door one
 * off wholesale. `acceptEdits` is the one that matters most: it auto-accepts
 * exactly the two tools this door exists to intercept.
 */
export const SHADOWING_PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "dontAsk", "auto"] as const;

/**
 * The startup assert of sect. 9 item 1: a guarded built-in must sit in the SDK's
 * base `tools` set and NEVER bare in `allowedTools`, because the bare entry is
 * what turns the interception off. True by construction after this rung, so this
 * exists for the edit that breaks it.
 */
export function shadowingFailures(input: {
  guarded: readonly string[];
  allowedTools: readonly string[];
  permissionMode?: string;
}): string[] {
  const fails: string[] = [];
  const bare = input.allowedTools.filter((t) => input.guarded.includes(t));
  if (bare.length > 0) {
    fails.push(
      `${bare.join(", ")} ${bare.length === 1 ? "is" : "are"} listed bare in allowedTools: a bare entry auto-approves the whole tool ` +
        `before canUseTool is consulted, which is exactly what switches door one off (RFA-0.8 sect. 9 item 1)`,
    );
  }
  const mode = input.permissionMode;
  if (mode && (SHADOWING_PERMISSION_MODES as readonly string[]).includes(mode)) {
    fails.push(
      `sandbox.permission_mode is \`${mode}\`, which auto-approves before the callback (acceptEdits auto-accepts Write and Edit themselves); ` +
        `a pack with a declared write surface must run the default permission flow so its writes reach door one`,
    );
  }
  return fails;
}

/**
 * The tools named by a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning, or `[]`.
 *
 * The warning fires on EVERY resident query already, naming the MCP tools this
 * platform auto-approves on purpose, so "any warning is fatal" would be a boot
 * loop. What is fatal is an intersection with the guarded set, which is the case
 * the assert above cannot see: the warning's own last sentence says settings-file
 * allow rules shadow the callback invisibly.
 */
export function parseShadowWarning(message: string): string[] {
  const m = /canUseTool will not be invoked for:\s*([^.]+)\./.exec(message);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve a path the way the filesystem will, not the way a string comparison
 * would: realpath the nearest EXISTING ancestor and rejoin the remainder.
 *
 * Both halves matter. The file being written usually does not exist yet, so a
 * plain `realpathSync` throws; and a prefix comparison on unresolved paths is
 * what this repository has already paid for once, when a path climbed to the
 * filesystem root because the hub directory and an attached path sat on opposite
 * sides of the macOS `/var` -> `/private/var` symlink. A symlinked target inside
 * the scratch pointing at the pack tree resolves OUT of the surface here, and a
 * `../../` traversal is normalized away by `path.resolve` before that.
 */
export function realResolve(target: string, base: string): string {
  const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(base, target);
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      // The root does not exist? Nothing more to resolve; the normalized path is
      // the honest answer and the containment check below will refuse it.
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** Is `target` the directory `root` itself, or something under it? Both sides already resolved. */
export function contains(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

export type WriteTargets = { ok: true; paths: string[] } | { ok: false; reason: string };

/**
 * What one guarded call would write. A guarded built-in whose target field is
 * unknown is REFUSED and not allowed: an SDK that adds a fourth write-shaped
 * built-in must arrive as a loud refusal, never as a silent hole.
 */
export function writeTargets(toolName: string, input: unknown): WriteTargets {
  if (!isGuardedBuiltin(toolName)) return { ok: false, reason: `${toolName} is not a guarded built-in` };
  const field = TARGET_FIELD[toolName];
  const value = (input as Record<string, unknown> | null | undefined)?.[field];
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, reason: `${toolName} arrived without a usable ${field}, so what it would write cannot be established` };
  }
  return { ok: true, paths: [value] };
}

export type GuardVerdict = { allow: true; resolved: string[] } | { allow: false; message: string };

/**
 * Door one's per-run path guard: a write is allowed only under THIS run's
 * scratch surface, refused everywhere else.
 *
 * The refusal is written for the model to act on, because a fenced write that
 * comes back as "denied" and nothing else costs a turn and teaches nothing.
 */
export function pathGuard(input: { toolName: string; input: unknown; scratchDir: string }): GuardVerdict {
  const targets = writeTargets(input.toolName, input.input);
  if (!targets.ok) {
    return { allow: false, message: `write refused: ${targets.reason}. This run may only write under ${input.scratchDir}.` };
  }
  const root = realResolve(input.scratchDir, input.scratchDir);
  const resolved: string[] = [];
  for (const p of targets.paths) {
    const abs = realResolve(p, input.scratchDir);
    if (!contains(root, abs)) {
      return {
        allow: false,
        message:
          `write refused: ${p} is outside this run's writable surface. This run may write ONLY under ${input.scratchDir} ` +
          `(the path resolves to ${abs}; symlinks and \`..\` are resolved before the check). ` +
          `Put the file under ${input.scratchDir} instead, and say in your answer where you put it.`,
      };
    }
    resolved.push(abs);
  }
  return { allow: true, resolved };
}

// ---------------------------------------------------------------- the claim fence

/** What the run held when it started: the task's identity and the attempt it was working. */
export interface ClaimHeld {
  taskId: string;
  attempt: number;
  owner: string;
}

/** What the board says NOW. Sect. 2.4's `lease_expired` data, read locally. */
export interface ClaimNow {
  current_attempt: number;
  current_owner: string | null;
  task_state: string;
}

const TERMINAL_STATES = new Set(["completed", "cancelled", "failed", "rejected"]);

/**
 * The claim-fence check of sect. 9 item 1: a write whose task claim has moved to
 * attempt N+1 is refused, and the refusal distinguishes RE-CLAIM from ABANDON,
 * because those are different instructions to whoever reads it. The three-field
 * shape is the one sect. 2.4 names, which is why it is read rather than inferred
 * from an `unauthorized`.
 *
 * Scope, stated because rung 7 threads this same door later: the fence here is
 * on the TASK claim's attempt. Resource-keyed claims are rung 7 and are not
 * built.
 */
export function claimFence(held: ClaimHeld, now: ClaimNow): { ok: true } | { ok: false; message: string } {
  if (TERMINAL_STATES.has(now.task_state)) {
    return {
      ok: false,
      message:
        `write refused: task ${held.taskId} is already ${now.task_state}, so there is nothing left to write for. ` +
        `Stop, and report that the task closed while you were working it.`,
    };
  }
  if (now.current_attempt > held.attempt) {
    const who = now.current_owner ? `attempt ${now.current_attempt} belongs to ${now.current_owner}` : `attempt ${now.current_attempt} is unowned`;
    return {
      ok: false,
      message:
        `write refused: your claim on task ${held.taskId} was attempt ${held.attempt} and the board has moved on (${who}). ` +
        `This is a RE-CLAIM, not an abandon: someone else owns the work now. Stop and do not repeat it.`,
    };
  }
  if (now.current_owner === null) {
    return {
      ok: false,
      message:
        `write refused: your claim on task ${held.taskId} (attempt ${held.attempt}) has lapsed and the task is unowned. ` +
        `This is an ABANDON, not a re-claim: stop, and let the board hand it out again.`,
    };
  }
  if (now.current_owner !== held.owner) {
    return {
      ok: false,
      message:
        `write refused: task ${held.taskId} is owned by ${now.current_owner} now, not by you. Stop and report it.`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- door two

/** The subset of the SDK's `SandboxSettings` this platform sets, kept structural so the SDK type never leaks in here. */
export interface SandboxPolicy {
  /** The SDK's `SandboxSettings` is an open object; the index signature keeps this structural type assignable to it. */
  [key: string]: unknown;
  enabled: true;
  failIfUnavailable: true;
  allowUnsandboxedCommands: false;
  autoAllowBashIfSandboxed: true;
  filesystem: { allowWrite: string[]; denyWrite: string[] };
}

/**
 * Door two's policy for ONE run.
 *
 * `allowWrite` carries the scratch surface. It is belt and braces: probe G
 * measured that `allowWrite` alone does NOT open a path in the CLI, and the cwd
 * grant is what actually opens the scratch. It costs nothing and it is the right
 * declaration if the CLI's cwd behaviour ever changes.
 *
 * `denyWrite` carries sect. 8.1's never-reachable surfaces MINUS any entry that
 * is an ancestor of the allowWrite root. That filter is finding 1 at the top of
 * this file and is not an optimization: `denyWrite: [packTree]` with the scratch
 * inside the pack tree denies the scratch, which is a fence that fences the run
 * out of its own workspace.
 */
export function sandboxPolicy(input: { scratchDir: string; denyWrite: string[] }): SandboxPolicy {
  const scratch = realResolve(input.scratchDir, input.scratchDir);
  const deny: string[] = [];
  for (const d of input.denyWrite) {
    const abs = realResolve(d, scratch);
    // An ancestor of the allow root would carve the run out of its own surface
    // (deny beats allow, probe H case G). Dropped, not silently kept.
    if (contains(abs, scratch)) continue;
    deny.push(abs);
  }
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: { allowWrite: [scratch], denyWrite: deny },
  };
}

export interface SandboxCheck {
  ok: boolean;
  platform: string;
  detail: string;
}

/** Injectable so the refusal path is testable without a host that lacks the primitives. */
export interface SandboxProbe {
  isSupportedPlatform(): boolean;
  checkDependenciesAsync(): Promise<{ errors?: string[]; warnings?: string[] }>;
  initialize(config: unknown): Promise<void>;
  wrapWithSandbox(command: string, shell?: string): Promise<string>;
}

/** Injectable for the same reason: the establishment step has to actually RUN something. */
export type ShellRunner = (command: string) => { ok: boolean; detail: string };

/**
 * The shell the establishment check runs its two trivial commands through.
 *
 * NOT a hardcoded `/bin/zsh`: this runs at the startup of a resident that may be
 * on Linux, where zsh is usually absent, and the check failing for want of a
 * shell would refuse a boot on a host where the fence works perfectly well. Fail
 * closed is right when the fence cannot establish, not when this module cannot
 * find a shell.
 */
const CHECK_SHELL = ["/bin/zsh", "/bin/bash", "/bin/sh"].find((sh) => {
  try {
    return fs.existsSync(sh);
  } catch {
    return false;
  }
}) ?? "/bin/sh";

function runInShell(command: string): { ok: boolean; detail: string } {
  try {
    execFileSync(CHECK_SHELL, ["-c", command], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, detail: "" };
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    return { ok: false, detail: String(e.stderr ?? e.message ?? "").slice(0, 300) };
  }
}

/**
 * Can the OS sandbox establish itself on THIS host? (sect. 9 item 3.)
 *
 * The failure mode being avoided is the one Bazel ships: a sandbox that silently
 * falls back to no sandbox and reports success. So this is asked once at startup
 * and answered loudly, and `failIfUnavailable: true` on every query is the second
 * half for a host that changes under a running resident.
 *
 * The check is srt's own, deliberately: bubblewrap on Linux and Seatbelt on macOS
 * are its problem to detect, and re-deriving the answer here would be a second
 * opinion that can disagree with the thing actually doing the work.
 */
export async function sandboxAvailable(probe?: SandboxProbe, run: ShellRunner = runInShell): Promise<SandboxCheck> {
  let srt: SandboxProbe;
  if (probe) srt = probe;
  else {
    try {
      const mod = (await import("@anthropic-ai/sandbox-runtime")) as { SandboxManager: SandboxProbe };
      srt = mod.SandboxManager;
    } catch (err) {
      return { ok: false, platform: process.platform, detail: `@anthropic-ai/sandbox-runtime could not be loaded: ${(err as Error).message}` };
    }
  }
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-fence-check-"));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-fence-outside-"));
  try {
    if (!srt.isSupportedPlatform()) {
      return { ok: false, platform: process.platform, detail: `the sandbox runtime does not support ${process.platform}` };
    }
    const deps = await srt.checkDependenciesAsync();
    const errors = deps.errors ?? [];
    if (errors.length > 0) {
      return { ok: false, platform: process.platform, detail: `missing sandbox primitives: ${errors.join("; ")}` };
    }

    /**
     * The ESTABLISHMENT step, and it is not belt and braces: the two checks above
     * BOTH pass inside an already-sandboxed macOS context where nothing can
     * actually be sandboxed. Measured 2026-08-26 (probe K): inside a Seatbelt
     * sandbox, `isSupportedPlatform()` returns true and `checkDependenciesAsync()`
     * returns zero errors, and the first wrapped command then dies on a nested
     * `sandbox-exec`. Asking about dependencies is not the same question as "can
     * this host sandbox a command right now", and only the second one is the
     * fence's precondition. So a trivial command is wrapped and RUN, both ways.
     *
     * `network: {}` is deliberate: the fence asks srt for no network policy, and
     * an empty block leaves the proxy and its mux socket unstarted, so this check
     * leaves nothing running behind it in a long-lived resident.
     */
    await srt.initialize({ network: {}, filesystem: { allowWrite: [dir] } });
    const witness = path.join(dir, "fence-check.txt");
    const inside = run(await srt.wrapWithSandbox(`echo ok > ${JSON.stringify(witness)}`, CHECK_SHELL));
    if (!inside.ok || !fs.existsSync(witness)) {
      return {
        ok: false,
        platform: process.platform,
        detail:
          `the dependency check passed but a sandboxed command could not run` +
          (inside.detail ? ` (${inside.detail})` : "") +
          `. On macOS this is what an ALREADY-SANDBOXED context looks like: nested sandbox-exec is refused`,
      };
    }
    // The negative half, because a sandbox that permits everything would pass the
    // positive one: a write outside the allow root must be refused.
    const canary = path.join(outside, "canary.txt");
    const beyond = run(await srt.wrapWithSandbox(`echo x > ${JSON.stringify(canary)}`, CHECK_SHELL));
    if (beyond.ok || fs.existsSync(canary)) {
      return { ok: false, platform: process.platform, detail: `a sandboxed command wrote OUTSIDE its allowWrite root, so what established here does not fence anything` };
    }

    const warnings = deps.warnings ?? [];
    return { ok: true, platform: process.platform, detail: warnings.length > 0 ? `established (warnings: ${warnings.join("; ")})` : "established" };
  } catch (err) {
    return { ok: false, platform: process.platform, detail: `the sandbox could not be established: ${(err as Error).message}` };
  } finally {
    for (const d of [dir, outside]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* a check that cannot clean its own temp directory is not a reason to refuse a boot */
      }
    }
  }
}
