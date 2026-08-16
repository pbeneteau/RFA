/**
 * Generic resident runner (RFA v0.4 spec section 4): loads an agent pack,
 * joins/resumes its bound room, and serves questions with a Claude Agent SDK
 * brain. Replaces the per-agent scripts (dogfood/pm-agent.ts).
 *
 *   npx tsx src/resident.ts --agent pm-agent
 *   RFA_HUB_URL=http://localhost:8790/mcp    hub endpoint
 *
 * v0.4.0 scope: SDK brain with per-conversation session resume (the knowledge
 * pack is consulted via Read/Grep tools, never prompt-stuffed), card + digest
 * derived from agent.md (a definition edit rotates the roster digest), cost
 * and usage recorded into every answer, MemoryGate on inbound messages, and a
 * heartbeat file the supervisor watches (the lease proxy: written by the same
 * loop that renews the presence lease).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { deriveCard, knowledgeFiles, loadPack, type AgentPack } from "./agentdef.js";
import { MemoryGate, RoomMember, type ServeContext } from "./client.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const HUB = process.env.RFA_HUB_URL ?? "http://localhost:8790/mcp";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const agentName = arg("--agent");
if (!agentName) {
  console.error("usage: resident --agent <name>  (a directory under agents/)");
  process.exit(2);
}
const pack: AgentPack = loadPack(path.join(ROOT, "agents", agentName));
const STATE_DIR = path.join(pack.dir, "state");
const STATE_FILE = path.join(STATE_DIR, "member.json");
const HEARTBEAT = path.join(STATE_DIR, "heartbeat");
const LEGACY_STATE = path.join(ROOT, "dogfood", "state", "pm-agent.json");
const ROOM_MD = path.join(ROOT, "dogfood", "ROOM.md");

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), `[${pack.name}]`, ...a);

// ---------------------------------------------------------------- state

interface SavedState {
  room: string;
  join_secret: string | null;
  membership_token: string;
  member_id: string;
  name: string;
  cursor: number;
  definition_hash?: string;
  /** conversation id -> Agent SDK session id (resume keys). */
  sessions?: Record<string, string>;
  /** running spend for the budget day (lagged enforcement). */
  spend?: { day: string; usd: number };
}

function readState(): SavedState | null {
  for (const file of [STATE_FILE, LEGACY_STATE]) {
    if (fs.existsSync(file)) {
      const s = JSON.parse(fs.readFileSync(file, "utf8")) as SavedState;
      if (file === LEGACY_STATE) log(`migrating legacy state from ${path.relative(ROOT, file)}`);
      return s;
    }
  }
  return null;
}

function writeState(s: SavedState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------- brain

const sessions = new Map<string, string>(); // conversation -> sdk session id
let spend = { day: new Date().toISOString().slice(0, 10), usd: 0 };

/** First heading (or first line) of a knowledge file: the retrieval hint. */
function fileHint(f: string): string {
  const head = fs.readFileSync(f, "utf8").slice(0, 2000);
  const line = head.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.replace(/^#+\s*/, "").trim().slice(0, 90);
}

function systemPrompt(): string {
  const files = knowledgeFiles(pack)
    .map((f) => `- ${path.relative(ROOT, f)} :: ${fileHint(f)}`)
    .join("\n");
  return (
    `${pack.prompt}\n\nKnowledge files (repo-relative; consult with Read/Grep/Glob). ` +
    `The text after :: says what each file contains; pick by content, and for questions about ` +
    `amounts, fees, or minimums, Grep the keyword across ALL knowledge files and answer with the ` +
    `numeric fact from the product files, not a glossary definition:\n${files}`
  );
}

async function answer(ctx: ServeContext): Promise<{ text: string; costUsd: number; numTurns: number }> {
  const budgets = pack.def.budgets ?? {};
  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) spend = { day: today, usd: 0 };
  if (budgets.per_day_usd && spend.usd >= budgets.per_day_usd) {
    throw Object.assign(new Error(`daily budget exhausted (spend=${spend.usd.toFixed(2)} budget=${budgets.per_day_usd})`), {
      refusal: { reason: "overloaded", detail: `daily budget exhausted; retry tomorrow`, retry_after_s: 3600 },
    });
  }
  const convo = ctx.conversationId ?? "adhoc";
  const q = query({
    prompt: ctx.wrapped,
    options: {
      cwd: ROOT,
      model: pack.def.model,
      ...(pack.def.effort ? { effort: pack.def.effort } : {}),
      systemPrompt: systemPrompt(),
      settingSources: [],
      allowedTools: pack.def.tools?.allow ?? [],
      disallowedTools: pack.def.tools?.deny,
      permissionMode: (pack.def.sandbox?.permission_mode ?? "default") as "default",
      maxTurns: budgets.max_turns ?? 10,
      ...(budgets.per_task_usd ? { maxBudgetUsd: budgets.per_task_usd } : {}),
      ...(sessions.has(convo) ? { resume: sessions.get(convo) } : {}),
    },
  });
  let text = "";
  let costUsd = 0;
  let numTurns = 0;
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessions.set(convo, msg.session_id);
    } else if (msg.type === "result") {
      if (msg.subtype !== "success" || msg.is_error) {
        throw new Error(`brain error: ${msg.subtype}${"result" in msg ? `: ${String(msg.result).slice(0, 200)}` : ""}`);
      }
      text = msg.result.trim();
      costUsd = msg.total_cost_usd ?? 0;
      numTurns = msg.num_turns ?? 0;
    }
  }
  if (!text) throw new Error("brain returned an empty result");
  spend.usd += costUsd;
  return { text, costUsd, numTurns };
}

// ---------------------------------------------------------------- lifecycle

