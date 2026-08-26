/**
 * Wire section 8's 0.1.9 additions (transplanted from RFA-0.8 sects. 2.2 and
 * 2.3, built as rung 2): chain ids, the `would_deadlock` refusal, the depth cap,
 * the hub-defaulted cross-home `reply_by`, and the advisory counter-ask
 * annotation.
 *
 * The problem, measured: A asks B and B asks A back, and the cycle deadlocks by
 * SILENCE. A serve loop is doubly serial, so B's request to A is not merely
 * queued behind A's turn, it is UNREAD until `reply_by`: 120 seconds of dead air
 * ending in a timeout that names nothing. The live test at the bottom of this
 * file is the proof that the dead air is gone.
 *
 * Nothing here is admission control, and one test asserts that on purpose: chain
 * ids are advisory refusal hints, a hub MUST NOT refuse admission or delivery on
 * chain-id grounds, and a counterparty that propagates nothing simply falls back
 * to the clock.
 *
 * (`test/chain.test.ts` is the log HASH chain. Different chain, different file.)
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { BlockedChains, CHAIN_DEPTH_CAP, CHAIN_EXT, COUNTER_ASK_EXT, mintChainId, nextChain, readChain } from "../src/chainid.js";
import { rawCall, RoomMember, ServeRefusal, type ServeContext } from "../src/client.js";
import { RoomHub } from "../src/store.js";
import type { AgentCard, Envelope, RfaEvent } from "../src/model.js";
import { freePort, startHub, stopHub, type TestHub } from "./hubproc.js";

const card = (name: string): AgentCard => ({
  name,
  description: `${name} for the cycle test`,
  skills: [{ id: "answer", description: "answers questions" }],
});

// ---------------------------------------------------------------- the ext itself

test("chain: the root mints, every hop increments, and the cap stops PROPAGATION rather than the request", () => {
  // The root request is the one made while serving nothing, and it carries no
  // ext: the first HOP is what is tagged.
  const first = nextChain(null);
  assert.ok(first && first.depth === 1, "an ask made while serving nothing mints a chain at depth 1");
  const second = nextChain(first);
  assert.equal(second!.id, first!.id, "the id is propagated UNCHANGED; only the depth moves");
  assert.equal(second!.depth, 2);

  let hop = first!;
  for (let i = 1; i < CHAIN_DEPTH_CAP; i++) hop = nextChain(hop)!;
  assert.equal(hop.depth, CHAIN_DEPTH_CAP);
  assert.equal(
    nextChain(hop),
    null,
    "at the cap the ext stops propagating; the request still goes, because a long chain is not proof of a cycle and refusing it would make an advisory hint into admission control",
  );
});

test("chain: a peer-supplied ext is validated, not trusted", () => {
  const id = mintChainId();
  assert.deepEqual(readChain({ [CHAIN_EXT]: { id, depth: 3 } }), { id, depth: 3 });
  assert.equal(readChain({}), null);
  assert.equal(readChain(null), null);
  for (const bad of [{ id, depth: "lots" }, { id, depth: 0 }, { id, depth: -1 }, { id: "", depth: 1 }, { id: "x".repeat(65), depth: 1 }, { depth: 1 }, [id, 1], "chain"]) {
    assert.equal(readChain({ [CHAIN_EXT]: bad }), null, `refused: ${JSON.stringify(bad)}`);
  }
  // A garbage depth that read as a chain would propagate onward as garbage, and
  // an over-long id ends up in a log line and a refusal detail.
});

test("chain: the blocked set counts, so a fan-out's second ask does not unblock the first", () => {
  const chains = new BlockedChains();
  const id = mintChainId();
  const leaveA = chains.enter(id);
  const leaveB = chains.enter(id);
  assert.equal(chains.has(id), true);
  leaveA();
  assert.equal(chains.has(id), true, "one ask returning does not mean the member is free of the chain");
  leaveA();
  assert.equal(chains.has(id), true, "and leaving twice is not a second decrement");
  leaveB();
  assert.equal(chains.has(id), false);
  assert.equal(chains.has(null), false);
});

// ---------------------------------------------------------------- the hub's part

function hubWith(cfg: Partial<ConstructorParameters<typeof RoomHub>[0]> = {}) {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, ...cfg });
  const created = hub.createRoom({ topic: "cycles", name: "operator", card: card("operator") });
  return { hub, room: created.room, secret: created.join_secret!, operator: created.contract.you };
}

/**
 * Every message envelope on the log, which is the only place a hub-stamped field
 * is observable. `wait_for: "all"` because the default is `mentions` and a
 * sender is not in its own mentions, so the default would return nothing here.
 */
