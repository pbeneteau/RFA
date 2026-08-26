/**
 * A child process that races one canonical action identity (RFA-0.8 sect. 6.4).
 *
 * Not a test: `test/consumption.test.ts` spawns several of these at one wall
 * clock instant against one `runs.db`, which is the only shape that proves
 * anything here. Per-process sequencing of the consumption ledger does not
 * compose across processes and MUST NOT be relied on, so a same-process test of
 * this mechanism asserts exactly the property the spec says is not the property.
 *
 * Deliberately no top-level await: `claimAction` is synchronous, and the file
 * stays runnable however a future loader treats it.
 */
import { Engine } from "../src/engine.js";

const [dbPath, identity, effectClass, startAt] = process.argv.slice(2);
// A wall-clock barrier: every racer leaves the gate together, so the contention
// is real rather than an artefact of process start order.
const go = Number(startAt);
while (Date.now() < go) {
  /* spin: the window is tens of milliseconds and a timer would add its own jitter */
}
const engine = new Engine(dbPath);
const res = engine.claimAction({
  identity,
  agent: "racer",
  toolName: "linear__save_document",
  scope: "task:t_1",
  effectClass,
  runId: `run_${process.pid}`,
});
process.stdout.write(
  JSON.stringify({
    pid: process.pid,
    ok: res.ok,
    key: res.idempotency_key,
    reason: res.ok ? null : res.reason,
  }),
);
engine.close();
