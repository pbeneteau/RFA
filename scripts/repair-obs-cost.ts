/**
 * One-time repair for observability rows whose `cost_usd` is a day ledger.
 *
 *   npx tsx scripts/repair-obs-cost.ts                 # dry run, prints what it would change
 *   npx tsx scripts/repair-obs-cost.ts -- --apply      # write it
 *   npx tsx scripts/repair-obs-cost.ts -- --before 2026-08-19T17:00:00Z --apply
 *
 * The bug (fixed 2026-08-19 in src/resident.ts): a serve turn stopped by a budget
 * or turn ceiling recorded `BudgetStop.spendUsd`, the DAY's running total, as that
 * run's own `cost_usd`. Eleven refusals that made no model call at all were each
 * recorded at $7.9831, and 98 of 99 error rows carried a ledger value: $351.84 of
 * the $372.91 total cost in the store, so 94% of the recorded spend was this one
 * line. It was found by the #ops review digest, whose p90-cost queue read those
 * rows and reported a plausible-looking p90 of $2.96 per run.
 *
 * Identifying the affected rows is exact rather than heuristic: on the error path
 * only the BudgetStop branch ever wrote a cost at all, every other failure wrote
 * NULL. So an error row with a non-NULL cost, written before the fix, IS one of
 * these rows.
 *
 * What it writes, and why not one single value:
 *   - a run of 1ms or less never reached the model (the ceiling was checked at
 *     pickup), so its true cost is 0 and that is what it gets;
 *   - a run with real duration did spend, but how much is not recoverable from
 *     the record, so it gets NULL, which is the store's way of saying unknown.
 *     Guessing a number here would be the same class of mistake as the bug.
 *
 * Run it ONCE, against data written before the fix. After the fix an error row's
 * cost is that run's own cost and must be left alone, which is what `--before` is
 * for.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { HubDirError, requireHubDir } from "../src/hubdir.js";

/**
 * The obs store lives in a HUB DIRECTORY, never in this checkout (RFA-0.7): the
 * repository's `data/` was removed on 2026-08-25. Run this from inside one, or
 * name it with `--dir` / `RFA_DIR`.
 */
const DB = (() => {
  try {
    const i = process.argv.indexOf("--dir");
    return requireHubDir({ dir: i >= 0 ? process.argv[i + 1] : undefined }).paths.obsDb;
  } catch (err) {
    if (err instanceof HubDirError) {
      console.error(`repair-obs-cost: ${err.message}\n  ${err.hint}`);
      process.exit(2);
    }
    throw err;
  }
})();
const apply = process.argv.includes("--apply");
const beforeArg = process.argv[process.argv.indexOf("--before") + 1];
const before = process.argv.includes("--before") ? Date.parse(beforeArg) : Date.now();
if (!Number.isFinite(before)) {
  console.error(`--before must be an ISO timestamp, got ${beforeArg}`);
  process.exit(2);
}
if (!fs.existsSync(DB)) {
  console.error(`no observability store at ${DB}`);
  process.exit(1);
}

const db = new Database(DB);
const rows = db
  .prepare(
    `SELECT id, name, cost_usd, (end_time - start_time) AS ms, error
     FROM runs WHERE status = 'error' AND cost_usd IS NOT NULL AND end_time < ?`,
  )
  .all(before) as { id: string; name: string; cost_usd: number; ms: number; error: string | null }[];

const zeroed = rows.filter((r) => r.ms <= 1);
const unknown = rows.filter((r) => r.ms > 1);
const total = rows.reduce((a, r) => a + r.cost_usd, 0);

console.log(`${rows.length} error row(s) carrying a cost, written before ${new Date(before).toISOString()}`);
console.log(`  $${total.toFixed(2)} of recorded cost removed from the store`);
console.log(`  ${zeroed.length} never reached the model (<=1ms) -> cost_usd = 0`);
console.log(`  ${unknown.length} spent an unrecoverable amount        -> cost_usd = NULL`);
for (const r of rows.slice(0, 5)) {
  console.log(`    ${r.id} ${r.name} $${r.cost_usd.toFixed(4)} ${r.ms}ms  ${String(r.error).slice(0, 50)}`);
}
if (rows.length > 5) console.log(`    ... and ${rows.length - 5} more`);

if (!apply) {
  console.log("\ndry run: pass --apply to write it");
  db.close();
  process.exit(0);
}

const tx = db.transaction(() => {
  const setZero = db.prepare("UPDATE runs SET cost_usd = 0 WHERE id = ?");
  const setNull = db.prepare("UPDATE runs SET cost_usd = NULL WHERE id = ?");
  for (const r of zeroed) setZero.run(r.id);
  for (const r of unknown) setNull.run(r.id);
});
tx();
const after = db
  .prepare("SELECT ROUND(SUM(cost_usd), 2) AS c FROM runs WHERE cost_usd IS NOT NULL")
  .get() as { c: number | null };
console.log(`\napplied. total recorded cost in the store is now $${(after.c ?? 0).toFixed(2)}`);
db.close();
