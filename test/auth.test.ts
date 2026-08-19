/**
 * v0.5.0 auth hardening (spec 15.5): constant-time key compare, the per-source attempt limit, the separate auth log.
 * Extended for hub 0.6.0a: the OPT-IN transport bearer in front of /mcp (RFA-0.6 sect. 4.2).
 */
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startHub as spawnTestHub, stopAllHubs, type TestHub } from "./hubproc.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HK = "hk_auth_test";
const MAX_FAILURES = 10; // AUTH_MAX_FAILURES in src/main.ts

let hub: ChildProcess;
let base: string;
let dataDir: string;

/** What the aggregated auth-log row must add up to: every /auth response, counted once. */
const expected = { successes: 0, failures: 0 };

type HubProc = TestHub & { dataDir: string };
const spawned: HubProc[] = [];

/** A hub on its own port with its own data dir: the auth log is asserted on disk and the hub must own its lockfile exclusively. */
async function startHub(extraArgs: string[]): Promise<HubProc> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-auth-"));
  // The shared helper owns the spawn and the readiness probe (an unauthenticated
  // 401 on /api/agents, which costs no /auth attempt); this wrapper adds the data
  // dir the log assertions read.
  const h: HubProc = { ...(await spawnTestHub(["--data", dir, "--human-key", HK, ...extraArgs])), dataDir: dir };
  spawned.push(h);
  return h;
}

type McpReply = { status: number; wwwAuthenticate: string | null; retryAfter: string | null; text: string };

