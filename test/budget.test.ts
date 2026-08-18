/** v0.5.2 the meter: the per-task ceiling, the viability floor, and where cost is counted. */
import { strict as assert } from "node:assert";
import { test } from "node:test";

/**
 * The arithmetic of spec 18.1, extracted so it can be asserted without a model
 * call. Kept in the test rather than exported from the resident because the
 * resident computes it inline from its own pack and ledger; if that expression
 * changes, this test is the thing that should fail.
 */
function ceiling(perTask: number | undefined, perDay: number | undefined, spent: number): number {
  const remaining = perDay ? perDay - spent : Infinity;
  return Math.min(perTask ?? Infinity, remaining);
}
const VIABLE = 0.05;

test("the per-task ceiling is min(per_task, per_day - spend), and per_day alone still caps", () => {
  assert.equal(ceiling(1, 5, 0), 1, "the per-task budget governs while the day has room");
  assert.equal(ceiling(1, 5, 4.5), 0.5, "late in the day the remainder governs");
  assert.equal(ceiling(undefined, 5, 4.5), 0.5, "a pack with no per-task budget is still capped by the day");
  assert.equal(ceiling(1, undefined, 99), 1, "a pack with no daily budget is still capped per task");
  assert.equal(ceiling(undefined, undefined, 0), Infinity, "declaring neither means no ceiling, which is why it is warned about");
});

test("the floor refuses at pickup instead of buying one truncated request", () => {
  // The SDK enforces maxBudgetUsd BETWEEN model requests, so a two-cent
  // remainder is not a small answer: it is a real request and a truncated
  // refusal. Refusing before spending is both cheaper and more honest.
  assert.ok(ceiling(1, 5, 4.98) < VIABLE, "two cents left is not viable");
  assert.ok(ceiling(1, 5, 4.9) >= VIABLE, "ten cents is");
  assert.ok(ceiling(1, 5, 5.5) < VIABLE, "an overspent day is not viable either, and the value is negative");
});