async function envelopes(hub: RoomHub, room: string, token: string): Promise<Envelope[]> {
  const res = (await hub.listen({ room, membership_token: token, since: 0, timeout_ms: 0, wait_for: "all" })) as { events: RfaEvent[] };
  return res.events.filter((e): e is RfaEvent & { type: "message"; envelope: Envelope } => e.type === "message").map((e) => e.envelope);
}

const findMsg = async (hub: RoomHub, room: string, token: string, id: string): Promise<Envelope | undefined> =>
  (await envelopes(hub, room, token)).find((e) => e.message_id === id);

test("hub: a cross-home request with no reply_by gets a bounded default; a local one does not", async () => {
  const { hub, room, secret, operator } = hubWith();
  try {
    const guest = hub.join({ room, join_secret: secret, name: "guest", card: card("guest") });
    const local = hub.join({ room, join_secret: secret, name: "local-agent", card: card("local-agent") });
    // Force the hub-derived home, the way an admission record will (RFA-0.6 sect. 3).
    const internals = hub as unknown as { rooms: Map<string, { members: Map<string, { id: string; home: string }> }> };
    internals.rooms.get(room)!.members.get(guest.you.id)!.home = "orgb.example";

    await hub.send({
      room,
      membership_token: operator.membership_token,
      message_id: "msg_crosshome1",
      kind: "request",
      mentions: [guest.you.id],
      body: [{ type: "text", text: "how long do you need?" }],
    });
    const stamped = await findMsg(hub, room, operator.membership_token, "msg_crosshome1");
    assert.ok(stamped?.reply_by, "a request crossing a home boundary is never left with no clock");
    const seconds = Math.round((Date.parse(stamped!.reply_by!) - Date.now()) / 1000);
    assert.ok(seconds > 500 && seconds <= 600, `bounded at the configured default, got ${seconds}s`);

    await hub.send({
      room,
      membership_token: operator.membership_token,
      message_id: "msg_localonly1",
      kind: "request",
      mentions: [local.you.id],
      body: [{ type: "text", text: "and you?" }],
    });
    assert.equal(
      (await findMsg(hub, room, operator.membership_token, "msg_localonly1"))?.reply_by,
      null,
      "a local-to-local request is untouched: the default costs nothing until there is a boundary to cross",
    );
  } finally {
    hub.close();
  }
});

test("hub: a sender's own reply_by always wins, and 0 disables the default entirely", async () => {
  const off = hubWith({ crossHomeReplyByDefaultS: 0 });
  try {
    const guest = off.hub.join({ room: off.room, join_secret: off.secret, name: "guest", card: card("guest") });
    (off.hub as unknown as { rooms: Map<string, { members: Map<string, { home: string }> }> }).rooms
      .get(off.room)!
      .members.get(guest.you.id)!.home = "orgb.example";
    await off.hub.send({
      room: off.room,
      membership_token: off.operator.membership_token,
      message_id: "msg_disabled01",
      kind: "request",
      mentions: [guest.you.id],
      body: [{ type: "text", text: "no clock please" }],
    });
    assert.equal(
      (await findMsg(off.hub, off.room, off.operator.membership_token, "msg_disabled01"))?.reply_by,
      null,
      "0 disables it, as the knob documents",
    );
  } finally {
    off.hub.close();
  }

  const own = hubWith();
  try {
    const guest = own.hub.join({ room: own.room, join_secret: own.secret, name: "guest", card: card("guest") });
    (own.hub as unknown as { rooms: Map<string, { members: Map<string, { home: string }> }> }).rooms
      .get(own.room)!
      .members.get(guest.you.id)!.home = "orgb.example";
    await own.hub.send({
      room: own.room,
      membership_token: own.operator.membership_token,
      message_id: "msg_ownclock01",
      kind: "request",
      mentions: [guest.you.id],
      reply_by: new Date(Date.now() + 45_000).toISOString(),
      body: [{ type: "text", text: "45 seconds is all I have" }],
    });
    const stamped = (await findMsg(own.hub, own.room, own.operator.membership_token, "msg_ownclock01"))!;
    const seconds = Math.round((Date.parse(stamped.reply_by!) - Date.now()) / 1000);
    assert.ok(seconds <= 45, `the sender's own deadline is not overwritten, got ${seconds}s`);
  } finally {
    own.hub.close();
  }
});

