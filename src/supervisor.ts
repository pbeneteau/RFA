/**
 * Resident supervisor v0 (RFA v0.4 spec section 4.2): the one long-lived
 * process that owns every resident. launchd keeps THIS alive; this keeps the
 * residents alive.
 *
 *   rfa supervisor run            (or: node --import tsx src/supervisor.ts [--dir <hub directory>])
 *
 * - Registry = `<hub directory>/agents/<name>/agent.md` (re-listed every 30s, file-watched).
 * - Spawn policy is pm2's vocabulary: autorestart with exponential backoff
 *   (1s doubling, capped 60s), max_restarts within a crash-loop window,
 *   min_uptime to reset the counter, kill_timeout = SIGTERM drain then SIGKILL.
 * - Health: the resident heartbeat file, written by the same serve cycle that
 *   renews its presence lease, and by a keepalive timer while a long turn
 *   (tool run, approval wait) blocks the cycle. A wedged event loop stops
 *   both, so staleness still means wedged.
 * - A definition edit triggers a versioned drain: validate the new agent.md
 *   first (a broken edit must never kill a healthy resident), then SIGTERM,
 *   wait, respawn. The new card digest in the roster marks the deploy.
 * - v0.5.2: it also owns the account layer (spec 18.6): the global cap on model
 *   turns in flight, the sweep of leases whose owner died, and the account-wide
 *   pause after a provider rate limit. The shared state is `src/account.ts` over
 *   the hub directory's `runs.db`; residents consult it, the supervisor governs it.
 * - v0.7: every path comes from the hub directory (src/hubdir.ts), residents are
 *   spawned through `spawnEntry` so the built package can start them, and they
 *   receive a MINIMAL environment (v0.4 sect. 6.3 as written) unless the manifest
 *   says `agents.env: inherit`.
 */
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AccountLedger, RATE_LIMIT_PAUSE_FLOOR_MS, UNSUPERVISED_CAP } from "./account.js";
import { declaredPackNames, declaredSecretNames, loadPack, scanPacks, type AgentPack } from "./agentdef.js";
import { RoomMember } from "./client.js";
import { Engine } from "./engine.js";
import { minimalEnv } from "./env.js";
import { ensureRuntime, HubDirError, requireHubDir, roomsStore, type HubDir } from "./hubdir.js";
import { ObsStore, evaluateAlerts, formatReviewDigest } from "./obs.js";
import { spawnEntry, stopTree } from "./proc.js";
import { belongsTo, residentProcessesSync } from "./procscan.js";
import { backupPlan, runBackup } from "./platform.js";
import { loadSecrets, pickSecrets, transportToken } from "./secrets.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let hubdir: HubDir;
try {
  hubdir = requireHubDir({ dir: arg("--dir") });
} catch (err) {
  if (err instanceof HubDirError) {
    console.error(`supervisor: ${err.message}\n  ${err.hint}`);
    process.exit(2);
  }
  throw err;
}
ensureRuntime(hubdir);
const AGENTS = hubdir.paths.agents;

const POLICY = {
  maxRestarts: 10, // within the crash-loop window
  crashWindowMs: 10 * 60_000,
  minUptimeMs: 10_000, // uptime above this resets the backoff
  backoffBaseMs: 1_000,
  backoffCapMs: 60_000,
  killTimeoutMs: 15_000,
  reconcileMs: 30_000,
  heartbeatGraceS: 60,
};

interface Child {
  pack: AgentPack;
  proc: ChildProcess | null;
  startedAt: number;
  restarts: { at: number }[];
  backoffMs: number;
  draining: boolean;
}

