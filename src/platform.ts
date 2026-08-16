/**
 * Platform duties shared by the supervisor and callable directly (v0.4 spec
 * 3.9): the nightly backup. Extracted so the mechanism is testable and can be
 * exercised once by hand (the restore procedure is only real if it has run).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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
    try {
      await execFileP("sqlite3", [db, `.backup '${out}'`]);
    } catch {
      fs.copyFileSync(db, out); // no sqlite3 CLI: plain copy (WAL risk accepted for the fallback)
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
