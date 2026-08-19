/**
 * v0.5.1 notification-only push (spec 17.2, 17.4): a nag and a link, never a
 * credential and never an action button. A verdict arriving over a broadcast
 * transport carrying a bearer is a forgeable approval, so this test asserts the
 * absence of the things that would make it one.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as http from "node:http";
import { RoomHub } from "../src/store.js";
import type { AgentCard } from "../src/model.js";
import { freePort, startHub, stopHub } from "./hubproc.js";

const HK = "hk_push_test";
const card = (name: string): AgentCard => ({
  name,
  description: `${name} does things.`,
  skills: [{ id: `${name}-skill`, description: `${name}'s skill.` }],
});
test("an approval card pushes a title and a link, and nothing that could decide it", async () => {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const sink = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const sinkPort = await freePort();
  await new Promise<void>((r) => sink.listen(sinkPort, "127.0.0.1", () => r()));
  const hub = await startHub([
    "--human-key", HK,
    "--push-url", `http://127.0.0.1:${sinkPort}/topic`,
    "--console-url", "https://example.ts.net",
  ]);
  const hubPort = hub.port;
  try {
    // A room with a pending approval card, over the real wire.
    const localHub = new RoomHub({ dataDir: null, sweepIntervalMs: 0 });
    void localHub; // the spawned hub owns the room; this is only for types
    const mcp = `http://127.0.0.1:${hubPort}/mcp`;
    const call = async (tool: string, args: Record<string, unknown>) => {
      const res = await fetch(mcp, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "Mcp-Method": "tools/call", "Mcp-Name": tool },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      const text = await res.text();
      const payload = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join(""))
        : JSON.parse(text);
      return JSON.parse(payload.result.content[0].text);
    };
    const room = await call("room_create", { topic: "push", name: "asker", card: card("asker") });
    await call("room_send", {
      room: room.room,
      membership_token: room.you.membership_token,
      message_id: "msg_needs_approval",
      kind: "request",
      body: [{ type: "text", text: "may I write to the world?" }],
      ext: { "io.github.pbeneteau/approval": { request_id: "apr_push_1", action: "save a document", tool_name: "mcp__linear__save_document", input_preview: "title: TEST", allowed_decisions: ["approve", "reject"] } },
    });
    // The watcher polls every 5s.
    for (let i = 0; i < 40 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
    assert.ok(received.length > 0, "the card produced a notification");

    const { headers, body } = received[0];
    assert.match(String(headers.title), /approval needed/i, "the title says what is wanted");
    assert.match(String(headers.click), /^https:\/\/example\.ts\.net\/console#/, "and it links to the console");
    // The point of the test: nothing here can decide anything.
    assert.equal(headers.authorization, undefined, "no credential rides the notification");
    const blob = JSON.stringify({ headers, body }).toLowerCase();
    for (const forbidden of ["bearer", "session_token", "membership_token", HK.toLowerCase(), "/api/approvals/decide"]) {
      assert.ok(!blob.includes(forbidden), `a notification must not carry ${forbidden}`);
    }
    for (const actionHeader of ["actions", "action"]) {
      assert.equal(headers[actionHeader], undefined, `no ${actionHeader} header: a broadcast button is a forgeable approval`);
    }
    assert.match(body, /console/i, "the body tells the operator where the decision happens");
  } finally {
    await stopHub(hub);
    sink.close();
  }
});
