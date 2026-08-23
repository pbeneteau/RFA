/**
 * The lifecycle (RFA-0.7 sect. 2.6 and 3.1): `up`, `down`, `restart`,
 * `status`, `logs`, `console`, and the foreground forms `hub run` and
 * `supervisor run` that a service manager runs.
 *
 * `rfa up` is for a laptop session; nothing restarts the supervisor itself if it
 * dies. `rfa service install` is for a box that reboots. The first `up` says so.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { listPacks } from "../../agentdef.js";
import { daemonState, DaemonError, runForeground, startDaemon, stopDaemon, logTail } from "../../daemon.js";
import { minimalEnv } from "../../env.js";
import { ensureRuntime, roomsStore, type HubDir } from "../../hubdir.js";
import { belongsTo, residentProcesses } from "../../procscan.js";
import { CliError, type CliContext } from "../context.js";
import { effectiveMode } from "../../posture.js";
import { nativeBindingProblem } from "../preflight.js";
import type { CommandDef } from "../router.js";
import { fmtAge, fmtDuration } from "../ui.js";

/** What a daemon inherits: the allowlist (so residents get the model credential) plus the directory. */
export function daemonEnv(ctx: CliContext, h: HubDir): NodeJS.ProcessEnv {
  return { ...minimalEnv(ctx.env), RFA_DIR: h.root, ...(ctx.env.RFA_HUB_URL ? { RFA_HUB_URL: ctx.env.RFA_HUB_URL } : {}) };
}

async function startHub(ctx: CliContext, h: HubDir): Promise<{ started: boolean; pid: number }> {
  const state = daemonState(h.paths.hubPid);
  if (state.alive && (await ctx.healthz())) return { started: false, pid: state.record!.pid };
  if (!("port" in h.manifest.hub)) throw new CliError(3, "this directory hosts agents for a hub elsewhere; there is no hub to start here", `the hub is ${h.hubUrl}`);
  const rec = await startDaemon({
    name: "hub",
    entry: "main",
    args: ["--dir", h.root],
    cwd: h.root,
    env: daemonEnv(ctx, h),
    logFile: h.paths.hubLog,
    pidFile: h.paths.hubPid,
    port: h.manifest.hub.port,
    ready: () => ctx.healthz(800),
    readyTimeoutMs: 20_000,
  });
  return { started: true, pid: rec.pid };
}

async function startSupervisor(ctx: CliContext, h: HubDir): Promise<{ started: boolean; pid: number }> {
  const state = daemonState(h.paths.supervisorPid);
  if (state.alive) return { started: false, pid: state.record!.pid };
  const since = Date.now();
  const rec = await startDaemon({
    name: "supervisor",
    entry: "supervisor",
    args: ["--dir", h.root],
    cwd: h.root,
    env: daemonEnv(ctx, h),
    logFile: h.paths.supervisorLog,
    pidFile: h.paths.supervisorPid,
    ready: async () => {
      try {
        return fs.statSync(h.paths.supervisorState).mtimeMs >= since - 1000;
      } catch {
        return false;
      }
    },
    readyTimeoutMs: 20_000,
  });
  return { started: true, pid: rec.pid };
}

/** Start what the directory runs. Exported for `init`. */
export async function upAll(ctx: CliContext, opts: { only?: "hub" | "supervisor" } = {}): Promise<{ hub: { started: boolean; pid: number } | null; supervisor: { started: boolean; pid: number } | null }> {
  const h = ctx.hubdir();
  ensureRuntime(h);
  const binding = nativeBindingProblem();
  if (binding) throw new CliError(3, binding.message, binding.hint);
  const ui = ctx.ui;
  let hub: { started: boolean; pid: number } | null = null;
  let supervisor: { started: boolean; pid: number } | null = null;
  try {
    if (h.mode === "hub" && opts.only !== "supervisor") {
      hub = await startHub(ctx, h);
      const url = `http://127.0.0.1:${"port" in h.manifest.hub ? h.manifest.hub.port : 0}`;
      ui.done(hub.started ? `hub          pid ${hub.pid}   ${url}` : `hub          already running (pid ${hub.pid})   ${url}`, hub.started ? "console at /console" : undefined);
    }
    if (opts.only !== "hub") {
      const packs = listPacks(h.paths.agents).length;
      supervisor = await startSupervisor(ctx, h);
      ui.done(supervisor.started ? `supervisor   pid ${supervisor.pid}   ${packs} agent${packs === 1 ? "" : "s"}` : `supervisor   already running (pid ${supervisor.pid})`);
    }
  } catch (err) {
    if (err instanceof DaemonError) {
      throw new CliError(1, err.message, err.logTail.length ? `log tail:\n     ${err.logTail.join("\n     ")}` : `see ${h.paths.logs}`);
    }
    throw err;
  }
  return { hub, supervisor };
}

