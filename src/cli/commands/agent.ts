/**
 * Packs (RFA-0.7 sect. 3.2): the lifecycle from `new` to `retire`, every step
 * validated through the schema the supervisor uses.
 */
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { AccountLedger } from "../../account.js";
import { CONCURRENCY_GATE_LABELS, concurrencyGateFailures, declaredSecretNames, deriveCard, knowledgeFiles, loadPack, packByName, parseAgentMd, scanPacks } from "../../agentdef.js";
import { surfaceReport } from "../../surface.js";
import { RoomMember } from "../../client.js";
import { daemonState } from "../../daemon.js";
import { findRoom, roomsStore, secretsStore, type HubDir, type RoomRecord } from "../../hubdir.js";
import { packageVersion } from "../../pkg.js";
import { belongsTo, residentProcessesSync } from "../../procscan.js";
import { reflect } from "../../reflect.js";
import { bindPack, currentSettings, editPack, setAgentMode, type EditResult, type PackChanges } from "../agentmd.js";
import { attachKnowledge, AttachError } from "../attach.js";
import { createRoomRecord } from "./init.js";
import { actingTools, effectiveMode, isMode, MODE_SUMMARY, MODES, type AgentMode } from "../../posture.js";
import { CliError, numberFlag, type CliContext } from "../context.js";
import type { CommandDef } from "../router.js";
import { BUILTIN_SERVERS, builtinTool, knowledgeRelativeToPack, nameProblem, PACK_KINDS, renderAgentMd, scaffoldPack, type PackKind, type ToolSpec } from "../scaffold.js";
import { askLine, pickOne } from "../prompts.js";
import { fmtAge } from "../ui.js";

/** `--room <alias|handle>`: an alias from rooms.json, or a handle as given. */
function resolveRoom(h: HubDir, ref: string | undefined): RoomRecord | { handle: string; alias: null } | null {
  if (!ref) return null;
  const rec = findRoom(roomsStore(h).read(), ref);
  if (rec) return rec;
  if (/^r_[a-f0-9]+$/.test(ref)) return { handle: ref, alias: null };
  throw new CliError(2, `no room called ${ref}`, "rfa room ls; or pass a handle (r_…)");
}

