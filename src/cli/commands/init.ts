/**
 * `rfa init` (RFA-0.7 sect. 4): an empty folder becomes a hub directory, with
 * the three parts explained, the credentials minted, a first agent, a room,
 * and the thing running, in under two minutes on a machine with a logged-in
 * `claude`.
 *
 * Rules it obeys: every question has a flag and `--yes` takes every default;
 * re-running is safe (an existing manifest is read, not overwritten; a
 * credential is never rotated without --force; an existing agent or room is left
 * alone and reported); no credential is printed except once, at the end, after
 * everything that could have failed; and on a pipe the same lines print without
 * prompts or spinners.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tokenDigest } from "../../credentials.js";
import {
  defaultManifest,
  detectLegacyLayout,
  ensureRuntime,
  loadHubDir,
  MANIFEST_FILE,
  principalsStore,
  roomsStore,
  secretsStore,
  tokensStore,
  writeManifest,
  type HubDir,
  type RoomRecord,
} from "../../hubdir.js";
import { packageFile, packageVersion } from "../../pkg.js";
import { principalRecordFor } from "../../principals.js";
import { CliError, numberFlag, type CliContext } from "../context.js";
import { openHubCall } from "../hubaccess.js";
import { blocksProvisioning, checkEnvironment, realProbe } from "../environment.js";
import { credentialAdvice, modelCredentialStatus, portFree } from "../preflight.js";
import type { CommandDef } from "../router.js";
import { builtinTool, nameProblem, PACK_KINDS, scaffoldPack, type PackKind, type ToolSpec } from "../scaffold.js";
import { firstAsk } from "../tui/data.js";
import { upAll } from "./procs.js";

const token = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

export const GITIGNORE = fs.existsSync(packageFile("templates", "gitignore")) ? fs.readFileSync(packageFile("templates", "gitignore"), "utf8") : ".rfa/\nagents/*/state/\n";

export interface InitAnswers {
  mode: "hub" | "remote";
  name: string;
  port: number;
  hubUrl?: string;
  remoteToken?: string;
  human: string;
  agentKind: PackKind | "none";
  agentName: string;
  knowledge?: string;
  room: string;
  topic: string;
  roomHandle?: string;
  /** For a tool user: the MCP server it acts through and the tool id that pauses for a human. */
  toolServer?: ToolSpec;
  start: boolean;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "hub";
}

/** Record a room the CLI created: alias, handle, secret and the operator's own membership. */
export async function createRoomRecord(ctx: CliContext, h: HubDir, alias: string, topic: string, opts: { history?: "member" | "joined_after"; mode?: "open" | "sequential" | "moderator" } = {}): Promise<RoomRecord> {
  const rooms = roomsStore(h);
  const existing = rooms.read().rooms.find((r) => r.alias === alias);
  if (existing) return existing;
  const secrets = secretsStore(h).read();
  const humanKey = secrets.RFA_HUMAN_KEY;
  const label = principalsStore(h).read().principals[0]?.label ?? "operator";
  const call = await openHubCall(ctx);
  try {
    const res = (await call.call("room_create", {
      topic,
      name: label,
      card: { name: label, description: "the operator, from the rfa CLI", skills: [{ id: "operate", description: "creates rooms, asks, decides" }] },
      policies: {
        history_visibility: opts.history ?? "joined_after",
        ...(opts.mode ? { mode: opts.mode } : {}),
        // Bearer-implied admission (wire 4.3): every holder of the operator bearer
        // joins without a secret, so residents and this CLI never paste one.
        ...(secrets.RFA_TOKEN ? { join_bearer_sha256: [tokenDigest(secrets.RFA_TOKEN)] } : {}),
      },
      ...(humanKey ? { human_key: humanKey } : {}),
    })) as { room: string; join_secret: string | null; you: { id: string; membership_token: string; name: string; role: "participant" | "observer" | "supervisor" } };
    const record: RoomRecord = {
      alias,
      handle: res.room,
      topic,
      join_secret: res.join_secret ?? null,
      operator: { member_id: res.you.id, membership_token: res.you.membership_token, name: res.you.name, role: res.you.role, host: true },
      created_at: new Date().toISOString(),
    };
    rooms.update((f) => {
      f.rooms.push(record);
    });
    return record;
  } finally {
    await call.close();
  }
}

