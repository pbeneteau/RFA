/**
 * Evals core (RFA v0.4 spec section 8): room logs ARE trajectories.
 *
 * - rfaLogToTrajectory(): a pure map from a room event slice to OpenAI-style
 *   messages (subject-centric; task-board actions become synthetic
 *   tool_calls), so agentevals/openevals evaluators run unmodified over what
 *   the hub already persists.
 * - Protocol lints: pure functions over raw events (the SWE-bench
 *   "invariants" half: a run that meets its goal while violating one fails).
 * - computeReward(): tau-bench's computed reward, r = r_state x r_output x
 *   r_protocol, each factor in {0,1}, components reported.
 * - passHatK(): tau-bench's estimator, E_task[C(c,k)/C(n,k)]: the chance ALL
 *   k trials of a task succeed. Consistency is the scarce property.
 */
import type { RfaEvent, RfaTask } from "../model.js";

export interface TrajectoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export interface TrajectoryOpts {
  /** The member under evaluation: its messages become `assistant` turns. */
  subject: string;
  /** Keep only this conversation's messages (task events always pass the filter by conversation linkage). */
  conversation?: string;
}

const textOf = (e: Extract<RfaEvent, { type: "message" }>): string =>
  e.envelope.body
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");

export function rfaLogToTrajectory(events: RfaEvent[], opts: TrajectoryOpts): TrajectoryMessage[] {
  const out: TrajectoryMessage[] = [];
  let call = 0;
  for (const e of events) {
    if (e.type === "message") {
      const env = e.envelope;
      if (opts.conversation && env.conversation_id !== opts.conversation) continue;
      const mine = env.from.id === opts.subject;
      const refusal = env.refusal ? ` [refused: ${env.refusal.reason}]` : "";
      if (mine) {
        out.push({ role: "assistant", content: `${textOf(e)}${refusal}` });
      } else {
        out.push({ role: "user", content: `${env.from.name} (${env.kind}): ${textOf(e)}${refusal}` });
      }
    } else if (e.type === "task") {
      const t = e.task;
      const args = JSON.stringify({ id: t.id, title: t.title, state: t.state, owner: t.owner });
      if (e.actor === opts.subject) {
        out.push({
          role: "assistant",
          content: "",
          tool_calls: [{ id: `tc_${++call}`, type: "function", function: { name: `room_task_${e.action}`, arguments: args } }],
        });
      } else {
        out.push({ role: "user", content: `[task ${e.action} by ${e.actor}] ${args}` });
      }
    } else if (e.type === "intervention") {
      out.push({ role: "user", content: `[intervention ${e.verb} by ${e.actor}${e.target ? ` -> ${e.target}` : ""}]` });
    } else if (e.type === "system") {
      out.push({ role: "user", content: `[system ${e.event}] ${JSON.stringify(e.refs)}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- protocol lints

export interface LintResult {
  id: string;
  ok: boolean;
  detail: string;
}

type Lint = (events: RfaEvent[], subject: string) => LintResult;

const messages = (events: RfaEvent[]) => events.filter((e): e is Extract<RfaEvent, { type: "message" }> => e.type === "message");
const tasks = (events: RfaEvent[]) => events.filter((e): e is Extract<RfaEvent, { type: "task" }> => e.type === "task");

export const LINTS: Record<string, Lint> = {
  /** Every request addressed to the subject got a response/refuse (no timeout notice named it). */
  reply_by_honored: (events, subject) => {
    const late = events.filter(
      (e) =>
        e.type === "system" &&
        e.event === "timeout" &&
        messages(events).some(
          (m) => m.envelope.message_id === (e.refs as { message_id?: string }).message_id && m.envelope.mentions.includes(subject),
        ),
    );
    return { id: "reply_by_honored", ok: late.length === 0, detail: late.length ? `${late.length} request(s) timed out on the subject` : "all deadlines met" };
  },
  /** The subject never went quiet while owing a reply. */
  no_gone_quiet: (events, subject) => {
    const gq = events.filter((e) => e.type === "system" && e.event === "gone_quiet" && (e.refs as { member?: string }).member === subject);
    return { id: "no_gone_quiet", ok: gq.length === 0, detail: gq.length ? `subject went quiet ${gq.length} time(s)` : "stayed responsive" };
  },
  /** No task was claimed twice (atomicity held). */
  atomic_claims: (events) => {
    const claims = new Map<string, number>();
    for (const t of tasks(events)) if (t.action === "claim") claims.set(t.task.id, (claims.get(t.task.id) ?? 0) + 1);
    const dup = [...claims.entries()].filter(([, n]) => n > 1);
    return { id: "atomic_claims", ok: dup.length === 0, detail: dup.length ? `double-claimed: ${dup.map(([id]) => id).join(",")}` : "claims atomic" };
  },
  /** Subject responses cite a knowledge source: in the prose OR in a structured json part (machine-readable is better). */
  citations_present: (events, subject) => {
    const answers = messages(events).filter((m) => m.envelope.from.id === subject && m.envelope.kind === "response");
    const uncited = answers.filter((m) => !/[\w-]+\.md|knowledge\/|"sources"/i.test(JSON.stringify(m.envelope.body)));
    return {
      id: "citations_present",
      ok: answers.length > 0 && uncited.length === 0,
      detail: answers.length === 0 ? "no responses from subject" : uncited.length ? `${uncited.length}/${answers.length} responses uncited` : "all responses cited",
    };
  },
  /** Evidence-gated tasks reached completed only through an accepting verifier. */
  evidence_gate_respected: (events) => {
    const finals = new Map<string, RfaTask>();
    for (const t of tasks(events)) finals.set(t.task.id, t.task);
    const bad = [...finals.values()].filter(
      (t) => t.evidence_required && t.state === "completed" && !(t.evidence && t.verification.verdict === "accept" && t.verification.verifier !== t.owner),
    );
    return { id: "evidence_gate_respected", ok: bad.length === 0, detail: bad.length ? `unverified completions: ${bad.map((t) => t.id).join(",")}` : "gate respected" };
  },
  /** Refusals are machine-readable (reason present). */
  refusals_machine_readable: (events, subject) => {
    const refusals = messages(events).filter((m) => m.envelope.from.id === subject && m.envelope.kind === "refuse");
    const bad = refusals.filter((m) => !m.envelope.refusal?.reason);
    return { id: "refusals_machine_readable", ok: bad.length === 0, detail: refusals.length ? `${refusals.length - bad.length}/${refusals.length} well-formed` : "no refusals" };
  },
};

// ---------------------------------------------------------------- computed reward (tau-bench shape)

export interface ExpectBlock {
  /** Goal: expected final task-board state (match by id or title regex). */
  state?: { id?: string; title_regex?: string; state: string; verified?: boolean }[];
  /** Goal: substrings that must appear in the subject's responses ("a|b" = any-of). */
  output?: { must_mention?: string[] };
  /** Invariants: lint ids that must pass (SWE-bench's PASS_TO_PASS half). */
  protocol?: string[];
}

export interface RewardResult {
  key: "reward";
  score: 0 | 1;
  components: { r_state: 0 | 1; r_output: 0 | 1; r_protocol: 0 | 1 };
  comment: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, "");

export function computeReward(events: RfaEvent[], subject: string, expect: ExpectBlock): RewardResult {
  const notes: string[] = [];

  let rState: 0 | 1 = 1;
  if (expect.state?.length) {
    const finals = new Map<string, RfaTask>();
    for (const t of tasks(events)) finals.set(t.task.id, t.task);
    for (const want of expect.state) {
      const found = [...finals.values()].find(
        (t) => (want.id ? t.id === want.id : true) && (want.title_regex ? new RegExp(want.title_regex, "i").test(t.title) : true),
      );
      const ok =
        found !== undefined &&
        found.state === want.state &&
        (want.verified === undefined || (found.verification.verdict === "accept") === want.verified);
      if (!ok) {
        rState = 0;
        notes.push(`state: expected ${want.id ?? want.title_regex} = ${want.state}${want.verified ? " verified" : ""}, got ${found ? `${found.state}` : "no such task"}`);
      }
    }
  }

  let rOutput: 0 | 1 = 1;
  if (expect.output?.must_mention?.length) {
    const answerText = norm(
      messages(events)
        .filter((m) => m.envelope.from.id === subject && (m.envelope.kind === "response" || m.envelope.kind === "chat"))
        .map(textOf)
        .join("\n"),
    );
    const missing = expect.output.must_mention.filter((m) => !m.split("|").some((alt) => answerText.includes(norm(alt))));
    if (missing.length) {
      rOutput = 0;
      notes.push(`output: missing ${JSON.stringify(missing)}`);
    }
  }

  let rProtocol: 0 | 1 = 1;
  for (const lintId of expect.protocol ?? []) {
    const lint = LINTS[lintId];
    if (!lint) {
      rProtocol = 0;
      notes.push(`protocol: unknown lint ${lintId}`);
      continue;
    }
    const res = lint(events, subject);
    if (!res.ok) {
      rProtocol = 0;
      notes.push(`protocol: ${res.id} FAILED (${res.detail})`);
    }
  }

  const score = (rState * rOutput * rProtocol) as 0 | 1;
  return {
    key: "reward",
    score,
    components: { r_state: rState, r_output: rOutput, r_protocol: rProtocol },
    comment: notes.length ? notes.join("; ") : "all goals and invariants met",
  };
}

// ---------------------------------------------------------------- pass^k (tau-bench estimator)

/**
 * pass^k = E_task[ C(c,k) / C(n,k) ]: for each task with n trials and c
 * successes, the probability that ALL of k randomly drawn trials succeed.
 */
export function passHatK(trialsPerTask: boolean[][], k: number): number {
  if (trialsPerTask.length === 0) return 0;
  const per = trialsPerTask.map((trials) => {
    const n = trials.length;
    const c = trials.filter(Boolean).length;
    if (k > n) throw new Error(`pass^${k} needs at least ${k} trials, got ${n}`);
    let ratio = 1;
    for (let i = 0; i < k; i++) ratio *= (c - i) / (n - i);
    return Math.max(0, ratio);
  });
  return per.reduce((a, b) => a + b, 0) / per.length;
}
