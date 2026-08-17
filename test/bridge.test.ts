/** v0.4.6 approval bridge: interrupt matching + the room-side approve/reject/expire wait, over the real wire. */
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { interruptMatch, joinSidekick, requestApproval } from "../src/bridge.js";
import { RoomMember } from "../src/client.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HK = "hk_bridge_test";

let hub: ChildProcess;
let hubUrl: string;
/** Session token for the workbench API: reads are operator-only since v0.5.0. */
let wbToken: string;

async function wbGet(route: string, token: string = wbToken): Promise<Response> {
  return fetch(hubUrl.replace("/mcp", route), { headers: { authorization: `Bearer ${token}` } });
}

before(async () => {
  const port = await new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
  hubUrl = `http://127.0.0.1:${port}/mcp`;
  hub = spawn("npx", ["-y", "tsx", "src/main.ts", "--http", String(port), "--data", "none", "--human-key", HK], {
    cwd: ROOT,
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      // Unauthenticated: 401 proves the listener is up AND that reads are gated.
      const r = await fetch(hubUrl.replace("/mcp", "/api/agents"));
      if (r.status === 401) break;
      if (r.ok) throw new Error("workbench reads must require a session token");
    } catch (err) {
      if ((err as Error).message.includes("must require")) throw err;
      await sleep(100);
    }
  }
  const auth = await fetch(hubUrl.replace("/mcp", "/auth"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ human_key: HK }),
  });
  wbToken = ((await auth.json()) as { session_token: string }).session_token;
});

after(() => {
  hub.kill("SIGKILL");
});

test("interruptMatch: exact, glob, false-disables, decision passthrough", () => {
  const rules = {
    "mcp__linear__save_document": { allowed_decisions: ["approve", "edit", "reject"] as ("approve" | "edit" | "reject")[] },
    "mcp__github__*": true,
    "mcp__github__read_file": false,
  };
  assert.deepEqual(interruptMatch(rules as never, "mcp__linear__save_document")?.allowed_decisions, ["approve", "edit", "reject"]);
  assert.deepEqual(interruptMatch(rules as never, "mcp__github__create_pr"), {});
  assert.equal(interruptMatch(rules as never, "mcp__github__read_file"), null, "explicit false wins over the glob when listed first-match");
  assert.equal(interruptMatch(rules as never, "Read"), null);
  assert.equal(interruptMatch(undefined, "anything"), null);
});

test("requestApproval: human approve (with edit) resolves the waiting bridge; reject and expiry deny", async () => {
  const agent = await RoomMember.create({
    hubUrl, name: "worker", topic: "bridge test",
    card: { name: "worker", description: "does work", skills: [{ id: "work", description: "works" }] },
  });
  const sidekick = await joinSidekick(hubUrl, agent.room, agent.joinSecret, "worker");
  const human = await RoomMember.create({
    hubUrl, room: agent.room, joinSecret: agent.joinSecret ?? undefined, name: "boss",
    card: { name: "boss", description: "human supervisor" }, role: "supervisor", humanKey: HK,
  });

  // Approve with edited params: the bridge gets the substitution.
  const p1 = requestApproval(agent, sidekick, { toolName: "mcp__linear__save_document", input: { title: "v1" }, timeoutMs: 30_000 });
  await sleep(600);
  const pending = await wbGet("/api/approvals").then((r) => r.json());
  assert.equal(pending.length, 1);
  await human.admin("approve", { target: pending[0].request_id, params: { title: "v2 (edited by boss)" } });
  const out1 = await p1;
  assert.equal(out1.approved, true);
  assert.deepEqual(out1.params, { title: "v2 (edited by boss)" });

  // Reject denies.
  const p2 = requestApproval(agent, sidekick, { toolName: "mcp__linear__save_document", input: { title: "x" }, timeoutMs: 30_000 });
  await sleep(600);
  const pending2 = (await wbGet("/api/approvals").then((r) => r.json())) as { request_id: string }[];
  await human.admin("reject", { target: pending2[0].request_id });
  const out2 = await p2;
  assert.equal(out2.approved, false);
  assert.match(out2.reason, /rejected/);

  // Nobody answers: the short expiry denies via the sweep (hub sweeps every 2s by default).
  const p3 = requestApproval(agent, sidekick, { toolName: "mcp__linear__save_document", input: {}, timeoutMs: 4_000 });
  const out3 = await p3;
  assert.equal(out3.approved, false);
  assert.match(out3.reason, /expired|timed out/);

  await human.leave();
  await sidekick.leave();
  await agent.leave();
});

test("v0.5.0 exposure: every workbench read is operator-only, and a bad token is refused", async () => {
  // The routes that leaked before this release: the Goodvest system prompt,
  // run payloads, and pending approval cards (whole draft documents).
  for (const route of ["/api/agents", "/api/agents/pm-agent/definition", "/api/runs", "/api/summary", "/api/approvals"]) {
    const anon = await fetch(hubUrl.replace("/mcp", route));
    assert.equal(anon.status, 401, `${route} must refuse an anonymous read`);
    const bogus = await wbGet(route, "st_not_a_real_token");
    assert.equal(bogus.status, 401, `${route} must refuse an unknown token`);
    const ok = await wbGet(route);
    assert.ok(ok.status < 400, `${route} must serve the operator (got ${ok.status})`);
  }
});

test("v0.5.0 exposure: a browser origin off this host is refused; non-browser clients are unaffected", async () => {
  const evil = await fetch(hubUrl.replace("/mcp", "/api/agents"), {
    headers: { authorization: `Bearer ${wbToken}`, origin: "http://attacker.example" },
  });
  assert.equal(evil.status, 403, "DNS-rebinding defense: a foreign Origin is refused even WITH a valid token");
  const localOrigin = await fetch(hubUrl.replace("/mcp", "/api/agents"), {
    headers: { authorization: `Bearer ${wbToken}`, origin: "http://localhost:8790" },
  });
  assert.ok(localOrigin.status < 400, "the console's own origin still works");
  const noOrigin = await wbGet("/api/agents");
  assert.ok(noOrigin.status < 400, "a CLI/agent client sends no Origin and must not be blocked");
});
