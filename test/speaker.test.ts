/**
 * The speaker membership of an adopted room (a room whose operator joined as a
 * supervisor: wire 12.1 gives that role no voice but inject). `speaker()` must
 * create ONE participant, record it in rooms.json, resume it on the next ask,
 * and replace + re-record it after an evict — proven against a real hub,
 * because resume-versus-join is the hub's word, not this file's. Before the
 * record existed, every `rfa ask` in an adopted room put a join/leave pair in
 * the log and left a roster corpse whenever the CLI died mid-ask.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { rawCall } from "../src/client.js";
import { speaker } from "../src/cli/commands/talk.js";
import { CliContext } from "../src/cli/context.js";
import { Ui } from "../src/cli/ui.js";
import { loadHubDir, roomsStore, secretsStore, type HubDir } from "../src/hubdir.js";
import { nodeArgsFor } from "../src/proc.js";
import { freePort, ROOT, startHub, stopHub, type TestHub } from "./hubproc.js";

const CLI = path.join(ROOT, "src", "cli", "main.ts");
const info = { name: "speaker-test", version: "0" };

let hub: TestHub;
let dir: string;
let h: HubDir;
let ctx: CliContext;
let host: { id: string; membership_token: string };
let handle: string;
let priorHubUrl: string | undefined;
let priorToken: string | undefined;

before(async () => {
  hub = await startHub();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-speaker-"));
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "init", "--yes", "--no-start", "--agent", "none", "--name", "spk", "--port", String(await freePort()), "--human", "paul"], { cwd: dir, encoding: "utf8", env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" } });
  h = loadHubDir(dir);
  // The test hub knows no principals, so the CLI must not present a human key.
  secretsStore(h).update((s) => {
    delete s.RFA_HUMAN_KEY;
  });
  const created = (await rawCall(hub.mcp, info, "room_create", { topic: "adopted elsewhere", name: "host", card: { name: "host", description: "hosts the room", skills: [{ id: "host", description: "hosts" }] } })) as { room: string; join_secret: string | null; you: { id: string; membership_token: string } };
  handle = created.room;
  host = created.you;
  // Recorded the way a migration leaves a room: known, with no membership that can speak.
  roomsStore(h).update((f) => {
    f.rooms.push({ alias: "adopted", handle, topic: "adopted elsewhere", join_secret: created.join_secret, operator: null, created_at: new Date().toISOString() });
  });
  priorHubUrl = process.env.RFA_HUB_URL;
  priorToken = process.env.RFA_TOKEN;
  process.env.RFA_HUB_URL = hub.mcp;
  ctx = new CliContext({ dir, json: false, yes: true, quiet: true, debug: false }, new Ui({ color: false, json: false, quiet: true, tty: false }));
});

after(async () => {
  if (priorHubUrl === undefined) delete process.env.RFA_HUB_URL;
  else process.env.RFA_HUB_URL = priorHubUrl;
  if (priorToken === undefined) delete process.env.RFA_TOKEN;
  else process.env.RFA_TOKEN = priorToken;
  await stopHub(hub);
  fs.rmSync(dir, { recursive: true, force: true });
});

const rec = () => roomsStore(h).read().rooms.find((r) => r.handle === handle)!;
const cliMembers = async () => ((await rawCall(hub.mcp, info, "room_roster", { room: handle, membership_token: host.membership_token })) as { roster: { id: string; name: string }[] }).roster.filter((m) => m.name.endsWith("-cli"));

test("the first ask joins once and records the voice; the second resumes it; an evicted one is replaced and re-recorded", async () => {
  const first = await speaker(ctx, h, rec());
  assert.equal(first.ephemeral, false, "recorded, so no caller leaves it after use");
  assert.equal(first.me.name, "paul-cli");
  assert.equal(rec().speaker?.member_id, first.me.memberId, "rooms.json carries the voice now");

  const second = await speaker(ctx, h, rec());
  assert.equal(second.me.memberId, first.me.memberId, "resumed, not rejoined");
  assert.equal((await cliMembers()).length, 1, "one member in the roster, not one per question");

  await rawCall(hub.mcp, info, "room_admin", { room: handle, membership_token: host.membership_token, verb: "evict", target: first.me.memberId, reason: "test evict" });
  const third = await speaker(ctx, h, rec());
  assert.equal(third.ephemeral, false);
  assert.notEqual(third.me.memberId, first.me.memberId, "a revoked membership is replaced, never fought over");
  assert.equal(rec().speaker?.member_id, third.me.memberId, "and the record follows the replacement");
});
