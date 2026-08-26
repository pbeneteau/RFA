/**
 * RFA-0.8 rung 4: candidate parallelism. N independent runs of ONE task, one
 * output selected, the rest discarded.
 *
 * The two traps of sect. 11 are what most of this file is about, because both of
 * them corrupt QUIETLY and neither shows up in a happy-path run:
 *
 *  1. **A losing candidate's reasoning must never become remembered fact.** The
 *     end-to-end proof of that lives beside the other memory seams, in
 *     `test/interleaving.test.ts` ("seam 2, extended"); here the mechanism is
 *     pinned: a candidate turn cannot write an episode at all, and selection is
 *     the only thing that makes one eligible.
 *  2. **N candidates are N reservations against ONE day budget.** So the fan-out
 *     asks the ledger how many it can afford BEFORE it starts any, and a
 *     cancelled candidate settles what it really spent rather than vanishing.
 *
 * Every test here is deterministic: barriers and injected callbacks, no sleeps
 * and no live model, for the reason spec sect. 14 gives about the trust anchor.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AccountLedger, VIABLE_BUDGET_USD } from "../src/account.js";
import { concurrencyGateFailures, parseAgentMd } from "../src/agentdef.js";
import { isCandidateSelector, planCandidates, runCandidateSet, type CandidatePlan, type CandidateSelector, type StartedCandidate } from "../src/candidates.js";
import { Engine } from "../src/engine.js";
import { EpisodeLog } from "../src/memoryfs.js";

function tmp(prefix: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "runs.db");
}

const plan = (over: Partial<CandidatePlan> = {}): CandidatePlan => ({ requested: 3, running: 3, selector: "human", degraded: null, ...over });

/** A candidate that resolves or rejects when the test says so, and records whether it was interrupted. */
function controllable(runId: string): StartedCandidate & { finish: (text: string, cost?: number) => void; fail: (err: Error) => void; cancelled: string | null } {
  let resolve!: (v: { text: string; costUsd: number; numTurns: number }) => void;
  let reject!: (e: Error) => void;
  const done = new Promise<{ text: string; costUsd: number; numTurns: number }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const h = {
    runId,
    done,
    cancelled: null as string | null,
    // What the real wiring does: the interrupt makes the turn throw, and the
    // cost it had already spent rides on the error.
    cancel(reason: string) {
      if (h.cancelled) return;
      h.cancelled = reason;
      setImmediate(() => reject(Object.assign(new Error(`interrupted: ${reason}`), { costUsd: 0.02 })));
    },
    finish: (text: string, cost = 0.05) => resolve({ text, costUsd: cost, numTurns: 2 }),
    fail: (err: Error) => reject(err),
  };
  return h;
}

// ---------------------------------------------------------------- the plan (trap 2, first half)

test("the plan is cut by the tightest ceiling, and every cut says why", () => {
  const wide = planCandidates({ requested: 3, selector: "human", concurrency: 4, affordable: { count: 3, detail: null } });
  assert.equal(wide.running, 3);
  assert.equal(wide.degraded, null);

  const byHost = planCandidates({ requested: 4, selector: "human", concurrency: 2, affordable: { count: 9, detail: null } });
  assert.equal(byHost.running, 2);
  assert.match(byHost.degraded ?? "", /concurrency: 2/);
  assert.match(byHost.degraded ?? "", /child process/);

  const byMoney = planCandidates({ requested: 3, selector: "human", concurrency: 8, affordable: { count: 1, detail: "only a dollar left" } });
  assert.equal(byMoney.running, 1);
  assert.equal(byMoney.degraded, "only a dollar left");

  // Both ceilings biting reports both, because an operator fixing one wants to
  // know the other is there too.
  const both = planCandidates({ requested: 4, selector: "human", concurrency: 3, affordable: { count: 2, detail: "the day budget affords 2" } });
  assert.equal(both.running, 2);
  assert.match(both.degraded ?? "", /concurrency: 3/);
  assert.match(both.degraded ?? "", /affords 2/);
});

