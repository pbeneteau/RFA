/** Durable engine (RFA v0.4 section 4.3): run lifecycle, thread mutex, memoized steps, schedules. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Engine } from "../src/engine.js";

function fresh(): { engine: Engine; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-engine-"));
  return { engine: new Engine(path.join(dir, "runs.db")), dir };
}

test("run lifecycle: create -> running -> success settles the thread idle", () => {
  const { engine, dir } = fresh();
  const { runId, action } = engine.createRun({ agent: "a", threadId: "t1", kind: "serve", input: { q: "hi" } });
  assert.equal(action, "start");
  assert.equal(engine.threadStatus("t1"), "busy");
  engine.completeRun(runId, { output: { a: "yo" }, costUsd: 0.01, numTurns: 2, checkpoint: { claude_session_id: "s1", room_cursor: 42 } });
  const run = engine.get(runId)!;
  assert.equal(run.status, "success");
  assert.equal(run.cost_usd, 0.01);
  assert.equal(run.checkpoint?.room_cursor, 42);
  assert.equal(engine.threadStatus("t1"), "idle");
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("thread mutex + multitask strategies: enqueue queues, reject refuses, interrupt kills the running run", () => {
  const { engine, dir } = fresh();
  const first = engine.createRun({ agent: "a", threadId: "t", kind: "serve" });
  // enqueue (default): second run waits as pending
  const second = engine.createRun({ agent: "a", threadId: "t", kind: "serve" });
  assert.equal(second.action, "enqueued");
  assert.equal(engine.get(second.runId)!.status, "pending");
  // reject: refused outright
  assert.equal(engine.createRun({ agent: "a", threadId: "t", kind: "serve", multitask: "reject" }).action, "rejected");
  // interrupt: running run becomes interrupted, new one starts
  const third = engine.createRun({ agent: "a", threadId: "t", kind: "serve", multitask: "interrupt" });
  assert.equal(third.action, "interrupted_previous");
  assert.equal(engine.get(first.runId)!.status, "interrupted");
  assert.equal(engine.get(third.runId)!.status, "running");
  // settle third; the enqueued second drains via nextPending
  engine.completeRun(third.runId, {});
  const drained = engine.nextPending("t")!;
  assert.equal(drained.run_id, second.runId);
  assert.equal(drained.status, "running");
  assert.equal(engine.threadStatus("t"), "busy");
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("failRun retries up to 3 attempts then errors terminally", () => {
  const { engine, dir } = fresh();
  const { runId } = engine.createRun({ agent: "a", threadId: "t", kind: "serve" });
  assert.equal(engine.failRun(runId, "boom 1").retried, true);
  assert.equal(engine.get(runId)!.status, "pending");
  assert.equal(engine.get(runId)!.attempt, 2);
  engine.nextPending("t");
  assert.equal(engine.failRun(runId, "boom 2").retried, true);
  engine.nextPending("t");
  assert.equal(engine.failRun(runId, "boom 3").retried, false, "attempt 3 is the last");
  assert.equal(engine.get(runId)!.status, "error");
  assert.equal(engine.threadStatus("t"), "error");
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("steps are memoized: the function runs once, replays return the journal", async () => {
  const { engine, dir } = fresh();
  const { runId } = engine.createRun({ agent: "a", threadId: "t", kind: "job" });
  let calls = 0;
  const once = () => engine.step(runId, "send-message", async () => ({ seq: ++calls }));
  assert.deepEqual(await once(), { seq: 1 });
  assert.deepEqual(await once(), { seq: 1 }, "replay must not re-execute");
  assert.equal(calls, 1);
  await engine.step(runId, "second-step", () => "ok");
  assert.deepEqual(engine.steps(runId).map((s) => s.step_id), ["send-message", "second-step"]);
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("state survives reopen (the whole point)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-engine-"));
  const db = path.join(dir, "runs.db");
  const e1 = new Engine(db);
  const { runId } = e1.createRun({ agent: "a", threadId: "t", kind: "serve" });
  await e1.step(runId, "s1", () => 41);
  e1.saveCheckpoint(runId, { claude_session_id: "sess", room_cursor: 7 });
  e1.close();
  const e2 = new Engine(db);
  assert.equal(e2.get(runId)!.status, "running");
  assert.equal(e2.get(runId)!.checkpoint?.claude_session_id, "sess");
  assert.equal(await e2.step(runId, "s1", () => 999), 41, "journal survives reopen");
  e2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("schedules: delayed, interval advance, cron next-fire, one-shot deletion, cancel", () => {
  const { engine, dir } = fresh();
  const past = new Date(Date.now() - 1000);
  engine.schedule("a", past, "one-shot", { n: 1 });
  engine.schedule("a", "interval:60", "tick", { n: 2 });
  const cron = engine.schedule("a", "0 8 * * 1-5", "digest", { n: 3 }, { timezone: "Europe/Paris" });
  assert.ok(cron.next_fire_at, "cron computes a next fire");
  assert.equal(engine.listSchedules("a").length, 3);

  // Only the one-shot (past) and nothing else is due right now... interval fires at +60s.
  const due = engine.dueSchedules(new Date());
  assert.deepEqual(due.map((d) => d.callback), ["one-shot"]);
  assert.equal(engine.listSchedules("a").length, 2, "one-shot deleted after firing");

  // Advance time past the interval: it fires and re-arms.
  const later = new Date(Date.now() + 61_000);
  const due2 = engine.dueSchedules(later);
  assert.deepEqual(due2.map((d) => d.callback), ["tick"]);
  const tick = engine.listSchedules("a").find((s) => s.callback === "tick")!;
  assert.ok(new Date(tick.next_fire_at!) > later, "interval re-armed");

  assert.equal(engine.cancelSchedule(cron.id), true);
  assert.equal(engine.listSchedules("a").length, 1);
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reconcileOrphans frees the threads a dead process left busy, and only that agent's", () => {
  // The failure this reverses: a run only leaves `running` when its own process
  // settles it, so a SIGKILLed or crashed resident leaves the row behind and its
  // thread `busy` forever. Under the default `enqueue` strategy the gate only
  // looks at `busy`, so every later run on that conversation is created `pending`
  // and waits for a drain that can only come from the settle that never happens.
  // Measured live before the fix: 4 threads busy, the oldest for two and a half
  // days.
  const { engine, dir } = fresh();

  const dead = engine.createRun({ agent: "pm-agent", threadId: "c_dead", kind: "serve" });
  assert.equal(dead.action, "start");
  // A second conversation of the same agent, and one belonging to another agent.
  const alsoDead = engine.createRun({ agent: "pm-agent", threadId: "c_dead2", kind: "serve" });
  const other = engine.createRun({ agent: "linear-scribe", threadId: "c_other", kind: "serve" });

  // The queued run behind the wedged thread: this is the part that stays stuck.
  const queued = engine.createRun({ agent: "pm-agent", threadId: "c_dead", kind: "serve" });
  assert.equal(queued.action, "enqueued", "the thread is busy, so this one waits");
  assert.equal(engine.get(queued.runId)!.status, "pending");
  assert.equal(engine.nextPending("c_dead"), null, "and nothing can pick it up while the thread is busy");

  const res = engine.reconcileOrphans("pm-agent");
  assert.deepEqual(res.runs.sort(), [dead.runId, alsoDead.runId].sort(), "both of this agent's orphans");
  assert.deepEqual(res.threads.sort(), ["c_dead", "c_dead2"], "and the threads they held");

  assert.equal(engine.get(dead.runId)!.status, "interrupted", "an orphan is interrupted, not success and not error");
  assert.match(String(engine.get(dead.runId)!.error), /never settled it/, "and says why, for whoever reads the row later");
  assert.equal(engine.get(other.runId)!.status, "running", "another agent's live run must be untouched");

  // The property that matters: the conversation is servable again.
  const picked = engine.nextPending("c_dead");
  assert.equal(picked?.run_id, queued.runId, "the queued run can finally be picked up");

  assert.deepEqual(engine.reconcileOrphans("pm-agent").runs, [picked!.run_id], "idempotent in shape: it reconciles whatever is running now");
  engine.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * RFA-0.8 sect. 3 item 4: a run whose process died is swept to a terminal state
 * by a DIRECT STATE CHECK, at any moment, from any process, AT ZERO TRAFFIC.
 *
 * `reconcileOrphans` above is safe only at the instant the supervisor knows
 * nothing owns a pack (as it starts a resident), so a pack whose resident is
 * retired, disabled or simply never restarted kept its `running` rows and its
 * `busy` threads indefinitely. A rate could not have found this: on a quiet hub a
 * rate has no denominator, which is the lesson the repository has already paid
 * for once.
 */
