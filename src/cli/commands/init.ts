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
import { RoomMember } from "../../client.js";
import { CliError, type CliContext } from "../context.js";
import { openHubCall } from "../hubaccess.js";
import { credentialAdvice, modelCredentialStatus, nextFreePort, portFree } from "../preflight.js";
import type { CommandDef } from "../router.js";
import { nameProblem, PACK_KINDS, scaffoldPack, type PackKind } from "../scaffold.js";
import { upAll } from "./procs.js";

const token = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

export const GITIGNORE = fs.existsSync(packageFile("templates", "gitignore")) ? fs.readFileSync(packageFile("templates", "gitignore"), "utf8") : ".rfa/\nagents/*/state/\n";

type Prompts = typeof import("@clack/prompts");

interface InitAnswers {
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

async function gather(ctx: CliContext, a: Record<string, string | boolean | undefined>, target: string, existing: HubDir | null): Promise<InitAnswers> {
  const ui = ctx.ui;
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
    start: a.start as boolean | undefined,
  };
  // On an existing directory the defaults are the directory's own state, so a
  // re-run without flags adds nothing: the first room it already has, no second
  // first agent. (Found by the test that re-ran init: a third room appeared.)
  const existingRooms = existing ? roomsStore(existing).read().rooms.filter((r) => r.alias !== "ops") : [];
  const existingPacks = existing && fs.existsSync(existing.paths.agents) ? fs.readdirSync(existing.paths.agents).filter((d) => fs.existsSync(path.join(existing.paths.agents, d, "agent.md"))) : [];
  const defaults: InitAnswers = {
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
    start: fromFlags.start ?? true,
  };
  if (!ctx.interactive) {
    if (defaults.mode === "hub" && !(await portFree(defaults.port)) && !(await ctx.healthz())) throw new CliError(3, `port ${defaults.port} is in use by something that is not this hub`, "pass --port, or stop what holds it");
    return defaults;
  }
  const p: Prompts = await import("@clack/prompts");
  const cancel = (): never => {
    p.cancel("nothing written beyond what is listed above");
    process.exit(2);
  };
  const pick = async <T,>(v: T | symbol): Promise<T> => {
    if (p.isCancel(v)) cancel();
    return v as T;
  };
  const answers = { ...defaults };
  if (!existing) {
    answers.mode = await pick(
      await p.select({
        message: "Run a hub here, or host agents for a hub that runs elsewhere?",
        options: [
          { value: "hub", label: "Run a hub here", hint: "the room server, the supervisor and the agents, all in this folder" },
          { value: "remote", label: "Connect to a hub elsewhere", hint: "you will need its URL and a bearer from its operator" },
        ],
        initialValue: answers.mode,
      }),
    );
    answers.name = await pick(
      await p.text({
        message: "Name this hub",
        initialValue: answers.name,
        validate: (v) => (/^[a-z0-9][a-z0-9.-]{0,63}$/.test(v ?? "") ? undefined : "lowercase letters, digits, dots and hyphens; must start with a letter or digit"),
      }),
    );
    if (answers.mode === "hub") {
      const free = await portFree(answers.port);
      const suggested = free ? answers.port : await nextFreePort(answers.port + 1);
      answers.port = Number(
        await pick(
          await p.text({
            message: `Port${free ? "" : ` (${answers.port} is taken)`}`,
            initialValue: String(suggested),
            validate: (v) => (/^\d+$/.test(v ?? "") && Number(v) > 0 && Number(v) < 65536 ? undefined : "a port number"),
          }),
        ),
      );
    } else {
      answers.hubUrl = await pick(await p.text({ message: "The hub's /mcp URL", initialValue: answers.hubUrl ?? "https://", validate: (v) => (/^https?:\/\/.+\/mcp\/?$/.test(v ?? "") ? undefined : "an http(s) URL ending in /mcp") }));
      answers.remoteToken = await pick(await p.password({ message: "The bearer its operator gave you (rfa peer add there)", validate: (v) => (v && v.length >= 16 ? undefined : "a bearer is at least 16 characters") }));
    }
  }
  ui.note(`your human principal: the only thing that can approve an agent's action or lift a quarantine`);
  answers.human = await pick(
    await p.text({
      message: "Your name",
      initialValue: answers.human,
      validate: (v) => (nameProblem(v ?? "") ?? (/^[a-z0-9][a-z0-9.-]*$/.test(v ?? "") ? undefined : "lowercase letters, digits, dots and hyphens")),
    }),
  );
  answers.agentKind = await pick(
    await p.select({
      message: "Your first agent?",
      options: [
        { value: "spec-expert", label: "spec-expert", hint: "answers about the RFA protocol from the spec shipped in this package; works with nothing else" },
        { value: "answerer", label: "an answerer", hint: "answers from a folder of markdown you point it at" },
        { value: "tool", label: "a tool user", hint: "acts on requests, behind your approval, with an MCP server you name" },
        { value: "none", label: "none yet" },
      ],
      initialValue: answers.agentKind,
    }),
  );
  if (answers.agentKind !== "none") {
    answers.agentName = await pick(await p.text({ message: "Name it", initialValue: answers.agentKind === "spec-expert" ? "spec-expert" : answers.agentName === "spec-expert" ? "" : answers.agentName, validate: (v) => nameProblem(v ?? "") ?? undefined }));
    if (answers.agentKind === "answerer") {
      const k = await pick(await p.text({ message: "A folder of markdown it should answer from (blank to fill knowledge/ later)", placeholder: "./docs" }));
      answers.knowledge = k?.trim() ? k.trim() : undefined;
    }
    if (answers.mode === "hub") {
      ui.note("rooms are the isolation unit: everyone in a room sees everything in it");
      answers.room = await pick(await p.text({ message: "A room for it", initialValue: answers.room, validate: (v) => (/^[a-z0-9][a-z0-9-]{0,31}$/.test(v ?? "") ? undefined : "an alias: lowercase letters, digits, hyphens") }));
    } else {
      answers.roomHandle = await pick(await p.text({ message: "The room handle its operator gave you", placeholder: "r_0123456789", validate: (v) => (/^r_[a-f0-9]+$/.test(v ?? "") ? undefined : "r_ plus hex") }));
    }
  }
  answers.start = await pick(await p.confirm({ message: answers.mode === "hub" ? "Start the hub and the supervisor now?" : "Start the supervisor now?", initialValue: answers.start }));
  return answers;
}

