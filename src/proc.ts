/**
 * Spawning a long-lived child process, and actually being able to stop it.
 *
 * `npx tsx x.ts` is THREE processes: the npm wrapper, the tsx shim, and the node
 * process that runs the code. Signals do not reach the bottom of that stack
 * reliably, and the difference is not cosmetic (all three measured here on
 * 2026-08-19):
 *
 *   - SIGTERM on the npm wrapper IS forwarded down, so an ordinary drain works.
 *   - SIGKILL cannot be forwarded by anything, so killing the wrapper leaves the
 *     real process alive holding its port and its memory.
 *   - Killing the tsx shim directly is not enough either: tsx spawns its own
 *     node child, which survives.
 *
 * What that cost: 119 orphaned test hubs were found alive on this machine, the
 * oldest three days old, holding 5.3 GB and pushing the laptop 8 GB into swap.
 * Every hub-spawning test had killed the wrapper and believed it had cleaned up.
 * Worse, the same shape was in the supervisor, whose drain escalates to SIGKILL
 * after a timeout: a resident that missed its drain deadline would keep running
 * and keep serving its membership while the supervisor recorded it as dead and
 * started a replacement. That is the duplicate-resident incident's second route.
 *
 * Two things fix it, and both are needed:
 *
 *   1. `node --import tsx <script>` instead of `npx tsx <script>`: ONE process
 *      rather than three, so there is no wrapper to lose a signal in. Measured:
 *      one pid, and SIGKILL on it leaves nothing behind.
 *   2. Signal the process GROUP rather than the pid. A resident spawns the Agent
 *      SDK's `claude` binary as a child of its own, so even a single-process
 *      wrapper has descendants that a pid-directed SIGKILL would orphan.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spawn a TypeScript entrypoint as its own process group.
 *
 * `detached` is what makes the group: the child becomes a group leader whose
 * pgid equals its pid, which is what lets `stopTree` signal every descendant.
 * It also means the child no longer receives the terminal's Ctrl-C directly, so
 * a caller that spawns must also stop: every caller here has an explicit
 * shutdown path that drains its children (the supervisor handles SIGINT and
 * SIGTERM; the tests and the e2e script stop theirs in a finally).
 */
export function spawnTsx(script: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", script, ...args], { ...opts, detached: true });
}

/**
 * Signal a whole process group, tolerating the races that make this fiddly.
 *
 * A negative pid addresses the group. ESRCH means the group is already empty,
 * which is success, not failure: it is the normal outcome of stopping a child
 * that had already exited.
 */
export function signalTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    // Not a group leader (spawned without `detached`), or no permission: fall
    // back to the pid so a caller is never left with no way to stop a child.
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Stop a child and everything it spawned: SIGTERM the group, wait for the
 * leader to exit, then SIGKILL the group.
 *
 * The final SIGKILL is unconditional rather than only-on-timeout, because the
 * leader exiting does NOT mean its descendants did, and a descendant holding a
 * port is exactly the failure this module exists to prevent. Killing an empty
 * group is a no-op (ESRCH, handled above).
 */
export async function stopTree(proc: ChildProcess, graceMs = 5_000): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    signalTree(proc, "SIGKILL");
    return;
  }
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  signalTree(proc, "SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
  signalTree(proc, "SIGKILL");
}

/**
 * A sibling entry module of the CALLING module, by the caller's own extension.
 *
 * `entryFor(import.meta.url, "resident")` is `src/resident.ts` when the caller
 * runs under tsx and `dist/resident.js` when it runs built, so the supervisor
 * never has to know which it is. `tsx` is a devDependency: the published package
 * contains compiled JavaScript only, and a hard-coded `src/resident.ts` with
 * `--import tsx` was the line that made a published package unable to start a
 * resident at all.
 */
export function entryFor(callerUrl: string, name: string): string {
  const file = fileURLToPath(callerUrl);
  return path.join(path.dirname(file), `${name}${path.extname(file)}`);
}

/**
 * The node arguments that run an entry: the built `.js` directly, a `.ts` entry
 * through tsx's loader by its ABSOLUTE path.
 *
 * Not `--import tsx`: a bare specifier on `--import` is resolved from the
 * process's working directory, and the supervisor now starts residents with the
 * hub directory as their cwd, where there is no node_modules. Measured on the
 * first live run of v0.7: every resident died at boot with "Cannot find package
 * 'tsx' imported from <hub directory>/", and the supervisor crash-looped it. The
 * loader is resolved from THIS module's location instead, which is where the
 * tool's dependencies are.
 */
export function nodeArgsFor(script: string): string[] {
  if (!script.endsWith(".ts")) return [script];
  return ["--import", fileURLToPath(import.meta.resolve("tsx")), script];
}

/** Spawn a sibling entry (see `entryFor`) as its own process group, exactly like `spawnTsx`. */
export function spawnEntry(callerUrl: string, name: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const script = entryFor(callerUrl, name);
  return spawn(process.execPath, [...nodeArgsFor(script), ...args], { ...opts, detached: true });
}
