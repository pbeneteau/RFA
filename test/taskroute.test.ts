/**
 * `rfa task create --capability`: the board assigned by what a member offers,
 * not by its name — the same resolve-at-create-time rule `rfa ask` uses (ready
 * first, among present participants). Against a real hub, because who is
 * present and ready is the hub's word.
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
const info = { name: "taskroute-test", version: "0" };

let hub: TestHub;
let dir: string;
let h: HubDir;
let handle: string;
let worker: { id: string };

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

before(async () => {
  hub = await startHub();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-taskroute-"));
  const port = await freePort();
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "init", "--yes", "--no-start", "--agent", "none", "--name", "route", "--port", String(port), "--human", "paul"], { cwd: dir, encoding: "utf8", env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" } });
  h = loadHubDir(dir);
  const created = (await rawCall(hub.mcp, info, "room_create", { topic: "routing", name: "paul", card: { name: "paul", description: "the operator", skills: [{ id: "operate", description: "decides" }] } })) as {
    room: string;
    join_secret: string | null;
    you: { id: string; membership_token: string; name: string; role: "participant" | "observer" | "supervisor" };
  };
  handle = created.room;
  const joined = (await rawCall(hub.mcp, info, "room_join", { room: handle, join_secret: created.join_secret ?? undefined, name: "scribe", card: { name: "scribe", description: "drafts documents", skills: [{ id: "draft-doc", description: "drafts a document on request" }] } })) as { you: { id: string } };
  worker = joined.you;
  // Recorded the way the CLI records a room it hosts: the operator's own participant membership.
  roomsStore(h).update((f) => {
    f.rooms.push({ alias: "routing", handle, topic: "routing", join_secret: created.join_secret, operator: { member_id: created.you.id, membership_token: created.you.membership_token, name: created.you.name, role: created.you.role, host: true }, created_at: new Date().toISOString() });
  });
});

after(async () => {
  await stopHub(hub);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("--capability resolves to the present offerer at create time and assigns it, never the asker", async () => {
  const r = await rfa(["task", "create", "route me by what you offer", "--room", "routing", "--capability", "draft-doc", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const t = JSON.parse(r.stdout) as { id: string; owner: string | null; state: string };
  assert.equal(t.owner, worker.id, "assigned to the member offering draft-doc, though nobody typed its name");
  assert.equal(t.state, "submitted");

  const miss = await rfa(["task", "create", "nobody does this", "--room", "routing", "--capability", "fold-laundry"]);
  assert.equal(miss.code, 3);
  assert.match(miss.stderr, /nobody in routing offers fold-laundry right now/);
  assert.match(miss.stderr, /offered: draft-doc \(scribe\)/, "and what IS offered is named, so the next try needs no rfa room show");
});