export const agentNew: CommandDef = {
  path: ["agent", "new"],
  summary: "Scaffold a pack, validated, bound to a room; alone on a terminal, the walkthrough",
  usage: "<name> [--kind spec-expert|answerer|tool] [--room <alias|handle>] [--knowledge <dir>] [--model haiku|sonnet] [--server <name> --command <cmd> --tool <id> | --builtin linear [--tool <id>]] [--mode ask|plan|bypass] [--dry-run]",
  why: "Everything the scaffold writes is something a hand-written pack got wrong at least once here: RFA_TOKEN in secrets, a skill on the card, budgets, allow_subagents: false, a room binding. It is validated through the supervisor's own schema, so it either loads or says why before the supervisor sees it. A tool user names the MCP server it brings; the runtime loads it from the pack's own declaration.",
  options: { kind: { type: "string" }, room: { type: "string" }, knowledge: { type: "string" }, model: { type: "string" }, server: { type: "string" }, command: { type: "string" }, builtin: { type: "string" }, tool: { type: "string" }, mode: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  examples: ["rfa agent new pm --kind answerer --knowledge ./docs --room product", "rfa agent new scribe --kind tool --builtin linear", "rfa agent new filer --kind tool --server filesystem --command 'npx -y @modelcontextprotocol/server-filesystem /tmp/scratch' --tool write_file"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    if (!a.positionals[0] && ctx.interactive) {
      // No name, a terminal: the walkthrough, every setting a pack has, one screen each.
      const { runAgentWizard } = await import("../tui/agentwizard.js");
      return runAgentWizard(ctx, h);
    }
    const name = a.positionals[0] ?? (await askLine(ctx, "Name the new agent", "rfa agent new <name> [--kind …]", { placeholder: "pm-agent" }));
    const problem = nameProblem(name);
    if (problem) throw new CliError(2, problem);
    const kind = (a.values.kind as PackKind | undefined) ?? "answerer";
    if (!PACK_KINDS.includes(kind)) throw new CliError(2, `--kind takes ${PACK_KINDS.join(", ")}`);
    const rooms = roomsStore(h).read().rooms;
    const room = resolveRoom(h, a.values.room as string | undefined) ?? rooms.find((r) => r.alias !== "ops") ?? null;
    let tool: ToolSpec | undefined;
    if (kind === "tool") {
      const server = a.values.server as string | undefined;
      const command = a.values.command as string | undefined;
      const toolId = a.values.tool as string | undefined;
      const builtin = a.values.builtin as string | undefined;
      if (builtin) {
        try {
          tool = builtinTool(builtin, toolId, server);
        } catch (err) {
          throw new CliError(2, (err as Error).message);
        }
      } else {
        if (!server || !command || !toolId) throw new CliError(2, "a tool user needs --server <name> --command <cmd> --tool <id>, or --builtin <name> [--tool <id>]", `the tool id is what pauses for your approval: mcp__<server>__<id>; built in: ${Object.keys(BUILTIN_SERVERS).join(", ")}`);
        const [cmd, ...args] = command.split(/\s+/);
        tool = { server, command: cmd, args, tool: toolId };
      }
    }
    const modeFlag = a.values.mode as string | undefined;
    if (modeFlag && !isMode(modeFlag)) throw new CliError(2, `--mode takes ${MODES.join(", ")}`);
    if (modeFlag && kind !== "tool") throw new CliError(2, `--mode applies to a tool user; a${kind === "answerer" ? "n answerer" : " spec-expert"} has no acting tool`);
    const opts = { name, kind, room: room?.handle ?? null, model: a.values.model as string | undefined, knowledge: a.values.knowledge as string | undefined, tool, mode: modeFlag as AgentMode | undefined };
    if (a.values["dry-run"]) {
      const content = renderAgentMd({ ...opts, knowledge: knowledgeRelativeToPack(h, name, opts.knowledge) });
      parseAgentMd(content, { dir: path.join(h.paths.agents, name) });
      process.stdout.write(content);
      return;
    }
    try {
      const res = scaffoldPack(h, opts);
      ctx.ui.done(`agents/${name}/agent.md`, `definition ${res.definitionHash.slice(7, 15)} · offers ${res.skillId}${room ? ` · room ${room.alias ?? room.handle}` : " · NOT bound to a room yet"}`);
      ctx.ui.note(res.reused ? `the folder already existed and was taken over${res.kept.length ? `; kept ${res.kept.length} file(s) of yours: ${res.kept.slice(0, 4).join(", ")}${res.kept.length > 4 ? ", …" : ""}` : ""}` : "the pack is a folder: agent.md, knowledge/, memory/, skills/, evals/");
      const sup = daemonState(h.paths.supervisorPid);
      const next: string[] = [];
      if (kind === "answerer" && !a.values.knowledge) next.push(`put markdown in agents/${name}/knowledge/, or rfa knowledge add ${name} <dir>`);
      if (!room) next.push(`rfa agent bind ${name} --room <alias>`);
      if (kind === "tool") next.push(tool?.envSecrets?.length ? `rfa secrets set ${tool.envSecrets.join(" / ")}: the server runs in dry-run mode until then` : `rfa secrets set <NAME> for any secret the server needs, and declare it under mcp_servers.${tool!.server}.env_secrets`);
      next.push(sup.alive ? "the supervisor picks it up within 30s: rfa status" : "rfa up starts it");
      for (const n of next) ctx.ui.note(`→ ${n}`);
      if (ctx.flags.json) ctx.ui.json({ name, dir: res.dir, definition_hash: res.definitionHash, skill: res.skillId, room: room?.handle ?? null });
    } catch (err) {
      throw new CliError(1, (err as Error).message);
    }
  },
};

function supervisorView(h: HubDir): Record<string, { pid: number | null; status: string; started_at: string | null; restarts_in_window: number }> {
  try {
    return (JSON.parse(fs.readFileSync(h.paths.supervisorState, "utf8")) as { agents?: Record<string, never> }).agents ?? {};
  } catch {
    return {};
  }
}

export const agentLs: CommandDef = {
  path: ["agent", "ls"],
  summary: "Packs with their supervisor status, room, model and spend today",
  run: async (ctx) => {
    const h = ctx.hubdir();
    /*
     * TOLERANT, and the broken pack gets a ROW rather than a footnote. This is
     * the command an operator reaches for when something is wrong, so it is the
     * command that most needs to show the pack that is wrong: `listPacks` maps
     * `loadPack` with no catch, and one unparseable definition answered
     * `rfa agent ls` with a Zod error instead of the registry. Skipping it
     * silently would be worse than the throw, because a pack absent from
     * `agent ls` reads as a RETIRED pack, and the next move after that
     * misreading is `rfa agent new` on a name that is already taken.
     */
    const { packs, broken } = scanPacks(h.paths.agents);
    const sup = supervisorView(h);
    const rooms = roomsStore(h).read().rooms;
    const today = new Date().toISOString().slice(0, 10);
    const rows = packs.map((p) => {
      const hb = path.join(p.dir, "state", "heartbeat");
      let member: { spend?: { day: string; usd: number } } | null = null;
      try {
        member = JSON.parse(fs.readFileSync(path.join(p.dir, "state", "member.json"), "utf8"));
      } catch {
        member = null;
      }
      const handle = (p.def.rooms ?? [])[0]?.room ?? null;
      return {
        name: p.name,
        status: sup[p.name]?.status ?? "not supervised",
        pid: sup[p.name]?.pid ?? null,
        room: rooms.find((r) => r.handle === handle)?.alias ?? handle,
        model: p.def.model ?? "inherit",
        mode: effectiveMode(p.def),
        offers: (p.def.offers ?? []).map((o) => o.id),
        heartbeat_age_ms: fs.existsSync(hb) ? Date.now() - Number(fs.readFileSync(hb, "utf8")) : null,
        spend_today_usd: member?.spend?.day === today ? member.spend.usd : 0,
        definition: p.definitionHash.slice(7, 15),
      };
    });
    // Named by DIRECTORY, because the declared name is exactly what is
    // unreadable. `status: "definition invalid"` keeps the JSON row shape one
    // array of agents (the console and the dashboard iterate it), and `broken`
    // carries the loader's own complaint so nobody has to re-run the parse.
    const brokenRows = broken.map((b) => ({
      name: b.name,
      status: "definition invalid",
      pid: null,
      room: null,
      model: null,
      mode: null,
      offers: [] as string[],
      heartbeat_age_ms: null,
      spend_today_usd: 0,
      definition: null,
      broken: b.error,
    }));
    if (ctx.flags.json) return void ctx.ui.json([...rows, ...brokenRows]);
    if (rows.length === 0 && brokenRows.length === 0) return void ctx.ui.note("no packs: rfa agent new <name>");
    ctx.ui.table([
      ...rows.map((r) => [r.status === "running" ? ctx.ui.good("●") : ctx.ui.dim("○"), r.name, r.status, r.room ?? "-", r.model, r.mode === "bypass" ? ctx.ui.bad(r.mode) : r.mode === "read-only" ? ctx.ui.dim(r.mode) : r.mode, `$${r.spend_today_usd.toFixed(2)} today`, r.heartbeat_age_ms === null ? ctx.ui.dim("no heartbeat") : `heartbeat ${fmtAge(Date.now() - r.heartbeat_age_ms)}`, ctx.ui.dim(r.offers.join(", "))]),
      ...brokenRows.map((r) => [ctx.ui.bad("✗"), r.name, ctx.ui.bad(r.status), "-", "-", "-", "-", "-", ctx.ui.dim(r.broken)]),
    ]);
    for (const b of broken) ctx.ui.warn(`agents/${b.name}/agent.md does not parse, so nothing supervises that pack: ${b.error}`, `rfa agent validate ${b.name}`);
  },
};

export const agentShow: CommandDef = {
  path: ["agent", "show"],
  summary: "A pack's definition, card, knowledge, budgets and binding",
  usage: "<name>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = await packArg(ctx, h, a.positionals[0], "rfa agent show <name>");
    const dir = path.join(h.paths.agents, name);
    if (!fs.existsSync(path.join(dir, "agent.md"))) throw new CliError(2, `no pack agents/${name}`, "rfa agent ls");
    const pack = loadPack(dir);
    const card = deriveCard(pack);
    const files = knowledgeFiles(pack);
    const rooms = roomsStore(h).read().rooms;
    const binding = (pack.def.rooms ?? [])[0];
    let member: { room?: string; member_id?: string; spend?: { day: string; usd: number } } | null = null;
    try {
      member = JSON.parse(fs.readFileSync(path.join(dir, "state", "member.json"), "utf8"));
    } catch {
      member = null;
    }
    const secretsHeld = secretsStore(h).exists() ? Object.keys(secretsStore(h).read()) : [];
    const declared = declaredSecretNames(pack.def);
    const view = {
      name: pack.name,
      description: pack.def.description,
      model: pack.def.model ?? "inherit",
      effort: pack.def.effort ?? null,
      definition_hash: pack.definitionHash,
      /**
       * RFA-0.8 sects. 10 and 11. Both are settable (`rfa agent edit --concurrency`,
       * `--candidates`) and were until now invisible: an operator could raise the
       * number and had no command that showed it back.
       */
      concurrency: pack.def.concurrency,
      candidates: pack.def.candidates,
      concurrency_gates: concurrencyGateFailures(pack.def),
      card: { name: card.name, skills: card.skills, digest_source: "derived from the definition" },
      tools: pack.def.tools ?? null,
      mcp_servers: pack.def.mcp_servers ?? null,
      interrupt_on: pack.def.interrupt_on ?? null,
      /**
       * RFA-0.9 sect. 10.1: the network posture with its scope, every unconfined
       * surface the pack holds, and the reachable tool count. All FROM DISK, and
       * the rendering says so: a resident's `state/member.json` records no
       * posture, no tool surface and no fence state, so there is nothing running
       * to compare against and inventing a comparison would be the defect
       * CLAUDE.md's rule was written for.
       */
      surface: surfaceReport(pack.def),
      knowledge: { globs: pack.def.knowledge ?? [], files: files.map((f) => path.relative(h.root, f)) },
      budgets: pack.def.budgets ?? null,
      spend_today_usd: member?.spend?.day === new Date().toISOString().slice(0, 10) ? member!.spend!.usd : 0,
      secrets: { declared, missing: declared.filter((n) => !secretsHeld.includes(n)) },
      binding: binding ? { ...binding, alias: rooms.find((r) => r.handle === binding.room)?.alias ?? null } : null,
      membership: member?.member_id ? { room: member.room, member_id: member.member_id } : null,
      supervisor: supervisorView(h)[pack.name] ?? null,
    };
    if (ctx.flags.json) return void ctx.ui.json(view);
    const ui = ctx.ui;
    ui.line(`${ui.bold(pack.name)}  ${ui.dim(pack.def.description)}`);
    /**
     * Why the gate line is here and not only in `rfa doctor`: above 1, the
     * number is allowed BECAUSE the pack passes sect. 10's gates, and an
     * operator reading `concurrency 2` with no reason beside it has to go and
     * look up why it was accepted. `concurrencyGateFailures` is the schema's own
     * function, so this line cannot claim a gate the loader does not enforce,
     * and the gate NAMES come from `CONCURRENCY_GATE_LABELS` in the same module
     * rather than being typed out here: this line said "three gates" and listed
     * three of the four for as long as the fourth existed.
     */
    const parallel =
      view.concurrency > 1 || view.candidates > 1
        ? `${view.concurrency} turn${view.concurrency === 1 ? "" : "s"} at once, ${view.candidates} candidate${view.candidates === 1 ? "" : "s"} per task  ` +
          (view.concurrency_gates.length === 0
            ? ui.dim(`· passed RFA-0.8 sect. 10's gates: ${CONCURRENCY_GATE_LABELS.join(", ")}`)
            : ui.bad(`· gates NOT passed: ${view.concurrency_gates.join("; ")}`))
        : ui.dim("1 turn at once (serial), no candidate fan-out");
    ui.table([
      ["model", `${view.model}${view.effort ? ` (${view.effort})` : ""}`],
      ["definition", view.definition_hash],
      ["concurrency", parallel],
      ["offers", card.skills?.map((s) => `${s.id}: ${s.description}`).join("\n") ?? "-"],
      ["room", view.binding ? `${view.binding.alias ?? view.binding.room} (${view.binding.role}, serve ${view.binding.serve})` : ui.caution("none: rfa agent bind")],
      ["membership", view.membership ? `${view.membership.member_id} in ${view.membership.room}` : ui.dim("never joined")],
      ["status", view.supervisor ? `${view.supervisor.status}${view.supervisor.pid ? ` (pid ${view.supervisor.pid})` : ""}` : ui.dim("not supervised")],
      ["budgets", view.budgets ? Object.entries(view.budgets).map(([k, v]) => `${k} ${v}`).join(", ") : ui.caution("none: unbounded spend")],
      ["spend today", `$${view.spend_today_usd.toFixed(2)}`],
      ["secrets", declared.length ? declared.map((n) => (view.secrets.missing.includes(n) ? ui.bad(`${n} (missing)`) : n)).join(", ") : "-"],
      ["mcp servers", view.mcp_servers ? Object.keys(view.mcp_servers).join(", ") : "-"],
      ["egress", `${view.surface.posture.summary}\n${ui.dim(`read from agent.md on disk: a resident's state/member.json records no posture`)}\n${ui.dim(`scope: ${view.surface.scope}`)}`],
      ["tools reachable", `${view.surface.tools.total} (${view.surface.tools.builtins.length} built-in, ${view.surface.tools.mcp.length} declared MCP, ${view.surface.tools.platform.length} injected by the platform)` + (view.surface.toolWarning ? `\n${ui.caution(view.surface.toolWarning)}` : "")],
      ["unconfined", view.surface.surfaces.map((u) => `${u.what} ${ui.dim("(from disk)")}\n${ui.dim(u.why)}`).join("\n") || ui.dim("none named")],
      ["interrupts", view.interrupt_on ? Object.keys(view.interrupt_on).join(", ") : "-"],
      ["knowledge", `${files.length} file${files.length === 1 ? "" : "s"} from ${view.knowledge.globs.length} glob${view.knowledge.globs.length === 1 ? "" : "s"}`],
    ]);
    for (const w of pack.warnings) ui.note(ui.caution(w));
    for (const f of view.knowledge.files.slice(0, 20)) ui.note(f);
    if (view.knowledge.files.length > 20) ui.note(`… and ${view.knowledge.files.length - 20} more`);
  },
};

export const agentValidate: CommandDef = {
  path: ["agent", "validate"],
  summary: "Parse every pack (or one) through the supervisor's schema; check bindings, secrets and knowledge",
  usage: "[<name>]",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const only = a.positionals[0];
    const dirs = fs.existsSync(h.paths.agents) ? fs.readdirSync(h.paths.agents, { withFileTypes: true }).filter((e) => e.isDirectory() && (!only || e.name === only)).map((e) => path.join(h.paths.agents, e.name)) : [];
    if (only && dirs.length === 0) throw new CliError(2, `no pack agents/${only}`);
    const rooms = roomsStore(h).read().rooms;
    const held = secretsStore(h).exists() ? Object.keys(secretsStore(h).read()) : [];
    const results: { name: string; ok: boolean; problems: string[] }[] = [];
    for (const dir of dirs) {
      const name = path.basename(dir);
      if (!fs.existsSync(path.join(dir, "agent.md"))) continue;
      try {
        const pack = loadPack(dir);
        const problems: string[] = [];
        const binding = (pack.def.rooms ?? [])[0];
        if (!binding) problems.push("no room binding: loads but never serves (rfa agent bind)");
        else if (binding.room && rooms.length && !rooms.some((r) => r.handle === binding.room)) problems.push(`bound to ${binding.room}, which rooms.json does not list (rfa room adopt, or rfa agent bind)`);
        if (!(pack.def.secrets ?? []).includes("RFA_TOKEN")) problems.push("secrets does not declare RFA_TOKEN: it cannot reach an authenticated hub");
        for (const n of declaredSecretNames(pack.def)) if (!held.includes(n)) problems.push(`secret ${n} is declared and not set (rfa secrets set ${n})`);
        if ((pack.def.knowledge ?? []).length && knowledgeFiles(pack).length === 0) problems.push("knowledge globs resolve to zero files");
        if (!pack.def.budgets?.per_task_usd && !pack.def.budgets?.per_day_usd) problems.push("no cost ceiling: neither per_task_usd nor per_day_usd");
        // RFA-0.9 sect. 7.2's threshold is a warning, not a refusal, so the
        // loader hands it out rather than throwing. This is the command an
        // operator runs to ask "is this pack all right", so it is the one place
        // a warning nobody surfaces would most obviously be a wish.
        problems.push(...pack.warnings);
        results.push({ name, ok: problems.length === 0, problems });
      } catch (err) {
        results.push({ name, ok: false, problems: [(err as Error).message] });
      }
    }
    if (ctx.flags.json) ctx.ui.json(results);
    else
      for (const r of results) {
        if (r.ok) ctx.ui.done(`${r.name} valid`);
        else {
          ctx.ui.fail(`${r.name}`);
          for (const p of r.problems) ctx.ui.note(`- ${p}`);
        }
      }
    if (results.some((r) => !r.ok)) return 1;
  },
};

