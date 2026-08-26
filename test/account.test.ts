/** The account layer (RFA v0.4 section 7.4 layer 3, v0.5 section 18.6): global cap, priority, account-wide pause. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AccountLedger, UNSUPERVISED_CAP, isRateLimitError } from "../src/account.js";
import { Engine } from "../src/engine.js";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rfa-account-")), "runs.db");
}

test("the cap is the supervisor's number, and lane limits encode the priority order", () => {
  const db = tmpDb();
  const a = new AccountLedger(db);
  try {
    assert.equal(a.cap(), UNSUPERVISED_CAP, "an unset cap falls back to the unsupervised fallback, never to unlimited");
    a.setCap(3);
    // serve (approvals + human-facing) may fill the cap; scheduled work leaves one
    // slot for a human; consolidation/evals/judges leave two.
    assert.equal(a.laneLimit("serve"), 3);
    assert.equal(a.laneLimit("schedule"), 2);
    assert.equal(a.laneLimit("background"), 1);
    // A cap of 1 still admits every lane, one at a time: the reserve may not starve a lane to zero.
    a.setCap(1);
    assert.deepEqual([a.laneLimit("serve"), a.laneLimit("schedule"), a.laneLimit("background")], [1, 1, 1]);
    assert.throws(() => a.setCap(0), /positive integer/);
  } finally {
    a.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

test("the cap holds across processes, and lower lanes are refused first", () => {
  const db = tmpDb();
  // Two connections to one file is the multi-process case: residents are separate
  // processes, and neither of them is the supervisor.
  const sup = new AccountLedger(db);
  const resident = new AccountLedger(db);
  try {
    sup.setCap(3);
    const serve1 = resident.acquire({ agent: "pm-agent", lane: "serve", runId: "run_1" });
    assert.ok(serve1.ok && serve1.lease);
    assert.equal(serve1.lease.lane, "serve");
    // One turn in flight already exceeds what background may hold (limit 1).
    const bg = sup.acquire({ agent: "pm-agent", lane: "background" });
    assert.equal(bg.ok, false);
    assert.equal(bg.reason, "cap_reached");
    assert.match(bg.detail!, /in_flight=1 lane_limit=1 cap=3/);
    assert.ok((bg.retry_after_s ?? 0) > 0, "a refusal carries a retry hint");
    // A scheduled job still fits (limit 2), a second serve too (limit 3).
    const sched = resident.acquire({ agent: "linear-scribe", lane: "schedule" });
    assert.ok(sched.ok);
    const serve2 = sup.acquire({ agent: "linear-scribe", lane: "serve" });
    assert.ok(serve2.ok);
    assert.equal(sup.inFlight().total, 3);
    assert.deepEqual(sup.inFlight().byLane, { serve: 2, schedule: 1, background: 0 });
    assert.deepEqual(sup.inFlight().byAgent, { "pm-agent": 1, "linear-scribe": 2 });
    // Full: even the top lane waits.
    assert.equal(sup.acquire({ agent: "pm-agent", lane: "serve" }).ok, false);
    // Releasing is idempotent and frees the slot for the other process.
    resident.release(serve1.lease.lease_id);
    resident.release(serve1.lease.lease_id);
    assert.equal(sup.inFlight().total, 2);
    assert.ok(sup.acquire({ agent: "pm-agent", lane: "serve" }).ok);
    // Retirement and drain: every slot the agent holds goes at once.
    assert.equal(sup.releaseAgent("linear-scribe"), 2);
    assert.deepEqual(sup.inFlight().byAgent, { "pm-agent": 1 });
  } finally {
    sup.close();
    resident.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

test("a slot whose owner died is reclaimed, by TTL and by dead pid", async () => {
  const db = tmpDb();
  const a = new AccountLedger(db, { leaseTtlMs: 120 });
  try {
    a.setCap(1);
    const held = a.acquire({ agent: "pm-agent", lane: "serve" });
    assert.ok(held.ok && held.lease);
    assert.equal(a.acquire({ agent: "pm-agent", lane: "serve" }).ok, false);
    // A long turn keeps its slot by renewing.
    assert.equal(a.renew(held.lease.lease_id), true);
    // Past the TTL the slot comes back even though nobody released it.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(a.inFlight().total, 0);
    assert.ok(a.acquire({ agent: "pm-agent", lane: "serve" }).ok);
    assert.equal(a.renew("lse_nosuchlease"), false);
    // A SIGKILLed resident is gone long before its TTL: the sweep judges the pid.
    const b = new AccountLedger(db);
    try {
      b.setCap(2);
      b.acquire({ agent: "linear-scribe", lane: "serve" });
      assert.equal(b.sweep({ alive: () => true }) >= 0, true);
      assert.ok(b.inFlight().total > 0);
      b.sweep({ alive: () => false });
      assert.equal(b.inFlight().total, 0);
    } finally {
      b.close();
    }
  } finally {
    a.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

test("a provider rate limit pauses pickup ACCOUNT-wide, not just the reporter", async () => {
  const db = tmpDb();
  const resident = new AccountLedger(db);
  const supervisor = new AccountLedger(db);
  try {
    supervisor.setCap(3);
    const { paused_until } = resident.reportRateLimit({ agent: "pm-agent", runId: "run_x", detail: "429 rate_limit_error" });
    assert.ok(Date.parse(paused_until) > Date.now(), "the report holds the account immediately, before the supervisor's pass");
    // Every agent and every lane, not only the one that hit the wall.
    for (const lane of ["serve", "schedule", "background"] as const) {
      const denied = supervisor.acquire({ agent: "linear-scribe", lane });
      assert.equal(denied.ok, false);
      assert.equal(denied.reason, "account_paused");
      assert.ok((denied.retry_after_s ?? 0) > 0);
    }
    // The report is the supervisor's input, and it is consumed exactly once.
    const pending = supervisor.pendingRateLimits();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].agent, "pm-agent");
    assert.equal(pending[0].run_id, "run_x");
    supervisor.markRateLimitsHandled(pending.map((r) => r.id));
    assert.equal(supervisor.pendingRateLimits().length, 0);
    // The supervisor owns the duration: a longer hold wins, a shorter one cannot cut it short.
    const long = supervisor.pause("escalated", 600_000);
    supervisor.pause("shorter", 1_000);
    assert.equal(supervisor.snapshot().paused_until, long.paused_until);
    // Waiting out a minutes-long hold inside a turn would spend the asker's whole
    // deadline, so the wait refuses instead of blocking.
    const t0 = Date.now();
    const waited = await resident.waitForSlot({ agent: "pm-agent", lane: "serve" }, { timeoutMs: 5_000, pollMs: 50 });
    assert.equal(waited.reason, "account_paused");
    assert.ok(Date.now() - t0 < 1_000, "a paused account is answered, not waited out");
    supervisor.resume();
    assert.equal(supervisor.pausedUntil(), 0);
    assert.equal(supervisor.snapshot().paused_until, null);
    assert.ok(resident.acquire({ agent: "pm-agent", lane: "serve" }).ok);
  } finally {
    resident.close();
    supervisor.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

test("waitForSlot admits as soon as another process releases", async () => {
  const db = tmpDb();
  const a = new AccountLedger(db);
  const b = new AccountLedger(db);
  try {
    a.setCap(1);
    const held = a.acquire({ agent: "pm-agent", lane: "serve" });
    assert.ok(held.ok && held.lease);
    setTimeout(() => a.release(held.lease!.lease_id), 100);
    const got = await b.waitForSlot({ agent: "linear-scribe", lane: "serve" }, { timeoutMs: 4_000, pollMs: 25 });
    assert.ok(got.ok, `expected admission after the release, got ${got.detail}`);
    // A cap that never frees is a refusal with the numbers, not an indefinite wait.
    const timedOut = await b.waitForSlot({ agent: "linear-scribe", lane: "serve" }, { timeoutMs: 150, pollMs: 25 });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.reason, "cap_reached");
  } finally {
    a.close();
    b.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

test("the ledger shares runs.db with the engine, and publishes an operator view", () => {
  const db = tmpDb();
  const engine = new Engine(db);
  const account = new AccountLedger(db);
  try {
    // The whole point of the mechanism: the file the residents already share.
    const { runId } = engine.createRun({ agent: "pm-agent", threadId: "c_1", kind: "serve" });
    const lease = account.acquire({ agent: "pm-agent", lane: "serve", runId });
    assert.ok(lease.ok && lease.lease);
    assert.equal(lease.lease.run_id, runId);
    assert.equal(engine.get(runId)?.status, "running");
    const snap = account.snapshot();
    assert.equal(snap.in_flight, 1);
    assert.equal(snap.cap, UNSUPERVISED_CAP);
    assert.equal(snap.paused_until, null);
    assert.equal(snap.leases[0].agent, "pm-agent");
  } finally {
    account.close();
    engine.close();
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
  }
});

test("isRateLimitError: the account-wide causes only", () => {
  for (const m of [
    "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}",
    "Rate limit exceeded",
    "Too Many Requests",
    "usage limit reached, resets at 3pm",
    "quota exceeded for this organization",
  ]) {
    assert.equal(isRateLimitError(new Error(m)), true, m);
  }
  for (const m of [
    // Provider capacity, which the SDK retries and which pausing does not help.
    "API Error: 529 {\"type\":\"overloaded_error\"}",
    "brain error: error_max_turns",
    "fetch failed",
  ]) {
    assert.equal(isRateLimitError(new Error(m)), false, m);
  }
});
