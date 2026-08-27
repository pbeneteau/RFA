/**
 * Rooms (RFA-0.7 sect. 2.5 and 3.3): created, hosted and administered by the
 * operator, named by an alias that never reaches the wire.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { tokenDigest } from "../../credentials.js";
import { findRoom, roomsStore, secretsStore, tokensStore, type HubDir, type RoomRecord } from "../../hubdir.js";
import { TERMINAL_TASK_STATES, type TaskState } from "../../model.js";
import { CliError, numberFlag, type CliContext } from "../context.js";
import { openHubCall, type HubCall } from "../hubaccess.js";
import { pickOne } from "../prompts.js";
import type { CommandDef } from "../router.js";
import { byRoomInterest, fmtAge } from "../ui.js";
import { createRoomRecord } from "./init.js";

/** A missing room on a terminal is a pick from the recorded rooms; with one room it is that room. */
export async function roomArg(ctx: CliContext, h: HubDir, given: string | undefined, usage: string): Promise<RoomRecord> {
  if (given) return requireRoom(h, given);
  const rooms = roomsStore(h).read().rooms;
  if (rooms.length <= 1 || !ctx.interactive) return requireRoom(h, undefined, true);
  const alias = await pickOne(ctx, "Which room?", rooms.map((r) => ({ value: r.alias, hint: `${r.handle} · ${r.topic}` })), usage);
  return requireRoom(h, alias);
}

export function requireRoom(h: HubDir, ref: string | undefined, fallbackFirst = false): RoomRecord {
  const file = roomsStore(h).read();
  if (!ref) {
    const first = fallbackFirst ? file.rooms.find((r) => r.alias !== "ops") : undefined;
    if (first) return first;
    throw new CliError(2, "which room? pass <alias|handle>", "rfa room ls");
  }
  const rec = findRoom(file, ref);
  if (!rec) throw new CliError(2, `no room called ${ref} in rooms.json`, /^r_/.test(ref) ? `rfa room adopt ${ref}` : "rfa room ls");
  return rec;
}

/** The room's persisted snapshot, read for reconnaissance only; every change goes through the hub's verbs. */
function snapshot(h: HubDir, handle: string): { policies?: Record<string, unknown>; joinSecret?: string | null; ended?: boolean; members?: { id: string; name: string; present: boolean; state?: string; role?: string; home?: string; isHost?: boolean }[]; topic?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.paths.roomLogs, `${handle}.meta.json`), "utf8"));
  } catch {
    return null;
  }
}

/** An admin verb as the operator, over whichever transport is available. */
async function admin(ctx: CliContext, rec: RoomRecord, verb: string, args: { target?: string; reason?: string; params?: Record<string, unknown> }): Promise<unknown> {
  if (!rec.operator) throw new CliError(3, `no operator membership recorded for ${rec.alias}`, `rfa room adopt ${rec.handle}`);
  const call = await openHubCall(ctx);
  try {
    return await call.call("room_admin", { room: rec.handle, membership_token: rec.operator.membership_token, verb, ...args });
  } finally {
    await call.close();
  }
}

export const roomCreate: CommandDef = {
  path: ["room", "create"],
  summary: "Create a room you host; the operator bearer is admitted at creation",
  usage: "<alias> [--topic <text>] [--history member|joined_after] [--mode open|sequential|moderator]",
  options: { topic: { type: "string" }, history: { type: "string" }, mode: { type: "string" } },
  why: "The creating membership is the operator's, human-origin, so every admin verb on the room is yours. The room admits the operator bearer (join_bearer_sha256), so residents and this CLI join without a secret; history defaults to joined_after (a new member has no claim on what the room said before it arrived). Works with the hub down: the store is opened in this process.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const alias = a.positionals[0];
    if (!alias || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(alias)) throw new CliError(2, "an alias: lowercase letters, digits, hyphens (rfa room create product)");
    if (findRoom(roomsStore(h).read(), alias)) throw new CliError(2, `a room called ${alias} exists`, "rfa room ls");
    const history = (a.values.history as "member" | "joined_after" | undefined) ?? "joined_after";
    if (!["member", "joined_after"].includes(history)) throw new CliError(2, "--history takes member or joined_after");
    const mode = a.values.mode as string | undefined;
    if (mode && !["open", "sequential", "moderator"].includes(mode)) throw new CliError(2, "--mode takes open, sequential or moderator");
    const rec = await createRoomRecord(ctx, h, alias, (a.values.topic as string | undefined) ?? alias, { history, mode: mode as never });
    ctx.ui.done(`room ${alias}  ${rec.handle}`, "you host it; agents and this CLI join it with the operator bearer");
    if (ctx.flags.json) ctx.ui.json({ alias, handle: rec.handle, topic: rec.topic });
  },
};