export const up: CommandDef = {
  path: ["up"],
  summary: "Start the hub and the supervisor as daemons",
  why: "Two detached process groups with their output in .rfa/logs/ and their pids in .rfa/run/. `rfa status` names them and `rfa down` stops them, which is what the old stance of starting nothing was protecting. Nothing restarts the supervisor itself if it dies: that is `rfa service install`, for a box that reboots.",
  options: { only: { type: "string" } },
  examples: ["rfa up", "rfa up --only hub"],
  run: async (ctx, a) => {
    const only = a.values.only as "hub" | "supervisor" | undefined;
    if (only && only !== "hub" && only !== "supervisor") throw new CliError(2, `--only takes hub or supervisor, not ${only}`);
    const res = await upAll(ctx, { only });
    if (ctx.flags.json) ctx.ui.json(res);
    else if (res.hub?.started || res.supervisor?.started) ctx.ui.note("rfa status shows what is running; rfa logs hub -f follows the hub; rfa service install keeps it up across reboots.");
  },
};

/** Stop both, supervisor first so it drains its residents. Exported for `init` on failure and for `restart`. */
export async function downAll(ctx: CliContext): Promise<{ supervisor: string; hub: string; strays: string[] }> {
  const h = ctx.hubdir();
  const supervisor = await stopDaemon(h.paths.supervisorPid, 25_000);
  const hub = await stopDaemon(h.paths.hubPid, 10_000);
  // A resident the supervisor did not own (it died, a previous drain missed) is
  // the duplicate-identity incident waiting to recur; name it, never kill it
  // blind: it may belong to another directory's supervisor. Residents live in
  // their own process groups and take a moment to exit after the supervisor's
  // drain, so only what is still alive after a short wait is a stray (the first
  // live run reported two residents that were gone a second later).
  let strays = await strayResidents(h);
  for (let i = 0; i < 10 && strays.length > 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    strays = await strayResidents(h);
  }
  return { supervisor, hub, strays };
}

async function strayResidents(h: HubDir): Promise<string[]> {
  const names = new Set(listPacks(h.paths.agents).map((p) => p.name));
  if (names.size === 0) return [];
  return (await residentProcesses()).filter((p) => names.has(p.agent) && belongsTo(p, h.root)).map((p) => `${p.pid} ${p.agent}`);
}

export const down: CommandDef = {
  path: ["down"],
  summary: "Stop the hub and the supervisor",
  why: "The supervisor goes first and drains its residents (SIGTERM, wait, SIGKILL the whole group), then the hub. A resident still alive afterwards is reported by pid and never killed blind, because it may be another directory's.",
  run: async (ctx) => {
    const res = await downAll(ctx);
    const say = (name: string, r: string) => {
      if (r === "stopped") ctx.ui.done(`${name} stopped`);
      else if (r === "stale") ctx.ui.done(`${name} was not running`, "stale pid file removed");
      else ctx.ui.step(`${name} was not running`);
    };
    say("supervisor", res.supervisor);
    say("hub", res.hub);
    for (const s of res.strays) ctx.ui.warn(`a resident is still running that this supervisor did not own: pid ${s}`, "stop it by hand, or `rfa agent retire <name>` if it is stale");
    if (ctx.flags.json) ctx.ui.json(res);
  },
};

export const restart: CommandDef = {
  path: ["restart"],
  summary: "Stop, then start",
  run: async (ctx) => {
    await downAll(ctx);
    await upAll(ctx);
  },
};

