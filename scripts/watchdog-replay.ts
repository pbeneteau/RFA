/**
 * Replay validation for watchdog invariants (spec 20.6).
 *
 *   npx tsx scripts/watchdog-replay.ts --dir ~/rfa/acme        replay every candidate, report
 *   npx tsx scripts/watchdog-replay.ts --dir ~/rfa/acme --hours 1   bucket size (default 1h)
 *
 * Run it from inside a hub directory, or name one with `--dir` / `RFA_DIR`: this
 * repository carries no instance.
 *
 * 20.6 is a MUST NOT with teeth: an invariant may not ship until it has been
 * replayed against at least two weeks of room logs plus the observability store
 * and shown to fire on the known incidents AND NOTHING ELSE. That rule needs a
 * harness or it is decoration, because the alternative is an engineer eyeballing a
 * log once and declaring the invariant sound.
 *
 * So this script is the gate, and `src/watchdog.ts` is the invariants. It
 * reconstructs the state each one reads at a series of past instants, reports
 * every firing, marks the ones that coincide with a recorded incident, and
 * REFUSES to bless anything while the corpus is shorter than 14 days.
 *
 * It also re-measures the `replay` verdict each invariant carries and exits
 * non-zero when the measurement disagrees, because that field is what decides
 * which invariants the supervisor evaluates in production. A recorded verdict
 * nobody re-measures is a licence that cannot expire.
 *
 * Replaying without a stored history works because every invariant reads state
 * that carries its own timestamps: an engine run knows when it started and ended,
 * and a roster event is a full snapshot of the room at its own seq.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RfaEvent } from "../src/model.js";
import { HubDirError, requireHubDir } from "../src/hubdir.js";
import { INVARIANTS, measureVerdict, shippedInvariants, verdictDrift } from "../src/watchdog.js";
import type { Firing, ReplayVerdict, RoomRoster, WatchdogRun, WatchdogState } from "../src/watchdog.js";

/**
 * THE CORPUS LIVES IN A HUB DIRECTORY, not in this checkout (RFA-0.7).
 *
 * This script read `<repo>/data/rooms` and `<repo>/data/runs.db` until
 * 2026-08-31, which is the pre-0.7 layout: `agents/`, `data/` and `dogfood/`
 * were removed from this repository on 2026-08-25 and the instance became a hub
 * directory. So it had been exiting `no room logs to replay against` on the
 * first line of work ever since, while STATUS carried "re-run it and ship what
 * is still clean" as an actionable item. `test/hubdir.test.ts` greps `src/` for
 * exactly this defect and did not walk `scripts/`; it does now.
 */
const hubdir = (() => {
  try {
    const i = process.argv.indexOf("--dir");
    return requireHubDir({ dir: i >= 0 ? process.argv[i + 1] : undefined });
  } catch (err) {
    if (err instanceof HubDirError) {
      console.error(`watchdog-replay: ${err.message}\n  ${err.hint}`);
      process.exit(2);
    }
    throw err;
  }
})();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REQUIRED_SPAN_DAYS = 14; // spec 20.6
const bucketHours = Number(process.argv[process.argv.indexOf("--hours") + 1]) || 1;

/**
 * Incidents this project actually had, from the findings ledger.
 *
 * Each window runs from ONSET to REMEDIATION, not to the moment someone noticed,
 * and that distinction was learned from this harness's first run. A persistent
 * anomaly fires in every bucket until it is fixed, so windows drawn around the
 * hour of discovery made three orphaned runs look like 34 false positives spread
 * over two days. The state was genuinely broken for all of it; the invariant was
 * right every time it spoke. An invariant that fires outside every window below
 * is a false positive until somebody writes the incident down, which is the
 * standard 20.6 is asking for.
 *
 * `explains` is the second thing this harness learned about itself. Matching a
 * firing to any incident that merely OVERLAPS it in time lets a broad window
 * launder unrelated firings: extending the orphaned-runs window to its true
 * remediation made the naive observer invariant read CLEAN, when what it had
 * actually done was fire on an expired sidekick lease that had nothing to do with
 * orphaned engine runs. An incident now has to claim the invariant by name.
 */
