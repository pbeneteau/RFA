/**
 * What the dashboard reads, with no React in it: the status the CLI already
 * collects, the approvals the console already serves, the observability store
 * read-only, a room log tailed from its file. The dashboard is a view over the
 * same data every command prints, which is what keeps it honest.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RoomMember } from "../../client.js";
import { Engine, type CandidateSet } from "../../engine.js";
import type { HubDir, RoomRecord } from "../../hubdir.js";
import { roomsStore } from "../../hubdir.js";
import { TERMINAL_TASK_STATES, type RfaTask } from "../../model.js";
import { packageVersion } from "../../pkg.js";
import { reviewQueueCounts, type QueueCounts } from "../../evals/label.js";
import type { CliContext } from "../context.js";
import { listCases } from "../commands/instruments.js";
import { collectStatus } from "../commands/procs.js";
import { board, memberFor, recordLastAsk, speaker } from "../commands/talk.js";

export interface AgentView {
  name: string;
  model: string;
  room: string | null;
  offers: string[];
  mode: string;
  definition: string;
  /** Turns this pack may run at once, and its default candidate fan-out (RFA-0.8 sects. 10 and 11). */
  concurrency: number;
  candidates: number;
  supervisor: { pid: number | null; status: string; started_at: string | null; definition_hash: string; restarts_in_window: number } | null;
  heartbeat_age_ms: number | null;
  spend_today_usd: number;
}

export interface RoomView {
  alias: string | null;
  handle: string;
  topic: string;
  ended?: boolean;
  members?: number;
  online?: number;
  guests?: number;
  humans?: number;
  open_tasks?: number;
  pending_approvals?: number;
  held?: number;
  seq?: number;
}

export interface StatusView {
  name: string;
  dir: string;
  mode: "hub" | "remote";
  hub_url: string;
  hub: { running: boolean; healthy: boolean; pid: number | null; stale_pid_file: boolean; started_at: string | null; lock_heartbeat_age_ms: number | null };
  supervisor: { running: boolean; pid: number | null; stale_pid_file: boolean; started_at: string | null; state_age_ms: number | null; account: { cap?: number; in_flight?: number; parked?: number; paused_until?: string | null; pause_reason?: string | null } | null };
  agents: AgentView[];
  rooms: RoomView[];
  rooms_source: "hub" | "file";
}

