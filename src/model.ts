/** RFA 0.1 wire shapes (spec sections 6-9). */

export type PresenceState = "ready" | "busy" | "away" | "offline";
export type DeclaredState = Exclude<PresenceState, "offline">;
export type Role = "participant" | "observer" | "supervisor";
/** Principal class, hub-derived at join (spec 14.1). Agents can never produce "human". */
export type Origin = "human" | "agent";
export type MessageKind = "chat" | "request" | "response" | "refuse" | "status" | "system";
export type RefusalReason = "busy" | "ineligible" | "unauthorized" | "overloaded" | "expired" | "declined";

export interface AgentSkill {
  id: string;
  name?: string;
  description: string;
  tags?: string[];
  inputModes?: string[];
  outputModes?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface AgentCard {
  name: string;
  description: string;
  version?: string;
  provider?: { organization?: string };
  skills?: AgentSkill[];
  signatures?: { protected: string; signature: string }[];
  [k: string]: unknown;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown; schema?: string }
  | { type: "file"; name: string; mime: string; size?: number; url?: string; content_base64?: string };

export interface Refusal {
  reason: RefusalReason;
  detail?: string;
  retry_after_s?: number;
}

export interface Envelope {
  rfa: "0.1";
  message_id: string;
  seq: number;
  ts: string;
  room: string;
  from: { id: string; name: string; origin: "human" | "agent" | "system" };
  kind: MessageKind;
  to: string[];
  mentions: string[];
  conversation_id: string | null;
  in_reply_to: string | null;
  reply_by: string | null;
  task: string | null;
  body: Part[];
  chunk: { index: number; final: boolean } | null;
  refusal: Refusal | null;
  _meta: Record<string, unknown>;
  ext: Record<string, unknown>;
}

export interface CardSummary {
  description: string;
  skill_ids: string[];
}

export interface PresenceRecord {
  id: string;
  name: string;
  role: Role;
  held: boolean;
  state: PresenceState;
  detail: string | null;
  waiting_for: string | null;
  task: string | null;
  digest: string;
  card_verified: boolean | null;
  card_summary: CardSummary;
  joined_at: string;
  last_seen: string;
  lease_expires: string;
  epoch: number;
}

/** Task states: a strict subset mapped 1:1 onto the A2A TaskState machine (spec 10.2). */
export type TaskState = "submitted" | "working" | "input_required" | "completed" | "failed" | "cancelled" | "rejected";
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled", "rejected"]);

export interface TaskEvidence {
  summary: string;
  artifacts?: string[];
}

export interface RfaTask {
  id: string;
  room: string;
  title: string;
  description: string | null;
  state: TaskState;
  created_by: string;
  owner: string | null;
  parent_id: string | null;
  conversation_id: string | null;
  blocks: string[];
  blocked_by: string[];
  reply_by: string | null;
  evidence_required: boolean;
  evidence: TaskEvidence | null;
  verification: { pending: boolean; verifier: string | null; verdict: "accept" | "reject" | null; note: string | null };
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** Distributes Omit over a union (plain Omit collapses discriminated unions). */
export type EventInput = RfaEventBody extends infer E ? (E extends RfaEventBody ? Omit<E, "seq" | "ts"> : never) : never;

/** Every appended event carries a hash chain link: SHA-256 over the JCS form of the previous event (spec 0.4 sect. 7.1). */
export type RfaEvent = RfaEventBody & { prev_hash?: string };

type RfaEventBody =
  | ({ seq: number; ts: string; type: "message" } & { envelope: Envelope })
  | ({ seq: number; ts: string; type: "presence" } & { member: PresenceRecord })
  | ({ seq: number; ts: string; type: "roster" } & {
      reason: "join" | "leave" | "evict" | "role" | "rebind";
      epoch: number;
      actor: string | null;
      members: PresenceRecord[];
    })
  | ({ seq: number; ts: string; type: "task" } & { action: string; actor: string; task: RfaTask })
  | ({ seq: number; ts: string; type: "system" } & { event: string; refs: Record<string, unknown> })
  | ({ seq: number; ts: string; type: "intervention" } & {
      verb: string;
      actor: string;
      target: string | null;
      reason: string | null;
      refs: Record<string, unknown>;
    });

export interface RoomPolicies {
  join: "open" | "invite";
  attention: "mentions" | "all";
  mode: "open" | "sequential" | "moderator";
  /** Member id who assigns the floor in moderator mode; null falls back to the host. */
  moderator: string | null;
  history_visibility: "member" | "joined_after";
  max_members: number;
  /** Per-member sends/minute; null falls back to the hub-wide default (v0.4.2 rate budgets). */
  member_rpm?: number | null;
  /** Max unanswered outbound requests per member; null = unlimited. */
  max_pending_requests?: number | null;
}

/** Floor-control state exposed by room_roster (moderation profile, spec 12.3). */
export interface FloorInfo {
  mode: RoomPolicies["mode"];
  holder: string | null;
  queue: string[];
}

export interface RecipientDisposition {
  member: string;
  name: string;
  presence: PresenceState;
  delivery: "live" | "queued";
}

export interface SendResult {
  seq: number;
  ts: string;
  message_id: string;
  conversation_id: string | null;
  recipients: RecipientDisposition[];
}

export interface ListenResult {
  events: RfaEvent[];
  cursor: number;
  epoch: number;
  lease_expires: string;
  ambient_skipped: number;
  compacted: number;
}

export interface JoinContract {
  room: string;
  topic: string;
  policies: RoomPolicies;
  you: { id: string; name: string; role: Role; origin: Origin; membership_token: string; requested_name_adjusted: boolean };
  roster: PresenceRecord[];
  epoch: number;
  history: { events: RfaEvent[]; cursor: number; truncated: boolean };
  instructions: string;
}

export interface DescribeResult {
  member: string;
  card: AgentCard;
  digest: string;
  verified: boolean | null;
  verification: { kid: string | null; alg: string | null; method: "trusted" | "embedded" | "unresolved"; ok: boolean }[];
  ttl_ms: number;
  cache_scope: "room";
}
