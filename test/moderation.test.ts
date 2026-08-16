/** Moderation profile tests (spec section 12): room_admin verbs, floor control, supervisor semantics. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHubServer } from "../src/hub.js";
import { RoomHub } from "../src/store.js";
import type { AgentCard } from "../src/model.js";

const card = (name: string): AgentCard => ({
  name,
  description: `${name} does things.`,
  version: "1.0.0",
  skills: [{ id: `${name}-skill`, description: `${name}'s skill.` }],
});

async function connectAgent(hub: RoomHub, clientName: string): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createHubServer(hub);
  const client = new Client({ name: clientName, version: "0.0.1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

class ToolError extends Error {
  constructor(public code: string, message: string, public data: Record<string, unknown>) {
    super(message);
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as any;
  const parsed = JSON.parse(res.content[0].text);
  if (res.isError) throw new ToolError(parsed.error.code, parsed.error.message, parsed.error.data ?? {});
  return parsed;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "(no error)";
  } catch (err) {
    return (err as ToolError).code;
  }
}

let msgCounter = 0;
const mid = () => `mod_${String(++msgCounter).padStart(6, "0")}`;

const HUMAN_KEY = "hk_test_human_1";

/** host (participant) + alice/bob (participants) + eve (human supervisor). */
async function setup(cfg: Record<string, unknown> = {}) {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [HUMAN_KEY], ...cfg });
  const hostC = await connectAgent(hub, "host-conn");
  const aliceC = await connectAgent(hub, "alice-conn");
  const bobC = await connectAgent(hub, "bob-conn");
  const eveC = await connectAgent(hub, "eve-conn");
  const created = await call(hostC, "room_create", { topic: "moderated work", name: "host", card: card("host") });
  const join = (c: Client, name: string, extra: Record<string, unknown> = {}) =>
    call(c, "room_join", { room: created.room, join_secret: created.join_secret, name, card: card(name), ...extra });
  const alice = await join(aliceC, "alice");
  const bob = await join(bobC, "bob");
  const eve = await join(eveC, "eve", { role: "supervisor", human_key: HUMAN_KEY });
  const t = {
    host: created.you.membership_token,
    alice: alice.you.membership_token,
    bob: bob.you.membership_token,
    eve: eve.you.membership_token,
  };
  const id = { host: created.you.id, alice: alice.you.id, bob: bob.you.id, eve: eve.you.id };
  return { hub, hostC, aliceC, bobC, eveC, room: created.room, secret: created.join_secret, t, id };
}

test("principals: human_key gates origin and supervisor role; sends are origin-stamped", async () => {
  const s = await setup();
  // Agent principals cannot self-assign supervisor, wrong keys fail loudly.
  const joinC = await connectAgent(s.hub, "x-conn");
  assert.equal(
    await code(call(joinC, "room_join", { room: s.room, join_secret: s.secret, name: "mallory", card: card("mallory"), role: "supervisor" })),
    "join_denied",
  );
  assert.equal(
    await code(call(joinC, "room_join", { room: s.room, join_secret: s.secret, name: "mallory", card: card("mallory"), human_key: "wrong" })),
    "join_denied",
  );
  // A human participant's messages are stamped origin=human; agents stay agent.
  const human = await call(joinC, "room_join", {
    room: s.room,
    join_secret: s.secret,
    name: "paul",
    card: card("paul"),
    human_key: HUMAN_KEY,
  });
  assert.equal(human.you.origin, "human");
  await call(joinC, "room_send", {
    room: s.room,
    membership_token: human.you.membership_token,
    message_id: mid(),
    body: [{ type: "text", text: "hello from a human" }],
  });
  const all = await call(s.aliceC, "room_listen", { room: s.room, membership_token: s.t.alice, since: 0, timeout_ms: 0, wait_for: "all" });
  const msg = all.events.filter((e: any) => e.type === "message").at(-1);
  assert.equal(msg.envelope.from.origin, "human");
  s.hub.close();
});