export const agentBind: CommandDef = {
  path: ["agent", "bind"],
  summary: "Bind a pack to a room (rewrites only its rooms: block; the supervisor redeploys)",
  usage: "<name> --room <alias|handle> [--observer] [--no-serve]",
  options: { room: { type: "string" }, observer: { type: "boolean", default: false }, serve: { type: "boolean", default: true } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = a.positionals[0];
    const ref = a.values.room as string | undefined;
    if (!name || !ref) throw new CliError(2, "rfa agent bind <name> --room <alias|handle>");
    const file = path.join(h.paths.agents, name, "agent.md");
    if (!fs.existsSync(file)) throw new CliError(2, `no pack agents/${name}`);
    const room = resolveRoom(h, ref)!;
    try {
      const { before, after } = bindPack(file, room.handle, { role: a.values.observer ? "observer" : "participant", serve: a.values.serve !== false });
      if (before === after) ctx.ui.step(`${name} was already bound to ${room.alias ?? room.handle}`);
      else ctx.ui.done(`${name} bound to ${room.alias ?? room.handle}`, `definition ${before.slice(7, 15)} -> ${after.slice(7, 15)}; a running supervisor drains and respawns it`);
    } catch (err) {
      throw new CliError(1, `the binding would produce an invalid pack: ${(err as Error).message}`);
    }
  },
};

