/** v0.6.3a durability: the room store must survive a torn snapshot, a restart, and a race for the lock. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RoomHub } from "../src/store.js";
import type { AgentCard } from "../src/model.js";

const card = (name: string): AgentCard => ({
  name,
  description: `${name} does things.`,
  skills: [{ id: `${name}-skill`, description: `${name}'s skill.` }],
});

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "rfa-durability-"));

test("a torn snapshot rebuilds the room from its log instead of losing it", async () => {
  const dir = tmpdir();
  let hub = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  const host = hub.createRoom({ topic: "durable", name: "host", card: card("host") });
  const tok = host.contract.you.membership_token;
  await hub.task({ room: host.room, membership_token: tok, action: "create", title: "survive a crash" });
  await hub.send({ room: host.room, membership_token: tok, message_id: "msg_1", body: [{ type: "text", text: "before the crash" }] });
  hub.close();

  // A crash mid-write leaves half a snapshot and a whole log.
  const meta = path.join(dir, "rooms", `${host.room}.meta.json`);
  const whole = fs.readFileSync(meta, "utf8");
  fs.writeFileSync(meta, whole.slice(0, Math.floor(whole.length / 2)));

  hub = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  const rejoined = hub.join({ room: host.room, name: "host2", card: card("host2") });
  const listed = (await hub.task({ room: host.room, membership_token: rejoined.you.membership_token, action: "list" })) as {
    tasks: { title: string }[];
  };
  assert.equal(listed.tasks.length, 1, "the task board came back from the log");
  assert.equal(listed.tasks[0].title, "survive a crash");
  const events = (await hub.listen({
    room: host.room, membership_token: rejoined.you.membership_token, since: 0, timeout_ms: 0, wait_for: "all",
  })) as { events: { type: string }[] };
  assert.ok(events.events.some((e) => e.type === "message"), "the history came back too");
  // The snapshot was rewritten, so the next boot is clean.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(meta, "utf8")), "a healthy snapshot was written back");
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("send idempotency survives a restart: a replayed message_id does not double-append", async () => {
  const dir = tmpdir();
  let hub = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  const host = hub.createRoom({ topic: "idem", name: "host", card: card("host") });
  const tok = host.contract.you.membership_token;
  const first = await hub.send({
    room: host.room, membership_token: tok, message_id: "msg_only_once", body: [{ type: "text", text: "exactly once please" }],
  });
  hub.close();

  hub = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  const again = await hub.send({
    room: host.room, membership_token: tok, message_id: "msg_only_once", body: [{ type: "text", text: "exactly once please" }],
  });
  assert.equal(again.seq, first.seq, "the replay answers with the original seq");
  assert.equal(again.replayed, true, "and says so, because it cannot report the original dispositions");
  assert.deepEqual(again.recipients, [], "dispositions are never fabricated to fill the shape");
  const events = (await hub.listen({ room: host.room, membership_token: tok, since: 0, timeout_ms: 0, wait_for: "all" })) as {
    events: { type: string }[];
  };
  assert.equal(events.events.filter((e) => e.type === "message").length, 1, "one message on the log, not two");
  hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the store lock is exclusive, and an abandoned lock is taken over", () => {
  const dir = tmpdir();
  const hub = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  assert.throws(
    () => new RoomHub({ dataDir: dir, sweepIntervalMs: 0 }),
    /already owned by a live rfa-hub/,
    "a second hub on the same data dir fails loudly rather than interleaving writes",
  );
  hub.close();

  // A hub that died leaves a lock with an old heartbeat. Liveness is judged on
  // that, not on a PID, which means nothing across containers.
  fs.writeFileSync(
    path.join(dir, ".hub.lock"),
    JSON.stringify({ pid: 999999, nonce: "a-dead-hub", heartbeat: Date.now() - 3600_000 }),
  );
  const revived = new RoomHub({ dataDir: dir, sweepIntervalMs: 0 });
  revived.close();

  // A lock whose heartbeat is current belongs to someone alive, even if the
  // PID is meaningless here.
  fs.writeFileSync(
    path.join(dir, ".hub.lock"),
    JSON.stringify({ pid: 999999, nonce: "a-live-hub-elsewhere", heartbeat: Date.now() }),
  );
  assert.throws(() => new RoomHub({ dataDir: dir, sweepIntervalMs: 0 }), /already owned/);
  fs.rmSync(dir, { recursive: true, force: true });
});
