/**
 * Talking to the room as a human principal (RFA-0.7 sect. 3.4): `ask`, the task
 * board, and the approval cards.
 */
import { RoomMember } from "../../client.js";
import { JsonStore, principalsStore, roomsStore, type HubDir, type RoomRecord } from "../../hubdir.js";
import { TERMINAL_TASK_STATES, type TaskState } from "../../model.js";
import { packageVersion } from "../../pkg.js";
import { CliError, numberFlag, type CliContext } from "../context.js";
import { openHubCall } from "../hubaccess.js";
import { askLine, pickOne } from "../prompts.js";
import type { CommandDef } from "../router.js";
import { fmtAge, fmtDuration } from "../ui.js";
import { requireRoom } from "./room.js";

const clientInfo = () => ({ name: "rfa-cli", version: packageVersion() });

/**
 * A participant membership to speak with: the operator's own when it is one,
 * else ONE recorded speaker membership, created the first time and resumed
 * after.
 *
 * The else-branch is every adopted room: `rfa room adopt` joins as a
 * supervisor for the admin verbs, and a supervisor cannot send (wire 12.1: its
 * only voice is inject). Joining ephemerally per ask put a join/leave pair in
 * the room log on every question and left a corpse in the roster whenever the
 * CLI died mid-ask, so the membership is recorded in rooms.json (the CLI's own
 * file, like the operator's) and resumed like a resident's. Two concurrent
 * first asks race the record; the loser's membership lapses at its lease,
 * once. `ephemeral` remains for the one case recording is impossible: a room
 * rooms.json does not list.
 */
export async function speaker(ctx: CliContext, h: HubDir, rec: RoomRecord): Promise<{ me: RoomMember; ephemeral: boolean }> {
  ctx.armTransport();
  const hubUrl = ctx.hubUrl();
  if (rec.operator?.role === "participant") {
    const me = await RoomMember.resume({ hubUrl, room: rec.handle, membershipToken: rec.operator.membership_token, memberId: rec.operator.member_id, name: rec.operator.name, clientInfo: clientInfo() });
    return { me, ephemeral: false };
  }
  if (rec.speaker) {
    try {
      const me = await RoomMember.resume({ hubUrl, room: rec.handle, membershipToken: rec.speaker.membership_token, memberId: rec.speaker.member_id, name: rec.speaker.name, clientInfo: clientInfo() });
      return { me, ephemeral: false };
    } catch {
      /* evicted, expired, or the room was rebuilt: join anew below and re-record */
    }
  }
  const label = principalsStore(h).read().principals[0]?.label ?? "operator";
  const me = await RoomMember.create({
    hubUrl,
    room: rec.handle,
    joinSecret: rec.join_secret ?? undefined,
    name: `${label}-cli`,
    humanKey: ctx.humanKey() ?? undefined,
    card: { name: `${label}-cli`, description: "the operator, from the terminal", skills: [{ id: "operate", description: "asks and decides" }] },
    clientInfo: clientInfo(),
  });
  let recorded = false;
  try {
    roomsStore(h).update((f) => {
      const r = f.rooms.find((x) => x.handle === rec.handle);
      if (r) {
        r.speaker = { member_id: me.memberId, membership_token: me.membershipToken, name: me.name };
        recorded = true;
      }
    });
  } catch {
    /* a store this process cannot write: fall back to leave-after-use */
  }
  return { me, ephemeral: !recorded };
}

type RosterEntry = { id: string; name: string; role: string; state: string; card_summary: { skill_ids: string[] } };

/** Members this CLI could get an answer from: other participants whose lease has not expired. */
const answerers = (roster: RosterEntry[], selfId: string) => roster.filter((r) => r.id !== selfId && r.role === "participant" && r.state !== "offline");

/**
 * The member a capability means right now: a present participant offering it,
 * the ready one first. Discovery is by capability, never by name (wire 3.2);
 * `ask` always resolved this way, and `task create --capability` uses the same
 * rule so the board is not the one place that couples work to a name.
 */
