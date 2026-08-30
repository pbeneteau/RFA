/**
 * Wire 14 item 12 applied to this repository's own reliability gate: a subject's
 * self-report must not be an input to an automated decision.
 *
 * Two decisions were keyed on one - which run a score attaches to, and whether a
 * trial counts toward pass^k - and both are `... WHERE id = ?` or an
 * unconstrained INSERT underneath, so a wrong id was silently no rows.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { corroborateRefusal, resolveRun, type RunLookup, type RunRecord } from "../src/evals/runresolve.js";

const row = (id: string, status = "success", start = 100, end = 200): RunRecord => ({ id, name: "serve:pm-agent", group_id: "r_1", status, start_time: start, end_time: end });
const lookupOf = (rows: RunRecord[] | null): RunLookup => () => rows;
const ARGS = { agent: "pm-agent", from: 0, to: 1000 };

test("a claimed run id is accepted only when the store corroborates it", () => {
  const store = [row("run_real")];
  const good = resolveRun({ ...ARGS, claimed: "run_real", lookup: lookupOf(store) });
  assert.deepEqual(good, { ok: true, runId: "run_real", source: "corroborated" });
});

test("a claim the store does not know is NOT used as the key", () => {
  // The defect: `markReview("run_invented")` is an UPDATE matching no rows, and
  // `feedback` inserts an orphan. Both are silent, so a failing answer never
  // reaches the review queue.
  const store = [row("run_real")];
  const r = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf(store) });
  // One unambiguous run in the window: the store answers, and the claim loses.
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.runId, "run_real");
  assert.equal(r.ok && r.source, "resolved-by-window");
});

test("an ambiguous or empty window REFUSES rather than guessing, and says why", () => {
  const two = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf([row("a"), row("b")]) });
  assert.equal(two.ok, false);
  assert.match(two.ok === false ? two.reason : "", /2 runs for pm-agent/);
  assert.match(two.ok === false ? two.reason : "", /not among them/);
  const none = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf([]) });
  assert.equal(none.ok, false);
  assert.match(none.ok === false ? none.reason : "", /no run row/);
  // An unreadable store is not a licence to trust the claim.
  const dark = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf(null) });
  assert.equal(dark.ok, false);
  assert.match(dark.ok === false ? dark.reason : "", /a claim is not a measurement/);
});

test("a refusal leaves pass^k alone only when the subject's own record backs it", () => {
  // The live scenario this exclusion was earned by: a $3/day answerer hits its
  // ceiling and never starts a turn. No row, so nothing contradicts it.
  const preflight = corroborateRefusal({ ...ARGS, lookup: lookupOf([]) });
  assert.equal(preflight.excluded, true);
  assert.match(preflight.detail, /started no turn/);

  // It started and failed: also corroborated.
  const failed = corroborateRefusal({ ...ARGS, lookup: lookupOf([row("a", "error")]) });
  assert.equal(failed.excluded, true);
  assert.match(failed.detail, /error/);

  // THE HOLE: it completed a turn and then declared a refusal. Its own record
  // contradicts the self-report, so the trial counts - otherwise a member lowers
  // the denominator of its own gate by declaring its state.
  const lying = corroborateRefusal({ ...ARGS, lookup: lookupOf([row("a", "success")]) });
  assert.equal(lying.excluded, false);
  assert.match(lying.detail, /CONTRADICTED/);
  assert.match(lying.detail, /14 item 12/);

  // Unreadable store: fail closed, the same direction the overlap metric takes.
  const dark = corroborateRefusal({ ...ARGS, lookup: lookupOf(null) });
  assert.equal(dark.excluded, false);
  assert.match(dark.detail, /could not be corroborated/);
});

test("the residual is stated rather than papered over", () => {
  // A subject that declares a refusal without starting a turn is
  // indistinguishable from one that genuinely could not start: both leave no
  // row. This test exists so that fact is asserted rather than assumed, and so
  // a future change that claims to close it has to change this line.
  const honest = corroborateRefusal({ ...ARGS, lookup: lookupOf([]) });
  const liar = corroborateRefusal({ ...ARGS, lookup: lookupOf([]) });
  assert.deepEqual(honest, liar, "closing this needs a hub-stamped correlation id on the answer, which is a wire change");
});