export const init: CommandDef = {
  path: ["init"],
  summary: "Create a hub directory here, interactively or from flags",
  usage: "[--yes] [--name] [--port] [--human] [--agent spec-expert|answerer|tool|none] [--agent-name] [--knowledge <dir>] [--room <alias>] [--topic] [--no-start] [--ask <question>] [--hub-url <url> --token <bearer> --room-handle <r_…>] [--force]",
  why: "This folder becomes a hub directory: rfa.json (the manifest), agents/ (one folder per agent, a markdown file each), policies/ (the gate), and a gitignored .rfa/ the tool owns. Credentials are minted once and shown once. The first agent offered answers about the protocol from the spec shipped in this package, so the first answer needs nothing but a logged-in claude.",
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
    let existing: HubDir | null = fs.existsSync(manifestFile) ? loadHubDir(target) : null;
    if (!existing) {
      const legacy = detectLegacyLayout(target);
      if (legacy) throw new CliError(3, `${target} has the pre-0.7 layout (${legacy.found.join(", ")})`, "rfa migrate --dry-run shows the move; rfa migrate performs it");
    }
    const agentFlag = a.values.agent as string | undefined;
    if (agentFlag && !PACK_KINDS.includes(agentFlag as PackKind) && agentFlag !== "none") throw new CliError(2, `--agent takes ${PACK_KINDS.join(", ")} or none`);

    if (!ctx.flags.json && !ctx.flags.quiet) {
      ui.box([ui.bold("rfa · Rooms for Agents") + `  ${ui.dim(packageVersion())}`, "", "One room. Agents from more than one place. One log you", "can verify. One human who can stop it."]);
      ui.blank();
      if (!existing) {
        ui.line(`   This folder becomes a hub directory. Three parts, one folder:`);
        ui.blank();
        ui.line(`     ${ui.bold("hub")}          the room server. Agents and people talk through it, over MCP.`);
        ui.line(`     ${ui.bold("supervisor")}   keeps your local agents running and restarts them when they die.`);
        ui.line(`     ${ui.bold("agents/")}      one folder per agent: a markdown file is the whole definition.`);
        ui.blank();
        ui.line(`   Nothing here phones home. The hub listens on this machine only until you expose it on purpose.`);
        ui.blank();
      } else {
        ui.line(`   ${target} is already a hub directory (${existing.manifest.name}); re-running adds what is missing and rotates nothing.`);
        ui.blank();
      }
    }

    const answers = await gather(ctx, a.values, target, existing);
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
      if (!current.RFA_TOKEN || a.values.force) {
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
    if (!current.RFA_HUMAN_KEY || a.values.force) {
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
      if (answers.agentKind !== "none" || answers.room !== "main" || a.values.room) {
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
      else if (answers.agentKind === "tool" && !a.values.yes && !ctx.interactive) {
        ui.warn("a tool user needs an MCP server named: rfa agent new <name> --kind tool --server <name> --command <cmd> --tool <id>");
      } else {
        const handle = room?.handle ?? answers.roomHandle ?? null;
        const res = scaffoldPack(h, { name: answers.agentName, kind: answers.agentKind, room: handle, knowledge: answers.knowledge });
        agent = { name: answers.agentName, skillId: res.skillId };
        ui.done(`agents/${answers.agentName}/agent.md`, `definition ${res.definitionHash.slice(7, 15)} · 1 offer: ${res.skillId}${handle ? "" : " · NOT bound to a room yet"}`);
        ui.note("the pack is a folder: agent.md, knowledge/, memory/, skills/, evals/. rfa agent show lists it.");
      }
    }

    // 6. start
    let ready: { ready: boolean; state: string | null } | null = null;
    if (answers.start) {
      ui.blank();
      await upAll(ctx);
      if (agent && room) {
        const sp = ui.spinner(`waiting for ${agent.name} to join ${answers.room}`);
        ready = await waitForReady(ctx, room, agent.name, 120_000);
        sp.stop(ready.ready ? { ok: true, text: `${agent.name} is ready in ${answers.room}` } : { ok: false, text: `${agent.name} is ${ready.state ?? "not in the room yet"} after 120s`, detail: `rfa logs ${agent.name}` });
      }
    }

    // 7. the first question: prompted when someone is there to read the answer, or given with --ask
    let firstAnswer: { kind: string; text: string; elapsed_s: number; cost_usd: number | null } | null = null;
    if (ready?.ready && agent && room && (ctx.interactive || a.values.ask)) {
      let q: string | symbol | undefined = a.values.ask as string | undefined;
      if (!q && ctx.interactive) {
        const p: Prompts = await import("@clack/prompts");
        q = await p.text({ message: "Ask it something?", initialValue: agent.skillId === "answer-protocol-question" ? "How do presence leases work?" : "", placeholder: "blank to skip" });
        if (p.isCancel(q)) q = undefined;
      }
      if (typeof q === "string" && q.trim()) {
        const sp = ui.spinner(`asking ${agent.name}`);
        try {
          ctx.armTransport();
          const me = await RoomMember.resume({ hubUrl: ctx.hubUrl(), room: room.handle, membershipToken: room.operator!.membership_token, memberId: room.operator!.member_id, name: room.operator!.name, clientInfo: { name: "rfa-cli", version: packageVersion() } });
          const target = me.roster.find((r) => r.card_summary.skill_ids.includes(agent!.skillId));
          const t0 = Date.now();
          const answer = await me.ask(target!.id, q.trim(), { timeoutMs: 180_000 });
          const meta = answer.parts.find((x) => x.type === "json")?.value as { cost_usd?: number; run_id?: string } | undefined;
          firstAnswer = { kind: answer.kind, text: answer.text, elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)), cost_usd: meta?.cost_usd ?? null };
          sp.stop({ ok: answer.kind === "response", text: answer.kind === "response" ? `${agent.name} answered` : `${agent.name} refused: ${answer.refusal?.reason}`, detail: `${firstAnswer.elapsed_s}s${meta?.cost_usd != null ? ` · $${meta.cost_usd}` : ""}${meta?.run_id ? ` · ${meta.run_id}` : ""}` });
          ui.blank();
          for (const line of answer.text.split("\n")) ui.line(`   ${line}`);
        } catch (err) {
          sp.stop({ ok: false, text: `the ask failed: ${(err as Error).message}` });
        }
      }
    }

    // 8. next steps, then the key, once
    ui.blank();
    ui.line(`   ${ui.bold("Your hub directory is ready.")}${answers.start ? "" : " Nothing is running yet."}`);
    ui.blank();
    const next: string[][] = [];
    if (!answers.start) next.push(["rfa up", "start the hub and the supervisor"]);
    next.push(["rfa status", "what is running"]);
    if (agent) next.push([`rfa ask "…"`, `ask by capability, from anywhere in this folder`]);
    next.push(["rfa console", "the live room view; unlock it with your human key"]);
    next.push(["rfa agent new <name>", "another agent"]);
    next.push(["rfa connect claude-code", "let your Claude Code sessions ask this hub"]);
    next.push(["rfa peer add <name>", "admit an agent running on another machine"]);
    next.push(["rfa service install", "keep it running across reboots"]);
    ui.table(next.map(([c, d]) => [ui.accent(c), ui.dim(d)]), { indent: 5 });
    if (minted.human) {
      ui.blank();
      ui.line(`   Your human key, shown once (rfa human rotate ${answers.human} if you lose it):`);
      ui.blank();
      ui.line(`     ${ui.bold(minted.human)}`);
      ui.blank();
      ui.line(`   ${ui.dim("It unlocks the console and is the only thing that can approve. This CLI keeps its own copy in .rfa/secrets.json.")}`);
    }
    if (ctx.flags.json) ui.json({ dir: h.root, name: h.manifest.name, mode: h.mode, hub_url: h.hubUrl, agent: agent?.name ?? null, room: room?.handle ?? null, started: answers.start, ready: ready?.ready ?? null, first_answer: firstAnswer, human_key: minted.human ?? null });
  },
};