test("hub: the 2-cycle is ANNOTATED, never refused, because a counter-ask is the legitimate idiom", async () => {
  const { hub, room, secret, operator } = hubWith();
  try {
    const other = hub.join({ room, join_secret: secret, name: "other", card: card("other") });
    // A asks R, with a clock so the hub tracks it as pending.
    await hub.send({
      room,
      membership_token: other.you.membership_token,
      message_id: "msg_counter001",
      kind: "request",
      mentions: [operator.id],
      reply_by: new Date(Date.now() + 60_000).toISOString(),
      body: [{ type: "text", text: "which envelope?" }],
    });
    // R asks A back before answering: the clarifying question.
    const back = await hub.send({
      room,
      membership_token: operator.membership_token,
      message_id: "msg_counter002",
      kind: "request",
      mentions: [other.you.id],
      body: [{ type: "text", text: "for which client?" }],
    });
    assert.ok(
      back.recipients.every((r) => r.delivery === "live" || r.delivery === "queued"),
      "the counter-ask is DELIVERED; annotating it is the whole of the hub's response",
    );
    const env = (await findMsg(hub, room, operator.membership_token, "msg_counter002"))!;
    assert.equal(env.ext?.[COUNTER_ASK_EXT], "msg_counter001", "and it names the pending request it counters");
    assert.equal(env.refusal, null);
    // The first request is not annotated: nothing was pending when it was sent.
    assert.equal((await findMsg(hub, room, operator.membership_token, "msg_counter001"))!.ext?.[COUNTER_ASK_EXT], undefined);
  } finally {
    hub.close();
  }
});

test("hub: a chain ext is carried untouched and is never an admission input", async () => {
  const { hub, room, secret, operator } = hubWith();
  try {
    const other = hub.join({ room, join_secret: secret, name: "other", card: card("other") });
    const chain = { id: mintChainId(), depth: 4 };
    // Deliberately absurd from the hub's point of view: the same chain id twice,
    // in both directions, which is a cycle. A hub that reasoned about chains
    // would refuse one of them. It must not.
    for (const [i, tok] of [operator.membership_token, other.you.membership_token].entries()) {
      const res = await hub.send({
        room,
        membership_token: tok,
        message_id: `msg_chainpass${i}`,
        kind: "request",
        mentions: [i === 0 ? other.you.id : operator.id],
        ext: { [CHAIN_EXT]: chain },
        body: [{ type: "text", text: `round and round ${i}` }],
      });
      assert.ok(res.seq > 0, "the hub MUST NOT refuse admission or delivery on chain-id grounds");
    }
    assert.deepEqual(
      (await findMsg(hub, room, operator.membership_token, "msg_chainpass0"))?.ext?.[CHAIN_EXT],
      chain,
      "carried through unchanged: the hub does not read it, edit it or act on it",
    );
  } finally {
    hub.close();
  }
});

// ---------------------------------------------------------------- the cycle, live

let hub: TestHub;

before(async () => {
  hub = await startHub();
});

after(async () => {
  if (hub) await stopHub(hub);
});