function writeRoomMd(m: RoomMember, joinSecret: string | null): void {
  if (pack.name !== "pm-agent") return; // the standing-room doc is pm-agent's
  fs.writeFileSync(
    ROOM_MD,
    [
      `# Standing product room (dogfood)`,
      ``,
      `- Hub: \`${HUB}\``,
      `- Room: \`${m.room}\``,
      `- Join secret: \`${joinSecret}\``,
      `- Resident: **${m.name}** (\`${m.memberId}\`), skill \`answer-product-question\`, definition \`${pack.definitionHash.slice(0, 15)}\``,
      `- Knowledge: ${knowledgeFiles(pack).map((f) => `\`${path.relative(ROOT, f)}\``).join(", ")}`,
      ``,
      `## Ask it something from any Claude Code session`,
      ``,
      `The short way (or use the /ask-pm command):`,
      ``,
      "```",
      `Read dogfood/ROOM.md, join the room as dev-agent, and ask the PM agent:`,
      `how do presence leases work?`,
      "```",
      ``,
      `Watch live: \`npm run tail -- data/rooms/${m.room}.ndjson --follow\``,
      `- Watch in the browser: \`http://localhost:8790/console#${m.room}\` (observer with the secret above; supervisor with the human key in \`dogfood/state/human-key.txt\`)`,
    ].join("\n"),
  );
}

async function boot(): Promise<{ member: RoomMember; joinSecret: string | null; prevHash: string | null }> {
  const binding = (pack.def.rooms ?? []).find((r) => r.serve) ?? pack.def.rooms?.[0];
  const card = deriveCard(pack);
  const saved = readState();
  if (saved && binding?.auto_resume !== false) {
    try {
      const member = await RoomMember.resume({
        hubUrl: HUB,
        room: saved.room,
        membershipToken: saved.membership_token,
        memberId: saved.member_id,
        name: saved.name,
        cursor: saved.cursor,
        joinSecret: saved.join_secret,
        clientInfo: { name: `rfa-resident-${pack.name}`, version: "0.4.0" },
      });
      for (const [k, v] of Object.entries(saved.sessions ?? {})) sessions.set(k, v);
      if (saved.spend?.day === new Date().toISOString().slice(0, 10)) spend = saved.spend;
      // Re-present the derived card: a definition change rotates the digest here.
      await member.setPresence("ready", { card });
      log(`resumed room ${member.room} as ${member.name} (${member.memberId}), epoch ${member.epoch}`);
      return { member, joinSecret: saved.join_secret, prevHash: saved.definition_hash ?? null };
    } catch (err) {
      log(`saved membership unusable (${(err as Error).message}); starting fresh`);
    }
  }
  const member = await RoomMember.create({
    hubUrl: HUB,
    name: pack.def.name,
    card,
    ...(binding?.room
      ? { room: binding.room, joinSecret: process.env.RFA_JOIN_SECRET }
      : { topic: binding?.topic ?? `${pack.def.name} standing room` }),
    role: binding?.role ?? "participant",
    clientInfo: { name: `rfa-resident-${pack.name}`, version: "0.4.0" },
  });
  log(`joined room ${member.room}${member.joinSecret ? ` (join_secret ${member.joinSecret})` : ""}`);
  return { member, joinSecret: member.joinSecret, prevHash: null };
}

// ---------------------------------------------------------------- main

const gate = new MemoryGate();
const { member, joinSecret, prevHash } = await boot();
const save = () =>
  writeState({
    room: member.room,
    join_secret: joinSecret,
    membership_token: member.membershipToken,
    member_id: member.memberId,
    name: member.name,
    cursor: member.cursor,
    definition_hash: pack.definitionHash,
    sessions: Object.fromEntries(sessions),
    spend,
  });
save();
writeRoomMd(member, joinSecret);
log(`definition ${pack.definitionHash.slice(0, 15)} (model ${pack.def.model ?? "inherit"}); knowledge: ${knowledgeFiles(pack).length} files`);

// A definition change since the last run is a deploy: announce the digest rotation.
if (prevHash && prevHash !== pack.definitionHash) {
  await member.send({
    body: `definition updated: ${prevHash.slice(0, 15)} -> ${pack.definitionHash.slice(0, 15)} (card digest rotated; re-describe if you pinned it)`,
    kind: "status",
  });
  log("announced definition change in the room");
}

let answered = 0;
process.on("SIGINT", () => {
  log(`shutting down after ${answered} answers`);
  save();
  process.exit(0);
});
process.on("SIGTERM", () => {
  log("SIGTERM: draining");
  save();
  process.exit(0);
});

await member.serve(
  async (ctx) => {
    const verdict = gate.inspect(ctx.envelope);
    if (!verdict.ok) log(`memory gate: near-duplicate from ${ctx.from.name} (${Math.round(verdict.similarity * 100)}%); answering but not remembering`);
    log(`Q from ${ctx.from.name} (seq ${ctx.envelope.seq}): ${ctx.text.slice(0, 100)}`);
    const { text, costUsd, numTurns } = await answer(ctx);
    answered++;
    log(`A sent (${text.length} chars, $${costUsd.toFixed(4)}, ${numTurns} turns): ${text.slice(0, 100)}`);
    return [
      { type: "text", text },
      {
        type: "json",
        value: {
          answered_by: member.name,
          definition: pack.definitionHash.slice(0, 15),
          cost_usd: Number(costUsd.toFixed(4)),
          num_turns: numTurns,
          day_spend_usd: Number(spend.usd.toFixed(4)),
        },
      },
    ];
  },
  {
    onCycle: () => {
      save();
      fs.writeFileSync(HEARTBEAT, String(Date.now()));
    },
    onError: (err) => log(`serve error: ${err.message}`),
  },
);
log("room ended; exiting");
