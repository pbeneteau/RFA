/**
 * Stopping a spawned hub must leave NOTHING behind.
 *
 * This exists because 119 orphaned hubs were found alive on the development
 * machine on 2026-08-19, the oldest three days old, holding 5.3 GB between them
 * and pushing the laptop 8 GB into swap. Four test files spawned hubs through
 * `npx -y tsx src/main.ts` and killed the child they got back; that child is the
 * npm wrapper, and SIGKILL is the one signal nothing can forward, so the hub
 * itself was never signalled. Every one of those test runs passed.
 *
 * That is the interesting part: no assertion in the suite was about the hub
 * still existing after teardown, so the leak was invisible from inside the
 * tests. The same shape was in the supervisor's drain, where it is not a tidiness
 * bug at all: a resident that missed its drain deadline kept running and kept
 * serving its membership while the supervisor recorded it as dead and started a
 * replacement, which is how two residents came to serve one membership for eight
 * hours. So the invariant gets a test of its own, stated as the property rather
 * than as the mechanism: after stopping, no process is still holding the port.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { spawnTsx, stopTree } from "../src/proc.js";
import { freePort, startHub, stopHub, ROOT } from "./hubproc.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every pid whose command line mentions this port, at any level of the wrapper stack. */
function pidsMentioning(needle: string): string[] {
  try {
    const out = execFileSync("/bin/ps", ["-eo", "pid=,command="], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((l) => l.includes(needle) && !l.includes("/bin/ps"))
      .map((l) => l.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
}

test("a stopped hub leaves no process holding its port", async () => {
  const hub = await startHub();
  const marker = `--http ${hub.port}`;
  assert.ok(pidsMentioning(marker).length > 0, "the hub should be visible in the process table while it serves");

  await stopHub(hub);
  // Exit is asynchronous even after SIGKILL; give the kernel a moment to reap.
  for (let i = 0; i < 40 && pidsMentioning(marker).length > 0; i++) await sleep(50);

  const survivors = pidsMentioning(marker);
  assert.equal(
    survivors.length,
    0,
    `stopping the hub left ${survivors.length} process(es) alive (${survivors.join(", ")}). ` +
      "This is the 119-orphan bug: signal the process GROUP, not the pid.",
  );
  // And the port is genuinely free again, which is the property an operator cares about.
  const res = await fetch(hub.base, { signal: AbortSignal.timeout(1_000) }).catch((e: Error) => e);
  assert.ok(res instanceof Error, "nothing should still be answering on the port");
});

test("stopTree reaps a child's own children, not just the child", async () => {
  // The resident case: it spawns the Agent SDK's `claude` binary, so a
  // pid-directed kill would orphan a process mid-answer. A tsx entrypoint is
  // itself the shape that used to leak, so spawning one and checking that its
  // whole tree goes away is the same assertion one level down.
  const port = await freePort();
  const proc = spawnTsx(`${ROOT}/src/main.ts`, ["--http", String(port), "--data", "none"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const marker = `--http ${port}`;
  for (let i = 0; i < 100 && pidsMentioning(marker).length === 0; i++) await sleep(50);
  assert.ok(pidsMentioning(marker).length > 0, "the spawned entrypoint should be running");

  await stopTree(proc, 2_000);
  for (let i = 0; i < 40 && pidsMentioning(marker).length > 0; i++) await sleep(50);
  assert.equal(pidsMentioning(marker).length, 0, "stopTree must leave no descendant behind");
});

test("stopTree on an already-dead child is a no-op, not a throw", async () => {
  const port = await freePort();
  const proc = spawnTsx(`${ROOT}/src/main.ts`, ["--http", String(port), "--data", "none"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  await new Promise<void>((r) => setTimeout(r, 500));
  await stopTree(proc, 1_000);
  // Twice: teardown paths call stop from both a finally and an after().
  await stopTree(proc, 1_000);
});