export const roomLs: CommandDef = {
  path: ["room", "ls"],
  summary: "Every room on the hub, with what is in it",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const recorded = roomsStore(h).read().rooms;
    let rows: Record<string, unknown>[];
    let source: "hub" | "snapshot" = "snapshot";
    if ((await ctx.healthz()) && ctx.humanKey()) {
      try {
        rows = (await ctx.workbench<Record<string, unknown>[]>("/api/rooms")).map((r) => ({ ...r, alias: r.alias ?? recorded.find((x) => x.handle === r.handle)?.alias ?? null }));
        source = "hub";
      } catch {
        rows = [];
      }
    } else rows = [];
    if (source === "snapshot") {
      const handles = new Set<string>(recorded.map((r) => r.handle));
      if (fs.existsSync(h.paths.roomLogs)) for (const f of fs.readdirSync(h.paths.roomLogs)) if (f.endsWith(".meta.json")) handles.add(f.replace(/\.meta\.json$/, ""));
      rows = [...handles].map((handle) => {
        const snap = snapshot(h, handle);
        const members = (snap?.members ?? []).filter((m) => m.present);
        return { alias: recorded.find((r) => r.handle === handle)?.alias ?? null, handle, topic: snap?.topic ?? recorded.find((r) => r.handle === handle)?.topic ?? "", ended: snap?.ended ?? false, members: members.length, online: members.filter((m) => m.state && m.state !== "offline").length, guests: members.filter((m) => (m.home ?? "local") !== "local").length };
      });
    }
    // The named rooms first, ended ones last within each group: the same one
    // comparator `rfa status` sorts with (src/cli/ui.ts), applied before --json
    // so a script sees the decided order too.
    rows.sort((a, b) => byRoomInterest(a as { alias?: string | null; handle?: string; ended?: boolean }, b as { alias?: string | null; handle?: string; ended?: boolean }));
    if (ctx.flags.json) return void ctx.ui.json({ source, rooms: rows });
    if (rows.length === 0) return void ctx.ui.note("no rooms: rfa room create <alias>");
    if (source === "snapshot") ctx.ui.note("from the store's snapshots (the hub is not answering, or no human key); counts may lag");
    ctx.ui.table(rows.map((r) => [String(r.alias ?? ctx.ui.dim("-")), String(r.handle), `${r.online}/${r.members} online`, `${r.guests} guest${r.guests === 1 ? "" : "s"}`, r.open_tasks !== undefined ? `${r.open_tasks} open task${r.open_tasks === 1 ? "" : "s"}` : "", Number(r.pending_approvals ?? 0) > 0 ? ctx.ui.caution(`${r.pending_approvals} approval pending`) : "", r.ended ? ctx.ui.dim("ended") : "", ctx.ui.dim(String(r.topic ?? "").slice(0, 50))]));
  },
};

