/**
 * The pre-0.7 layout becomes a hub directory (RFA-0.7 sect. 7).
 *
 * Before 0.7 the repository checkout was the instance: `data/`, `dogfood/ROOM.md`,
 * `dogfood/state/`, `deploy/gate.json` and `evals/` beside `src/`. This module
 * plans the move as a list of steps a human can read (`rfa migrate --dry-run`
 * prints it) and then performs exactly that list, so what happened is what was
 * shown. It never copies a secret into a log line and it never touches a store
 * whose hub is still running.
 *
 * In-place (`to` equals the legacy root) or into a fresh directory: the repository
 * keeps its source, the instance moves out, and git shows the tracked packs and
 * policies leaving, which is the separation the owner asked for.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tokenDigest } from "./credentials.js";
import { packageFile } from "./pkg.js";
import {
  defaultManifest,
  detectLegacyLayout,
  ensureRuntime,
  hubUrlFor,
  loadHubDir,
  MANIFEST_FILE,
  pathsFor,
  principalsStore,
  roomsStore,
  secretsStore,
  tokensStore,
  writeJsonAtomic,
  writeManifest,
  type LegacyLayout,
  type Manifest,
} from "./hubdir.js";
import { principalRecordFor } from "./principals.js";

export interface MigrationStep {
  kind: "move" | "copy" | "write" | "record" | "note";
  from?: string;
  to?: string;
  detail: string;
}

export interface MigrationPlan {
  legacy: LegacyLayout;
  target: string;
  inPlace: boolean;
  manifest: Manifest;
  steps: MigrationStep[];
  warnings: string[];
  /** What must happen after the hub is up again, because it needs the hub. */
  afterwards: string[];
  /** The options the plan was made with, so apply uses the same ones. */
  options: MigrationOptions;
}

export interface MigrationOptions {
  name?: string;
  port?: number;
  /** Label for the human principal the legacy human key becomes. */
  human?: string;
  /** Alias for the legacy standing room. */
  roomAlias?: string;
  now?: Date;
}

const LOCK_STALE_MS = 60_000;

function exists(p: string | null | undefined): p is string {
  return typeof p === "string" && fs.existsSync(p);
}

/** A legacy store whose hub is still serving must not be moved from under it. */
export function lockStatus(dataDir: string, now = Date.now()): "none" | "stale" | "live" {
  const lock = path.join(dataDir, ".hub.lock");
  if (!fs.existsSync(lock)) return "none";
  try {
    const rec = JSON.parse(fs.readFileSync(lock, "utf8")) as { heartbeat?: number; startedAt?: number };
    const beat = rec.heartbeat ?? rec.startedAt ?? 0;
    return now - beat > LOCK_STALE_MS ? "stale" : "live";
  } catch {
    return "stale";
  }
}

/** Read `dogfood/ROOM.md` for the handle and the secret it published. */
export function parseRoomMd(text: string): { handle: string; secret: string | null; hub: string | null } | null {
  const handle = /Room: `(r_[a-f0-9]+)`/.exec(text)?.[1];
  if (!handle) return null;
  return { handle, secret: /Join secret: `([^`]+)`/.exec(text)?.[1] ?? null, hub: /Hub: `([^`]+)`/.exec(text)?.[1] ?? null };
}

