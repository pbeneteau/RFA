/**
 * The approval bridge (RFA v0.4 spec 7.3): a resident whose pack declares
 * `interrupt_on` for a tool routes that tool call through the room's approval
 * machinery: the SDK's canUseTool publishes an approval request, a
 * HUMAN-origin decision releases or denies it, edit-before-approve rewrites
 * the tool input. The audit trail is the ordinary intervention log.
 *
 * Listener design: the serve loop owns the main member's cursor, so decisions
 * are watched by a lazy OBSERVER sidekick membership (`<name>-hitl`): cheap,
 * read-only, and it can never eat a question meant for the serve loop.
 */
import { RoomMember } from "./client.js";
import type { AgentDef } from "./agentdef.js";

export interface InterruptRule {
  allowed_decisions?: ("approve" | "edit" | "reject" | "respond")[];
  /** Input keys of which one must be present before a human is paged (src/agentdef.ts). */
  require_one_of?: string[];
}

/** Match a tool name against interrupt_on keys (trailing `*` = prefix glob; an exact rule always beats a glob). */
export function interruptMatch(
  interruptOn: AgentDef["interrupt_on"],
  toolName: string,
): InterruptRule | null {
  const entries = Object.entries(interruptOn ?? {});
  const resolve = (rule: boolean | { allowed_decisions?: InterruptRule["allowed_decisions"]; require_one_of?: string[] }): InterruptRule | null =>
    rule === false ? null : rule === true ? {} : { allowed_decisions: rule.allowed_decisions, ...(rule.require_one_of ? { require_one_of: rule.require_one_of } : {}) };
  const exact = entries.find(([p]) => p === toolName);
  if (exact) return resolve(exact[1] as never);
  const glob = entries.find(([p]) => p.endsWith("*") && toolName.startsWith(p.slice(0, -1)));
  return glob ? resolve(glob[1] as never) : null;
}

export interface ApprovalOutcome {
  approved: boolean;
  /** Edit-before-approve: the params the human substituted, when they did. */
  params?: Record<string, unknown>;
  reason: string;
  /** A clock closed the window, not a person (wire 12.4: `expired`, never `rejected`). */
  expired?: boolean;
}

/** Delivery margin subtracted from the asker's deadline, so the card dies first (spec 16.1). */
const REPLY_BY_MARGIN_MS = 30_000;
/** Floor: a nearly-expired ask still gets a real chance at a human (spec 16.1). */
const APPROVAL_FLOOR_MS = 60_000;
/**
 * Window for an ask that carries no `reply_by` (spec 16.1), matching the
 * `npm run ask` default. There is no ceiling above this: a longer asker
 * deadline buys a longer window, bounded only by what the in-process wait of
 * 16.4 survives (minutes to about an hour, not hours).
 */
export const DEFAULT_APPROVAL_WINDOW_MS = 30 * 60_000;

/**
 * The approval window, derived from the asker's own deadline (spec 16.1): the
 * card must never outlive its audience, and must never die before it either.
 */
export function approvalWindowMs(replyBy: string | null | undefined, now: number = Date.now()): number {
  const remaining = replyBy ? Date.parse(replyBy) - now - REPLY_BY_MARGIN_MS : NaN;
  return Number.isFinite(remaining) ? Math.max(APPROVAL_FLOOR_MS, remaining) : DEFAULT_APPROVAL_WINDOW_MS;
}

/**
 * The refusal reason a denied tool call owes the asker (wire 12.4). Only the
 * clock is `deadline_expired`; a human "no" is `declined`. Null when nothing
 * was denied, so the answer is an ordinary response.
 */
export function refusalForOutcome(outcome: ApprovalOutcome): "deadline_expired" | "declined" | null {
  if (outcome.approved) return null;
  return outcome.expired ? "deadline_expired" : "declined";
}

let approvalSeq = 0;

/**
 * A short human-readable label for a tool call (spec 12.5's `action`), derived
 * from the tool name HERE rather than in the hub, which is forbidden from deriving
 * it and could not do so honestly anyway: only the caller knows what its own
 * namespaced identifier means.
 *
 * `mcp__linear__save_document` becomes "save document". The identifier still
 * travels, untouched, as `tool_name`.
 */
export function humanAction(toolName: string): string {
  const tail = toolName.split("__").filter(Boolean).pop() ?? toolName;
  const words = tail.replace(/[_-]+/g, " ").trim();
  return words.length > 0 ? words.slice(0, 64) : toolName.slice(0, 64);
}

/**
 * The requester's preview of its own input: one `key: value` line per field, most
 * informative first, so the first 512 characters the hub keeps are the ones a
 * decider needs.
 *
 * Not `JSON.stringify`, which spends its first characters on braces and quoting
 * and then gets truncated mid-token. A human deciding whether to authorize a
 * document write wants to see the title, not `{"content":"# Spec produ`.
 */