export const roomShow: CommandDef = {
  path: ["room", "show"],
  summary: "Roster with presence, home and skills; policies; the task board",
  usage: "<alias|handle>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const rec = await roomArg(ctx, h, a.positionals[0], "rfa room show <alias|handle>");
    const snap = snapshot(h, rec.handle);
    let roster: { id: string; name: string; role: string; state: string; home?: string; held?: boolean; card_summary: { skill_ids: string[]; description?: string } }[] = [];
    let tasks: Record<string, unknown>[] = [];
    let live = false;
    if (rec.operator) {
      let call: HubCall | null = null;
      try {
        call = await openHubCall(ctx);
        const r = (await call.call("room_roster", { room: rec.handle, membership_token: rec.operator.membership_token })) as { roster: typeof roster };
        roster = r.roster;
        try {
          tasks = ((await call.call("room_task", { room: rec.handle, membership_token: rec.operator.membership_token, action: "list" })) as { tasks: Record<string, unknown>[] }).tasks ?? [];
        } catch {
          tasks = [];
        }
        live = call.transport === "http";
      } catch (err) {
        ctx.ui.warn(`could not read the roster through the hub (${(err as Error).message}); showing the snapshot`);
      } finally {
        await call?.close();
      }
    }
    if (roster.length === 0 && snap?.members) roster = snap.members.filter((m) => m.present).map((m) => ({ id: m.id, name: m.name, role: m.role ?? "?", state: m.state ?? "?", home: m.home, card_summary: { skill_ids: [] } }));
    const view = { alias: rec.alias, handle: rec.handle, topic: snap?.topic ?? rec.topic, ended: snap?.ended ?? false, live, policies: snap?.policies ?? null, operator: rec.operator ? { member_id: rec.operator.member_id, name: rec.operator.name, role: rec.operator.role, host: rec.operator.host } : null, roster, tasks };
    if (ctx.flags.json) return void ctx.ui.json(view);
    const ui = ctx.ui;
    ui.line(`${ui.bold(rec.alias)}  ${rec.handle}  ${ui.dim(view.topic)}${view.ended ? ui.bad("  ended") : ""}${live ? "" : ui.dim("  (not live: from the store)")}`);
    ui.blank();
    ui.line("members");
    if (roster.length === 0) ui.note("nobody present");
    else
      ui.table(
        roster.map((m) => [ui.presence(m.state), m.name, ui.dim(m.id), m.role, m.state, (m.home ?? "local") === "local" ? "" : ui.caution(`guest ${m.home}`), m.held ? ui.caution("held") : "", ui.dim((m.card_summary.skill_ids ?? []).join(", "))]),
      );
    ui.blank();
    const p = view.policies ?? {};
    ui.line("policies");
    ui.note(`join ${String(p.join ?? "?")} · attention ${String(p.attention ?? "?")} · mode ${String(p.mode ?? "?")} · history ${String(p.history_visibility ?? "?")} · max_members ${String(p.max_members ?? "?")} · bearers admitted: ${((p.join_bearer_sha256 as string[] | undefined) ?? []).length}`);
    ui.blank();
    ui.line(`tasks  ${ui.dim(`${tasks.length} on the board`)}`);
    const open = tasks.filter((t) => !TERMINAL_TASK_STATES.has(String(t.state) as TaskState));
    if (open.length) ui.table(open.slice(0, 20).map((t) => [String(t.id), String(t.state), String(t.owner ?? ui.dim("unowned")), String(t.title).slice(0, 60)]));
  },
};

export const roomTail: CommandDef = {
  path: ["room", "tail"],
  summary: "The conversation-level view of a room's log",
  usage: "<alias|handle> [-f] [-n <lines>]",
  options: { follow: { type: "boolean", short: "f", default: false }, lines: { type: "string", short: "n" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const rec = await roomArg(ctx, h, a.positionals[0], "rfa room tail <alias|handle>");
    const n = numberFlag(a.values.lines, "lines", { int: true, min: 1 }) ?? 40;
    const file = path.join(h.paths.roomLogs, `${rec.handle}.ndjson`);
    if (!fs.existsSync(file)) throw new CliError(3, `no log yet for ${rec.alias} (${path.relative(h.root, file)})`);
    const ui = ctx.ui;
    const paint: Record<string, (s: string) => string> = { message: (s) => ui.accent(s), presence: (s) => ui.caution(s), roster: (s) => ui.paint("magenta", s), system: (s) => ui.bad(s), intervention: (s) => ui.paint("bgRed", s) };
    const summarize = (e: any): string => {
      switch (e.type) {
        case "message": {
          const env = e.envelope;
          const text = env.body?.find((p: any) => p.type === "text")?.text ?? "";
          const target = env.mentions?.length ? ` -> ${env.mentions.join(",")}` : "";
          const conv = env.conversation_id ? ui.dim(` [${env.conversation_id}]`) : "";
          const chunk = env.chunk ? ui.dim(` (chunk ${env.chunk.index}${env.chunk.final ? " final" : ""})`) : "";
          const refusal = env.refusal ? ` REFUSE:${env.refusal.reason}` : "";
          return `${ui.bold(env.from.name)} ${env.kind}${refusal}${target}${conv}${chunk} "${String(text).slice(0, 80)}"`;
        }
        case "presence":
          return `${ui.bold(e.member.name)} is ${e.member.state}${e.member.detail ? ` (${e.member.detail})` : ""}`;
        case "roster":
          return `${e.reason} (epoch ${e.epoch}): ${e.members.map((m: any) => `${m.name}:${m.state}`).join(", ")}`;
        case "system":
          return `${e.event} ${ui.dim(JSON.stringify(e.refs))}`;
        case "intervention":
          return `${e.verb} by ${e.actor} on ${e.target ?? "-"}`;
        default:
          return JSON.stringify(e);
      }
    };
    const render = (line: string): void => {
      if (!line.trim()) return;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      process.stdout.write(`${ui.dim(String(e.seq).padStart(5))} ${ui.dim(e.ts)} ${(paint[e.type] ?? ((s: string) => s))(String(e.type).padEnd(12))} ${summarize(e)}\n`);
    };
    const all = fs.readFileSync(file, "utf8").split("\n");
    for (const line of all.filter((l) => l.trim()).slice(-n)) render(line);
    if (!a.values.follow) return;
    let offset = fs.statSync(file).size;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        try {
          const size = fs.statSync(file).size;
          if (size > offset) {
            const fd = fs.openSync(file, "r");
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fs.closeSync(fd);
            offset = size;
            for (const line of buf.toString("utf8").split("\n")) render(line);
          }
        } catch {
          /* next tick */
        }
      }, 400);
      process.on("SIGINT", () => {
        clearInterval(timer);
        resolve();
      });
    });
  },
};