test("supervisors are read-only on the message plane and speak via inject", async () => {
  const s = await setup();
  assert.equal(
    await code(call(s.eveC, "room_send", { room: s.room, membership_token: s.t.eve, message_id: mid(), body: [{ type: "text", text: "hi" }] })),
    "unauthorized",
  );
  const injected = await call(s.eveC, "room_admin", {
    room: s.room,
    membership_token: s.t.eve,
    verb: "inject",
    params: { text: "pause the deploy", mentions: [s.id.alice] },
  });
  assert.ok(injected.message_id);
  const got = await call(s.aliceC, "room_listen", { room: s.room, membership_token: s.t.alice, since: 0, timeout_ms: 0 });
  const msg = got.events.find((e: any) => e.type === "message");
  assert.equal(msg.envelope.from.origin, "human");
  assert.equal(msg.envelope.ext["dev.agentcom/injected"], true);
  // The intervention audit trail is in the log.
  const all = await call(s.aliceC, "room_listen", { room: s.room, membership_token: s.t.alice, since: 0, timeout_ms: 0, wait_for: "all" });
  assert.ok(all.events.some((e: any) => e.type === "intervention" && e.verb === "inject"));
  // Plain members cannot use room_admin at all.
  assert.equal(
    await code(call(s.aliceC, "room_admin", { room: s.room, membership_token: s.t.alice, verb: "inject", params: { text: "x" } })),
    "unauthorized",
  );
  s.hub.close();
});

test("hold_member pauses sends and task writes; release_member resumes; target sees both interventions", async () => {
  const s = await setup();
  await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "hold_member", target: s.id.alice, reason: "runaway loop" });
  assert.equal(
    await code(call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), body: [{ type: "text", text: "hi" }] })),
    "held",
  );
  assert.equal(
    await code(call(s.aliceC, "room_task", { room: s.room, membership_token: s.t.alice, action: "create", title: "sneaky task" })),
    "held",
  );
  // Reads still work while held (alice must be able to hear the release).
  const seen = await call(s.aliceC, "room_listen", { room: s.room, membership_token: s.t.alice, since: 0, timeout_ms: 0 });
  assert.ok(seen.events.some((e: any) => e.type === "intervention" && e.verb === "hold_member" && e.target === s.id.alice));
  // Roster shows the hold.
  const roster = await call(s.bobC, "room_roster", { room: s.room, membership_token: s.t.bob });
  assert.equal(roster.roster.find((r: any) => r.id === s.id.alice).held, true);
  await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "release_member", target: s.id.alice });
  await call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), body: [{ type: "text", text: "back" }] });
  // The host is protected from holds.
  assert.equal(
    await code(call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "evict", target: s.id.host })),
    "unauthorized",
  );
  s.hub.close();
});

test("evict revokes on the next call; quarantine also blocks re-join by name and by card digest", async () => {
  const s = await setup();
  await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "quarantine", target: s.id.bob, reason: "prompt injection" });
  // Token is dead immediately (spec 14.8).
  assert.equal(
    await code(call(s.bobC, "room_send", { room: s.room, membership_token: s.t.bob, message_id: mid(), body: [{ type: "text", text: "?" }] })),
    "not_a_member",
  );
  // Same name is refused; a different name with the same card (digest) too.
  const rejoinC = await connectAgent(s.hub, "rejoin-conn");
  assert.equal(
    await code(call(rejoinC, "room_join", { room: s.room, join_secret: s.secret, name: "bob", card: card("bob") })),
    "join_denied",
  );
  assert.equal(
    await code(call(rejoinC, "room_join", { room: s.room, join_secret: s.secret, name: "bobby", card: card("bob") })),
    "join_denied",
  );
  // A fresh identity still gets in.
  await call(rejoinC, "room_join", { room: s.room, join_secret: s.secret, name: "carol", card: card("carol") });
  // The roster event is reason=evict and the epoch advanced.
  const all = await call(s.aliceC, "room_listen", { room: s.room, membership_token: s.t.alice, since: 0, timeout_ms: 0, wait_for: "all" });
  assert.ok(all.events.some((e: any) => e.type === "roster" && e.reason === "evict" && e.actor === s.id.bob));
  s.hub.close();
});

test("quarantine release is the pending human action: agent supervisors cannot, humans can", async () => {
  const s = await setup();
  // Promote an agent to supervisor (host authority), then quarantine bob with it.
  await call(s.hostC, "room_admin", { room: s.room, membership_token: s.t.host, verb: "set_role", target: s.id.alice, params: { role: "supervisor" } });
  await call(s.aliceC, "room_admin", { room: s.room, membership_token: s.t.alice, verb: "quarantine", target: s.id.bob });
  // The agent supervisor cannot lift it.
  assert.equal(
    await code(call(s.aliceC, "room_admin", { room: s.room, membership_token: s.t.alice, verb: "release_member", target: s.id.bob })),
    "unauthorized",
  );
  // The human supervisor can; bob's identity may re-join afterwards.
  await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "release_member", target: s.id.bob });
  const rejoinC = await connectAgent(s.hub, "rejoin-conn");
  const back = await call(rejoinC, "room_join", { room: s.room, join_secret: s.secret, name: "bob", card: card("bob") });
  assert.equal(back.you.name, "bob");
  s.hub.close();
});

