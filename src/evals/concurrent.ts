/**
 * kind: live-concurrent - the tuple issuance half of the eval runner, behind an
 * injected port (RFA-0.4 spec section 8, the concurrency case of RFA-0.8).
 *
 * It lives in its own module for one reason: `src/evals/runner.ts` calls `main()`
 * at import, so nothing inside it can be imported by a test, and the pieces that
 * decide whether this case measures anything - the simultaneous issuance, the
 * index attribution, the refusal classification, the run-window read - were
 * therefore untested. A SEQUENTIAL loop would have passed every test in the
 * suite. Everything here takes its room, its clock and its run rows through
 * `ConcurrentPort`, so a fake can drive the whole path and resolve OUT OF ORDER.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import type { PresenceRecord, RfaEvent } from "../model.js";
import type { AskResult } from "../client.js";
import {
  measureInFlightTogether,
  measureRunOverlap,
  scoreConcurrentTrial,
  type AskObservation,
  type ConcurrentAsk,
  type ExpectBlock,
  type OverlapMeasure,
  type RunWindow,
} from "./trajectory.js";

/**
 * The SUBJECT's own run windows, out of the engine DB (`.rfa/data/runs.db`, whose
 * `runs` rows carry `started_at` and `ended_at`; see src/engine.ts). This is the
 * clock the overlap is measured on, and the reason is worth keeping written down:
 * the harness's own send-to-reply windows all start in the same tick, so their
 * intersection is non-empty however thoroughly the resident serialized the tuple,
 * and the metric built on them reported overlap on a fully serialized pack.
 *
 * The resident settles the run BEFORE it sends the answer (engine.completeRun,
 * then the reply body), so by the time an ask resolves its row is final: no
 * polling. Read-only, and every failure is null rather than a throw - an
 * unreadable window makes the overlap UNMEASURED, which FAILS an expect_overlap
 * case rather than passing it.
 *
 * `label` is what the caller wants the operator to see in place of the path
 * (a hub-relative path, rather than an absolute one in a report).
 */
export function openRunWindows(file: string, label = file): { lookup: (runId: string) => RunWindow | null; unavailable: string | null } {
  if (!fs.existsSync(file)) {
    return { lookup: () => null, unavailable: `no ${label}: nothing local has run here, so the subject's own run windows cannot be read` };
  }
  let db: Database.Database | null = null;
  let stmt: Database.Statement;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    stmt = db.prepare(`SELECT started_at, ended_at FROM runs WHERE run_id = ?`);
  } catch (err) {
    db?.close();
    return { lookup: () => null, unavailable: `${label} could not be read (${(err as Error).message.slice(0, 80)})` };
  }
  // The handle stays open for the life of the caller's process, which for the eval
  // runner is one run: a readonly connection holds a WAL read mark, so this is not
  // a thing to keep open in a long-lived process.
  return {
    unavailable: null,
    lookup: (runId: string) => {
      try {
        const row = stmt.get(runId) as { started_at: string | null; ended_at: string | null } | undefined;
        // A row with no start or no end is a run still in flight or never picked
        // up: unmeasured, not zero.
        if (!row?.started_at || !row.ended_at) return null;
        const startedAt = Date.parse(row.started_at);
        const endedAt = Date.parse(row.ended_at);
        return Number.isFinite(startedAt) && Number.isFinite(endedAt) ? { startedAt, endedAt } : null;
      } catch {
        return null;
      }
    },
  };
}

/** One asker: a fresh membership per ask (duplicate suppression is per sender). */
export interface ConcurrentAsker {
  memberId: string;
  name: string;
  roster: PresenceRecord[];
  ask(target: string, text: string, opts: { timeoutMs?: number }): Promise<AskResult>;
}