/** Append a command for the supervisor and wait for its state file to reflect it. */
export async function supervisorCommand(ctx: CliContext, h: HubDir, agent: string, action: "start" | "stop" | "restart"): Promise<string> {
  if (!daemonState(h.paths.supervisorPid).alive) throw new CliError(3, "the supervisor is not running", "rfa up");
  if (!fs.existsSync(path.join(h.paths.agents, agent, "agent.md"))) throw new CliError(2, `no pack agents/${agent}`);
  fs.appendFileSync(h.paths.supervisorCommands, JSON.stringify({ ts: new Date().toISOString(), agent, action, principal: "cli" }) + "\n");
  const want = action === "stop" ? (s: string) => s === "stopped" : (s: string) => s === "running";
  const deadline = Date.now() + 30_000;
  let last = "unknown";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    last = supervisorView(h)[agent]?.status ?? "not in the registry";
    if (want(last)) return last;
  }
  throw new CliError(1, `${agent} is ${last} after 30s`, `rfa logs supervisor`);
}

const lifecycle = (action: "start" | "stop" | "restart"): CommandDef => ({
  path: ["agent", action],
  summary: `${action[0].toUpperCase()}${action.slice(1)} a resident through the supervisor`,
  usage: "<name>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = await packArg(ctx, h, a.positionals[0], `rfa agent ${action} <name>`);
    const status = await supervisorCommand(ctx, h, name, action);
    ctx.ui.done(`${name} ${status}`);
  },
});
export const agentStart = lifecycle("start");
export const agentStop = lifecycle("stop");
export const agentRestart = lifecycle("restart");

// ---------------------------------------------------------------- edit

export interface EditOutcome extends EditResult {
  /** What happened beside agent.md: a room created, a clone made. */
  notes: string[];
  room: { alias: string; handle: string } | null;
}

/**
 * The one implementation behind `rfa agent edit`'s flags and its walkthrough:
 * the room and the clone first, because they must exist to be named, then one
 * validated write of agent.md through `editPack`.
 */
export async function applyPackEdit(ctx: CliContext, h: HubDir, name: string, changes: PackChanges, extras: { newRoom?: { alias: string; topic: string } | null; knowledge?: { source: string; docs?: string } | null } = {}): Promise<EditOutcome> {
  const dir = path.join(h.paths.agents, name);
  const file = path.join(dir, "agent.md");
  if (!fs.existsSync(file)) throw new Error(`no pack agents/${name}`);
  const c: PackChanges = { ...changes };
  const notes: string[] = [];
  let room: EditOutcome["room"] = null;
  if (extras.newRoom) {
    const rec = await createRoomRecord(ctx, h, extras.newRoom.alias, extras.newRoom.topic);
    c.room = rec.handle;
    room = { alias: rec.alias, handle: rec.handle };
    notes.push(`room ${rec.alias} (${rec.handle}): you host it; the pack joins it with the bearer`);
  }
  if (extras.knowledge) {
    const att = attachKnowledge(h, { name, dir }, extras.knowledge.source, { docs: extras.knowledge.docs });
    c.knowledge = [...(c.knowledge ?? []), ...att.globs];
    notes.push(att.clone ? `cloned ${extras.knowledge.source} at ${att.clone.head.slice(0, 10)}: ${att.clone.docs} document(s); rfa knowledge sync pulls it` : `reads ${att.attached}`);
  }
  return { ...editPack(file, c), notes, room };
}

/** `--editor`: agent.md in $EDITOR, validated on save; what `rfa agent edit` did before it had a walkthrough. */
export async function editInEditor(ctx: CliContext, name: string, file: string): Promise<number> {
  const editor = ctx.env.VISUAL || ctx.env.EDITOR;
  if (!editor) throw new CliError(2, "no $EDITOR set", `edit ${path.relative(process.cwd(), file)} by hand; rfa agent validate ${name} checks it`);
  const before = parseAgentMd(fs.readFileSync(file, "utf8"), { dir: path.dirname(file) }).definitionHash;
  const [cmd, ...args] = editor.split(/\s+/);
  const code = await new Promise<number>((resolve) => spawn(cmd, [...args, file], { stdio: "inherit" }).on("exit", (c) => resolve(c ?? 1)));
  if (code !== 0) throw new CliError(1, `${editor} exited ${code}`);
  try {
    const after = parseAgentMd(fs.readFileSync(file, "utf8"), { dir: path.dirname(file) }).definitionHash;
    if (after === before) ctx.ui.step("unchanged");
    else ctx.ui.done(`${name} edited`, `definition ${before.slice(7, 15)} -> ${after.slice(7, 15)}; a running supervisor drains and respawns it`);
  } catch (err) {
    throw new CliError(1, `agent.md is now INVALID and the supervisor keeps the running resident: ${(err as Error).message}`, `fix it: rfa agent edit ${name} --editor`);
  }
  return 0;
}