export async function setBearerList(ctx: CliContext, h: HubDir, rec: RoomRecord, mutate: (list: string[]) => string[]): Promise<string[]> {
  const snap = snapshot(h, rec.handle);
  const current = ((snap?.policies?.join_bearer_sha256 as string[] | undefined) ?? []).slice();
  const next = [...new Set(mutate(current))];
  if (next.length > 16) throw new CliError(2, "a room admits at most 16 bearers by hash (wire 5.1)");
  await admin(ctx, rec, "set_policy", { params: { policies: { join_bearer_sha256: next } } });
  return next;
}

export const roomAllow: CommandDef = {
  path: ["room", "allow"],
  summary: "Admit a bearer into a room without a secret (join_bearer_sha256)",
  usage: "<alias|handle> --token <label>",
  options: { token: { type: "string" } },
  why: "Admission by transport bearer (wire 4.3, first slice): the credential lives in the peer's MCP config beside the bearer itself, and nothing has to travel through a model's context or a chat. Each peer gets its OWN bearer, so removing one hash revokes one peer.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const rec = requireRoom(h, a.positionals[0]);
    const label = a.values.token as string | undefined;
    if (!label) throw new CliError(2, "rfa room allow <alias> --token <label>");
    const tok = tokensStore(h).read().tokens.find((t) => t.label === label);
    if (!tok) throw new CliError(2, `no bearer labelled ${label}`, "rfa token ls");
    const next = await setBearerList(ctx, h, rec, (l) => [...l, tok.sha256]);
    tokensStore(h).update((f) => {
      const t = f.tokens.find((x) => x.label === label);
      if (t) t.rooms = [...new Set([...(t.rooms ?? []), rec.handle])];
    });
    ctx.ui.done(`${label} admitted into ${rec.alias}`, `${next.length} bearer${next.length === 1 ? "" : "s"} listed; it joins with room_join {room} and no secret`);
  },
};

export const roomDisallow: CommandDef = {
  path: ["room", "disallow"],
  summary: "Remove a bearer's admission from a room",
  usage: "<alias|handle> --token <label> | --sha256 <hex>",
  options: { token: { type: "string" }, sha256: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const rec = requireRoom(h, a.positionals[0]);
    const label = a.values.token as string | undefined;
    const hex = (a.values.sha256 as string | undefined) ?? tokensStore(h).read().tokens.find((t) => t.label === label)?.sha256;
    if (!hex) throw new CliError(2, "rfa room disallow <alias> --token <label> (or --sha256 <hex> for a bearer already revoked)");
    const next = await setBearerList(ctx, h, rec, (l) => l.filter((x) => x !== hex));
    tokensStore(h).update((f) => {
      for (const t of f.tokens) if (t.sha256 === hex) t.rooms = (t.rooms ?? []).filter((r) => r !== rec.handle);
    });
    ctx.ui.done(`removed from ${rec.alias}`, `${next.length} bearer${next.length === 1 ? "" : "s"} still listed`);
  },
};

