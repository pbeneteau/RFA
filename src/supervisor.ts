/**
 * Resident supervisor v0 (RFA v0.4 spec section 4.2): the one long-lived
 * process that owns every resident. launchd keeps THIS alive; this keeps the
 * residents alive.
 *
 *   npm run supervisor
 *
 * - Registry = `agents/<name>/agent.md` (re-listed every 30s, file-watched).
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
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { listPacks, loadPack, type AgentPack } from "./agentdef.js";
import { RoomMember } from "./client.js";
import { ObsStore, evaluateAlerts } from "./obs.js";
import { runBackup } from "./platform.js";
import { loadSecrets, pickSecrets } from "./secrets.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const AGENTS = path.join(ROOT, "agents");
const RESIDENT = path.join(ROOT, "src", "resident.ts");

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
const manualStopped = new Set<string>();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[supervisor]", ...a);

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
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "supervisor-state.json"), JSON.stringify({ ts: new Date().toISOString(), agents }, null, 1));
}

function residentLog(pack: AgentPack): number {
  const dir = path.join(pack.dir, "state");
  fs.mkdirSync(dir, { recursive: true });
  return fs.openSync(path.join(dir, "resident.log"), "a");
}

function start(child: Child): void {
  const fd = residentLog(child.pack);
  // Secrets: the pack declares NAMES; only those values are injected (6.3).
  let env = process.env;
  const names = child.pack.def.secrets ?? [];
  if (names.length > 0) {
    const { env: picked, missing } = pickSecrets(loadSecrets(path.join(ROOT, "data", "secrets.json")), names);
    if (missing.length > 0) log(`${child.pack.name}: missing secrets [${missing.join(", ")}] (declare them in data/secrets.json)`);
    env = { ...process.env, ...picked };
  }
  const proc = spawn("npx", ["tsx", RESIDENT, "--agent", child.pack.name], {
    cwd: ROOT,
    stdio: ["ignore", fd, fd],
    detached: false,
    env,
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
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      log(`${child.pack.name} did not drain in ${POLICY.killTimeoutMs}ms; SIGKILL`);
      proc.kill("SIGKILL");
      resolve();
    }, POLICY.killTimeoutMs);
    proc.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** A definition edit: validate first, then versioned drain + respawn. */