const EDIT_FLAGS = ["model", "description", "offer", "offer-description", "per-task", "per-day", "max-turns", "mode", "room", "knowledge", "concurrency", "candidates", "drop-network"] as const;

/** The flags of `rfa agent edit` as the changes `editPack` takes; null when no flag was given. */
export function changesFromFlags(h: HubDir, current: ReturnType<typeof currentSettings>, v: Record<string, string | boolean | undefined>): PackChanges | null {
  if (!EDIT_FLAGS.some((f) => v[f] !== undefined)) return null;
  const c: PackChanges = {};
  if (v.model !== undefined) c.model = String(v.model);
  if (v.description !== undefined) c.description = String(v.description);
  if (v.offer !== undefined || v["offer-description"] !== undefined) {
    const id = v.offer !== undefined ? String(v.offer) : current.offer?.id;
    const description = v["offer-description"] !== undefined ? String(v["offer-description"]) : current.offer?.description;
    if (!id || !description) throw new CliError(2, "a capability needs both --offer <id> and --offer-description \"<text>\" when the pack advertises none yet");
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new CliError(2, `--offer ${JSON.stringify(id)}: lowercase letters, digits and hyphens; make it a verb`);
    c.offer = { id, description };
  }
  const money = (flag: string): number | undefined => {
    if (v[flag] === undefined) return undefined;
    const n = Number(v[flag]);
    if (!Number.isFinite(n) || n <= 0) throw new CliError(2, `--${flag} takes dollars, like 0.25`);
    return n;
  };
  const perTask = money("per-task");
  const perDay = money("per-day");
  let maxTurns: number | undefined;
  if (v["max-turns"] !== undefined) {
    maxTurns = Number(v["max-turns"]);
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) throw new CliError(2, "--max-turns takes a whole number from 1 to 200");
  }
  if (perTask !== undefined || perDay !== undefined || maxTurns !== undefined) c.budgets = { ...(perTask !== undefined ? { per_task_usd: perTask } : {}), ...(perDay !== undefined ? { per_day_usd: perDay } : {}), ...(maxTurns !== undefined ? { max_turns: maxTurns } : {}) };
  if (v.mode !== undefined) {
    if (!isMode(String(v.mode))) throw new CliError(2, `--mode takes ${MODES.join(", ")}`);
    c.mode = String(v.mode) as AgentMode;
  }
  if (v.room !== undefined) {
    const rec = resolveRoom(h, String(v.room));
    if (!rec) throw new CliError(2, "--room takes an alias or a handle");
    c.room = rec.handle;
  }
  if (v.candidates !== undefined) {
    const n = Number(v.candidates);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new CliError(2, "--candidates takes a whole number from 1 to 8");
    c.candidates = n;
  }
  if (v.concurrency !== undefined) {
    const n = Number(v.concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 16) throw new CliError(2, "--concurrency takes a whole number from 1 to 16");
    c.concurrency = n;
  }
  // RFA-0.9 sect. 4.6: the inert `sandbox.network` line every pre-rung-1
  // scaffold wrote. Nothing read it, so a pack carrying it advertises an egress
  // policy the platform never had; `rfa doctor` names the pack and this flag.
  if (v["drop-network"]) c.dropNetwork = true;
  return c;
}

export const agentEdit: CommandDef = {
  path: ["agent", "edit"],
  summary: "Change a pack's settings: alone on a terminal the walkthrough, with flags headless, --editor opens agent.md",
  usage: '<name> [--model haiku|sonnet|opus] [--description "<text>"] [--offer <id>] [--offer-description "<text>"] [--per-task <usd>] [--per-day <usd>] [--max-turns <n>] [--mode ask|plan|bypass] [--room <alias|handle>] [--knowledge <dir|git remote> [--docs <subdir>]] [--concurrency <n>] [--candidates <n>] [--drop-network] [--editor]',
  options: { model: { type: "string" }, description: { type: "string" }, offer: { type: "string" }, "offer-description": { type: "string" }, "per-task": { type: "string" }, "per-day": { type: "string" }, "max-turns": { type: "string" }, mode: { type: "string" }, room: { type: "string" }, knowledge: { type: "string" }, docs: { type: "string" }, concurrency: { type: "string" }, candidates: { type: "string" }, "drop-network": { type: "boolean" }, editor: { type: "boolean", default: false } },
  why: "Every setting rfa agent new asks for can be changed afterwards on the same screen, pre-filled with what the pack has; the flags are the headless form of every answer, and --editor is agent.md itself for the prompt and everything else. Each change rewrites only its line or block (the rest of the file byte for byte) and the whole is validated through the supervisor's own schema before a single write, so an edit can never produce a pack the platform refuses. A change rotates the definition: a running supervisor drains the resident and respawns it, and the room sees the digest change.",
  examples: ["rfa agent edit pm-agent", "rfa agent edit pm-agent --model sonnet --per-day 10", 'rfa agent edit pm-agent --offer answer-fee-question --offer-description "Answers fee questions from the handbook, citing the page."', "rfa agent edit pm-agent --knowledge ./handbook", "rfa agent edit pm-agent --editor", "rfa agent edit pm-agent --concurrency 2", "rfa agent edit pm-agent --concurrency 3 --candidates 3", "rfa agent edit pm-agent --drop-network"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = await packArg(ctx, h, a.positionals[0], "rfa agent edit <name> [--model …]");
    const dir = path.join(h.paths.agents, name);
    const file = path.join(dir, "agent.md");
    if (!fs.existsSync(file)) throw new CliError(2, `no pack agents/${name}`, "rfa agent ls");
    if (a.values.editor) return editInEditor(ctx, name, file);
    const pack = loadPack(dir);
    const changes = changesFromFlags(h, currentSettings(pack.def), a.values);
    const knowledge = a.values.knowledge !== undefined ? { source: String(a.values.knowledge), docs: a.values.docs as string | undefined } : null;
    if (!changes && !knowledge) {
      if (ctx.interactive) {
        const { runAgentEdit } = await import("../tui/agentedit.js");
        return runAgentEdit(ctx, h, name);
      }
      throw new CliError(2, `rfa agent edit ${name} needs a change on a pipe: ${EDIT_FLAGS.map((f) => `--${f}`).join(", ")}; alone on a terminal it is the walkthrough, --editor opens agent.md`);
    }
    let r: EditOutcome;
    try {
      r = await applyPackEdit(ctx, h, name, changes ?? {}, { knowledge });
    } catch (err) {
      if (err instanceof AttachError) throw new CliError(1, err.message, err.hint);
      throw new CliError(1, (err as Error).message);
    }
    if (ctx.flags.json) return void ctx.ui.json({ name, changed: r.changed, definition: { before: r.before, after: r.after }, notes: r.notes });
    for (const n of r.notes) ctx.ui.note(n);
    if (r.before === r.after) return void ctx.ui.step(`${name} unchanged: every value given is what the pack already has`);
    const sup = daemonState(h.paths.supervisorPid);
    ctx.ui.done(`${name} edited: ${r.changed.join(", ")}`, `definition ${r.before.slice(7, 15)} -> ${r.after.slice(7, 15)}`);
    ctx.ui.note(sup.alive ? "the supervisor drains the resident and respawns it on the new definition" : "nothing is running: the next rfa up reads it");
  },
};