export const roomPolicy: CommandDef = {
  path: ["room", "policy"],
  summary: "Set room policies (mode, moderator, attention, max_members, member_rpm, max_pending_requests, history_visibility)",
  usage: "<alias|handle> set <key>=<value> [<key>=<value> …]",
  examples: ["rfa room policy product set history_visibility=member", "rfa room policy product set mode=sequential max_members=8"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const [ref, verb, ...pairs] = a.positionals;
    const rec = requireRoom(h, ref);
    if (verb !== "set" || pairs.length === 0) throw new CliError(2, "rfa room policy <alias> set <key>=<value> …");
    const policies: Record<string, unknown> = {};
    for (const pair of pairs) {
      const i = pair.indexOf("=");
      if (i < 0) throw new CliError(2, `${pair} is not key=value`);
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      policies[k] = v === "null" ? null : /^-?\d+$/.test(v) ? Number(v) : v;
    }
    const res = await admin(ctx, rec, "set_policy", { params: { policies } });
    ctx.ui.done(`${rec.alias} policies updated`, JSON.stringify((res as { changes?: unknown }).changes ?? policies));
  },
};

export const roomSecret: CommandDef = {
  path: ["room", "secret"],
  summary: "Show a room's legacy join secret, for a client that cannot send a header",
  usage: "show <alias|handle>",
  why: "The join secret is one secret for the whole room with no attribution and no per-holder revocation, and the hub cannot rotate it (minted once at room_create). It stays legal for an all-local room and a client that cannot carry a bearer; everything else uses rfa room allow.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const [verb, ref] = a.positionals;
    if (verb !== "show") throw new CliError(2, "rfa room secret show <alias|handle>");
    const rec = requireRoom(h, ref);
    const secret = rec.join_secret ?? snapshot(h, rec.handle)?.joinSecret ?? null;
    if (ctx.flags.json) return void ctx.ui.json({ alias: rec.alias, handle: rec.handle, join_secret: secret });
    if (!secret) throw new CliError(3, `${rec.alias} has no join secret on record (join: open, or created elsewhere)`);
    process.stdout.write(`${secret}\n`);
  },
};

const moderation = (verb: "hold_member" | "release_member" | "evict" | "quarantine", name: string, summary: string): CommandDef => ({
  path: ["room", name],
  summary,
  usage: "<alias|handle> <member id|name> [--reason <text>]",
  options: { reason: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const [ref, target] = a.positionals;
    const rec = requireRoom(h, ref);
    if (!target) throw new CliError(2, `rfa room ${name} <alias> <member>`);
    const res = await admin(ctx, rec, verb, { target, ...(a.values.reason ? { reason: String(a.values.reason) } : {}) });
    ctx.ui.done(`${verb} ${target} in ${rec.alias}`, `audited as an intervention (seq ${(res as { seq?: number }).seq ?? "?"})`);
  },
});
export const roomEvict = moderation("evict", "evict", "Revoke a membership");
export const roomHold = moderation("hold_member", "hold", "Pause a member: sends and task mutations refused, reads keep working");
export const roomRelease = moderation("release_member", "release", "Resume a held member, or lift a quarantine (human-origin)");
export const roomQuarantine = moderation("quarantine", "quarantine", "Evict and refuse that identity's re-join until a human lifts it");

export const roomInject: CommandDef = {
  path: ["room", "inject"],
  summary: "Speak as the supervisor into a room (the only voice a supervisor has)",
  usage: "<alias|handle> \"<text>\" [--to <member>]",
  options: { to: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const [ref, ...rest] = a.positionals;
    const rec = requireRoom(h, ref);
    const text = rest.join(" ").trim();
    if (!text) throw new CliError(2, 'rfa room inject <alias> "<text>"');
    const res = await admin(ctx, rec, "inject", { params: { text, ...(a.values.to ? { mentions: [String(a.values.to)] } : {}) } });
    ctx.ui.done(`injected into ${rec.alias}`, `seq ${(res as { seq?: number }).seq ?? "?"}`);
  },
};

export const roomEnd: CommandDef = {
  path: ["room", "end"],
  summary: "End a room (host only): members are notified, sends stop, reads keep working",
  usage: "<alias|handle> [--summary <text>]",
  options: { summary: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const rec = requireRoom(h, a.positionals[0]);
    if (!rec.operator) throw new CliError(3, `no operator membership recorded for ${rec.alias}`);
    const call = await openHubCall(ctx);
    try {
      await call.call("room_end", { room: rec.handle, membership_token: rec.operator.membership_token, ...(a.values.summary ? { summary: String(a.values.summary) } : {}) });
    } finally {
      await call.close();
    }
    ctx.ui.done(`${rec.alias} ended`, "its log stays readable; rfa room tail still works");
  },
};

