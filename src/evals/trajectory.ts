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
 * - scoreConcurrentTrial(): the same reward algebra over a TUPLE of asks issued
 *   at once (kind: live-concurrent). One trial is one tuple, so a tuple's
 *   pass/fail is what pass^k samples.
 * - measureRunOverlap(): whether the subject really ran two asks at once,
 *   measured on ITS OWN run windows out of runs.db. The client's send-to-reply
 *   windows are a separate datum (measureInFlightTogether) and never this one:
 *   they all start in the same tick, so their intersection is non-empty however
 *   thoroughly the subject serialized the tuple.
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

/**
 * The subject's answering prose in a slice, normalized the way must_mention
 * matches it. One definition, because the contamination check in a concurrent
 * tuple must read exactly the text must_mention reads: a marker that counts as
 * present for one ask has to count as leaked for the other.
 */
function answerText(events: RfaEvent[], subject: string): string {
  return norm(
    messages(events)
      .filter((m) => m.envelope.from.id === subject && (m.envelope.kind === "response" || m.envelope.kind === "chat"))
      .map(textOf)
      .join("\n"),
  );
}

/** A marker matches when ANY of its "a|b" alternatives appears. */
const hits = (text: string, marker: string): boolean => marker.split("|").some((alt) => text.includes(norm(alt)));

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
    const said = answerText(events, subject);
    const missing = expect.output.must_mention.filter((m) => !hits(said, m));
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

// ---------------------------------------------------------------- concurrent tuples (kind: live-concurrent)

/** One ask inside a tuple. Its markers are ITS OWN: must_not_mention is the other asks' markers. */
export interface ConcurrentAsk {
  ask: string;
  must_mention?: string[];
  /** Markers whose presence means this answer carries another conversation's content. */
  must_not_mention?: string[];
}

/** A half-open wall-clock window, ms since epoch. */
export interface Window {
  startedAt: number;
  endedAt: number;
}

/**
 * The RESIDENT's own run window: `started_at` and `ended_at` of its row in
 * runs.db, which is the only clock that says when the subject was actually
 * working on this ask.
 */
export type RunWindow = Window;

/** What the runner observed for ONE ask of a tuple. */
export interface AskObservation {
  /**
   * Position in the tuple, CARRIED rather than inferred from array position: the
   * asks settle out of order by construction, and every feedback row, marker set
   * and report line is keyed on this number.
   */
  index: number;
  ask: ConcurrentAsk;
  /** The question + answer slice, exactly what a single live trial scores. */
  events: RfaEvent[];
  /**
   * The answer's json part, or null when the answer carried NONE. Absent is not
   * the same as present-without-a-run_id: an answer with no json part at all is
   * UNMEASURABLE by this harness (an older resident, or a member that is not one
   * of ours), and blaming the subject's quality for the harness's blindness is
   * how a configuration state enters a baseline as a quality number.
   */
  json: { runId: string | null } | null;
  /**
   * The CLIENT's send-to-reply window: "both in flight". NEVER the overlap. Every
   * ask of a tuple is issued in the same tick, so these windows all start at t0
   * and their intersection is non-empty whatever the subject did - it reported
   * overlap on a fully serialized pack, which is the defect this field's name now
   * exists to prevent.
   */
  client: Window;
  /**
   * The subject's OWN run window, read from runs.db by run id. Null when it could
   * not be read (no runs.db, no run id, a member that is not a local pack), in
   * which case the overlap is UNMEASURED rather than absent.
   */
  run: RunWindow | null;
  /** Why `run` is null, when it is. Carried into the report so "unmeasured" says why. */
  runNote?: string | null;
}

/** Pure interval arithmetic: the widest pairwise intersection, and the total span. */
export function intersectWindows(windows: Window[]): { ms: number; spanMs: number } {
  if (windows.length === 0) return { ms: 0, spanMs: 0 };
  let ms = 0;
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      ms = Math.max(ms, Math.min(a.endedAt, b.endedAt) - Math.max(a.startedAt, b.startedAt));
    }
  }
  const first = Math.min(...windows.map((w) => w.startedAt));
  const last = Math.max(...windows.map((w) => w.endedAt));
  return { ms: Math.max(0, ms), spanMs: Math.max(0, last - first) };
}

/**
 * `overlapped`: the subject ran two asks at once, measured on its own run rows.
 * `serialized`: it ran them one after the other, which is CORRECT at
 * `concurrency: 1`. `unmeasured`: the run rows could not be read, so nothing is
 * known either way - and a case that ASSERTS overlap fails on it, because a
 * metric that cannot be read must never pass an assertion by default.
 */