// ---------------------------------------------------------------- status

interface SupervisorStateFile {
  ts?: string;
  pid?: number;
  agents?: Record<string, { pid: number | null; status: string; started_at: string | null; definition_hash: string; restarts_in_window: number }>;
  account?: { cap?: number; in_flight?: number; paused_until?: string | null; pause_reason?: string | null };
}

function readLockHeartbeat(h: HubDir): { age_ms: number; pid: number | null } | null {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(h.paths.data, ".hub.lock"), "utf8")) as { heartbeat?: number; startedAt?: number; pid?: number };
    const beat = rec.heartbeat ?? rec.startedAt ?? 0;
    return { age_ms: Date.now() - beat, pid: rec.pid ?? null };
  } catch {
    return null;
  }
}

export async function collectStatus(ctx: CliContext): Promise<Record<string, unknown>> {
  const h = ctx.hubdir();
  const hubState = daemonState(h.paths.hubPid);
  const healthy = await ctx.healthz();
  const lock = readLockHeartbeat(h);
  const supState = daemonState(h.paths.supervisorPid);
  let supFile: SupervisorStateFile | null = null;
  try {
    supFile = JSON.parse(fs.readFileSync(h.paths.supervisorState, "utf8")) as SupervisorStateFile;
  } catch {
    supFile = null;
  }
  const packs = listPacks(h.paths.agents).map((p) => {
    const hb = path.join(p.dir, "state", "heartbeat");
    const hbAge = fs.existsSync(hb) ? Date.now() - Number(fs.readFileSync(hb, "utf8")) : null;
    let member: { room?: string; spend?: { day: string; usd: number } } | null = null;
    try {
      member = JSON.parse(fs.readFileSync(path.join(p.dir, "state", "member.json"), "utf8"));
    } catch {
      member = null;
    }
    const today = new Date().toISOString().slice(0, 10);
    return {
      name: p.name,
      model: p.def.model ?? "inherit",
      room: (p.def.rooms ?? [])[0]?.room ?? member?.room ?? null,
      offers: (p.def.offers ?? []).map((o) => o.id),
      mode: effectiveMode(p.def),
      definition: p.definitionHash.slice(7, 15),
      supervisor: supFile?.agents?.[p.name] ?? null,
      heartbeat_age_ms: hbAge,
      spend_today_usd: member?.spend?.day === today ? member.spend.usd : 0,
    };
  });
  let rooms: Record<string, unknown>[] = [];
  let roomsSource: "hub" | "file" = "file";
  const recorded = roomsStore(h).read().rooms;
  if (healthy && ctx.humanKey()) {
    try {
      rooms = (await ctx.workbench<Record<string, unknown>[]>("/api/rooms")).map((r) => ({ ...r, alias: r.alias ?? recorded.find((x) => x.handle === r.handle)?.alias ?? null }));
      roomsSource = "hub";
    } catch {
      rooms = [];
    }
  }
  if (roomsSource === "file") rooms = recorded.map((r) => ({ alias: r.alias, handle: r.handle, topic: r.topic }));
  return {
    name: h.manifest.name,
    dir: h.root,
    mode: h.mode,
    hub_url: h.hubUrl,
    hub: { running: hubState.alive, healthy, pid: hubState.record?.pid ?? null, stale_pid_file: hubState.stale, started_at: hubState.record?.started_at ?? null, lock_heartbeat_age_ms: lock?.age_ms ?? null },
    supervisor: {
      running: supState.alive,
      pid: supState.record?.pid ?? null,
      stale_pid_file: supState.stale,
      started_at: supState.record?.started_at ?? null,
      state_age_ms: supFile?.ts ? Date.now() - Date.parse(supFile.ts) : null,
      account: supFile?.account ?? null,
    },
    agents: packs,
    rooms,
    rooms_source: roomsSource,
  };
}