/** Wait until a member of that name is present and ready in the room, polling the roster with the operator membership. */
export async function waitForReady(ctx: CliContext, room: RoomRecord, memberName: string, timeoutMs: number): Promise<{ ready: boolean; state: string | null }> {
  const { rawCall } = await import("../../client.js");
  ctx.armTransport();
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    try {
      const res = (await rawCall(ctx.hubUrl(), { name: "rfa-cli", version: packageVersion() }, "room_roster", { room: room.handle, membership_token: room.operator!.membership_token })) as { roster: { name: string; state: string }[] };
      const m = res.roster.find((r) => r.name === memberName);
      last = m?.state ?? null;
      if (m && m.state === "ready") return { ready: true, state: "ready" };
    } catch {
      /* the hub may still be coming up */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ready: false, state: last };
}

/** Where provisioning reports: the text UI on the command line, the checklist in the onboarding. */
export interface Reporter {
  done(what: string, detail?: string): void;
  step(what: string, detail?: string): void;
  warn(what: string, detail?: string): void;
  note(...lines: string[]): void;
  blank(): void;
}

export interface ProvisionResult {
  h: HubDir;
  minted: { human?: string };
  agent: { name: string; skillId: string } | null;
  room: RoomRecord | null;
  ready: { ready: boolean; state: string | null } | null;
}

export interface ProvisionOptions {
  report: Reporter;
  /** Rotate credentials that already exist (locks out every holder of the old ones). */
  force?: boolean;
  /** The room alias was given explicitly, so the room is created even for a directory with no agent. */
  roomGiven?: boolean;
  /** No screen and nobody to ask: a tool pack that needs a server is warned about, not built. */
  headless?: boolean;
}

/**
 * The answers with no screen: flags first, then the directory's own state, then
 * the defaults. On an existing directory the defaults ARE its state, so a
 * re-run without flags adds nothing (a third room once appeared this way).
 */
export async function defaultAnswers(ctx: CliContext, a: Record<string, string | boolean | undefined>, target: string, existing: HubDir | null): Promise<InitAnswers> {
  const fromFlags: Partial<InitAnswers> = {
    mode: a["hub-url"] ? "remote" : existing ? existing.mode : undefined,
    name: (a.name as string | undefined) ?? existing?.manifest.name,
    port: a.port ? Number(a.port) : existing && "port" in existing.manifest.hub ? existing.manifest.hub.port : undefined,
    hubUrl: (a["hub-url"] as string | undefined) ?? (existing && "url" in existing.manifest.hub ? existing.manifest.hub.url : undefined),
    remoteToken: a.token as string | undefined,
    human: a.human as string | undefined,
    agentKind: a.agent as PackKind | "none" | undefined,
    agentName: a["agent-name"] as string | undefined,
    knowledge: a.knowledge as string | undefined,
    room: a.room as string | undefined,
    topic: a.topic as string | undefined,
    roomHandle: a["room-handle"] as string | undefined,
    toolServer: toolServerFromFlags(a),
    start: a.start as boolean | undefined,
  };
  const existingRooms = existing ? roomsStore(existing).read().rooms.filter((r) => r.alias !== "ops") : [];
  const existingPacks = existing && fs.existsSync(existing.paths.agents) ? fs.readdirSync(existing.paths.agents).filter((d) => fs.existsSync(path.join(existing.paths.agents, d, "agent.md"))) : [];
  return {
    mode: fromFlags.mode ?? "hub",
    name: fromFlags.name ?? slug(path.basename(target)),
    port: fromFlags.port ?? 8790,
    hubUrl: fromFlags.hubUrl,
    remoteToken: fromFlags.remoteToken,
    human: fromFlags.human ?? (slug(ctx.env.USER ?? os.userInfo().username ?? "operator").replace(/[.-]+$/, "") || "operator"),
    agentKind: fromFlags.agentKind ?? (existingPacks.length > 0 ? "none" : "spec-expert"),
    agentName: fromFlags.agentName ?? (fromFlags.agentKind && fromFlags.agentKind !== "none" ? fromFlags.agentKind : "spec-expert"),
    knowledge: fromFlags.knowledge,
    room: fromFlags.room ?? existingRooms[0]?.alias ?? "main",
    topic: fromFlags.topic ?? "questions and work for this hub's agents",
    roomHandle: fromFlags.roomHandle,
    toolServer: fromFlags.toolServer,
    start: fromFlags.start ?? true,
  };
}