export interface ConcurrentPort {
  /** Mint one fresh asker. Called once per ask of every trial, in tuple order. */
  mint(label: string): Promise<ConcurrentAsker>;
  /** Leave every minted probe. Always called, even when a tuple throws. */
  release(): Promise<void>;
  /**
   * The SUBJECT's own run window for a run id, out of runs.db, or null when it
   * cannot be read. Null is a first-class answer here: no runs.db, a member that
   * is not a local pack, a row with no timestamps. It makes the overlap
   * UNMEASURED, which fails an `expect_overlap` case rather than passing it.
   */
  runWindow(runId: string): RunWindow | null;
  /** Why runWindow returns null for everything, when it does. Carried into the report. */
  runWindowUnavailable?: string | null;
  /** The question+answer event slice a scored trial reads, built the same way a single live trial builds it. */
  slice(asker: ConcurrentAsker, ask: string, answer: AskResult): RfaEvent[];
  /** The answer's json part: `null` when the answer carried NONE (unmeasurable, see AskObservation.json). */
  json(answer: AskResult): { runId: string | null } | null;
  now?: () => number;
}

/**
 * The LIVE port, built here rather than inside `src/evals/runner.ts` for the same
 * reason everything else in this module lives here: the runner calls `main()` at
 * import, so a port constructed in it can never be exercised by a test, and the
 * `openRunWindows` call plus the `runWindow` wiring were the last unexercised
 * pieces of the rebuilt overlap metric. A test builds this against a temp hub
 * directory holding a real runs.db.
 *
 * `runsDbLabel` is what the operator sees in place of the path (a hub-relative
 * path, never an absolute one in a report).
 */
export function liveConcurrentPort(args: {
  runsDb: string;
  runsDbLabel?: string;
  /** The eval harness's probe pool: one fresh membership per ask, released together. */
  pool: { mint(label: string): Promise<ConcurrentAsker>; release(): Promise<void> };
  slice: ConcurrentPort["slice"];
  json: ConcurrentPort["json"];
}): ConcurrentPort {
  const runs = openRunWindows(args.runsDb, args.runsDbLabel ?? args.runsDb);
  return {
    mint: (label) => args.pool.mint(label),
    release: () => args.pool.release(),
    runWindow: runs.lookup,
    runWindowUnavailable: runs.unavailable,
    slice: args.slice,
    json: args.json,
  };
}

export interface ConcurrentCaseDef {
  id: string;
  asks?: ConcurrentAsk[];
  subject?: string;
  subject_capability?: string;
  trials?: number;
  timeout_ms?: number;
  expect: ExpectBlock;
  expect_overlap?: boolean;
}

/** A sink for evaluator feedback, satisfied structurally by ObsStore. */
export interface FeedbackSink {
  feedback(row: { run_id: string; key: string; score: number; comment: string; source_type: "evaluator" }): void;
  markReview(runId: string, flag: boolean): void;
}

export interface TrialRecord {
  index: number;
  /** null when the trial was excluded (refused by infrastructure, or unmeasurable). */
  passed: boolean | null;
  overlap: OverlapMeasure;
  inFlightTogetherMs: number;
  comment: string;
  observations: AskObservation[];
}

export interface ConcurrentOutcome {
  /** Tuple-level pass/fail, one boolean per SCORED trial: what pass^k samples. */
  trials: boolean[];
  /** Trials excluded because the subject refused for an INFRASTRUCTURE reason (budget, credential, provider capacity). */
  refused: string[];
  /** Trials excluded because the harness could not measure them (an answer with no json part). */
  unmeasurable: string[];
  /**
   * Dispatcher-produced refusals. These are the surface UNDER TEST refusing a
   * simultaneous ask, so they are counted as FAILED trials, never filed as
   * infrastructure - filing them as infrastructure reported BLOCKED and hid the
   * exact regression this case exists to catch.
   */
  dispatcherRefusals: string[];
  comments: string[];
  subject: PresenceRecord | null;
  /** Set when the case could not run at all: an unresolvable subject is a CONFIGURATION state, never a score of 0. */
  blocked: string | null;
  perTrial: TrialRecord[];
  /** The tuple observations of the first SCORED trial, for the judge (a tuple has no single trajectory). */
  firstScored: AskObservation[] | null;
}