export function planMigration(legacyRoot: string, target: string, opts: MigrationOptions = {}): MigrationPlan {
  const legacy = detectLegacyLayout(legacyRoot);
  if (!legacy) throw new Error(`${legacyRoot} has no pre-0.7 layout to migrate (no data/, dogfood/ROOM.md or dogfood/state/)`);
  const targetRoot = path.resolve(target);
  const inPlace = path.resolve(legacyRoot) === targetRoot;
  if (fs.existsSync(path.join(targetRoot, MANIFEST_FILE))) throw new Error(`${targetRoot} already holds ${MANIFEST_FILE}; refusing to migrate into an existing hub directory`);
  const name = opts.name ?? (path.basename(targetRoot).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "hub");
  const manifest = defaultManifest({ name, port: opts.port ?? 8790 });
  const p = pathsFor(targetRoot, manifest);
  const hubUrl = hubUrlFor(manifest);
  const steps: MigrationStep[] = [];
  const warnings: string[] = [];
  const afterwards: string[] = [];
  const rel = (f: string) => path.relative(legacyRoot, f) || ".";
  const tgt = (f: string) => path.relative(targetRoot, f) || ".";
  const move = (from: string, to: string, detail: string) => steps.push({ kind: "move", from, to, detail: `${detail}: ${rel(from)} -> ${tgt(to)}` });

  steps.push({ kind: "write", to: p.manifest, detail: `write ${MANIFEST_FILE} (name ${name}, hub ${hubUrl})` });
  steps.push({ kind: "write", to: p.runtime, detail: `create ${tgt(p.runtime)}/ (0700) with data/, supervisor/, logs/, run/, retired/` });

  // The store. Moved, never copied: one store, one lock.
  if (legacy.data) {
    const status = lockStatus(legacy.data);
    if (status === "live") warnings.push(`${rel(legacy.data)}/.hub.lock has a fresh heartbeat: a hub is serving this store. Stop it first; the migration refuses to move a live store.`);
    if (status === "stale") steps.push({ kind: "note", detail: `delete the stale ${rel(legacy.data)}/.hub.lock` });
    const dataFiles = fs.readdirSync(legacy.data);
    for (const f of dataFiles) {
      const from = path.join(legacy.data, f);
      if (f === ".hub.lock") continue;
      if (f === "rooms") move(from, p.roomLogs, "room logs and snapshots");
      else if (/^runs\.db(-wal|-shm)?$/.test(f)) move(from, path.join(p.data, f), "engine database");
      else if (/^obs\.db(-wal|-shm)?$/.test(f)) move(from, path.join(p.data, f), "observability store");
      else if (f === "auth.log.ndjson") move(from, p.authLog, "auth log");
      else if (f === "secrets.json") move(from, p.secrets, "secrets (values; stays the one file that holds them)");
      else if (f === "supervisor-state.json") move(from, p.supervisorState, "supervisor state");
      else if (f === "supervisor-commands.ndjson") move(from, p.supervisorCommands, "supervisor command channel");
      else if (f === "ops-room.json") move(from, p.opsRoom, "the supervisor's ops membership");
      else if (f === "ops-digest.json") move(from, p.opsDigest, "digest stamp");
      else if (f === "judge-count.json") move(from, p.judgeCount, "judge counter");
      else if (f === "retired") move(from, p.retired, "retired packs");
      else if (f.startsWith(".")) continue; // Finder droppings and the like: not data
      else if (f.endsWith(".pid")) steps.push({ kind: "note", detail: `${rel(from)} is the pid of a pre-0.7 process: left behind (the new runtime keeps pids under ${tgt(p.run)}/)` });
      else if (f.endsWith(".log")) move(from, path.join(p.logs, f), "log");
      else move(from, path.join(p.data, f), "data file");
    }
  }

  // Credentials: hashed into the two files, the operator's plaintext into secrets.
  if (exists(legacy.humanKey)) steps.push({ kind: "record", from: legacy.humanKey, to: p.principals, detail: `hash ${rel(legacy.humanKey)} into ${tgt(p.principals)} as principal "${opts.human ?? "operator"}", and keep the plaintext in ${tgt(p.secrets)} as RFA_HUMAN_KEY for the CLI` });
  else warnings.push("no dogfood/state/human-key.txt: the new directory will have no human principal until `rfa human add`");
  if (exists(legacy.secrets)) steps.push({ kind: "record", from: legacy.secrets, to: p.tokens, detail: `hash RFA_TOKEN from ${rel(legacy.secrets)} into ${tgt(p.tokens)} as the operator bearer` });
  else warnings.push("no data/secrets.json: the new directory will have no operator bearer until `rfa token mint operator`");

  // Rooms.
  if (exists(legacy.roomMd)) steps.push({ kind: "record", from: legacy.roomMd, to: p.rooms, detail: `record the standing room from ${rel(legacy.roomMd)} in ${tgt(p.rooms)} as \`${opts.roomAlias ?? "main"}\` (handle and join secret; the file itself is left in place and no longer read)` });
  const opsFile = legacy.data ? path.join(legacy.data, "ops-room.json") : null;
  if (exists(opsFile)) steps.push({ kind: "record", from: opsFile, to: p.rooms, detail: `record the ops room from ${rel(opsFile)} in ${tgt(p.rooms)} as \`ops\`` });

  // Operator-authored material.
  if (exists(legacy.gate)) {
    if (inPlace) steps.push({ kind: "copy", from: legacy.gate, to: p.gate!, detail: `copy ${rel(legacy.gate)} -> ${tgt(p.gate!)} (the old checkout's deploy/ is not touched; 0.7 ships no deploy/ and rfa service replaces it)` });
    else move(legacy.gate, p.gate!, "policy gate");
  } else if (p.gate) {
    // A checkout that pulled 0.7 before migrating has no deploy/ any more (the
    // first live migration hit exactly this): the hub refuses to start without
    // a gate, so the packaged default goes in, the same file rfa init writes.
    steps.push({ kind: "copy", from: packageFile("templates", "gate.json"), to: p.gate, detail: `write the default policy gate -> ${tgt(p.gate)} (no deploy/gate.json in the checkout; this is the file rfa init writes)` });
  }
  if (!inPlace) {
    if (exists(legacy.agents)) move(legacy.agents, p.agents, "agent packs, state included, so every resident resumes its membership");
    if (exists(legacy.evals)) move(legacy.evals, p.evals, "eval cases, baseline and rubric");
    if (fs.existsSync(path.join(legacyRoot, ".git")) && (exists(legacy.agents) || exists(legacy.evals))) {
      afterwards.push("the checkout's tracked files under agents/ and evals/ (the example packs, the generic case, the rubric) now show as deleted in git: `git checkout -- agents evals` there restores them as the repository's examples; the instance has its own copies");
    }
  }
  if (exists(legacy.parity)) move(legacy.parity, p.evalParity, "parity fixtures");
  if (exists(legacy.dogfoodState)) {
    for (const f of fs.readdirSync(legacy.dogfoodState)) {
      if (f.endsWith(".log")) move(path.join(legacy.dogfoodState, f), path.join(p.logs, f), "log");
    }
  }
  steps.push({ kind: "write", to: p.gitignore, detail: `write ${tgt(p.gitignore)} (${tgt(p.runtime)}/, agents/*/state/, knowledge clones)` });

  const plistDir = path.join(process.env.HOME ?? "", "Library", "LaunchAgents");
  if (fs.existsSync(path.join(plistDir, "com.rfa.hub.plist")) || fs.existsSync(path.join(plistDir, "com.rfa.supervisor.plist"))) {
    afterwards.push("launchd agents com.rfa.hub and com.rfa.supervisor still point at the old checkout: `launchctl bootout gui/$(id -u)/com.rfa.hub` and `.../com.rfa.supervisor`, then `rfa service install`");
  }
  afterwards.push("`rfa up`, then `rfa status` until every resident shows ready (they resume their memberships; the epoch does not bump)");
  afterwards.push("`rfa room adopt` for each recorded room creates the operator's own admin membership and allows the operator bearer in it (join_bearer_sha256), after which residents need no join secret");
  afterwards.push("`rfa log verify` (every room), then one `rfa ask`");
  return { legacy, target: targetRoot, inPlace, manifest, steps, warnings, afterwards, options: opts };
}

