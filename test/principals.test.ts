/**
 * Per-human principals (RFA-0.6 sect. 4.4, rung v0.6.4's local half).
 *
 * Two defects, both named in 4.4 as "not remote-specific":
 *
 *   1. Every provisioned human key was interchangeable, so the hash-chained log
 *      could prove an approval happened and could not say who gave it. 4.4 puts it
 *      bluntly: a log that cannot say which human approved undermines the pitch.
 *   2. `POST /auth` compared keys in constant time; the WIRE join path used
 *      `Array.includes` and was documented in `src/main.ts` as PENDING, on the
 *      reasoning that it sits behind a room handle and a join secret.
 *
 * The interesting assertions are that a principal id is not the key, that two
 * humans produce two attributable actors, and that the console's per-principal
 * names cannot be claimed by prefix.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { RoomHub } from "../src/store.js";
import { consoleNameFor, constantTimeMatch, matchPrincipal, principalIdFor } from "../src/principals.js";
import type { AgentCard } from "../src/model.js";

const KEY_A = "hk_operator_alice_0001";
const KEY_B = "hk_operator_bob_00002";
const card = (name: string): AgentCard => ({
  name,
  description: `${name}.`,
  skills: [{ id: `${name}-skill`, description: `${name} does things.` }],
});

test("a principal id identifies a key without containing it", () => {
  const id = principalIdFor(KEY_A);
  assert.match(id, /^hp_[0-9a-f]{12}$/);
  assert.equal(principalIdFor(KEY_A), id, "stable across calls, so it can be recorded and compared");
  assert.notEqual(principalIdFor(KEY_B), id, "and it distinguishes two operators");

  // The property that lets it go in an event log: it is not the key, nor a prefix
  // of it, nor recoverable from it by truncation.
  assert.ok(!id.includes(KEY_A));
  assert.ok(!KEY_A.includes(id.slice(3)));
  // Domain separation: a bare sha256 of the key would collide with any other place
  // this project hashes the same string.
  assert.notEqual(id.slice(3), createHash("sha256").update(KEY_A).digest("hex").slice(0, 12));
});

test("matchPrincipal says WHICH key matched, and nothing on a miss", () => {
  const keys = [KEY_A, KEY_B];
  assert.equal(matchPrincipal(KEY_A, keys), principalIdFor(KEY_A));
  assert.equal(matchPrincipal(KEY_B, keys), principalIdFor(KEY_B));
  assert.equal(matchPrincipal("hk_wrong", keys), null);
  assert.equal(matchPrincipal("", keys), null);
  assert.equal(matchPrincipal(KEY_A, []), null, "no configured keys means no principal, never a default one");

  // A near-miss must not match: same length, one character different.
  const near = KEY_A.slice(0, -1) + (KEY_A.endsWith("1") ? "2" : "1");
  assert.equal(near.length, KEY_A.length);
  assert.equal(matchPrincipal(near, keys), null);
});

test("constantTimeMatch agrees with matchPrincipal on every verdict", () => {
  // Two functions over the same secrets is how one of them ends up wrong, so they
  // are checked against each other rather than each against a hand-written table.
  const keys = [KEY_A, KEY_B];
  for (const candidate of [KEY_A, KEY_B, "hk_wrong", "", "hk_operator_alice_000", KEY_A + "x"]) {
    assert.equal(
      constantTimeMatch(candidate, keys),
      matchPrincipal(candidate, keys) !== null,
      `disagreement on ${JSON.stringify(candidate)}`,
    );
  }
});

test("the wire join path records which human joined, in constant time", () => {
  // This is the path that used Array.includes. The observable half of the fix is
  // that the member now carries a principal; the timing half is structural.
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [KEY_A, KEY_B] });
  const host = hub.createRoom({ topic: "principals", name: "host", card: card("host") });

  const alice = hub.join({
    room: host.room, join_secret: host.join_secret!, name: "alice", card: card("alice"),
    role: "supervisor", human_key: KEY_A,
  });
  const bob = hub.join({
    room: host.room, join_secret: host.join_secret!, name: "bob", card: card("bob"),
    role: "supervisor", human_key: KEY_B,
  });
  assert.notEqual(alice.you.id, bob.you.id);

  // A wrong key still fails loudly and never downgrades to agent origin.
  assert.throws(
    () => hub.join({ room: host.room, join_secret: host.join_secret!, name: "eve", card: card("eve"), human_key: "hk_nope" }),
    /invalid human_key/,
  );
  hub.close();
});

test("two operators deciding through the console produce two attributable actors", () => {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [KEY_A, KEY_B] });
  const host = hub.createRoom({ topic: "who approved", name: "host", card: card("host") });
  const pa = principalIdFor(KEY_A);
  const pb = principalIdFor(KEY_B);

  const a1 = hub.consoleMembership(host.room, pa);
  const a2 = hub.consoleMembership(host.room, pa);
  const b1 = hub.consoleMembership(host.room, pb);

  assert.equal(a1.member_id, a2.member_id, "the same principal reuses its membership");
  assert.notEqual(a1.member_id, b1.member_id, "two humans are two members, which is the entire point");

  // And the intervention says which human, not just which member.
  hub.admin({ room: host.room, membership_token: a1.membership_token, verb: "inject", params: { text: "alice was here" } });
  const events = (hub.listen({ room: host.room, membership_token: a1.membership_token, since: 0, timeout_ms: 0, wait_for: "all" }) as {
    events: { type: string; verb?: string; actor?: string; refs?: Record<string, unknown> }[];
  }).events;
  const iv = events.find((e) => e.type === "intervention" && e.verb === "inject");
  assert.ok(iv, "the inject is audited");
  assert.equal(iv!.refs!.principal, pa, "the log answers 'which human' without a lookup table");
  assert.equal(iv!.actor, a1.member_id);
  hub.close();
});

test("a per-principal console name cannot be claimed by prefix, and needs human origin", () => {
  const p = principalIdFor(KEY_A);
  const name = consoleNameFor(p);
  assert.match(name, /^console-[0-9a-f]{12}$/);
  assert.ok(!name.includes("hp_"), "the name carries the id's digits, not its prefix");

  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [KEY_A] });
  const host = hub.createRoom({ topic: "prefix", name: "host", card: card("host") });
  const real = hub.consoleMembership(host.room, p);

  // An agent cannot take a console name: the reserved first token still requires a
  // human principal, and `console-<hex>` has first token `console`.
  assert.throws(
    () => hub.join({ room: host.room, join_secret: host.join_secret!, name, card: card("x") }),
    /reserved first name token/,
    "the per-principal naming scheme must not open a hole in the reserved-token rule",
  );

  // And a DIFFERENT principal's lookup must not be satisfied by an existing one.
  const other = hub.consoleMembership(host.room, principalIdFor(KEY_B));
  assert.notEqual(other.member_id, real.member_id);
  hub.close();
});

test("an unattributed caller gets the legacy shared membership, not a fresh authority", () => {
  // Passing no principal must not mint an anonymous supervisor: a caller that
  // cannot say which human it is should not get a new identity out of the deal.
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [KEY_A] });
  const host = hub.createRoom({ topic: "legacy", name: "host", card: card("host") });
  const first = hub.consoleMembership(host.room);
  const second = hub.consoleMembership(host.room);
  assert.equal(first.member_id, second.member_id, "one shared `console`, as before");
  assert.notEqual(hub.consoleMembership(host.room, principalIdFor(KEY_A)).member_id, first.member_id);
  hub.close();
});

test("an agent-origin intervention carries no principal, rather than a placeholder", () => {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [KEY_A] });
  const host = hub.createRoom({ topic: "agents", name: "host", card: card("host") });
  // The host is agent-origin and may run room_admin verbs.
  hub.admin({
    room: host.room, membership_token: host.contract.you.membership_token,
    verb: "set_policy", params: { policies: { mode: "open" } },
  });
  const events = (hub.listen({ room: host.room, membership_token: host.contract.you.membership_token, since: 0, timeout_ms: 0, wait_for: "all" }) as {
    events: { type: string; verb?: string; refs?: Record<string, unknown> }[];
  }).events;
  const iv = events.find((e) => e.type === "intervention" && e.verb === "set_policy");
  assert.ok(iv);
  assert.equal("principal" in iv!.refs!, false, "absent, not `null` and not `hp_unknown`: there is no human to name");
  hub.close();
});

test("two DIFFERENT humans can verify each other; the same human across two memberships cannot", async () => {
  // Implementing principals fixed a latent over-refusal. Spec 10.4's rule was
  // approximated by comparing `home`, and since every local member's home is
  // "local", two distinct human operators on one hub were treated as the same party
  // and could not verify each other's work. Now the comparison is exact.
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [KEY_A, KEY_B] });
  const host = hub.createRoom({ topic: "who may verify", name: "host", card: card("host") });
  const secret = host.join_secret!;
  const join = (name: string, key: string) =>
    hub.join({ room: host.room, join_secret: secret, name, card: card(name), role: "supervisor", human_key: key });

  const alice = join("alice", KEY_A);
  const aliceAgain = join("alice-second-seat", KEY_A); // same human, second membership
  const bob = join("bob", KEY_B);

  const mk = async (title: string) =>
    (await hub.task({ room: host.room, membership_token: alice.you.membership_token, action: "create", title, evidence_required: true })) as { id: string };

  // Alice owns and completes; Bob (a different human) verifies. This is the case
  // that was wrongly refused.
  const t1 = await mk("bob verifies alice");
  await hub.task({ room: host.room, membership_token: alice.you.membership_token, action: "claim", id: t1.id });
  await hub.task({
    room: host.room, membership_token: alice.you.membership_token, action: "complete", id: t1.id,
    evidence: { summary: "done by alice" },
  });
  const verified = (await hub.task({
    room: host.room, membership_token: bob.you.membership_token, action: "verify", id: t1.id, verdict: "accept",
  })) as { verification: { verdict: string; verifier: string } };
  assert.equal(verified.verification.verdict, "accept", "a different human is a different party");
  assert.equal(verified.verification.verifier, bob.you.id);

  // Alice's OTHER membership must not accept Alice's own evidence.
  const t2 = await mk("alice tries to verify herself");
  await hub.task({ room: host.room, membership_token: alice.you.membership_token, action: "claim", id: t2.id });
  await hub.task({
    room: host.room, membership_token: alice.you.membership_token, action: "complete", id: t2.id,
    evidence: { summary: "done by alice again" },
  });
  await assert.rejects(
    () => hub.task({ room: host.room, membership_token: aliceAgain.you.membership_token, action: "verify", id: t2.id, verdict: "accept" }),
    /same principal/,
    "a second seat is not a second party",
  );
  hub.close();
});
