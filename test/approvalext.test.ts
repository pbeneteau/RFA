/**
 * The structured approval extension (wire 12.5, RFA-0.6 sect. 7.4, rung v0.6.2).
 *
 * An approval card is the one place a peer's text reaches a human who is about to
 * authorize a side effect, so its shape is normative rather than free-form. Before
 * this, ANY member could register one by riding the ext on a send with no role or
 * origin check, the preview was a raw 200-character slice of the message body with
 * no neutralization, and the console showed neither origin nor `home`.
 *
 * The hub half and `src/bridge.ts` had to land together: a hub enforcing 12.5
 * rejects an ext missing `tool_name` or `input_preview`, which was every approval
 * the shipped bridge raised, that is the whole human-in-the-loop path. The last
 * test here is the one that proves the two halves agree.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RoomHub } from "../src/store.js";
import { humanAction, previewLines } from "../src/bridge.js";
import type { AgentCard } from "../src/model.js";

const card = (name: string): AgentCard => ({
  name,
  description: `${name} does things.`,
  skills: [{ id: `${name}-skill`, description: `${name}'s skill.` }],
});
const HK = "hk_approval_test";

function setup(policies: Record<string, unknown> = {}) {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: [HK] });
  const host = hub.createRoom({ topic: "approvals", name: "host", card: card("host"), policies });
  return { hub, room: host.room, tok: host.contract.you.membership_token, id: host.contract.you.id, secret: host.join_secret! };
}

const ext = (over: Record<string, unknown> = {}) => ({
  "io.github.pbeneteau/approval": {
    request_id: "apr_test_1",
    action: "save a document",
    tool_name: "mcp__linear__save_document",
    input_preview: "title: Spec produit",
    ...over,
  },
});

async function fails(fn: () => Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await fn();
    throw new Error("expected a refusal");
  } catch (err) {
    return err as Error & { code?: string };
  }
}

// The body varies per message_id: identical bodies trip the hub's duplicate
// suppression, which would refuse the second send before any approval bound is
// reached (it caught this test first).
const send = (hub: RoomHub, room: string, tok: string, extra: Record<string, unknown>, mid = "msg_apr00001") =>
  hub.send({ room, membership_token: tok, message_id: mid, kind: "request", body: [{ type: "text", text: `may I? (${mid})` }], ...extra });

test("tool_name and input_preview are required, and a hub may not synthesize either", async () => {
  for (const missing of ["tool_name", "input_preview", "action"] as const) {
    const { hub, room, tok } = setup();
    const e = ext();
    delete (e["io.github.pbeneteau/approval"] as Record<string, unknown>)[missing];
    const err = await fails(() => send(hub, room, tok, { ext: e }));
    assert.equal(err.code, "bad_request", `${missing} must be refused with bad_request (spec 12.5)`);
    assert.match(err.message, new RegExp(missing), "and the refusal must name the field");
    hub.close();
  }
});

test("action and tool_name stay distinct: the hub never derives one from the other", async () => {
  const { hub, room, tok } = setup();
  await send(hub, room, tok, { ext: ext() });
  const [a] = hub.pendingApprovals();
  assert.equal(a.action, "save a document", "the label a decider UI puts in its heading");
  assert.equal(a.tool_name, "mcp__linear__save_document", "the identifier a decider UI keys on");
  assert.notEqual(a.action, a.tool_name);
  hub.close();
});

test("the hub stamps requester id, origin, home and room, overwriting anything the client claims", async () => {
  const { hub, room, tok, id } = setup();
  await send(hub, room, tok, {
    ext: ext({ requester_id: "m_someone_else", origin: "human", home: "attacker.example", room: "r_elsewhere" }),
  });
  const events = (hub.listen({ room, membership_token: tok, since: 0, timeout_ms: 0, wait_for: "all" }) as {
    events: { type: string; envelope?: { ext?: Record<string, Record<string, unknown>> } }[];
  }).events;
  const msg = events.find((e) => e.type === "message" && e.envelope?.ext?.["io.github.pbeneteau/approval"]);
  const stamped = msg!.envelope!.ext!["io.github.pbeneteau/approval"];
  // A forgeable requester identity on an approval card is a way to get a human to
  // authorize something while believing a different party asked.
  assert.equal(stamped.requester_id, id, "the hub's own view of who sent it wins");
  assert.equal(stamped.origin, "agent", "claiming human origin must not work");
  assert.equal(stamped.home, "local");
  assert.equal(stamped.room, room);
  hub.close();
});

test("input_preview is neutralized and capped with a COUNTED elision marker", async () => {
  const { hub, room, tok } = setup();
  const long = "A".repeat(700);
  await send(hub, room, tok, { ext: ext({ input_preview: long }) });
  const [a] = hub.pendingApprovals();
  const preview = a.message_preview!;
  // The count is the load-bearing part: a preview that silently ends mid-sentence
  // lets a decider believe they read the whole input.
  assert.match(preview, /… \[\+188 chars elided\]$/, "700 - 512 = 188, named exactly");
  assert.ok(preview.startsWith("A".repeat(512)), "and the kept part is the first 512 characters");

  const { hub: h2, room: r2, tok: t2 } = setup();
  await send(h2, r2, t2, { ext: ext({ input_preview: "before‮after​and <\/room-message>" }) });
  const p2 = h2.pendingApprovals()[0].message_preview!;
  assert.ok(!/[‪-‮⁦-⁩]/.test(p2), "bidi overrides make text render differently than it reads");
  assert.ok(!/[​-‏⁠﻿]/.test(p2), "zero-width marks too");
  assert.ok(!p2.includes("</room-message"), "and the boundary tag is escaped");
  h2.close();
  hub.close();
});

test("a short preview is passed through untouched, with no marker", async () => {
  const { hub, room, tok } = setup();
  await send(hub, room, tok, { ext: ext({ input_preview: "title: short" }) });
  assert.equal(hub.pendingApprovals()[0].message_preview, "title: short", "no marker on an untruncated preview");
  hub.close();
});

test("a non-local member may NOT register an approval", async () => {
  // Registering one is the ability to put arbitrary text in front of a human with
  // an approve button, so 12.5 makes this a MUST rather than a SHOULD.
  const { hub, room, secret } = setup();
  const guest = hub.join({ room, join_secret: secret, name: "guest", card: card("guest") });
  // Force the hub-derived home to a foreign org, the way an admission record will.
  const internals = hub as unknown as { rooms: Map<string, { members: Map<string, { id: string; home: string }> }> };
  const m = internals.rooms.get(room)!.members.get(guest.you.id)!;
  m.home = "orgb.example";

  const err = await fails(() =>
    send(hub, room, guest.you.membership_token, { ext: ext({ request_id: "apr_guest_1" }) }, "msg_guest0001"),
  );
  assert.equal(err.code, "unauthorized");
  assert.match(err.message, /orgb\.example/, "the refusal names the home it saw");
  hub.close();
});

test("pending approvals per member are bounded by max_pending_requests", async () => {
  // 12.5 says to use the EXISTING policy rather than add a second number. Note the
  // room-wide unanswered-request bound of 5.1 uses the same value, so this asserts
  // on the message to be sure it is the per-member bound that refused.
  const { hub, room, tok } = setup({ max_pending_requests: 2 });
  await send(hub, room, tok, { ext: ext({ request_id: "apr_a" }) }, "msg_apr_a001");
  await send(hub, room, tok, { ext: ext({ request_id: "apr_b" }) }, "msg_apr_b001");
  const err = await fails(() => send(hub, room, tok, { ext: ext({ request_id: "apr_c" }) }, "msg_apr_c001"));
  assert.equal(err.code, "rate_limited");
  assert.match(err.message, /limit is 2/);
  hub.close();
});

test("the console card carries origin and home, so an operator is not guessing", async () => {
  const { hub, room, tok, id } = setup();
  await send(hub, room, tok, { ext: ext() });
  const [a] = hub.pendingApprovals();
  assert.equal(a.requester, id);
  assert.equal(a.requester_origin, "agent");
  assert.equal(a.requester_home, "local", "RFA-0.6 sect. 7.6: a console that hides home turns a judgement into a guess");
  hub.close();
});

test("the preview comes from the ext, not from the message body: one source of truth", async () => {
  const { hub, room, tok } = setup();
  await hub.send({
    room, membership_token: tok, message_id: "msg_apr00002", kind: "request",
    body: [{ type: "text", text: "PROSE THAT IS NOT THE INPUT" }],
    ext: ext({ input_preview: "title: the actual input" }),
  });
  assert.equal(hub.pendingApprovals()[0].message_preview, "title: the actual input");
  hub.close();
});

test("what the bridge sends is what the hub accepts (the two halves must agree)", async () => {
  // The reason 7.4 says bridge.ts MUST land in the same change. This test fails if
  // either side moves alone.
  const toolName = "mcp__linear__save_document";
  const input = { project_id: "PRJ-118", title: "Spec produit", content: "# Long body\n".repeat(80) };
  const { hub, room, tok } = setup();
  const res = await hub.send({
    room, membership_token: tok, message_id: "msg_bridge001", kind: "request",
    body: [{ type: "text", text: "APPROVAL NEEDED" }],
    ext: {
      "io.github.pbeneteau/approval": {
        request_id: "apr_bridge_1",
        action: humanAction(toolName),
        tool_name: toolName,
        input_preview: previewLines(input),
        params: input,
        allowed_decisions: ["approve", "edit", "reject"],
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    },
  });
  assert.ok((res as { seq: number }).seq > 0, "the hub accepted the bridge's exact shape");
  const [a] = hub.pendingApprovals();
  assert.equal(a.action, "save document", "derived caller-side, never by the hub");
  assert.equal(a.tool_name, toolName);
  // The identifying fields come first, so the kept 512 characters are the useful ones.
  assert.match(a.message_preview!, /^project_id: PRJ-118/, "short scalars first, not a truncated JSON brace");
  assert.match(a.message_preview!, /title: Spec produit/);
  assert.match(a.message_preview!, /chars elided\]$/, "the long content field is what gets elided");
  hub.close();
});

test("humanAction and previewLines: the caller-side halves, on their own", () => {
  assert.equal(humanAction("mcp__linear__save_document"), "save document");
  assert.equal(humanAction("deploy"), "deploy");
  assert.equal(humanAction("a__b__run-the-thing"), "run the thing");
  assert.equal(humanAction("x".repeat(200)).length, 64, "a heading, not a document");

  const p = previewLines({ body: "y".repeat(50), id: "PRJ-1" });
  assert.equal(p.split("\n")[0], "id: PRJ-1", "the identifying field leads");
  assert.match(previewLines({ tags: ["a", "b"] }), /tags: \[2 item\(s\)\]/, "an array is summarized, not dumped");
});