/** `--server linear --command 'rfa server linear' --tool save_document`, the same three flags `rfa agent new` takes. */
export function toolServerFromFlags(a: Record<string, string | boolean | undefined>): InitAnswers["toolServer"] {
  const server = a.server as string | undefined;
  const command = a.command as string | undefined;
  const tool = a.tool as string | undefined;
  const builtin = a.builtin as string | undefined;
  if (builtin) return builtinTool(builtin, tool, server);
  if (!server || !command || !tool) return undefined;
  const [cmd, ...args] = command.trim().split(/\s+/);
  return { server, command: cmd, args, tool };
}

/**
 * Write the hub directory from a set of answers. The one implementation behind
 * the onboarding and `rfa init --yes`: credentials minted once, the gate and
 * the gitignore, rooms, the first agent bound to one, the stack started and
 * the agent waited for. Asking the first question is the caller's.
 */
export async function provision(ctx: CliContext, target: string, answers: InitAnswers, opts: ProvisionOptions): Promise<ProvisionResult> {
  const ui = opts.report;
  const manifestFile = path.join(target, MANIFEST_FILE);
  let existing: HubDir | null = fs.existsSync(manifestFile) ? loadHubDir(target) : null;
  const minted: { human?: string } = {};

  // 1. the manifest
  if (!existing) {
    const manifest = answers.mode === "remote" ? defaultManifest({ name: answers.name, url: answers.hubUrl }) : defaultManifest({ name: answers.name, port: answers.port });
    writeManifest(target, manifest);
    ui.done(`${MANIFEST_FILE}`, "the manifest. Commit it.");
  }
  ctx.flags.dir = target;
  ctx.reset();
  const h = ctx.hubdir();
  existing = h;
  ensureRuntime(h);

  // 2. credentials, minted once
  const secrets = secretsStore(h);
  const tokens = tokensStore(h);
  const principals = principalsStore(h);
  const current = secrets.read();
  if (h.mode === "hub") {
    if (!current.RFA_TOKEN || opts.force) {
      const t = token("tok");
      secrets.update((s) => {
        s.RFA_TOKEN = t;
      });
      tokens.update((f) => {
        f.tokens = f.tokens.filter((x) => x.label !== "operator");
        f.tokens.push({ id: `tk_${tokenDigest(t).slice(0, 12)}`, label: "operator", kind: "operator", sha256: tokenDigest(t), created_at: new Date().toISOString(), expires_at: null });
      });
      ui.done(".rfa/secrets.json  (0600)", "RFA_TOKEN, the bearer your agents and this CLI use to reach the hub");
    } else ui.step(".rfa/secrets.json already holds RFA_TOKEN", "left alone (--force rotates it, which locks out every agent holding it)");
  } else {
    if (answers.remoteToken) {
      secrets.update((s) => {
        s.RFA_TOKEN = answers.remoteToken!;
      });
      ui.done(".rfa/secrets.json  (0600)", "RFA_TOKEN, the bearer the far hub's operator gave you");
    } else if (!current.RFA_TOKEN) ui.warn("no bearer for the far hub", "rfa secrets set RFA_TOKEN once its operator gives you one (rfa peer add there)");
  }
  if (!current.RFA_HUMAN_KEY || opts.force) {
    const key = token("hk");
    secrets.update((s) => {
      s.RFA_HUMAN_KEY = key;
    });
    principals.update((f) => {
      f.principals = f.principals.filter((x) => x.label !== answers.human);
      f.principals.push(principalRecordFor(key, answers.human));
    });
    minted.human = key;
    ui.done(`.rfa/principals.json, .rfa/tokens.json`, "hashes only; plaintext never rests there");
    ui.done(`human principal ${answers.human}`, "shown once, at the end");
  } else ui.step(`human principal already minted`, "left alone (--force rotates it)");
  if (!tokens.exists()) tokens.write({ version: 1, tokens: [] });
  if (!principals.exists()) principals.write({ version: 1, principals: [] });

  // 3. the gate and the gitignore
  if (h.paths.gate && !fs.existsSync(h.paths.gate)) {
    fs.mkdirSync(path.dirname(h.paths.gate), { recursive: true });
    fs.copyFileSync(packageFile("templates", "gate.json"), h.paths.gate);
    ui.done("policies/gate.json", "three default rules: alert on injection markers, refuse private keys, hold on a review marker");
  }
  // The eval corpus a new instance starts from:
  //
  //  - the versioned judge rubric, so `--judged` has a rubric whose sha is on
  //    every judge row;
  //  - ONE tenant-neutral REPLAY case over the protocol itself, active, so
  //    `rfa evals run` has something true to score on day one with no room, no
  //    resident, no credential and no money;
  //  - one live-concurrent PAIR case shipped as `case.yaml.example`, inert until
  //    the operator renames it to `case.yaml`. It is the only case shape that can
  //    catch two conversations bleeding into each other, and it needs a room, a
  //    running resident and a credential: 8 live answers per run, roughly 0.22
  //    dollars. Seeding it active would have made a fresh hub's first
  //    `rfa evals run` exit 3 for want of a room, including with
  //    --update-baseline, which is the day-one baseline flow.
  //
  // NOT a baseline: a baseline is MEASURED (the gate's own rule is that one
  // captured while the stack was unhealthy is vacuous), so the first
  // `rfa evals run --update-baseline` writes it.
  const seededEvals: string[] = [];
  for (const [from, to] of [
    [packageFile("templates", "evals", "rubric.md"), h.paths.evalRubric],
    [packageFile("templates", "evals", "cases"), h.paths.evalCases],
  ]) {
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    seededEvals.push(path.relative(h.root, to));
  }
  if (seededEvals.length) {
    ui.done(
      seededEvals.join(", "),
      "the judge rubric, one protocol replay case that scores with no room or credential, and a live concurrent-pair case shipped as case.yaml.example (rename it to case.yaml to run it: 8 live answers, about $0.22 per run)",
    );
    ui.note("rfa evals run scores the replay case now; --update-baseline measures the first baseline.");
  }
  if (!fs.existsSync(h.paths.gitignore) || !fs.readFileSync(h.paths.gitignore, "utf8").includes(".rfa/")) {
    const prev = fs.existsSync(h.paths.gitignore) ? fs.readFileSync(h.paths.gitignore, "utf8") : "";
    fs.writeFileSync(h.paths.gitignore, (prev && !prev.endsWith("\n") ? prev + "\n" : prev) + GITIGNORE);
    ui.done(".gitignore", ".rfa/, agents/*/state/, knowledge clones");
  }
  fs.mkdirSync(h.paths.agents, { recursive: true });

  // 4. the model credential
  const cred = modelCredentialStatus(ctx.env);
  if (cred.ok === true) ui.done(`model credential`, `${cred.detail}. Agents inherit it from the shell that runs rfa up.`);
  else {
    ui.warn(`model credential: ${cred.detail}`);
    ui.note(...credentialAdvice(cred));
  }

  // 5. rooms, then the first agent bound to one
  let room: RoomRecord | null = null;
  if (h.mode === "hub") {
    if (answers.agentKind !== "none" || answers.room !== "main" || opts.roomGiven) {
      room = await createRoomRecord(ctx, h, answers.room, answers.topic);
      ui.done(`room ${answers.room}  ${room.handle}`, "you host it. Agents join it with the bearer above; there is no secret to paste.");
    }
    const ops = await createRoomRecord(ctx, h, "ops", "#ops: platform alerts (error rate, latency, feedback), backups, retention");
    ui.done(`room ops  ${ops.handle}`, "the supervisor posts alerts, the nightly backup and the daily review digest here");
  }
  let agent: { name: string; skillId: string } | null = null;
  if (answers.agentKind !== "none") {
    const dir = path.join(h.paths.agents, answers.agentName);
    if (fs.existsSync(path.join(dir, "agent.md"))) ui.step(`agents/${answers.agentName} already exists`, "left alone");
    else if (answers.agentKind === "tool" && !answers.toolServer) {
      ui.warn("a tool user needs the MCP server it acts through; nothing scaffolded", "rfa agent new <name> --kind tool --server <name> --command <cmd> --tool <id>");
    } else {
      const handle = room?.handle ?? answers.roomHandle ?? null;
      const res = scaffoldPack(h, { name: answers.agentName, kind: answers.agentKind, room: handle, knowledge: answers.knowledge, tool: answers.toolServer });
      agent = { name: answers.agentName, skillId: res.skillId };
      ui.done(`agents/${answers.agentName}/agent.md`, `definition ${res.definitionHash.slice(7, 15)} · 1 offer: ${res.skillId}${handle ? "" : " · NOT bound to a room yet"}`);
      ui.note("the pack is a folder: agent.md, knowledge/, memory/, skills/, evals/. rfa agent show lists it.");
    }
  }

  // 6. start
  let ready: { ready: boolean; state: string | null } | null = null;
  if (answers.start) {
    ui.blank();
    const up = await upAll(ctx);
    if (up.hub) ui.done(`hub ${up.hub.started ? "started" : "already running"}`, `pid ${up.hub.pid} · ${h.hubUrl}`);
    if (up.supervisor) ui.done(`supervisor ${up.supervisor.started ? "started" : "already running"}`, `pid ${up.supervisor.pid}`);
    if (agent && room) {
      ui.step(`waiting for ${agent.name} to join ${answers.room}`, "a resident boots, joins with the bearer and heartbeats; up to two minutes the first time");
      ready = await waitForReady(ctx, room, agent.name, 120_000);
      if (ready.ready) ui.done(`${agent.name} is ready in ${answers.room}`);
      else ui.warn(`${agent.name} is ${ready.state ?? "not in the room yet"} after 120s`, `rfa logs ${agent.name}`);
    }
  }
  return { h, minted, agent, room, ready };
}