/**
 * A refusal classified. `infrastructure` is the subject's environment (budget
 * ceiling, credential, provider capacity): the trial is excluded, exactly as a
 * single-ask case excludes it. `dispatcher` is the subject's own concurrency
 * machinery refusing a simultaneous ask, which is a FAILURE of the thing this
 * case measures.
 */
export type RefusalClass = "infrastructure" | "dispatcher";

/**
 * The dispatcher's own refusal details (src/dispatch.ts). Matched on text
 * because the wire reason alone cannot separate the two senses: `overloaded`
 * carries both "this agent has N requests queued" (the dispatcher shedding a
 * simultaneous ask) and "daily budget exhausted" / "no account slot" (the
 * environment), and `deadline_expired` carries both the dispatcher's reply_by
 * verdict and the approval card's clock (wire 12.4). test/evalconcurrent.test.ts
 * drives a real Dispatcher into every one of its refusals and asserts this
 * classifier sees them, so the coupling fails loudly if those strings drift.
 *
 * The ACCOUNT concurrency cap is deliberately on the INFRASTRUCTURE side, and is
 * pinned there by a test even though its detail says the word "concurrency": it is
 * `cap_reached` out of src/account.ts (the operator's ceiling on the shared model
 * account, reaching the asker as `overloaded` through AccountStop), so a slot the
 * INSTANCE does not have is the environment the subject runs in - the same class as
 * a budget ceiling or a missing credential, fixed by configuration rather than by
 * the pack - and the trial is excluded rather than failed. Only the subject's own
 * dispatcher shedding a simultaneous ask is the surface this case measures.
 */
const DISPATCHER_DETAIL = /request(?:\(s\)|s)? queued|queued across|reply_by|concurrency \d/i;

export function classifyRefusal(refusal: { reason?: string; detail?: string } | null): RefusalClass {
  const reason = refusal?.reason ?? "";
  const detail = refusal?.detail ?? "";
  // `would_deadlock` (wire 8, 0.1.9) has one producer and it is the concurrency
  // machinery: a chain that would wait on itself. Never infrastructure.
  if (reason === "would_deadlock") return "dispatcher";
  if ((reason === "overloaded" || reason === "deadline_expired") && DISPATCHER_DETAIL.test(detail)) return "dispatcher";
  return "infrastructure";
}

const refusalText = (answer: AskResult): string =>
  `${answer.refusal?.reason ?? "refused"}${answer.refusal?.detail ? `: ${answer.refusal.detail}` : ""}`;

/**
 * Run one live-concurrent case: `trials` simultaneous tuples through `port`.
 *
 * ONE TRIAL IS ONE SIMULTANEOUS TUPLE. Every ask goes out in the same tick, each
 * from its own fresh probe, and `Promise.allSettled` holds them in flight
 * together - allSettled rather than all, so one ask's timeout cannot leave its
 * sibling running while the probes are released. The answers are attributed by
 * the index the issuing closure captured, never by settle order.
 */