test("live: a two-agent cycle is refused immediately with would_deadlock instead of 120 seconds of dead air", async () => {
  // The shape is the resident's, exactly: alpha SERVES a request and makes a
  // nested ask from inside its handler, so its serve loop is blocked and cannot
  // read anything. beta then asks alpha back on the same chain. The refusal can
  // only come from alpha's ask-wait loop, which runs on its own cursor and is
  // the one thing still reading.
  const asker = await RoomMember.create({ hubUrl: hub.mcp, topic: "cycles", name: "asker", card: card("asker") });
  const alpha = await RoomMember.create({ hubUrl: hub.mcp, room: asker.room, joinSecret: asker.joinSecret ?? undefined, name: "alpha", card: card("alpha") });
  const beta = await RoomMember.create({ hubUrl: hub.mcp, room: asker.room, joinSecret: asker.joinSecret ?? undefined, name: "beta", card: card("beta") });
  const stop = new AbortController();
  /** What beta's ask back to alpha came back as: the assertion of record. */
  let counterResult: { kind: string; reason?: string; detail?: string } | null = null;
  /** Every request alpha's SERVE loop handled, to prove the refused one is not answered twice. */
  const alphaServed: string[] = [];

  const alphaServe = alpha.serve(
    async (ctx: ServeContext) => {
      alphaServed.push(ctx.envelope.message_id);
      // The nested ask, chained off whatever arrived (nothing, here: the asker is
      // a root), exactly as `mcp__rfa__ask` does it.
      const chain = nextChain(readChain(ctx.envelope.ext));
      const res = await alpha.ask(beta.memberId, "what do you know about this?", { timeoutMs: 30_000, chain });
      return `alpha heard: ${res.kind}`;
    },
    { signal: stop.signal, onError: () => {} },
  );

  const betaServe = beta.serve(
    async (ctx: ServeContext) => {
      // beta answers alpha's question with a question, on the SAME chain. This is
      // the edge that closes the cycle.
      const chain = nextChain(readChain(ctx.envelope.ext));
      try {
        const back = await beta.ask(alpha.memberId, "before I answer: which client?", { timeoutMs: 20_000, chain });
        counterResult = { kind: back.kind, reason: back.refusal?.reason, detail: back.refusal?.detail };
      } catch (err) {
        counterResult = { kind: "threw", reason: (err as Error).message };
      }
      return new ServeRefusal("busy", "answered after the counter-ask came back");
    },
    { signal: stop.signal, onError: () => {} },
  );

  try {
    const t0 = Date.now();
    const answer = await asker.ask(alpha.memberId, "please look into this", { timeoutMs: 60_000 });
    const elapsed = Date.now() - t0;
    assert.equal(answer.kind, "response", "the human's ask completes, which it could not before");
    assert.ok(counterResult, "beta's counter-ask returned rather than hanging");
    assert.equal(counterResult!.kind, "refuse", "and it returned a refusal, not a timeout");
    assert.equal(counterResult!.reason, "would_deadlock", "with the wire 0.1.9 reason");
    assert.match(counterResult!.detail ?? "", /chain/, "whose detail names the chain, so 'why was I refused' is a lookup");
    // The number that matters. Before this, the cycle sat until reply_by, which
    // the client defaults to the ask timeout: 20 s for beta's ask alone.
    assert.ok(elapsed < 20_000, `the whole cycle resolved in ${elapsed}ms, not at somebody's reply_by`);
    // And alpha never answered the refused request a second time from its serve
    // loop, which reads the same log on its own cursor.
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(alphaServed.length, 1, `alpha's serve loop handled only the human's request, got ${alphaServed.length}`);
  } finally {
    // End the room rather than only aborting: `serve()` sits in a 25 s long poll
    // and the abort signal is checked between windows, so a bare abort makes the
    // teardown wait out a full window. `room_ended` wakes every waiter at once
    // and both loops return on it, which is also the shutdown path the reference
    // client documents.
    stop.abort();
    await rawCall(hub.mcp, { name: "chainid-test", version: "0" }, "room_end", {
      room: asker.room,
      membership_token: asker.membershipToken,
    }).catch(() => {});
    await Promise.allSettled([alphaServe, betaServe]);
  }
});

test("live: an unchained request to a blocked member is never refused, so a non-conforming peer falls back to the clock", async () => {
  // The fail-open posture, driven with raw sends rather than serve loops: a
  // framework that propagates nothing must still get answers, and the
  // cross-organization backstop is the reply_by clock, not a refusal. Both
  // requests below arrive while `blocked` is waiting on a chained ask; only the
  // one carrying that chain id may be refused.
  const info = { name: "chainid-test", version: "0" };
  const host = await RoomMember.create({ hubUrl: hub.mcp, topic: "failopen", name: "host", card: card("host") });
  const blocked = await RoomMember.create({ hubUrl: hub.mcp, room: host.room, joinSecret: host.joinSecret ?? undefined, name: "blocked", card: card("blocked") });
  const chain = nextChain(null)!;

  // `blocked` waits on a chain nobody will answer; its ask loop is the only
  // thing reading, exactly as inside a resident's turn.
  const waiting = blocked.ask(host.memberId, "anyone there?", { timeoutMs: 2_500, chain }).catch(() => null);
  await new Promise((r) => setTimeout(r, 300));

  const sendTo = (messageId: string, ext?: Record<string, unknown>) =>
    rawCall(hub.mcp, info, "room_send", {
      room: host.room,
      membership_token: host.membershipToken,
      message_id: messageId,
      kind: "request",
      mentions: [blocked.memberId],
      reply_by: new Date(Date.now() + 30_000).toISOString(),
      body: [{ type: "text", text: `question ${messageId}` }],
      ...(ext ? { ext } : {}),
    });
  await sendTo("msg_unchained01");
  await sendTo("msg_onchain0001", { [CHAIN_EXT]: chain });
  await waiting;

  const seen = (await rawCall(hub.mcp, info, "room_listen", {
    room: host.room,
    membership_token: host.membershipToken,
    since: 0,
    timeout_ms: 0,
    wait_for: "all",
  })) as { events: { type: string; envelope?: Envelope }[] };
  const refusals = seen.events
    .map((e) => e.envelope)
    .filter((e): e is Envelope => !!e && e.kind === "refuse" && e.from.id === blocked.memberId);
  assert.equal(refusals.length, 1, `exactly one refusal, for the chained request only; got ${refusals.length}`);
  assert.equal(refusals[0].in_reply_to, "msg_onchain0001", "and it answers the request that carried the chain id");
  assert.equal(refusals[0].refusal?.reason, "would_deadlock");
  // The unchained one is simply unanswered: detection fails OPEN and the clock
  // stamped on it is what recovers, which is the whole cross-org story.
});