/** Move across filesystems too: rename, and on EXDEV copy then remove. */
function moveTree(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export const GITIGNORE_LINES = [
  "# rfa: runtime state, secrets and logs (owned by the tool)",
  ".rfa/",
  "agents/*/state/",
  "agents/*/knowledge/*-clone/",
  "agents/*/knowledge/handbook-clone/",
];

export function writeGitignore(file: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const missing = GITIGNORE_LINES.filter((l) => !existing.split("\n").includes(l));
  if (missing.length === 0) return;
  fs.writeFileSync(file, (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") + missing.join("\n") + "\n");
}

/** Perform a plan. Refuses a live store. Re-runnable: a step whose source is gone and whose target exists is skipped. */
export function applyMigration(plan: MigrationPlan, opts: MigrationOptions = plan.options): { done: string[]; skipped: string[] } {
  const now = opts.now ?? new Date();
  if (plan.legacy.data && lockStatus(plan.legacy.data, now.getTime()) === "live") {
    throw new Error(`a hub is serving ${plan.legacy.data} (fresh .hub.lock heartbeat); stop it, then run the migration again`);
  }
  const done: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(plan.target, { recursive: true });
  writeManifest(plan.target, plan.manifest);
  const h = loadHubDir(plan.target);
  ensureRuntime(h);
  done.push(`wrote ${MANIFEST_FILE}`);
  if (plan.legacy.data) {
    const lock = path.join(plan.legacy.data, ".hub.lock");
    if (fs.existsSync(lock)) {
      fs.rmSync(lock, { force: true });
      done.push("removed the stale store lock");
    }
  }
  for (const step of plan.steps) {
    if (step.kind === "move" && step.from && step.to) {
      if (!fs.existsSync(step.from)) {
        skipped.push(step.detail);
        continue;
      }
      if (fs.existsSync(step.to)) {
        // `ensureRuntime` pre-creates the runtime tree; an EMPTY directory in the
        // way is that, and is replaced. Anything with content is never overwritten.
        const st = fs.statSync(step.to);
        if (st.isDirectory() && fs.readdirSync(step.to).length === 0) fs.rmdirSync(step.to);
        else throw new Error(`refusing to overwrite ${step.to} (from ${step.from})`);
      }
      moveTree(step.from, step.to);
      done.push(step.detail);
    } else if (step.kind === "copy" && step.from && step.to) {
      if (!fs.existsSync(step.from)) {
        skipped.push(step.detail);
        continue;
      }
      fs.mkdirSync(path.dirname(step.to), { recursive: true });
      fs.copyFileSync(step.from, step.to);
      done.push(step.detail);
    }
  }
  // Credentials, after the secrets file has moved.
  const secrets = secretsStore(h);
  if (exists(plan.legacy.humanKey)) {
    const key = fs.readFileSync(plan.legacy.humanKey, "utf8").trim();
    if (key) {
      principalsStore(h).update((f) => {
        const rec = principalRecordFor(key, opts.human ?? "operator", now);
        if (!f.principals.some((p) => p.key_sha256 === rec.key_sha256)) f.principals.push(rec);
      });
      secrets.update((s) => {
        if (!s.RFA_HUMAN_KEY) s.RFA_HUMAN_KEY = key;
      });
      done.push("recorded the human principal (hashed) and kept the operator's key in secrets.json");
    }
  }
  const current = secrets.read();
  if (current.RFA_TOKEN) {
    tokensStore(h).update((f) => {
      const sha256 = tokenDigest(current.RFA_TOKEN);
      if (!f.tokens.some((t) => t.sha256 === sha256)) {
        f.tokens.push({ id: `tk_${sha256.slice(0, 12)}`, label: "operator", kind: "operator", sha256, created_at: now.toISOString(), expires_at: null });
      }
    });
    done.push("recorded the operator bearer (hashed)");
  }
  // Rooms.
  const rooms = roomsStore(h);
  if (exists(plan.legacy.roomMd)) {
    const parsed = parseRoomMd(fs.readFileSync(plan.legacy.roomMd, "utf8"));
    if (parsed) {
      rooms.update((f) => {
        if (!f.rooms.some((r) => r.handle === parsed.handle)) {
          f.rooms.push({ alias: opts.roomAlias ?? "main", handle: parsed.handle, topic: "standing room (migrated)", join_secret: parsed.secret, operator: null, created_at: now.toISOString() });
        }
      });
      done.push(`recorded room ${parsed.handle} as \`${opts.roomAlias ?? "main"}\``);
    }
  }
  if (fs.existsSync(h.paths.opsRoom)) {
    try {
      const ops = JSON.parse(fs.readFileSync(h.paths.opsRoom, "utf8")) as { room?: string; joinSecret?: string | null };
      if (ops.room) {
        const handle = ops.room;
        rooms.update((f) => {
          if (!f.rooms.some((r) => r.handle === handle)) f.rooms.push({ alias: "ops", handle, topic: "#ops: platform alerts", join_secret: ops.joinSecret ?? null, operator: null, created_at: now.toISOString() });
        });
        done.push(`recorded the ops room ${handle}`);
      }
    } catch {
      skipped.push("ops-room.json unreadable; not recorded");
    }
  }
  if (!rooms.exists()) rooms.write({ version: 1, rooms: [] });
  // The emptied pre-0.7 directories go too, so the checkout stops looking like
  // an instance. Only when empty: anything left behind is left for a human.
  for (const dir of [plan.legacy.data, plan.legacy.dogfoodState, plan.legacy.dogfoodState ? path.dirname(plan.legacy.dogfoodState) : null]) {
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      done.push(`removed the empty ${path.relative(plan.legacy.root, dir)}/`);
    }
  }
  writeGitignore(h.paths.gitignore);
  // Every runtime file the hub will load must exist, even empty, so a missing
  // file is never mistaken for a malformed one.
  if (!fs.existsSync(h.paths.tokens)) writeJsonAtomic(h.paths.tokens, { version: 1, tokens: [] });
  if (!fs.existsSync(h.paths.principals)) writeJsonAtomic(h.paths.principals, { version: 1, principals: [] });
  if (!fs.existsSync(h.paths.secrets)) writeJsonAtomic(h.paths.secrets, {});
  done.push("wrote .gitignore");
  return { done, skipped };
}