export async function runConcurrentCase(
  def: ConcurrentCaseDef,
  port: ConcurrentPort,
  opts: { obs?: FeedbackSink | null } = {},
): Promise<ConcurrentOutcome> {
  const asks = def.asks ?? [];
  // Defense in depth: the case is also validated at load (validateConcurrentCase).
  if (asks.length < 2) {
    throw new Error(`case ${def.id}: kind live-concurrent needs at least two asks (one trial is one simultaneous tuple, not one ask)`);
  }
  const now = port.now ?? Date.now;
  const obs = opts.obs ?? null;
  // Per ASK, not per tuple: the two clocks both start at t0, so a pack that
  // serializes the tuple must fit answer 1 AND answer 2 inside this ceiling or
  // its queueing is recorded as a timeout.
  const timeoutMs = (def.timeout_ms ?? 120_000) * asks.length;

  const out: ConcurrentOutcome = {
    trials: [], refused: [], unmeasurable: [], dispatcherRefusals: [], comments: [],
    subject: null, blocked: null, perTrial: [], firstScored: null,
  };

  try {
    for (let i = 0; i < (def.trials ?? 1); i++) {
      // One probe per ask, minted sequentially: a join is not what this case
      // measures, and the ASKS are what has to be simultaneous.
      const tuple: ConcurrentAsker[] = [];
      for (let j = 0; j < asks.length; j++) tuple.push(await port.mint(`t${i + 1}a${j + 1}`));
      if (!out.subject) {
        const found = def.subject
          ? tuple[0].roster.find((r) => r.id === def.subject)
          : tuple[0].roster.find((r) => def.subject_capability && r.card_summary.skill_ids.includes(def.subject_capability));
        if (!found) {
          // A CONFIGURATION state, not a quality one. This used to throw into the
          // runner's catch, which recorded trials: [false] and score 0, and
          // `--update-baseline` then wrote "this case scores 0" into the baseline
          // as if it had measured something.
          out.blocked = `no roster member offers ${def.subject_capability ?? def.subject}: the case cannot run until one does (rfa room roster shows who is in)`;
          return out;
        }
        out.subject = found;
      }
      const subject = out.subject;

      const settled = await Promise.allSettled(
        tuple.map(async (asker, index) => {
          const startedAt = now();
          const answer = await asker.ask(subject.id, asks[index].ask, { timeoutMs });
          return { asker, answer, index, client: { startedAt, endedAt: now() } };
        }),
      );
      const broke = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
      // Infrastructure, not quality: the same throw a single-ask trial makes, so
      // the case lands as ERROR rather than as a regression.
      if (broke) throw new Error(`trial ${i + 1}: ${(broke.reason as Error).message}`);
      // Index off the closure's own capture: the asks settle out of order by
      // construction, and reading `asks[position in settled]` would attribute the
      // wrong markers to the wrong answer the first time they did.
      const done = settled
        .map((s) => (s as PromiseFulfilledResult<{ asker: ConcurrentAsker; answer: AskResult; index: number; client: { startedAt: number; endedAt: number } }>).value)
        .sort((a, b) => a.index - b.index);

      const refusals = done.filter((d) => d.answer.kind === "refuse");
      if (refusals.length) {
        const byDispatcher = refusals.filter((d) => classifyRefusal(d.answer.refusal) === "dispatcher");
        const why = refusals.map((d) => `ask ${d.index + 1} ${refusalText(d.answer)}`).join("; ");
        if (byDispatcher.length) {
          // THE regression this case exists to catch: the subject refused a
          // simultaneous ask from its own dispatcher. A failed trial, with the
          // reason named - not an excluded one, which would report BLOCKED and
          // leave the regression invisible.
          const named = `trial ${i + 1}: FAILED, the subject's DISPATCHER refused a simultaneous ask (${byDispatcher
            .map((d) => `ask ${d.index + 1} ${refusalText(d.answer)}`)
            .join("; ")}): that is the concurrency surface under test refusing, not infrastructure`;
          out.dispatcherRefusals.push(named);
          out.trials.push(false);
          out.comments.push(named);
          const clientWindows = done.map((d) => d.client);
          out.perTrial.push({
            index: i,
            passed: false,
            overlap: measureRunOverlap([], "the tuple was refused by the dispatcher before both asks could run"),
            inFlightTogetherMs: measureInFlightTogether(clientWindows).ms,
            comment: named,
            observations: [],
          });
          continue;
        }
        // Budget, credential, provider capacity: the stack's state. One refusal
        // refuses the TUPLE, because half a tuple cannot be scored for
        // contamination.
        out.refused.push(why);
        out.comments.push(`trial ${i + 1}: REFUSED (infrastructure) ${why}`);
        continue;
      }

      const observations: AskObservation[] = done.map((d) => {
        const json = port.json(d.answer);
        const runId = json?.runId ?? null;
        const run = runId ? port.runWindow(runId) : null;
        return {
          index: d.index,
          ask: asks[d.index],
          events: port.slice(d.asker, asks[d.index].ask, d.answer),
          json,
          client: d.client,
          run,
          runNote: run
            ? null
            : (port.runWindowUnavailable ??
              (runId
                ? `no readable run row for ${runId} in runs.db (a member hosted elsewhere does not record its runs here)`
                : "the answer carried no run id, so no run row could be looked up")),
        };
      });

      const res = scoreConcurrentTrial(observations, subject.id, def.expect);
      out.perTrial.push({
        index: i,
        passed: res.unmeasurable ? null : res.score === 1,
        overlap: res.overlap,
        inFlightTogetherMs: res.inFlightTogether.ms,
        comment: res.comment,
        observations,
      });
      if (res.unmeasurable) {
        out.unmeasurable.push(res.unmeasurable);
        out.comments.push(`trial ${i + 1}: UNMEASURABLE ${res.comment}`);
        continue;
      }
      out.trials.push(res.score === 1);
      out.comments.push(`trial ${i + 1}: ${res.comment}`);
      if (!out.firstScored) out.firstScored = observations;

      for (const o of observations) {
        const runId = o.json?.runId;
        if (!runId || !obs) continue;
        const per = res.perAsk.find((p) => p.index === o.index);
        obs.feedback({
          run_id: runId,
          // Keyed on the ask's CARRIED index, never on array position.
          key: `eval:${def.id}#ask${o.index + 1}`,
          score: per?.score ?? 0,
          comment: `${per?.comment ?? ""} · tuple ${res.score === 1 ? "passed" : "FAILED"} · ${res.overlap.detail}`,
          source_type: "evaluator",
        });
        if (res.score === 0) obs.markReview(runId, true);
      }
    }
  } finally {
    // Or the roster fills with eval corpses (this is how the zombie-membership
    // finding started).
    await port.release();
  }
  return out;
}

