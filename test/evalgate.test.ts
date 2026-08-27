/**
 * v0.5.4 the eval gate (spec 20.3). The arithmetic is extracted into
 * src/evals/gate.ts because the old gate's defect was arithmetic, not plumbing:
 * comparing a point estimate against a stored 1 at trials: 1 means a ~5%
 * per-question flake produces a roughly 19% chance of a false regression on a
 * five-case no-change run, and raising trials against a hard 1.0 target makes it
 * worse rather than better.
 *
 * Every number below comes from the SHIPPED functions. This file used to re-type
 * the gate's arithmetic in a local helper, so the test named for a gate change
 * exercised no shipped code at all and would have passed against any runner.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compareToBaseline, gateValue, GATE_BAND, GATE_K, nextBaseline, type CaseBaseline } from "../src/evals/gate.js";
import { passHatK } from "../src/evals/trajectory.js";

/**
 * The gate's verdict for one case: a thin wrapper over the shipped gateValue and
 * compareToBaseline, with the baseline measured the same way this run was (the
 * comparable case). Nothing here re-implements the arithmetic.
 */
function regressed(trials: boolean[], baselinePassK: number): { value: number; regressed: boolean } {
  const current = gateValue(trials);
  const base: CaseBaseline = { passk: baselinePassK, k: current.k, estimated: current.estimated, definition_hash: null };
  return { value: current.value, regressed: compareToBaseline(current, base).verdict === "regressed" };
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

test("a live-concurrent case reaches the gate as tuple-level trials, and the arithmetic does not change", () => {
  // One trial of a concurrent case is one simultaneous PAIR, and it contributes
  // one boolean: the pair either held together or it did not. That is what keeps
  // pass^k applicable unchanged - the trials are still independent samples of one
  // thing - and it is also why a concurrent case is expensive per trial, so its
  // trials count is the honest limit on how sharp the estimate can be.
  const tuples = [true, true, true, true];
  assert.equal(passHatK([tuples], GATE_K), 1, "four clean pairs is pass^4 = 1, same estimator, same k");
  assert.equal(gateValue(tuples).k, GATE_K, "and four trials is exactly enough to estimate it");
  const oneBleed = [true, true, false, true];
  const verdict = regressed(oneBleed, 1);
  assert.ok(verdict.value < 0.01, `one contaminated pair in four collapses pass^4 (got ${verdict.value.toFixed(3)})`);
  assert.equal(verdict.regressed, true, "which is correct: a cross-conversation bleed one time in four is not noise");
  // Which is why the seeded concurrent case runs at 4 trials and not 2: below k
  // the gate can only ever hold a point estimate, where one failure is a 0.50
  // drop against a 0.15 band.
  assert.equal(gateValue([true, true]).estimated, false);
  assert.equal(regressed([true, false], 1).value, 0.5);
});

test("too few trials falls back to the point estimate, and the caller must know", () => {
  const single = [true];
  const verdict = regressed(single, 1);
  assert.equal(verdict.value, 1, "one trial cannot estimate pass^4, so the point score stands in");
  // This is exactly the case the gate must label, because a point estimate
  // against a stored pass^4 is comparing two different things.
  assert.equal(gateValue(single).estimated, false, "the runner prints 'too few trials for pass^k' for this row");
  assert.equal(gateValue(single).k, 1, "and the baseline stores the k it actually used, not the gate's k");
});

test("the baseline stores the k it MEASURED, and a comparison across two different k is REFUSED", () => {
  // The dishonesty this replaces: `--update-baseline` wrote k: 4 beside a
  // two-trial point estimate, so every later run compared two different
  // quantities while the file claimed they were one.
  const twoTrials = gateValue([true, true]);
  assert.deepEqual(twoTrials, { value: 1, k: 2, estimated: false });
  const fourTrials = gateValue([true, true, true, false]);
  assert.equal(fourTrials.k, GATE_K);
  assert.equal(fourTrials.estimated, true);

  // A stored pass^4 against this run's two-trial point estimate: incomparable,
  // and the gate says so rather than inventing a movement in either direction.
  const storedAtFour: CaseBaseline = { passk: 1, k: GATE_K, estimated: true, definition_hash: null };
  const across = compareToBaseline(twoTrials, storedAtFour);
  assert.equal(across.verdict, "incomparable");
  assert.match(across.verdict === "incomparable" ? across.detail : "", /baseline holds pass\^4 = 1\.00, this run measured a point estimate over 2 trial\(s\) = 1\.00/);
  // Note what the old arithmetic would have said here: 1.00 - 1.00 = no drop, a
  // clean pass. The danger runs the other way too, so the refusal is symmetric.
  const collapsedAtTwo = compareToBaseline(gateValue([false, false]), storedAtFour);
  assert.equal(collapsedAtTwo.verdict, "incomparable", "a collapse measured at the wrong k is still not a comparison");

  // Same k, same shape: compared normally.
  assert.equal(compareToBaseline(fourTrials, { passk: fourTrials.value, k: GATE_K, estimated: true, definition_hash: null }).verdict, "ok");
  assert.equal(compareToBaseline(gateValue([true, true, true, true]), undefined).verdict, "no-baseline", "the first run of a case is never a regression");
});

test("a baseline written BEFORE the honest-k fix still compares: the file is always older than the code", () => {
  // Rows already on disk carry no `estimated` at all. Reading their absence as
  // "not a pass^k" would have turned every existing baseline INCOMPARABLE on the
  // next run and taken the whole gate to "did not check" overnight, so an absent
  // flag is resolved the way the old gate itself read it: k >= GATE_K.
  const legacyAtFour = { passk: 1, k: GATE_K, definition_hash: "sha256:x" };
  assert.equal(compareToBaseline(gateValue([true, true, true, true]), legacyAtFour).verdict, "ok");
  assert.equal(compareToBaseline(gateValue([true, false, false, false]), legacyAtFour).verdict, "regressed", "and it still fires on a real collapse");
  // A legacy row for a case that only ever ran 2 trials claimed k: 4 anyway. That
  // claim is exactly what must not be compared to a 2-trial point estimate.
  assert.equal(compareToBaseline(gateValue([true, true]), legacyAtFour).verdict, "incomparable");
  // Keeping such a row (its case was blocked) writes the implied flag down.
  const kept = nextBaseline([{ id: "legacy", trials: [], blocked: "no room" }], { legacy: legacyAtFour });
  assert.deepEqual(kept["legacy"], { passk: 1, k: GATE_K, estimated: true, definition_hash: "sha256:x" });
});

test("--update-baseline never writes a BLOCKED case: a configuration state must not enter the file as quality", () => {
  // The three ways a case does not run - every trial refused, no room, an
  // unresolvable subject_capability or a malformed case - all arrive as `blocked`,
  // and all of them used to be able to reach the file as a score. A stored 0 is
  // permanent: nothing can drop below it, so the gate goes blind on that case.
  const previous: Record<string, CaseBaseline> = {
    "kept-by-block": { passk: 0.75, k: GATE_K, estimated: true, definition_hash: "sha256:old" },
  };
  const next = nextBaseline(
    [
      { id: "measured", trials: [true, true, true, false], definition_hash: "sha256:new" },
      { id: "kept-by-block", trials: [], blocked: "every trial refused: daily budget exhausted" },
      { id: "never-ran", trials: [], blocked: "no roster member offers answer-protocol-question" },
      { id: "two-trials", trials: [true, true] },
    ],
    previous,
  );
  assert.deepEqual(Object.keys(next).sort(), ["kept-by-block", "measured", "two-trials"], "a blocked case with no previous baseline gets NO entry");
  assert.deepEqual(next["kept-by-block"], previous["kept-by-block"], "and one with a previous baseline keeps it, untouched");
  assert.equal(next["never-ran"], undefined, "a case that could not run is absent, not zero");
  // And the honest k, per case, at whatever it was measured.
  assert.deepEqual(next["measured"], { passk: passHatK([[true, true, true, false]], GATE_K), k: GATE_K, estimated: true, definition_hash: "sha256:new" });
  assert.deepEqual(next["two-trials"], { passk: 1, k: 2, estimated: false, definition_hash: null });
});

test("the band is what makes the gate usable, and it is a CHOSEN number", () => {
  // 0.15 absolute, chosen not measured (spec 20.3), which is why the runner
  // prints its own flake rate beside every verdict. Only a drop WIDER than the
  // band fires. (The boundary itself is not pinned: 1 - 0.15 is 0.85 in decimal
  // and 0.8500000000000001 in floating point, and a test on that is a test of
  // IEEE 754.)
  assert.equal(GATE_BAND, 0.15);
  const base: CaseBaseline = { passk: 1, k: GATE_K, estimated: true, definition_hash: null };
  assert.equal(compareToBaseline({ value: 0.9, k: GATE_K, estimated: true }, base).verdict, "ok", "a 0.10 drop is inside the band");
  const past = compareToBaseline({ value: 0.8, k: GATE_K, estimated: true }, base);
  assert.equal(past.verdict, "regressed", "a 0.20 drop is not");
  assert.equal(past.verdict === "regressed" ? Number(past.drop.toFixed(2)) : null, 0.2);
});