export type OverlapState = "overlapped" | "serialized" | "unmeasured";

export interface OverlapMeasure {
  state: OverlapState;
  /** True only for `overlapped`. An unmeasured tuple is not an overlapping one. */
  overlapped: boolean;
  /** The widest pairwise intersection of the RUN windows, in ms (0 when serialized or unmeasured). */
  ms: number;
  /** Wall clock from the first run start to the last run end, so `ms` has a scale. */
  spanMs: number;
  detail: string;
}

/**
 * The overlap, measured on the subject's OWN run windows.
 *
 * NOT on the client's send-to-reply windows. That is the defect this function
 * replaces: a tuple's asks are issued in the same tick, so every client window
 * starts at t0, every pairwise intersection is non-empty, and `expect_overlap`
 * became an assertion that could not fail - a live run reported "overlap 11.4s"
 * on a pack that had serialized the pair. The run rows are the subject's clock:
 * two windows that intersect there mean two turns really were in flight at once.
 */
export function measureRunOverlap(runs: (RunWindow | null)[], why?: string | null): OverlapMeasure {
  const missing = runs.filter((r) => r === null).length;
  if (missing > 0 || runs.length < 2) {
    const because = why ? `: ${why}` : "";
    const what = runs.length < 2 ? `fewer than two run windows to intersect (${runs.length})` : `${missing}/${runs.length} run window(s) unreadable`;
    return {
      state: "unmeasured",
      overlapped: false,
      ms: 0,
      spanMs: 0,
      detail: `overlap UNMEASURED (${what}${because}); a case asserting overlap FAILS on this rather than passing`,
    };
  }
  const { ms, spanMs } = intersectWindows(runs as RunWindow[]);
  return {
    state: ms > 0 ? "overlapped" : "serialized",
    overlapped: ms > 0,
    ms,
    spanMs,
    detail:
      ms > 0
        ? `overlap ${(ms / 1000).toFixed(1)}s of ${(spanMs / 1000).toFixed(1)}s span, on the subject's own run windows`
        : `NO overlap (the subject serialized the tuple): ${(spanMs / 1000).toFixed(1)}s span of run time`,
  };
}

/**
 * "Both in flight": the intersection of the CLIENT's send-to-reply windows. A
 * separate, deliberately separately-named datum, reported so a reader can see how
 * long the harness held the tuple open - and never read as the overlap, since it
 * is non-empty by construction.
 */
export interface InFlightTogether {
  ms: number;
  spanMs: number;
  detail: string;
}

export function measureInFlightTogether(windows: Window[]): InFlightTogether {
  const { ms, spanMs } = intersectWindows(windows);
  return {
    ms,
    spanMs,
    detail: `both in flight ${(ms / 1000).toFixed(1)}s of ${(spanMs / 1000).toFixed(1)}s client span (NOT the overlap: the asks are issued in one tick)`,
  };
}

export interface ConcurrentTrialResult {
  score: 0 | 1;
  /**
   * Set when this tuple could not be MEASURED at all (an answer with no json
   * part). The runner excludes such a trial from pass^k instead of scoring it 0:
   * the harness could not see, which is not the subject failing.
   */
  unmeasurable: string | null;
  /** MEASURED on the subject's run windows, per trial. The assertion is at CASE level. */
  overlap: OverlapMeasure;
  /** The client windows' intersection, kept as its own datum. Never the overlap. */
  inFlightTogether: InFlightTogether;
  /** Per-ask reward, so a tuple failure says WHICH ask and why. */
  perAsk: { index: number; ask: string; score: 0 | 1; comment: string }[];
  /** The run ids the answers carried, in tuple order. */
  runIds: (string | null)[];
  comment: string;
}

/**
 * Score one tuple. All of these must hold, or the trial fails:
 *
 *  1. every ask's answer satisfies its OWN must_mention, and none of its
 *     must_not_mention (the cross-contamination check: an answer carrying the
 *     sibling's marker means the two concurrent conversations bled together);
 *  2. every answer carries a run_id, and they are DISTINCT across the tuple
 *     (two concurrent answers sharing one run id is the shared-run-context bug
 *     class this ladder started from);
 *  3. the per-ask protocol lints in expect.protocol pass for each ask.
 *
 * `expect.output` and `expect.state` are NOT read here: a tuple's expectations
 * are per-ask by construction, and the case shape carries them on each ask (a
 * case that sets either is rejected at load by validateConcurrentCase).
 *
 * The overlap is MEASURED here and asserted at CASE level, never per trial: one
 * legitimately serialized tuple (a lease held elsewhere, a reservation refused on
 * one leg) must not zero a correct pack.
 */
