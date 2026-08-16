/**
 * Push-profile demo over a REAL stdio transport (spec 11.2b interim binding):
 * one persistent MCP connection to a spawned hub, two memberships on it.
 * The watcher registers room_watch once and never polls; events arrive as
 * notifications/room/event the instant the sender appends them.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const client = new Client({ name: "push-demo", version: "0.1.0" });
const pushed: { at: number; params: any }[] = [];
(client as any).fallbackNotificationHandler = async (n: any) => {
  if (n.method === "notifications/room/event") {
    pushed.push({ at: performance.now(), params: n.params });
    const e = n.params.event;
    const what =
      e.type === "message"
        ? `message from ${e.envelope.from.name}: "${e.envelope.body[0].text}"`
        : e.type === "presence"
          ? `presence: ${e.member.name} -> ${e.member.state}`
          : e.type;
    console.log(`${green("  PUSH >>")} seq ${e.seq} ${what}`);
  }
};

await client.connect(new StdioClientTransport({ command: "npx", args: ["-y", "tsx", "src/main.ts", "--data", "none"] }));

async function call(tool: string, args: Record<string, unknown>): Promise<any> {
  const res = (await client.callTool({ name: tool, arguments: args })) as any;
  const parsed = JSON.parse(res.content[0].text);
  if (res.isError) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  return parsed;
}

console.log(bold(cyan("── room_watch push demo (stdio, zero polling) ──")));

const created = await call("room_create", {
  topic: "push demo", name: "watcher-agent",
  card: { name: "watcher-agent", description: "Listens by push.", skills: [{ id: "watch", description: "watches" }] },
});
const sender = await call("room_join", {
  room: created.room, join_secret: created.join_secret, name: "sender-agent",
  card: { name: "sender-agent", description: "Sends things.", skills: [{ id: "send", description: "sends" }] },
});

const watch = await call("room_watch", {
  room: created.room, membership_token: created.you.membership_token, since: created.history.cursor, wait_for: "all",
});
console.log(`watch registered (cursor ${watch.cursor}, replayed ${watch.replayed}); ${bold("no room_listen will ever be called")}`);

for (let i = 1; i <= 3; i++) {
  const t0 = performance.now();
  await call("room_send", {
    room: created.room, membership_token: sender.you.membership_token, message_id: `msg_push_${i}`,
    mentions: [created.you.id], body: [{ type: "text", text: `event number ${i}` }],
  });
  // Give the notification a beat to arrive, then report latency vs the send.
  await new Promise((r) => setTimeout(r, 60));
  const last = pushed.at(-1);
  if (last) console.log(dim(`     push arrived ${(last.at - t0).toFixed(1)}ms after the send call started`));
}

await call("room_presence", { room: created.room, membership_token: sender.you.membership_token, state: "busy", detail: "demo" });
await new Promise((r) => setTimeout(r, 100));

await call("room_watch", { room: created.room, membership_token: created.you.membership_token, since: 0, enabled: false });
await call("room_end", { room: created.room, membership_token: created.you.membership_token, summary: "push demo done" });

console.log(`\n${bold(green("done"))} ${dim(`- ${pushed.length} events pushed, 0 listen calls`)}`);
await client.close();
process.exit(0);