export const status: CommandDef = {
  path: ["status"],
  summary: "What is running: hub, supervisor, agents, rooms",
  why: "One screen that answers the question every session eventually asked: is the thing that looks healthy actually able to work. A pid file is never trusted alone; the hub is asked (/healthz) and the lock heartbeat is read; the supervisor's state file and every resident's heartbeat are aged.",
  run: async (ctx) => {
    const s = await collectStatus(ctx);
    if (ctx.flags.json) return void ctx.ui.json(s);
    const ui = ctx.ui;
    const hub = s.hub as { running: boolean; healthy: boolean; pid: number | null; stale_pid_file: boolean; started_at: string | null; lock_heartbeat_age_ms: number | null };
    const sup = s.supervisor as { running: boolean; pid: number | null; stale_pid_file: boolean; started_at: string | null; state_age_ms: number | null; account: { cap?: number; in_flight?: number; paused_until?: string | null } | null };
    ui.line(`${ui.bold(String(s.name))} · ${ui.dim(String(s.dir))}`);
    ui.blank();
    const hubLine = hub.healthy
      ? `${ui.good("●")} running   ${hub.pid ? `pid ${hub.pid}` : "not started by rfa"}   ${String(s.hub_url).replace(/\/mcp$/, "")}   ${ui.dim(`healthz ok · lock ${hub.lock_heartbeat_age_ms !== null && hub.lock_heartbeat_age_ms < 60_000 ? "fresh" : "stale"}${hub.started_at ? ` · up ${fmtDuration(Date.now() - Date.parse(hub.started_at))}` : ""}`)}`
      : hub.running
        ? `${ui.caution("●")} pid ${hub.pid} is alive but /healthz does not answer   ${ui.dim("rfa logs hub")}`
        : `${ui.dim("○")} not running${hub.stale_pid_file ? ui.dim("   (stale pid file)") : ""}   ${ui.dim(s.mode === "remote" ? `remote hub ${s.hub_url}` : "rfa up")}`;
    ui.line(`hub          ${hubLine}`);
    const supLine = sup.running
      ? `${ui.good("●")} running   pid ${sup.pid}   ${ui.dim(`account ${sup.account?.in_flight ?? 0}/${sup.account?.cap ?? "?"} in flight${sup.account?.paused_until ? ` · PAUSED until ${sup.account.paused_until}` : " · not paused"}${sup.started_at ? ` · up ${fmtDuration(Date.now() - Date.parse(sup.started_at))}` : ""}`)}`
      : `${ui.dim("○")} not running${sup.stale_pid_file ? ui.dim("   (stale pid file)") : ""}`;
    ui.line(`supervisor   ${supLine}`);
    ui.blank();
    const agents = s.agents as { name: string; model: string; room: string | null; definition: string; supervisor: { status: string } | null; heartbeat_age_ms: number | null; spend_today_usd: number }[];
    ui.line("agents");
    if (agents.length === 0) ui.note("none yet: rfa agent new <name>");
    else
      ui.table(
        agents.map((a) => {
          const st = a.supervisor?.status ?? (sup.running ? "unknown" : "not supervised");
          const dot = st === "running" && a.heartbeat_age_ms !== null && a.heartbeat_age_ms < 240_000 ? ui.good("●") : st === "running" ? ui.caution("●") : ui.dim("○");
          const roomAlias = (s.rooms as { alias?: string | null; handle: string }[]).find((r) => r.handle === a.room)?.alias ?? a.room ?? "-";
          return [dot, a.name, st, roomAlias, a.model, `$${a.spend_today_usd.toFixed(2)} today`, a.heartbeat_age_ms === null ? "no heartbeat" : `heartbeat ${fmtAge(Date.now() - a.heartbeat_age_ms)}`, ui.dim(`def ${a.definition}`)];
        }),
      );
    ui.blank();
    ui.line(`rooms${s.rooms_source === "file" ? ui.dim("   (from rooms.json; the hub is not answering or no human key)") : ""}`);
    const rooms = s.rooms as Record<string, unknown>[];
    if (rooms.length === 0) ui.note("none yet: rfa room create <alias>");
    else
      ui.table(
        rooms.map((r) =>
          s.rooms_source === "hub"
            ? [String(r.alias ?? "-"), String(r.handle), `${r.online}/${r.members} online`, `${r.guests} guest${r.guests === 1 ? "" : "s"}`, `${r.open_tasks} open task${r.open_tasks === 1 ? "" : "s"}`, Number(r.pending_approvals) > 0 ? ui.caution(`${r.pending_approvals} approval pending`) : "", r.ended ? ui.dim("ended") : ""]
            : [String(r.alias ?? "-"), String(r.handle), ui.dim(String(r.topic ?? ""))],
        ),
      );
  },
};

