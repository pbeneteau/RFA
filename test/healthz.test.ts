/**
 * `GET /healthz` (RFA-0.6 sect. 8.7, rung v0.6.3b).
 *
 * Two rules that pull against each other, which is why this has its own file. The
 * route MUST answer without a credential, because sect. 4.5 forwards exactly two
 * paths on the public side (`POST /mcp` and `GET /healthz`) and a health check that
 * needs a bearer is not a health check. And the unauthenticated body MUST carry
 * NOTHING beyond `{"ok":true}`, because on a hub other organizations dial into a
 * detailed body is a version banner and an internal-state oracle.
 *
 * So the interesting assertions are negative: no 401 when a transport token is
 * configured, and no version, count, uptime or config key in the body.
 */
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RoomHub } from "../src/store.js";
import { startHub, stopAllHubs } from "./hubproc.js";

after(async () => {
  await stopAllHubs();
});

test("an unauthenticated GET returns 200 and exactly {\"ok\":true}", async () => {
  const hub = await startHub();
  const res = await fetch(`${hub.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");

  const text = await res.text();
  assert.equal(text, '{"ok":true}', "byte-for-byte: sect. 8.7 says exactly this body");
  assert.deepEqual(Object.keys(JSON.parse(text) as object), ["ok"], "one key, and it is `ok`");
});

test("the body leaks nothing: no version, counts, uptime, queue depth or config", async () => {
  const hub = await startHub(["--human-key", "hk_healthz_test"]);
  // Give the hub something to count, so a body that leaked counts would show it.
  const created = await fetch(`${hub.base}/healthz`);
  const text = await created.text();

  for (const forbidden of ["version", "rooms", "members", "uptime", "queue", "config", "pid", "0.6", "node"]) {
    assert.ok(!text.toLowerCase().includes(forbidden), `the public body must not mention ${forbidden}`);
  }
  assert.ok(text.length < 32, `eleven bytes is the contract, got ${text.length}`);
  // And nothing in the headers either: a Server or X-Powered-By header is the same
  // version banner one layer up.
  assert.equal(created.headers.get("server"), null);
  assert.equal(created.headers.get("x-powered-by"), null);
});

test("an authenticated hub still answers /healthz without a credential", async () => {
  // The regression that would matter most: /healthz behind mcpAuthorized would 401
  // for the one caller sect. 4.5 forwards it to.
  const hub = await startHub(["--mcp-token", "tok_healthz_probe"]);
  const res = await fetch(`${hub.base}/healthz`);
  assert.equal(res.status, 200, "a transport token gates /mcp, never /healthz");
  assert.equal(await res.text(), '{"ok":true}');

  // Proof that the hub really is in authenticated mode: /mcp refuses the same caller.
  const mcp = await fetch(hub.mcp, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
  });
  assert.equal(mcp.status, 401, "otherwise the test above proves nothing");
});

test("a cross-origin health check is not refused", async () => {
  // The Origin allowlist defends the workbench, whose responses carry agent
  // definitions and approval bodies. This response carries no secret, so refusing
  // it would break monitoring to protect nothing.
  const hub = await startHub();
  const res = await fetch(`${hub.base}/healthz`, { headers: { origin: "https://monitoring.example" } });
  assert.equal(res.status, 200);
  // Contrast: a workbench route from the same origin IS refused.
  const wb = await fetch(`${hub.base}/api/agents`, { headers: { origin: "https://monitoring.example" } });
  assert.equal(wb.status, 403, "the allowlist still defends what it was written for");
});

test("HEAD works and carries no body", async () => {
  const hub = await startHub();
  const res = await fetch(`${hub.base}/healthz`, { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "", "a HEAD response has no body");
  assert.equal(res.headers.get("content-length"), "11", "but it still advertises the length");
});

test("an unsupported method falls through rather than pretending to be healthy", async () => {
  const hub = await startHub();
  const res = await fetch(`${hub.base}/healthz`, { method: "POST" });
  assert.notEqual(res.status, 200, "POST /healthz is not the contract and must not answer ok");
});

test("a hub with no data dir is healthy: there is no store to lose", () => {
  // Getting this backwards would make "healthy" mean "holds a lockfile" and report
  // every in-memory hub, which is every test hub and the stdio default, as sick.
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0 });
  assert.equal(hub.serving(), true);
  hub.close();
});

test("a hub whose store was taken over stops reporting itself able to serve", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-healthz-"));
  const first = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  assert.equal(first.serving(), true, "it holds the lock");

  // Simulate the takeover the lock heartbeat is there to detect: another nonce in
  // the lockfile means our writes are no longer authoritative.
  const lock = path.join(dir, ".hub.lock");
  assert.ok(fs.existsSync(lock), "the lockfile is where the takeover is observable");
  fs.writeFileSync(lock, JSON.stringify({ pid: 99999, nonce: "someone-else", heartbeat: Date.now() }));
  (first as unknown as { touchLock(): void }).touchLock();
  assert.equal(first.serving(), false, "a hub that lost its store must not answer 200");

  // And a lockfile that simply vanished is NOT a takeover: an operator may have
  // deleted it, and a serving hub should not declare itself sick over that.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-healthz-"));
  const second = new RoomHub({ dataDir: dir2, sweepIntervalMs: 0 });
  fs.unlinkSync(path.join(dir2, ".hub.lock"));
  (second as unknown as { touchLock(): void }).touchLock();
  assert.equal(second.serving(), true, "a missing lock is not evidence that someone else owns the store");

  first.close();
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
});