const INCIDENTS: { name: string; from: number; to: number; explains: string[] }[] = [
  {
    // Three linear-scribe runs left 'running' when the supervisor SIGTERMed the
    // resident 38s after a human approval (heartbeat starvation). They stayed
    // stuck, holding three threads busy, until the supervisor learned to
    // reconcile orphans at start.
    name: "linear-scribe runs orphaned by the heartbeat-starvation SIGTERM, threads wedged until reconciliation shipped",
    from: Date.parse("2026-08-17T09:17:00Z"),
    to: Date.parse("2026-08-19T17:08:12Z"),
    explains: ["engine-run-stuck-running"],
  },
  {
    name: "supervisor crash left children running; duplicate residents served one membership, and a pm-agent run was orphaned",
    from: Date.parse("2026-08-19T10:00:00Z"),
    to: Date.parse("2026-08-19T17:08:12Z"),
    explains: ["engine-run-stuck-running"],
  },
  {
    name: "zombie -hitl observer memberships accumulating (5 evicted by hand on the 16th)",
    from: Date.parse("2026-08-16T12:00:00Z"),
    to: Date.parse("2026-08-17T23:59:00Z"),
    explains: ["observers-present-but-lease-expired-NAIVE", "observers-expired-beyond-prune"],
  },
];
/** The incident that explains THIS invariant firing at this instant, if any. */
const incidentFor = (id: string, t: number): string | null =>
  INCIDENTS.find((i) => i.explains.includes(id) && t >= i.from && t <= i.to)?.name ?? null;

// ---------------------------------------------------------------- the corpus

const roomFiles = fs.existsSync(hubdir.paths.roomLogs)
  ? fs.readdirSync(hubdir.paths.roomLogs).filter((f) => f.endsWith(".ndjson"))
  : [];
const rooms = new Map<string, RfaEvent[]>();
for (const f of roomFiles) {
  const events = fs
    .readFileSync(path.join(hubdir.paths.roomLogs, f), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RfaEvent);
  if (events.length > 0) rooms.set(f.replace(/\.ndjson$/, ""), events);
}
const allTs = [...rooms.values()].flat().map((e) => Date.parse(e.ts)).filter(Number.isFinite);
if (allTs.length === 0) {
  console.error("no room logs to replay against");
  process.exit(1);
}
const corpusFrom = Math.min(...allTs);
const corpusTo = Math.max(...allTs);
const spanDays = (corpusTo - corpusFrom) / DAY;

const runsDb = hubdir.paths.runsDb;
const runs: WatchdogRun[] = fs.existsSync(runsDb)
  ? (new Database(runsDb, { readonly: true })
      .prepare("SELECT run_id, agent, status, started_at, ended_at FROM runs")
      .all() as WatchdogRun[])
  : [];

// ---------------------------------------------------------------- the state

/**
 * THE INVARIANTS ARE NOT DEFINED HERE.
 *
 * They live in `src/watchdog.ts`, which is also what `src/supervisor.ts`
 * evaluates in production. This script supplies the state and the verdict; an
 * invariant validated as one copy and shipped as another validates nothing.
 *
 * What this file owns is the reconstruction: room rosters at a past instant, and
 * the full `runs` table rather than the live `running` set, because evaluating at
 * a past `t` means re-deriving which runs were running THEN from the timestamps
 * each row carries.
 */

/** The last roster snapshot at or before `t`, per room: a full member list. */
function rosterAt(t: number): RoomRoster[] {
  const out: RoomRoster[] = [];
  for (const [room, events] of rooms) {
    let latest: RfaEvent | undefined;
    for (const e of events) {
      if (Date.parse(e.ts) > t) break;
      if (e.type === "roster") latest = e;
    }
    if (latest && latest.type === "roster") out.push({ room, members: latest.members as unknown as Record<string, unknown>[] });
  }
  return out;
}

