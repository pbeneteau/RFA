/**
 * The CLI channel (RFA v0.4 spec 3.10): ask a resident from the terminal, as
 * a HUMAN principal (requests carry origin: human).
 *
 *   npm run ask -- "your question"
 *   npm run ask -- --capability draft-linear-document --timeout 300 "draft an expression de besoin from: ..."
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
  console.error('usage: npm run ask -- [--capability answer-product-question] [--room r_x] [--timeout 180] "question"');
  process.exit(2);
}
const capability = flag("--capability") ?? "answer-product-question";
const timeoutS = Number(flag("--timeout") ?? 180);

const roomMd = fs.readFileSync(path.join(ROOT, "dogfood", "ROOM.md"), "utf8");
const room = flag("--room") ?? /Room: `(r_\w+)`/.exec(roomMd)![1];
const secret = /Join secret: `([^`]+)`/.exec(roomMd)![1];
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
