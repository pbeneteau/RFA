/** The card backstop's ledger (RFA-0.4 sect. 3.12): a carded command that executes without a card ahead of it is the SDK's session cache bypassing door one. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { CardLedger } from "../src/bridge.js";

test("a card must lead every execution; the first execution without one is the bypass", () => {
  // The measured failure (2026-08-30): two approved Bash cards, then 16
  // commands with none, because the SDK caches a permission decision per
  // session and canUseTool stops firing.
  const led = new CardLedger(new Set(["Bash"]));
  // legitimate: card fires, then the tool executes
  led.reached("Bash");
  assert.equal(led.executed("Bash"), null, "execution 1 had card 1 ahead of it");
  led.reached("Bash");
  assert.equal(led.executed("Bash"), null, "execution 2 had card 2 ahead of it");
  // the cache engages: no card, tool runs anyway
  assert.equal(led.executed("Bash"), "Bash", "execution 3 with only 2 cards is the bypass");
  // and it keeps flagging
  assert.equal(led.executed("Bash"), "Bash");
});

test("a command the pack does NOT card is never watched", () => {
  const led = new CardLedger(new Set(["Bash"]));
  // Read is not in the carded set: executing it, uncarded, is normal
  assert.equal(led.executed("Read"), null);
  led.reached("Read"); // no-op
  assert.equal(led.executed("Read"), null);
});

test("keyed per tool head: one tool's cards do not cover another's executions", () => {
  const led = new CardLedger(new Set(["Bash", "Write"]));
  led.reached("Bash");
  assert.equal(led.executed("Write"), "Write", "a Bash card does not authorize a Write execution");
  assert.equal(led.executed("Bash"), null, "Bash still has its own card");
});

test("the empty carded set backstops nothing (a command pack that cards no commands)", () => {
  const led = new CardLedger(new Set());
  for (let i = 0; i < 5; i++) assert.equal(led.executed("Bash"), null);
});