/**
 * A missing pack name on a terminal is a pick from the packs that exist;
 * elsewhere it is the usage error.
 *
 * TOLERANT: a broken pack cannot be OFFERED (its declared name is unknown, and
 * every caller of this goes on to load the pack by that name), but it must not
 * crash the picker either. `listPacks` maps `loadPack` with no catch, so one
 * unparseable definition turned every interactive `rfa agent show`, `mode`,
 * `edit` and `reflect` into a parse error before the question was even asked.
 * Nothing is named here because a prompt is not a report: the operator who types
 * the broken pack's name explicitly gets its error loudly from the command
 * itself, and `rfa agent ls` is where the list lives.
 */
async function packArg(ctx: CliContext, h: HubDir, given: string | undefined, usage: string): Promise<string> {
  if (given) return given;
  return pickOne(ctx, "Which agent?", scanPacks(h.paths.agents).packs.map((p) => ({ value: p.name, hint: (p.def.offers ?? []).map((o) => o.id).join(", ") })), usage);
}

// ---------------------------------------------------------------- reflect

export const agentReflect: CommandDef = {
  path: ["agent", "reflect"],
  summary: "Distill the judged record (labels, gold sources, failed trials) into lessons: propose by default, --apply commits",
  usage: "<name> [--apply [<proposal file>]] [--model haiku] [--batch <n>]",
  options: { apply: { type: "boolean", default: false }, model: { type: "string" }, batch: { type: "string" } },
  why: "Consolidation (RFA-0.4 sect. 5.3) distills what was said; reflection (5.4) distills what was JUDGED: the labelling sitting's labels and gold-source corrections, human flags, failed eval and parity trials, each with what the answer actually retrieved. Without it the flywheel improves detection and never the agent: a human wrote the gold source and nothing carried it into the next answer. Propose-only by default, because a background pass that edits what shapes every answer is a behaviour change nobody reviewed: the proposal is a file under the pack's memory/proposals/ with the lessons embedded, and applying commits exactly what was reviewed, as facts, through the same gated store as consolidation (a lesson that parrots an asker's words dies at the door; lessons judged only by humans carry the human origin tag). An applied change moves behaviour like a definition change: run rfa evals parity (twice) before trusting it. Costs one or two small model calls; runs in the background account lane and defers to live work.",
  examples: ["rfa agent reflect pm-agent", "rfa agent reflect pm-agent --apply", "rfa agent reflect pm-agent --apply agents/pm-agent/memory/proposals/reflection-2026-08-24-10-30.md"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = await packArg(ctx, h, a.positionals[0], "rfa agent reflect <name>");
    if (!fs.existsSync(path.join(h.paths.agents, name, "agent.md"))) throw new CliError(2, `no pack agents/${name}`, "rfa agent ls");
    const batch = numberFlag(a.values.batch, "batch", { int: true, min: 1 });
    const applyFile = a.values.apply ? a.positionals[1] : undefined;
    if (applyFile && !fs.existsSync(applyFile)) throw new CliError(2, `no proposal at ${applyFile}`, "rfa agent reflect <name> writes one under the pack's memory/proposals/");
    const r = await reflect(name, { hubdir: h, model: a.values.model as string | undefined, batch, apply: Boolean(a.values.apply), applyFile });
    if (ctx.flags.json) return void ctx.ui.json(r);
    if (r.deferred) return void ctx.ui.step(`nothing done: ${r.deferred}`);
    if (r.incidents === 0 && !r.applied) return void ctx.ui.done(`nothing judged negatively in the ${r.scanned} feedback record(s) scanned`, "the watermark moved; the next pass starts after them");
    if (r.applied) {
      ctx.ui.done(`${name}: ${r.lessons} lesson(s) committed: +${r.applied.added} added, ~${r.applied.updated} updated, -${r.applied.invalidated} invalidated, ${r.applied.skipped} skipped`, `$${r.cost_usd.toFixed(4)}${r.proposal ? ` · ${path.relative(h.root, r.proposal)}` : ""}`);
      ctx.ui.note("a memory change moves behaviour like a definition change: run `rfa evals parity`, twice, before trusting it");
    } else {
      ctx.ui.done(`${name}: ${r.incidents} incident(s) -> ${r.lessons} lesson(s) proposed`, `$${r.cost_usd.toFixed(4)} · ${path.relative(h.root, r.proposal!)}`);
      ctx.ui.note(`review it (edit the JSON block if a lesson is wrong), then: rfa agent reflect ${name} --apply ${path.relative(process.cwd(), r.proposal!)}`);
    }
  },
};

// ---------------------------------------------------------------- mode

