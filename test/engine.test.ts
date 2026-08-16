/** Durable engine (RFA v0.4 section 4.3): run lifecycle, thread mutex, memoized steps, schedules. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
