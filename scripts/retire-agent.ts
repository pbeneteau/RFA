/**
 * Retire a resident agent (RFA v0.5 spec 18.7). A SCRIPT and not a runbook
 * checklist, because the documented failure mode of the checklist is that under
 * time pressure step 1 happens and nothing else does: the resident is stopped,
 * its sidekick keeps a membership in the roster, its card digest still answers
 * `agent_describe`, and its memory sits unarchived until someone deletes the
 * directory by hand.
 *
 *   npx tsx scripts/retire-agent.ts <agent-name> [--dry-run] [--timeout 60]
 *
 * Every step prints, and every step is re-runnable: a partial failure is fixed
 * by running the script again, not by finishing it by hand.
 *
 * Kept on purpose: the observability rows in `data/obs.db`. They carry the human
 * feedback that judges and evals are trained against, and that feedback is the
 * scarcest thing in the ledger; retention prunes it on its own schedule.
 *
 * Secrets: there is nothing to revoke here. The supervisor injects only the
 * NAMES a definition declares (spec 6.3), so moving the definition aside already
 * ends injection; dropping the names from `data/secrets.json` afterwards is
 * hygiene, not control.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { AccountLedger } from "../src/account.js";
import { RoomMember } from "../src/client.js";
import type { AgentCard } from "../src/model.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const HUB = process.env.RFA_HUB_URL ?? "http://localhost:8790/mcp";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const name = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const timeoutS = Number(flag("--timeout") ?? 60);
const stopTimeoutMs = (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : 60) * 1_000;
// An explicit name, always: a retire script that can default is a retire script
// that eventually retires the wrong agent.
if (!name || name.startsWith("--")) {
  console.error("usage: npx tsx scripts/retire-agent.ts <agent-name> [--dry-run] [--timeout 60]");
  console.error("  the agent name is required and is never inferred");
  process.exit(2);
}

const packDir = path.join(ROOT, "agents", name);
const defFile = path.join(packDir, "agent.md");
const stateFile = path.join(packDir, "state", "member.json");
const memoryDb = path.join(packDir, "state", "memory.db");
const cmdFile = path.join(ROOT, "data", "supervisor-commands.ndjson");
const supStateFile = path.join(ROOT, "data", "supervisor-state.json");
const humanKeyFile = path.join(ROOT, "dogfood", "state", "human-key.txt");
const roomsDir = path.join(ROOT, "data", "rooms");
const archive = path.join(ROOT, "data", "retired", `${name}-${new Date().toISOString().slice(0, 10)}`);

if (!fs.existsSync(packDir)) {
  console.error(`no pack directory ${path.relative(ROOT, packDir)}: nothing to retire (name is case-sensitive)`);
  process.exit(1);
}

let step = 0;
const say = (msg: string) => console.log(`${++step}. ${msg}`);
const note = (msg: string) => console.log(`   ${msg}`);
const would = (msg: string) => console.log(`   [dry-run] would ${msg}`);

console.log(`retiring ${name}${dryRun ? " (DRY RUN: nothing is changed)" : ""}`);
console.log(`archive: ${path.relative(ROOT, archive)}`);

// ---------------------------------------------------------------- 1. stop the resident

interface SupervisorState {
  agents: Record<string, { pid: number | null; status: string }>;
}
/**
 * The supervisor writes this file non-atomically, so a torn read is possible and
 * says NOTHING about the resident: it must never be mistaken for "stopped".
 */
function readSupState(): SupervisorState | null {
  if (!fs.existsSync(supStateFile)) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(fs.readFileSync(supStateFile, "utf8")) as SupervisorState;
    } catch {
      /* retry: mid-write */
    }
  }
  return { agents: { [name]: { pid: -1, status: "unreadable supervisor state" } } };
}
const stoppedIn = (s: SupervisorState | null): boolean => {
  const entry = s?.agents?.[name];
  return !entry || entry.pid === null;
};

/** The heartbeat catches a resident started by hand, which no supervisor state knows about. */
function heartbeatAgeMs(): number | null {
  const hb = path.join(packDir, "state", "heartbeat");
  if (!fs.existsSync(hb)) return null;
  const ts = Number(fs.readFileSync(hb, "utf8"));
  return Number.isFinite(ts) ? Date.now() - ts : null;
}