test("reconcileDead sweeps runs whose owning process is gone, on a direct check, and leaves live ones alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-dead-"));
  const engine = new Engine(path.join(dir, "runs.db"));
  try {
    const mine = engine.createRun({ agent: "pm-agent", threadId: "convo-live", kind: "serve" });
    const theirs = engine.createRun({ agent: "pm-agent", threadId: "convo-dead", kind: "serve" });
    const other = engine.createRun({ agent: "linear-scribe", threadId: "convo-scribe", kind: "serve" });
    assert.equal(engine.get(mine.runId)!.owner_pid, process.pid, "a run that starts records who owns it");

    // Only `theirs` belongs to a process that is gone. The check is injected, so
    // the test drives it rather than killing something.
    const deadPid = engine.get(theirs.runId)!.owner_pid!;
    const swept = engine.reconcileDead({ alive: (pid) => pid === process.pid || pid !== deadPid });
    assert.deepEqual(swept.runs, [], "nothing is swept while every owner is alive");

    const real = engine.reconcileDead({ alive: () => false });
    assert.equal(real.runs.length, 3, "every run whose owner is gone, across agents");
    assert.deepEqual(real.threads.sort(), ["convo-dead", "convo-live", "convo-scribe"]);
    for (const id of [mine.runId, theirs.runId, other.runId]) {
      const run = engine.get(id)!;
      assert.equal(run.status, "interrupted", "a terminal state, so the conversation is servable again");
      assert.match(run.error!, /pid \d+\) is gone/, run.error!);
      assert.equal(run.owner_pid, null, "ownership is cleared with the sweep");
    }
    assert.equal(engine.threadStatus("convo-dead"), "idle", "idle, not interrupted: idle is what lets a pending run be picked up");

    // Idempotent, and it never invents death for a row that carries no owner: a
    // pre-0.8 row has no evidence, and inferring death from age is the timeout
    // heuristic this deliberately avoids (a 30-minute approval wait is a
    // legitimately long run).
    assert.deepEqual(engine.reconcileDead({ alive: () => false }).runs, [], "nothing left to sweep");
    const raw = new Database(path.join(dir, "runs.db"));
    raw
      .prepare(`INSERT INTO runs (run_id, thread_id, agent, status, kind, created_at, started_at) VALUES ('run_legacy', 'convo-old', 'pm-agent', 'running', 'serve', ?, ?)`)
      .run(new Date().toISOString(), new Date().toISOString());
    raw.close();
    assert.deepEqual(engine.reconcileDead({ alive: () => false }).runs, [], "a NULL owner_pid is left alone, never read as dead");
    assert.equal(engine.get("run_legacy")!.status, "running");
    // And `reconcileOrphans`, which is safe only at a resident start, still covers it.
    assert.deepEqual(engine.reconcileOrphans("pm-agent").runs, ["run_legacy"]);

    // A settled run carries no owner, so nothing can sweep it twice.
    const fresh = engine.createRun({ agent: "pm-agent", threadId: "convo-done", kind: "serve" });
    engine.completeRun(fresh.runId, { output: { ok: true }, costUsd: 0.01 });
    assert.equal(engine.get(fresh.runId)!.owner_pid, null, "settling releases ownership");
    assert.deepEqual(engine.reconcileDead({ alive: () => false }).runs, [], "a completed run is not a corpse");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
