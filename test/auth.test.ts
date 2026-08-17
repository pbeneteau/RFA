/** v0.5.0 auth hardening (spec 15.5): constant-time key compare, the per-source attempt limit, the separate auth log. */
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HK = "hk_auth_test";
const MAX_FAILURES = 10; // AUTH_MAX_FAILURES in src/main.ts

let hub: ChildProcess;
let base: string;
let dataDir: string;

/** What the aggregated auth-log row must add up to: every /auth response, counted once. */
const expected = { successes: 0, failures: 0 };

async function auth(key: string): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ human_key: key }),
  });
  const body = (await r.json()) as Record<string, unknown>;
  if (r.status === 200) expected.successes++;
  else expected.failures++;
  return { status: r.status, retryAfter: r.headers.get("retry-after"), body };
}

/** A good key clears the source's record, so each test starts from a known count. */
async function reset(): Promise<void> {
  const ok = await auth(HK);
  assert.equal(ok.status, 200, "the provisioned key must authenticate");
}

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
  base = `http://127.0.0.1:${port}`;
  // A private data dir: the auth log is asserted on disk, and the hub must own its lockfile exclusively.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-auth-"));
  hub = spawn("npx", ["-y", "tsx", "src/main.ts", "--http", String(port), "--data", dataDir, "--human-key", HK], {
    cwd: ROOT,
    stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    if (i >= 100) throw new Error("hub did not come up");
    try {
      // 401 proves the listener is up without spending an /auth attempt.
      if ((await fetch(`${base}/api/agents`)).status === 401) break;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
});

after(() => {
  hub.kill("SIGKILL");
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("a provisioned key authenticates; a wrong key is refused whatever its length", async () => {
  const ok = await auth(HK);
  assert.equal(ok.status, 200);
  assert.match(String(ok.body.session_token), /^st_/, "the console's contract: {session_token, ttl_s}");
  assert.equal(ok.body.ttl_s, 12 * 3600);

  const wrongSameLength = await auth("hk_auth_tesX");
  assert.equal(wrongSameLength.status, 401);
  assert.equal(wrongSameLength.body.error, "invalid human_key");

  // The length-mismatch path: timingSafeEqual throws on it, so it must be handled, not short-circuited.
  const wrongShort = await auth("x");
  assert.equal(wrongShort.status, 401);
  const wrongLong = await auth("hk_auth_test_with_a_much_longer_tail");
  assert.equal(wrongLong.status, 401);
});

test("a successful auth resets the source's failure counter", async () => {
  for (let round = 0; round < 2; round++) {
    await reset();
    // One below the limit, twice over: without the reset the second round would trip.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const r = await auth("hk_wrong_key");
      assert.equal(r.status, 401, `failure ${i + 1} of round ${round} must be refused, not locked out`);
    }
  }
});

test("repeated wrong keys lock the source out with 429 and Retry-After", async () => {
  await reset();
  for (let i = 1; i < MAX_FAILURES; i++) {
    assert.equal((await auth("hk_wrong_key")).status, 401, `attempt ${i} is below the limit`);
  }
  const tripped = await auth("hk_wrong_key");
  assert.equal(tripped.status, 429, `attempt ${MAX_FAILURES} must trip the lock`);
  const retryS = Number(tripped.retryAfter);
  assert.ok(Number.isInteger(retryS) && retryS > 0, `Retry-After must be a positive integer (got ${tripped.retryAfter})`);
  assert.equal(tripped.body.retry_after_s, retryS);

  const stillLocked = await auth("hk_wrong_key");
  assert.equal(stillLocked.status, 429);
  assert.ok(Number(stillLocked.retryAfter) > 0);

  // The lock gates the endpoint, not just wrong keys: the correct key waits too.
  const goodKeyWhileLocked = await auth(HK);
  assert.equal(goodKeyWhileLocked.status, 429, "a locked source must not reach the key comparison");
});

test("the auth log is one aggregated row per window, not one row per attempt", async () => {
  const attempts = expected.successes + expected.failures;
  assert.ok(attempts > 20, `the tests above must spend enough attempts for the distinction to matter (${attempts})`);

  // The open window flushes on exit; SIGTERM, not SIGKILL, so the handler runs.
  const exited = new Promise<void>((r) => hub.once("exit", () => r()));
  hub.kill("SIGTERM");
  await exited;

  const file = path.join(dataDir, "auth.log.ndjson");
  assert.ok(fs.existsSync(file), "auth events belong in a separate append-only log, never a room's chain");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the auth log must be created 0600");

  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${attempts} attempts must aggregate into one window row, not ${lines.length}`);
  const row = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(row).sort(),
    ["distinct_sources", "failures", "hash", "lockouts", "prev_hash", "successes", "window_end", "window_start"],
    "window bounds plus aggregated counters, on the log's own chain",
  );
  assert.equal(row.successes, expected.successes);
  assert.equal(row.failures, expected.failures);
  assert.equal(row.lockouts, 1, "the trip is logged to the separate auth log");
  assert.equal(row.distinct_sources, 1, "every attempt came from loopback");
  assert.ok(Date.parse(String(row.window_start)) <= Date.parse(String(row.window_end)));
  assert.match(String(row.prev_hash), /^[0-9a-f]{64}$/, "its own genesis, not a room's chain head");
  assert.match(String(row.hash), /^[0-9a-f]{64}$/);
});
