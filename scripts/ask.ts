/**
 * The CLI channel (RFA v0.4 spec 3.10): ask a resident from the terminal, as
 * a HUMAN principal (requests carry origin: human).
 *
 *   npm run ask -- "your question"                        (waits 30 min: --timeout in seconds)
 *   npm run ask -- --capability draft-linear-document "draft an expression de besoin from: ..."
 *   npm run ask -- --room r_xxx "..."       (default: the standing room from dogfood/ROOM.md)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RoomMember } from "../src/client.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1]?.startsWith("--") !== true);
const question = positional.join(" ").trim();
if (!question) {
  console.error('usage: npm run ask -- [--capability answer-product-question] [--room r_x] [--timeout 1800] "question"');
  process.exit(2);
}
/**
 * Which capability to ask for.
 *
 * `--capability` when you know it. Otherwise: the roster's SOLE capability if there
 * is exactly one, and only then the historical default. A fresh environment used to
 * fail here for a reason that had nothing to do with the operator: `new-agent`
 * scaffolds a pack offering `answer-question` while this tool defaulted to
 * `answer-product-question`, so the first ask against a correctly configured setup
 * reported "nobody offers answer-product-question" and listed an agent that plainly
 * could have answered.
 */
type RosterEntry = { id: string; name: string; role: string; state: string; card_summary: { skill_ids: string[] } };

/**
 * Members this CLI could actually get an answer from: other participants whose
 * lease has not expired. The raw roster snapshot includes this CLI's OWN
 * just-created membership and present-but-offline members, which had two costs:
 * the sole-capability rule below was unreachable (offered always contained our
 * own `operate`), and the target find could pick an offline member and burn the
 * whole ask timeout against someone who will never answer (both 2026-08-21).
 */
function answerers(roster: RosterEntry[], selfId: string): RosterEntry[] {
  return roster.filter((r) => r.id !== selfId && r.role === "participant" && r.state !== "offline");
}

function chooseCapability(roster: RosterEntry[], selfId: string): string {
  const explicit = flag("--capability");
  if (explicit) return explicit;
  const offered = [...new Set(answerers(roster, selfId).flatMap((r) => r.card_summary.skill_ids))];
  // ROOM.md records the room-creating resident's actual first offer, so on the
  // STANDING room the default ask goes to the agent that publishes the room; a
  // --room override targets a different room the hint knows nothing about.
  const hinted = flag("--room") ? undefined : /skill `([^`]+)`/.exec(roomMd)?.[1];
  if (hinted && offered.includes(hinted)) return hinted;
  if (offered.length === 1) return offered[0];
  return "answer-product-question";
}
// 30 minutes (spec 16.1): the asker's deadline governs the resident's approval
// window, so this is what buys "I stepped away". One clock, not two: reply_by
// equals the wait below, so the card dies a margin before the asker gives up.
const timeoutS = Number(flag("--timeout") ?? 1800);

const roomMd = readRoomMd(ROOT);
const room = flag("--room") ?? /Room: `(r_\w+)`/.exec(roomMd)![1];
const secret = /Join secret: `([^`]+)`/.exec(roomMd)![1];
// A hub configured with --mcp-token refuses an unauthenticated /mcp call, so
// resolve the transport credential before the client reads the environment.
// Keeps `npm run ask` working on an authenticated hub with nothing exported.
const { transportToken } = await import("../src/secrets.js");

/**
 * The standing room's join info, or a readable failure.
 *
 * `dogfood/ROOM.md` is gitignored (it holds a join secret), so in a fresh checkout it
 * does not exist and a bare readFileSync here died with an unhandled ENOENT stack
 * trace: the wrong first experience for a tool an operator has just cloned.
 */
function readRoomMd(root: string): string {
  const file = path.join(root, "dogfood", "ROOM.md");
  if (!fs.existsSync(file)) {
    console.error(
      `no dogfood/ROOM.md, so there is no room to talk to yet.\n` +
        `  New checkout?  npm run init        then start the hub and the supervisor\n` +
        `  Already set up? the first resident with no \`rooms:\` binding writes this file when it creates the room;\n` +
        `                  check dogfood/state/*.log, or pass --room <handle> explicitly.`,
    );
    process.exit(2);
  }
  return fs.readFileSync(file, "utf8");
}
const tok = transportToken(path.join(ROOT, "data", "secrets.json"));
if (tok && !process.env.RFA_TOKEN) process.env.RFA_TOKEN = tok;

const humanKeyFile = path.join(ROOT, "dogfood", "state", "human-key.txt");
const humanKey = fs.existsSync(humanKeyFile) ? fs.readFileSync(humanKeyFile, "utf8").trim() : undefined;

const me = await RoomMember.create({
  hubUrl: process.env.RFA_HUB_URL ?? "http://localhost:8790/mcp",
  room,
  joinSecret: secret,
  name: "paul-cli",
  humanKey,
  card: { name: "paul-cli", description: "the operator, from the terminal", skills: [{ id: "operate", description: "asks and decides" }] },
});
try {
  const capability = chooseCapability(me.roster, me.memberId);
  const eligible = answerers(me.roster, me.memberId).filter((r) => r.card_summary.skill_ids.includes(capability));
  // A ready member beats one that is busy or away; offline is already excluded.
  const target = eligible.find((r) => r.state === "ready") ?? eligible[0];
  if (!target) {
    console.error(`nobody in ${room} offers "${capability}". Roster: ${me.roster.map((r) => `${r.name} [${r.card_summary.skill_ids.join(",")}]`).join(" · ")}`);
    process.exit(1);
  }
  console.error(`asking ${target.name} (${capability}, ${target.state})...`);
  const t0 = Date.now();
  const a = await me.ask(target.id, question, { timeoutMs: timeoutS * 1000 });
  const meta = a.parts.find((p) => p.type === "json")?.value as { cost_usd?: number; run_id?: string } | undefined;
  console.log(a.text);
  console.error(
    `\n[${a.kind}${a.refusal ? `: ${a.refusal.reason}` : ""} · ${((Date.now() - t0) / 1000).toFixed(1)}s` +
      (meta?.cost_usd != null ? ` · $${meta.cost_usd}` : "") +
      (meta?.run_id ? ` · ${meta.run_id}` : "") +
      `]`,
  );
} finally {
  await me.leave().catch(() => {});
}
