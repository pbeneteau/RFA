/**
 * Starting the hub and the supervisor as daemons, and being able to name and
 * stop them afterwards (RFA-0.7 sect. 2.6).
 *
 * A daemon is a detached process group (src/proc.ts) with its stdio on a log
 * file and a pid record under `.rfa/run/`. The record is never trusted alone:
 * liveness is `kill(pid, 0)`, and a record whose process is gone is reported as
 * stale and cleaned up, never as running. Stopping signals the GROUP, because a
 * supervisor's residents and a resident's `claude` child are descendants a
 * pid-directed signal would orphan (119 orphaned hubs, 2026-08-19).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { writeJsonAtomic } from "./hubdir.js";
import { entryFor, nodeArgsFor, spawnEntry } from "./proc.js";

export interface PidRecord {
  name: string;
  pid: number;
  pgid: number;
  started_at: string;
  dir: string;
  port?: number;
}

export interface DaemonState {
  record: PidRecord | null;
  /** The recorded pid answers `kill(pid, 0)`. */
  alive: boolean;
  /** A record exists and its process does not. */
  stale: boolean;
}

export function readPidFile(file: string): PidRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PidRecord;
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and belongs to someone else. Still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function daemonState(pidFile: string): DaemonState {
  const record = readPidFile(pidFile);
  if (!record) return { record: null, alive: false, stale: false };
  const isAlive = alive(record.pid);
  return { record, alive: isAlive, stale: !isAlive };
}

export class DaemonError extends Error {
  constructor(
    message: string,
    readonly logTail: string[] = [],
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export function logTail(file: string, lines = 12): string[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Start an entry as a daemon and wait until `ready` says so.
 *
 * On a failure to become ready the process is stopped (the whole group), the
 * pid file removed, and the error carries the log's last lines: a daemon that
 * died at boot must say why in the same breath.
 */
export async function startDaemon(opts: {
  name: string;
  /** A sibling of this module: `main` (the hub) or `supervisor`. */
  entry: "main" | "supervisor";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  pidFile: string;
  port?: number;
  ready: () => Promise<boolean>;
  readyTimeoutMs?: number;
}): Promise<PidRecord> {
  const current = daemonState(opts.pidFile);
  if (current.alive) throw new DaemonError(`${opts.name} is already running (pid ${current.record!.pid})`);
  if (current.stale) fs.rmSync(opts.pidFile, { force: true });
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
  fs.mkdirSync(path.dirname(opts.pidFile), { recursive: true });
  const fd = fs.openSync(opts.logFile, "a");
  fs.writeSync(fd, `\n--- ${opts.name} started ${new Date().toISOString()} by rfa (pid ${process.pid}) ---\n`);
  const proc = spawnEntry(import.meta.url, opts.entry, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  proc.unref();
  if (proc.pid === undefined) throw new DaemonError(`${opts.name} could not be spawned`);
  const record: PidRecord = { name: opts.name, pid: proc.pid, pgid: proc.pid, started_at: new Date().toISOString(), dir: opts.cwd, ...(opts.port ? { port: opts.port } : {}) };
  writeJsonAtomic(opts.pidFile, record, 0o600);
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (exited) break;
    if (await opts.ready()) {
      // The parent must not keep the child's exit event (or anything else) alive.
      proc.removeAllListeners("exit");
      return record;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const tail = logTail(opts.logFile);
  try {
    process.kill(-record.pgid, "SIGKILL");
  } catch {
    /* already gone */
  }
  fs.rmSync(opts.pidFile, { force: true });
  throw new DaemonError(exited ? `${opts.name} exited during startup` : `${opts.name} did not become ready in ${Math.round((opts.readyTimeoutMs ?? 15_000) / 1000)}s`, tail);
}

/** SIGTERM the group, wait, SIGKILL the group, remove the record. */
export async function stopDaemon(pidFile: string, graceMs = 10_000): Promise<"stopped" | "not_running" | "stale"> {
  const state = daemonState(pidFile);
  if (!state.record) return "not_running";
  if (!state.alive) {
    fs.rmSync(pidFile, { force: true });
    return "stale";
  }
  const { pid, pgid } = state.record;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pgid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && alive(pid)) await new Promise((r) => setTimeout(r, 100));
  // Unconditional, like stopTree: the leader exiting does not mean its descendants did.
  signal("SIGKILL");
  fs.rmSync(pidFile, { force: true });
  return "stopped";
}

/**
 * Run an entry in the foreground with inherited stdio, forwarding SIGINT and
 * SIGTERM, and resolve with its exit code: what `rfa hub run` and
 * `rfa supervisor run` are, and what a service manager runs.
 */
export function runForeground(entry: "main" | "supervisor" | "evals/runner", args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<number> {
  const script = entryFor(import.meta.url, entry);
  const child = spawn(process.execPath, [...nodeArgsFor(script), ...args], { cwd: opts.cwd, env: opts.env, stdio: "inherit" });
  const forward = (sig: NodeJS.Signals) => () => {
    try {
      child.kill(sig);
    } catch {
      /* gone */
    }
  };
  const onInt = forward("SIGINT");
  const onTerm = forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}