export function memberFor<T extends { id: string; name?: string; role: string; state: string; card_summary: { skill_ids: string[] } }>(roster: T[], selfId: string | null, capability: string, prefer?: string): T | null {
  const eligible = roster.filter((r) => r.id !== selfId && r.role === "participant" && r.state !== "offline" && r.card_summary.skill_ids.includes(capability));
  // A reply prefers the member that answered last time: a conversation is with
  // someone, and two agents offering one capability must not split a thread.
  const preferred = prefer ? eligible.find((r) => r.name === prefer) : undefined;
  return preferred ?? eligible.find((r) => r.state === "ready") ?? eligible[0] ?? null;
}

/** What `rfa ask --reply` continues: the last conversation per room, with who answered it and under which capability. */
export interface LastAsk {
  conversation: string;
  capability: string;
  target: string;
  at: string;
}

export const lastAskStore = (h: HubDir) => new JsonStore<Record<string, LastAsk>>(h.paths.lastAsk, () => ({}));

/** Record the thread an answer opened (or continued), so the next --reply and the ask box's r find it. */
export function recordLastAsk(h: HubDir, room: string, thread: Omit<LastAsk, "at">): void {
  try {
    lastAskStore(h).update((f) => {
      f[room] = { ...thread, at: new Date().toISOString() };
    });
  } catch {
    /* a store this process cannot write costs only the convenience */
  }
}

/** `answer-product-question (pm-agent), draft-linear-document (linear-scribe)`: the choice --capability makes, with who is behind each. */
export function describeOffers(candidates: { name: string; card_summary: { skill_ids: string[] } }[], offered: string[]): string {
  return offered.map((c) => `${c} (${candidates.filter((r) => r.card_summary.skill_ids.includes(c)).map((r) => r.name).join(", ")})`).join(", ");
}

