/**
 * `rfa ask --reply`: the human's side of conversation threading. Residents
 * always kept one brain session per conversation_id; the CLI opened a new
 * conversation on every ask, so the challenge-and-refine loop belonged to
 * agents only. Proven against a real hub with an echoing responder: the
 * second ask must carry the FIRST ask's conversation id, end to end.
 */
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { rawCall } from "../src/client.js";
import { loadHubDir, roomsStore, type HubDir } from "../src/hubdir.js";
import { nodeArgsFor } from "../src/proc.js";
import { freePort, ROOT, startHub, stopHub, type TestHub } from "./hubproc.js";

const CLI = path.join(ROOT, "src", "cli", "main.ts");
const info = { name: "askreply-test", version: "0" };

let hub: TestHub;
let dir: string;
let h: HubDir;
let handle: string;
let worker: { id: string; membership_token: string };
let stopResponder = false;
let responder: Promise<void>;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
function rfa(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...nodeArgsFor(CLI), ...args],
      { cwd: dir, env: { ...process.env, RFA_DIR: "", RFA_HUB_URL: hub.mcp, NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

/** The far side: answers every request with the conversation id it arrived in, so threading is observable in the reply text. */
async function respond(): Promise<void> {
  let since = 0;
  let n = 0;
  while (!stopResponder) {
    try {
      const res = (await rawCall(hub.mcp, info, "room_listen", { room: handle, membership_token: worker.membership_token, since, timeout_ms: 2000 })) as { cursor: number; events: { type: string; envelope?: { kind: string; message_id: string; conversation_id: string | null; mentions?: string[]; from: { id: string } } }[] };
      since = res.cursor;
      for (const e of res.events) {
        if (e.type !== "message" || e.envelope?.kind !== "request" || !e.envelope.mentions?.includes(worker.id)) continue;
        await rawCall(hub.mcp, info, "room_send", {
          room: handle,
          membership_token: worker.membership_token,
          message_id: `msg_echo_${++n}_${Math.random().toString(36).slice(2, 8)}`,
          kind: "response",
          in_reply_to: e.envelope.message_id,
          conversation_id: e.envelope.conversation_id,
          to: [e.envelope.from.id],
          body: [{ type: "text", text: `echo:${e.envelope.conversation_id}` }],
        });
      }
    } catch {
      /* the hub is stopping, or a listen window elapsed: loop decides */
    }
  }
}

before(async () => {
  hub = await startHub();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-askreply-"));
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "init", "--yes", "--no-start", "--agent", "none", "--name", "thread", "--port", String(await freePort()), "--human", "paul"], { cwd: dir, encoding: "utf8", env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" } });
  h = loadHubDir(dir);
  const created = (await rawCall(hub.mcp, info, "room_create", { topic: "threading", name: "paul", card: { name: "paul", description: "the operator", skills: [{ id: "operate", description: "decides" }] } })) as {
    room: string;
    join_secret: string | null;
    you: { id: string; membership_token: string; name: string; role: "participant" | "observer" | "supervisor" };
  };
  handle = created.room;
  const joined = (await rawCall(hub.mcp, info, "room_join", { room: handle, join_secret: created.join_secret ?? undefined, name: "scribe", card: { name: "scribe", description: "echoes", skills: [{ id: "draft-doc", description: "drafts a document" }] } })) as { you: { id: string; membership_token: string } };
  worker = joined.you;
  roomsStore(h).update((f) => {
    f.rooms.push({ alias: "thread", handle, topic: "threading", join_secret: created.join_secret, operator: { member_id: created.you.id, membership_token: created.you.membership_token, name: created.you.name, role: created.you.role, host: true }, created_at: new Date().toISOString() });
  });
  responder = respond();
});

after(async () => {
  // Every step guarded: a failed before() leaves any of these unset, and an
  // after() that throws ahead of stopHub leaves the hub holding the process's
  // event loop open, so the whole suite hangs instead of failing (found
  // 2026-08-25: a missing CLI dependency became a 2.5 hour silent npm test wedge).
  stopResponder = true;
  await responder?.catch(() => {});
  if (hub) await stopHub(hub);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("--reply carries the first ask's conversation to the same responder; --reply with no history is refused", async () => {
  const premature = await rfa(["ask", "too early", "--room", "thread", "--reply"]);
  assert.equal(premature.code, 2);
  assert.match(premature.stderr, /no previous ask recorded in thread/);

  const first = await rfa(["ask", "one", "--room", "thread", "--json"]);
  assert.equal(first.code, 0, first.stderr);
  const a = JSON.parse(first.stdout) as { conversation_id: string | null; text: string; asked: string };
  assert.ok(a.conversation_id, "every answer names the conversation it opened");
  assert.equal(a.text, `echo:${a.conversation_id}`, "the responder saw that same conversation on the wire");
  assert.equal(a.asked, "scribe");

  const second = await rfa(["ask", "two", "--room", "thread", "--reply", "--json"]);
  assert.equal(second.code, 0, second.stderr);
  const b = JSON.parse(second.stdout) as { conversation_id: string | null; text: string };
  assert.equal(b.conversation_id, a.conversation_id, "the reply continued the SAME conversation: the resident would resume its brain session");
  assert.equal(b.text, `echo:${a.conversation_id}`, "and the wire agrees, end to end");

  const saved = JSON.parse(fs.readFileSync(h.paths.lastAsk, "utf8")) as Record<string, { conversation: string; target: string }>;
  assert.equal(saved[handle].conversation, a.conversation_id, "recorded per room, so the next --reply finds it");
  assert.equal(saved[handle].target, "scribe");

  const both = await rfa(["ask", "x", "--room", "thread", "--reply", "--conversation", "c_zzz"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /pass one or the other/);
});
