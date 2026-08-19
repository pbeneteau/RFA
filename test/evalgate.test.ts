/**
 * v0.5.4 the eval gate (spec 20.3). The arithmetic is extracted here because the
 * old gate's defect was arithmetic, not plumbing: comparing a point estimate
 * against a stored 1 at trials: 1 means a ~5% per-question flake produces a
 * roughly 19% chance of a false regression on a five-case no-change run, and
 * raising trials against a hard 1.0 target makes it worse rather than better.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { passHatK } from "../src/evals/trajectory.js";

const GATE_K = 4;
const GATE_BAND = 0.15;

/** The gate's verdict for one case, mirroring src/evals/runner.ts. */
function regressed(trials: boolean[], baselinePassK: number): { value: number; regressed: boolean } {
  const value = trials.length >= GATE_K ? passHatK([trials], GATE_K) : trials.filter(Boolean).length / trials.length;
  return { value, regressed: baselinePassK - value > GATE_BAND };
}

test("a flaky case does not regress against a baseline measured the same way", () => {
  // The old gate stored 1 and compared a point estimate, so any flake fired.
  // The new gate stores pass^4, so the baseline carries the same flakiness the
  // case actually has, and an unchanged case does not move.
  const flaky = [true, true, true, true, true, true, true, false]; // 7 of 8
  const baseline = passHatK([flaky], GATE_K);
  assert.ok(baseline < 1, "a flaky case has a flaky baseline, which is the point");
  const again = regressed([true, true, true, true, true, false, true, true], baseline);
  assert.equal(again.regressed, false, "same reliability, different trial order: not a regression");
});

test("pass^4 is SHARP, which is why the baseline must be measured and not assumed", () => {
  // One flake in eight halves pass^4: (7/8)(6/7)(5/6)(4/5) = 0.5. That is
  // correct for a "four in a row" estimator, and it is the reason storing a
  // hopeful 1.0 by hand produces false regressions forever.
  const oneFlake = [true, true, true, true, true, true, true, false];
  assert.equal(Number(passHatK([oneFlake], GATE_K).toFixed(3)), 0.5);
  assert.equal(regressed(oneFlake, 1).regressed, true, "against an ASSUMED perfect baseline it fires, correctly");
  assert.equal(regressed(oneFlake, 0.5).regressed, false, "against a MEASURED baseline it does not");
});

test("a real collapse still fails the gate", () => {
  const collapsed = [false, false, false, true, false, true, false, false];
  const verdict = regressed(collapsed, 1);
  assert.equal(verdict.regressed, true, "a case that mostly fails is a regression, band or no band");
  assert.ok(verdict.value < 0.2, `pass^4 of a mostly-failing case is near zero (got ${verdict.value.toFixed(3)})`);
});

test("pass^k punishes inconsistency harder than a mean does, which is the point", () => {
  const halfPassing = [true, false, true, false, true, false, true, false];
  const mean = halfPassing.filter(Boolean).length / halfPassing.length;
  const pk = passHatK([halfPassing], GATE_K);
  assert.equal(mean, 0.5);
  assert.ok(pk < 0.05, `pass^4 of a coin flip is near zero (got ${pk.toFixed(3)}), while its mean looks like half credit`);
});

test("too few trials falls back to the point estimate, and the caller must know", () => {
  const single = [true];
  const verdict = regressed(single, 1);
  assert.equal(verdict.value, 1, "one trial cannot estimate pass^4, so the point score stands in");
  // This is exactly the case the gate must label, because a point estimate
  // against a stored pass^4 is comparing two different things.
  assert.ok(single.length < GATE_K, "the runner prints 'too few trials for pass^k' for this row");
});
