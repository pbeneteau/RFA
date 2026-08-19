/** v0.4.3 observability: run tree via dotted_order, universal feedback, summary math, alerts, retention. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ObsStore, dottedSegment, evaluateAlerts, formatReviewDigest } from "../src/obs.js";

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
