/**
 * Platform duties shared by the supervisor and callable directly (v0.4 spec
 * 3.9): the nightly backup. Extracted so the mechanism is testable and can be
 * exercised once by hand (the restore procedure is only real if it has run).
 */
import { scanPacks, type BrokenPack } from "./agentdef.js";
import type { HubDir } from "./hubdir.js";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * What a backup of a hub directory holds: every SQLite store (the engine DB, the
 * observability DB, each pack's memory DB), and one archive of the room logs,
 * the supervisor's state, the four runtime files and every pack's memory
 * directory. One list, used by the supervisor's nightly and by `rfa backup now`,
 * so the two cannot drift apart.
 *
 * TOLERANT of a pack that does not parse, and it therefore backs up STRICTLY
 * MORE than the loud version did. `listPacks` maps `loadPack` with no catch, so
 * one unparseable `agent.md` threw out of here and took the ENTIRE backup with
 * it: no engine DB, no observability DB, no room logs, no secrets, no memory for
 * any pack, over a typo in one file, and nightly for as long as it stood. A
 * backup must never be prevented by an unrelated typo. Nothing in this plan
 * comes from a parsed definition (the paths come from the directory listing), so
 * a broken pack's own `state/memory.db` and `memory/` go into the archive too,
 * which is exactly when an operator wants them. `broken` travels out so
 * `rfa backup now` and the supervisor's nightly can NAME the pack instead of
 * leaving the operator to infer it was skipped, which it was not.
 */
export function backupPlan(h: HubDir): { dbs: string[]; dirs: string[]; broken: BrokenPack[] } {
  const p = h.paths;
  const rel = (f: string) => path.relative(h.root, f);
  const { packs, broken } = scanPacks(p.agents);
  const packDirs = [...packs.map((pack) => pack.dir), ...broken.map((b) => path.join(p.agents, b.name))];
  return {
    dbs: [p.runsDb, p.obsDb, ...packDirs.map((d) => path.join(d, "state", "memory.db"))],
    dirs: [rel(p.roomLogs), rel(p.supervisor), rel(p.secrets), rel(p.principals), rel(p.tokens), rel(p.rooms), ...packDirs.map((d) => rel(path.join(d, "memory")))],
    broken,
  };
}

export interface BackupResult {
  dest: string;
  files: string[];
  kept: string[];
}

/**
 * Write a dated backup: sqlite `.backup` (WAL-safe) of every DB that exists,
 * plus one tar of the given directories, then rotate to the newest `keep`.
 */
export async function runBackup(opts: {
  root: string;
  dbs: string[];
  dirs: string[];
  destRoot: string;
  keep: number;
  day?: string;
}): Promise<BackupResult> {
  const day = opts.day ?? new Date().toISOString().slice(0, 10);
  const dest = path.join(opts.destRoot, day);
  fs.mkdirSync(dest, { recursive: true });
  const files: string[] = [];
  for (const db of opts.dbs.filter((f) => fs.existsSync(f))) {
    const out = path.join(dest, path.relative(opts.root, db).replaceAll(path.sep, "__"));
    // better-sqlite3's own backup, not the sqlite3 CLI: the driver is already a
    // dependency, the CLI is not guaranteed to exist, and shelling out put the
    // destination path through a shell-quoted string. The plain-copy fallback
    // stays because a corrupt-but-present backup file is worse than a warned
    // one, but it is now genuinely last-resort: with WAL enabled a byte copy
    // can miss committed transactions still in the -wal file.
    try {
      const { default: Database } = await import("better-sqlite3");
      const src = new Database(db, { readonly: true });
      try {
        await src.backup(out);
      } finally {
        src.close();
      }
    } catch (err) {
      console.error(`backup: driver backup of ${db} failed (${(err as Error).message}); falling back to a byte copy, which may miss WAL commits`);
      fs.copyFileSync(db, out);
    }
    files.push(out);
  }
  const dirs = opts.dirs.filter((d) => fs.existsSync(path.join(opts.root, d)));
  if (dirs.length > 0) {
    const tarOut = path.join(dest, "dirs.tar.gz");
    await execFileP("tar", ["-czf", tarOut, "-C", opts.root, ...dirs], { maxBuffer: 32 * 1024 * 1024 });
    files.push(tarOut);
  }
  const dated = fs
    .readdirSync(opts.destRoot)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  for (const old of dated.slice(0, Math.max(0, dated.length - opts.keep))) {
    fs.rmSync(path.join(opts.destRoot, old), { recursive: true, force: true });
  }
  return { dest, files, kept: dated.slice(-opts.keep) };
}