async function redeploy(child: Child): Promise<void> {
  let fresh: AgentPack;
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

async function reconcile(): Promise<void> {
  let packs: AgentPack[];
  try {
    packs = listPacks(AGENTS);
  } catch (err) {
    log(`registry scan failed: ${(err as Error).message}`);
    return;
  }
  const seen = new Set<string>();
  for (const pack of packs) {
    seen.add(pack.name);
    const existing = children.get(pack.name);
    if (!existing) {
      const child: Child = { pack, proc: null, startedAt: 0, restarts: [], backoffMs: POLICY.backoffBaseMs, draining: false };
      children.set(pack.name, child);
      if (!manualStopped.has(pack.name)) start(child);
      fs.watch(path.join(pack.dir, "agent.md"), () => void redeploy(children.get(pack.name)!));
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
    }
  }
}

// ---------------------------------------------------------------- workbench commands (v0.4.5)

const CMD_FILE = path.join(ROOT, "data", "supervisor-commands.ndjson");
let cmdOffset = fs.existsSync(CMD_FILE) ? fs.statSync(CMD_FILE).size : 0;

async function drainCommands(): Promise<void> {
  if (!fs.existsSync(CMD_FILE)) return;
  const size = fs.statSync(CMD_FILE).size;
  if (size <= cmdOffset) return;
  const fd = fs.openSync(CMD_FILE, "r");
  const buf = Buffer.alloc(size - cmdOffset);
  fs.readSync(fd, buf, 0, buf.length, cmdOffset);
  fs.closeSync(fd);
  cmdOffset = size;
  for (const line of buf.toString("utf8").split("\n").filter((l) => l.trim())) {
    let cmd: { agent: string; action: string };
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    const child = children.get(cmd.agent);
    log(`command: ${cmd.action} ${cmd.agent}`);
    if (cmd.action === "stop" && child) {
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
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  if (!fs.existsSync(CMD_FILE)) fs.writeFileSync(CMD_FILE, "");
  fs.watch(CMD_FILE, () => void drainCommands());
} catch (err) {
  log(`command channel unavailable: ${(err as Error).message}`);
}

// ---------------------------------------------------------------- platform duties (v0.4.3): #ops alerts, retention, backup

const HUB = process.env.RFA_HUB_URL ?? "http://localhost:8790/mcp";
const OPS_STATE = path.join(ROOT, "data", "ops-room.json");
const OBS_DB = path.join(ROOT, "data", "obs.db");
const OPS = {
  alertEveryMs: 5 * 60_000,
  alertWindowMs: 15 * 60_000,
  alertCooldownMs: 30 * 60_000,
  retentionDays: 14,
  backupHourLocal: 3, // daily, once past 03:00
  backupKeep: 7,
};

let opsRoom: RoomMember | null = null;
const alertLastSent = new Map<string, number>();

/** The supervisor is itself a member: it owns the #ops room and speaks alerts into it. */
async function opsMember(): Promise<RoomMember | null> {
  if (opsRoom) return opsRoom;
  try {
    if (fs.existsSync(OPS_STATE)) {
      const saved = JSON.parse(fs.readFileSync(OPS_STATE, "utf8"));
      opsRoom = await RoomMember.resume({ hubUrl: HUB, ...saved, clientInfo: { name: "rfa-supervisor", version: "0.4.3" } });
      return opsRoom;
    }
    opsRoom = await RoomMember.create({
      hubUrl: HUB,
      name: "platform",
      topic: "#ops: platform alerts (error rate, latency, feedback), backups, retention",
      card: { name: "platform", description: "The supervisor process: posts alerts and platform notices.", skills: [{ id: "ops-alerts", description: "Posts threshold alerts from the local observability store." }] },
      clientInfo: { name: "rfa-supervisor", version: "0.4.3" },
    });
    fs.writeFileSync(
      OPS_STATE,
      JSON.stringify({ room: opsRoom.room, membershipToken: opsRoom.membershipToken, memberId: opsRoom.memberId, name: opsRoom.name, joinSecret: opsRoom.joinSecret }, null, 2),
      { mode: 0o600 },
    );
    log(`#ops room created: ${opsRoom.room} (join_secret ${opsRoom.joinSecret}); watch it at /console#${opsRoom.room}`);
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
    const res = await runBackup({
      root: ROOT,
      dbs: [path.join(ROOT, "data", "runs.db"), OBS_DB, ...listPacks(AGENTS).map((p) => path.join(p.dir, "state", "memory.db"))],
      dirs: ["data/rooms", "dogfood/state", ...listPacks(AGENTS).map((p) => path.relative(ROOT, path.join(p.dir, "memory")))],
      destRoot: path.join(process.env.HOME ?? ROOT, "Backups", "rfa-agent-com"),
      keep: OPS.backupKeep,
      day,
    });
    log(`backup written: ${res.dest} (${res.files.length} files, ${res.kept.length} kept)`);
    const m = await opsMember();
    await m?.send({ body: `nightly backup written to ${res.dest} (${res.kept.length} kept)`, kind: "status" }).catch(() => {});
  } catch (err) {
    log(`backup FAILED: ${(err as Error).message}`);
    const m = await opsMember();
    await m?.send({ body: `ALERT backup: nightly backup FAILED: ${(err as Error).message}`, kind: "status" }).catch(() => {});
  }
}

// ---------------------------------------------------------------- main

log(`registry: ${AGENTS}`);
await reconcile();
writeStateFile();
void opsMember();
const timer = setInterval(() => void reconcile(), POLICY.reconcileMs);
const opsTimer = setInterval(() => {
  void alertPass();
  void nightlyPass();
}, OPS.alertEveryMs);
opsTimer.unref?.();

async function shutdown(sig: string): Promise<void> {
  log(`${sig}: draining ${children.size} resident(s)`);
  clearInterval(timer);
  clearInterval(opsTimer);
  await Promise.all([...children.values()].map((c) => drain(c)));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