// ---------------------------------------------------------------- logs, console

export const logs: CommandDef = {
  path: ["logs"],
  summary: "Tail the hub, the supervisor or an agent",
  usage: "[hub|supervisor|<agent>] [-f] [-n <lines>]",
  options: { follow: { type: "boolean", short: "f", default: false }, lines: { type: "string", short: "n" } },
  examples: ["rfa logs hub -f", "rfa logs pm -n 100"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const which = a.positionals[0] ?? "hub";
    const file = which === "hub" ? h.paths.hubLog : which === "supervisor" ? h.paths.supervisorLog : path.join(h.paths.agents, which, "state", "resident.log");
    if (!fs.existsSync(file)) throw new CliError(3, `no log for ${which} yet (${path.relative(h.root, file)})`, which === "hub" || which === "supervisor" ? "rfa up starts it" : "the supervisor writes it once the agent starts");
    const n = Number(a.values.lines ?? 40);
    for (const line of logTail(file, Number.isFinite(n) ? n : 40)) process.stdout.write(line + "\n");
    if (!a.values.follow) return;
    let offset = fs.statSync(file).size;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        try {
          const size = fs.statSync(file).size;
          if (size > offset) {
            const fd = fs.openSync(file, "r");
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = size;
            process.stdout.write(buf.toString("utf8"));
          } else if (size < offset) offset = 0;
        } catch {
          /* rotated or gone: next tick */
        }
      }, 300);
      process.on("SIGINT", () => {
        clearInterval(timer);
        resolve();
      });
    });
  },
};

export const consoleCmd: CommandDef = {
  path: ["console"],
  summary: "Open the live room view in the browser",
  usage: "[--room <alias|handle>] [--no-open]",
  options: { room: { type: "string" }, open: { type: "boolean", default: true } },
  why: "The console is a plain MCP client in one static page, served by the hub. Observer is read-only; unlocking it with your human key gives the intervention buttons, approve and reject, and the inject box. The key is pasted into the page, never put in a URL.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const base = ("port" in h.manifest.hub && h.manifest.hub.public_url) || ctx.hubBase();
    let fragment = "";
    if (a.values.room) {
      const rec = roomsStore(h).read().rooms.find((r) => r.alias === a.values.room || r.handle === a.values.room);
      fragment = `#${rec?.handle ?? String(a.values.room)}`;
    }
    const url = `${base}/console${fragment}`;
    if (ctx.flags.json) return void ctx.ui.json({ url });
    ctx.ui.line(url);
    if (a.values.open && ctx.ui.opts.tty) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      execFile(opener, [url], () => {});
    }
  },
};

// ---------------------------------------------------------------- foreground forms

export const hubRun: CommandDef = {
  path: ["hub", "run"],
  summary: "Run the hub in the foreground (what a service manager runs)",
  usage: "[--stdio]",
  options: { stdio: { type: "boolean", default: false } },
  why: "Everything comes from rfa.json and the .rfa/ credential files; no secret is on the command line. --stdio serves MCP on stdin/stdout instead of HTTP, for an MCP host that wants an ephemeral hub of its own (use --data none there, or it contends for the store lock with the daemon).",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    ensureRuntime(h);
    const code = await runForeground("main", ["--dir", h.root, ...(a.values.stdio ? ["--stdio", "--data", "none"] : [])], { cwd: h.root, env: daemonEnv(ctx, h) });
    process.exitCode = code;
  },
};

export const supervisorRun: CommandDef = {
  path: ["supervisor", "run"],
  summary: "Run the supervisor in the foreground (what a service manager runs)",
  run: async (ctx) => {
    const h = ctx.hubdir();
    ensureRuntime(h);
    const code = await runForeground("supervisor", ["--dir", h.root], { cwd: h.root, env: daemonEnv(ctx, h) });
    process.exitCode = code;
  },
};