/**
 * The CASE-level overlap verdict (finding 6). `expect_overlap` asserts that the
 * pack CAN interleave, which is a property of the case's run as a whole: at least
 * one trial overlapped. Asserting it per trial with zero tolerance zeroed a
 * correct pack the first time one leg was serialized by a lease held elsewhere.
 *
 * UNMEASURED fails the assertion: a metric nobody could read must never pass one.
 */
export function overlapVerdict(
  perTrial: TrialRecord[],
  expectOverlap: boolean,
): {
  trials: number;
  overlapped: number;
  serialized: number;
  unmeasured: number;
  max_overlap_ms: number;
  max_in_flight_together_ms: number;
  asserted: boolean;
  assertion: { ok: boolean; detail: string } | null;
} {
  const overlapped = perTrial.filter((t) => t.overlap.state === "overlapped").length;
  const serialized = perTrial.filter((t) => t.overlap.state === "serialized").length;
  const unmeasured = perTrial.filter((t) => t.overlap.state === "unmeasured").length;
  const assertion = !expectOverlap
    ? null
    : overlapped > 0
      ? { ok: true, detail: `${overlapped}/${perTrial.length} trial(s) overlapped on the subject's run windows` }
      : {
          ok: false,
          detail:
            unmeasured === perTrial.length && perTrial.length > 0
              ? `expect_overlap: the overlap could not be MEASURED on any of ${perTrial.length} trial(s) (${perTrial[0].overlap.detail}). An unmeasured metric fails the assertion instead of passing it.`
              : `expect_overlap: not one of ${perTrial.length} trial(s) overlapped on the subject's own run windows (${serialized} serialized, ${unmeasured} unmeasured). Either the pack is at concurrency 1 (drop expect_overlap) or it stopped interleaving.`,
        };
  return {
    trials: perTrial.length,
    overlapped,
    serialized,
    unmeasured,
    max_overlap_ms: Math.max(0, ...perTrial.map((t) => t.overlap.ms)),
    max_in_flight_together_ms: Math.max(0, ...perTrial.map((t) => t.inFlightTogetherMs)),
    asserted: expectOverlap,
    assertion,
  };
}