export function previewLines(input: Record<string, unknown>): string {
  const render = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (v === null || v === undefined) return String(v);
    if (Array.isArray(v)) return `[${v.length} item(s)]`;
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  };
  // Short scalars first: they are the identifying fields (title, project, id), and
  // a long body would otherwise consume the whole preview before naming what it is.
  const entries = Object.entries(input).sort(([, a], [, b]) => render(a).length - render(b).length);
  return entries.map(([k, v]) => `${k}: ${render(v)}`).join("\n");
}

/**
 * Publish an approval request for a pending tool call and block until a
 * human-origin decision, the expiry, or the timeout. The request is sent by
 * the MAIN member (we are inside its serve handler, so no send races); the
 * decision is watched by the sidekick.
 */
export async function requestApproval(
  member: RoomMember,
  sidekick: RoomMember,
  opts: {
    toolName: string;
    input: Record<string, unknown>;
    allowedDecisions?: string[];
    timeoutMs?: number;
    runId?: string;
  },
): Promise<ApprovalOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_WINDOW_MS;
  const requestId = `apr_${opts.runId ?? "run"}_${++approvalSeq}_${Date.now().toString(36)}`;
  const serialized = JSON.stringify(opts.input);
  const send = await member.send({
    kind: "request",
    body:
      `APPROVAL NEEDED: I want to call ${opts.toolName}.\n` +
      `Input: ${serialized.slice(0, 1500)}${serialized.length > 1500 ? "... (truncated)" : ""}\n` +
      `Decide in the console Inbox (request ${requestId}).`,
    ext: {
      // Spec 12.5, and this half MUST ship with the hub-side enforcement: a hub
      // that enforces 12.5 rejects an ext missing `tool_name` or `input_preview`
      // with `bad_request`, which would be every approval this bridge raises, that
      // is the whole human-in-the-loop path.
      "io.github.pbeneteau/approval": {
        request_id: requestId,
        // `action` and `tool_name` are DIFFERENT required fields and a hub may not
        // derive one from the other: a decider UI keys on the identifier and
        // displays the label. This used to send the tool name as the label, which
        // is why an operator's inbox read `mcp__linear__save_document` where a
        // heading belongs.
        action: humanAction(opts.toolName),
        tool_name: opts.toolName,
        // The requester's own preview. The hub neutralizes it and caps it at 512
        // with a counted elision marker, so what is sent here is the full readable
        // form and the hub decides what fits.
        input_preview: previewLines(opts.input),
        // The decider's client gets the full input; the hub never inspects it.
        params: opts.input,
        allowed_decisions: opts.allowedDecisions ?? ["approve", "edit", "reject"],
        expires_at: new Date(Date.now() + timeoutMs).toISOString(),
      },
    },
  });

  // Watch from the request's seq; the sidekick's cursor is ours to spend.
  sidekick.cursor = send.seq;
  const deadline = Date.now() + timeoutMs + 5_000;
  while (Date.now() < deadline) {
    // The serve loop is blocked on us, so the MAIN member's lease renewal is
    // our job here: without this the resident goes gone_quiet mid-approval
    // (found live) and the asker rightly gives up on it.
    await member.setPresence("busy", { detail: "awaiting human approval" }).catch(() => {});
    const events = await sidekick.listenOnce({ timeoutMs: 20_000, waitFor: "all" });
    for (const e of events) {
      if (e.type === "intervention" && (e.verb === "approve" || e.verb === "reject")) {
        const refs = e.refs as { request_id?: string; params?: Record<string, unknown> };
        if (refs.request_id !== requestId) continue;
        return e.verb === "approve"
          ? { approved: true, params: refs.params, reason: `approved by ${e.actor}${refs.params ? " (edited)" : ""}` }
          : { approved: false, reason: `rejected by ${e.actor}` };
      }
      if (e.type === "system" && e.event === "approval_expired") {
        const refs = e.refs as { request_id?: string };
        if (refs.request_id === requestId) return { approved: false, reason: "approval expired unanswered", expired: true };
      }
    }
  }
  // The sweep's event never reached us, but the window closed all the same:
  // still a clock, so still `expired` rather than a human refusal (12.4).
  return { approved: false, reason: "approval wait timed out", expired: true };
}

/** The lazy observer sidekick: joined once per resident process, reused. */
export async function joinSidekick(
  hubUrl: string,
  room: string,
  joinSecret: string | null,
  residentName: string,
): Promise<RoomMember> {
  return RoomMember.create({
    hubUrl,
    room,
    joinSecret: joinSecret ?? undefined,
    name: `${residentName}-hitl`,
    role: "observer",
    card: { name: `${residentName}-hitl`, description: `approval watcher for ${residentName} (observer)` },
    clientInfo: { name: "rfa-bridge", version: "0.4.6" },
  });
}
