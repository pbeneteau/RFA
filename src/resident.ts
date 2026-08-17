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
import { interruptMatch, joinSidekick, requestApproval } from "./bridge.js";
import { MemoryGate, RoomMember, type ServeContext } from "./client.js";
import { Engine } from "./engine.js";
import { ObsStore } from "./obs.js";
import { consolidate } from "./consolidate.js";
import { EpisodeLog, FactStore, GatedMemory } from "./memoryfs.js";

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
  // The legacy migration path belongs to pm-agent alone: any other pack
  // falling back to it would RESUME PM'''S MEMBERSHIP (found live: the scribe
  // answered product questions as pm-agent for 40 seconds).
  const candidates = pack.name === 'pm-agent' ? [STATE_FILE, LEGACY_STATE] : [STATE_FILE];
  for (const file of candidates) {
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
const obs = new ObsStore(path.join(ROOT, "data", "obs.db"));
const episodes = new EpisodeLog(path.join(STATE_DIR, "memory.db"));
const facts = new FactStore(path.join(STATE_DIR, "memory.db"), gate, "self");
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
  // Joiners must RETAIN the secret they joined with: the approval sidekick and
  // future resumes need it (found live: the scribe's sidekick got null and the
  // whole approval bridge answered join_denied).
  const effectiveSecret = member.joinSecret ?? (binding?.room ? process.env.RFA_JOIN_SECRET ?? null : null);
  return { member, joinSecret: effectiveSecret, prevHash: null };
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

// ---- linear tools (v0.4.6): dry-run without LINEAR_API_KEY, GraphQL with it ----

const LINEAR_KEY = process.env.LINEAR_API_KEY;

async function linearGql(gql: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: LINEAR_KEY! },
    body: JSON.stringify({ query: gql, variables }),
  });
  const data = (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] };
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join("; "));
  return data.data ?? {};
}

