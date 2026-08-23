import * as path from "node:path";
import * as fs from "node:fs";
/**
 * Finding resident processes in the process table, strictly.
 *
 * Four places asked `ps` the same question ("is a resident for pack X
 * running?") and matched two substrings anywhere in a command line. Measured
 * 2026-08-22: a shell whose script mentioned `resident.ts` and `--agent
 * spec-expert` matched, the supervisor refused to start the real resident
 * ("ALREADY running as pid 63029, not mine"), and `rfa down` reported the same
 * shell as a stray. A resident is a node process whose script argument IS
 * `resident.ts` or `resident.js`, followed by `--agent <name>`; nothing else
 * counts, whatever its command line happens to say.
 */
import { execFile, execFileSync } from "node:child_process";

export interface ResidentProcess {
  pid: number;
  ppid: number | null;
  agent: string;
  /** The hub directory it was spawned for (`--dir`), null for a resident started before 0.7.1 spawned with it. */
  dir: string | null;
}

/** Parse `ps ax -o pid=,ppid=,command=` (or `pid=,command=`) output. */
export function parseResidentProcesses(psOutput: string, hasPpid = true): ResidentProcess[] {
  const out: ResidentProcess[] = [];
  for (const raw of psOutput.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pid = Number(parts[0]);
    const ppid = hasPpid ? Number(parts[1]) : null;
    const argv = parts.slice(hasPpid ? 2 : 1);
    if (!Number.isFinite(pid) || argv.length < 3) continue;
    const exe = argv[0];
    if (!(exe === "node" || exe.endsWith("/node"))) continue;
    // The script is the first non-flag argument after node's own options
    // (`--import <loader>` takes a value).
    let i = 1;
    while (i < argv.length && argv[i].startsWith("-")) {
      if (argv[i] === "--import" || argv[i] === "--loader" || argv[i] === "-r" || argv[i] === "--require") i += 2;
      else i += 1;
    }
    const script = argv[i];
    if (!script || !/(^|\/)resident\.(ts|js)$/.test(script)) continue;
    const at = argv.indexOf("--agent", i + 1);
    const agent = at >= 0 ? argv[at + 1] : undefined;
    if (!agent) continue;
    const dt = argv.indexOf("--dir", i + 1);
    const dir = dt >= 0 ? (argv[dt + 1] ?? null) : null;
    out.push({ pid, ppid: Number.isFinite(ppid as number) ? (ppid as number) : null, agent, dir });
  }
  return out;
}

export function residentProcessesSync(): ResidentProcess[] {
  try {
    return parseResidentProcesses(execFileSync("ps", ["ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" }));
  } catch {
    return []; // cannot enumerate: the caller proceeds rather than refusing
  }
}

export function residentProcesses(): Promise<ResidentProcess[]> {
  return new Promise((resolve) => execFile("ps", ["ax", "-o", "pid=,ppid=,command="], { encoding: "utf8" }, (_e, stdout) => resolve(parseResidentProcesses(stdout ?? ""))));
}

/**
 * Whether a resident belongs to this hub directory. Two hub directories on one
 * machine each run a `spec-expert`; a supervisor that matched on the name alone
 * refused to start its own (found live: the cold-start test failed because the
 * test project's resident was running). A resident spawned without `--dir`
 * (before 0.7.1) cannot say, and still counts.
 */
export function belongsTo(p: { dir: string | null }, root: string): boolean {
  if (p.dir === null) return true;
  const real = (f: string) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return path.resolve(f);
    }
  };
  return real(p.dir) === real(root);
}