export const ask: CommandDef = {
  path: ["ask"],
  summary: "Ask an agent by capability, as a human principal, and wait for the answer",
  usage: '"<question>" [--room <alias|handle>] [--capability <skill id>] [--reply | --conversation <c_…>] [--timeout <seconds>]',
  options: { room: { type: "string" }, capability: { type: "string" }, reply: { type: "boolean", default: false }, conversation: { type: "string" }, timeout: { type: "string" } },
  why: "Discovery is by capability, never by name: the roster's skill ids are what an asker matches on. With one capability in the room it is chosen; with several, --capability picks. --reply continues the room's last conversation (recorded in .rfa/last-ask.json with who answered): the resident resumes the same brain session, so it argues with the context of what it just said; --conversation names any thread explicitly. The 30-minute default deadline is the asker's own: a resident's approval window derives from it, so it is what buys 'I stepped away'.",
  examples: ['rfa ask "how do presence leases work?"', 'rfa ask --reply "that contradicts wire 7.2: which is it?"', 'rfa ask --room product --capability draft-linear-document "draft an expression de besoin from: …"'],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const question = a.positionals.join(" ").trim() || (await askLine(ctx, "Your question", 'rfa ask "<question>"', { placeholder: "how do presence leases work?" }));
    const timeoutS = numberFlag(a.values.timeout, "timeout", { min: 1 }) ?? 1800;
    if (a.values.reply && a.values.conversation) throw new CliError(2, "--reply continues the last conversation; --conversation names one: pass one or the other");
    if (!(await ctx.healthz())) throw new CliError(3, `the hub at ${ctx.hubUrl()} is not answering`, "rfa up");
    const rec = requireRoom(h, a.values.room as string | undefined, true);
    let thread: LastAsk | null = null;
    if (a.values.reply) {
      thread = lastAskStore(h).read()[rec.handle] ?? null;
      if (!thread) throw new CliError(2, `no previous ask recorded in ${rec.alias}`, "ask once without --reply; every answer prints the conversation it opened");
    }
    const conversationId = (a.values.conversation as string | undefined) ?? thread?.conversation;
    const { me, ephemeral } = await speaker(ctx, h, rec);
    try {
      const roster = (await me.refreshRoster()) as RosterEntry[];
      const candidates = answerers(roster, me.memberId);
      const offered = [...new Set(candidates.flatMap((r) => r.card_summary.skill_ids))];
      const explicit = (a.values.capability as string | undefined) ?? thread?.capability;
      let capability = explicit ?? (offered.length === 1 ? offered[0] : null);
      if (!capability && offered.length > 1 && ctx.interactive) {
        capability = await pickOne(ctx, `${rec.alias} offers ${offered.length} capabilities`, offered.map((c) => ({ value: c, hint: candidates.filter((r) => r.card_summary.skill_ids.includes(c)).map((r) => r.name).join(", ") })), "rfa ask --capability <id>");
      }
      if (!capability) {
        if (offered.length === 0) throw new CliError(3, `nobody in ${rec.alias} is present to answer`, candidates.length ? "" : "rfa status shows whether the agents are up");
        throw new CliError(2, `${rec.alias} offers ${offered.length} capabilities: ${describeOffers(candidates, offered)}`, "pick one with --capability <id>");
      }
      const target = memberFor(roster, me.memberId, capability, thread?.target);
      if (!target) throw new CliError(3, `nobody in ${rec.alias} offers ${capability}`, `present: ${candidates.map((r) => `${r.name} [${r.card_summary.skill_ids.join(",")}]`).join(" · ") || "nobody"}`);
      const sp = ctx.ui.spinner(`asking ${target.name} (${capability}, ${target.state})`);
      const t0 = Date.now();
      // A tool user that calls a gated tool pauses on a card and waits for a
      // human; from here that looked like a silent four minutes. Poll the
      // cards while waiting and say so, with the command that unblocks it.
      const watch = ctx.humanKey()
        ? setInterval(() => {
            void ctx
              .workbench<Card[]>("/api/approvals")
              .then((cards) => {
                const mine = cards.find((c) => c.status === "pending" && c.requester_name === target.name && c.room === rec.handle);
                if (mine) sp.update(`${target.name} is waiting for YOUR decision on "${mine.action}": rfa approvals approve ${mine.request_id}  (or rfa, tab 4, y)`);
              })
              .catch(() => {});
          }, 3000)
        : null;
      watch?.unref?.();
      let answer;
      try {
        answer = await me.ask(target.id, question, { timeoutMs: timeoutS * 1000, conversationId });
      } finally {
        if (watch) clearInterval(watch);
      }
      const meta = answer.parts.find((p) => p.type === "json")?.value as { cost_usd?: number; run_id?: string } | undefined;
      const convo = answer.envelope.conversation_id ?? conversationId ?? null;
      if (convo) recordLastAsk(h, rec.handle, { conversation: convo, capability, target: target.name });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      sp.stop({ ok: answer.kind === "response", text: answer.kind === "response" ? `${target.name} answered` : `${target.name} refused: ${answer.refusal?.reason ?? "?"}${answer.refusal?.detail ? ` (${answer.refusal.detail})` : ""}`, detail: `${elapsed}s${meta?.cost_usd != null ? ` · $${meta.cost_usd}` : ""}${meta?.run_id ? ` · ${meta.run_id}` : ""}` });
      if (ctx.flags.json) ctx.ui.json({ room: rec.handle, conversation_id: convo, asked: target.name, capability, kind: answer.kind, refusal: answer.refusal ?? null, text: answer.text, elapsed_s: Number(elapsed), cost_usd: meta?.cost_usd ?? null, run_id: meta?.run_id ?? null });
      else {
        ctx.ui.blank();
        process.stdout.write(answer.text + "\n");
        if (convo) {
          ctx.ui.blank();
          ctx.ui.note(`conversation ${convo}${conversationId ? " (continued)" : ""} · rfa ask --reply argues back with the context kept`);
        }
      }
      if (answer.kind !== "response") return 1;
    } finally {
      if (ephemeral) await me.leave().catch(() => {});
    }
  },
};

// ---------------------------------------------------------------- tasks

/** The task board of a room, from the operator membership: one hub call per command, over HTTP or in process. */
export async function board(ctx: CliContext, h: HubDir, ref: string | undefined): Promise<{ rec: RoomRecord; call: (args: Record<string, unknown>) => Promise<any>; roster: () => Promise<any>; close: () => Promise<void> }> {
  const rec = requireRoom(h, ref, true);
  if (!rec.operator) throw new CliError(3, `no operator membership recorded for ${rec.alias}`, `rfa room adopt ${rec.handle}`);
  const hub = await openHubCall(ctx);
  return {
    rec,
    call: (args) => hub.call("room_task", { room: rec.handle, membership_token: rec.operator!.membership_token, ...args }),
    roster: () => hub.call("room_roster", { room: rec.handle, membership_token: rec.operator!.membership_token }),
    close: () => hub.close(),
  };
}