test("turns this process is already running count against the pack's host sizing", () => {
  // The whole set runs inside ONE dispatcher job, so the dispatcher counts one
  // where three turns would run: without subtracting what is busy, `concurrency:
  // 3` would be a floor rather than a ceiling.
  const p = planCandidates({ requested: 3, selector: "human", concurrency: 3, busy: 2, affordable: { count: 9, detail: null } });
  assert.equal(p.running, 1);
  assert.match(p.degraded ?? "", /already running 2 turns/);
  // Never below one: a fan-out cut to zero by a transient serve turn would be a
  // task that silently does nothing.
  const floor = planCandidates({ requested: 3, selector: "human", concurrency: 2, busy: 9, affordable: { count: 9, detail: null } });
  assert.equal(floor.running, 1);
});

// ---------------------------------------------------------------- the ledger (trap 2, second half)

test("the ledger says how many candidates it can afford, over settled AND reserved", () => {
  const led = new AccountLedger(tmp("rfa-cand-afford-"));
  try {
    const budget = { perDayUsd: 5, perTaskUsd: 1, day: "2026-08-26" };
    // 5 dollars, 1 per task: four fit and the fifth would leave nothing viable.
    assert.equal(led.affordableCandidates({ agent: "pm", want: 3, budget }).count, 3);
    assert.equal(led.affordableCandidates({ agent: "pm", want: 9, budget }).count, 5);

    // A LIVE reservation counts against the plan exactly as settled spend does,
    // which is the whole point of asking the ledger rather than reading a total.
    const held = led.acquire({ agent: "pm", lane: "serve", budget });
    assert.ok(held.ok);
    assert.equal(held.granted_usd, 1);
    const after = led.affordableCandidates({ agent: "pm", want: 9, budget });
    assert.equal(after.count, 4);
    assert.match(after.detail ?? "", /not 9/);
    led.release(held.lease!.lease_id, 1);

    // Settled spend, same arithmetic.
    led.recordSpend("pm", 3, "2026-08-26");
    assert.equal(led.affordableCandidates({ agent: "pm", want: 3, budget }).count, 1);
  } finally {
    led.close();
  }
});

test("with no per-task ceiling exactly ONE candidate is affordable, and the reason names the fix", () => {
  const led = new AccountLedger(tmp("rfa-cand-nopertask-"));
  try {
    const answer = led.affordableCandidates({ agent: "pm", want: 4, budget: { perDayUsd: 5, perTaskUsd: null, day: "2026-08-26" } });
    // Not a degenerate case: admission reserves `min(per_task, remaining)`, so
    // with no per-task ceiling the FIRST reservation is the whole remainder.
    assert.equal(answer.count, 1);
    assert.match(answer.detail ?? "", /no budgets\.per_task_usd/);
    assert.match(answer.detail ?? "", /declare a per-task ceiling/);
  } finally {
    led.close();
  }
});

