/**
 * Resource claims (wire 10.3's `resources[]` block, RFA-0.8 rung 7): the key
 * grammar with its authority segment, canonical form, the intersection rule, the
 * disclosure digest, and the per-reader redaction of grant keys that makes the
 * digest worth having (item 7, amended 2026-08-28).
 *
 * The intersection tests are written FIRST and deliberately: prefix-or-equal on
 * SEGMENTS is the single easiest thing in this rung to get wrong, a naive
 * `startsWith` gets it wrong, and the bug is invisible until two unrelated packs
 * deadlock each other with nothing in the log to say why.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_KEYS, MAX_KEY_BYTES, digestKey, discloseGrantKey, discloseKey, intersects, redactGrantsFor, segmentsOf, validateKeys } from "../src/resources.js";

// ---------------------------------------------------------------- intersection

test("intersection is prefix-or-equal on SEGMENTS, and a sibling is not a prefix", () => {
  // The spec's own worked example, both halves (wire 10.3 item 5).
  assert.equal(intersects("local/agent-a", "local/agent-a/notes"), true, "a parent conflicts with its child");
  assert.equal(intersects("local/agent-a/notes", "local/agent-a"), true, "and the check is symmetric");
  assert.equal(intersects("local/agent-ab", "local/agent-a"), false, "a SIBLING whose name merely starts with the other's does NOT conflict");

  // The byte-prefix bug, stated as a property: `startsWith` says true for every
  // one of these and every one of them is a different resource.
  for (const [a, b] of [
    ["local/agent-a", "local/agent-ab"],
    ["local/a", "local/ab/c"],
    ["room/r_1/doc", "room/r_1/document"],
    ["local/x/y", "local/x/yz"],
  ] as const) {
    assert.equal(intersects(a, b), false, `${a} and ${b} are different resources`);
    assert.equal(a.startsWith(a.slice(0, 3)) && b.startsWith(a.slice(0, 3)), true, "(and a byte prefix would have said otherwise)");
  }

  assert.equal(intersects("local/a", "local/a"), true, "equal keys conflict");
  assert.equal(intersects("local/a/b/c", "local/a"), true, "depth does not matter, only the sequence");
  assert.equal(intersects("local/a", "room/r_1/a"), false, "different authority segments never intersect");
  assert.equal(intersects("acme/a", "local/a"), false);
});

test("segmentsOf is the one place the separator is interpreted", () => {
  assert.deepEqual(segmentsOf("local/agent-a/notes"), ["local", "agent-a", "notes"]);
  assert.deepEqual(segmentsOf("room/r_1"), ["room", "r_1"]);
});

// ---------------------------------------------------------------- the grammar

const local = { home: "local", roomHandle: "r_1" };
const guest = { home: "acme", roomHandle: "r_1" };

test("the authority segment decides who may claim what", () => {
  // room/<handle>/...: any member of THAT room, local or guest. The only
  // namespace where local and remote claims legitimately intersect.
  assert.equal(validateKeys(["room/r_1/board"], local).ok, true);
  assert.equal(validateKeys(["room/r_1/board"], guest).ok, true);
  const otherRoom = validateKeys(["room/r_2/board"], local);
  assert.equal(otherRoom.ok, false);
  if (!otherRoom.ok) assert.match(otherRoom.reason, /room\/r_1\//, "the refusal says which room handle it would accept");

  // local/...: local members only.
  assert.equal(validateKeys(["local/agent-a"], local).ok, true);
  const guestLocal = validateKeys(["local/agent-a"], guest);
  assert.equal(guestLocal.ok, false);
  if (!guestLocal.ok) assert.match(guestLocal.reason, /local\//);

  // <home>/...: only the peer whose hub-derived home matches.
  assert.equal(validateKeys(["acme/thing"], guest).ok, true);
  assert.equal(validateKeys(["acme/thing"], local).ok, false, "a local member cannot claim under another org's authority");
  assert.equal(validateKeys(["other/thing"], guest).ok, false, "and a peer cannot claim under a home that is not its own");
});

test("`room` is a reserved home, so a key's first segment is never ambiguous", () => {
  // Appendix B: a hub MUST NOT derive or admit home === "room". If it ever did,
  // `room/...` would mean two things at once. The store asserts the join side;
  // this pins the claim side.
  const impossible = validateKeys(["room/anything"], { home: "room", roomHandle: "r_1" });
  assert.equal(impossible.ok, false, "a member whose home is `room` cannot be validated against at all");
  if (!impossible.ok) assert.match(impossible.reason, /reserved/);
});

test("canonical form is enforced, and a bad key is bad_request and not a refusal", () => {
  const cases: [string[], RegExp][] = [
    [[""], /empty/],
    [["local"], /at least two segments/],
    [["local/"], /empty segment/],
    [["local//x"], /empty segment/],
    [["local/./x"], /`\.` or `\.\.`/],
    [["local/../x"], /`\.` or `\.\.`/],
    [["local/x/.."], /`\.` or `\.\.`/],
    [["local/" + "x".repeat(MAX_KEY_BYTES)], /256 bytes/],
    [Array.from({ length: MAX_KEYS + 1 }, (_, i) => `local/k${i}`), /16 keys/],
  ];
  for (const [keys, expected] of cases) {
    const v = validateKeys(keys, local);
    assert.equal(v.ok, false, `expected ${JSON.stringify(keys).slice(0, 60)} to be refused`);
    if (!v.ok) assert.match(v.reason, expected);
  }
  // Exactly at the bounds is fine.
  assert.equal(validateKeys(["local/" + "x".repeat(MAX_KEY_BYTES - 6)], local).ok, true);
  assert.equal(validateKeys(Array.from({ length: MAX_KEYS }, (_, i) => `local/k${i}`), local).ok, true);
});

test("keys are normalized to NFC, so two spellings of one name are one key", () => {
  const composed = "local/café"; // é as one code point
  const decomposed = "local/café"; // e + combining acute
  assert.notEqual(composed, decomposed, "the two spellings differ as byte strings");
  const v = validateKeys([decomposed], local);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.keys[0], composed, "validation returns the NFC form, so the store only ever stores one spelling");
    assert.equal(intersects(v.keys[0], composed), true);
  }
});

test("a duplicate key inside one claim is collapsed, not refused", () => {
  // One real resource, one key (item 4). Asking for the same key twice is a
  // client being redundant, not a client being wrong.
  const v = validateKeys(["local/a", "local/a"], local);
  assert.equal(v.ok, true);
  if (v.ok) assert.deepEqual(v.keys, ["local/a"]);
});

// ---------------------------------------------------------------- disclosure

test("a non-local claimant blocked by a local key sees a digest, never the key", () => {
  const secret = Buffer.from("test-secret");
  const key = "local/pm-agent/handbook";

  const toLocal = discloseKey(key, { claimantHome: "local", secret });
  assert.equal(toLocal, key, "a local claimant sees the key: there is nothing to hide from it");

  const toGuest = discloseKey(key, { claimantHome: "acme", secret });
  assert.notEqual(toGuest, key);
  assert.match(toGuest, /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(toGuest, digestKey(key, secret), "the digest is the documented HMAC, not an ad-hoc hash");
  // No valid key's first segment can contain ":", so a reader can never mistake
  // a digest for a key (wire 10.3 item 8).
  assert.equal(validateKeys([toGuest], { home: "local", roomHandle: "r_1" }).ok, false);

  // A guest blocked by a ROOM key sees it plainly: it is a namespace both parties
  // legitimately share, and hiding it would break back-off for no gain.
  assert.equal(discloseKey("room/r_1/board", { claimantHome: "acme", secret }), "room/r_1/board");
  // As does a guest blocked by its OWN org's key.
  assert.equal(discloseKey("acme/thing", { claimantHome: "acme", secret }), "acme/thing");
});

test("a grant's keys are redacted per reader, by authority segment, through the same digest", () => {
  // Item 7 as amended 2026-08-28. The board used to publish exactly what item 8
  // digests in a refusal, so the digest protected nothing while LOOKING like a
  // protection. The reader's home decides, not the claimant's.
  const secret = Buffer.from("test-secret");
  const room = "r_1";
  const at = (readerHome: string) => (k: string) => discloseGrantKey(k, { readerHome, roomHandle: room, secret });

  const toLocal = at("local");
  for (const k of ["local/pm-agent/handbook", `room/${room}/board`, "acme/thing"]) {
    assert.equal(toLocal(k), k, "a local reader needs the real keys to work, and `rfa task show` prints them");
  }

  const toGuest = at("acme");
  // Shared ground: verbatim, because it is the namespace the guest can itself
  // contend in, which is what makes back-off possible.
  assert.equal(toGuest(`room/${room}/board`), `room/${room}/board`);
  // Its own home: verbatim. Those are the peer's own names, never the operator's,
  // and item 8 already hands the peer exactly these keys in a refusal.
  assert.equal(toGuest("acme/thing"), "acme/thing");
  assert.equal(toGuest("acme"), "acme", "the authority segment alone is still its own");
  // The operator's layout, and another peer's: opaque, through item 8's helper.
  assert.equal(toGuest("local/pm-agent/handbook"), digestKey("local/pm-agent/handbook", secret));
  assert.equal(toGuest("orgb.example/agent-a"), digestKey("orgb.example/agent-a", secret));
  // ANOTHER room's shared namespace is not this reader's shared ground either.
  assert.equal(toGuest("room/r_2/board"), digestKey("room/r_2/board", secret));
  // A prefix of the home is not the home: `acme-corp` must not read as `acme`.
  assert.equal(at("acme")("acme-corp/thing"), digestKey("acme-corp/thing", secret));

  // The whole grant travels: order and every other field preserved, keys mapped.
  const grant = { keys: ["local/pm-agent/handbook", `room/${room}/board`], owner: "m_1", attempt: 2, source: "claim" as const, granted_at: "2026-08-28T00:00:00.000Z" };
  const [redacted] = redactGrantsFor([grant], { readerHome: "acme", roomHandle: room, secret });
  assert.deepEqual(redacted.keys, [digestKey("local/pm-agent/handbook", secret), `room/${room}/board`]);
  assert.equal(redacted.owner, "m_1");
  assert.equal(redacted.attempt, 2);
  assert.equal(redacted.source, "claim");
  assert.deepEqual(grant.keys, ["local/pm-agent/handbook", `room/${room}/board`], "the caller's grant is not mutated: the store's copy stays the record");
});

test("the digest is stable under one secret and unguessable without it", () => {
  const a = Buffer.from("secret-a");
  const b = Buffer.from("secret-b");
  assert.equal(digestKey("local/x", a), digestKey("local/x", a), "stable for the grant's lifetime");
  assert.notEqual(digestKey("local/x", a), digestKey("local/x", b), "keyed, so an unsalted dictionary attack over guessable key shapes fails");
  assert.notEqual(digestKey("local/x", a), digestKey("local/y", a));
});

// ---------------------------------------------------------------- the cross-org memory quarantine

test("a write attributed to a non-local requester is withheld from OTHER turns, and readable by this one", async () => {
  const { GatedMemory } = await import("../src/memoryfs.js");
  const { MemoryGate } = await import("../src/client.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-quarantine-"));
  try {
    // The provider is read PER WRITE, never captured: one GatedMemory serves
    // every concurrent turn in a process, and each may be answering a different
    // organization (RFA-0.8 sect. 4 item 5).
    let serving: { requester_home: string; room: string | null } | null = { requester_home: "local", room: "r_1" };
    const mem = new GatedMemory(root, new MemoryGate(), "m_self", () => serving);

    mem.create("/memories/blocks/ours.md", "---\nlabel: ours\n---\nwhat we concluded");
    serving = { requester_home: "acme", room: "r_1" };
    mem.create("/memories/blocks/theirs.md", "---\nlabel: theirs\n---\nwhat a guest asked us to remember");

    const compiled = mem.compileBlocks();
    assert.match(compiled, /what we concluded/, "a local write reaches every other turn's system prompt as before");
    assert.doesNotMatch(
      compiled,
      /what a guest asked us to remember/,
      "a guest-attributed write is NOT compiled into another turn's prompt: N parallel conversations are N injection sequences in the time of one",
    );
    // Withheld from automatic injection, not deleted and not hidden: the turn
    // that wrote it can still read it, and so can an operator.
    assert.match(mem.view("/memories/blocks/theirs.md"), /what a guest asked us to remember/);

    const prov = mem.provenanceIndex();
    assert.equal(prov["blocks/theirs.md"].requester_home, "acme", "provenance carries the hub-derived home");
    assert.equal(prov["blocks/theirs.md"].room, "r_1");
    assert.equal(prov["blocks/theirs.md"].quarantined, true);
    assert.equal(prov["blocks/ours.md"].quarantined, false, "a local write is never quarantined");

    // The consolidation lane promotes; the answer path cannot reach this, or a
    // guest could promote its own injection by asking twice.
    assert.equal(mem.promote("blocks/theirs.md"), true);
    assert.match(mem.compileBlocks(), /what a guest asked us to remember/, "a promoted write is ordinarily retrievable");
    assert.equal(mem.promote("blocks/theirs.md"), false, "promoting twice is a no-op, not an error");

    // No provider at all is the pre-rung-7 behaviour: an unattributed write (a
    // schedule, a consolidation pass) is the hub's own work and is never held.
    serving = null;
    mem.create("/memories/blocks/sched.md", "---\nlabel: sched\n---\nfrom a timer");
    assert.match(mem.compileBlocks(), /from a timer/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rename carries the quarantine with it, a delete takes the record with the file, and provenance holds all five fields", async () => {
  const { GatedMemory } = await import("../src/memoryfs.js");
  const { MemoryGate } = await import("../src/client.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rfa-quarantine-mv-"));
  try {
    let serving: import("../src/memoryfs.js").WriteProvenance | null = {
      requester_home: "acme", room: "r_1", run_id: "run_1", conversation_id: "conv_1", lane: "serve",
    };
    const mem = new GatedMemory(root, new MemoryGate(), "m_self", () => serving);
    mem.create("/memories/blocks/theirs.md", "---\nlabel: theirs\n---\nwhat a guest asked us to remember");

    // Sect. 4 item 4's five fields, not two: run id, conversation and lane sat
    // on the TurnBinding while the record carried home and room alone (audit
    // 2026-08-30, rank 8).
    const rec = mem.provenanceIndex()["blocks/theirs.md"];
    assert.equal(rec.run_id, "run_1");
    assert.equal(rec.conversation_id, "conv_1");
    assert.equal(rec.lane, "serve");
    assert.equal(rec.quarantined, true);

    // The escape this pins: rename a quarantined block and the record used to
    // stay keyed on the OLD path, so compileBlocks() injected the renamed file
    // into other turns' prompts - the exact read the quarantine withholds.
    mem.rename("/memories/blocks/theirs.md", "/memories/blocks/renamed.md");
    assert.doesNotMatch(
      mem.compileBlocks(),
      /what a guest asked us to remember/,
      "a rename must not lift a quarantine; promotion is promote()'s alone",
    );
    const moved = mem.provenanceIndex();
    assert.equal(moved["blocks/theirs.md"], undefined, "the old key is gone");
    assert.equal(moved["blocks/renamed.md"].quarantined, true, "the record moved intact");
    assert.equal(moved["blocks/renamed.md"].run_id, "run_1");

    // A delete takes the record with the file: an index describing a path that
    // no longer exists lies to the operator and the consolidation lane.
    mem.delete("/memories/blocks/renamed.md");
    assert.equal(mem.provenanceIndex()["blocks/renamed.md"], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provenanceFromTurn maps ALL five required fields off the binding, not two", async () => {
  // The mutation this exists for: dropping run_id/conversation_id/lane from the
  // mapper failed nothing, because the sibling test constructs its provenance
  // literal directly. The mapper is the only production constructor, so it gets
  // its own pin (RFA-0.8 sect. 4 item 4).
  const { provenanceFromTurn } = await import("../src/turnbinding.js");
  const p = provenanceFromTurn({
    runId: "run_9", leaseId: null, agent: "pm", lane: "serve", chain: null,
    replyBy: null, conversationId: "conv_9", taskId: null, requesterHome: "acme", room: "r_2",
  });
  assert.deepEqual(p, { requester_home: "acme", room: "r_2", run_id: "run_9", conversation_id: "conv_9", lane: "serve" });
  assert.equal(provenanceFromTurn(null), null);
});

// ---------------------------------------------------------------- the guest branch, on the store

test("a guest is refused a `local/…` key, and a guest blocked by one sees a digest and never the path", async () => {
  const { RoomHub } = await import("../src/store.js");
  const skill = (id: string) => ({ name: id, description: `${id} agent`, skills: [{ id, description: id }] });
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0 });
  try {
    const host = hub.createRoom({ topic: "guests", name: "host", card: skill("hosting") });
    const room = host.room;
    const localWorker = await hub.join({ room, join_secret: host.join_secret!, name: "local-worker", card: skill("work") });
    const guest = await hub.join({ room, join_secret: host.join_secret!, name: "guest", card: skill("work") });
    // Force the hub-derived home to a foreign org, the way an admission record
    // will. Every member on this hub is `local` until 4.3's admission half
    // ships, so this is the only way to reach the guest branches at all, and the
    // ledger says so rather than implying they were exercised live.
    const internals = hub as unknown as { rooms: Map<string, { members: Map<string, { id: string; home: string }> }> };
    internals.rooms.get(room)!.members.get(guest.you.id)!.home = "orgb.example";

    const mk = async (title: string) =>
      (await hub.task({ room, membership_token: host.contract.you.membership_token, action: "create", title })) as { id: string };

    // The authority segment is a rule about WHO, and it is checked even though a
    // peer's key names cannot be verified: the segment is the part the hub owns.
    const t1 = await mk("guest wants a local key");
    const refusedAuthority = await hub
      .task({ room, membership_token: guest.you.membership_token, action: "claim", id: t1.id, resources: ["local/pm-agent/handbook"] })
      .then(() => null)
      .catch((e: { code?: string; message?: string }) => e);
    assert.equal(refusedAuthority?.code, "bad_request", "a guest claiming under `local/` is malformed, not merely busy");

    // A guest MAY claim under `room/<handle>/…`, the one namespace both parties share.
    const t2 = await mk("guest wants a room key");
    const roomKey = await hub.task({ room, membership_token: guest.you.membership_token, action: "claim", id: t2.id, resources: [`room/${room}/board`] });
    assert.equal((roomKey as { state: string }).state, "working");

    // Now the disclosure rule. A local member holds a `local/…` key; the guest is
    // blocked by it and must NOT learn the operator's resource layout.
    const t3 = await mk("local worker holds a private key");
    await hub.task({ room, membership_token: localWorker.you.membership_token, action: "claim", id: t3.id, resources: ["local/pm-agent/handbook"] });
    const t4 = await mk("guest collides with it");
    const blocked = await hub
      .task({ room, membership_token: guest.you.membership_token, action: "claim", id: t4.id, resources: [`room/${room}/board/x`, "orgb.example/mine"] })
      .then(() => null)
      .catch((e: { code?: string; data?: Record<string, unknown>; message?: string }) => e);
    // That claim collides with the guest's own room-key grant, so it is refused
    // and the blocking key is one the guest already knows: shown plainly.
    assert.equal(blocked?.code, "task_conflict");
    assert.equal(blocked?.data?.blocking_key, `room/${room}/board`, "a room key is shared ground and is disclosed as itself");

    // The case the digest exists for CANNOT ARISE through this path, and that is
    // a property rather than a gap in this test. See the dedicated test below.
    const t5 = await mk("guest cannot even name the local key");
    const cannotName = await hub
      .task({ room, membership_token: guest.you.membership_token, action: "claim", id: t5.id, resources: ["local/pm-agent/handbook/inner"] })
      .then(() => null)
      .catch((e: { code?: string }) => e);
    assert.equal(cannotName?.code, "bad_request", "the authority segment stops the guest before intersection is ever consulted");

    // A LOCAL claimant blocked by the same key sees it in full: there is nothing
    // to protect it from.
    const t6 = await mk("local worker collides with itself");
    const toLocal = await hub
      .task({ room, membership_token: localWorker.you.membership_token, action: "claim", id: t6.id, resources: ["local/pm-agent/handbook/inner"] })
      .then(() => null)
      .catch((e: { code?: string; data?: Record<string, unknown> }) => e);
    assert.equal(toLocal?.code, "task_conflict");
    assert.equal(toLocal?.data?.blocking_key, "local/pm-agent/handbook", "a local claimant sees the key");
  } finally {
    hub.close();
  }
});

test("the `local/…` digest rule cannot fire through the claim path, and that is a property of the grammar", () => {
  // Found while wiring rung 7. Wire 10.3 item 8 says a NON-LOCAL claimant blocked
  // by a `local/…` key gets an opaque digest instead of the key. Under item 2's
  // authority grammar and item 5's intersection rule together, that state is
  // unreachable:
  //
  //   - a non-local claimant's keys may only begin `room/<handle>` or `<its own
  //     home>` (item 2), so `local` is never its first segment;
  //   - intersection is prefix-or-equal on SEGMENTS, so two keys whose FIRST
  //     segments differ never intersect (item 5).
  //
  // Therefore no validated guest key can ever be blocked by a `local/…` key. The
  // rule is kept because the spec states it and because it costs nothing, but it
  // is defence in depth and not a live path, and an implementer who does not know
  // that will either write a test that cannot pass or "fix" the grammar until it
  // can. Exhaustive over every shape a guest could plausibly send:
  const guestHomes = ["orgb.example", "acme", "partner"];
  const localKeys = ["local/a", "local/a/b", "local/pm-agent/handbook"];
  const attempts = [
    "local/a", "local/a/b", "/local/a", "local", "room/r_1/a", "orgb.example/a",
    "acme/local/a", "room/r_1/local/a", "../local/a", "LOCAL/a", "local/./a",
  ];
  for (const home of guestHomes) {
    for (const raw of attempts) {
      const v = validateKeys([raw], { home, roomHandle: "r_1" });
      if (!v.ok) continue; // bad_request: never reaches the intersection check at all
      for (const lk of localKeys) {
        assert.equal(intersects(v.keys[0], lk), false, `a validated guest key ${v.keys[0]} must never intersect ${lk}`);
      }
    }
  }
  // The converse, so this test fails if the grammar is ever widened rather than
  // silently passing: a LOCAL claimant obviously can be blocked by one.
  const localSide = validateKeys(["local/a/b"], { home: "local", roomHandle: "r_1" });
  assert.equal(localSide.ok && intersects(localSide.keys[0], "local/a"), true);
});

// ---------------------------------------------------------------- the greedy-peer watch

test("the greedy-peer watch fires on a QUIET room, counts flaps and not tasks, and holds nobody by default", async () => {
  const { RoomHub } = await import("../src/store.js");
  const skill = (id: string) => ({ name: id, description: `${id} agent`, skills: [{ id, description: id }] });
  let now = 1_000_000_000_000;
  // Two flaps, so the default of three has not been reached, and a window long
  // enough that nothing ages out during the test.
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, defaultLeaseS: 60, flapWindowS: 10, now: () => now, greedyReleaseCount: 3, greedyReleaseWindowS: 600 });
  try {
    const host = hub.createRoom({ topic: "greedy", name: "host", card: skill("hosting") });
    const room = host.room;
    const hostTok = host.contract.you.membership_token;
    const events = async () =>
      ((await hub.listen({ room, membership_token: hostTok, since: 0, timeout_ms: 0, wait_for: "all" })) as { events: { event?: string; refs?: Record<string, unknown> }[] }).events;

    // ONE membership that flaps, which is what the watch is keyed to see: the
    // counter key is `peer_id ?? principal ?? member.id` (RFA-0.6 sect. 5.6), so
    // a peer that drops and comes back is the same claimant across flaps.
    const worker = hub.join({ room, join_secret: host.join_secret!, name: "flapper", card: skill("work") });
    let flaps = 0;
    const flap = async (tasks: number) => {
      flaps++;
      // Back online: any call renews the presence lease (spec 7.2).
      hub.presence({ room, membership_token: worker.you.membership_token, state: "ready" });
      for (let i = 0; i < tasks; i++) {
        const t = (await hub.task({ room, membership_token: hostTok, action: "create", title: `t${flaps}-${i}` })) as { id: string };
        await hub.task({ room, membership_token: worker.you.membership_token, action: "claim", id: t.id });
      }
      now += 71_000; // past the lease plus the flap window: the sweep sees an offline owner
      hub.sweep();
    };

    // Flap one drops THREE tasks at once. If the watch counted released TASKS it
    // would fire here, and one network drop would page an operator.
    await flap(3);
    assert.equal((await events()).filter((e) => e.event === "greedy_release_watch").length, 0, "three tasks dropped in ONE flap is one event, not three");

    await flap(1);
    assert.equal((await events()).filter((e) => e.event === "greedy_release_watch").length, 0, "two flaps are a drop and a retry");

    await flap(1);
    const fired = (await events()).filter((e) => e.event === "greedy_release_watch");
    assert.equal(fired.length, 1, "three flaps inside the window are a pattern, and the operator hears about it");
    assert.equal(fired[0].refs?.releases, 3);
    assert.equal(fired[0].refs?.window_s, 600);
    assert.equal(fired[0].refs?.auto_held, false, "a hold is an intervention; the default is to tell the operator and let them decide");

    // The property that matters most, and the one a rate-shaped alert cannot
    // have: this room has had no message traffic at all. A rate has no
    // denominator at zero traffic, which is exactly how a quiet room's total
    // outage went unreported here for hours.
    const messages = (await events()).filter((e) => (e as { type?: string }).type === "message");
    assert.equal(messages.length, 0, "the watch fired on a room with zero message traffic");
  } finally {
    hub.close();
  }
});
