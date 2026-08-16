/** Observability (spec 13): one OTel span per tool call with rfa.* attributes. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHubServer } from "../src/hub.js";
import { RoomHub } from "../src/store.js";

// Global provider: registered once for this test process (node --test runs files isolated).
const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

async function connectAgent(hub: RoomHub): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createHubServer(hub);
  const client = new Client({ name: "otel-test", version: "0.0.1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as any;
  return JSON.parse(res.content[0].text);
}

test("spans: per-call rfa.{tool} names, room/member/seq attributes, error codes, trace propagation", async () => {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0 });
  const c = await connectAgent(hub);
  const created = await call(c, "room_create", {
    topic: "otel",
    name: "tracer",
    card: { name: "tracer", description: "traces", skills: [{ id: "trace", description: "traces things" }] },
  });
  const sent = await call(c, "room_send", {
    room: created.room,
    membership_token: created.you.membership_token,
    message_id: "otel_msg_1",
    body: [{ type: "text", text: "hello" }],
    _meta: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
  });
  await call(c, "room_send", {
    room: created.room,
    membership_token: "mt_bogus_token_123456789",
    message_id: "otel_msg_2",
    body: [{ type: "text", text: "nope" }],
  });

  const spans = exporter.getFinishedSpans();
  const names = spans.map((s) => s.name);
  assert.ok(names.includes("rfa.room_create"), `missing create span: ${names}`);
  assert.ok(names.includes("rfa.room_send"), `missing send span: ${names}`);

  const create = spans.find((s) => s.name === "rfa.room_create")!;
  assert.equal(create.attributes["mcp.tool.name"], "room_create");
  assert.equal(create.attributes["mcp.method.name"], "tools/call");

  const ok = spans.find((s) => s.name === "rfa.room_send" && s.attributes["rfa.seq"] !== undefined)!;
  assert.equal(ok.attributes["rfa.room"], created.room);
  assert.equal(ok.attributes["rfa.member"], created.you.id);
  assert.equal(ok.attributes["rfa.seq"], sent.seq);
  // SEP-414 propagation: the hub span joined the caller's trace.
  assert.equal(ok.spanContext().traceId, "11111111111111111111111111111111");
  assert.equal(ok.parentSpanContext?.spanId, "2222222222222222");

  const failed = spans.find((s) => s.name === "rfa.room_send" && s.attributes["rfa.error_code"] !== undefined)!;
  assert.equal(failed.attributes["rfa.error_code"], "not_a_member");
  assert.equal(failed.status.code, 2, "span status ERROR");
  assert.equal(failed.attributes["rfa.member"], undefined, "bogus token attributes nothing");

  hub.close();
});
