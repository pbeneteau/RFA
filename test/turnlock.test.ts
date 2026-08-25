/**
 * The resident's one-turn-at-a-time lock (src/turnlock.ts). The property under
 * test is the one the lease race depended on: two turns entered concurrently
 * must EXECUTE sequentially, in order, and a throwing turn must not wedge the
 * queue behind it.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeTurnLock } from "../src/turnlock.js";

const tick = () => new Promise((r) => setTimeout(r, 10));

test("turnlock: a turn entered mid-turn waits instead of overlapping", async () => {
  const oneTurn = makeTurnLock();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((r) => (releaseFirst = r));
  const first = oneTurn(async () => {
    order.push("first:start");
    await gate;
    order.push("first:end");
    return "first";
  });
  const second = oneTurn(async () => {
    order.push("second:start");
    return "second";
  });
  await tick();
  // The second turn is queued, not running: exactly what the shared-lease race needed.
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("turnlock: three turns run in entry order", async () => {
  const oneTurn = makeTurnLock();
  const order: number[] = [];
  await Promise.all(
    [1, 2, 3].map((n) =>
      oneTurn(async () => {
        order.push(n);
        await tick();
      }),
    ),
  );
  assert.deepEqual(order, [1, 2, 3]);
});

test("turnlock: a throwing turn releases the next one and keeps its own error", async () => {
  const oneTurn = makeTurnLock();
  await assert.rejects(
    oneTurn(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await oneTurn(async () => "after"), "after");
});
