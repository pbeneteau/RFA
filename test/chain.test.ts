/**
 * The offline chain verifier (wire sect. 13, rung v0.6.3b).
 *
 * The hub has computed this chain since 0.1.7 but only ever FORWARD: it stamps
 * `prev_hash` from its running head and moves on. Nothing walked a log backwards
 * and asked whether the links hold, so "the log is tamper-evident" was a claim
 * about the code rather than a checked property of the bytes.
 *
 * The tests that matter here are the ones about NOT crying wolf. A verifier that
 * reports the project's own main room as tampered, or prints a green light over a
 * log it never checked, is a verifier somebody switches off.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalize, sha256hex } from "../src/jcs.js";
import { CHAIN_SCOPE_QUALIFIER, genesisFor, hashedForm, linkOf, verifyChain } from "../src/chain.js";
import { RoomHub } from "../src/store.js";
import type { AgentCard } from "../src/model.js";

const card = (name: string): AgentCard => ({
  name,
  description: `${name}.`,
  skills: [{ id: `${name}-skill`, description: `${name} does things.` }],
});

/** A real chained log, straight from the hub, so the test never reimplements the producer. */
async function realLog(): Promise<{ handle: string; events: Record<string, unknown>[]; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-chain-"));
  const hub = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  const room = hub.createRoom({ topic: "chain under test", name: "host", card: card("host") });
  const tok = room.contract.you.membership_token;
  for (const text of ["first", "second", "third"]) {
    await hub.send({ room: room.room, membership_token: tok, message_id: `msg_${text}0001`, kind: "chat", body: [{ type: "text", text }] });
  }
  await hub.task({ room: room.room, membership_token: tok, action: "create", title: "a task in the chain" });
  hub.close();
  const file = path.join(dir, "rooms", `${room.room}.ndjson`);
  const events = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { handle: room.room, events, dir };
}

