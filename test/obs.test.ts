/** v0.4.3 observability: run tree via dotted_order, universal feedback, summary math, alerts, retention. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AlertCooldown, ObsStore, dottedSegment, evaluateAlerts, formatReviewDigest } from "../src/obs.js";

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-obs-"));
  return { dir, obs: new ObsStore(path.join(dir, "obs.db")) };
}

test("dotted_order: lexicographic sort of one column is depth-first trace traversal", () => {
  const { dir, obs } = fresh();
  const t0 = Date.UTC(2026, 7, 17, 10, 0, 0, 0);
  const root = obs.record({ id: "r1", name: "serve", run_type: "agent_span", start_time: t0, end_time: t0 + 5000 });
  const childA = obs.record({
    id: "c1", trace_id: root.trace_id, parent_run_id: root.id, parent_dotted_order: root.dotted_order,
    name: "claude", run_type: "generation_span", start_time: t0 + 100, end_time: t0 + 4000,
  });
  obs.record({
    id: "g1", trace_id: root.trace_id, parent_run_id: childA.id, parent_dotted_order: childA.dotted_order,
    name: "grep", run_type: "tool", start_time: t0 + 200, end_time: t0 + 300,
  });
  obs.record({
    id: "c2", trace_id: root.trace_id, parent_run_id: root.id, parent_dotted_order: root.dotted_order,
    name: "post", run_type: "function_span", start_time: t0 + 4500, end_time: t0 + 4600,
  });
  const trace = obs.trace(root.trace_id);
  assert.deepEqual(trace.map((r) => r.id), ["r1", "c1", "g1", "c2"], "parent before children, siblings by start time");
  assert.ok(trace[2].dotted_order.startsWith(trace[1].dotted_order + "."), "grandchild extends child's dotted_order");
  assert.match(dottedSegment(t0, "x1"), /^20260817T100000000Zx1$/);
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("feedback: one record for every writer; summary aggregates runs and scores", () => {
  const { dir, obs } = fresh();
  const now = Date.now();
  obs.record({ id: "ok1", name: "serve", run_type: "agent_span", start_time: now - 10_000, end_time: now - 8_000, cost_usd: 0.02 });
  obs.record({ id: "ok2", name: "serve", run_type: "agent_span", start_time: now - 7_000, end_time: now - 1_000, cost_usd: 0.03 });
  obs.record({ id: "bad", name: "serve", run_type: "agent_span", start_time: now - 5_000, end_time: now - 4_000, error: "boom" });
  obs.record({ id: "tool1", name: "rfa.room_listen", run_type: "tool", start_time: now - 60_000, end_time: now - 100 });
  obs.feedback({ run_id: "ok1", key: "parity", score: 1, source_type: "evaluator" });
  obs.feedback({ run_id: "bad", key: "parity", score: 0, comment: "missing fact", source_type: "evaluator" });
  obs.feedback({ run_id: "ok2", key: "thumbs", score: 1, source_type: "human" });
  const s = obs.summary(60_000, now);
  assert.equal(s.runs, 3, "tool spans excluded from the signal");
  assert.equal(s.errors, 1);
  assert.ok(Math.abs(s.error_pct - 33.33) < 0.5);
  assert.ok(Math.abs(s.cost_usd - 0.05) < 1e-9);
  assert.equal(s.feedback_count, 3);
  assert.ok(Math.abs((s.avg_feedback ?? 0) - 2 / 3) < 1e-9);
  assert.equal(obs.feedbackFor("bad")[0].comment, "missing fact");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("evaluateAlerts: the LangSmith triad with minimum-volume guards", () => {
  const base = { window_ms: 900_000, runs: 10, errors: 0, error_pct: 0, avg_latency_ms: 5_000, feedback_count: 0, avg_feedback: null, cost_usd: 0 };
  assert.deepEqual(evaluateAlerts(base), []);
  assert.equal(evaluateAlerts({ ...base, errors: 3, error_pct: 30 })[0]?.kind, "error_pct");
  assert.equal(evaluateAlerts({ ...base, avg_latency_ms: 45_000 })[0]?.kind, "latency");
  assert.equal(evaluateAlerts({ ...base, feedback_count: 4, avg_feedback: 0.2 })[0]?.kind, "feedback");
  // Volume guards: two runs at 100% error is noise, not an alert.
  assert.deepEqual(evaluateAlerts({ ...base, runs: 2, errors: 2, error_pct: 100 }), []);
  assert.deepEqual(evaluateAlerts({ ...base, feedback_count: 1, avg_feedback: 0 }), []);
});

test("retention: prune drops old runs but keeps feedback-bearing and needs_review rows", () => {
  const { dir, obs } = fresh();
  const now = Date.now();
  const old = now - 30 * 86_400_000;
  obs.record({ id: "old-plain", name: "serve", run_type: "agent_span", start_time: old, end_time: old + 1000 });
  obs.record({ id: "old-fb", name: "serve", run_type: "agent_span", start_time: old, end_time: old + 1000 });
  obs.feedback({ run_id: "old-fb", key: "parity", score: 1, source_type: "evaluator" });
  obs.record({ id: "old-review", name: "serve", run_type: "agent_span", start_time: old, end_time: old + 1000 });
  obs.markReview("old-review", true);
  obs.record({ id: "recent", name: "serve", run_type: "agent_span", start_time: now - 1000, end_time: now });
  assert.equal(obs.prune(14, now), 1, "only the plain old run goes");
  assert.equal(obs.get("old-plain"), null);
  assert.ok(obs.get("old-fb"));
  assert.ok(obs.get("old-review"));
  assert.ok(obs.get("recent"));
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("review queues (20.5): queue 1 is flagged or negatively-scored runs, over the same population as the summary", () => {
  const { dir, obs } = fresh();
  const now = Date.now();
  const at = (i: number, ms = 1_000, cost = 0.01) =>
    obs.record({
      id: `run${i}`, name: "serve", run_type: "agent_span",
      start_time: now - 60_000, end_time: now - 60_000 + ms, cost_usd: cost,
    });
  for (let i = 0; i < 12; i++) at(i);
  // A tool span must NOT count: the digest's two numbers have to be over one population.
  obs.record({ id: "tool1", name: "grep", run_type: "tool", start_time: now - 60_000, end_time: now - 59_000 });

  obs.markReview("run3", true);
  obs.feedback({ run_id: "run4", key: "judge", score: 0, source_type: "model", rubric_hash: "abc" });
  obs.feedback({ run_id: "run5", key: "human", score: -1, source_type: "human" });
  // A passing score is not a review item.
  obs.feedback({ run_id: "run6", key: "judge", score: 1, source_type: "model", rubric_hash: "abc" });

  const q = obs.reviewQueues(3_600_000, now);
  assert.equal(q.runs, 12, "tool spans are excluded, as in summary()");
  assert.equal(q.flagged, 3, "needs_review, score 0 and score -1; a score of 1 is not review work");
  assert.deepEqual(q.flagged_run_ids.slice(0, 3).sort(), ["run3", "run4", "run5"]);
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("review queues: p90 needs ten runs to rank, and above-p90 is a top decile, not an anomaly", () => {
  const { dir, obs } = fresh();
  const now = Date.now();
  const add = (i: number, ms: number, cost: number) =>
    obs.record({
      id: `r${i}`, name: "serve", run_type: "agent_span",
      start_time: now - 30_000, end_time: now - 30_000 + ms, cost_usd: cost,
    });

  // Under ten runs there is no decile to speak of: reporting the largest run as
  // "above p90" would make every quiet window look anomalous.
  for (let i = 0; i < 9; i++) add(i, 1_000 + i, 0.01);
  let q = obs.reviewQueues(3_600_000, now);
  assert.equal(q.p90_latency_ms, null, "fewer than 10 runs: unranked");
  assert.equal(q.top_decile, 0, "and therefore an empty queue, not a spurious one");

  add(9, 60_000, 0.5); // one slow and expensive run makes ten
  q = obs.reviewQueues(3_600_000, now);
  assert.notEqual(q.p90_latency_ms, null, "ten runs can be ranked");
  assert.ok(q.top_decile >= 1 && q.top_decile <= 2, `the tail, not the population (got ${q.top_decile})`);
  assert.ok(q.top_decile < q.runs, "a percentile queue can never be everything");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the digest names an empty queue rather than saying nothing", () => {
  // A silent channel and a dead channel look identical, and this project's #ops
  // channel WAS dead for a day without anyone noticing.
  const quiet = formatReviewDigest({
    window_ms: 24 * 3_600_000, runs: 0, flagged: 0, flagged_run_ids: [], top_decile: 0,
    p90_cost_usd: null, p90_latency_ms: null,
  });
  assert.match(quiet, /nothing to review/, "an idle day still produces a line");

  const busy = formatReviewDigest({
    window_ms: 24 * 3_600_000, runs: 40, flagged: 2, flagged_run_ids: ["a", "b"], top_decile: 4,
    p90_cost_usd: 0.0812, p90_latency_ms: 24_500,
  });
  assert.match(busy, /review queue: 2 runs \(a, b\)/);
  assert.match(busy, /top decile: 4 above p90/, "named as a decile, never as anomalies");
  assert.ok(!/anomal/i.test(busy), "the digest must not overstate what queue 2 is");
  assert.match(busy, /24\.5s/, "p90 latency in seconds, the unit an operator reads");

  const unranked = formatReviewDigest({
    window_ms: 3_600_000, runs: 4, flagged: 0, flagged_run_ids: [], top_decile: 0,
    p90_cost_usd: null, p90_latency_ms: null,
  });
  assert.match(unranked, /not ranked \(under 10 runs/, "says why the decile is absent instead of printing a 0");
});

test("a credential failure alerts with NO minimum-volume guard, because it is a state not a rate", () => {
  // Measured 2026-08-19: an expired OAuth session produced runs=1, errors=1,
  // error_pct=100% in the supervisor's 15-minute window and raised NOTHING, because
  // the rate checks require 5 runs. A quiet room is where an outage is least likely
  // to be noticed and most likely to persist, so the volume guard produced exactly
  // the silence it exists to prevent.
  const { dir, obs } = fresh();
  const now = Date.now();
  obs.record({
    id: "run_auth1", name: "serve:pm-agent", run_type: "agent_span",
    start_time: now - 2000, end_time: now - 500, status: "error",
    error: "brain error: Failed to authenticate: OAuth session expired and could not be refreshed",
  });

  const s = obs.summary(15 * 60_000, now);
  assert.equal(s.runs, 1, "one run is below every rate check's minimum");
  assert.equal(s.auth_errors, 1);
  const alerts = evaluateAlerts(s);
  assert.deepEqual(alerts.map((a) => a.kind), ["credential"], "the rate checks stay silent; this one does not");
  assert.match(alerts[0].message, /no agent can answer/);
  assert.match(alerts[0].message, /Retrying does not help/, "the operator is told waiting is not the fix");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an ordinary error does NOT raise a credential alert", () => {
  const { dir, obs } = fresh();
  const now = Date.now();
  for (const [i, err] of ["brain error: error_max_turns", "429 rate_limited", "socket hang up"].entries()) {
    obs.record({
      id: `run_other${i}`, name: "serve:pm-agent", run_type: "agent_span",
      start_time: now - 2000, end_time: now - 500, status: "error", error: err,
    });
  }
  const s = obs.summary(15 * 60_000, now);
  assert.equal(s.auth_errors, 0, "a turn ceiling, a rate limit and a dropped socket are not credential failures");
  assert.equal(evaluateAlerts(s).length, 0, "and three runs is still below the rate checks' minimum");
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the SQL classifier and isAuthError agree, so they cannot drift apart", async () => {
  // The same condition is decided in two languages: SQL inside summary(), and a
  // regex in src/account.ts that the resident uses to choose a refusal reason. This
  // pins them to each other rather than each to a hand-written expectation.
  const { isAuthError } = await import("../src/account.js");
  const { dir, obs } = fresh();
  const now = Date.now();
  const cases = [
    // The pre-2026-08-24 shape: the resident once printed the SDK's "success"
    // subtype verbatim, and rows already in obs.db keep that text forever.
    "brain error: success: Failed to authenticate: OAuth session expired and could not be refreshed",
    // What the resident writes now (the subtype is dropped when it says nothing).
    "brain error: Failed to authenticate: OAuth session expired and could not be refreshed",
    "Failed to authenticate: OAuth session expired",
    "invalid_api_key: your key is not valid",
    "authentication_error",
    "could not be refreshed",
    // A host that never authenticated at all, measured on a fresh clone 2026-08-21
    // (one in the pre-2026-08-24 shape, one in the current one).
    "brain error: success: Not logged in · Please run /login",
    "brain error: Not logged in · Run /login",
    // Prose that contains ONE of the two required phrases must NOT classify:
    // model-authored result text reaches the classifier via the brain error.
    "brain error: the GitHub CLI is not logged in, so I could not fetch the PR",
    "Run /login after upgrading to use your new plan.",
    "brain error: error_max_turns",
    "429 rate_limited: too many requests",
    "socket hang up",
    "fetch failed",
    "overloaded_error: the model is overloaded",
  ];
  for (const [i, err] of cases.entries()) {
    const { dir: d2, obs: o2 } = fresh();
    o2.record({
      id: `run_${i}`, name: "serve:x", run_type: "agent_span",
      start_time: now - 1000, end_time: now - 100, status: "error", error: err,
    });
    const sqlSaysAuth = o2.summary(60_000, now).auth_errors === 1;
    assert.equal(sqlSaysAuth, isAuthError(new Error(err)), `disagreement on ${JSON.stringify(err)}`);
    o2.close();
    fs.rmSync(d2, { recursive: true, force: true });
  }
  obs.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("AlertCooldown: the first is due, the repeat is not, and the cooldown expires", () => {
  const cd = new AlertCooldown(30 * 60_000);
  const a = { kind: "error_pct" as const, message: "40% over 12 runs" };
  assert.deepEqual(cd.due([a], 1_000), [a], "nothing sent yet, so it is due");
  assert.deepEqual(cd.due([a], 1_000 + 29 * 60_000), [], "still inside the cooldown");
  assert.deepEqual(cd.due([a], 1_000 + 31 * 60_000), [a], "past it, the operator hears it again");
});

test("AlertCooldown: one watchdog invariant firing never silences another", () => {
  // Every watchdog alert shares the kind `watchdog` (spec 20.6, src/watchdog.ts).
  // Keying the cooldown on kind, which is what the triad needed, would let the
  // first invariant to speak mute the rest for the whole window.
  const cd = new AlertCooldown(30 * 60_000);
  const stuck = { kind: "watchdog" as const, key: "watchdog:engine-run-stuck-running", message: "1 run stuck" };
  const other = { kind: "watchdog" as const, key: "watchdog:some-other-invariant", message: "something else" };
  assert.deepEqual(cd.due([stuck], 0), [stuck]);
  assert.deepEqual(
    cd.due([stuck, other], 60_000).map((x) => x.key),
    ["watchdog:some-other-invariant"],
    "the second invariant is heard while the first is still cooling down",
  );
});
