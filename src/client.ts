/**
 * rfa-client: the member-side SDK for RFA 0.1.
 *
 * Encodes the client obligations of spec section 9.5 so agents do not have to
 * re-learn them by prompt: cursor discipline, presence heartbeats, reply
 * correlation, refusal handling, untrusted-content wrapping, and capability
 * projection (roster skills -> callable tool definitions, the
 * "discover agents like MCP tools" contract made executable).
 *
 * Speaks the modern-era (2026-07-28) MCP wire over HTTP; works against any
 * conforming hub.
 */
import type { AgentCard, Envelope, Part, PresenceRecord, RefusalReason, RfaEvent, SendResult } from "./model.js";
import { neutralize, renderWrapped } from "./wrap.js";

/** Wire 12.4 (0.1.8) added `deadline_expired`; `RefusalReason` and the hub's send schema still predate it. */
export type SendableRefusalReason = RefusalReason | "deadline_expired";

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

export class RfaClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RfaClientError";
  }
}

export interface AskResult {
  kind: "response" | "refuse";
  text: string;
  parts: Part[];
  envelope: Envelope;
  refusal: { reason: string; detail?: string; retry_after_s?: number } | null;
}

export interface ServeContext {
  text: string;
  envelope: Envelope;
  /** The message pre-wrapped as untrusted data, ready to paste into a model prompt. */
  wrapped: string;
  conversationId: string | null;
  from: { id: string; name: string };
}

/**
 * A serve handler's answer when the answer is a refusal, not prose (wire 12.4:
 * an approval that closed on the clock owes the asker `deadline_expired`).
 * The refusal is sent by this member's own client; the hub never speaks in a
 * member's voice, so nothing else can produce it.
 */
export class ServeRefusal {
  constructor(
    readonly reason: SendableRefusalReason,
    readonly detail: string,
    /** What the asker reads; defaults to the detail. */
    readonly body: string | Part[] = detail,
  ) {}
}

export interface ProjectedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  member: string;
  memberName: string;
  skillId: string;
  invoke: (args: Record<string, unknown> | string, opts?: { timeoutMs?: number }) => Promise<AskResult>;
}

export interface RoomMemberOptions {
  hubUrl: string;
  name: string;
  card: AgentCard;
  /** Join an existing room; omit (with `topic`) to create one. */
  room?: string;
  joinSecret?: string;
  topic?: string;
  policies?: Record<string, unknown>;
  historyLimit?: number;
  role?: "participant" | "observer" | "supervisor";
  /** Provisioned human-principal key (hub --human-key): grants origin=human, required to join as supervisor. */
  humanKey?: string;
  clientInfo?: { name: string; version: string };
}

