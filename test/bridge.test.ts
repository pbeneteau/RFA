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
      const r = await fetch(hubUrl.replace("/mcp", "/api/agents"));
      if (r.ok) break;
    } catch {
      await sleep(100);
    }
  }
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
  const pending = await fetch(hubUrl.replace("/mcp", "/api/approvals")).then((r) => r.json());
  assert.equal(pending.length, 1);
  await human.admin("approve", { target: pending[0].request_id, params: { title: "v2 (edited by boss)" } });
  const out1 = await p1;
  assert.equal(out1.approved, true);
  assert.deepEqual(out1.params, { title: "v2 (edited by boss)" });

  // Reject denies.
  const p2 = requestApproval(agent, sidekick, { toolName: "mcp__linear__save_document", input: { title: "x" }, timeoutMs: 30_000 });
  await sleep(600);
  const pending2 = (await fetch(hubUrl.replace("/mcp", "/api/approvals")).then((r) => r.json())) as { request_id: string }[];
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