export const roomAdopt: CommandDef = {
  path: ["room", "adopt"],
  summary: "Record a room this CLI did not create, joining it as the operator (supervisor)",
  usage: "<alias|handle> [--alias <alias>] [--secret <join secret>] [--no-allow]",
  options: { alias: { type: "string" }, secret: { type: "string" }, allow: { type: "boolean", default: true } },
  why: "After a migration (rooms recorded without an operator membership), or for a room a pack created on its own, the operator needs an admin membership in it. This joins as a human supervisor and, unless --no-allow, admits the operator bearer so residents can join without the secret. A recorded room is named by its alias; a room nobody recorded yet by its handle.",
  examples: ["rfa room adopt product", "rfa room adopt r_9a25e48c0e --alias product --secret <join secret>"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const file = roomsStore(h).read();
    const ref = a.positionals[0];
    if (!ref) throw new CliError(2, "rfa room adopt <alias|handle>");
    // An alias names a recorded room; a handle may name one nobody recorded yet.
    const handle = /^r_[a-f0-9]+$/.test(ref) ? ref : findRoom(file, ref)?.handle;
    if (!handle) throw new CliError(2, `no recorded room named ${ref}`, "rfa room ls; a room not recorded yet is adopted by its handle r_…");
    const existing = file.rooms.find((r) => r.handle === handle);
    if (existing?.operator) throw new CliError(2, `${handle} is already recorded as ${existing.alias} with an operator membership`);
    const alias = (a.values.alias as string | undefined) ?? existing?.alias ?? `room-${handle.slice(2, 8)}`;
    if (!existing && findRoom(file, alias)) throw new CliError(2, `alias ${alias} is taken`, "--alias <other>");
    const snap = snapshot(h, handle);
    const secret = (a.values.secret as string | undefined) ?? existing?.join_secret ?? snap?.joinSecret ?? undefined;
    const humanKey = ctx.humanKey();
    if (!humanKey) throw new CliError(3, "adopting needs the operator's human key", "rfa human add <label>");
    const call = await openHubCall(ctx);
    let you: { id: string; membership_token: string; name: string; role: "participant" | "observer" | "supervisor" };
    try {
      const label = (await import("../../hubdir.js")).principalsStore(h).read().principals[0]?.label ?? "operator";
      const res = (await call.call("room_join", {
        room: handle,
        ...(secret ? { join_secret: secret } : {}),
        name: label,
        role: "supervisor",
        human_key: humanKey,
        card: { name: label, description: "the operator, from the rfa CLI", skills: [{ id: "operate", description: "supervises, asks, decides" }] },
        history_limit: 0,
      })) as { you: typeof you };
      you = res.you;
      if (a.values.allow !== false) {
        const tok = secretsStore(h).read().RFA_TOKEN;
        if (tok) {
          const current = ((snap?.policies?.join_bearer_sha256 as string[] | undefined) ?? []).slice();
          if (!current.includes(tokenDigest(tok))) await call.call("room_admin", { room: handle, membership_token: you.membership_token, verb: "set_policy", params: { policies: { join_bearer_sha256: [...current, tokenDigest(tok)].slice(0, 16) } } });
        }
      }
    } finally {
      await call.close();
    }
    const record: RoomRecord = { alias, handle, topic: snap?.topic ?? existing?.topic ?? alias, join_secret: secret ?? null, operator: { member_id: you.id, membership_token: you.membership_token, name: you.name, role: you.role, host: false }, created_at: existing?.created_at ?? new Date().toISOString() };
    roomsStore(h).update((f) => {
      f.rooms = f.rooms.filter((r) => r.handle !== handle).concat(record);
    });
    ctx.ui.done(`adopted ${handle} as ${alias}`, `operator membership ${you.id} (supervisor)${a.values.allow !== false ? "; the operator bearer is admitted" : ""}`);
    ctx.ui.note(`rfa room show ${alias}`);
  },
};

export function roomAge(rec: RoomRecord): string {
  return fmtAge(rec.created_at);
}