const children = new Map<string, Child>();
/** Definition watchers, closed when a pack leaves the registry so a retirement cannot fire into a dead child. */
const watchers = new Map<string, fs.FSWatcher>();
const manualStopped = new Set<string>();
// A supervisor that dies takes restarts, drains, health checks and #ops alerts
// with it while every resident keeps running, so the room looks healthy and is
// unsupervised. That happened once, from an unhandled throw inside an fs.watch
// callback, so the process refuses to die quietly.
process.on("uncaughtException", (err) => {
  console.error(`${new Date().toISOString().slice(11, 19)} [supervisor] UNCAUGHT (staying up): ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`${new Date().toISOString().slice(11, 19)} [supervisor] UNHANDLED REJECTION (staying up): ${String(reason)}`);
});

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[supervisor]", ...a);

// ---------------------------------------------------------------- account layer (v0.5.2, spec 18.6)

const ACCOUNT = {
  passMs: 5_000,
  /** Escalation ceiling for the account-wide hold after repeated provider rate limits. */
  pauseCapMs: 15 * 60_000,
  /** Rate limits inside this window escalate the hold instead of restarting the ladder. */
  escalationWindowMs: 10 * 60_000,
};

/**
 * The cap the supervisor writes into the ledger, which is what makes it the
 * EFFECTIVE cap for every resident (RFA-0.8 sect. 5 item 8). The manifest's
 * `agents.max_inflight` defaults to `EFFECTIVE_DEFAULT_CAP` in `src/hubdir.ts`;
 * `UNSUPERVISED_CAP` is unreachable from here (zod has already applied the
 * default and enforces min 1) and is kept only so this line reads as total.
 */
function configuredCap(): number {
  const raw = Number(process.env.RFA_ACCOUNT_MAX_INFLIGHT);
  if (Number.isInteger(raw) && raw >= 1) return raw;
  return hubdir.manifest.agents.max_inflight || UNSUPERVISED_CAP;
}

const account = new AccountLedger(hubdir.paths.runsDb);
// The same database the residents journal into (WAL, so a second connection in
// this process is fine). The supervisor needs it for exactly one thing: clearing
// the runs a dead resident left `running` before it starts a fresh one.
const engine = new Engine(hubdir.paths.runsDb);
let pauseStreak = 0;
let lastPauseAt = 0;
let announcedPauseUntil = 0;

/** The workbench reads this (v0.4.5): the supervisor's view of every resident. */
function writeStateFile(): void {
  const agents: Record<string, unknown> = {};
  for (const [name, c] of children) {
    agents[name] = {
      pid: c.proc?.pid ?? null,
      status: manualStopped.has(name) ? "stopped" : c.proc ? "running" : c.restarts.length > POLICY.maxRestarts ? "crash-looped" : "restarting",
      started_at: c.startedAt ? new Date(c.startedAt).toISOString() : null,
      definition_hash: c.pack.definitionHash,
      restarts_in_window: c.restarts.length,
    };
  }
  fs.writeFileSync(
    hubdir.paths.supervisorState,
    // `invalid` is the running supervisor's own record of what it could not
    // load. The CLI reads it from here rather than re-parsing the files, so
    // `rfa status` and `rfa doctor` report what IS unsupervised and not what a
    // second scan guesses.
    JSON.stringify(
      { ts: new Date().toISOString(), pid: process.pid, agents, invalid: Object.fromEntries(invalidPacks), account: account.snapshot() },
      null,
      1,
    ),
  );
}

function residentLog(pack: AgentPack): number {
  const dir = path.join(pack.dir, "state");
  fs.mkdirSync(dir, { recursive: true });
  return fs.openSync(path.join(dir, "resident.log"), "a");
}

/**
 * Is a resident process for this pack already running that this supervisor does
 * not own? Found the hard way: when the supervisor died (an unhandled throw in a
 * file watcher), its children kept serving. Restarting the supervisor then
 * spawned SECOND residents, and two processes served the same membership: they
 * competed for one room cursor, one held a stale definition and a stale spend
 * ledger, and an eval run spent an hour producing failures whose real cause was
 * duplicate agents. Two residents on one membership is the same identity
 * collision this project already fixed once at the state-file level.
 */
function foreignResident(name: string): number | null {
  // Strict (src/procscan.ts): a node process whose script IS resident.ts/.js
  // with `--agent <name>`. A substring match once took a shell script that
  // mentioned both strings for a running resident and refused to start the
  // real one.
  for (const p of residentProcessesSync().filter((p) => belongsTo(p, hubdir.root))) {
    if (p.agent !== name) continue;
    // Ours, or a descendant of ours, is not a stray.
    if (p.ppid === process.pid || p.pid === process.pid) continue;
    if ([...children.values()].some((c) => c.proc?.pid === p.pid || c.proc?.pid === p.ppid)) continue;
    return p.pid;
  }
  return null;
}

// ---------------------------------------------------------------- the resident's environment (v0.4 sect. 6.3)

function residentEnv(pack: AgentPack): NodeJS.ProcessEnv {
  const base = hubdir.manifest.agents.env === "inherit" ? { ...process.env } : minimalEnv(process.env);
  // Every child derives its paths from the directory and its hub from the
  // manifest; RFA_HUB_URL survives only as an explicit override for tests.
  base.RFA_DIR = hubdir.root;
  base.RFA_HUB_URL = process.env.RFA_HUB_URL ?? hubdir.hubUrl;
  // Secrets: the pack declares NAMES (its own, plus its MCP servers'); only those values are injected (6.3).
  const names = declaredSecretNames(pack.def);
  if (names.length > 0) {
    const { env: picked, missing } = pickSecrets(loadSecrets(hubdir.paths.secrets), names);
    if (missing.length > 0) log(`${pack.name}: missing secrets [${missing.join(", ")}] (add them with \`rfa secrets set <NAME>\`)`);
    Object.assign(base, picked);
  }
  return base;
}

function start(child: Child): void {
  // Never a second resident for the same pack. Two processes serving one
  // membership compete for the same room cursor, and one of them holds a stale
  // definition and a stale spend ledger. This happened for real: the supervisor
  // died from an unhandled throw, its children kept serving, and the restarted
  // supervisor spawned duplicates that spent an hour producing eval failures
  // whose true cause was two agents answering as one.
  const stray = foreignResident(child.pack.name);
  if (stray !== null) {
    log(
      `${child.pack.name}: a resident is ALREADY running as pid ${stray} and this supervisor does not own it ` +
        `(usually an orphan from a supervisor that died). NOT starting a second one. Stop that process, or ` +
        `\`rfa agent retire ${child.pack.name}\` if it is stale.`,
    );
    return;
  }
  // Past the duplicate guard, so nothing else owns this pack: any run still
  // `running` for it belongs to a process that is gone, and it holds its thread
  // `busy` forever, which makes that conversation permanently unservable under the
  // default `enqueue` strategy. This is the moment the fact is knowable, and the
  // only one: a 30-minute approval wait is a legitimately long run, so no timeout
  // heuristic could tell a corpse from a live turn.
  const orphaned = engine.reconcileOrphans(child.pack.name);
  if (orphaned.runs.length > 0) {
    log(
      `${child.pack.name}: reconciled ${orphaned.runs.length} orphaned run(s) left 'running' by a dead process, ` +
        `freeing ${orphaned.threads.length} wedged thread(s): ${orphaned.threads.join(", ")}`,
    );
  }
  const fd = residentLog(child.pack);
  // `node --import tsx` (or the built entry) in its own process group, NOT `npx
  // tsx` (src/proc.ts): the wrapper stack cannot forward the SIGKILL that `drain`
  // escalates to, so a resident that missed its drain deadline used to survive as
  // an unsupervised process still serving its membership while this supervisor
  // recorded it as dead and started a replacement. The group also covers the
  // Agent SDK's `claude` child, which a pid-directed kill would orphan mid-answer.
  const proc = spawnEntry(import.meta.url, "resident", ["--agent", child.pack.name, "--dir", hubdir.root], {
    cwd: hubdir.root,
    stdio: ["ignore", fd, fd],
    env: residentEnv(child.pack),
  });
  child.proc = proc;
  child.startedAt = Date.now();
  child.draining = false;
  log(`started ${child.pack.name} (pid ${proc.pid}, definition ${child.pack.definitionHash.slice(0, 15)})`);
  writeStateFile();
  proc.on("exit", (code, signal) => {
    fs.closeSync(fd);
    const uptime = Date.now() - child.startedAt;
    child.proc = null;
    writeStateFile();
    if (child.draining) {
      log(`${child.pack.name} drained (uptime ${Math.round(uptime / 1000)}s)`);
      return; // the drain caller respawns
    }
    if (uptime >= POLICY.minUptimeMs) child.backoffMs = POLICY.backoffBaseMs;
    child.restarts = child.restarts.filter((r) => Date.now() - r.at < POLICY.crashWindowMs);
    child.restarts.push({ at: Date.now() });
    if (child.restarts.length > POLICY.maxRestarts) {
      log(`${child.pack.name} is crash-looping (${child.restarts.length} restarts in window); giving up until the definition changes`);
      return;
    }
    log(`${child.pack.name} exited (code ${code}, signal ${signal}); restarting in ${child.backoffMs}ms`);
    setTimeout(() => {
      if (!child.proc && children.has(child.pack.name)) start(child);
    }, child.backoffMs).unref?.();
    child.backoffMs = Math.min(POLICY.backoffCapMs, child.backoffMs * 2);
  });
}

async function drain(child: Child): Promise<void> {
  const proc = child.proc;
  if (!proc) return;
  child.draining = true;
  await stopTree(proc, POLICY.killTimeoutMs);
  if (proc.exitCode === null && proc.signalCode === null) {
    log(`${child.pack.name} did not drain in ${POLICY.killTimeoutMs}ms; SIGKILL`);
  }
  // A SIGKILLed resident cannot release its own slot, and a slot nobody is using
  // is a slot the account has lost until the sweep notices.
  const freed = account.releaseAgent(child.pack.name);
  if (freed > 0) log(`account: released ${freed} lease(s) held by the drained ${child.pack.name}`);
}

/** A definition edit: validate first, then versioned drain + respawn. */
async function redeploy(child: Child): Promise<void> {
  let fresh: AgentPack;
  if (!fs.existsSync(path.join(child.pack.dir, "agent.md"))) return; // moved aside by a retire: the registry pass drains it
  try {
    fresh = loadPack(child.pack.dir);
  } catch (err) {
    log(`${child.pack.name}: new agent.md is INVALID (${(err as Error).message}); keeping the running resident`);
    return;
  }
  if (fresh.definitionHash === child.pack.definitionHash) return;
  log(`${child.pack.name}: definition ${child.pack.definitionHash.slice(0, 15)} -> ${fresh.definitionHash.slice(0, 15)}; versioned drain`);
  child.pack = fresh;
  child.restarts = []; // a new definition earns a fresh crash budget
  child.backoffMs = POLICY.backoffBaseMs;
  await drain(child);
  start(child);
}

function heartbeatStale(child: Child): boolean {
  const hb = path.join(child.pack.dir, "state", "heartbeat");
  if (!fs.existsSync(hb)) return false; // not written yet (booting)
  const ts = Number(fs.readFileSync(hb, "utf8"));
  const ttl = (child.pack.def.rooms?.[0]?.presence_ttl_s ?? 180) + POLICY.heartbeatGraceS;
  return Date.now() - ts > ttl * 1000;
}

/**
 * Pack directories that do not parse, by directory name, with the first line of
 * their error. Held across cycles so the log and #ops speak on CHANGE and not
 * every 30 seconds, and so `writeStateFile` can publish them: the CLI must be
 * able to learn this from the RUNNING supervisor's own record rather than by
 * re-reading the files itself (the rule in CLAUDE.md, earned three times).
 */
const invalidPacks = new Map<string, string>();

async function reconcile(): Promise<void> {
  /*
   * Per pack, never all-or-nothing. `listPacks` maps `loadPack` with no catch,
   * so ONE unparseable agent.md used to make this whole function log a line and
   * RETURN: nothing started, no wedged resident restarted, no retirement
   * drained, every 30 seconds, and the operator's only signal was that log. The
   * loudness `listPacks` exists to provide is kept, and moved somewhere it can
   * actually be seen, instead of being expressed as "supervise nothing".
   */
  const { packs, broken: brokenList } = scanPacks(AGENTS);
  const broken = new Map(brokenList.map((b) => [b.name, b.error]));

  // Speak on change only: a 30s loop shouting the same typo is how a log stops
  // being read. Gone-quiet transitions are announced too, so a fixed pack is
  // visibly fixed.
  for (const [dir, why] of broken) {
    if (invalidPacks.get(dir) === why) continue;
    log(`agents/${dir}/agent.md is INVALID, so it is NOT supervised and its resident is left exactly as it is: ${why}`);
    void opsMember()
      .then((m) => m?.send({ body: `agents/${dir}/agent.md does not parse, so that pack is unsupervised until it is fixed: ${why}`, kind: "status" }))
      .catch((e) => log(`invalid-pack post failed: ${(e as Error).message}`));
  }
  for (const dir of invalidPacks.keys()) if (!broken.has(dir)) log(`agents/${dir}/agent.md parses again; back under supervision`);
  invalidPacks.clear();
  for (const [dir, why] of broken) invalidPacks.set(dir, why);

  /*
   * `seen` decides RETIREMENT at the bottom of this function, so it must hold
   * every DECLARED pack, including the ones that do not parse. A pack whose file
   * has a typo is not a retired pack: leaving it out would drain a HEALTHY
   * running resident over a syntax error, which is worse than the
   * all-or-nothing this replaces. The declared name is unreadable for a broken
   * pack, so the directory name stands in, and any child whose pack lives in
   * that directory is protected by name as well, because a directory and a
   * declared name are allowed to differ.
   */
  const seen = declaredPackNames(
    packs,
    brokenList,
    [...children].map(([name, c]) => ({ name, dir: c.pack.dir })),
  );
  for (const pack of packs) {
    seen.add(pack.name);
    const existing = children.get(pack.name);
    if (!existing) {
      const child: Child = { pack, proc: null, startedAt: 0, restarts: [], backoffMs: POLICY.backoffBaseMs, draining: false };
      children.set(pack.name, child);
      if (!manualStopped.has(pack.name)) start(child);
      // The watcher outlives the child: a retirement moves agent.md aside, which
      // fires this AFTER the registry scan has dropped the pack, and the `!`
      // assertion here used to throw inside an fs.watch callback, which is
      // unhandled and killed the whole supervisor. Every resident kept running
      // (separate processes), so the room looked healthy while nothing was
      // supervising it any more: no restarts, no drains, no alerts. Retiring an
      // agent could therefore take down supervision of every other agent.
      const watcher = fs.watch(path.join(pack.dir, "agent.md"), () => {
        const current = children.get(pack.name);
        if (!current) {
          watcher.close(); // the pack is gone; stop watching a path nobody owns
          return;
        }
        void redeploy(current).catch((err) => log(`${pack.name}: redeploy failed (${(err as Error).message})`));
      });
      watcher.on("error", (err) => log(`${pack.name}: definition watcher error (${err.message}); relying on the 30s registry scan`));
      watchers.set(pack.name, watcher);
      continue;
    }
    if (existing.proc && heartbeatStale(existing)) {
      // Alive but not heartbeating = wedged by lease definition: restart.
      log(`${existing.pack.name} heartbeat is stale (wedged); restarting`);
      await drain(existing);
      start(existing);
    }
    if (!existing.proc && existing.restarts.length > POLICY.maxRestarts) {
      // Crash-looped: only a definition change revives it (handled by redeploy).
      continue;
    }
  }
  for (const [name, child] of children) {
    if (!seen.has(name)) {
      log(`${name} removed from the registry; draining`);
      await drain(child);
      children.delete(name);
      // A retired name forgets its manual stop: `rfa agent retire x` stops x
      // through the command channel, and a pack re-created under the same name
      // minutes later was kept "stopped" by the flag of a pack that no longer
      // exists (found live: the new filer never started).
      manualStopped.delete(name);
      // Close the definition watcher with the child, or a later write to that
      // path fires a callback whose child no longer exists.
      watchers.get(name)?.close();
      watchers.delete(name);
    }
  }
}

// ---------------------------------------------------------------- workbench commands (v0.4.5)

const CMD_FILE = hubdir.paths.supervisorCommands;
let cmdOffset = fs.existsSync(CMD_FILE) ? fs.statSync(CMD_FILE).size : 0;

/** One reader at a time: the watch and the poll below must not both consume the same bytes. */
let commandsDraining = false;

async function drainCommands(): Promise<void> {
  if (commandsDraining) return;
  if (!fs.existsSync(CMD_FILE)) return;
  const size = fs.statSync(CMD_FILE).size;
  if (size <= cmdOffset) return;
  commandsDraining = true;
  try {
    await readCommands(size);
  } finally {
    commandsDraining = false;
  }
}

async function readCommands(size: number): Promise<void> {
  const fd = fs.openSync(CMD_FILE, "r");
  const buf = Buffer.alloc(size - cmdOffset);
  fs.readSync(fd, buf, 0, buf.length, cmdOffset);
  fs.closeSync(fd);
  cmdOffset = size;
  for (const line of buf.toString("utf8").split("\n").filter((l) => l.trim())) {
    let cmd: { agent: string; action: string; principal?: string };
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    const child = children.get(cmd.agent);
    log(`command: ${cmd.action} ${cmd.agent}`);
    // pause/resume are ACCOUNT-wide whatever agent they name (spec 18.6): the
    // subscription is the resource, and it is shared.
    if (cmd.action === "pause") {
      const { paused_until } = account.pause(`operator pause (${cmd.principal ?? "cli"})`, ACCOUNT.pauseCapMs);
      announcedPauseUntil = Date.parse(paused_until);
      log(`account: PAUSED pickup account-wide until ${paused_until} (operator)`);
      writeStateFile();
    } else if (cmd.action === "resume") {
      account.resume();
      pauseStreak = 0;
      announcedPauseUntil = 0;
      log("account: pickup resumed account-wide (operator)");
      writeStateFile();
    } else if (cmd.action === "stop" && child) {
      manualStopped.add(cmd.agent);
      await drain(child);
      writeStateFile();
    } else if (cmd.action === "start") {
      manualStopped.delete(cmd.agent);
      if (child && !child.proc) {
        child.restarts = [];
        child.backoffMs = POLICY.backoffBaseMs;
        start(child);
      } else if (!child) {
        await reconcile();
      }
    } else if (cmd.action === "restart" && child) {
      manualStopped.delete(cmd.agent);
      child.restarts = [];
      await drain(child);
      start(child);
    }
  }
}
try {
  if (!fs.existsSync(CMD_FILE)) fs.writeFileSync(CMD_FILE, "");
  fs.watch(CMD_FILE, () => void drainCommands());
} catch (err) {
  log(`command channel unavailable: ${(err as Error).message}`);
}

// ---------------------------------------------------------------- platform duties (v0.4.3): #ops alerts, retention, backup

const HUB = process.env.RFA_HUB_URL ?? hubdir.hubUrl;

// The supervisor is a hub CLIENT as well as a process manager, and it had no
// transport credential: since /mcp started requiring one (2026-08-18) every #ops
// post failed with 401 and the alert triad quietly degraded to this log file.
// The residents were unaffected because their token is INJECTED from their pack's
// declared `secrets`, which is exactly why nobody noticed for a day. Resolved the
// same way `rfa ask` and the retire command do it, and set on the environment
// because src/client.ts reads it per call (a module-level capture was its own bug).
const supervisorToken = transportToken(hubdir.paths.secrets);
if (supervisorToken && !process.env.RFA_TOKEN) process.env.RFA_TOKEN = supervisorToken;

const OPS_STATE = hubdir.paths.opsRoom;
const OBS_DB = hubdir.paths.obsDb;
const OPS = {
  alertEveryMs: 5 * 60_000,
  alertWindowMs: 15 * 60_000,
  alertCooldownMs: 30 * 60_000,
  // The review digest (spec 20.5): evaluated on this same tick, posted daily over
  // a daily window. It is a digest, not an alert, so the cadence is the point: the
  // two queues move on the timescale a human reviews them on, and a count reposted
  // every five minutes is a channel an operator learns to ignore.
  digestEveryMs: 24 * 3_600_000,
  digestWindowMs: 24 * 3_600_000,
  retentionDays: hubdir.manifest.retention.obs_days,
  backupHourLocal: 3, // daily, once past 03:00
  backupKeep: hubdir.manifest.retention.backup_keep,
};

let opsRoom: RoomMember | null = null;
const alertLastSent = new Map<string, number>();

/**
 * The supervisor is itself a member: it speaks alerts into the `ops` room.
 *
 * Since v0.7 the room is the operator's: `rfa init` creates it and records it in
 * `rooms.json` under the alias `ops`, and the supervisor JOINS it with the bearer
 * it already holds (bearer-implied admission, so no secret travels). A directory
 * migrated from the pre-0.7 layout, or one whose operator deleted the alias, still
 * gets a room: the supervisor creates one and records it, so `rfa room ls` shows
 * it, which is the one room-creation path this process keeps.
 */
async function opsMember(): Promise<RoomMember | null> {
  if (opsRoom) return opsRoom;
  const clientInfo = { name: "rfa-supervisor", version: "0.7.0" };
  try {
    if (fs.existsSync(OPS_STATE)) {
      const saved = JSON.parse(fs.readFileSync(OPS_STATE, "utf8"));
      opsRoom = await RoomMember.resume({ hubUrl: HUB, ...saved, clientInfo });
      return opsRoom;
    }
    const card = {
      name: "platform",
      description: "The supervisor process: posts alerts and platform notices.",
      skills: [{ id: "ops-alerts", description: "Posts threshold alerts from the local observability store." }],
    };
    const rooms = roomsStore(hubdir);
    const known = rooms.read().rooms.find((r) => r.alias === "ops");
    if (known) {
      opsRoom = await RoomMember.create({ hubUrl: HUB, room: known.handle, joinSecret: known.join_secret ?? undefined, name: "platform", card, clientInfo });
      log(`joined the ops room ${known.handle}`);
    } else {
      opsRoom = await RoomMember.create({
        hubUrl: HUB,
        name: "platform",
        topic: "#ops: platform alerts (error rate, latency, feedback), backups, retention",
        card,
        clientInfo,
      });
      const handle = opsRoom.room;
      rooms.update((f) => {
        if (!f.rooms.some((r) => r.handle === handle)) {
          f.rooms.push({ alias: "ops", handle, topic: "#ops: platform alerts", join_secret: opsRoom!.joinSecret, operator: null, created_at: new Date().toISOString() });
        }
      });
      log(`ops room created: ${handle}; recorded in rooms.json as \`ops\`; watch it with \`rfa console --room ops\``);
    }
    fs.writeFileSync(
      OPS_STATE,
      JSON.stringify({ room: opsRoom.room, membershipToken: opsRoom.membershipToken, memberId: opsRoom.memberId, name: opsRoom.name, joinSecret: opsRoom.joinSecret }, null, 2),
      { mode: 0o600 },
    );
    return opsRoom;
  } catch (err) {
    log(`ops room unavailable (${(err as Error).message}); alerts stay in this log`);
    opsRoom = null;
    return null;
  }
}

async function alertPass(): Promise<void> {
  if (!fs.existsSync(OBS_DB)) return;
  const obs = new ObsStore(OBS_DB);
  try {
    const summary = obs.summary(OPS.alertWindowMs);
    const alerts = evaluateAlerts(summary);
    const now = Date.now();
    for (const alert of alerts) {
      if (now - (alertLastSent.get(alert.kind) ?? 0) < OPS.alertCooldownMs) continue;
      alertLastSent.set(alert.kind, now);
      log(`ALERT ${alert.kind}: ${alert.message}`);
      const m = await opsMember();
      await m?.send({ body: `ALERT ${alert.kind}: ${alert.message}`, kind: "status" }).catch((e) => log(`alert post failed: ${e.message}`));
    }
  } finally {
    obs.close();
  }
}

/**
 * The `#ops` review digest (spec 20.5), and the one new scheduled job v0.5 admits
 * (18.6's sequencing rule, now satisfiable because layer 3 exists).
 *
 * The last-posted time is PERSISTED, unlike the alert cooldowns which live in
 * memory: a supervisor restart is routine (three today), and an in-memory daily
 * timer would post a fresh digest on each one, which is how a digest becomes
 * noise.
 */
const DIGEST_STATE = hubdir.paths.opsDigest;
function lastDigestAt(): number {
  try {
    return (JSON.parse(fs.readFileSync(DIGEST_STATE, "utf8")) as { last_at?: number }).last_at ?? 0;
  } catch {
    return 0;
  }
}
async function digestPass(): Promise<void> {
  if (!fs.existsSync(OBS_DB)) return;
  const now = Date.now();
  if (now - lastDigestAt() < OPS.digestEveryMs) return;
  const obs = new ObsStore(OBS_DB);
  let text: string;
  try {
    text = formatReviewDigest(obs.reviewQueues(OPS.digestWindowMs, now));
  } finally {
    obs.close();
  }
  // Stamp BEFORE posting: a hub that is down must not turn a daily digest into a
  // five-minute retry loop against an unreachable room.
  fs.writeFileSync(DIGEST_STATE, JSON.stringify({ last_at: now }, null, 1) + "\n", { mode: 0o600 });
  for (const line of text.split("\n")) log(line);
  const m = await opsMember();
  await m?.send({ body: text, kind: "status" }).catch((e) => log(`digest post failed: ${(e as Error).message}`));
}

/** Nightly: retention prune + .backup of every SQLite DB + archive of memory/state dirs. */
let lastBackupDay = "";
async function nightlyPass(): Promise<void> {
  const nowD = new Date();
  const day = nowD.toISOString().slice(0, 10);
  if (nowD.getHours() < OPS.backupHourLocal || lastBackupDay === day) return;
  lastBackupDay = day;
  // Retention first (spec 3.9): prune obs runs unless feedback-bearing or under review.
  if (fs.existsSync(OBS_DB)) {
    const obs = new ObsStore(OBS_DB);
    const pruned = obs.prune(OPS.retentionDays);
    obs.close();
    if (pruned > 0) log(`retention: pruned ${pruned} obs runs older than ${OPS.retentionDays}d`);
  }
  try {
    const p = hubdir.paths;
    const plan = backupPlan(hubdir);
    const res = await runBackup({
      root: hubdir.root,
      dbs: plan.dbs,
      dirs: plan.dirs,
      destRoot: p.backups,
      keep: OPS.backupKeep,
      day,
    });
    // The broken packs are in the archive (the plan reads the directory, not the
    // definition); the log says so, because `reconcile` above has already told
    // this operator those packs are unsupervised and the two facts differ.
    log(`backup written: ${res.dest} (${res.files.length} files, ${res.kept.length} kept)${plan.broken.length ? `; included the files of ${plan.broken.length} unparseable pack(s): ${plan.broken.map((b) => b.name).join(", ")}` : ""}`);
    const m = await opsMember();
    await m?.send({ body: `nightly backup written to ${res.dest} (${res.kept.length} kept)`, kind: "status" }).catch(() => {});
  } catch (err) {
    log(`backup FAILED: ${(err as Error).message}`);
    const m = await opsMember();
    await m?.send({ body: `ALERT backup: nightly backup FAILED: ${(err as Error).message}`, kind: "status" }).catch(() => {});
  }
}

// ---------------------------------------------------------------- account pass (spec 18.6)

/**
 * The supervisor's half of layer 3: it does not sit in the admission path (an
 * RPC per model turn buys nothing on one laptop), it governs the shared table
 * residents consult. Three duties: reclaim slots whose owner died, turn a
 * reported provider rate limit into an account-wide hold with an escalating
 * duration, and say out loud when the hold lifts.
 */
function accountPass(): void {
  const swept = account.sweep();
  if (swept > 0) log(`account: swept ${swept} lease(s) whose owner is gone`);
  // Run-state reconciliation at ZERO TRAFFIC (RFA-0.8 sect. 3 item 4). A direct
  // state check, on this timer, not at a resident's start and not from any rate:
  // a run whose process died holds its thread `busy` forever, every later run on
  // that conversation is created `pending` behind it, and nothing about that is
  // visible in an error rate, which on a quiet hub has no denominator at all.
  // `reconcileOrphans` still covers pre-0.8 rows carrying no owner, at the one
  // moment it can (a resident start, above).
  const orphanedRuns = engine.reconcileDead();
  if (orphanedRuns.runs.length > 0) {
    log(
      `engine: swept ${orphanedRuns.runs.length} run(s) whose owning process is gone, freeing ` +
        `${orphanedRuns.threads.length} wedged thread(s): ${orphanedRuns.threads.join(", ")}`,
    );
  }
  const reports = account.pendingRateLimits();
  if (reports.length > 0) {
    const now = Date.now();
    pauseStreak = now - lastPauseAt < ACCOUNT.escalationWindowMs ? pauseStreak + 1 : 1;
    lastPauseAt = now;
    const holdMs = Math.min(ACCOUNT.pauseCapMs, RATE_LIMIT_PAUSE_FLOOR_MS * 2 ** (pauseStreak - 1));
    const agents = [...new Set(reports.map((r) => r.agent))].join(", ");
    const { paused_until } = account.pause(`provider rate limit (${agents})`, holdMs);
    account.markRateLimitsHandled(reports.map((r) => r.id));
    announcedPauseUntil = Date.parse(paused_until);
    log(
      `account: PAUSED pickup account-wide until ${paused_until} (${reports.length} rate-limit report(s) from ${agents}; hold ${Math.round(holdMs / 1000)}s, streak ${pauseStreak})`,
    );
    void opsMember().then((m) =>
      m
        ?.send({ body: `ALERT account: provider rate limit reported by ${agents}; pickup paused account-wide until ${paused_until}`, kind: "status" })
        .catch((e) => log(`account alert post failed: ${e.message}`)),
    );
    writeStateFile();
    return;
  }
  if (announcedPauseUntil > 0 && account.pausedUntil() === 0) {
    announcedPauseUntil = 0;
    log("account: hold lapsed; pickup resumed account-wide");
    writeStateFile();
  }
}

// ---------------------------------------------------------------- main

log(`hub directory: ${hubdir.root} (${hubdir.mode === "hub" ? `hub on ${HUB}` : `remote hub ${HUB}`}); registry: ${AGENTS}; resident env: ${hubdir.manifest.agents.env}`);
account.setCap(configuredCap());
account.sweep();
{
  // At boot too: a supervisor restarting after a crash is the most likely moment
  // for a dead owner's run to be sitting there.
  const swept = engine.reconcileDead();
  if (swept.runs.length > 0) log(`engine: swept ${swept.runs.length} run(s) whose owning process is gone at boot (${swept.threads.length} thread(s) freed)`);
}
log(`account layer: cap ${account.cap()} model turn(s) in flight (lane limits: serve ${account.laneLimit("serve")}, schedule ${account.laneLimit("schedule")}, background ${account.laneLimit("background")})`);
if (account.pausedUntil() > 0) {
  announcedPauseUntil = account.pausedUntil();
  log(`account: pickup is still paused until ${new Date(announcedPauseUntil).toISOString()} (${account.pauseReason() ?? "no reason recorded"})`);
}
await reconcile();
writeStateFile();
void opsMember();
const timer = setInterval(() => void reconcile(), POLICY.reconcileMs);
const accountTimer = setInterval(() => {
  accountPass();
  // The command channel is watched, but fs.watch drops events under load and the
  // retirement script waits on a stop actually landing.
  void drainCommands();
}, ACCOUNT.passMs);
accountTimer.unref?.();
const opsTimer = setInterval(() => {
  void alertPass();
  void digestPass();
  void nightlyPass();
}, OPS.alertEveryMs);
opsTimer.unref?.();

async function shutdown(sig: string): Promise<void> {
  log(`${sig}: draining ${children.size} resident(s)`);
  clearInterval(timer);
  clearInterval(opsTimer);
  clearInterval(accountTimer);
  await Promise.all([...children.values()].map((c) => drain(c)));
  account.close();
  engine.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
