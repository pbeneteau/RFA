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
const capability = flag("--capability") ?? "answer-product-question";
// 30 minutes (spec 16.1): the asker's deadline governs the resident's approval
// window, so this is what buys "I stepped away". One clock, not two: reply_by
// equals the wait below, so the card dies a margin before the asker gives up.
const timeoutS = Number(flag("--timeout") ?? 1800);

const roomMd = fs.readFileSync(path.join(ROOT, "dogfood", "ROOM.md"), "utf8");
const room = flag("--room") ?? /Room: `(r_\w+)`/.exec(roomMd)![1];
const secret = /Join secret: `([^`]+)`/.exec(roomMd)![1];
// A hub configured with --mcp-token refuses an unauthenticated /mcp call, so
// resolve the transport credential before the client reads the environment.
// Keeps `npm run ask` working on an authenticated hub with nothing exported.
const { transportToken } = await import("../src/secrets.js");
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
  const target = me.roster.find((r) => r.card_summary.skill_ids.includes(capability));
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