const state: WatchdogState = { runs, rosters: rosterAt };

// ---------------------------------------------------------------- the replay

console.log(`corpus: ${rooms.size} room log(s), ${allTs.length} events, ${runs.length} engine runs`);
console.log(`        ${new Date(corpusFrom).toISOString()} .. ${new Date(corpusTo).toISOString()} (${spanDays.toFixed(1)} days)`);
console.log(`        replaying in ${bucketHours}h buckets against ${INCIDENTS.length} recorded incident window(s)\n`);

let anyBlocked = false;
const measurements: { id: string; verdict: ReplayVerdict }[] = [];
for (const inv of INVARIANTS) {
  const firings: Firing[] = [];
  for (let t = corpusFrom; t <= corpusTo; t += bucketHours * HOUR) {
    const f = inv.evaluate(state, t);
    if (f) firings.push(f);
  }
  const inIncident = firings.filter((f) => incidentFor(inv.id, f.at) !== null);
  const outside = firings.filter((f) => incidentFor(inv.id, f.at) === null);
  const measured = measureVerdict(firings.length, outside.length);
  measurements.push({ id: inv.id, verdict: measured });
  console.log(`${measured.toUpperCase().padEnd(12)} ${inv.id}`);
  console.log(`             ${inv.what}`);
  console.log(`             recorded: ${inv.replay}${inv.replay === "clean" ? " (SHIPS)" : " (does not ship)"}`);
  console.log(`             ${inv.why.replace(/\s+/g, " ")}`);
  console.log(`             ${firings.length} firing bucket(s): ${inIncident.length} inside a recorded incident, ${outside.length} outside`);
  if (firings.length > 0) {
    const first = firings[0];
    console.log(`             first: ${new Date(first.at).toISOString()} ${first.detail}`);
    console.log(`                    incident: ${incidentFor(inv.id, first.at) ?? "NONE THAT CLAIMS THIS INVARIANT"}`);
  }
  if (outside.length > 0) {
    const o = outside[0];
    console.log(`             unexplained: ${new Date(o.at).toISOString()} ${o.detail}`);
  }
  if (measured !== inv.replay) console.log(`             DISAGREES WITH src/watchdog.ts: recorded \`${inv.replay}\`, measured \`${measured}\``);
  if (measured === "false-fires" && inv.replay === "clean") anyBlocked = true;
  console.log();
}

console.log(`spec 20.6 requires >= ${REQUIRED_SPAN_DAYS} days of logs before ANY invariant ships.`);
if (spanDays < REQUIRED_SPAN_DAYS) {
  console.log(`NOT SHIPPABLE: the corpus is ${spanDays.toFixed(1)} days, ${(REQUIRED_SPAN_DAYS - spanDays).toFixed(1)} short.`);
  console.log("The verdicts above are a dry run: they say what these invariants WOULD have said, not that they may ship.");
  process.exit(0);
}
if (anyBlocked) {
  console.log("NOT SHIPPABLE: a SHIPPED invariant fired outside every recorded incident. Unship it, fix it, or record the incident.");
  process.exit(1);
}
// The recorded verdicts are re-measured, not trusted: `src/watchdog.ts` ships on
// the strength of that field, so a field that has drifted from what the corpus
// says is a shipped invariant holding a stale licence.
const disagreed = verdictDrift(measurements);
if (disagreed.length > 0) {
  console.log("VERDICTS DRIFTED from src/watchdog.ts, which is what production evaluates:");
  for (const d of disagreed) console.log(`  ${d}`);
  console.log("Update the `replay` field and its `why` to what this corpus measures, or explain the difference.");
  process.exit(1);
}
console.log(`Corpus long enough; every verdict matches src/watchdog.ts. Shipped: ${shippedInvariants().map((i) => i.id).join(", ")}`);