export const agentMode: CommandDef = {
  path: ["agent", "mode"],
  summary: "Show or set how an agent's acting tools are treated: ask, plan or bypass",
  usage: "<name> [ask|plan|bypass]",
  why: "The same idea as Claude Code's permission modes, for a resident. ask (the default) pauses every acting tool on a card you decide; plan proposes and never acts; bypass acts without asking, and the room gate, budgets, hold and quarantine still apply. An auto mode (the SDK's classifier deciding) was tried and withdrawn: it approved a gated call with no card. A mode is one line in agent.md, so changing it rotates the definition: a running supervisor drains and respawns the resident, and the room sees the digest change.",
  examples: ["rfa agent mode linear-agent", "rfa agent mode linear-agent plan", "rfa agent mode linear-agent bypass --yes"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = await packArg(ctx, h, a.positionals[0], "rfa agent mode <name> [ask|plan|bypass]");
    // The by-name rule: loud for the pack the operator NAMED, tolerant of every
    // other. `listPacks(...).find(...)` used to answer a question about
    // `pm-agent` with a Zod error from `scribe`, which is neither.
    const found = packByName(h.paths.agents, name);
    if (found.broken) throw new CliError(1, `agents/${name}/agent.md does not parse, so its mode cannot be read or set: ${found.broken.error}`, `rfa agent validate ${name}`);
    const pack = found.pack;
    if (!pack) throw new CliError(2, `no pack agents/${name}`, "rfa agent ls");
    const current = effectiveMode(pack.def);
    const wanted = a.positionals[1];
    if (!wanted) {
      if (ctx.flags.json) return void ctx.ui.json({ name, mode: current, acting: actingTools(pack.def) });
      ctx.ui.line(`${ctx.ui.bold(name)}  ${current === "bypass" ? ctx.ui.bad(current) : ctx.ui.accent(current)}${current === "read-only" ? "" : `  ${ctx.ui.dim(MODE_SUMMARY[current])}`}`);
      if (current === "read-only") ctx.ui.note("no acting tool (nothing in interrupt_on), so there is nothing a mode would change");
      else for (const m of MODES) ctx.ui.note(`${m === current ? "▸" : " "} ${m.padEnd(7)} ${MODE_SUMMARY[m]}`);
      return;
    }
    if (!isMode(wanted)) throw new CliError(2, `a mode is one of ${MODES.join(", ")}`);
    if (current === "read-only") throw new CliError(2, `${name} has no acting tool (nothing in interrupt_on); a mode would change nothing`, "rfa agent new <name> --kind tool … makes a tool user");
    if (wanted === "bypass" && !ctx.flags.yes) {
      if (!ctx.interactive) throw new CliError(2, "bypass acts without a human; pass --yes to set it without a prompt");
      const p = await import("@clack/prompts");
      const ok = await p.confirm({ message: `${name} will call ${actingTools(pack.def).join(", ") || "its acting tools"} without asking anyone. Set bypass?`, initialValue: false });
      if (p.isCancel(ok) || !ok) throw new CliError(2, "mode unchanged");
    }
    const res = setAgentMode(path.join(pack.dir, "agent.md"), wanted);
    if (ctx.flags.json) return void ctx.ui.json({ name, mode: wanted, was: current, definition: { before: res.before, after: res.after } });
    if (res.before === res.after) return void ctx.ui.step(`${name} is already in ${wanted} mode`);
    ctx.ui.done(`${name}: ${current} -> ${wanted}`, `definition ${res.before.slice(7, 15)} -> ${res.after.slice(7, 15)}; a running supervisor drains and respawns it`);
    ctx.ui.note(MODE_SUMMARY[wanted]);
  },
};

// ---------------------------------------------------------------- retire