test("a real hub's log verifies, genesis included", async () => {
  const { handle, events, dir } = await realLog();
  const res = verifyChain(events, { genesis: genesisFor(handle) });
  assert.equal(res.ok, true, JSON.stringify(res.divergences, null, 1));
  assert.equal(res.genesisOk, true, "the genesis link is sha256 of the room handle");
  assert.equal(res.unchainedPrefix, 0, "a log written by a current hub is chained from its first event");
  assert.equal(res.linksChecked, events.length - 1, "every link checked");
  assert.equal(res.unverifiable, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("one altered byte anywhere in the log is caught, and reported at the FOLLOWING event", async () => {
  const { handle, events, dir } = await realLog();
  const target = events.findIndex((e) => e.type === "message");
  assert.ok(target > 0, "need a message to alter");

  const tampered = events.map((e) => JSON.parse(JSON.stringify(e)) as Record<string, unknown>);
  const env = tampered[target].envelope as { body: { type: string; text?: string }[] };
  env.body[0].text = "FIRST";

  const res = verifyChain(tampered, { genesis: genesisFor(handle) });
  assert.equal(res.ok, false);
  assert.equal(res.divergences.length, 1, "one edit is one break, not a cascade: the chain re-anchors after it");
  // The break surfaces at the NEXT event, because that is the event whose stored
  // prev_hash no longer matches. An operator told "seq N is broken" would look at
  // the wrong event, so the message names both candidates.
  assert.equal(res.divergences[0].seq, Number(events[target + 1].seq));
  assert.match(res.divergences[0].suspect, new RegExp(`event ${String(events[target].seq)} was altered`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pre-chain prefix is skipped, not reported as tampering", () => {
  // This is real, not hypothetical: the standing room's first 269 events predate
  // 0.1.7 and carry no prev_hash. A verifier that called that a break would report
  // the project's own main room as tampered.
  const genesis = genesisFor("r_old");
  const legacy = [
    { seq: 0, ts: "2026-08-16T09:00:00.000Z", type: "roster", reason: "join" },
    { seq: 1, ts: "2026-08-16T09:00:01.000Z", type: "roster", reason: "join" },
  ] as Record<string, unknown>[];
  const first = { seq: 2, ts: "2026-08-17T09:00:00.000Z", type: "system", event: "x", prev_hash: "does-not-matter" };
  const second = { seq: 3, ts: "2026-08-17T09:00:01.000Z", type: "system", event: "y", prev_hash: sha256hex(canonicalize(first)) };

  const res = verifyChain([...legacy, first, second], { genesis });
  assert.equal(res.ok, true, "the chained tail verifies on its own");
  assert.equal(res.unchainedPrefix, 2);
  assert.equal(res.linksChecked, 1, "only the one real link");
  assert.equal(res.genesisOk, null, "a chain that starts mid-log has no genesis to check; null, not false");
  assert.equal(res.unverifiable, false, "one link IS a verification");
});

test("a log with no chain at all is NOT-CHAINED, never intact", () => {
  // Ten of this hub's thirteen room logs are in exactly this state. Reporting them
  // as intact would be a green light over a log nobody checked.
  const res = verifyChain(
    [
      { seq: 0, ts: "2026-08-16T09:00:00.000Z", type: "roster", reason: "join" },
      { seq: 1, ts: "2026-08-16T09:00:01.000Z", type: "roster", reason: "leave" },
    ] as Record<string, unknown>[],
    { genesis: genesisFor("r_ancient") },
  );
  assert.equal(res.ok, true, "nothing contradicts it");
  assert.equal(res.unverifiable, true, "but nothing verifies it either, and the two must not be conflated");
  assert.equal(res.linksChecked, 0);
});

test("a wrong genesis is caught: the handle must hash to the first link", () => {
  const first = { seq: 0, ts: "2026-08-17T09:00:00.000Z", type: "roster", reason: "join", prev_hash: genesisFor("r_real") };
  const ok = verifyChain([first] as Record<string, unknown>[], { genesis: genesisFor("r_real") });
  assert.equal(ok.genesisOk, true);

  const wrong = verifyChain([first] as Record<string, unknown>[], { genesis: genesisFor("r_other") });
  assert.equal(wrong.ok, false);
  assert.match(wrong.divergences[0].suspect, /genesis/);
});

test("`wrapped` is stripped and NOTHING else is: the extra exclusions are now wrong", () => {
  // The hub used to stamp envelope.seq and envelope.ts AFTER serializing, so a
  // verifier had to zero both to reproduce a hash. Fixed 2026-08-18 by stamping
  // before hashing, which makes those exclusions actively wrong: applying them
  // fails every message link. INTEROP.md told peers to do it in three places.
  const stored = {
    seq: 7,
    ts: "2026-08-18T10:00:00.000Z",
    type: "message",
    prev_hash: "abc",
    envelope: { message_id: "msg_x0000001", seq: 7, ts: "2026-08-18T10:00:00.000Z", body: [{ type: "text", text: "hi" }] },
  } as Record<string, unknown>;
  const served = { ...stored, wrapped: "<room-message ...>hi</room-message>" };

  assert.equal(linkOf(served).hash, linkOf(stored).hash, "a served event hashes like its stored form once wrapped is removed");
  assert.equal("wrapped" in hashedForm(served), false);
  assert.equal("wrapped" in served, true, "and the caller's object is not mutated: these are often the hub's live objects");

  // The retired procedure, demonstrated to be wrong rather than asserted to be.
  const zeroed = JSON.parse(JSON.stringify(stored)) as { envelope: { seq: number; ts: string } };
  zeroed.envelope.seq = 0;
  zeroed.envelope.ts = "";
  assert.notEqual(sha256hex(canonicalize(zeroed)), linkOf(stored).hash, "zeroing envelope.seq/ts now produces the WRONG hash");
});

test("a redacted event verifies through content_hash, so redaction does not read as tampering", () => {
  // Wire 12.1. There is no producer yet (`room_admin redact` is the next rung), so
  // this constructs the shape the spec fixes: the pre-redaction hash is stamped on
  // the event and the verifier MUST use it instead of recomputing over the blank.
  const original = {
    seq: 4,
    ts: "2026-08-19T10:00:00.000Z",
    type: "message",
    prev_hash: "prevlink",
    envelope: { message_id: "msg_secret01", body: [{ type: "text", text: "a private key" }] },
  } as Record<string, unknown>;
  const preRedactionLink = linkOf(original).hash;

  const redacted = {
    ...original,
    envelope: { message_id: "msg_secret01", body: [] },
    redacted: true,
    content_hash: preRedactionLink,
  } as Record<string, unknown>;

  const link = linkOf(redacted);
  assert.equal(link.source, "content_hash", "one hash function, one canonicalization, not two");
  assert.equal(link.hash, preRedactionLink);

  const next = { seq: 5, ts: "2026-08-19T10:00:01.000Z", type: "system", event: "z", prev_hash: preRedactionLink };
  const res = verifyChain([redacted, next] as Record<string, unknown>[]);
  assert.equal(res.ok, true, "the chain survives a legitimate redaction");
  assert.equal(res.stampedLinks, 1, "and says so, rather than hiding that a link came from a stamp");

  // A redaction whose content_hash was itself forged does NOT verify.
  const forged = { ...redacted, content_hash: sha256hex("something else") };
  assert.equal(verifyChain([forged, next] as Record<string, unknown>[]).ok, false);
});

test("a per-reader redaction verifies through content_hash WITHOUT `redacted`", () => {
  // Wire 10.3 item 7 as amended 2026-08-28. The hub rewrites a task event's grant
  // keys for ONE reader, so the served event no longer canonicalizes to the form
  // the hub hashed, and it stamps the appended form's hash. It does NOT set
  // `redacted`, because nothing was removed from the record: 12.1's flag means
  // content is gone from every future read, and this reader's copy is a
  // projection. `linkOf` therefore tests the FIELD, not the flag - it tested the
  // pair until this amendment, which would have rejected the stamp sitting right
  // there.
  const appended = {
    seq: 11,
    ts: "2026-08-28T10:00:00.000Z",
    type: "task",
    prev_hash: "prevlink",
    action: "claim",
    actor: "m_local",
    task: { id: "t_1", room: "r_1", resource_grants: [{ keys: ["local/pm-agent/ledger", "room/r_1/ledger"] }] },
  } as Record<string, unknown>;
  const appendedLink = sha256hex(canonicalize(appended));

  const asServedToGuest = {
    ...appended,
    task: { id: "t_1", room: "r_1", resource_grants: [{ keys: [`hmac-sha256:${"ab".repeat(32)}`, "room/r_1/ledger"] }] },
    content_hash: appendedLink,
  } as Record<string, unknown>;
  assert.equal(asServedToGuest.redacted, undefined, "no content was removed, so nothing claims it was");

  const link = linkOf(asServedToGuest);
  assert.equal(link.source, "content_hash");
  assert.equal(link.hash, appendedLink);
  assert.notEqual(sha256hex(canonicalize(hashedForm(asServedToGuest))), appendedLink, "recomputing over the served form gives the WRONG link, which is the whole reason for the stamp");

  const next = { seq: 12, ts: "2026-08-28T10:00:01.000Z", type: "system", event: "z", prev_hash: appendedLink };
  assert.equal(verifyChain([asServedToGuest, next] as Record<string, unknown>[]).ok, true, "a guest verifies the segment it received");

  // Without the stamp the same segment breaks: the assertion above is not vacuous.
  const { content_hash: _c, ...unstamped } = asServedToGuest;
  assert.equal(verifyChain([unstamped, next] as Record<string, unknown>[]).ok, false);

  // And an UNTOUCHED task event verifies by plain recomputation, with no stamp:
  // the hub stamps what it changed and nothing else.
  const untouched = { seq: 13, ts: "2026-08-28T10:00:02.000Z", type: "task", prev_hash: appendedLink, action: "create", actor: "m_local", task: { id: "t_2", room: "r_1" } } as Record<string, unknown>;
  assert.equal(linkOf(untouched).source, "computed");
  const after = { seq: 14, ts: "2026-08-28T10:00:03.000Z", type: "system", event: "y", prev_hash: sha256hex(canonicalize(untouched)) };
  assert.equal(verifyChain([asServedToGuest, untouched, after] as Record<string, unknown>[]).ok, true);
});

test("the scope qualifier says what the chain is NOT worth", () => {
  // Wire sect. 13 requires this wherever the chain is offered as evidence and
  // forbids describing it to a counterparty as protection against the hub. It lives
  // in the library so no surface can quietly drop it.
  assert.match(CHAIN_SCOPE_QUALIFIER, /no party OTHER THAN THE HUB/);
  assert.match(CHAIN_SCOPE_QUALIFIER, /not evidence against the operator/i);
  assert.match(CHAIN_SCOPE_QUALIFIER, /MUST NOT be offered to a counterparty/);
});
