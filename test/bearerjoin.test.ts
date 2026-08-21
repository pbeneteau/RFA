/**
 * Bearer-implied admission (spec 4.3, first slice) and the 2026-08-21 history
 * defaults. The complaint that shipped both: an operator had to paste a
 * join_secret into a model's chat for a remote member to join, and every new
 * member received room history nothing consumed.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RoomHub } from "../src/store.js";
import { withBearer } from "../src/reqcontext.js";
import { sha256hex } from "../src/jcs.js";
import type { AgentCard } from "../src/model.js";

const card = (name: string): AgentCard => ({
  name,
  description: `${name} does things.`,
  skills: [{ id: `${name}-skill`, description: `${name}'s skill.` }],
});

async function fails(fn: () => unknown): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure, got none");
}

const STUDIO_BEARER = "tok_studio_example_bearer";
const STUDIO_SHA = sha256hex(STUDIO_BEARER);

test("a listed transport bearer joins without a join_secret; everyone else still needs one", async () => {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: ["hk_b"] });
  const host = hub.createRoom({
    topic: "bearer admission",
    name: "host",
    card: card("host"),
    policies: { join_bearer_sha256: [STUDIO_SHA] },
  });

  // No secret, no bearer context (a stdio/in-process caller): refused.
  const bare = await fails(() => hub.join({ room: host.room, name: "stranger", card: card("stranger") }));
  assert.equal(bare.code, "join_denied");

  // No secret, WRONG bearer: refused. The hash comes from request context the
  // HTTP layer set, never from an argument a client could forge.
  const wrong = await fails(() => withBearer(sha256hex("some-other-token"), () => hub.join({ room: host.room, name: "stranger", card: card("stranger") })));
  assert.equal(wrong.code, "join_denied");

  // No secret, LISTED bearer: admitted. This is the whole point: the secret
  // lives beside the bearer in the peer's MCP config, and the chat that says
  // "join room r_X" carries no credential at all.
  const joined = withBearer(STUDIO_SHA, () => hub.join({ room: host.room, name: "studio", card: card("studio") }));
  assert.equal(joined.you.name, "studio");

  // The secret path is untouched.
  const bySecret = hub.join({ room: host.room, join_secret: host.join_secret!, name: "classic", card: card("classic") });
  assert.equal(bySecret.you.name, "classic");
  hub.close();
});

test("set_policy manages the bearer list, hashes only, and it is audited", async () => {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: ["hk_b"] });
  const host = hub.createRoom({ topic: "bearer policy", name: "host", card: card("host") });

  // Raw bearers (not 64-hex) must never enter persisted room metadata.
  const raw = await fails(() =>
    hub.admin({ room: host.room, membership_token: host.contract.you.membership_token, verb: "set_policy", params: { policies: { join_bearer_sha256: [STUDIO_BEARER] } } }),
  );
  assert.equal(raw.code, "bad_request");

  await hub.admin({
    room: host.room,
    membership_token: host.contract.you.membership_token,
    verb: "set_policy",
    params: { policies: { join_bearer_sha256: [STUDIO_SHA] } },
  });
  const joined = withBearer(STUDIO_SHA, () => hub.join({ room: host.room, name: "studio", card: card("studio") }));
  assert.equal(joined.you.name, "studio");

  // Revocation is the other half: clear the list and the same bearer is out.
  await hub.admin({
    room: host.room,
    membership_token: host.contract.you.membership_token,
    verb: "set_policy",
    params: { policies: { join_bearer_sha256: [] } },
  });
  const revoked = await fails(() => withBearer(STUDIO_SHA, () => hub.join({ room: host.room, name: "studio2", card: card("studio2") })));
  assert.equal(revoked.code, "join_denied");
  hub.close();
});

test("new rooms default to joined_after: the rule is room-wide, the appetite per agent, and appetite never exceeds rule", async () => {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: ["hk_b"] });
  const host = hub.createRoom({ topic: "history defaults", name: "host", card: card("host") });
  assert.equal((hub.roster({ room: host.room, membership_token: host.contract.you.membership_token }) as any).policies.history_visibility, "joined_after");

  await hub.send({ room: host.room, membership_token: host.contract.you.membership_token, message_id: "m_h1", kind: "chat", body: [{ type: "text", text: "before the guest" }] });

  // Default appetite is 0: the join contract carries no history even for the host's own room.
  const guest = hub.join({ room: host.room, join_secret: host.join_secret!, name: "guest", card: card("guest") });
  assert.equal(guest.history.events.length, 0, "history_limit defaults to 0");

  // Appetite is per agent, but the room-wide rule caps it: asking for 100 gets
  // nothing from before the join.
  const greedy = hub.join({ room: host.room, join_secret: host.join_secret!, name: "greedy", card: card("greedy"), history_limit: 100 });
  assert.ok(!greedy.history.events.some((e: any) => e.type === "message"), "joined_after hides pre-join messages regardless of appetite");

  // And the listen path is clamped the same way.
  const replay = await hub.listen({ room: host.room, membership_token: greedy.you.membership_token, since: 0, timeout_ms: 0, wait_for: "all" });
  assert.ok(!replay.events.some((e: any) => e.type === "message" && e.envelope?.message_id === "m_h1"), "since:0 cannot reach pre-join history");

  // A human principal is exempt: the operator's key could read the log file on
  // this disk anyway, and the console's scrollback is operator UX, not leakage.
  const human = hub.join({ room: host.room, join_secret: host.join_secret!, name: "operator-eyes", card: card("op"), human_key: "hk_b", role: "supervisor" });
  const humanReplay = await hub.listen({ room: host.room, membership_token: human.you.membership_token, since: 0, timeout_ms: 0, wait_for: "all" });
  assert.ok(humanReplay.events.some((e: any) => e.type === "message" && e.envelope?.message_id === "m_h1"), "human principals keep scrollback");

  // A room that IS a shared workspace opts back in explicitly.
  const shared = hub.createRoom({ topic: "workspace", name: "host2", card: card("host2"), policies: { history_visibility: "member" } });
  await hub.send({ room: shared.room, membership_token: shared.contract.you.membership_token, message_id: "m_h2", kind: "chat", body: [{ type: "text", text: "for everyone later" }] });
  const late = hub.join({ room: shared.room, join_secret: shared.join_secret!, name: "late", card: card("late"), history_limit: 50 });
  assert.ok(late.history.events.some((e: any) => e.envelope?.message_id === "m_h2"), "member visibility still shares the past when asked for");
  hub.close();
});

test("the human exemption covers the join-contract slice, which is the console's only scrollback", async () => {
  // Found in review 2026-08-22: the exemption lived only on the listen path,
  // while the console renders contract.history and then long-polls forward,
  // so a joined_after room's overnight alerts were invisible to the operator.
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: ["hk_b"] });
  const host = hub.createRoom({ topic: "scrollback", name: "host", card: card("host") });
  await hub.send({ room: host.room, membership_token: host.contract.you.membership_token, message_id: "m_alert", kind: "chat", body: [{ type: "text", text: "overnight alert" }] });

  const console_ = hub.join({ room: host.room, join_secret: host.join_secret!, name: "operator-console", card: card("oc"), human_key: "hk_b", role: "supervisor", history_limit: 200 });
  assert.ok(console_.history.events.some((e: any) => e.envelope?.message_id === "m_alert"), "the operator's join contract keeps scrollback on a joined_after room");

  const agent = hub.join({ room: host.room, join_secret: host.join_secret!, name: "late-agent", card: card("la"), history_limit: 200 });
  assert.ok(!agent.history.events.some((e: any) => e.type === "message"), "an agent's join contract stays clamped");
  hub.close();
});

test("history_visibility is settable after create, because an opt-in that only exists at create is not one", async () => {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: ["hk_b"] });
  const host = hub.createRoom({ topic: "switchable", name: "host", card: card("host") });
  await hub.send({ room: host.room, membership_token: host.contract.you.membership_token, message_id: "m_pre", kind: "chat", body: [{ type: "text", text: "before" }] });

  await hub.admin({ room: host.room, membership_token: host.contract.you.membership_token, verb: "set_policy", params: { policies: { history_visibility: "member" } } });
  const late = hub.join({ room: host.room, join_secret: host.join_secret!, name: "late", card: card("late"), history_limit: 50 });
  assert.ok(late.history.events.some((e: any) => e.envelope?.message_id === "m_pre"), "switching to member shares the past");

  const bad = await fails(() => hub.admin({ room: host.room, membership_token: host.contract.you.membership_token, verb: "set_policy", params: { policies: { history_visibility: "everything" } } }));
  assert.equal(bad.code, "bad_request");
  hub.close();
});