export const agentRetire: CommandDef = {
  path: ["agent", "retire"],
  summary: "Stop, release leases, leave, evict remnants, archive, deregister: eight re-runnable steps",
  usage: "<name> [--dry-run] [--timeout 60]",
  options: { "dry-run": { type: "boolean", default: false }, timeout: { type: "string" } },
  why: "A script and not a checklist, because the documented failure mode of the checklist is that under time pressure step 1 happens and nothing else does: the resident is stopped, its sidekick keeps a membership in the roster, its card digest still answers agent_describe, and its memory sits unarchived. Every step prints and every step is re-runnable; a partial failure is fixed by running it again. Observability rows are kept: they carry the human feedback judges are trained against.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = a.positionals[0];
    if (!name || name.startsWith("-")) throw new CliError(2, "rfa agent retire <name>: the name is required and never inferred");
    const dryRun = Boolean(a.values["dry-run"]);
    const stopTimeoutMs = (numberFlag(a.values.timeout, "timeout", { min: 1 }) ?? 60) * 1000;
    const packDir = path.join(h.paths.agents, name);
    if (!fs.existsSync(packDir)) throw new CliError(2, `no pack directory agents/${name}: nothing to retire (names are case-sensitive)`);
    const defFile = path.join(packDir, "agent.md");
    const stateFile = path.join(packDir, "state", "member.json");
    const memoryDb = path.join(packDir, "state", "memory.db");
    const archive = path.join(h.paths.retired, `${name}-${new Date().toISOString().slice(0, 10)}`);
    ctx.armTransport();
    const HUB = ctx.hubUrl();
    const ui = ctx.ui;
    let step = 0;
    const say = (msg: string) => ui.line(`${++step}. ${msg}`);
    const note = (msg: string) => ui.note(msg);
    const would = (msg: string) => ui.note(`[dry-run] would ${msg}`);
    ui.line(`retiring ${ui.bold(name)}${dryRun ? " (DRY RUN: nothing is changed)" : ""}  ${ui.dim(`archive: ${path.relative(h.root, archive)}`)}`);

    // 1. stop
    const readSup = (): Record<string, { pid: number | null; status: string }> | null => {
      if (!fs.existsSync(h.paths.supervisorState)) return null;
      for (let i = 0; i < 3; i++) {
        try {
          return supervisorView(h);
        } catch {
          /* mid-write */
        }
      }
      return { [name]: { pid: -1, status: "unreadable supervisor state" } };
    };
    const stoppedIn = (s: ReturnType<typeof readSup>): boolean => !s?.[name] || s[name].pid === null;
    const residentAlive = (): boolean => residentProcessesSync().some((p) => p.agent === name && belongsTo(p, h.root));
    say(`stop ${name} through the supervisor command channel`);
    const before = readSup();
    if (!before || stoppedIn(before)) {
      const hb = path.join(packDir, "state", "heartbeat");
      const age = fs.existsSync(hb) ? Date.now() - Number(fs.readFileSync(hb, "utf8")) : null;
      if (age !== null && age < 90_000 && !dryRun && residentAlive()) {
        throw new CliError(1, `the supervisor does not own a running ${name}, but a process is (heartbeat ${Math.round(age / 1000)}s old)`, "something started this resident outside the supervisor; stop it, then run this again");
      }
      note(before ? `already stopped (${before[name]?.status ?? "not in the registry"})` : "no supervisor state: no supervisor is running, so no resident is either");
    } else if (dryRun) would(`append {action: "stop"} and wait for pid ${before[name].pid} to exit`);
    else {
      fs.appendFileSync(h.paths.supervisorCommands, JSON.stringify({ ts: new Date().toISOString(), agent: name, action: "stop", principal: "retire" }) + "\n");
      note(`stop queued; waiting up to ${Math.round(stopTimeoutMs / 1000)}s for the supervisor to drain pid ${before[name].pid}`);
      const deadline = Date.now() + stopTimeoutMs;
      let stopped = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (stoppedIn(readSup())) {
          stopped = true;
          break;
        }
      }
      if (!stopped) throw new CliError(1, `${name} is still running after ${Math.round(stopTimeoutMs / 1000)}s; retirement stops here on purpose`, "evicting and archiving under a live resident would leave it rejoining and rewriting what we archive. Check rfa logs supervisor, then run this again");
      note("stopped");
    }

    // 2. account leases
    say("release its account-layer leases (spec 18.6)");
    if (dryRun) would("delete any account_leases rows held by this agent");
    else if (fs.existsSync(h.paths.runsDb)) {
      const ledger = new AccountLedger(h.paths.runsDb);
      try {
        note(`released ${ledger.releaseAgent(name)} lease(s)`);
      } finally {
        ledger.close();
      }
    } else note("no engine database yet");

    // 3. leave
    interface Saved {
      room: string;
      join_secret: string | null;
      membership_token: string;
      member_id: string;
      name: string;
    }
    const saved: Saved | null = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as Saved) : null;
    say("leave the room with the resident's own membership");
    if (!saved) note("no state/member.json: never joined, or already retired");
    else if (dryRun) would(`room_leave ${saved.member_id} from ${saved.room}`);
    else {
      try {
        const me = await RoomMember.resume({ hubUrl: HUB, room: saved.room, membershipToken: saved.membership_token, memberId: saved.member_id, name: saved.name, clientInfo: { name: "rfa-cli", version: packageVersion() } });
        await me.leave();
        note(`left ${saved.room} as ${saved.member_id}`);
      } catch (err) {
        note(`could not leave with the saved membership (${(err as Error).message}); the eviction pass handles the remnant`);
      }
    }

    // 4. evict remnants: the resident, its sidekick, and suffixed retries
    const REMNANT = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-hitl)?(-\\d+)?$`);
    interface Meta {
      handle: string;
      ended: boolean;
      joinSecret: string | null;
      members: { id: string; name: string; present: boolean; isHost: boolean }[];
    }
    const remnants = new Map<string, { meta: Meta; members: Meta["members"] }>();
    if (fs.existsSync(h.paths.roomLogs)) {
      for (const f of fs.readdirSync(h.paths.roomLogs).filter((x) => x.endsWith(".meta.json"))) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(h.paths.roomLogs, f), "utf8")) as Meta;
          if (meta.ended) continue;
          const members = (meta.members ?? []).filter((m) => m.present && REMNANT.test(m.name));
          if (members.length) remnants.set(meta.handle, { meta, members });
        } catch {
          /* snapshot mid-write */
        }
      }
    }
    say(`evict remnants (${name}, ${name}-hitl, and suffixed retries) with room_admin`);
    const humanKey = ctx.humanKey();
    if (remnants.size === 0) note("no present membership left under that name in any live room");
    else if (!humanKey) throw new CliError(3, "room_admin needs the operator's human key and .rfa/secrets.json holds none", `remnants left behind: ${[...remnants].map(([r, v]) => `${r}: ${v.members.map((m) => m.name).join(", ")}`).join(" | ")}`);
    else {
      for (const [room, { meta, members }] of remnants) {
        if (dryRun) {
          would(`join ${room} as a human supervisor and evict ${members.map((m) => `${m.name} (${m.id})`).join(", ")}`);
          continue;
        }
        const recorded = roomsStore(h).read().rooms.find((r) => r.handle === room);
        let operator: RoomMember;
        try {
          operator = await RoomMember.create({
            hubUrl: HUB,
            room,
            joinSecret: meta.joinSecret ?? recorded?.join_secret ?? saved?.join_secret ?? undefined,
            name: "retire",
            role: "supervisor",
            humanKey,
            card: { name: "retire", description: `operator retiring ${name}` },
            clientInfo: { name: "rfa-cli", version: packageVersion() },
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
              note(`${room}: ${m.name} (${m.id}) NOT evicted: ${(err as Error).message}${m.isHost ? " (it hosts this room; its own leave is the exit)" : ""}`);
            }
          }
        } finally {
          await operator.leave().catch(() => {});
        }
      }
    }

    // 5. memory
    say("archive state/memory.db (archived, never deleted)");
    if (!fs.existsSync(memoryDb)) note("no memory.db: nothing to archive");
    else if (dryRun) would(`back up ${path.relative(h.root, memoryDb)} to ${path.relative(h.root, path.join(archive, "memory.db"))}`);
    else {
      const dest = path.join(archive, "memory.db");
      if (fs.existsSync(dest)) note(`${path.relative(h.root, dest)} already exists; keeping the earlier archive`);
      else {
        fs.mkdirSync(archive, { recursive: true });
        // db.backup(), not copyFile: a WAL database is three files, and a plain copy
        // of the .db alone silently drops everything still in the -wal.
        const db = new Database(memoryDb, { readonly: true });
        try {
          await db.backup(dest);
        } finally {
          db.close();
        }
        note(`archived ${(fs.statSync(dest).size / 1024).toFixed(0)}KB to ${path.relative(h.root, dest)}`);
      }
    }

    // 6. the identity
    say("archive state/member.json so the identity cannot be resumed");
    if (!fs.existsSync(stateFile)) note("no member.json: this pack never joined a room");
    else if (dryRun) would(`move ${path.relative(h.root, stateFile)} into the archive`);
    else {
      // A safety property, not tidiness: a LATER pack of the same name would
      // otherwise inherit a retired agent's identity and speak as it.
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(stateFile, path.join(archive, "member.json"));
      note(`moved to ${path.relative(h.root, path.join(archive, "member.json"))}; a future pack of this name starts as a new member`);
    }

    // 7. observability rows stay
    say("keep the observability rows in obs.db");
    if (!fs.existsSync(h.paths.obsDb)) note("no obs.db");
    else {
      const db = new Database(h.paths.obsDb, { readonly: true });
      try {
        const like = `%:${name}`;
        const runs = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE name LIKE ?`).get(like) as { n: number }).n;
        const scored = (db.prepare(`SELECT COUNT(DISTINCT f.run_id) AS n FROM feedback f JOIN runs r ON r.id = f.run_id WHERE r.name LIKE ?`).get(like) as { n: number }).n;
        note(`${runs} run row(s), ${scored} carrying feedback: KEPT (they are the evidence trail; retention prunes on its own schedule)`);
      } catch (err) {
        note(`could not count obs rows (${(err as Error).message}); nothing was deleted`);
      } finally {
        db.close();
      }
    }

    // 8. the definition
    say("move the pack aside (agent.md, knowledge, memory, skills, evals) so the card digest leaves every roster and the name is free again");
    // The WHOLE folder goes, not only agent.md: a folder left behind without a
    // definition is invisible to the supervisor but blocks `rfa agent new` under
    // the same name, which is exactly what the owner hit on the first retire.
    if (!fs.existsSync(packDir)) note("already moved aside");
    else if (dryRun) would(`move ${path.relative(h.root, packDir)}/ to ${path.relative(h.root, archive)}/pack/`);
    else {
      fs.mkdirSync(archive, { recursive: true });
      if (fs.existsSync(defFile)) fs.renameSync(defFile, path.join(archive, "agent.md"));
      let dest = path.join(archive, "pack");
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(archive, `pack-${n}`);
      fs.renameSync(packDir, dest);
      note(`moved to ${path.relative(h.root, archive)}/ (agent.md beside ${path.basename(dest)}/); the supervisor drops it from the registry on its next reconcile`);
    }
    ui.blank();
    ui.line(dryRun ? `dry run complete: nothing changed. Run again without --dry-run to retire ${name}.` : `${ui.bold(name)} is retired. Its memory and definition are in ${path.relative(h.root, archive)}; its observability rows and human feedback stay in obs.db.`);
    if (!dryRun) ui.note("secrets need no revocation: the supervisor injects only the names a definition declares, so moving the definition ended injection");
  },
};