say(`stop ${name} through the supervisor command channel`);
const before = readSupState();
if (!before || stoppedIn(before)) {
  const age = heartbeatAgeMs();
  if (age !== null && age < 90_000 && !dryRun) {
    console.error(`   the supervisor does not own a running ${name}, but its heartbeat is ${Math.round(age / 1000)}s old:`);
    console.error(`   something is running this resident outside the supervisor. Stop it, then re-run this script.`);
    process.exit(1);
  }
}
if (!before) {
  note(`no ${path.relative(ROOT, supStateFile)}: no supervisor is running, so no resident is either`);
} else if (stoppedIn(before)) {
  note(`already stopped (${before.agents[name]?.status ?? "not in the registry"})`);
} else if (dryRun) {
  would(`append {action: "stop"} to ${path.relative(ROOT, cmdFile)} and wait for pid ${before.agents[name].pid} to exit`);
} else {
  fs.appendFileSync(cmdFile, JSON.stringify({ ts: new Date().toISOString(), agent: name, action: "stop", principal: "retire-agent" }) + "\n");
  note(`stop queued; waiting up to ${Math.round(stopTimeoutMs / 1000)}s for the supervisor to drain pid ${before.agents[name].pid}`);
  // Watching the state file, not the command file: the command being READ is not
  // the resident being stopped, and a drain takes as long as the turn it interrupts.
  const deadline = Date.now() + stopTimeoutMs;
  let stopped = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    if (stoppedIn(readSupState())) {
      stopped = true;
      break;
    }
  }
  if (!stopped) {
    console.error(`   ${name} is still running after ${Math.round(stopTimeoutMs / 1000)}s. Retirement STOPS here on purpose:`);
    console.error(`   evicting and archiving under a live resident would leave it rejoining and rewriting what we archive.`);
    console.error(`   check the supervisor log, then re-run this script.`);
    process.exit(1);
  }
  note("stopped");
}

// ---------------------------------------------------------------- 2. release its account slots

say("release its account-layer leases (spec 18.6)");
if (dryRun) {
  would("delete any account_leases rows held by this agent");
} else {
  const ledger = new AccountLedger(path.join(ROOT, "data", "runs.db"));
  try {
    note(`released ${ledger.releaseAgent(name)} lease(s)`);
  } finally {
    ledger.close();
  }
}

// ---------------------------------------------------------------- 3. leave its room

interface SavedState {
  room: string;
  join_secret: string | null;
  membership_token: string;
  member_id: string;
  name: string;
}
const saved: SavedState | null = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as SavedState) : null;

say("leave the room with the resident's own membership");
if (!saved) {
  note(`no ${path.relative(ROOT, stateFile)}: never joined, or already retired`);
} else if (dryRun) {
  would(`room_leave ${saved.member_id} from ${saved.room}`);
} else {
  try {
    const me = await RoomMember.resume({
      hubUrl: HUB,
      room: saved.room,
      membershipToken: saved.membership_token,
      memberId: saved.member_id,
      name: saved.name,
      clientInfo: { name: "rfa-retire-agent", version: "0.5.2" },
    });
    await me.leave();
    note(`left ${saved.room} as ${saved.member_id}`);
  } catch (err) {
    // A revoked token or a dead hub is not a reason to abandon the rest: the
    // eviction pass below is what actually guarantees an empty roster.
    note(`could not leave with the saved membership (${(err as Error).message}); the eviction pass handles the remnant`);
  }
}

// ---------------------------------------------------------------- 4. evict every remnant