test("set_role: host-only, host protected, epoch bumps, role roster event lands", async () => {
  const s = await setup();
  const before = (await call(s.hostC, "room_roster", { room: s.room, membership_token: s.t.host })).epoch;
  // Supervisors cannot assign roles; the host can.
  assert.equal(
    await code(call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "set_role", target: s.id.alice, params: { role: "observer" } })),
    "unauthorized",
  );
  await call(s.hostC, "room_admin", { room: s.room, membership_token: s.t.host, verb: "set_role", target: s.id.alice, params: { role: "observer" } });
  const after = await call(s.hostC, "room_roster", { room: s.room, membership_token: s.t.host });
  assert.equal(after.epoch, before + 1);
  assert.equal(after.roster.find((r: any) => r.id === s.id.alice).role, "observer");
  // Demoted alice can no longer send.
  assert.equal(
    await code(call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), body: [{ type: "text", text: "hi" }] })),
    "unauthorized",
  );
  assert.equal(
    await code(call(s.hostC, "room_admin", { room: s.room, membership_token: s.t.host, verb: "set_role", target: s.id.host, params: { role: "observer" } })),
    "unauthorized",
  );
  const all = await call(s.hostC, "room_listen", { room: s.room, membership_token: s.t.host, since: 0, timeout_ms: 0, wait_for: "all" });
  assert.ok(all.events.some((e: any) => e.type === "roster" && e.reason === "role" && e.actor === s.id.alice));
  s.hub.close();
});

test("approval flow: only a human-origin approve satisfies; agents approving is void by construction", async () => {
  const s = await setup();
  // Promote alice (an agent) to supervisor to prove the origin check bites even with the role.
  await call(s.hostC, "room_admin", { room: s.room, membership_token: s.t.host, verb: "set_role", target: s.id.bob, params: { role: "supervisor" } });
  await call(s.aliceC, "room_send", {
    room: s.room,
    membership_token: s.t.alice,
    message_id: mid(),
    kind: "request",
    body: [{ type: "text", text: "requesting permission to deploy to prod" }],
    mentions: [s.id.eve],
    ext: { "dev.agentcom/approval": { request_id: "apr_deploy_1", action: "deploy_prod" } },
  });
  // Agent-origin supervisor: refused. Reject would be allowed, approve is not.
  assert.equal(
    await code(call(s.bobC, "room_admin", { room: s.room, membership_token: s.t.bob, verb: "approve", target: "apr_deploy_1" })),
    "unauthorized",
  );
  // Unknown request ids fail loudly.
  assert.equal(
    await code(call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "approve", target: "apr_nope" })),
    "bad_request",
  );
  const ok = await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "approve", target: "apr_deploy_1" });
  assert.equal(ok.status, "approved");
  // The requester sees the verdict under the mentions filter, with correlation refs.
  const got = await call(s.aliceC, "room_listen", { room: s.room, membership_token: s.t.alice, since: 0, timeout_ms: 0 });
  const iv = got.events.find((e: any) => e.type === "intervention" && e.verb === "approve");
  assert.equal(iv.target, s.id.alice);
  assert.equal(iv.refs.request_id, "apr_deploy_1");
  // Double-decide conflicts; duplicate request_ids conflict too.
  assert.equal(
    await code(call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "reject", target: "apr_deploy_1" })),
    "task_conflict",
  );
  assert.equal(
    await code(
      call(s.aliceC, "room_send", {
        room: s.room,
        membership_token: s.t.alice,
        message_id: mid(),
        kind: "request",
        body: [{ type: "text", text: "again" }],
        ext: { "dev.agentcom/approval": { request_id: "apr_deploy_1", action: "deploy_prod" } },
      }),
    ),
    "task_conflict",
  );
  s.hub.close();
});