export function scoreConcurrentTrial(observations: AskObservation[], subject: string, expect: ExpectBlock): ConcurrentTrialResult {
  if (observations.length < 2) throw new Error("a concurrent trial is a tuple: at least two asks, got " + observations.length);
  const notes: string[] = [];
  const perAsk: ConcurrentTrialResult["perAsk"] = [];
  let ok = true;

  for (const obs of observations) {
    const reward = computeReward(obs.events, subject, {
      output: obs.ask.must_mention?.length ? { must_mention: obs.ask.must_mention } : undefined,
      protocol: expect.protocol,
    });
    const said = answerText(obs.events, subject);
    const leaked = (obs.ask.must_not_mention ?? []).filter((m) => hits(said, m));
    const askScore = (reward.score === 1 && leaked.length === 0 ? 1 : 0) as 0 | 1;
    const detail = leaked.length ? `${reward.comment}; CONTAMINATED: carries ${JSON.stringify(leaked)}` : reward.comment;
    if (askScore === 0) {
      ok = false;
      notes.push(`ask ${obs.index + 1}: ${detail}`);
    }
    perAsk.push({ index: obs.index, ask: obs.ask.ask, score: askScore, comment: detail });
  }

  // An answer with NO json part is the harness being blind, not the subject
  // being wrong: report the tuple unmeasurable and let the runner exclude it.
  const noJson = observations.filter((o) => o.json === null);
  const unmeasurable = noJson.length
    ? `${noJson.length}/${observations.length} answer(s) carried no json part, so no run id could be read: this tuple is UNMEASURABLE (excluded, not scored 0)`
    : null;

  const runIds = observations.map((o) => o.json?.runId ?? null);
  if (!unmeasurable) {
    const missing = runIds.filter((r) => !r).length;
    if (missing) {
      ok = false;
      notes.push(`run_id absent on ${missing}/${runIds.length} answer(s) that DID carry a json part`);
    }
    const present = runIds.filter((r): r is string => Boolean(r));
    if (present.length > 1 && new Set(present).size !== present.length) {
      ok = false;
      notes.push(`run_id SHARED across the tuple (${present.join(", ")}): the concurrent answers ran in one run context`);
    }
  }

  const overlap = measureRunOverlap(
    observations.map((o) => o.run),
    observations.find((o) => o.run === null && o.runNote)?.runNote ?? null,
  );
  const inFlightTogether = measureInFlightTogether(observations.map((o) => o.client));

  return {
    score: (ok ? 1 : 0) as 0 | 1,
    unmeasurable,
    overlap,
    inFlightTogether,
    perAsk,
    runIds,
    comment: `${unmeasurable ?? (ok ? `${observations.length} asks answered, run ids distinct` : notes.join("; "))} · ${overlap.detail} · ${inFlightTogether.detail}`,
  };
}

/**
 * Reject a malformed `live-concurrent` case AT LOAD, with the reasons. Both of
 * these used to be accepted and then silently produce nothing:
 *
 *  - `expect.output` / `expect.state` are never read for a tuple (its
 *    expectations are per ask), so a case that sets them was asserting nothing
 *    while looking like it asserted something;
 *  - a marker that is required and forbidden on the SAME ask cannot be satisfied
 *    by any answer, so the case fails forever and reads as a quality collapse.
 */
export function validateConcurrentCase(def: { asks?: ConcurrentAsk[]; expect?: ExpectBlock }): string[] {
  const problems: string[] = [];
  const asks = def.asks ?? [];
  if (asks.length < 2) problems.push("kind live-concurrent needs at least two asks (one trial is one simultaneous tuple, not one ask)");
  if (def.expect?.output) problems.push("expect.output is not read for a tuple: put must_mention on each ask instead");
  if (def.expect?.state) problems.push("expect.state is not read for a tuple: a tuple scores answers, not board state");
  asks.forEach((ask, i) => {
    const forbidden = new Set((ask.must_not_mention ?? []).flatMap((m) => m.split("|").map(norm)));
    for (const marker of ask.must_mention ?? []) {
      const alts = marker.split("|").map(norm);
      if (alts.length > 0 && alts.every((alt) => forbidden.has(alt))) {
        problems.push(`ask ${i + 1}: ${JSON.stringify(marker)} is in must_mention AND must_not_mention, which no answer can satisfy`);
      }
    }
  });
  return problems;
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