export const taskLs: CommandDef = {
  path: ["task", "ls"],
  summary: "The task board (open tasks; --all for every state)",
  usage: "[--room <alias|handle>] [--all]",
  options: { room: { type: "string" }, all: { type: "boolean", default: false } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const b = await board(ctx, h, a.values.room as string | undefined);
    try {
      const tasks = ((await b.call({ action: "list" })) as { tasks: Record<string, unknown>[] }).tasks ?? [];
      const shown = a.values.all ? tasks : tasks.filter((t) => !TERMINAL_TASK_STATES.has(String(t.state) as TaskState));
      if (ctx.flags.json) return void ctx.ui.json(shown);
      if (shown.length === 0) return void ctx.ui.note(`no ${a.values.all ? "" : "open "}tasks in ${b.rec.alias}`);
      ctx.ui.table(shown.map((t) => [String(t.id), String(t.state), String(t.owner ?? ctx.ui.dim("unowned")), t.evidence_required ? "evidence" : "", t.reply_by ? `by ${String(t.reply_by).slice(0, 16)}` : "", String(t.title).slice(0, 70)]));
    } finally {
      await b.close();
    }
  },
};

export const taskShow: CommandDef = {
  path: ["task", "show"],
  summary: "One task, in full",
  usage: "<id> [--room <alias|handle>]",
  options: { room: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const id = a.positionals[0];
    if (!id) throw new CliError(2, "rfa task show <id>");
    const b = await board(ctx, h, a.values.room as string | undefined);
    try {
      const t = await b.call({ action: "get", id });
      if (ctx.flags.json) return void ctx.ui.json(t);
      process.stdout.write(JSON.stringify(t, null, 2) + "\n");
    } finally {
      await b.close();
    }
  },
};