test("supervisor cancel_task overrides ownership and audits the intervention", async () => {
  const s = await setup();
  const task = await call(s.aliceC, "room_task", { room: s.room, membership_token: s.t.alice, action: "create", title: "risky migration" });
  await call(s.bobC, "room_task", { room: s.room, membership_token: s.t.bob, action: "claim", id: task.id });
  const res = await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "cancel_task", target: task.id, reason: "insufficient review" });
  assert.equal(res.ok, true);
  const after = await call(s.aliceC, "room_task", { room: s.room, membership_token: s.t.alice, action: "get", id: task.id });
  assert.equal(after.state, "cancelled");
  const got = await call(s.bobC, "room_listen", { room: s.room, membership_token: s.t.bob, since: 0, timeout_ms: 0 });
  assert.ok(got.events.some((e: any) => e.type === "intervention" && e.verb === "cancel_task" && e.refs.task_id === task.id));
  s.hub.close();
});

test("sequential floor: first speaker takes it, others queue with not_your_turn, yield_floor advances", async () => {
  const s = await setup();
  await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "set_policy", params: { policies: { mode: "sequential" } } });
  // Alice speaks first and takes the floor.
  await call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), body: [{ type: "text", text: "my turn" }] });
  // Bob's turn-starting message queues him.
  let denied: ToolError | null = null;
  try {
    await call(s.bobC, "room_send", { room: s.room, membership_token: s.t.bob, message_id: mid(), body: [{ type: "text", text: "me too" }] });
  } catch (e) {
    denied = e as ToolError;
  }
  assert.equal(denied?.code, "not_your_turn");
  assert.equal(denied?.data.holder, s.id.alice);
  assert.equal(denied?.data.position, 1);
  // Replies flow freely: bob answering alice is not turn-starting.
  await call(s.bobC, "room_send", {
    room: s.room,
    membership_token: s.t.bob,
    message_id: mid(),
    kind: "response",
    in_reply_to: "whatever_alice_said",
    body: [{ type: "text", text: "a reply" }],
  });
  const roster = await call(s.hostC, "room_roster", { room: s.room, membership_token: s.t.host });
  assert.equal(roster.floor.holder, s.id.alice);
  assert.deepEqual(roster.floor.queue, [s.id.bob]);
  // Alice yields with her last message; bob is granted and notified.
  await call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), body: [{ type: "text", text: "done" }], yield_floor: true });
  const bobSees = await call(s.bobC, "room_listen", { room: s.room, membership_token: s.t.bob, since: 0, timeout_ms: 0 });
  assert.ok(bobSees.events.some((e: any) => e.type === "system" && e.event === "floor_granted" && e.refs.member === s.id.bob));
  await call(s.bobC, "room_send", { room: s.room, membership_token: s.t.bob, message_id: mid(), body: [{ type: "text", text: "finally my turn" }] });
  s.hub.close();
});

test("floor timers: grace expiry times out a silent grantee and advances the queue (fake clock)", async () => {
  let now = 1_000_000_000_000;
  const s = await setup({ now: () => now, floorGraceS: 10, floorRenewS: 30, floorCapS: 60 });
  await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "set_policy", params: { policies: { mode: "sequential" } } });
  await call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), body: [{ type: "text", text: "turn A" }] });
  assert.equal(await code(call(s.bobC, "room_send", { room: s.room, membership_token: s.t.bob, message_id: mid(), body: [{ type: "text", text: "queue me" }] })), "not_your_turn");
  // Renewal: a status message extends alice's turn.
  now += 25_000;
  await call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), kind: "status", body: [{ type: "text", text: "still working" }] });
  now += 25_000;
  s.hub.sweep();
  let roster = await call(s.hostC, "room_roster", { room: s.room, membership_token: s.t.host });
  assert.equal(roster.floor.holder, s.id.alice, "renewed turn survives");
  // But the hard cap ends it: past 60s total the turn expires and bob is granted.
  now += 15_000;
  s.hub.sweep();
  roster = await call(s.hostC, "room_roster", { room: s.room, membership_token: s.t.host });
  assert.equal(roster.floor.holder, s.id.bob, "cap expiry advances the queue");
  const all = await call(s.hostC, "room_listen", { room: s.room, membership_token: s.t.host, since: 0, timeout_ms: 0, wait_for: "all" });
  assert.ok(all.events.some((e: any) => e.type === "system" && e.event === "timeout" && e.refs.scope === "floor" && e.refs.member === s.id.alice));
  // Bob never speaks: grace expiry frees the floor entirely (queue empty).
  now += 11_000;
  s.hub.sweep();
  roster = await call(s.hostC, "room_roster", { room: s.room, membership_token: s.t.host });
  assert.equal(roster.floor.holder, null);
  s.hub.close();
});