let msgCounter = 0;
function mid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(++msgCounter).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export class RoomMember {
  readonly hubUrl: string;
  readonly room: string;
  readonly memberId: string;
  readonly name: string;
  readonly membershipToken: string;
  /** Present only when this member created the room. */
  readonly joinSecret: string | null;
  cursor: number;
  epoch: number;
  roster: PresenceRecord[];
  private clientInfo: { name: string; version: string };
  private cardCache = new Map<string, AgentCard>();

  private constructor(init: {
    hubUrl: string;
    room: string;
    memberId: string;
    name: string;
    membershipToken: string;
    joinSecret: string | null;
    cursor: number;
    epoch: number;
    roster: PresenceRecord[];
    clientInfo: { name: string; version: string };
  }) {
    this.hubUrl = init.hubUrl;
    this.room = init.room;
    this.memberId = init.memberId;
    this.name = init.name;
    this.membershipToken = init.membershipToken;
    this.joinSecret = init.joinSecret;
    this.cursor = init.cursor;
    this.epoch = init.epoch;
    this.roster = init.roster;
    this.clientInfo = init.clientInfo;
  }

  /** Create a room (with `topic`) or join an existing one (with `room` [+ `joinSecret`]). */
  static async create(opts: RoomMemberOptions): Promise<RoomMember> {
    const clientInfo = opts.clientInfo ?? { name: "rfa-client", version: "0.1.0" };
    const call = (tool: string, args: Record<string, unknown>) => rawCall(opts.hubUrl, clientInfo, tool, args);
    const contract = opts.room
      ? await call("room_join", {
          room: opts.room,
          join_secret: opts.joinSecret,
          name: opts.name,
          card: opts.card,
          role: opts.role,
          human_key: opts.humanKey,
          history_limit: opts.historyLimit,
        })
      : await call("room_create", {
          topic: opts.topic ?? "rfa-client room",
          name: opts.name,
          card: opts.card,
          policies: opts.policies,
          human_key: opts.humanKey,
        });
    return new RoomMember({
      hubUrl: opts.hubUrl,
      room: contract.room,
      memberId: contract.you.id,
      name: contract.you.name,
      membershipToken: contract.you.membership_token,
      joinSecret: contract.join_secret ?? null,
      cursor: contract.history.cursor,
      epoch: contract.epoch,
      roster: contract.roster,
      clientInfo,
    });
  }

  /** Resume a saved membership (token survives hub restarts). Throws if it no longer works. */
  static async resume(saved: {
    hubUrl: string;
    room: string;
    membershipToken: string;
    memberId: string;
    name: string;
    cursor?: number;
    joinSecret?: string | null;
    clientInfo?: { name: string; version: string };
  }): Promise<RoomMember> {
    const clientInfo = saved.clientInfo ?? { name: "rfa-client", version: "0.1.0" };
    const roster = await rawCall(saved.hubUrl, clientInfo, "room_roster", {
      room: saved.room,
      membership_token: saved.membershipToken,
    });
    if (roster.ended) throw new RfaClientError("room_ended", `room ${saved.room} has ended`);
    return new RoomMember({
      hubUrl: saved.hubUrl,
      room: saved.room,
      memberId: saved.memberId,
      name: saved.name,
      membershipToken: saved.membershipToken,
      joinSecret: saved.joinSecret ?? null,
      cursor: Math.min(saved.cursor ?? 0, roster.cursor),
      epoch: roster.epoch,
      roster: roster.roster,
      clientInfo,
    });
  }

  private call(tool: string, args: Record<string, unknown>): Promise<any> {
    return rawCall(this.hubUrl, this.clientInfo, tool, { room: this.room, membership_token: this.membershipToken, ...args });
  }

  /** One listen window; advances the cursor and keeps epoch/roster tracking honest. */
  async listenOnce(opts: { timeoutMs?: number; waitFor?: string; presence?: "ready" | "busy" | "away" } = {}): Promise<RfaEvent[]> {
    const res = await this.call("room_listen", {
      since: this.cursor,
      timeout_ms: opts.timeoutMs ?? 25_000,
      wait_for: opts.waitFor ?? "mentions",
      presence: opts.presence,
    });
    this.cursor = res.cursor;
    if (res.epoch !== this.epoch) await this.refreshRoster();
    return res.events as RfaEvent[];
  }

  async refreshRoster(): Promise<PresenceRecord[]> {
    const res = await this.call("room_roster", {});
    this.epoch = res.epoch;
    this.roster = res.roster;
    return this.roster;
  }

  /** Moderation verbs (spec section 12); requires host or supervisor authority. */
  async admin(
    verb:
      | "hold_member"
      | "release_member"
      | "interrupt"
      | "evict"
      | "quarantine"
      | "inject"
      | "cancel_task"
      | "approve"
      | "reject"
      | "set_policy"
      | "set_role"
      | "grant_floor",
    opts: { target?: string; reason?: string; params?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> {
    return this.call("room_admin", { verb, ...opts });
  }

  async setPresence(
    state: "ready" | "busy" | "away",
    extras: { detail?: string; waiting_for?: string; task?: string; ttl_s?: number; card?: AgentCard } = {},
  ): Promise<void> {
    await this.call("room_presence", { state, ...extras });
    if (extras.card) this.cardCache.clear();
  }

  async send(args: {
    body: Part[] | string;
    kind?: "chat" | "request" | "response" | "refuse" | "status";
    to?: string[];
    mentions?: string[];
    conversationId?: string;
    inReplyTo?: string;
    replyBy?: Date | string;
    chunk?: { index: number; final: boolean };
    refusal?: { reason: string; detail?: string; retry_after_s?: number };
    presence?: "ready" | "busy" | "away";
    meta?: Record<string, unknown>;
    ext?: Record<string, unknown>;
  }): Promise<SendResult> {
    return this.call("room_send", {
      message_id: mid("msg_" + this.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)),
      kind: args.kind,
      body: typeof args.body === "string" ? [{ type: "text", text: args.body }] : args.body,
      to: args.to,
      mentions: args.mentions,
      conversation_id: args.conversationId,
      in_reply_to: args.inReplyTo,
      reply_by: args.replyBy instanceof Date ? args.replyBy.toISOString() : args.replyBy,
      chunk: args.chunk,
      refusal: args.refusal,
      presence: args.presence,
      _meta: args.meta,
      ext: args.ext,
    });
  }

  /**
   * Ask another member and wait for its reply. Returns responses AND refusals
   * (a machine-readable "busy" is an answer, not an exception); streamed
   * chunked responses are assembled until the final chunk.
   */
  async ask(
    target: string,
    text: string,
    opts: { timeoutMs?: number; conversationId?: string; extraParts?: Part[]; replyByMs?: number } = {},
  ): Promise<AskResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const messageId = mid("msg_ask_" + this.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8));
    const sent = await this.call("room_send", {
      message_id: messageId,
      kind: "request",
      mentions: [target],
      conversation_id: opts.conversationId,
      reply_by: new Date(Date.now() + (opts.replyByMs ?? timeoutMs)).toISOString(),
      body: [{ type: "text", text }, ...(opts.extraParts ?? [])],
    });
    // This wait runs on its OWN cursor, starting at our send's seq, and never
    // touches `this.cursor`. Two things follow. First, ask() is now legal from
    // a serving member (this used to throw busy_loop): the log is replayable,
    // so two concurrent listens cannot steal each other's events, and serve()'s
    // own filters already skip response kinds and our own traffic; only a
    // SHARED cursor made concurrency unsafe. Second, the old bug class is gone
    // by construction: advancing the shared cursor to our own send silently
    // swallowed anything appended in between (an integrator hit that), and an
    // isolated cursor has nothing to swallow from.

    const deadline = Date.now() + timeoutMs;
    const chunks: Envelope[] = [];
    let since = sent.seq as number;
    while (Date.now() < deadline) {
      const window = Math.max(1_000, Math.min(25_000, deadline - Date.now()));
      const res = await this.call("room_listen", { since, timeout_ms: window, wait_for: "mentions" });
      since = res.cursor as number;
      if (res.epoch !== this.epoch) await this.refreshRoster();
      const events = res.events as RfaEvent[];
      for (const event of events) {
        if (event.type === "system" && event.refs?.message_id === messageId && event.event === "timeout") {
          throw new RfaClientError("reply_timeout", `no reply to ${messageId} before its reply_by`, { target });
        }
        if (event.type === "system" && event.event === "gone_quiet" && Array.isArray(event.refs.askers) && event.refs.askers.includes(this.memberId)) {
          throw new RfaClientError("gone_quiet", `the member owing a reply went offline`, { refs: event.refs });
        }
        if (event.type !== "message") continue;
        const env = event.envelope;
        if (env.in_reply_to !== messageId) continue;
        if (env.kind === "refuse") {
          return { kind: "refuse", text: textOf(env.body), parts: env.body, envelope: env, refusal: env.refusal };
        }
        if (env.kind === "response" || env.kind === "chat") {
          if (env.chunk && !env.chunk.final) {
            chunks.push(env);
            continue;
          }
          const all = [...chunks, env];
          return {
            kind: "response",
            text: all.map((e) => textOf(e.body)).filter(Boolean).join("\n"),
            parts: all.flatMap((e) => e.body),
            envelope: env,
            refusal: null,
          };
        }
      }
    }
    throw new RfaClientError("ask_timeout", `no reply from ${target} within ${timeoutMs}ms`, { target });
  }

  /**
   * Become a resident: answer every request/chat addressed to this member.
   * The handler returns the reply (string or parts); throwing sends a
   * machine-readable "overloaded" refusal. Runs until the signal aborts or
   * the room ends.
   */
  async serve(
    handler: (ctx: ServeContext) => Promise<string | Part[] | ServeRefusal>,
    opts: {
      signal?: AbortSignal;
      presence?: "ready" | "busy" | "away";
      onCycle?: (cursor: number) => void;
      onError?: (err: Error) => void;
      /**
       * Task events reaching this member (the hub routes them to a task's
       * owner, creator and verifier under the mentions filter). Without this
       * hook they were DELIVERED and silently dropped here, so an executor
       * could never notice an assignment: the hub spent effort routing the
       * event to exactly the right member and the client threw it away with
       * no refusal and no log (found 2026-08-21). Throwing inside the hook is
       * reported through onError and never kills the loop.
       */
      onTask?: (event: { task: Record<string, unknown>; action: string; actor: string | null }) => Promise<void>;
    } = {},
  ): Promise<void> {
    while (!opts.signal?.aborted) {
        let events: RfaEvent[];
        try {
          events = await this.listenOnce({ timeoutMs: 25_000, waitFor: "mentions", presence: opts.presence ?? "ready" });
        } catch (err) {
          if ((err as RfaClientError).code === "room_ended") return;
          opts.onError?.(err as Error);
          await sleep(5_000);
          continue;
        }
        opts.onCycle?.(this.cursor);
        for (const event of events) {
          if (opts.signal?.aborted) return;
          if (event.type === "system" && event.event === "room_ended") return;
          if (event.type === "task" && opts.onTask) {
            const t = event as unknown as { task: Record<string, unknown>; action: string; actor: string | null };
            try {
              await opts.onTask(t);
            } catch (err) {
              opts.onError?.(err as Error);
            }
            continue;
          }
          if (event.type !== "message") continue;
          const env = event.envelope;
          if (env.from.id === this.memberId) continue;
          if (env.kind !== "request" && env.kind !== "chat") continue;
          const text = textOf(env.body);
          if (!text.trim()) continue;
          try {
            const answer = await handler({
              text,
              envelope: env,
              wrapped: RoomMember.wrapForModel(env),
              conversationId: env.conversation_id,
              from: { id: env.from.id, name: env.from.name },
            });
            await this.send({
              kind: answer instanceof ServeRefusal ? "refuse" : env.kind === "request" ? "response" : "chat",
              inReplyTo: env.message_id,
              conversationId: env.conversation_id ?? undefined,
              to: [env.from.id],
              body: answer instanceof ServeRefusal ? answer.body : answer,
              refusal: answer instanceof ServeRefusal ? { reason: answer.reason, detail: answer.detail.slice(0, 200) } : undefined,
              presence: opts.presence ?? "ready",
            });
          } catch (err) {
            opts.onError?.(err as Error);
            try {
              await this.send({
                kind: "refuse",
                inReplyTo: env.message_id,
                conversationId: env.conversation_id ?? undefined,
                refusal: { reason: "overloaded", detail: "answer generation failed, retry shortly", retry_after_s: 60 },
                body: "Answer generation failed; please retry shortly.",
              });
            } catch {
              /* room may have ended */
            }
          }
        }
      }
  }

  /**
   * Capability projection: every skill of every OTHER participant becomes a
   * callable tool definition, ready to hand to a model. Invoking one sends a
   * request to that member and awaits the reply.
   */
  async projectTools(): Promise<ProjectedTool[]> {
    await this.refreshRoster();
    const tools: ProjectedTool[] = [];
    for (const member of this.roster) {
      if (member.id === this.memberId || member.role !== "participant") continue;
      let card = this.cardCache.get(member.digest);
      if (!card) {
        const described = await this.call("agent_describe", { digest: member.digest });
        card = described.card as AgentCard;
        this.cardCache.set(member.digest, card);
      }
      for (const skill of card.skills ?? []) {
        const toolName = `ask_${member.name}__${skill.id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        tools.push({
          name: toolName,
          description: `${card.description} :: ${skill.description}`.slice(0, 1024),
          inputSchema:
            skill.inputSchema ?? {
              type: "object",
              properties: { question: { type: "string", description: "The question or task for this agent" } },
              required: ["question"],
            },
          member: member.id,
          memberName: member.name,
          skillId: skill.id,
          invoke: (args, invokeOpts) => {
            const text = typeof args === "string" ? args : typeof args.question === "string" ? args.question : JSON.stringify(args);
            return this.ask(member.id, text, {
              timeoutMs: invokeOpts?.timeoutMs,
              extraParts: [{ type: "json", value: { skill: skill.id, args: typeof args === "string" ? { question: args } : args } }],
            });
          },
        });
      }
    }
    return tools;
  }

  /** Task-board passthrough (tasks profile, spec 10.2). */
  async task(args: Record<string, unknown>): Promise<any> {
    return this.call("room_task", args);
  }

  async leave(): Promise<void> {
    await this.call("room_leave", {});
  }

  /**
   * Wrap a peer message as untrusted data for inclusion in a model prompt.
   * The body goes through the SAME neutralizer as the memory path: this escaped
   * the boundary tag but passed control and bidi characters straight into the
   * prompt, so a peer could hide text from the human reading the same message.
   */
  static wrapForModel(env: Envelope): string {
    // The hub also ships `wrapped` (spec 9.6); this renders the identical
    // string from the same module so a local client and a stranger's hub
    // cannot disagree about what the boundary looks like.
    return renderWrapped({
      name: env.from.name,
      origin: env.from.origin,
      kind: env.kind,
      home: env.from.home,
      text: textOf(env.body),
    });
  }


  /**
   * Prepare a peer message for storage in retrievable memory (spec 14.3): the
   * stored record keeps provenance and stays neutralized, so it re-enters a
   * prompt later still marked as untrusted data. Pair with a MemoryGate:
   * auto-ingesting peer messages without one is a wormable design.
   */
  static sanitizeForMemory(env: Envelope): MemoryRecord {
    return {
      text: neutralize(textOf(env.body)),
      from: {
        id: env.from.id,
        name: env.from.name.replace(/[^\p{L}\p{N} _.\-:]/gu, ""),
        origin: env.from.origin,
      },
      room: env.room,
      seq: env.seq,
      ts: env.ts,
      kind: env.kind,
      wrapped: RoomMember.wrapForModel(env),
    };
  }
}

/** A peer message sanitized for retrievable memory: neutralized text + provenance. */
export interface MemoryRecord {
  text: string;
  from: { id: string; name: string; origin: string };
  room: string;
  seq: number;
  ts: string;
  kind: string;
  /** Prompt-ready boundary form for retrieval time. */
  wrapped: string;
}

export interface MemoryGateOptions {
  /** How many recent messages to compare against (default 64). */
  window?: number;
  /** Jaccard similarity (5-char shingles) at or above which cross-sender content is flagged (default 0.9). */
  threshold?: number;
  /** Texts shorter than this skip similarity (tiny acks collide naturally; default 40 chars). */
  minLength?: number;
}

export type MemoryGateVerdict =
  | { ok: true; record: MemoryRecord }
  | { ok: false; reason: "replicated"; similarity: number; matchedFrom: string; record: MemoryRecord };

/**
 * Replication detector for retrievable memory (the Morris-II defense, spec
 * 14.3): near-identical content arriving from DIFFERENT senders is the
 * signature of a self-replicating prompt spreading hop to hop. inspect()
 * sanitizes the message, compares it against a bounded window of recent peer
 * content, and flags cross-sender near-duplicates instead of admitting them.
 * Same-sender repeats are left to the hub's duplicate suppression.
 */
export class MemoryGate {
  private windowSize: number;
  private threshold: number;
  private minLength: number;
  private seen: { from: string; shingles: Set<string> }[] = [];

  constructor(opts: MemoryGateOptions = {}) {
    this.windowSize = opts.window ?? 64;
    this.threshold = opts.threshold ?? 0.9;
    this.minLength = opts.minLength ?? 40;
  }

  inspect(env: Envelope): MemoryGateVerdict {
    const record = RoomMember.sanitizeForMemory(env);
    const v = this.inspectText(record.text, env.from.id);
    return v.ok ? { ok: true, record } : { ...v, record };
  }

  /**
   * Envelope-free gate for direct memory writes (the memory tool): flag text
   * that near-duplicates recent content from a DIFFERENT sender. An agent
   * persisting a copy of peer content into its own memory is the exact
   * worm-persistence move spec 14.3 exists to block.
   */
  inspectText(
    text: string,
    senderId: string,
  ): { ok: true } | { ok: false; reason: "replicated"; similarity: number; matchedFrom: string } {
    const shingles = shinglesOf(text);
    let verdict: { ok: true } | { ok: false; reason: "replicated"; similarity: number; matchedFrom: string } = { ok: true };
    if (text.length >= this.minLength) {
      for (let i = this.seen.length - 1; i >= 0; i--) {
        const prior = this.seen[i];
        if (prior.from === senderId) continue;
        const sim = jaccard(shingles, prior.shingles);
        if (sim >= this.threshold) {
          verdict = { ok: false, reason: "replicated", similarity: sim, matchedFrom: prior.from };
          break;
        }
      }
    }
    // Flagged content still enters the window: later copies of the same worm
    // payload must keep matching even after the original entry ages out.
    this.seen.push({ from: senderId, shingles });
    if (this.seen.length > this.windowSize) this.seen.shift();
    return verdict;
  }
}


function shinglesOf(text: string): Set<string> {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i + 5 <= norm.length; i++) out.add(norm.slice(i, i + 5));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tools that are safe to repeat if the answer never arrived (spec 9.5). Sends
 * are excluded on purpose: they carry a message_id and the hub dedupes them,
 * but a blind retry here would race that logic, so the caller decides.
 */
const IDEMPOTENT_TOOLS = new Set(["room_roster", "room_listen", "room_presence", "agent_describe", "room_task"]);

/** Bounded jitter, so a hub restart does not get a thundering herd of residents. */
const RETRY_DELAYS_MS = [250, 1_000, 3_000];

async function rawCall(
  hubUrl: string,
  clientInfo: { name: string; version: string },
  tool: string,
  args: Record<string, unknown>,
): Promise<any> {
  let lastErr: unknown;
  const attempts = IDEMPOTENT_TOOLS.has(tool) ? RETRY_DELAYS_MS.length + 1 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await rawCallOnce(hubUrl, clientInfo, tool, args);
    } catch (err) {
      lastErr = err;
      // Only transport failures and the hub's own "come back later" are worth
      // repeating. A refusal, a bad cursor or an auth failure will say the same
      // thing every time.
      const code = (err as RfaClientError).code;
      const message = (err as Error).message ?? "";
      const transient =
        /fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up|EHOSTUNREACH|ETIMEDOUT|503/i.test(message) ||
        code === "overloaded" ||
        code === "rate_limited";
      if (!transient || attempt === attempts - 1) throw err;
      const retryAfter = Number((err as RfaClientError).data?.retry_after_s ?? 0) * 1000;
      const base = Math.max(RETRY_DELAYS_MS[attempt], retryAfter);
      await sleep(base + Math.random() * base * 0.25);
    }
  }
  throw lastErr;
}

/**
 * Transport credential for a hub that requires one (spec 4.2). Read from the
 * environment rather than threaded through every call site, because it belongs
 * to the PROCESS and its deployment, not to a membership: one agent may hold
 * several memberships and they all present the same bearer. A hub with no
 * tokens configured ignores it, so setting it is always safe.
 *
 * UNRUN SPIKE (RFA-0.6 section 4.4): whether a third-party MCP host can carry a
 * static Authorization header into a registered server is unmeasured. If it
 * cannot, the credential moves into tool arguments and this changes shape.
 */
/**
 * Read per call, NOT captured at module load: a static `import` is evaluated
 * before any statement in the importing module, so a tool that resolves the
 * token from a secrets file and then sets the variable would have been too late
 * and every call went out unauthenticated. Found by running `npm run ask`
 * against an authenticated hub.
 */
const rfaToken = (): string | undefined => process.env.RFA_TOKEN?.trim() || undefined;

async function rawCallOnce(
  hubUrl: string,
  clientInfo: { name: string; version: string },
  tool: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(hubUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "Mcp-Method": "tools/call",
      "Mcp-Name": tool,
      ...((): Record<string, string> => { const t = rfaToken(); return t ? { authorization: `Bearer ${t}` } : {}; })(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args, _meta: { ...META, "io.modelcontextprotocol/clientInfo": clientInfo } },
    }),
  });
  const text = await res.text();
  // A transport-level refusal is not JSON-RPC: the hub answers 401/403/429 with
  // a plain JSON body, and parsing it as an envelope produced the useless
  // "rpc error" that a stranger would have had to guess at. Name it instead.
  if (!res.ok && res.status !== 200) {
    let detail = text.slice(0, 200);
    try {
      const body = JSON.parse(text) as { error?: string };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      /* not JSON: keep the raw prefix */
    }
    const code =
      res.status === 401 || res.status === 403
        ? "unauthorized"
        : res.status === 429
          ? "rate_limited"
          : res.status >= 500
            ? "overloaded"
            : "bad_request";
    const retryAfter = Number(res.headers.get("retry-after") ?? 0);
    throw new RfaClientError(code, `hub returned ${res.status}: ${detail}`, {
      status: res.status,
      ...(retryAfter > 0 ? { retry_after_s: retryAfter } : {}),
      ...(code === "unauthorized" && res.headers.get("www-authenticate")
        ? { hint: "this hub requires a transport credential; set RFA_TOKEN" }
        : {}),
    });
  }
  // Frame by CONTENT-TYPE, never by sniffing for "data: " in the body: the
  // hub's own `instructions` string can contain that substring, and a client
  // written this way crashes on the join contract. Found live by writing a
  // second client from the spec, which is exactly what that exercise is for.
  const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
  const payload = isSse
    ? JSON.parse(
        text
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("") || "{}",
      )
    : JSON.parse(text);
  if (payload.error) throw new RfaClientError("rpc_error", payload.error.message ?? "rpc error");
  let inner: any;
  try {
    inner = JSON.parse(payload.result.content[0].text);
  } catch {
    throw new RfaClientError("bad_tool_result", `${tool}: ${String(payload.result.content?.[0]?.text).slice(0, 200)}`);
  }
  if (payload.result.isError || inner.error) {
    const e = inner.error ?? { code: "unknown", message: "tool error" };
    throw new RfaClientError(e.code, e.message, e.data ?? {});
  }
  return inner;
}