export const taskCreate: CommandDef = {
  path: ["task", "create"],
  summary: "Put a task on the board: assigned by name, found by capability, or unowned for a claimer",
  usage: '"<title>" [--room] [--description <text>] [--owner <member> | --capability <skill id>] [--reply-by <ISO|+minutes>] [--evidence-required] [--blocked-by <id,id>] [--max-attempts <n>]',
  options: { room: { type: "string" }, description: { type: "string" }, owner: { type: "string" }, capability: { type: "string" }, "reply-by": { type: "string" }, "evidence-required": { type: "boolean", default: false }, "blocked-by": { type: "string" }, "max-attempts": { type: "string" } },
  why: "An assigned resident wakes and does the task; an unowned one waits on the board for a claimer. --capability assigns without naming: the present participant offering that skill (ready first), resolved at create time by the same rule `rfa ask` uses, because discovery is by capability and the board must not be the one place that couples work to a name.",
  examples: ['rfa task create "draft the release note" --owner linear-agent --evidence-required', 'rfa task create "draft the release note" --capability draft-linear-document', 'rfa task create "collect the fee table" --reply-by +60'],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const title = a.positionals.join(" ").trim();
    if (!title) throw new CliError(2, 'rfa task create "<title>"');
    const capability = a.values.capability as string | undefined;
    if (capability && a.values.owner) throw new CliError(2, "--owner names the agent; --capability finds it by what it offers: pass one or the other");
    const maxAttempts = numberFlag(a.values["max-attempts"], "max-attempts", { int: true, min: 1, max: 20 });
    const replyRaw = a.values["reply-by"] as string | undefined;
    const replyBy = replyRaw ? (/^\+\d+$/.test(replyRaw) ? new Date(Date.now() + Number(replyRaw.slice(1)) * 60_000).toISOString() : replyRaw) : undefined;
    const b = await board(ctx, h, a.values.room as string | undefined);
    try {
      let owner = a.values.owner ? String(a.values.owner) : undefined;
      if (capability) {
        const roster = ((await b.roster()) as { roster: RosterEntry[] }).roster;
        const target = memberFor(roster, b.rec.operator?.member_id ?? null, capability);
        if (!target) {
          const candidates = answerers(roster, b.rec.operator?.member_id ?? "");
          const offered = [...new Set(candidates.flatMap((r) => r.card_summary.skill_ids))];
          throw new CliError(3, `nobody in ${b.rec.alias} offers ${capability} right now`, offered.length ? `offered: ${describeOffers(candidates, offered)}` : "rfa status shows whether the agents are up");
        }
        owner = target.id;
        ctx.ui.step(`${capability} -> ${target.name} (${target.state})`, "resolved at create time, ready first: the same rule rfa ask uses");
      }
      const t = await b.call({
        action: "create",
        title,
        ...(a.values.description ? { description: String(a.values.description) } : {}),
        ...(owner ? { owner } : {}),
        ...(replyBy ? { reply_by: replyBy } : {}),
        ...(a.values["evidence-required"] ? { evidence_required: true } : {}),
        ...(a.values["blocked-by"] ? { blocked_by: String(a.values["blocked-by"]).split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        ...(maxAttempts !== undefined ? { max_attempts: maxAttempts } : {}),
      });
      ctx.ui.done(`task ${t.id} created in ${b.rec.alias}`, `${t.state}${t.owner ? `, assigned to ${t.owner}` : ""}`);
      if (ctx.flags.json) ctx.ui.json(t);
    } finally {
      await b.close();
    }
  },
};

export const taskCancel: CommandDef = {
  path: ["task", "cancel"],
  summary: "Cancel a task",
  usage: "<id> [--room]",
  options: { room: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const id = a.positionals[0];
    if (!id) throw new CliError(2, "rfa task cancel <id>");
    const b = await board(ctx, h, a.values.room as string | undefined);
    try {
      await b.call({ action: "cancel", id });
      ctx.ui.done(`task ${id} cancelled`);
    } finally {
      await b.close();
    }
  },
};

export const taskVerify: CommandDef = {
  path: ["task", "verify"],
  summary: "Accept or reject a task's evidence, as a human principal (wire 10.4)",
  usage: "<id> --verdict accept|reject [--note <text>] [--room]",
  options: { room: { type: "string" }, verdict: { type: "string" }, note: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const id = a.positionals[0];
    const verdict = a.values.verdict as string | undefined;
    if (!id || !verdict || !["accept", "reject"].includes(verdict)) throw new CliError(2, "rfa task verify <id> --verdict accept|reject");
    const b = await board(ctx, h, a.values.room as string | undefined);
    try {
      const t = await b.call({ action: "verify", id, verdict, ...(a.values.note ? { note: String(a.values.note) } : {}) });
      ctx.ui.done(`task ${id} ${verdict === "accept" ? "accepted" : "rejected"}`, `now ${t.state}`);
    } finally {
      await b.close();
    }
  },
};

// ---------------------------------------------------------------- approvals

interface Card {
  room: string;
  topic: string;
  request_id: string;
  requester: string;
  requester_name: string;
  requester_origin: string;
  requester_home: string;
  action: string;
  tool_name: string;
  allowed_decisions: string[] | null;
  expires_at: string | null;
  held: boolean;
  message_preview: string | null;
  status: string;
}

async function cards(ctx: CliContext): Promise<Card[]> {
  if (!(await ctx.healthz())) throw new CliError(3, `the hub at ${ctx.hubUrl()} is not answering`, "rfa up");
  return ctx.workbench<Card[]>("/api/approvals");
}

export const approvalsLs: CommandDef = {
  path: ["approvals", "ls"],
  summary: "Pending approval cards across every room",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const list = await cards(ctx);
    const aliases = new Map(roomsStore(h).read().rooms.map((r) => [r.handle, r.alias]));
    if (ctx.flags.json) return void ctx.ui.json(list);
    if (list.length === 0) return void ctx.ui.note("nothing pending");
    ctx.ui.table(list.map((c) => [c.status === "pending" ? ctx.ui.caution("●") : ctx.ui.dim("○"), c.request_id, aliases.get(c.room) ?? c.room, `${c.requester_name} (${c.requester_home})`, c.action, ctx.ui.dim(c.tool_name), c.expires_at ? (Date.parse(c.expires_at) > Date.now() ? `expires in ${fmtDuration(Date.parse(c.expires_at) - Date.now())}` : `expired ${fmtAge(c.expires_at)}`) : "", c.held ? ctx.ui.caution("held") : ""]));
    ctx.ui.note("rfa approvals show <id> for the preview; rfa approvals approve|reject <id>");
  },
};

