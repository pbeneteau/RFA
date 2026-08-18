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
  // The events came back into the room, but a member that joined AFTER the
  // rebuild does not get to replay them: a rebuilt room defaults to
  // history_visibility "joined_after" and the since clamp enforces it. So the
  // recovery evidence is the log on disk plus the board, not a fresh replay.
  const logged = fs.readFileSync(path.join(dir, "rooms", `${host.room}.ndjson`), "utf8");
  assert.ok(logged.includes("before the crash"), "the log still holds the history");
  const replay = (await hub.listen({
    room: host.room, membership_token: rejoined.you.membership_token, since: 0, timeout_ms: 0, wait_for: "all",
  })) as { events: { type: string }[] };
  assert.ok(
    !replay.events.some((e) => e.type === "message"),
    "and a member who joined after the rebuild cannot replay what was said before it arrived",
  );
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

test("the nightly backup captures commits still living in the WAL file", async () => {
  // The backup used to shell out to the sqlite3 CLI and fall back to a byte
  // copy when it was missing. With WAL enabled a byte copy can miss committed
  // transactions that are still in the -wal file, so the fallback could write a
  // backup that silently lost recent work. This uses the driver's own backup.
  const { default: Database } = await import("better-sqlite3");
  const { runBackup } = await import("../src/platform.js");
  const root = tmpdir();
  const dest = tmpdir();
  const dbPath = path.join(root, "live.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("create table t(x)");
  const ins = db.prepare("insert into t values (?)");
  for (let i = 0; i < 500; i++) ins.run(i);

  const res = await runBackup({ root, dbs: [dbPath], dirs: [], destRoot: dest, keep: 3 });
  const copy = new Database(res.files[0], { readonly: true });
  const { c } = copy.prepare("select count(*) c from t").get() as { c: number };
  assert.equal(c, 500, "every committed row is in the backup, WAL or not");
  db.close();
  copy.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(dest, { recursive: true, force: true });
});