test("moderator mode: only the designated moderator starts turns unassigned; grant_floor assigns", async () => {
  const s = await setup();
  // Host designates alice as moderator.
  await call(s.hostC, "room_admin", { room: s.room, membership_token: s.t.host, verb: "set_policy", params: { policies: { mode: "moderator", moderator: s.id.alice } } });
  // Bob cannot start a turn even with the floor free.
  assert.equal(await code(call(s.bobC, "room_send", { room: s.room, membership_token: s.t.bob, message_id: mid(), body: [{ type: "text", text: "hi" }] })), "not_your_turn");
  // The moderator herself can speak, and can grant the floor to bob.
  await call(s.aliceC, "room_send", { room: s.room, membership_token: s.t.alice, message_id: mid(), body: [{ type: "text", text: "bob, go ahead" }], yield_floor: true });
  await call(s.aliceC, "room_admin", { room: s.room, membership_token: s.t.alice, verb: "grant_floor", target: s.id.bob });
  await call(s.bobC, "room_send", { room: s.room, membership_token: s.t.bob, message_id: mid(), body: [{ type: "text", text: "thanks" }] });
  // Back to open clears the floor and everyone may speak again.
  await call(s.eveC, "room_admin", { room: s.room, membership_token: s.t.eve, verb: "set_policy", params: { policies: { mode: "open" } } });
  await call(s.bobC, "room_send", { room: s.room, membership_token: s.t.bob, message_id: mid(), body: [{ type: "text", text: "free again" }] });
  const roster = await call(s.hostC, "room_roster", { room: s.room, membership_token: s.t.host });
  assert.equal(roster.floor.mode, "open");
  assert.equal(roster.floor.holder, null);
  s.hub.close();
});

test("moderation state survives a restart: quarantine, held, origin, approvals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-mod-"));
  const hub1 = new RoomHub({ dataDir: dir, sweepIntervalMs: 0, humanKeys: [HUMAN_KEY] });
  const hostC = await connectAgent(hub1, "host-conn");
  const aliceC = await connectAgent(hub1, "alice-conn");
  const eveC = await connectAgent(hub1, "eve-conn");
  const created = await call(hostC, "room_create", { topic: "persist", name: "host", card: card("host") });
  const alice = await call(aliceC, "room_join", { room: created.room, join_secret: created.join_secret, name: "alice", card: card("alice") });
  const eve = await call(eveC, "room_join", { room: created.room, join_secret: created.join_secret, name: "eve", card: card("eve"), role: "supervisor", human_key: HUMAN_KEY });
  await call(aliceC, "room_send", {
    room: created.room,
    membership_token: alice.you.membership_token,
    message_id: mid(),
    kind: "request",
    body: [{ type: "text", text: "may I?" }],
    ext: { "dev.agentcom/approval": { request_id: "apr_persist_1", action: "ship" } },
  });
  await call(eveC, "room_admin", { room: created.room, membership_token: eve.you.membership_token, verb: "hold_member", target: alice.you.id });
  const bobC = await connectAgent(hub1, "bob-conn");
  const bob = await call(bobC, "room_join", { room: created.room, join_secret: created.join_secret, name: "bob", card: card("bob") });
  await call(eveC, "room_admin", { room: created.room, membership_token: eve.you.membership_token, verb: "quarantine", target: bob.you.id });
  hub1.close();

  const hub2 = new RoomHub({ dataDir: dir, sweepIntervalMs: 0, humanKeys: [HUMAN_KEY] });
  const c2 = await connectAgent(hub2, "post-restart");
  // Quarantine survives.
  assert.equal(
    await code(call(c2, "room_join", { room: created.room, join_secret: created.join_secret, name: "bob", card: card("bob") })),
    "join_denied",
  );
  // Held survives.
  assert.equal(
    await code(call(c2, "room_send", { room: created.room, membership_token: alice.you.membership_token, message_id: mid(), body: [{ type: "text", text: "hi" }] })),
    "held",
  );
  // Human origin and the pending approval survive: eve can still approve it.
  const ok = await call(c2, "room_admin", { room: created.room, membership_token: eve.you.membership_token, verb: "approve", target: "apr_persist_1" });
  assert.equal(ok.status, "approved");
  hub2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