export const approvalsShow: CommandDef = {
  path: ["approvals", "show"],
  summary: "One card, preview included",
  usage: "<request_id>",
  run: async (ctx, a) => {
    const id = a.positionals[0];
    if (!id) throw new CliError(2, "rfa approvals show <request_id>");
    const c = (await cards(ctx)).find((x) => x.request_id === id);
    if (!c) throw new CliError(2, `no card ${id}`, "rfa approvals ls");
    if (ctx.flags.json) return void ctx.ui.json(c);
    const ui = ctx.ui;
    ui.line(`${ui.bold(c.action)}  ${ui.dim(c.tool_name)}  ${c.status}`);
    ui.table([
      ["request", c.request_id],
      ["room", c.room],
      ["requester", `${c.requester_name} (${c.requester}) · origin ${c.requester_origin} · home ${c.requester_home}`],
      ["decisions", (c.allowed_decisions ?? []).join(", ")],
      ["expires", c.expires_at ?? "-"],
    ]);
    if (c.message_preview) {
      ui.blank();
      ui.line(ui.dim("preview (requester-supplied, sanitized by the hub, capped):"));
      for (const line of c.message_preview.split("\n")) ui.line(`   ${line}`);
    }
  },
};

const decide = (verb: "approve" | "reject"): CommandDef => ({
  path: ["approvals", verb],
  summary: verb === "approve" ? "Approve a card, optionally editing its params (edit-before-approve merges over the original input)" : "Reject a card",
  usage: verb === "approve" ? "<request_id> [--edit key=value …]" : "<request_id> [--reason <text>]",
  options: verb === "approve" ? { edit: { type: "string", multiple: true } } : { reason: { type: "string" } },
  why: "A decision lands as a human-origin intervention carrying your principal id, exactly as the console's does (same POST /auth, same per-principal membership): the CLI on the operator's machine is the console's equal, which is why v0.5 sect. 17.2's 'sole verdict surface' was amended to include it. Notifications over broadcast channels still carry no button.",
  run: async (ctx, a) => {
    const id = a.positionals[0] ?? (await pickOne(ctx, `Which card to ${verb}?`, (await cards(ctx)).filter((c) => c.status === "pending").map((c) => ({ value: c.request_id, hint: `${c.action} from ${c.requester_name} in ${c.room}` })), `rfa approvals ${verb} <request_id>`));
    const c = (await cards(ctx)).find((x) => x.request_id === id);
    if (!c) throw new CliError(2, `no card ${id}`, "rfa approvals ls");
    if (c.status !== "pending") throw new CliError(2, `card ${id} is ${c.status}`);
    const params: Record<string, unknown> = {};
    const edits = (a.values.edit as unknown as string[] | undefined) ?? [];
    for (const e of edits) {
      const i = e.indexOf("=");
      if (i < 0) throw new CliError(2, `--edit takes key=value, not ${e}`);
      params[e.slice(0, i)] = e.slice(i + 1);
    }
    if (!ctx.flags.yes && ctx.interactive) {
      const p = await import("@clack/prompts");
      const ok = await p.confirm({ message: `${verb} "${c.action}" (${c.tool_name}) from ${c.requester_name} in ${c.room}?`, initialValue: verb === "approve" });
      if (p.isCancel(ok) || !ok) throw new CliError(2, "no decision made");
    }
    const res = await ctx.workbench("/api/approvals/decide", { method: "POST", body: { room: c.room, request_id: id, verb, ...(Object.keys(params).length ? { params } : {}) } });
    ctx.ui.done(`${verb}d ${id}`, `${c.action} from ${c.requester_name}${Object.keys(params).length ? ` with edits ${JSON.stringify(params)}` : ""}; audited with your principal`);
    if (ctx.flags.json) ctx.ui.json(res);
  },
});
export const approvalsApprove = decide("approve");
export const approvalsReject = decide("reject");