/** One raw MCP tools/call over Streamable HTTP, shaped exactly as src/client.ts `rawCall` shapes it. */
async function mcpCall(
  target: string,
  tool: string,
  args: Record<string, unknown>,
  token?: string,
): Promise<McpReply> {
  const r = await fetch(`${target}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "Mcp-Method": "tools/call",
      "Mcp-Name": tool,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  return {
    status: r.status,
    wwwAuthenticate: r.headers.get("www-authenticate"),
    retryAfter: r.headers.get("retry-after"),
    text: await r.text(),
  };
}

/** Unwrap the tool result from either era's framing (SSE data: line, or a bare JSON body). */
function mcpResult(text: string): Record<string, unknown> {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(line ? line.slice(6) : text) as { result: { content: { text: string }[] } };
  return JSON.parse(payload.result.content[0].text) as Record<string, unknown>;
}

/** room_create args: the verb sect. 4.2 names, because uncredentialed it is a resource-creation primitive. */
function roomArgs(topic: string): Record<string, unknown> {
  return {
    topic,
    name: "tester",
    card: { name: "tester", description: "transport auth test", skills: [{ id: "s", description: "test skill" }] },
  };
}

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
  // No --mcp-token: the shipped default, which is the mode the whole live system runs in.
  const h = await startHub([]);
  hub = h.proc;
  base = h.base;
  dataDir = h.dataDir;
});

after(async () => {
  // stopAllHubs reaps the process TREE; killing the pid left the real hub alive
  // on its port (src/proc.ts, and 119 orphans found on 2026-08-19).
  await stopAllHubs();
  for (const h of spawned) fs.rmSync(h.dataDir, { recursive: true, force: true });
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

// ---------------------------------------------------------------- /mcp transport bearer (RFA-0.6 sect. 4.2)
// The credential is OPT-IN, and the default is what these tests guard hardest:
// both residents, the ask CLI, the console page and the eval harness POST to
// /mcp with no Authorization header, because src/client.ts sends none. A
// mandatory token would break every one of them.

test("with no token configured, /mcp is uncredentialed exactly as before", async () => {
  const r = await mcpCall(base, "room_create", roomArgs("default off"));
  assert.equal(r.status, 200, "no token configured must mean no header required: this is the live system's regression");
  assert.equal(r.wwwAuthenticate, null, "an endpoint that requires nothing must not challenge for anything");
  assert.match(String(mcpResult(r.text).room), /^r_/, "room_create still reachable with no credential (sect. 4.1)");
});

const MCP_TOKEN = "mt_" + "a".repeat(43); // opaque and long, as sect. 4.2 requires of a real one
const MCP_TOKEN_2 = "mt_" + "b".repeat(31); // a second configured token, and a different length
/** Every /mcp response on the token hub, counted once, to check against the window row. */
const expectedMcp = { successes: 0, failures: 0 };
let tokenHub: HubProc;

async function tokenMcp(tool: string, args: Record<string, unknown>, token?: string): Promise<McpReply> {
  const r = await mcpCall(tokenHub.base, tool, args, token);
  if (r.status === 200) expectedMcp.successes++;
  else expectedMcp.failures++;
  return r;
}

test("with tokens configured, /mcp refuses 401 without a valid bearer and serves with one", async () => {
  tokenHub = await startHub(["--mcp-token", `${MCP_TOKEN},${MCP_TOKEN_2}`]);

  const noHeader = await tokenMcp("room_create", roomArgs("no header"));
  assert.equal(noHeader.status, 401, "a request with no Authorization header must not reach the MCP handler");
  assert.match(
    String(noHeader.wwwAuthenticate),
    /^Bearer\b/,
    "the refusal must be well-formed for an MCP client: WWW-Authenticate: Bearer",
  );
  const body = JSON.parse(noHeader.text) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "401 carries a JSON body, not an empty response");

  const wrong = await tokenMcp("room_create", roomArgs("wrong token"), "mt_" + "c".repeat(43));
  assert.equal(wrong.status, 401, "a same-length wrong token is refused");
  assert.match(String(wrong.wwwAuthenticate), /^Bearer\b/);

  // The length-mismatch path: timingSafeEqual throws on it, so it must be handled, not short-circuited.
  const wrongShort = await tokenMcp("room_create", roomArgs("short token"), "x");
  assert.equal(wrongShort.status, 401);

  const ok = await tokenMcp("room_create", roomArgs("good token"), MCP_TOKEN);
  assert.equal(ok.status, 200, "the configured token must be accepted");
  assert.match(String(mcpResult(ok.text).room), /^r_/, "and the call must reach the handler, not just pass the gate");

  const ok2 = await tokenMcp("room_create", roomArgs("second token"), MCP_TOKEN_2);
  assert.equal(ok2.status, 200, "every token in the list is accepted, whatever its length");

  // The hub VALIDATES and never ISSUES (sect. 4.2, 4.3): no minting route appears alongside /auth.
  for (const route of ["/mcp/token", "/token", "/oauth/token"]) {
    const r = await fetch(`${tokenHub.base}${route}`, { method: "POST", body: "{}" });
    expectedMcp.failures++;
    assert.equal(r.status, 401, `${route} must be gated like the rest of the fall-through, never an issuance endpoint`);
  }

  // The bearer gates /mcp only. The workbench keeps its own credential, and the
  // console document keeps its own posture (sect. 4.5 keeps them on separate proxies).
  const authRes = await fetch(`${tokenHub.base}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ human_key: HK }),
  });
  assert.equal(authRes.status, 200, "POST /auth must not require the transport bearer: it is a different credential");
  assert.equal((await fetch(`${tokenHub.base}/console`)).status, 200, "the console page is still served");

  // /mcp is DELIBERATELY not lockable, and this assertion exists to stop anyone
  // restoring the lock. The limiter keys on the source address, and the reach
  // design terminates a proxy at loopback, so every request (a phone included)
  // arrives as 127.0.0.1: a per-source lock is therefore either global, which
  // takes every resident offline at once, or exempted for loopback, which is no
  // limiter at all. Learned live: a handful of probes from this machine locked
  // out 127.0.0.1 and stopped both agents. Guessing is slowed by a delay that
  // grows with recent failures, never by a refusal to serve.
  for (let i = 0; i < MAX_FAILURES + 4; i++) {
    const r = await tokenMcp("room_create", roomArgs(`guess ${i}`), "mt_" + "d".repeat(43));
    assert.equal(r.status, 401, `guess ${i} must be refused with 401, never locked out with 429`);
  }
  // The point of the whole design: a legitimate client is served immediately
  // after someone else's failures, with no waiting period.
  const good = await tokenMcp("room_create", roomArgs("after the failures"), MCP_TOKEN);
  assert.equal(good.status, 200, "a valid credential is served immediately after a run of failures");

  // And the operator can still reach the console: the keys are namespaced.
  const authAfterFailures = await fetch(`${tokenHub.base}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ human_key: HK }),
  });
  assert.equal(authAfterFailures.status, 200, "/mcp failures must not gate POST /auth");
});

test("the window row carries the /mcp counters in the same aggregated log", async () => {
  const exited = new Promise<void>((r) => tokenHub.proc.once("exit", () => r()));
  tokenHub.proc.kill("SIGTERM");
  await exited;

  const lines = fs.readFileSync(path.join(tokenHub.dataDir, "auth.log.ndjson"), "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${expectedMcp.successes + expectedMcp.failures + 1} outcomes must aggregate into one window row`);
  const row = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(row.mcp_successes, expectedMcp.successes);
  assert.equal(row.mcp_failures, expectedMcp.failures);
  assert.equal(row.mcp_lockouts, 1, "the transport-auth trip lands in its own counter");
  assert.equal(row.successes, 2, "the two POST /auth calls, counted under their own credential's counter");
  assert.equal(row.failures, 0, "a /mcp refusal must never read as a human_key refusal, nor its trip as a /auth trip");
  assert.equal(row.lockouts, 0, "and the /mcp lock is not a /auth lock");
  assert.equal(row.distinct_sources, 1, "one loopback caller is one source, whichever endpoints it hit");
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
    [
      "distinct_sources",
      "failures",
      "hash",
      "lockouts",
      "mcp_failures",
      "mcp_lockouts",
      "mcp_successes",
      "prev_hash",
      "successes",
      "window_end",
      "window_start",
    ],
    "window bounds plus aggregated counters, on the log's own chain",
  );
  assert.equal(row.successes, expected.successes);
  assert.equal(row.failures, expected.failures);
  assert.equal(row.lockouts, 1, "the trip is logged to the separate auth log");
  // This hub has no --mcp-token, and the /mcp call above went through: with the
  // check off there is no outcome to record, so the counters stay at zero.
  assert.equal(row.mcp_successes, 0, "a hub with no token configured audits no transport-auth outcome");
  assert.equal(row.mcp_failures, 0);
  assert.equal(row.mcp_lockouts, 0);
  assert.equal(row.distinct_sources, 1, "every attempt came from loopback");
  assert.ok(Date.parse(String(row.window_start)) <= Date.parse(String(row.window_end)));
  assert.match(String(row.prev_hash), /^[0-9a-f]{64}$/, "its own genesis, not a room's chain head");
  assert.match(String(row.hash), /^[0-9a-f]{64}$/);
});
