/**
 * `backup` and `service`: the operator duties that are not about rooms.
 *
 * A backup is the supervisor's nightly done on demand, from the same plan, into
 * the same place (`retention.backup_dir`, outside the hub directory on purpose:
 * a backup inside the thing backed up is not one). A restore refuses to touch a
 * store whose hub or supervisor is still serving, writes a safety backup first,
 * and then puts the files back exactly where the plan took them from.
 *
 * A service is the hub and the supervisor as foreground processes under the
 * user's launchd or systemd, with the same `rfa hub run` / `rfa supervisor run`
 * entries `rfa up` daemonizes, so there is one way to run them and the init
 * system only adds boot and restart.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonState } from "../../daemon.js";
import type { HubDir } from "../../hubdir.js";
import { packageFile } from "../../pkg.js";
import { backupPlan, runBackup } from "../../platform.js";
import { entryFor, nodeArgsFor } from "../../proc.js";
import { CliError } from "../context.js";
import type { CommandDef } from "../router.js";

// ---------------------------------------------------------------- backup

function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = dirSize(full);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += fs.statSync(full).size;
      files++;
    }
  }
  return { bytes, files };
}

const fmtBytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} kB` : `${n} B`);

function listBackups(h: HubDir): { day: string; dir: string; files: number; bytes: number; written_at: string }[] {
  if (!fs.existsSync(h.paths.backups)) return [];
  return fs
    .readdirSync(h.paths.backups, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(h.paths.backups, e.name);
      const { bytes, files } = dirSize(dir);
      return { day: e.name, dir, files, bytes, written_at: fs.statSync(dir).mtime.toISOString() };
    })
    .sort((a, b) => (a.day < b.day ? 1 : -1));
}

export const backupNow: CommandDef = {
  path: ["backup", "now"],
  summary: "Write a dated backup of every store, the same one the supervisor writes nightly",
  usage: "[--keep <n>]",
  options: { keep: { type: "string" } },
  why: "SQLite databases through the driver's own .backup (WAL-safe), plus one archive of the room logs, the supervisor state, the four runtime files and every pack's memory. The destination is retention.backup_dir in rfa.json, outside the hub directory, and the newest --keep (default retention.backup_keep) are kept.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const keep = a.values.keep ? Number(a.values.keep) : h.manifest.retention.backup_keep;
    if (!Number.isInteger(keep) || keep < 1) throw new CliError(2, "--keep takes a whole number of backups to keep, at least 1");
    const sp = ctx.ui.spinner(`backing up ${h.manifest.name} to ${h.paths.backups}`);
    const res = await runBackup({ root: h.root, ...backupPlan(h), destRoot: h.paths.backups, keep });
    sp.stop({ ok: true, text: `backup written: ${res.dest}`, detail: `${res.files.length} database(s) + archive · ${res.kept.length} kept` });
    if (ctx.flags.json) ctx.ui.json({ dest: res.dest, files: res.files, kept: res.kept });
  },
};

export const backupLs: CommandDef = {
  path: ["backup", "ls"],
  summary: "The backups on disk, newest first",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const rows = listBackups(h);
    if (ctx.flags.json) return void ctx.ui.json({ dir: h.paths.backups, backups: rows });
    if (rows.length === 0) return void ctx.ui.line(ctx.ui.dim(`no backups at ${h.paths.backups}: rfa backup now writes one, the supervisor writes one nightly`));
    ctx.ui.line(ctx.ui.dim(h.paths.backups));
    ctx.ui.table(rows.map((r) => [r.day, `${r.files} file(s)`, fmtBytes(r.bytes), ctx.ui.dim(r.written_at)]), { align: ["l", "r", "r", "l"] });
  },
};

interface RestorePlan {
  day: string;
  dir: string;
  databases: { from: string; to: string }[];
  archive: string | null;
  archiveEntries: number;
}

function restorePlan(h: HubDir, day: string): RestorePlan {
  const dir = path.join(h.paths.backups, day);
  if (!fs.existsSync(dir)) throw new CliError(2, `no backup named ${day} at ${h.paths.backups}`, "rfa backup ls");
  const databases = fs
    .readdirSync(dir)
    .filter((f) => f.includes("__") || f.endsWith(".db"))
    .filter((f) => !f.endsWith(".tar.gz"))
    // The backup names a database by its path relative to the root, with `__` for the separator.
    .map((f) => ({ from: path.join(dir, f), to: path.join(h.root, ...f.split("__")) }));
  const archive = path.join(dir, "dirs.tar.gz");
  let archiveEntries = 0;
  if (fs.existsSync(archive)) {
    const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    archiveEntries = listing.split("\n").filter((l) => l.trim() && !l.endsWith("/")).length;
  }
  return { day, dir, databases, archive: fs.existsSync(archive) ? archive : null, archiveEntries };
}

export const backupRestore: CommandDef = {
  path: ["backup", "restore"],
  summary: "Put a backup's files back, after a safety backup of what is there now",
  usage: "<day> [--dry-run]",
  options: { "dry-run": { type: "boolean", default: false } },
  why: "Refused while the hub or the supervisor is running: a database replaced under a process that holds it open is corruption, not a restore. The current state is backed up first under pre-restore-<instant>, so a restore is itself reversible. Stale -wal and -shm files beside a restored database are removed, since a write-ahead log from another lineage would be replayed into the restored file.",
  examples: ["rfa backup restore 2026-08-21 --dry-run", "rfa backup restore 2026-08-21"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const day = a.positionals[0];
    if (!day) throw new CliError(2, "rfa backup restore <day>", "rfa backup ls");
    const plan = restorePlan(h, day);
    if (ctx.flags.json && a.values["dry-run"]) return void ctx.ui.json({ plan, dry_run: true });
    if (!ctx.flags.json) {
      ctx.ui.line(`${ctx.ui.bold(`restore ${day}`)} from ${ctx.ui.dim(plan.dir)}`);
      for (const d of plan.databases) ctx.ui.step(`database ${path.relative(h.root, d.to)}`);
      if (plan.archive) ctx.ui.step(`archive: ${plan.archiveEntries} file(s) into ${h.root}`);
      if (!plan.archive && plan.databases.length === 0) ctx.ui.warn("this backup holds nothing to restore");
    }
    if (a.values["dry-run"]) return;
    const running = [daemonState(h.paths.hubPid), daemonState(h.paths.supervisorPid)].filter((s) => s.alive);
    if (running.length) throw new CliError(3, "the hub or the supervisor is running; a store cannot be replaced under a process that holds it open", "rfa down, then restore");
    if (!ctx.flags.yes) {
      if (!ctx.interactive) throw new CliError(2, "pass --yes to restore without a prompt");
      const p = await import("@clack/prompts");
      const ok = await p.confirm({ message: `Replace the current state of ${h.manifest.name} with ${day}? A safety backup is written first.`, initialValue: false });
      if (p.isCancel(ok) || !ok) return 1;
    }
    const stamp = `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const safety = await runBackup({ root: h.root, ...backupPlan(h), destRoot: h.paths.backups, keep: 10_000, day: stamp });
    for (const d of plan.databases) {
      fs.mkdirSync(path.dirname(d.to), { recursive: true });
      fs.copyFileSync(d.from, d.to);
      for (const side of ["-wal", "-shm"]) fs.rmSync(d.to + side, { force: true });
    }
    if (plan.archive) execFileSync("tar", ["-xzf", plan.archive, "-C", h.root]);
    if (ctx.flags.json) return void ctx.ui.json({ restored: day, databases: plan.databases.map((d) => d.to), archive_entries: plan.archiveEntries, safety_backup: safety.dest });
    ctx.ui.done(`restored ${day}`, `${plan.databases.length} database(s), ${plan.archiveEntries} archived file(s)`);
    ctx.ui.note(`what was there is under ${safety.dest}`, "rfa up brings the hub back on the restored state");
  },
};

// ---------------------------------------------------------------- service

type Platform = "darwin" | "linux";

interface ServiceUnit {
  id: "hub" | "supervisor";
  label: string;
  file: string;
  text: string;
  log: string;
}

/** POSIX single-quoting, for the one shell line the init system runs. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template placeholder ${k} has no value`);
    return vars[k];
  });
}

export function serviceUnits(h: HubDir, platform: Platform, home = os.homedir()): ServiceUnit[] {
  const cli = entryFor(import.meta.url, "../main");
  const ids: ("hub" | "supervisor")[] = h.mode === "hub" ? ["hub", "supervisor"] : ["supervisor"];
  return ids.map((id) => {
    const command = [process.execPath, ...nodeArgsFor(cli), id, "run", "--dir", h.root].map(shq).join(" ");
    const log = id === "hub" ? h.paths.hubLog : h.paths.supervisorLog;
    if (platform === "darwin") {
      const label = `rfa.${h.manifest.name}.${id}`;
      const text = render(fs.readFileSync(packageFile("templates", "service", "launchd.plist"), "utf8"), { LABEL: xml(label), ROOT: xml(shq(h.root)), COMMAND: xml(command), LOG: xml(log) });
      return { id, label, file: path.join(home, "Library", "LaunchAgents", `${label}.plist`), text, log };
    }
    const label = `rfa-${h.manifest.name}-${id}`;
    const text = render(fs.readFileSync(packageFile("templates", "service", "systemd.service"), "utf8"), { DESCRIPTION: `RFA ${id} for ${h.manifest.name}`, ROOT: h.root, COMMAND: command.replace(/'/g, "'\\''"), LOG: log });
    return { id, label, file: path.join(home, ".config", "systemd", "user", `${label}.service`), text, log };
  });
}

function platformOf(a: { values: Record<string, unknown> }): Platform {
  const p = (a.values.platform as string | undefined) ?? process.platform;
  if (p !== "darwin" && p !== "linux") throw new CliError(2, `no service template for ${p}`, "launchd (darwin) and systemd (linux) are supported; --print --platform <one of them> renders the unit anyway");
  return p;
}

const uid = () => process.getuid?.() ?? 501;

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr ?? (err as Error).message) };
  }
}

function systemctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    return { ok: false, out: String((err as { stdout?: string }).stdout ?? (err as Error).message) };
  }
}

function unitState(u: ServiceUnit, platform: Platform): { installed: boolean; state: string; pid: number | null } {
  const installed = fs.existsSync(u.file);
  if (platform === "darwin") {
    const r = launchctl(["print", `gui/${uid()}/${u.label}`]);
    if (!r.ok) return { installed, state: installed ? "not loaded" : "not installed", pid: null };
    const pid = /\bpid = (\d+)/.exec(r.out)?.[1];
    const state = /\bstate = (\w+)/.exec(r.out)?.[1] ?? (pid ? "running" : "loaded");
    return { installed, state, pid: pid ? Number(pid) : null };
  }
  const active = systemctl(["is-active", u.label]).out.trim() || "unknown";
  const pid = /MainPID=(\d+)/.exec(systemctl(["show", "-p", "MainPID", u.label]).out)?.[1];
  return { installed, state: active, pid: pid && pid !== "0" ? Number(pid) : null };
}

export const serviceInstall: CommandDef = {
  path: ["service", "install"],
  summary: "Run the hub and the supervisor at login, under launchd or systemd",
  usage: "[--print] [--platform darwin|linux]",
  options: { print: { type: "boolean", default: false }, platform: { type: "string" } },
  why: "The units run `rfa hub run` and `rfa supervisor run` through a login shell, so the model credential and PATH are the ones the operator has; logs go to .rfa/logs/. Refused while `rfa up` daemons are running: two hubs on one store is what the lockfile exists to prevent, and the service would lose that race on every boot. The supervisor unit may restart a few times at boot until the hub answers; that is the init system's throttle, not an error. --print renders the units without installing.",
  examples: ["rfa service install --print", "rfa service install"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const platform = platformOf(a);
    const units = serviceUnits(h, platform);
    if (a.values.print) {
      if (ctx.flags.json) return void ctx.ui.json({ platform, units: units.map((u) => ({ id: u.id, label: u.label, file: u.file, text: u.text })) });
      for (const u of units) process.stdout.write(`# ${u.file}\n${u.text}\n`);
      return;
    }
    if (platform !== process.platform) throw new CliError(2, `this machine is ${process.platform}; --platform ${platform} only makes sense with --print`);
    const running = [daemonState(h.paths.hubPid), daemonState(h.paths.supervisorPid)].filter((s) => s.alive);
    if (running.length) throw new CliError(3, "rfa up daemons are running; the service would start a second hub on the same store", "rfa down, then install");
    for (const u of units) {
      fs.mkdirSync(path.dirname(u.file), { recursive: true });
      fs.writeFileSync(u.file, u.text);
    }
    const results: { id: string; label: string; file: string; ok: boolean; detail: string }[] = [];
    if (platform === "darwin") {
      for (const u of units) {
        launchctl(["bootout", `gui/${uid()}/${u.label}`]);
        const r = launchctl(["bootstrap", `gui/${uid()}`, u.file]);
        results.push({ id: u.id, label: u.label, file: u.file, ok: r.ok, detail: r.ok ? "loaded" : r.out.trim() });
      }
    } else {
      const reload = systemctl(["daemon-reload"]);
      for (const u of units) {
        const r = reload.ok ? systemctl(["enable", "--now", u.label]) : reload;
        results.push({ id: u.id, label: u.label, file: u.file, ok: r.ok, detail: r.ok ? "enabled" : r.out.trim() });
      }
    }
    if (ctx.flags.json) return void ctx.ui.json({ platform, installed: results });
    for (const r of results) {
      if (r.ok) ctx.ui.done(`${r.label} ${r.detail}`, r.file);
      else ctx.ui.fail(`${r.label}: ${r.detail}`, r.file);
    }
    ctx.ui.note("rfa service status shows the units; rfa status shows what they are serving");
    if (results.some((r) => !r.ok)) return 1;
  },
};

export const serviceUninstall: CommandDef = {
  path: ["service", "uninstall"],
  summary: "Stop the units and remove them",
  options: { platform: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const platform = platformOf(a);
    if (platform !== process.platform) throw new CliError(2, `this machine is ${process.platform}`);
    const removed: string[] = [];
    for (const u of serviceUnits(h, platform)) {
      if (platform === "darwin") launchctl(["bootout", `gui/${uid()}/${u.label}`]);
      else systemctl(["disable", "--now", u.label]);
      if (fs.existsSync(u.file)) {
        fs.rmSync(u.file);
        removed.push(u.label);
      }
    }
    if (platform === "linux") systemctl(["daemon-reload"]);
    if (ctx.flags.json) return void ctx.ui.json({ removed });
    if (removed.length === 0) ctx.ui.line(ctx.ui.dim("no units were installed"));
    for (const r of removed) ctx.ui.done(`${r} removed`);
  },
};

export const serviceStatus: CommandDef = {
  path: ["service", "status"],
  summary: "Whether the units are installed, loaded and running",
  options: { platform: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const platform = platformOf(a);
    const rows = serviceUnits(h, platform).map((u) => ({ id: u.id, label: u.label, file: u.file, ...unitState(u, platform) }));
    if (ctx.flags.json) return void ctx.ui.json({ platform, units: rows });
    ctx.ui.table(rows.map((r) => [r.id, r.label, r.installed ? (r.pid ? ctx.ui.good(`${r.state} pid ${r.pid}`) : ctx.ui.caution(r.state)) : ctx.ui.dim("not installed"), ctx.ui.dim(r.file)]));
    if (rows.every((r) => !r.installed)) ctx.ui.note("rfa service install writes and loads them");
  },
};
