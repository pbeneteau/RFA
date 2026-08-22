/**
 * RFA 0.1 demo: the spec section 17 worked example, live.
 * Two MCP clients (dev-agent, pm-agent) talk through one RoomHub, in process.
 * Was scripts/demo.ts; now `rfa demo`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHubServer } from "../hub.js";
import { RoomHub } from "../store.js";
import type { Ui } from "./ui.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runDemo(ui: Ui): Promise<void> {
  const dim = (s: string) => ui.dim(s);
  const bold = (s: string) => ui.bold(s);
  const green = (s: string) => ui.good(s);
  const amber = (s: string) => ui.caution(s);
  const cyan = (s: string) => ui.accent(s);
  const out = (s = "") => process.stdout.write(s + "\n");

  let n = 0;
  const mid = () => `msg_demo_${String(++n).padStart(4, "0")}`;
  const step = (title: string) => out(`\n${bold(cyan(`── ${title}`))}`);
  const show = (who: string, what: string) => out(`${bold(who.padEnd(10))} ${what}`);

  async function agent(hub: RoomHub, name: string): Promise<Client> {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createHubServer(hub);
    const client = new Client({ name, version: "0.1.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  async function call(client: Client, tool: string, args: Record<string, unknown>): Promise<any> {
    const res = (await client.callTool({ name: tool, arguments: args })) as any;
    const parsed = JSON.parse(res.content[0].text);
    if (res.isError) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    return parsed;
  }

  const hub = new RoomHub({ dataDir: null });
  try {
    const pm = await agent(hub, "pm-host");
    const dev = await agent(hub, "dev-host");

    step("1 · pm-agent creates the room");
    const created = await call(pm, "room_create", {
      topic: "checkout-flow feature work",
      name: "pm-agent",
      card: {
        name: "pm-agent",
        description: "Product manager for the checkout squad. Answers spec and priority questions.",
        version: "1.4.0",
        skills: [{ id: "answer-spec-question", description: "Authoritative answers on checkout requirements, with sources." }],
      },
    });
    const room = created.room;
    const pmTok = created.you.membership_token;
    show("pm-agent", `created ${bold(room)} (epoch ${created.epoch}), join_secret ${dim(created.join_secret)}`);

    step("2 · dev-agent joins and discovers the roster");
    const joined = await call(dev, "room_join", {
      room,
      join_secret: created.join_secret,
      name: "dev-agent",
      card: { name: "dev-agent", description: "Implements checkout features.", version: "0.9.0", skills: [{ id: "implement-feature", description: "Implements and tests checkout features." }] },
    });
    const devTok = joined.you.membership_token;
    const pmEntry = joined.roster.find((r: any) => r.name === "pm-agent");
    show("dev-agent", `joined as ${bold(joined.you.name)} (${joined.you.id}), epoch ${joined.epoch}`);
    for (const m of joined.roster) {
      show("", `${ui.presence(m.state)} ${m.name.padEnd(12)} ${m.state.padEnd(6)} ${dim(m.digest.slice(0, 24) + "…")} skills: ${m.card_summary.skill_ids.join(", ")}`);
    }

    step("3 · capability discovery: fetch pm-agent's card once, by digest");
    const card = await call(dev, "agent_describe", { room, membership_token: devTok, digest: pmEntry.digest });
    show("dev-agent", `cached card for digest ${dim(pmEntry.digest.slice(0, 24) + "…")} (cache ${card.cache_scope}, ttl ${card.ttl_ms}ms)`);
    show("", dim(`projected tool: ask_pm-agent__answer-spec-question`));

    step("4 · pm-agent parks a mentions listen (this is the presence loop)");
    const pmListen = call(pm, "room_listen", { room, membership_token: pmTok, since: joined.history.cursor, timeout_ms: 10_000 });
    await sleep(60);

    step("5 · dev-agent asks (kind=request, reply_by 5m)");
    const askId = mid();
    const sent = await call(dev, "room_send", {
      room, membership_token: devTok, message_id: askId, kind: "request",
      mentions: [pmEntry.id],
      reply_by: new Date(Date.now() + 300_000).toISOString(),
      body: [{ type: "text", text: "For guest checkout: is the billing address mandatory when the cart only has digital goods?" }],
    });
    show("dev-agent", `sent seq ${sent.seq}, conversation ${bold(sent.conversation_id)}`);
    show("hub", `delivery to pm-agent: ${green(sent.recipients[0].delivery)} (presence: ${sent.recipients[0].presence})`);
    const pmInbox = await pmListen;
    show("pm-agent", `woke with: "${(pmInbox.events[0].envelope.body[0] as any).text.slice(0, 60)}…" ${dim(`(origin: ${pmInbox.events[0].envelope.from.origin})`)}`);

    step("6 · pm-agent is actually mid-release: machine-readable busy refusal");
    const devWait = call(dev, "room_listen", { room, membership_token: devTok, since: sent.seq, timeout_ms: 10_000 });
    await sleep(60);
    await call(pm, "room_send", {
      room, membership_token: pmTok, message_id: mid(), kind: "refuse",
      in_reply_to: askId, conversation_id: sent.conversation_id,
      refusal: { reason: "busy", detail: "release review, ~2s", retry_after_s: 2 },
      presence: "busy",
      body: [{ type: "text", text: "In release review, ping me again in a moment." }],
    });
    const refusal = (await devWait).events.find((e: any) => e.type === "message");
    show("pm-agent", `${amber("refused: busy")} ("${refusal.envelope.refusal.detail}", retry_after ${refusal.envelope.refusal.retry_after_s}s)`);

    step("7 · dev-agent watches presence; pm-agent flips back to ready");
    const devWatch = call(dev, "room_listen", { room, membership_token: devTok, since: refusal.seq, timeout_ms: 10_000, wait_for: "all" });
    await sleep(1000);
    await call(pm, "room_presence", { room, membership_token: pmTok, state: "ready" });
    const watch = await devWatch;
    const pres = watch.events.find((e: any) => e.type === "presence");
    show("hub", `presence event: pm-agent is ${green(pres.member.state)} again (epoch ${pres.member.epoch})`);

    step("8 · retry, then the answer arrives as a 3-chunk stream");
    const ask2 = mid();
    const pmListen2 = call(pm, "room_listen", { room, membership_token: pmTok, since: watch.cursor, timeout_ms: 10_000 });
    await sleep(60);
    const sent2 = await call(dev, "room_send", {
      room, membership_token: devTok, message_id: ask2, kind: "request",
      conversation_id: sent.conversation_id, mentions: [pmEntry.id],
      body: [{ type: "text", text: "Re-asking: billing address for digital-only carts?" }],
    });
    await pmListen2;
    const parts = [
      [{ type: "text", text: "Checked the spec…" }],
      [{ type: "text", text: "Also confirmed with the payments PRD…" }],
      [
        { type: "text", text: "No: billing address is optional for digital-only carts. Postal code only where tax rules require it." },
        { type: "json", value: { mandatory: false, source: "checkout spec §4.2", tax_exception: "EU VAT postal code" } },
      ],
    ];
    for (let i = 0; i < 3; i++) {
      await call(pm, "room_send", {
        room, membership_token: pmTok, message_id: mid(), kind: "response",
        in_reply_to: ask2, conversation_id: sent.conversation_id, to: [joined.you.id],
        chunk: { index: i, final: i === 2 }, body: parts[i],
      });
    }
    const answer = await call(dev, "room_listen", { room, membership_token: devTok, since: sent2.seq, timeout_ms: 0 });
    for (const e of answer.events.filter((e: any) => e.type === "message")) {
      const tag = e.envelope.chunk.final ? green(`chunk ${e.envelope.chunk.index} FINAL`) : dim(`chunk ${e.envelope.chunk.index}`);
      show("pm-agent", `${tag} "${(e.envelope.body[0] as any).text}"`);
    }
    const finalChunk = answer.events.at(-1).envelope;
    show("dev-agent", `got structured payload: ${JSON.stringify(finalChunk.body[1].value)}`);

    step("9 · pm-agent ends the room");
    await call(pm, "room_end", { room, membership_token: pmTok, summary: "Question answered; spec 4.2 confirmed." });
    const closing = await call(dev, "room_listen", { room, membership_token: devTok, since: answer.cursor, timeout_ms: 0, wait_for: "all" });
    show("hub", `${dim(JSON.stringify(closing.events.at(-1)))}`);

    out(`\n${bold(green("done"))} ${dim(`— full event log had ${closing.cursor} events; \`rfa room tail <alias> --follow\` shows a real room's log`)}\n`);
  } finally {
    hub.close();
  }
}
