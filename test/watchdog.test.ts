/** Watchdog invariants (RFA-0.5 sect. 20.6): the shipping gate, the one shipped invariant, and the single definition. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Engine } from "../src/engine.js";
import {
  INVARIANTS,
  STUCK_AFTER_MS,
  measureVerdict,
  verdictDrift,
  evaluateWatchdog,
  shippedInvariants,
  watchdogAlerts,
  watchdogFailures,
  type WatchdogRun,
  type WatchdogState,
} from "../src/watchdog.js";

const NOW = Date.parse("2026-08-30T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const stuck = INVARIANTS.find((i) => i.id === "engine-run-stuck-running")!;
const state = (runs: WatchdogRun[]): WatchdogState => ({ runs, rosters: null });
const run = (o: Partial<WatchdogRun>): WatchdogRun => ({
  run_id: "r1",
  agent: "pm-agent",
  status: "running",
  started_at: null,
  ended_at: null,
  ...o,
});

test("20.6 ships only what replay measured clean, and records why for the rest", () => {
  // The gate is the point of the module: a false-firing invariant MUST NOT ship,
  // and a silent one has not been shown to fire on anything, so it has not met
  // 20.6's bar either.
  assert.deepEqual(
    shippedInvariants().map((i) => i.id),
    ["engine-run-stuck-running"],
  );
  for (const inv of INVARIANTS) {
    assert.equal(inv.replay === "clean", shippedInvariants().includes(inv), `${inv.id}: shipped iff clean`);
    assert.ok(inv.why.length > 40, `${inv.id} must record why it carries its verdict`);
  }
  assert.equal(INVARIANTS.find((i) => i.id === "observers-present-but-lease-expired-NAIVE")!.replay, "false-fires");
  assert.equal(INVARIANTS.find((i) => i.id === "observers-expired-beyond-prune")!.replay, "silent");
});

test("engine-run-stuck-running: fires past the threshold, silent at it", () => {
  const just = state([run({ started_at: iso(NOW - STUCK_AFTER_MS) })]);
  assert.equal(stuck.evaluate(just, NOW), null, "exactly at the threshold is not yet stuck");
  const over = state([run({ started_at: iso(NOW - STUCK_AFTER_MS - 60_000) })]);
  const firing = stuck.evaluate(over, NOW);
  assert.ok(firing, "one minute past the threshold fires");
  assert.match(firing!.detail, /1 run\(s\) stuck 'running' \(oldest 2\.0h\): r1\/pm-agent/);
});

test("engine-run-stuck-running: a settled, a future and an unstarted run are all quiet", () => {
  const old = iso(NOW - 10 * 3_600_000);
  // ended before `at`: it ran long, it is not stuck
  assert.equal(stuck.evaluate(state([run({ started_at: old, ended_at: iso(NOW - 3_600_000) })]), NOW), null);
  // ended after `at`: still running AT `at`, which is what the replay depends on
  assert.ok(stuck.evaluate(state([run({ started_at: old, ended_at: iso(NOW + 3_600_000) })]), NOW));
  // started after `at`: not yet born at the evaluation instant
  assert.equal(stuck.evaluate(state([run({ started_at: iso(NOW + 60_000) })]), NOW), null);
  // pending: no started_at at all, so no age to judge
  assert.equal(stuck.evaluate(state([run({ status: "pending" })]), NOW), null);
  assert.equal(stuck.evaluate(state([run({ started_at: "not a date" })]), NOW), null);
});

test("engine-run-stuck-running: reports the count, the oldest age, and at most three names", () => {
  const runs = [1, 2, 3, 4].map((n) => run({ run_id: `r${n}`, agent: `a${n}`, started_at: iso(NOW - (2 + n) * 3_600_000) }));
  const firing = stuck.evaluate(state(runs), NOW)!;
  assert.match(firing.detail, /^4 run\(s\) stuck 'running' \(oldest 6\.0h\): r1\/a1, r2\/a2, r3\/a3, …$/);
});

test("one stuck run at zero other traffic raises an alert: a state check carries no volume guard", () => {
  // The inverse cost this project a day of silence: an error RATE with a
  // minimum-run guard said nothing while a credential failed 100% of one run.
  const alerts = watchdogAlerts(state([run({ started_at: iso(NOW - 5 * 3_600_000) })]), NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "watchdog");
  assert.equal(alerts[0].key, "watchdog:engine-run-stuck-running");
  assert.match(alerts[0].message, /^engine-run-stuck-running: 1 run\(s\) stuck/);
  assert.deepEqual(watchdogAlerts(state([]), NOW), [], "a hub with nothing running says nothing");
});

test("alert keys are per invariant, so one firing cannot cool down another", () => {
  // The supervisor's cooldown map is keyed on `key ?? kind`; every watchdog alert
  // shares one kind, so a per-kind key would silence the rest for 30 minutes.
  const fired = watchdogAlerts(state([run({ started_at: iso(NOW - 5 * 3_600_000) })]), NOW);
  assert.equal(fired[0].key, `watchdog:${stuck.id}`);
  assert.notEqual(fired[0].key, fired[0].kind, "falling back to kind would pool every invariant into one cooldown");
  assert.equal(new Set(INVARIANTS.map((i) => `watchdog:${i.id}`)).size, INVARIANTS.length);
});

test("the supervisor's state is not blind: no shipped invariant needs what it cannot read", () => {
  // `rosters: null` is what src/supervisor.ts passes, because the hub owns the
  // room store exclusively. A shipped invariant needing rosters would never fire
  // there, which reads as coverage and is worse than not shipping it.
  const supervisorState = state([]);
  assert.deepEqual(watchdogFailures(supervisorState), []);
  for (const inv of shippedInvariants()) assert.ok(!inv.needs.includes("rosters"), `${inv.id} would be blind`);
  assert.deepEqual(
    evaluateWatchdog(state([run({ started_at: iso(NOW - 5 * 3_600_000) })]), NOW).map((r) => r.invariant.id),
    ["engine-run-stuck-running"],
    "every shipped invariant is actually evaluated, none silently skipped",
  );
});

test("the roster invariants read a roster, and read nothing when one is not supplied", () => {
  const members = [
    { name: "watcher", role: "observer", lease_expires: iso(NOW - 2 * 3_600_000) },
    { name: "fresh", role: "observer", lease_expires: iso(NOW + 3_600_000) },
    { name: "pm", role: "member", lease_expires: iso(NOW - 40 * 3_600_000) },
  ];
  const withRoster: WatchdogState = { runs: [], rosters: () => [{ room: "r_1", members }] };
  const naive = INVARIANTS.find((i) => i.id === "observers-present-but-lease-expired-NAIVE")!;
  const pruned = INVARIANTS.find((i) => i.id === "observers-expired-beyond-prune")!;
  // 2h expired: the naive form fires (this is its false-fire), the corrected one does not
  assert.match(naive.evaluate(withRoster, NOW)!.detail, /1: r_1\/watcher/);
  assert.equal(pruned.evaluate(withRoster, NOW), null, "still inside the 24h prune window");
  const long = [{ name: "zombie", role: "observer", lease_expires: iso(NOW - 40 * 3_600_000) }];
  assert.match(pruned.evaluate({ runs: [], rosters: () => [{ room: "r_1", members: long }] }, NOW)!.detail, /1: r_1\/zombie/);
  // a member, not an observer, is never either one's business
  assert.equal(naive.evaluate({ runs: [], rosters: () => [{ room: "r_1", members: [members[2]] }] }, NOW), null);
  assert.equal(naive.evaluate(state([]), NOW), null, "no roster supplied reads as no observers");
});

test("engine.runningRuns feeds the watchdog the rows the engine itself holds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-watchdog-"));
  const engine = new Engine(path.join(dir, "runs.db"));
  const a = engine.createRun({ agent: "pm-agent", threadId: "t1", kind: "serve" });
  const b = engine.createRun({ agent: "scribe", threadId: "t2", kind: "serve" });
  engine.completeRun(b.runId, { output: {}, costUsd: 0, numTurns: 1 });
  engine.createRun({ agent: "pm-agent", threadId: "t1", kind: "serve" }); // queued pending behind a
  const rows = engine.runningRuns();
  assert.deepEqual(
    rows.map((r) => r.run_id),
    [a.runId],
    "running only: not the settled one, not the pending one",
  );
  assert.equal(rows[0].agent, "pm-agent");
  assert.ok(rows[0].started_at, "a running row carries the start the invariant judges");
  // and the whole path: an engine row this old is what the operator hears about
  engine.db.prepare("UPDATE runs SET started_at = ? WHERE run_id = ?").run(iso(Date.now() - 6 * 3_600_000), a.runId);
  const alerts = watchdogAlerts({ runs: engine.runningRuns(), rosters: null }, Date.now());
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, new RegExp(`${a.runId}/pm-agent`));
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("measureVerdict: fired-and-explained ships, fired-unexplained does not, never-fired is not validation", () => {
  assert.equal(measureVerdict(54, 0), "clean");
  assert.equal(measureVerdict(24, 2), "false-fires", "two unexplained firings out of 24 is still a false-firing invariant");
  assert.equal(measureVerdict(0, 0), "silent");
});

test("verdictDrift: a recorded licence that the corpus no longer supports fails its replay", () => {
  const truth = INVARIANTS.map((i) => ({ id: i.id, verdict: i.replay }));
  assert.deepEqual(verdictDrift(truth), [], "the recorded verdicts agree with themselves");
  const drifted = truth.map((m) => (m.id === stuck.id ? { ...m, verdict: "false-fires" as const } : m));
  assert.deepEqual(verdictDrift(drifted), [
    "engine-run-stuck-running: recorded `clean`, this corpus measures `false-fires`",
  ]);
  // an invariant the harness never replayed keeps no licence either
  assert.deepEqual(verdictDrift(truth.filter((m) => m.id !== stuck.id)), [
    "engine-run-stuck-running: defined and never replayed, so its `clean` verdict is unbacked",
  ]);
  assert.deepEqual(verdictDrift([...truth, { id: "ghost", verdict: "clean" }]), [
    "ghost: replayed, but no such invariant is defined in src/watchdog.ts",
  ]);
});

test("the invariants are defined once: the replay harness imports them, it does not carry a copy", () => {
  // This session's recurring defect is one fact in two places, and a watchdog
  // validated as one copy and shipped as another validates nothing. The replay
  // harness is the licence-issuer, so it is the copy that would matter.
  const replay = fs.readFileSync(new URL("../scripts/watchdog-replay.ts", import.meta.url), "utf8");
  assert.match(replay, /from "\.\.\/src\/watchdog\.js"/);
  assert.ok(!/\bevaluate:\s*\(/.test(replay), "an `evaluate:` in the harness is a second definition");
  assert.ok(!/STUCK_AFTER/.test(replay), "the threshold belongs to src/watchdog.ts alone");
  // The harness re-measures the verdict it ships on rather than trusting the
  // field. This grep only proves the CALL is there; that the call bites is
  // `verdictDrift` above, and that the harness exits 1 on drift is a mutation
  // proof against the live corpus (docs/LEDGER.md), because it needs one.
  assert.match(replay, /verdictDrift\(measurements\)/);
});