/** The resident, its approval sidekick, and the hub's suffixed retries of both. */
const REMNANT = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-hitl)?(-\\d+)?$`);

interface RoomMeta {
  handle: string;
  ended: boolean;
  joinSecret: string | null;
  members: { id: string; name: string; present: boolean; isHost: boolean }[];
}

/**
 * Reconnaissance only: `data/rooms` belongs to the hub, and this reads the
 * snapshots to find which live rooms still hold a membership under this name.
 * Every change goes through the hub's own verbs below.
 */
function remnantsByRoom(): Map<string, { meta: RoomMeta; members: RoomMeta["members"] }> {
  const out = new Map<string, { meta: RoomMeta; members: RoomMeta["members"] }>();
  if (!fs.existsSync(roomsDir)) return out;
  for (const file of fs.readdirSync(roomsDir).filter((f) => f.endsWith(".meta.json"))) {
    let meta: RoomMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(roomsDir, file), "utf8")) as RoomMeta;
    } catch {
      continue;
    }
    if (meta.ended) continue;
    const members = (meta.members ?? []).filter((m) => m.present && REMNANT.test(m.name));
    if (members.length > 0) out.set(meta.handle, { meta, members });
  }
  return out;
}

const humanKey = fs.existsSync(humanKeyFile) ? fs.readFileSync(humanKeyFile, "utf8").trim() : undefined;
const operatorCard: AgentCard = { name: "retire-agent", description: `operator tool retiring ${name}` };

say(`evict remnants (${name}, ${name}-hitl, and suffixed retries) with room_admin`);
const remnants = remnantsByRoom();
if (remnants.size === 0) {
  note("no present membership left under that name in any live room");
} else if (!humanKey) {
  console.error(`   ${path.relative(ROOT, humanKeyFile)} is missing: room_admin needs the operator human key (hub --human-key).`);
  console.error(`   remnants left behind: ${[...remnants].map(([r, v]) => `${r}: ${v.members.map((m) => m.name).join(", ")}`).join(" | ")}`);
  process.exit(1);
} else {
  for (const [room, { meta, members }] of remnants) {
    if (dryRun) {
      would(`join ${room} as a human supervisor and evict ${members.map((m) => `${m.name} (${m.id})`).join(", ")}`);
      continue;
    }
    const secret = meta.joinSecret ?? saved?.join_secret ?? process.env.RFA_JOIN_SECRET;
    let operator: RoomMember;
    try {
      operator = await RoomMember.create({
        hubUrl: HUB,
        room,
        joinSecret: secret ?? undefined,
        name: "retire-agent",
        role: "supervisor",
        humanKey,
        card: operatorCard,
        clientInfo: { name: "rfa-retire-agent", version: "0.5.2" },
      });
    } catch (err) {
      note(`${room}: cannot join to evict (${(err as Error).message}); remnants ${members.map((m) => m.name).join(", ")} stay`);
      continue;
    }
    try {
      for (const m of members) {
        try {
          await operator.admin("evict", { target: m.id, reason: `agent ${name} retired` });
          note(`${room}: evicted ${m.name} (${m.id})`);
        } catch (err) {
          // The host of a room cannot be evicted (spec 12): its own room_leave in
          // step 3 is the only exit, so say so instead of failing silently.
          note(`${room}: ${m.name} (${m.id}) NOT evicted: ${(err as Error).message}${m.isHost ? " (it hosts this room; its own leave is the exit)" : ""}`);
        }
      }
    } finally {
      await operator.leave().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- 5. archive the memory

say("archive state/memory.db (archived, never deleted)");
if (!fs.existsSync(memoryDb)) {
  note("no memory.db: nothing to archive");
} else if (dryRun) {
  would(`back up ${path.relative(ROOT, memoryDb)} to ${path.relative(ROOT, path.join(archive, "memory.db"))}`);
} else {
  const dest = path.join(archive, "memory.db");
  if (fs.existsSync(dest)) {
    note(`${path.relative(ROOT, dest)} already exists; keeping the earlier archive`);
  } else {
    fs.mkdirSync(archive, { recursive: true });
    // db.backup(), not copyFile: a WAL database is three files, and a plain copy
    // of the .db alone silently drops everything still in the -wal.
    const db = new Database(memoryDb, { readonly: true });
    try {
      await db.backup(dest);
    } finally {
      db.close();
    }
    note(`archived ${(fs.statSync(dest).size / 1024).toFixed(0)}KB to ${path.relative(ROOT, dest)}`);
  }
}

// ---------------------------------------------------------------- 6. keep the observability rows

say("keep the observability rows in data/obs.db");
const obsDb = path.join(ROOT, "data", "obs.db");
if (!fs.existsSync(obsDb)) {
  note("no obs.db");
} else {
  const db = new Database(obsDb, { readonly: true });
  try {
    const like = `%:${name}`;
    const runs = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE name LIKE ?`).get(like) as { n: number }).n;
    const scored = (
      db
        .prepare(`SELECT COUNT(DISTINCT f.run_id) AS n FROM feedback f JOIN runs r ON r.id = f.run_id WHERE r.name LIKE ?`)
        .get(like) as { n: number }
    ).n;
    note(`${runs} run row(s), ${scored} carrying feedback: KEPT (they are the evidence trail; retention prunes on its own schedule)`);
  } catch (err) {
    note(`could not count obs rows (${(err as Error).message}); nothing was deleted`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 7. move the definition aside

say("move agent.md aside so the card digest leaves every roster");
if (!fs.existsSync(defFile)) {
  note("already moved aside");
} else if (dryRun) {
  would(`rename ${path.relative(ROOT, defFile)} to ${path.relative(ROOT, path.join(archive, "agent.md"))}`);
} else {
  fs.mkdirSync(archive, { recursive: true });
  const dest = path.join(archive, "agent.md");
  fs.renameSync(defFile, dest);
  // listPacks() skips a directory without agent.md, so the supervisor's next
  // reconcile drops the agent from the registry and nothing re-derives the card.
  note(`moved to ${path.relative(ROOT, dest)}; the supervisor drops it from the registry on its next reconcile`);
}

console.log(
  dryRun
    ? `\ndry run complete: nothing changed. Re-run without --dry-run to retire ${name}.`
    : `\n${name} is retired. Its memory and definition are in ${path.relative(ROOT, archive)}; its observability rows and human feedback stay in data/obs.db.\n` +
        `Secrets need no revocation: the supervisor injects only the names a definition declares, so moving the definition ended injection.`,
);