export interface CardView {
  room: string;
  topic: string;
  request_id: string;
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

export interface RecentAnswer {
  id: string;
  agent: string;
  room: string | null;
  when: number;
  ms: number;
  question: string;
  answer: string;
  cost_usd: number | null;
  error: string | null;
  needs_review: boolean;
}

export interface Snapshot {
  at: number;
  status: StatusView | null;
  approvals: CardView[];
  alerts: string[];
  summary: { runs: number; errors: number; error_pct: number; avg_latency_ms: number; cost_usd: number } | null;
  recent: RecentAnswer[];
  /** Answers per hour over the last 24h, oldest first: the overview's sparkline. */
  perHour: number[];
  /** The labelling sitting's two numbers (spec 20.4/20.5): what waits for a human label, what carries one. Null before the first answer. */
  review: QueueCounts | null;
  error: string | null;
}

export async function snapshot(ctx: CliContext, h: HubDir): Promise<Snapshot> {
  const at = Date.now();
  let status: StatusView | null = null;
  let error: string | null = null;
  try {
    status = (await collectStatus(ctx)) as unknown as StatusView;
  } catch (err) {
    error = (err as Error).message;
  }
  let approvals: CardView[] = [];
  if (status?.hub.healthy && ctx.humanKey()) {
    try {
      approvals = (await ctx.workbench<CardView[]>("/api/approvals")).filter((c) => c.status === "pending");
    } catch {
      approvals = [];
    }
  }
  const obs = await readObs(h);
  let review: QueueCounts | null = null;
  if (fs.existsSync(h.paths.obsDb)) {
    try {
      review = reviewQueueCounts(h.paths.obsDb);
    } catch {
      review = null;
    }
  }
  return { at, status, approvals, alerts: obs.alerts, summary: obs.summary, recent: obs.recent, perHour: obs.perHour, review, error };
}

async function readObs(h: HubDir): Promise<Pick<Snapshot, "alerts" | "summary" | "recent" | "perHour">> {
  const empty = { alerts: [], summary: null, recent: [], perHour: new Array<number>(24).fill(0) };
  if (!fs.existsSync(h.paths.obsDb)) return empty;
  try {
    const { ObsStore, evaluateAlerts } = await import("../../obs.js");
    const store = new ObsStore(h.paths.obsDb);
    try {
      const s = store.summary(15 * 60_000);
      const alerts = evaluateAlerts(s).map((a) => a.message);
      const runs = store.runs({ run_type: "agent_span", limit: 300 });
      const now = Date.now();
      const perHour = new Array<number>(24).fill(0);
      for (const r of runs) {
        const hoursAgo = Math.floor((now - r.end_time) / 3_600_000);
        if (hoursAgo >= 0 && hoursAgo < 24) perHour[23 - hoursAgo]++;
      }
      const recent: RecentAnswer[] = runs.slice(0, 12).map((r) => {
        const inputs = (r.inputs ?? {}) as { text?: string };
        const outputs = (r.outputs ?? {}) as { text?: string };
        return {
          id: r.id,
          agent: r.name.replace(/^serve:/, ""),
          room: r.group_id ?? null,
          when: r.end_time,
          ms: r.end_time - r.start_time,
          question: inputs.text ?? "",
          answer: outputs.text ?? "",
          cost_usd: r.cost_usd ?? null,
          error: r.error ?? null,
          needs_review: r.needs_review === 1,
        };
      });
      const day = store.summary(24 * 3_600_000);
      return { alerts, summary: { runs: day.runs, errors: day.errors, error_pct: day.error_pct, avg_latency_ms: day.avg_latency_ms, cost_usd: day.cost_usd }, recent, perHour };
    } finally {
      store.close();
    }
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------- the gate

export interface GateCase {
  id: string;
  kind: string;
  subject: string;
  where: string;
  failure_mode: string | null;
  /** pass^k in evals/baseline.json, or null when the case has never been baselined. */
  baseline: number | null;
  /** What the last `rfa evals run` recorded for it, or null when that run did not include it. */
  last: { score: number; passk: number | null; trials: boolean[]; refused: number; blocked: string | null; note: string } | null;
}

export interface GateView {
  cases: GateCase[];
  gate: { k: number; band: number };
  lastRun: { ts: string; at: number; judged: boolean } | null;
  corpusVersion: string | null;
}

interface RunReport {
  ts: string;
  judged: boolean;
  results: { id: string; score: number; passk: { k: number; value: number } | null; trials: boolean[]; refused?: string[]; blocked?: string; comments: string[] }[];
}

/** The runner's report name back to an instant: `2026-08-23T09-17-16` was an ISO time with its colons replaced. */
function reportInstant(ts: string): number {
  return Date.parse(`${ts.slice(0, 10)}T${ts.slice(11).replace(/-/g, ":")}Z`);
}

/**
 * The gate as the Evals tab shows it: the cases `rfa evals ls` lists, each with
 * its baseline pass^k and what the newest report under .rfa/reports/evals/ says
 * about it. Every number here is one `rfa evals run` printed.
 */
export function gateView(h: HubDir): GateView {
  const cases = listCases(h);
  let stored: Record<string, unknown> = {};
  if (fs.existsSync(h.paths.evalBaseline)) {
    try {
      stored = JSON.parse(fs.readFileSync(h.paths.evalBaseline, "utf8")) as Record<string, unknown>;
    } catch {
      stored = {};
    }
  }
  const gate = (stored.gate as { k?: number; band?: number } | undefined) ?? {};
  const baseCases = (stored.cases as Record<string, { passk: number }> | undefined) ?? {};
  const baselineOf = (id: string): number | null => {
    if (baseCases[id]) return baseCases[id].passk;
    const flat = stored[id];
    return typeof flat === "number" ? flat : null;
  };
  const reportDir = path.join(h.paths.reports, "evals");
  let report: RunReport | null = null;
  if (fs.existsSync(reportDir)) {
    const newest = fs.readdirSync(reportDir).filter((f) => f.endsWith(".json")).sort().at(-1);
    if (newest) {
      try {
        report = JSON.parse(fs.readFileSync(path.join(reportDir, newest), "utf8")) as RunReport;
      } catch {
        report = null;
      }
    }
  }
  const lastOf = (id: string): GateCase["last"] => {
    const r = report?.results.find((x) => x.id === id);
    if (!r) return null;
    return { score: r.score, passk: r.passk?.value ?? null, trials: r.trials ?? [], refused: r.refused?.length ?? 0, blocked: r.blocked ?? null, note: r.blocked ?? r.comments.at(-1) ?? "" };
  };
  return {
    cases: cases.map((c) => ({ id: c.id, kind: c.kind, subject: c.subject, where: c.where, failure_mode: c.failure_mode, baseline: baselineOf(c.id), last: lastOf(c.id) })),
    gate: { k: gate.k ?? 4, band: gate.band ?? 0.15 },
    lastRun: report ? { ts: report.ts, at: reportInstant(report.ts), judged: Boolean(report.judged) } : null,
    corpusVersion: typeof stored.corpus_version === "string" ? stored.corpus_version : null,
  };
}

// ---------------------------------------------------------------- the feed

export interface FeedLine {
  seq: number;
  ts: string;
  type: string;
  who: string;
  text: string;
  kind?: string;
}

/** One compact line per event, the same reading `rfa room tail` gives, minus the paint. */
export function summarizeEvent(e: Record<string, any>): FeedLine {
  const base = { seq: Number(e.seq ?? 0), ts: String(e.ts ?? ""), type: String(e.type ?? "?") };
  switch (e.type) {
    case "message": {
      const env = e.envelope ?? {};
      const text = env.body?.find((p: { type: string }) => p.type === "text")?.text ?? "";
      const refusal = env.refusal ? ` REFUSE:${env.refusal.reason}` : "";
      const chunk = env.chunk ? ` (chunk ${env.chunk.index}${env.chunk.final ? " final" : ""})` : "";
      return { ...base, who: env.from?.name ?? "?", kind: env.kind, text: `${env.kind ?? ""}${refusal}${chunk} ${String(text).replace(/\s+/g, " ")}`.trim() };
    }
    case "presence":
      return { ...base, who: e.member?.name ?? "?", text: `is ${e.member?.state}${e.member?.detail ? ` (${e.member.detail})` : ""}` };
    case "roster":
      return { ...base, who: "room", text: `${e.reason} (epoch ${e.epoch}): ${(e.members ?? []).map((m: { name: string; state: string }) => `${m.name}:${m.state}`).join(", ")}` };
    case "system":
      return { ...base, who: "hub", text: `${e.event} ${JSON.stringify(e.refs ?? {})}` };
    case "intervention":
      return { ...base, who: String(e.actor ?? "?"), text: `${e.verb} on ${e.target ?? "-"}` };
    case "task":
      return { ...base, who: e.task?.owner ?? "board", text: `task ${e.task?.id ?? "?"} ${e.task?.state ?? ""}: ${String(e.task?.title ?? "").slice(0, 60)}` };
    default:
      return { ...base, who: "?", text: JSON.stringify(e).slice(0, 100) };
  }
}

export function roomLogFile(h: HubDir, handle: string): string {
  return path.join(h.paths.roomLogs, `${handle}.ndjson`);
}

export function tailLines(file: string, max: number): FeedLine[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  return lines.slice(-max).flatMap((l) => {
    try {
      return [summarizeEvent(JSON.parse(l))];
    } catch {
      return [];
    }
  });
}

/**
 * Follow an append-only log: read what grew since the last size. Polling at
 * 500ms rather than fs.watch, because a watcher on a file the hub rewrites on
 * rotation would silently stop, and the cost of a stat twice a second is nil.
 */
export function followFile(file: string, onLines: (lines: FeedLine[]) => void, intervalMs = 500): () => void {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let carry = "";
  const tick = () => {
    try {
      if (!fs.existsSync(file)) return;
      const size = fs.statSync(file).size;
      if (size < offset) {
        offset = 0;
        carry = "";
      }
      if (size === offset) return;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        const chunk = carry + buf.toString("utf8");
        const parts = chunk.split("\n");
        carry = parts.pop() ?? "";
        const out: FeedLine[] = [];
        for (const p of parts) {
          if (!p.trim()) continue;
          try {
            out.push(summarizeEvent(JSON.parse(p)));
          } catch {
            /* a torn line completes on the next tick */
          }
        }
        if (out.length) onLines(out);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* transient; the next tick tries again */
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- the task board

export interface Member {
  id: string;
  name: string;
  origin: string;
  state: string;
  role: string;
  /** The card's skill ids, so a task can be aimed at a capability instead of a name. */
  skills: string[];
}

export interface Board {
  tasks: RfaTask[];
  /** The roster, so owners and creators show by name rather than by member id. */
  members: Member[];
}

export const isOpenTask = (t: RfaTask): boolean => !TERMINAL_TASK_STATES.has(t.state);

/** A room's board and roster, through the operator membership: what `rfa task ls` reads, one hub call each. */
export async function readBoard(ctx: CliContext, h: HubDir, rec: RoomRecord): Promise<Board> {
  const b = await board(ctx, h, rec.alias ?? rec.handle);
  try {
    const tasks = (((await b.call({ action: "list" })) as { tasks?: RfaTask[] }).tasks ?? []).sort((x, y) => Number(x.id.replace(/^t_/, "")) - Number(y.id.replace(/^t_/, "")));
    const raw = (await b.roster()) as { roster?: (Member & { card_summary?: { skill_ids?: string[] } })[] };
    const members = (raw.roster ?? []).map((m) => ({ id: m.id, name: m.name, origin: m.origin, state: m.state, role: m.role, skills: m.card_summary?.skill_ids ?? [] }));
    return { tasks, members };
  } finally {
    await b.close();
  }
}

/** One task action (create, cancel, verify), the same `room_task` call the task commands make. */
export async function taskAction(ctx: CliContext, h: HubDir, rec: RoomRecord, args: Record<string, unknown>): Promise<RfaTask> {
  const b = await board(ctx, h, rec.alias ?? rec.handle);
  try {
    return (await b.call(args)) as RfaTask;
  } finally {
    await b.close();
  }
}

/**
 * The candidate set for a task (RFA-0.8 sect. 11), read from the engine DB.
 *
 * Local on purpose and worth saying at every surface: candidates never reach
 * the wire, so this is a hub-directory read and not a `room_task` call. The room
 * saw one task and will see one completion.
 */
export function readCandidateSet(h: HubDir, taskId: string): CandidateSet | null {
  const engine = new Engine(h.paths.runsDb);
  try {
    return engine.candidateSetForTask(taskId);
  } catch {
    return null;
  } finally {
    engine.close();
  }
}

/**
 * Pick the candidate to keep, and nudge the owner to file it. Exactly what
 * `rfa task select` does, through the same two calls, so the dashboard cannot
 * drift from the command.
 */
export async function selectCandidate(ctx: CliContext, h: HubDir, rec: RoomRecord, setId: string, idx: number, by: string): Promise<string> {
  const engine = new Engine(h.paths.runsDb);
  let set: CandidateSet | null;
  try {
    const chosen = engine.selectCandidate(setId, idx, by);
    if (!chosen.ok) throw new Error(chosen.detail ?? `candidate ${idx} cannot be selected`);
    set = engine.candidateSet(setId);
  } finally {
    engine.close();
  }
  if (set?.task_id) {
    await taskAction(ctx, h, rec, { action: "update", id: set.task_id, note: `candidate ${idx} selected; file it as the evidence` });
  }
  const discarded = (set?.candidates ?? []).filter((c) => c.state === "lost").length;
  return `candidate ${idx} selected: ${discarded} discarded, $${(set?.cost_usd ?? 0).toFixed(4)} for the set`;
}

// ---------------------------------------------------------------- asking

export interface AskOutcome {
  kind: "response" | "refuse";
  text: string;
  target: string;
  capability: string;
  elapsed_ms: number;
  cost_usd: number | null;
  run_id: string | null;
  /** The thread this answer opened or continued: what a reply carries back. */
  conversation: string | null;
  refusal: string | null;
}

export interface Offer {
  capability: string;
  members: string[];
}

/** Who offers what in a room right now, for the ask box's capability pick. */
export async function offersIn(ctx: CliContext, h: HubDir, rec: RoomRecord): Promise<Offer[]> {
  const { me, ephemeral } = await speaker(ctx, h, rec);
  try {
    const roster = await me.refreshRoster();
    const candidates = roster.filter((r) => r.id !== me.memberId && r.role === "participant" && r.state !== "offline");
    const map = new Map<string, string[]>();
    for (const r of candidates) for (const s of r.card_summary.skill_ids) map.set(s, [...(map.get(s) ?? []), r.name]);
    return [...map].map(([capability, members]) => ({ capability, members }));
  } finally {
    if (ephemeral) await me.leave().catch(() => {});
  }
}

export async function askInRoom(ctx: CliContext, h: HubDir, rec: RoomRecord, capability: string, question: string, opts: { timeoutMs?: number; conversationId?: string; prefer?: string } = {}): Promise<AskOutcome> {
  const { me, ephemeral } = await speaker(ctx, h, rec);
  try {
    const roster = await me.refreshRoster();
    const target = memberFor(roster, me.memberId, capability, opts.prefer);
    if (!target) throw new Error(`nobody in ${rec.alias} offers ${capability} right now`);
    const t0 = Date.now();
    const a = await me.ask(target.id, question, { timeoutMs: opts.timeoutMs ?? 1800_000, conversationId: opts.conversationId });
    const meta = a.parts.find((p) => p.type === "json")?.value as { cost_usd?: number; run_id?: string } | undefined;
    const conversation = a.envelope.conversation_id ?? opts.conversationId ?? null;
    if (conversation) recordLastAsk(h, rec.handle, { conversation, capability, target: target.name });
    return { kind: a.kind, text: a.text, target: target.name, capability, elapsed_ms: Date.now() - t0, cost_usd: meta?.cost_usd ?? null, run_id: meta?.run_id ?? null, conversation, refusal: a.refusal ? `${a.refusal.reason}${a.refusal.detail ? `: ${a.refusal.detail}` : ""}` : null };
  } finally {
    if (ephemeral) await me.leave().catch(() => {});
  }
}

/** The first question after init: asked with the operator's own membership, the one init just created. */
export async function firstAsk(ctx: CliContext, room: RoomRecord, skillId: string, question: string): Promise<AskOutcome> {
  ctx.armTransport();
  const me = await RoomMember.resume({ hubUrl: ctx.hubUrl(), room: room.handle, membershipToken: room.operator!.membership_token, memberId: room.operator!.member_id, name: room.operator!.name, clientInfo: { name: "rfa-cli", version: packageVersion() } });
  const roster = await me.refreshRoster();
  const target = roster.find((r) => r.card_summary.skill_ids.includes(skillId));
  if (!target) throw new Error(`nobody offers ${skillId} yet`);
  const t0 = Date.now();
  const a = await me.ask(target.id, question, { timeoutMs: 180_000 });
  const meta = a.parts.find((p) => p.type === "json")?.value as { cost_usd?: number; run_id?: string } | undefined;
  return { kind: a.kind, text: a.text, target: target.name, capability: skillId, elapsed_ms: Date.now() - t0, cost_usd: meta?.cost_usd ?? null, run_id: meta?.run_id ?? null, conversation: a.envelope.conversation_id ?? null, refusal: a.refusal ? a.refusal.reason : null };
}

export function recordedRooms(h: HubDir): RoomRecord[] {
  try {
    return roomsStore(h).read().rooms;
  } catch {
    return [];
  }
}
