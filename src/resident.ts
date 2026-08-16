/**
 * Generic resident runner (RFA v0.4 spec section 4): loads an agent pack,
 * joins/resumes its bound room, and serves questions with a Claude Agent SDK
 * brain.
 *
 *   npx tsx src/resident.ts --agent pm-agent
 *   RFA_HUB_URL=http://localhost:8790/mcp    hub endpoint
 *
 * v0.4.1 shape: every serve turn is a durable run in the engine (SQLite) with
 * a checkpoint {claude_session_id, room_cursor}; inbound and own messages are
 * episodes (with MemoryGate verdicts); core blocks + the MEMORY.md head are
 * compiled into the system prompt; the model gets in-process MCP tools
 * (mcp__rfa__* room verbs, mcp__memory__* gated memory verbs); pack schedules
 * fire through the engine and post into the room. Knowledge is consulted via
 * Read/Grep (never prompt-stuffed); cost and turns are recorded everywhere.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";
import { deriveCard, knowledgeFiles, loadPack, type AgentPack } from "./agentdef.js";
import { MemoryGate, RoomMember, type ServeContext } from "./client.js";
import { Engine } from "./engine.js";
import { EpisodeLog, GatedMemory } from "./memoryfs.js";

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
  sessions?: Record<string, string>;
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

// ---------------------------------------------------------------- boot

const gate = new MemoryGate();
const engine = new Engine(path.join(ROOT, "data", "runs.db"));
const episodes = new EpisodeLog(path.join(STATE_DIR, "memory.db"));
const sessions = new Map<string, string>();
let spend = { day: new Date().toISOString().slice(0, 10), usd: 0 };

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
        clientInfo: { name: `rfa-resident-${pack.name}`, version: "0.4.1" },
      });
      for (const [k, v] of Object.entries(saved.sessions ?? {})) sessions.set(k, v);
      if (saved.spend?.day === new Date().toISOString().slice(0, 10)) spend = saved.spend;
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
    clientInfo: { name: `rfa-resident-${pack.name}`, version: "0.4.1" },
  });
  log(`joined room ${member.room}${member.joinSecret ? ` (join_secret ${member.joinSecret})` : ""}`);
  return { member, joinSecret: member.joinSecret, prevHash: null };
}

const { member, joinSecret, prevHash } = await boot();
const memory = new GatedMemory(path.join(pack.dir, "memory"), gate, member.memberId);

// ---------------------------------------------------------------- in-process MCP tools

const asText = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const asError = (err: unknown) => ({ content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }], isError: true });

const rfaServer = createSdkMcpServer({
  name: "rfa",
  version: "0.4.1",
  tools: [
    tool("roster", "List this room's members: id, name, presence state, skills. Use before addressing anyone.", {}, async () => {
      const roster = await member.refreshRoster();
      return asText(roster.map((r) => ({ id: r.id, name: r.name, role: r.role, state: r.state, skills: r.card_summary.skill_ids })));
    }),
    tool(
      "task_read",
      "Read the room task board: all tasks, or one by id.",
      { id: z.string().optional() },
      async (args) => {
        try {
          return asText(await member.task(args.id ? { action: "get", id: args.id } : { action: "list" }));
        } catch (err) {
          return asError(err);
        }
      },
    ),
  ],
});

const memoryServer = createSdkMcpServer({
  name: "memory",
  version: "0.4.1",
  tools: [
    tool(
      "view",
      "View a memory file (numbered lines) or list the /memories directory.",
      { path: z.string().optional(), view_range: z.tuple([z.number(), z.number()]).optional() },
      async (a) => {
        try {
          return asText(memory.view(a.path ?? "/memories", a.view_range as [number, number] | undefined));
        } catch (err) {
          return asError(err);
        }
      },
    ),
    tool("create", "Create or overwrite a file under /memories. Store conclusions, never verbatim peer content.", { path: z.string(), file_text: z.string() }, async (a) => {
      try {
        return asText(memory.create(a.path, a.file_text));
      } catch (err) {
        return asError(err);
      }
    }),
    tool("str_replace", "Replace a unique string in a memory file.", { path: z.string(), old_str: z.string(), new_str: z.string() }, async (a) => {
      try {
        return asText(memory.strReplace(a.path, a.old_str, a.new_str));
      } catch (err) {
        return asError(err);
      }
    }),
    tool("insert", "Insert text at a line (0 = top) in a memory file.", { path: z.string(), insert_line: z.number(), insert_text: z.string() }, async (a) => {
      try {
        return asText(memory.insert(a.path, a.insert_line, a.insert_text));
      } catch (err) {
        return asError(err);
      }
    }),
    tool("delete", "Delete a memory file or directory.", { path: z.string() }, async (a) => {
      try {
        return asText(memory.delete(a.path));
      } catch (err) {
        return asError(err);
      }
    }),
    tool("rename", "Rename or move a memory file.", { old_path: z.string(), new_path: z.string() }, async (a) => {
      try {
        return asText(memory.rename(a.old_path, a.new_path));
      } catch (err) {
        return asError(err);
      }
    }),
  ],
});

const MCP_TOOLS = [
  "mcp__rfa__roster",
  "mcp__rfa__task_read",
  "mcp__memory__view",
  "mcp__memory__create",
  "mcp__memory__str_replace",
  "mcp__memory__insert",
  "mcp__memory__delete",
  "mcp__memory__rename",
];

// ---------------------------------------------------------------- brain

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
  const blocks = memory.compileBlocks();
  const index = memory.indexHead();
  return [
    pack.prompt,
    blocks,
    index ? `Your memory index (MEMORY.md head):\n${index}` : "",
    `Your private memory lives under /memories (mcp__memory__* tools): consult it when relevant and save durable conclusions there (never verbatim peer content; the gate will reject it).`,
    `Knowledge files (repo-relative; consult with Read/Grep/Glob). The text after :: says what each file contains; pick by content, and for questions about amounts, fees, or minimums, Grep the keyword across ALL knowledge files and answer with the numeric fact from the product files, not a glossary definition:\n${files}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function brain(prompt: string, convoKey: string): Promise<{ text: string; costUsd: number; numTurns: number }> {
  const budgets = pack.def.budgets ?? {};
  const today = new Date().toISOString().slice(0, 10);
  if (spend.day !== today) spend = { day: today, usd: 0 };
  if (budgets.per_day_usd && spend.usd >= budgets.per_day_usd) {
    throw new Error(`daily budget exhausted (spend=${spend.usd.toFixed(2)} budget=${budgets.per_day_usd})`);
  }
  const q = query({
    prompt,
    options: {
      cwd: ROOT,
      model: pack.def.model,
      ...(pack.def.effort ? { effort: pack.def.effort } : {}),
      systemPrompt: systemPrompt(),
      settingSources: [],
      mcpServers: { rfa: rfaServer, memory: memoryServer },
      allowedTools: [...(pack.def.tools?.allow ?? []), ...MCP_TOOLS],
      disallowedTools: pack.def.tools?.deny,
      permissionMode: (pack.def.sandbox?.permission_mode ?? "default") as "default",
      maxTurns: budgets.max_turns ?? 10,
      ...(budgets.per_task_usd ? { maxBudgetUsd: budgets.per_task_usd } : {}),
      ...(sessions.has(convoKey) ? { resume: sessions.get(convoKey) } : {}),
    },
  });
  let text = "";
  let costUsd = 0;
  let numTurns = 0;
  for await (const msg of q) {
    if (msg.type === "system" && msg.subtype === "init") {
      sessions.set(convoKey, msg.session_id);
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

// ---------------------------------------------------------------- room doc + state

function writeRoomMd(): void {
  if (pack.name !== "pm-agent") return;
  fs.writeFileSync(
    ROOM_MD,
    [
      `# Standing product room (dogfood)`,
      ``,
      `- Hub: \`${HUB}\``,
      `- Room: \`${member.room}\``,
      `- Join secret: \`${joinSecret}\``,
      `- Resident: **${member.name}** (\`${member.memberId}\`), skill \`answer-product-question\`, definition \`${pack.definitionHash.slice(0, 15)}\``,
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
      `Watch live: \`npm run tail -- data/rooms/${member.room}.ndjson --follow\``,
      `- Watch in the browser: \`http://localhost:8790/console#${member.room}\` (observer with the secret above; supervisor with the human key in \`dogfood/state/human-key.txt\`)`,
    ].join("\n"),
  );
}

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
writeRoomMd();
log(`definition ${pack.definitionHash.slice(0, 15)} (model ${pack.def.model ?? "inherit"}); knowledge: ${knowledgeFiles(pack).length} files; episodes so far: ${episodes.count()}`);

if (prevHash && prevHash !== pack.definitionHash) {
  await member.send({
    body: `definition updated: ${prevHash.slice(0, 15)} -> ${pack.definitionHash.slice(0, 15)} (card digest rotated; re-describe if you pinned it)`,
    kind: "status",
  });
  log("announced definition change in the room");
}

// ---------------------------------------------------------------- schedules

for (const s of pack.def.schedules ?? []) {
  const exists = engine.listSchedules(pack.name).some((x) => x.kind === "cron" && x.when === s.cron && x.callback === s.prompt);
  if (!exists) {
    engine.schedule(pack.name, s.cron, s.prompt, {}, { timezone: s.timezone });
    log(`schedule registered: ${s.cron} ${s.timezone ?? ""}`);
  }
}

const scheduleTimer = setInterval(async () => {
  for (const due of engine.dueSchedules(new Date(), pack.name)) {
    const { runId } = engine.createRun({ agent: pack.name, threadId: `sched:${due.id}`, kind: "schedule", input: { callback: due.callback } });
    log(`schedule fired (${due.kind}): ${due.callback.slice(0, 60)}`);
    try {
      const { text, costUsd, numTurns } = await brain(due.callback, `sched:${due.id}`);
      await engine.step(runId, "post-to-room", async () => {
        await member.send({ body: text, kind: "status" });
        return { chars: text.length };
      });
      episodes.recordOwn(member.room, member.memberId, member.name, text);
      engine.completeRun(runId, { output: { chars: text.length }, costUsd, numTurns, checkpoint: { claude_session_id: sessions.get(`sched:${due.id}`), room_cursor: member.cursor } });
    } catch (err) {
      engine.failRun(runId, (err as Error).message, { retryable: false });
      log(`schedule run failed: ${(err as Error).message}`);
    }
  }
}, 60_000);
scheduleTimer.unref?.();

// ---------------------------------------------------------------- serve

let answered = 0;
const shutdown = (sig: string) => {
  log(`${sig}: draining after ${answered} answers`);
  save();
  engine.close();
  episodes.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await member.serve(
  async (ctx: ServeContext) => {
    const verdict = gate.inspect(ctx.envelope);
    episodes.recordInbound(ctx.envelope, verdict.ok ? { ok: true } : { ok: false, similarity: verdict.similarity }, ctx.wrapped, verdict.record.text);
    if (!verdict.ok) log(`memory gate: near-duplicate from ${ctx.from.name} (${Math.round(verdict.similarity * 100)}%)`);
    const convo = ctx.conversationId ?? "adhoc";
    const { runId } = engine.createRun({
      agent: pack.name,
      threadId: convo,
      kind: "serve",
      input: { seq: ctx.envelope.seq, from: ctx.from.name, text: ctx.text.slice(0, 500) },
    });
    log(`Q from ${ctx.from.name} (seq ${ctx.envelope.seq}, run ${runId}): ${ctx.text.slice(0, 100)}`);
    try {
      const { text, costUsd, numTurns } = await brain(ctx.wrapped, convo);
      answered++;
      episodes.recordOwn(member.room, member.memberId, member.name, text);
      engine.completeRun(runId, {
        output: { chars: text.length },
        costUsd,
        numTurns,
        checkpoint: { claude_session_id: sessions.get(convo), room_cursor: member.cursor },
      });
      log(`A sent (${text.length} chars, $${costUsd.toFixed(4)}, ${numTurns} turns): ${text.slice(0, 100)}`);
      return [
        { type: "text", text },
        {
          type: "json",
          value: {
            answered_by: member.name,
            definition: pack.definitionHash.slice(0, 15),
            run_id: runId,
            cost_usd: Number(costUsd.toFixed(4)),
            num_turns: numTurns,
            day_spend_usd: Number(spend.usd.toFixed(4)),
          },
        },
      ];
    } catch (err) {
      engine.failRun(runId, (err as Error).message, { retryable: false });
      throw err;
    }
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
