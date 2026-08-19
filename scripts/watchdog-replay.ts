/**
 * Replay validation for watchdog invariants (spec 20.6).
 *
 *   npx tsx scripts/watchdog-replay.ts                 # replay every candidate, report
 *   npx tsx scripts/watchdog-replay.ts -- --hours 1    # bucket size (default 1h)
 *
 * 20.6 is a MUST NOT with teeth: an invariant may not ship until it has been
 * replayed against at least two weeks of room logs plus the observability store
 * and shown to fire on the known incidents AND NOTHING ELSE. That rule needs a
 * harness or it is decoration, because the alternative is an engineer eyeballing a
 * log once and declaring the invariant sound.
 *
 * So this script is the gate, not the invariants. It reconstructs the state each
 * candidate reads at a series of past instants, reports every firing, marks the
 * ones that coincide with a recorded incident, and REFUSES to bless anything while
 * the corpus is shorter than 14 days. Today the corpus is about 3 days, so the
 * honest output is "not shippable yet, here is what they would have said".
 *
 * Replaying without a stored history works because both candidates read state that
 * carries its own timestamps: an engine run knows when it started and ended, and a
 * roster event is a full snapshot of the room at its own seq.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RfaEvent } from "../src/model.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
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

const roomFiles = fs.existsSync(path.join(ROOT, "data", "rooms"))
  ? fs.readdirSync(path.join(ROOT, "data", "rooms")).filter((f) => f.endsWith(".ndjson"))
  : [];
const rooms = new Map<string, RfaEvent[]>();
for (const f of roomFiles) {
  const events = fs
    .readFileSync(path.join(ROOT, "data", "rooms", f), "utf8")
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

const runsDb = path.join(ROOT, "data", "runs.db");
type RunRow = { run_id: string; agent: string; status: string; started_at: string | null; ended_at: string | null };
const runs: RunRow[] = fs.existsSync(runsDb)
  ? (new Database(runsDb, { readonly: true })
      .prepare("SELECT run_id, agent, status, started_at, ended_at FROM runs")
      .all() as RunRow[])
  : [];

// ---------------------------------------------------------------- candidates

type Firing = { at: number; detail: string };
type Candidate = { id: string; what: string; shippable: boolean; note?: string; evaluate: (t: number) => Firing | null };

/** The last roster snapshot at or before `t`, per room: a full member list. */
function rosterAt(t: number): { room: string; members: Record<string, unknown>[] }[] {
  const out: { room: string; members: Record<string, unknown>[] }[] = [];
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

const STUCK_AFTER_MS = 2 * HOUR; // must exceed a legitimate 30-minute approval wait

const candidates: Candidate[] = [
  {
    id: "engine-run-stuck-running",
    what: `an engine run has been 'running' for more than ${STUCK_AFTER_MS / HOUR}h`,
    shippable: true,
    note: "spec 20.6 REQUIRES this one: it is the only anomaly that was present in live state",
    evaluate: (t) => {
      const stuck = runs.filter((r) => {
        if (!r.started_at) return false;
        const started = Date.parse(r.started_at);
        if (!Number.isFinite(started) || started > t) return false;
        const ended = r.ended_at ? Date.parse(r.ended_at) : null;
        const runningAtT = ended === null || ended > t;
        return runningAtT && t - started > STUCK_AFTER_MS;
      });
      return stuck.length === 0 ? null : { at: t, detail: `${stuck.length} run(s): ${stuck.slice(0, 3).map((r) => `${r.run_id}/${r.agent}`).join(", ")}` };
    },
  },
  {
    id: "observers-present-but-lease-expired-NAIVE",
    what: "any observer is present with an expired lease",
    shippable: false,
    note: "the form spec 20.6 predicts false-fires: an expired lease is NORMAL for up to the 24h prune window",
    evaluate: (t) => {
      const hits: string[] = [];
      for (const { room, members } of rosterAt(t)) {
        for (const m of members) {
          const role = String(m.role ?? "");
          const exp = m.lease_expires ? Date.parse(String(m.lease_expires)) : NaN;
          if (role === "observer" && Number.isFinite(exp) && exp < t) hits.push(`${room}/${String(m.name)}`);
        }
      }
      return hits.length === 0 ? null : { at: t, detail: `${hits.length}: ${hits.slice(0, 3).join(", ")}` };
    },
  },
  {
    id: "observers-expired-beyond-prune",
    what: "an observer's lease expired more than 24h ago, so the prune should have taken it",
    shippable: true,
    note: "20.6's corrected form of the invariant above",
    evaluate: (t) => {
      const hits: string[] = [];
      for (const { room, members } of rosterAt(t)) {
        for (const m of members) {
          const role = String(m.role ?? "");
          const exp = m.lease_expires ? Date.parse(String(m.lease_expires)) : NaN;
          if (role === "observer" && Number.isFinite(exp) && t - exp > DAY) hits.push(`${room}/${String(m.name)}`);
        }
      }
      return hits.length === 0 ? null : { at: t, detail: `${hits.length}: ${hits.slice(0, 3).join(", ")}` };
    },
  },
];

// ---------------------------------------------------------------- the replay

console.log(`corpus: ${rooms.size} room log(s), ${allTs.length} events, ${runs.length} engine runs`);
console.log(`        ${new Date(corpusFrom).toISOString()} .. ${new Date(corpusTo).toISOString()} (${spanDays.toFixed(1)} days)`);
console.log(`        replaying in ${bucketHours}h buckets against ${INCIDENTS.length} recorded incident window(s)\n`);

let anyBlocked = false;
for (const c of candidates) {
  const firings: Firing[] = [];
  for (let t = corpusFrom; t <= corpusTo; t += bucketHours * HOUR) {
    const f = c.evaluate(t);
    if (f) firings.push(f);
  }
  const inIncident = firings.filter((f) => incidentFor(c.id, f.at) !== null);
  const outside = firings.filter((f) => incidentFor(c.id, f.at) === null);
  const verdict = firings.length === 0 ? "SILENT" : outside.length === 0 ? "CLEAN" : "FALSE-FIRES";
  console.log(`${verdict.padEnd(12)} ${c.id}`);
  console.log(`             ${c.what}`);
  if (c.note) console.log(`             note: ${c.note}`);
  console.log(`             ${firings.length} firing bucket(s): ${inIncident.length} inside a recorded incident, ${outside.length} outside`);
  if (firings.length > 0) {
    const first = firings[0];
    console.log(`             first: ${new Date(first.at).toISOString()} ${first.detail}`);
    console.log(`                    incident: ${incidentFor(c.id, first.at) ?? "NONE THAT CLAIMS THIS INVARIANT"}`);
  }
  if (outside.length > 0) {
    const o = outside[0];
    console.log(`             unexplained: ${new Date(o.at).toISOString()} ${o.detail}`);
  }
  if (verdict === "FALSE-FIRES" && c.shippable) anyBlocked = true;
  console.log();
}

console.log(`spec 20.6 requires >= ${REQUIRED_SPAN_DAYS} days of logs before ANY invariant ships.`);
if (spanDays < REQUIRED_SPAN_DAYS) {
  console.log(`NOT SHIPPABLE: the corpus is ${spanDays.toFixed(1)} days, ${(REQUIRED_SPAN_DAYS - spanDays).toFixed(1)} short.`);
  console.log("The verdicts above are a dry run: they say what these invariants WOULD have said, not that they may ship.");
  process.exit(0);
}
if (anyBlocked) {
  console.log("NOT SHIPPABLE: a candidate marked shippable fired outside every recorded incident. Fix it or record the incident.");
  process.exit(1);
}
console.log("Corpus long enough and no shippable candidate false-fires.");
