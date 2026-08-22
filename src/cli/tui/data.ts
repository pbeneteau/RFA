/**
 * What the dashboard reads, with no React in it: the status the CLI already
 * collects, the approvals the console already serves, the observability store
 * read-only, a room log tailed from its file. The dashboard is a view over the
 * same data every command prints, which is what keeps it honest.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RoomMember } from "../../client.js";
import type { HubDir, RoomRecord } from "../../hubdir.js";
import { roomsStore } from "../../hubdir.js";
import { packageVersion } from "../../pkg.js";
import type { CliContext } from "../context.js";
import { collectStatus } from "../commands/procs.js";
import { speaker } from "../commands/talk.js";

export interface AgentView {
  name: string;
  model: string;
  room: string | null;
  offers: string[];
  mode: string;
  definition: string;
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
  supervisor: { running: boolean; pid: number | null; stale_pid_file: boolean; started_at: string | null; state_age_ms: number | null; account: { cap?: number; in_flight?: number; paused_until?: string | null; pause_reason?: string | null } | null };
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
  return { at, status, approvals, alerts: obs.alerts, summary: obs.summary, recent: obs.recent, perHour: obs.perHour, error };
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

// ---------------------------------------------------------------- asking

export interface AskOutcome {
  kind: "response" | "refuse";
  text: string;
  target: string;
  capability: string;
  elapsed_ms: number;
  cost_usd: number | null;
  run_id: string | null;
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

export async function askInRoom(ctx: CliContext, h: HubDir, rec: RoomRecord, capability: string, question: string, timeoutMs = 1800_000): Promise<AskOutcome> {
  const { me, ephemeral } = await speaker(ctx, h, rec);
  try {
    const roster = await me.refreshRoster();
    const eligible = roster.filter((r) => r.id !== me.memberId && r.role === "participant" && r.state !== "offline" && r.card_summary.skill_ids.includes(capability));
    const target = eligible.find((r) => r.state === "ready") ?? eligible[0];
    if (!target) throw new Error(`nobody in ${rec.alias} offers ${capability} right now`);
    const t0 = Date.now();
    const a = await me.ask(target.id, question, { timeoutMs });
    const meta = a.parts.find((p) => p.type === "json")?.value as { cost_usd?: number; run_id?: string } | undefined;
    return { kind: a.kind, text: a.text, target: target.name, capability, elapsed_ms: Date.now() - t0, cost_usd: meta?.cost_usd ?? null, run_id: meta?.run_id ?? null, refusal: a.refusal ? `${a.refusal.reason}${a.refusal.detail ? `: ${a.refusal.detail}` : ""}` : null };
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
  return { kind: a.kind, text: a.text, target: target.name, capability: skillId, elapsed_ms: Date.now() - t0, cost_usd: meta?.cost_usd ?? null, run_id: meta?.run_id ?? null, refusal: a.refusal ? a.refusal.reason : null };
}

export function recordedRooms(h: HubDir): RoomRecord[] {
  try {
    return roomsStore(h).read().rooms;
  } catch {
    return [];
  }
}