test("a pack with a dollar left runs ONE candidate instead of three, and says why", () => {
  const led = new AccountLedger(tmp("rfa-cand-dollar-"));
  try {
    const budget = { perDayUsd: 5, perTaskUsd: 1, day: "2026-08-26" };
    led.recordSpend("pm", 4, "2026-08-26");
    const p = planCandidates({
      requested: 3,
      selector: "human",
      concurrency: 4,
      affordable: led.affordableCandidates({ agent: "pm", want: 3, budget }),
    });
    assert.equal(p.running, 1);
    assert.match(p.degraded ?? "", /\$1\.00 left of pm's \$5\.00 day budget/);
    assert.match(p.degraded ?? "", /not 3/);

    // And under the viability floor it is zero with the floor named, rather than
    // a fan-out of runs that would each die at admission.
    led.recordSpend("pm", 1 - VIABLE_BUDGET_USD / 2, "2026-08-26");
    const broke = led.affordableCandidates({ agent: "pm", want: 3, budget });
    assert.equal(broke.count, 0);
    assert.match(broke.detail ?? "", /viability floor/);
  } finally {
    led.close();
  }
});

// ---------------------------------------------------------------- the fan-out

test("human selection runs every candidate to completion and picks nothing itself", async () => {
  const handles = [controllable("run_a"), controllable("run_b"), controllable("run_c")];
  const settled: number[] = [];
  const discarded: number[] = [];
  const running = runCandidateSet({
    plan: plan(),
    start: (i) => handles[i],
    onSettled: (o) => settled.push(o.index),
    onDiscard: (o) => discarded.push(o.index),
  });
  handles[1].finish("second finished first", 0.03);
  handles[0].finish("first", 0.04);
  handles[2].finish("third", 0.05);
  const result = await running;
  assert.equal(result.winner, null, "human selection never picks for the human");
  assert.deepEqual(discarded, [], "nothing is discarded before somebody chooses");
  assert.equal(result.outcomes.filter((o) => o.state === "ready").length, 3);
  assert.equal(settled.length, 3);
  assert.ok(Math.abs(result.costUsd - 0.12) < 1e-9, `set cost ${result.costUsd}`);
  // Nobody was interrupted: under human selection every candidate is wanted.
  assert.deepEqual(handles.map((h) => h.cancelled), [null, null, null]);
});

test("early stop keeps the first finisher, interrupts the rest, and STILL settles what they spent", async () => {
  const handles = [controllable("run_a"), controllable("run_b"), controllable("run_c")];
  const discarded: number[] = [];
  const running = runCandidateSet({
    plan: plan({ selector: "first-verified" }),
    start: (i) => handles[i],
    onDiscard: (o) => discarded.push(o.index),
  });
  handles[2].finish("the fastest answer", 0.06);
  const result = await running;

  assert.equal(result.winner, 2);
  assert.equal(result.outcomes[2].state, "ready");
  assert.equal(result.outcomes[0].state, "cancelled");
  assert.equal(result.outcomes[1].state, "cancelled");
  assert.deepEqual(handles.map((h) => h.cancelled !== null), [true, true, false], "the winner is never interrupted");
  // The property this test exists for: a cancelled candidate's spend does NOT
  // vanish. A candidate whose cost disappeared is exactly the unattributable
  // meter the honest-meters doctrine forbids.
  assert.equal(result.outcomes[0].costUsd, 0.02);
  assert.equal(result.outcomes[1].costUsd, 0.02);
  assert.ok(Math.abs(result.costUsd - 0.1) < 1e-9, `set cost ${result.costUsd}`);
  assert.deepEqual(discarded.sort(), [0, 1]);
});

test("the set does not resolve until every interrupted candidate has settled", async () => {
  // A slow loser: the interrupt lands, but its turn takes a while to unwind. If
  // the set resolved on the winner alone, the loser's cost would be read after
  // the task had already completed, which is the honest-meters failure with an
  // extra step.
  const fast = controllable("run_fast");
  let releaseSlow!: () => void;
  const slowDone = new Promise<never>((_res, rej) => {
    releaseSlow = () => rej(Object.assign(new Error("interrupted: late"), { costUsd: 0.09 }));
  });
  const slow: StartedCandidate & { cancelled: boolean } = { runId: "run_slow", done: slowDone, cancelled: false, cancel: () => { slow.cancelled = true; } };
  let resolved = false;
  const running = runCandidateSet({ plan: plan({ running: 2, requested: 2, selector: "first-verified" }), start: (i) => (i === 0 ? fast : slow) }).then((r) => {
    resolved = true;
    return r;
  });
  fast.finish("done", 0.01);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(resolved, false, "the set resolved while a loser was still unwinding");
  assert.equal(slow.cancelled, true);
  releaseSlow();
  const result = await running;
  assert.equal(result.outcomes[1].costUsd, 0.09);
  assert.ok(Math.abs(result.costUsd - 0.1) < 1e-9);
});

test("a candidate that cannot even start is a failed candidate, never a failed set", async () => {
  const ok = controllable("run_ok");
  const result = runCandidateSet({
    plan: plan({ running: 2, requested: 2 }),
    start: (i) => {
      if (i === 0) throw new Error("no account slot");
      return ok;
    },
  });
  ok.finish("the other one worked");
  const out = await result;
  assert.equal(out.outcomes[0].state, "failed");
  assert.match(out.outcomes[0].error ?? "", /no account slot/);
  assert.equal(out.outcomes[1].state, "ready");
});

test("a cancel that arrives while a candidate is still starting still lands", async () => {
  // The race the fan-out has to survive: the winner finishes before a slower
  // sibling's `start` has even returned. Without the late-cancel check the
  // sibling would run to completion after the task was already answered.
  const fast = controllable("run_fast");
  const late = controllable("run_late");
  let releaseStart!: () => void;
  const startGate = new Promise<void>((r) => (releaseStart = r));
  const running = runCandidateSet({
    plan: plan({ running: 2, requested: 2, selector: "first-verified" }),
    start: async (i) => {
      if (i === 0) return fast;
      await startGate;
      return late;
    },
  });
  fast.finish("first", 0.01);
  await new Promise((r) => setImmediate(r));
  releaseStart();
  const out = await running;
  assert.equal(out.winner, 0);
  assert.ok(late.cancelled, "the late starter was never told to stop");
  assert.equal(out.outcomes[1].state, "cancelled");
});

// ---------------------------------------------------------------- the durable set

test("a candidate set records every run, its cost and its terminal state, and cost per TASK is one query", () => {
  const engine = new Engine(tmp("rfa-cand-engine-"));
  try {
    const setId = engine.openCandidateSet({ agent: "pm", room: "r_1", taskId: "t_9", title: "reconcile the fee table", requested: 3, running: 3, selector: "human" });
    for (let i = 0; i < 3; i++) {
      const { runId } = engine.createRun({ agent: "pm", threadId: `task:t_9#c${i}`, kind: "candidate", candidateSet: setId, candidateIndex: i });
      engine.startCandidate(setId, i, runId, `/tmp/scratch/${runId}`);
      engine.completeRun(runId, { costUsd: 0.1 * (i + 1) });
      engine.settleCandidate(setId, i, { state: "ready", text: `answer ${i}`, costUsd: 0.1 * (i + 1), numTurns: 2 });
    }
    engine.closeCandidateSet(setId, "awaiting_selection");
    const set = engine.candidateSet(setId)!;
    assert.equal(set.state, "awaiting_selection");
    assert.equal(set.candidates.length, 3);
    assert.ok(Math.abs(set.cost_usd - 0.6) < 1e-9, `set cost ${set.cost_usd}`);
    // Three candidates of one task must not read as three tasks: the set id is
    // on the run rows too, which is what makes the question answerable at all.
    const runs = engine.runs({ agent: "pm", limit: 50 });
    assert.equal(runs.length, 3);
    assert.deepEqual([...new Set(runs.map((r) => r.kind))], ["candidate"]);
    assert.equal(engine.candidateSetForTask("t_9")!.set_id, setId);
  } finally {
    engine.close();
  }
});

test("selection has exactly one winner, cannot be repeated, and refuses a candidate that is not ready", () => {
  const engine = new Engine(tmp("rfa-cand-select-"));
  try {
    const setId = engine.openCandidateSet({ agent: "pm", taskId: "t_1", requested: 3, running: 3, selector: "human" });
    engine.startCandidate(setId, 0, "run_0", null);
    engine.startCandidate(setId, 1, "run_1", null);
    engine.startCandidate(setId, 2, "run_2", null);

    // A set with candidates still in flight cannot be selected from: the answer
    // might not be the best one yet, and the fan-out is still spending.
    assert.equal(engine.selectCandidate(setId, 0, "human:paul").ok, false);

    engine.settleCandidate(setId, 0, { state: "ready", text: "a", costUsd: 0.1 });
    engine.settleCandidate(setId, 1, { state: "ready", text: "b", costUsd: 0.1 });
    engine.settleCandidate(setId, 2, { state: "failed", error: "budget", costUsd: 0.01 });
    engine.closeCandidateSet(setId, "awaiting_selection");

    const failed = engine.selectCandidate(setId, 2, "human:paul");
    assert.equal(failed.ok, false);
    assert.match(failed.detail ?? "", /is failed, not ready/);

    const won = engine.selectCandidate(setId, 1, "human:paul");
    assert.equal(won.ok, true);
    assert.equal(won.run?.text, "b");
    const set = engine.candidateSet(setId)!;
    assert.equal(set.state, "selected");
    assert.equal(set.selected_index, 1);
    assert.equal(set.selected_by, "human:paul");
    assert.deepEqual(set.candidates.map((c) => c.state), ["lost", "won", "failed"]);
    // The loser keeps its TEXT and its COST: it lost its scratch surface, not
    // its record. Deleting the evidence that it ran would be the meter lying.
    assert.equal(set.candidates[0].text, "a");
    assert.equal(set.candidates[0].cost_usd, 0.1);

    assert.equal(engine.selectCandidate(setId, 0, "human:paul").ok, false, "a set cannot be selected twice");
  } finally {
    engine.close();
  }
});

test("the local candidate request is found by task id, and by room and title when the wire event won the race", () => {
  const engine = new Engine(tmp("rfa-cand-request-"));
  try {
    // The ordinary path: written before the create, bound after it.
    const bound = engine.requestCandidates({ room: "r_1", title: "one", count: 3, selector: "human" });
    engine.bindCandidateRequest(bound, "t_1");
    assert.deepEqual(engine.takeCandidateRequest({ taskId: "t_1" }), { count: 3, selector: "human" });
    assert.equal(engine.takeCandidateRequest({ taskId: "t_1" }), null, "a request is consumed once: a redelivery must not fan out twice");

    // The race the fallback exists for: the resident was woken and looked before
    // `bindCandidateRequest` ran. Matching on room and title finds it anyway,
    // and binds it as it consumes it.
    engine.requestCandidates({ room: "r_1", title: "two", count: 2, selector: "first-verified" });
    assert.deepEqual(engine.takeCandidateRequest({ taskId: "t_2", room: "r_1", title: "two" }), { count: 2, selector: "first-verified" });
    assert.equal(engine.takeCandidateRequest({ taskId: "t_3", room: "r_1", title: "two" }), null);

    assert.equal(engine.takeCandidateRequest({ taskId: "t_4", room: "r_1", title: "never asked for" }), null);
  } finally {
    engine.close();
  }
});

// ---------------------------------------------------------------- trap 1, the mechanism

test("an episode cannot be recorded from inside a candidate turn", () => {
  const db = tmp("rfa-cand-episodes-");
  let inCandidate: string | null = null;
  const log = new EpisodeLog(db, () => (inCandidate ? `it is candidate work in set ${inCandidate}` : null));
  try {
    log.recordOwn("r_1", "m_self", "pm", "an ordinary answer");
    assert.equal(log.count(), 1);
    inCandidate = "cs_abc";
    assert.throws(() => log.recordOwn("r_1", "m_self", "pm", "a candidate's answer"), /must not be recorded as an episode/);
    assert.equal(log.count(), 1, "the guard is at the WRITE, not a filter over the read");
    inCandidate = null;
    log.recordOwn("r_1", "m_self", "pm", "the selected answer");
    assert.equal(log.count(), 2);
  } finally {
    log.close();
  }
});

// ---------------------------------------------------------------- the gates

const packMd = (front: string) => `---\n${front}\n---\nYou answer questions.\n`;

test("candidates above 1 need the concurrency to match, and inherit its three gates", () => {
  const base = `rfa_agent: 1\nname: pm\ndescription: A pack.\n`;
  // Fan-out without the host sizing to back it: refused, naming both numbers.
  const fails = concurrencyGateFailures({ concurrency: 1, candidates: 3, budgets: { per_day_usd: 5 } });
  assert.equal(fails.length, 1);
  assert.match(fails[0], /candidates: 3 but concurrency: 1/);

  // With the sizing declared, the ordinary three gates apply, which is the
  // point: candidates do not get a weaker door than concurrency.
  const noBudget = concurrencyGateFailures({ concurrency: 3, candidates: 3 });
  assert.equal(noBudget.length, 1);
  assert.match(noBudget[0], /no budgets\.per_day_usd/);
  assert.match(noBudget[0], /unbounded-times-3/);

  const writing = concurrencyGateFailures({ concurrency: 3, candidates: 3, mode: "bypass", budgets: { per_day_usd: 5 }, interrupt_on: { "mcp__linear__save": true } });
  assert.ok(writing.some((f) => /not read-only/.test(f)), `expected a posture failure, got ${JSON.stringify(writing)}`);

  assert.equal(concurrencyGateFailures({ concurrency: 3, candidates: 3, budgets: { per_day_usd: 5 } }).length, 0);

  // And the schema refuses the pack, with the reason, rather than accepting a
  // definition the platform would then reject at spawn.
  assert.throws(
    () => parseAgentMd(packMd(`${base}candidates: 3`)),
    /candidates: 3 but concurrency: 1/,
  );
  const ok = parseAgentMd(packMd(`${base}concurrency: 3\ncandidates: 3\nbudgets:\n  per_day_usd: 5\n  per_task_usd: 1`));
  assert.equal(ok.def.candidates, 3);
  // The default is no fan-out at all: an existing pack is untouched by this rung.
  assert.equal(parseAgentMd(packMd(base)).def.candidates, 1);
});

test("the selector names are a closed set", () => {
  const good: CandidateSelector[] = ["human", "first-verified"];
  for (const s of good) assert.ok(isCandidateSelector(s));
  assert.equal(isCandidateSelector("best"), false);
  assert.equal(isCandidateSelector(undefined), false);
});