const linearServer = createSdkMcpServer({
  name: "linear",
  version: "0.4.6",
  tools: [
    tool(
      "search_project",
      "Find a Linear project or team by name (returns ids). ALWAYS use before save_document: a live save requires exactly one parent (project_id or team_id).",
      { query: z.string() },
      async (a) => {
        if (!LINEAR_KEY) return asText("[dry-run] LINEAR_API_KEY not configured: skip project linking and save without a project.");
        try {
          const data = await linearGql(
            `query($q: String!) {
               projects(filter: { name: { containsIgnoreCase: $q } }, first: 5) { nodes { id name state } }
               teams(filter: { name: { containsIgnoreCase: $q } }, first: 5) { nodes { id name key } }
             }`,
            { q: a.query },
          );
          return asText({
            projects: (data.projects as { nodes: unknown[] }).nodes,
            teams: (data.teams as { nodes: unknown[] }).nodes,
          });
        } catch (err) {
          return asError(err);
        }
      },
    ),
    tool(
      "save_document",
      "Create a Linear document with the final draft. REQUIRES human approval (the call pauses on an approve/edit/reject decision). Call exactly once, with the complete markdown. Linear requires exactly one parent: pass project_id OR team_id (find either with search_project first).",
      { title: z.string(), content: z.string(), project_id: z.string().optional(), team_id: z.string().optional() },
      async (a) => {
        if (!LINEAR_KEY) {
          const dir = path.join(STATE_DIR, "drafts");
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${new Date().toISOString().slice(0, 19).replace(/[:]/g, "-")}-${a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`);
          fs.writeFileSync(file, `# ${a.title}\n\n${a.content}\n`);
          return asText(`[dry-run] LINEAR_API_KEY not configured; draft saved to ${path.relative(ROOT, file)}. A human can paste it into Linear.`);
        }
        // Linear enforces exactly one parent at runtime (found live: the first
        // approved save died on it, wasting a human decision).
        if (!a.project_id && !a.team_id) {
          return asError(new Error("Linear requires exactly one parent for a document. Call search_project, then retry with project_id or team_id."));
        }
        try {
          const data = await linearGql(
            `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { success document { id title url } } }`,
            { input: { title: a.title, content: a.content, ...(a.project_id ? { projectId: a.project_id } : { teamId: a.team_id }) } },
          );
          return asText((data.documentCreate as { document: unknown }).document);
        } catch (err) {
          return asError(err);
        }
      },
    ),
  ],
});

// ---- approval bridge (v0.4.6): interrupt_on tools pause on a human decision ----

let sidekick: RoomMember | null = null;
let currentRunId: string | null = null;
let currentReplyBy: string | null = null;

async function ensureSidekick(): Promise<RoomMember> {
  sidekick ??= await joinSidekick(HUB, member.room, joinSecret, pack.name);
  return sidekick;
}

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

async function brain(prompt: string, convoKey: string): Promise<{ text: string; costUsd: number; numTurns: number; tokens: { input: number | null; output: number | null } }> {
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
      mcpServers: { rfa: rfaServer, memory: memoryServer, linear: linearServer },
      // interrupt_on tools are EXCLUDED from the allowlist so they fall through
      // to canUseTool, where the human decision happens (spec 7.3).
      allowedTools: [...(pack.def.tools?.allow ?? []), ...MCP_TOOLS].filter((t) => !interruptMatch(pack.def.interrupt_on, t)),
      disallowedTools: pack.def.tools?.deny,
      canUseTool: async (toolName, input) => {
        const rule = interruptMatch(pack.def.interrupt_on, toolName);
        if (!rule) return { behavior: "deny" as const, message: `tool ${toolName} is not allowed for this pack` };
        // Preflight before paging a human: a live save without a parent is doomed
        // at Linear's door, so bounce it back to the model instead of burning an
        // approval on it.
        if (toolName === "mcp__linear__save_document" && LINEAR_KEY) {
          const i = input as { project_id?: string; team_id?: string };
          if (!i.project_id && !i.team_id) {
            log(`preflight deny: ${toolName} without project_id/team_id`);
            return { behavior: "deny" as const, message: "Linear requires exactly one parent. Call mcp__linear__search_project, then retry save_document with project_id or team_id." };
          }
        }
        log(`approval needed: ${toolName}`);
        let sk: RoomMember;
        try {
          sk = await ensureSidekick();
        } catch (err) {
          log(`approval bridge unavailable: ${(err as Error).message}`);
          return { behavior: "deny" as const, message: `the approval channel is unavailable (${(err as Error).message}); report this and include your draft in the answer instead` };
        }
        // The card must never outlive its audience (found live: a 10-min card
        // vs a 600s asker left a 35s window where an approval would have saved
        // a document for a departed asker). Cap the window at reply_by minus a
        // margin, floored so a nearly-expired ask still gets a real chance.
        const replyByMs = currentReplyBy ? Date.parse(currentReplyBy) - Date.now() - 30_000 : NaN;
        const outcome = await requestApproval(member, sk, {
          toolName,
          input: input as Record<string, unknown>,
          allowedDecisions: rule.allowed_decisions,
          runId: currentRunId ?? undefined,
          ...(Number.isFinite(replyByMs) ? { timeoutMs: Math.max(60_000, Math.min(10 * 60_000, replyByMs)) } : {}),
        });
        log(`approval ${toolName}: ${outcome.reason}`);
        return outcome.approved
          // Edit-before-approve MERGES over the original input: the human edits
          // fields, they do not retype the whole call (found live: a title-only
          // edit clobbered the document content).
          ? { behavior: "allow" as const, updatedInput: { ...(input as Record<string, unknown>), ...(outcome.params ?? {}) } }
          : { behavior: "deny" as const, message: `human decision: ${outcome.reason}. Report this outcome; do not retry the tool.` };
      },
      permissionMode: (pack.def.sandbox?.permission_mode ?? "default") as "default",
      maxTurns: budgets.max_turns ?? 10,
      ...(budgets.per_task_usd ? { maxBudgetUsd: budgets.per_task_usd } : {}),
      ...(sessions.has(convoKey) ? { resume: sessions.get(convoKey) } : {}),
    },
  });
  let text = "";
  let costUsd = 0;
  let numTurns = 0;
  let tokens: { input: number | null; output: number | null } = { input: null, output: null };
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
      const u = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      tokens = { input: u?.input_tokens ?? null, output: u?.output_tokens ?? null };
    }
  }
  if (!text) throw new Error("brain returned an empty result");
  spend.usd += costUsd;
  return { text, costUsd, numTurns, tokens };
}

/** Trace continuity (spec 7.1): join the asker's trace when the envelope carries SEP-414 context. */
function traceFrom(meta: Record<string, unknown>): { trace_id?: string; parent_run_id?: string } {
  const tp = meta.traceparent;
  const m = typeof tp === "string" ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(tp) : null;
  return m ? { trace_id: m[1], parent_run_id: m[2] } : {};
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
    const st0 = Date.now();
    try {
      const { text, costUsd, numTurns, tokens } = await brain(due.callback, `sched:${due.id}`);
      await engine.step(runId, "post-to-room", async () => {
        await member.send({ body: text, kind: "status" });
        return { chars: text.length };
      });
      episodes.recordOwn(member.room, member.memberId, member.name, text);
      engine.completeRun(runId, { output: { chars: text.length }, costUsd, numTurns, checkpoint: { claude_session_id: sessions.get(`sched:${due.id}`), room_cursor: member.cursor } });
      obs.record({
        id: runId, name: `schedule:${pack.name}`, run_type: "agent_span", start_time: st0, end_time: Date.now(),
        group_id: member.room, inputs: { callback: due.callback.slice(0, 200) }, outputs: { chars: text.length },
        input_tokens: tokens.input, output_tokens: tokens.output, cost_usd: costUsd,
        extra: { "gen_ai.request.model": pack.def.model ?? "inherit", num_turns: numTurns, schedule: due.id },
      });
    } catch (err) {
      engine.failRun(runId, (err as Error).message, { retryable: false });
      log(`schedule run failed: ${(err as Error).message}`);
    }
  }
}, 60_000);
scheduleTimer.unref?.();