export const init: CommandDef = {
  path: ["init"],
  summary: "Create a hub directory here, interactively or from flags",
  usage: "[--yes] [--name] [--port] [--human] [--agent spec-expert|answerer|tool|none] [--agent-name] [--knowledge <dir>] [--server <name> --command <cmd> --tool <id> | --builtin linear] [--room <alias>] [--topic] [--no-start] [--ask <question>] [--hub-url <url> --token <bearer> --room-handle <r_…>] [--force]",
  why: "This folder becomes a hub directory: rfa.json (the manifest), agents/ (one folder per agent, a markdown file each), policies/ (the gate), and a gitignored .rfa/ the tool owns. Credentials are minted once and shown once. On a terminal this is the onboarding, one question per screen with the reason beside it; with --yes or on a pipe the same provisioning runs from flags and defaults with no question at all. The first agent offered answers about the protocol from the spec shipped in this package, so the first answer needs nothing but a logged-in claude.",
  options: {
    name: { type: "string" },
    port: { type: "string" },
    human: { type: "string" },
    agent: { type: "string" },
    "agent-name": { type: "string" },
    knowledge: { type: "string" },
    room: { type: "string" },
    topic: { type: "string" },
    "room-handle": { type: "string" },
    "hub-url": { type: "string" },
    token: { type: "string" },
    server: { type: "string" },
    command: { type: "string" },
    builtin: { type: "string" },
    tool: { type: "string" },
    start: { type: "boolean", default: true },
    force: { type: "boolean", default: false },
    ask: { type: "string" },
  },
  examples: ["rfa init", "rfa init --yes --name acme --port 8790 --human paul", "rfa init --yes --no-start --agent none", "rfa init --hub-url https://rfa.acme.example/mcp --token <bearer> --room-handle r_… --agent answerer"],
  run: async (ctx, a) => {
    const ui = ctx.ui;
    const target = path.resolve(ctx.flags.dir ?? process.cwd());
    fs.mkdirSync(target, { recursive: true });
    const manifestFile = path.join(target, MANIFEST_FILE);
    const existing: HubDir | null = fs.existsSync(manifestFile) ? loadHubDir(target) : null;
    if (!existing) {
      const legacy = detectLegacyLayout(target);
      if (legacy) throw new CliError(3, `${target} has the pre-0.7 layout (${legacy.found.join(", ")})`, "rfa migrate --dry-run shows the move; rfa migrate performs it");
    }
    const agentFlag = a.values.agent as string | undefined;
    if (agentFlag && !PACK_KINDS.includes(agentFlag as PackKind) && agentFlag !== "none") throw new CliError(2, `--agent takes ${PACK_KINDS.join(", ")} or none`);
    numberFlag(a.values.port, "port", { int: true, min: 1, max: 65535 });

    if (ctx.interactive) {
      const { runOnboarding } = await import("../tui/index.js");
      return runOnboarding(ctx, { target, existing, flags: a.values });
    }

    if (!ctx.flags.json && !ctx.flags.quiet) {
      ui.box([ui.bold("rfa · Rooms for Agents") + `  ${ui.dim(packageVersion())}`, "", "One room. Agents from more than one place. One log you", "can verify. One human who can stop it."]);
      ui.blank();
    }
    // The machine first, as the onboarding's first screen does.
    const env = checkEnvironment(realProbe(ctx.env));
    for (const c of env) {
      if (c.verdict === "ok") ui.done(c.text);
      else if (c.verdict === "warn") ui.warn(c.text, c.fix);
      else if (c.verdict === "fail") ui.fail(c.text, c.fix);
    }
    const blocking = env.filter(blocksProvisioning);
    if (blocking.length) throw new CliError(3, `${blocking.length} check${blocking.length === 1 ? "" : "s"} must pass before anything is written`, blocking.map((c) => c.fix).filter(Boolean).join("; "));
    const answers = await defaultAnswers(ctx, a.values, target, existing);
    if (answers.mode === "hub" && !(await portFree(answers.port)) && !(await ctx.healthz())) throw new CliError(3, `port ${answers.port} is in use by something that is not this hub`, "pass --port, or stop what holds it");
    const r = await provision(ctx, target, answers, { report: ui, force: Boolean(a.values.force), roomGiven: Boolean(a.values.room), headless: true });

    // The first question, when --ask gives one and someone is there to answer it.
    let firstAnswer: { kind: string; text: string; elapsed_s: number; cost_usd: number | null } | null = null;
    const q = a.values.ask as string | undefined;
    if (r.ready?.ready && r.agent && r.room && q?.trim()) {
      const sp = ui.spinner(`asking ${r.agent.name}`);
      try {
        const out = await firstAsk(ctx, r.room, r.agent.skillId, q.trim());
        firstAnswer = { kind: out.kind, text: out.text, elapsed_s: Number((out.elapsed_ms / 1000).toFixed(1)), cost_usd: out.cost_usd };
        sp.stop({ ok: out.kind === "response", text: out.kind === "response" ? `${r.agent.name} answered` : `${r.agent.name} refused: ${out.refusal}`, detail: `${firstAnswer.elapsed_s}s${out.cost_usd != null ? ` · $${out.cost_usd}` : ""}${out.run_id ? ` · ${out.run_id}` : ""}` });
        ui.blank();
        for (const line of out.text.split("\n")) ui.line(`   ${line}`);
      } catch (err) {
        sp.stop({ ok: false, text: `the ask failed: ${(err as Error).message}` });
      }
    }

    ui.blank();
    ui.line(`   ${ui.bold("Your hub directory is ready.")}${answers.start ? "" : " Nothing is running yet."}`);
    ui.blank();
    const next: string[][] = [];
    if (!answers.start) next.push(["rfa up", "start the hub and the supervisor"]);
    next.push(["rfa", "the dashboard: status, agents, rooms, approvals, the live feed"]);
    if (r.agent) next.push([`rfa ask "…"`, `ask by capability, from anywhere in this folder`]);
    next.push(["rfa agent new <name>", "another agent"]);
    next.push(["rfa connect claude-code", "let your Claude Code sessions ask this hub"]);
    next.push(["rfa completion zsh --install", "tab completion for the long commands"]);
    next.push(["rfa service install", "keep it running across reboots"]);
    ui.table(next.map(([c, d]) => [ui.accent(c), ui.dim(d)]), { indent: 5 });
    if (r.minted.human) {
      ui.blank();
      ui.line(`   Your human key, shown once (rfa human rotate ${answers.human} if you lose it):`);
      ui.blank();
      ui.line(`     ${ui.bold(r.minted.human)}`);
      ui.blank();
      ui.line(`   ${ui.dim("It unlocks the console and is the only thing that can approve. This CLI keeps its own copy in .rfa/secrets.json.")}`);
    }
    if (ctx.flags.json) ui.json({ dir: r.h.root, name: r.h.manifest.name, mode: r.h.mode, hub_url: r.h.hubUrl, agent: r.agent?.name ?? null, room: r.room?.handle ?? null, started: answers.start, ready: r.ready?.ready ?? null, first_answer: firstAnswer, human_key: r.minted.human ?? null });
  },
};
