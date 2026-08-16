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
 *   renews its presence lease (the lease proxy; v0.4.1 upgrades this to
 *   reading lease_expires from the roster as an observer member).
 * - A definition edit triggers a versioned drain: validate the new agent.md
 *   first (a broken edit must never kill a healthy resident), then SIGTERM,
 *   wait, respawn. The new card digest in the roster marks the deploy.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { listPacks, loadPack, type AgentPack } from "./agentdef.js";

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
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[supervisor]", ...a);

function residentLog(pack: AgentPack): number {
  const dir = path.join(pack.dir, "state");
  fs.mkdirSync(dir, { recursive: true });
  return fs.openSync(path.join(dir, "resident.log"), "a");
}

function start(child: Child): void {
  const fd = residentLog(child.pack);
  const proc = spawn("npx", ["tsx", RESIDENT, "--agent", child.pack.name], {
    cwd: ROOT,
    stdio: ["ignore", fd, fd],
    detached: false,
  });
  child.proc = proc;
  child.startedAt = Date.now();
  child.draining = false;
  log(`started ${child.pack.name} (pid ${proc.pid}, definition ${child.pack.definitionHash.slice(0, 15)})`);
  proc.on("exit", (code, signal) => {
    fs.closeSync(fd);
    const uptime = Date.now() - child.startedAt;
    child.proc = null;
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
      start(child);
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

// ---------------------------------------------------------------- main

log(`registry: ${AGENTS}`);
await reconcile();
const timer = setInterval(() => void reconcile(), POLICY.reconcileMs);

async function shutdown(sig: string): Promise<void> {
  log(`${sig}: draining ${children.size} resident(s)`);
  clearInterval(timer);
  await Promise.all([...children.values()].map((c) => drain(c)));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