// ---------------------------------------------------------------- serve

let answered = 0;
let serving = false;
let sinceConsolidation = 0;
let lastConsolidation = Date.now();

// Background consolidation (spec 5.3): after 8 gated exchanges or 6h, when idle.
const consolidationTimer = setInterval(() => {
  if (serving) return;
  if (sinceConsolidation < 8 && Date.now() - lastConsolidation < 6 * 3600_000) return;
  sinceConsolidation = 0;
  lastConsolidation = Date.now();
  void consolidate(pack.name)
    .then((r) => {
      if (r.episodes > 0) log(`consolidated ${r.episodes} episodes: +${r.added} facts, ~${r.updated}, -${r.invalidated} ($${r.cost_usd.toFixed(4)})`);
    })
    .catch((err) => log(`consolidation failed: ${(err as Error).message}`));
}, 60_000);
consolidationTimer.unref?.();

// Long turns starve both the lease and the heartbeat: the serve loop only
// breathes between listens, so a multi-minute tool run or approval wait looks
// wedged to the supervisor and gone_quiet to the room (found live: the scribe
// was SIGTERMed 38s after a human approved its save). While serving, renew
// both from a timer; a truly wedged event loop stops the timer too, so the
// supervisor's staleness check still catches real hangs.
const keepaliveTimer = setInterval(() => {
  if (!serving) return;
  fs.writeFileSync(HEARTBEAT, String(Date.now()));
  void member.setPresence("busy", { detail: "serving" }).catch(() => {});
}, 30_000);
keepaliveTimer.unref?.();

const shutdown = (sig: string) => {
  log(`${sig}: draining after ${answered} answers`);
  save();
  clearInterval(consolidationTimer);
  engine.close();
  episodes.close();
  facts.close();
  obs.close();
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
    currentRunId = runId;
    currentReplyBy = ctx.envelope.reply_by;
    serving = true;
    const t0 = Date.now();
    try {
      // L3 retrieval (spec 5.1): consolidated facts relevant to THIS question,
      // origin-tagged, injected per turn (never the whole store).
      const relevant = facts.retrieve(ctx.text, 5);
      const memoryBlock = relevant.length
        ? `<consolidated-memory note="your own distilled conclusions; [origin] tags the source trust tier; may be stale">\n${relevant.map((f) => `- [${f.source_origin}] ${f.text}`).join("\n")}\n</consolidated-memory>\n\n`
        : "";
      const { text, costUsd, numTurns, tokens } = await brain(memoryBlock + ctx.wrapped, convo);
      answered++;
      episodes.recordOwn(member.room, member.memberId, member.name, text);
      engine.completeRun(runId, {
        output: { chars: text.length },
        costUsd,
        numTurns,
        checkpoint: { claude_session_id: sessions.get(convo), room_cursor: member.cursor },
      });
      obs.record({
        id: runId,
        ...traceFrom(ctx.envelope._meta),
        name: `serve:${pack.name}`,
        run_type: "agent_span",
        start_time: t0,
        end_time: Date.now(),
        group_id: member.room,
        inputs: { from: ctx.from.name, seq: ctx.envelope.seq, text: ctx.text.slice(0, 300) },
        outputs: { text: text.slice(0, 300), chars: text.length },
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cost_usd: costUsd,
        extra: { "gen_ai.request.model": pack.def.model ?? "inherit", num_turns: numTurns, definition: pack.definitionHash.slice(0, 15), conversation: convo },
      });
      serving = false;
      sinceConsolidation++;
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
      serving = false;
      engine.failRun(runId, (err as Error).message, { retryable: false });
      obs.record({
        id: runId,
        ...traceFrom(ctx.envelope._meta),
        name: `serve:${pack.name}`,
        run_type: "agent_span",
        status: "error",
        error: (err as Error).message.slice(0, 300),
        start_time: t0,
        end_time: Date.now(),
        group_id: member.room,
        inputs: { from: ctx.from.name, seq: ctx.envelope.seq, text: ctx.text.slice(0, 300) },
        extra: { "gen_ai.request.model": pack.def.model ?? "inherit", conversation: convo },
      });
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
