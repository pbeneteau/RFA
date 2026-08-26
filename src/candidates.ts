/**
 * Candidate parallelism (RFA-0.8 sect. 11, rung 4): N independent runs of ONE
 * task, in N scratch surfaces that never merge, one output selected, the rest
 * discarded. The design note is `docs/design/rung4-candidates.md`; this file is
 * the orchestration half of it.
 *
 * No shared-state write conflict exists by construction, which is why this is
 * the cheap rung, and identical packs produce useful candidate spread, so there
 * is deliberately NO diversity mechanism here: prompt diversity was a measured
 * null result and intra-agent spread is enough (W5 sect. 9).
 *
 * Three properties this module exists to hold, none of which is optional:
 *
 *  1. **Every candidate settles.** `runCandidateSet` does not resolve until each
 *     started candidate has finished or been interrupted AND reported what it
 *     cost. A candidate whose spend disappears is exactly the unattributable
 *     meter the honest-meters doctrine forbids, and early stop is where that is
 *     tested, because it deliberately kills work that has already spent money.
 *  2. **Cancellation is an interrupt, not an abort.** The caller's `cancel` is
 *     wired to the SDK's `query.interrupt()`, because that lets the CLI emit its
 *     `result` message and `total_cost_usd` lives on that message. Aborting the
 *     controller throws the iteration away with the cost inside it.
 *  3. **The loser's scratch goes, the loser's record stays.** Deleting the
 *     surface is the point; deleting the evidence that it ran, and what it cost,
 *     would be the meter lying.
 *
 * Deliberately transport-agnostic and engine-agnostic: it takes a `start`
 * callback and returns outcomes, so its acceptance test is a unit test with
 * barriers rather than a live room.
 */

/** How the winner is chosen. `human` is the default and the one shipped first. */
export const CANDIDATE_SELECTORS = ["human", "first-verified"] as const;
export type CandidateSelector = (typeof CANDIDATE_SELECTORS)[number];

export function isCandidateSelector(v: unknown): v is CandidateSelector {
  return typeof v === "string" && (CANDIDATE_SELECTORS as readonly string[]).includes(v);
}

/**
 * What the selector costs, stated at the point of use rather than discovered
 * later (RFA-0.8 sect. 11 requires the costs be written in).
 */
export const SELECTOR_NOTES: Record<CandidateSelector, string> = {
  human: "every candidate runs, a human picks; expect to lose 10-15 points of task coverage to selection when no executable check exists (measured 69.8% -> 57.4%)",
  "first-verified": "the first candidate to finish wins and the rest are interrupted; buys 1.6-2.2x latency for 1.7-2.6x cost, and needs no selector at all",
};

/** The fan-out width actually run, and every reason it is not the width asked for. */
export interface CandidatePlan {
  requested: number;
  running: number;
  selector: CandidateSelector;
  /** Why `running` is below `requested`, in one sentence an operator reads. Null when nothing was cut. */
  degraded: string | null;
}

/**
 * Decide the width. Three ceilings, and each one is reported when it bites:
 * what was asked for, what the host was told to run (`concurrency: N` is N full
 * `claude` CLI child processes, not N threads), and what the day budget can
 * actually reserve.
 */
export function planCandidates(args: {
  requested: number;
  selector: CandidateSelector;
  /** The pack's declared host sizing (`concurrency: N` in agent.md). */
  concurrency: number;
  /**
   * Turns this process is ALREADY running that are not this fan-out. The whole
   * set runs inside ONE dispatcher job, so the dispatcher's own cap cannot see
   * N turns where it counts one; subtracting what is already busy is what keeps
   * `concurrency: N` a true statement about this host rather than a floor.
   *
   * A snapshot, exactly like the budget one: a serve turn arriving after this
   * can still push the process over for a moment. It errs toward FEWER
   * candidates, which is the safe direction, and the account cap
   * (`agents.max_inflight`) bounds the total across every resident regardless
   * (RFA-0.8 sect. 10).
   */
  busy?: number;
  affordable: { count: number; detail: string | null };
}): CandidatePlan {
  const requested = Math.max(1, Math.floor(args.requested));
  const reasons: string[] = [];
  let running = requested;
  const busy = Math.max(0, Math.floor(args.busy ?? 0));
  const host = Math.max(1, args.concurrency - busy);
  if (host < running) {
    reasons.push(
      busy > 0
        ? `the pack declares concurrency: ${args.concurrency} and this resident is already running ${busy} turn${busy === 1 ? "" : "s"}, each a full CLI child process`
        : `the pack declares concurrency: ${args.concurrency}, and each candidate is a full CLI child process`,
    );
    running = host;
  }
  if (args.affordable.count < running) {
    running = Math.max(0, args.affordable.count);
    if (args.affordable.detail) reasons.push(args.affordable.detail);
    else reasons.push(`the day budget affords ${running}`);
  }
  return {
    requested,
    running: Math.max(0, running),
    selector: args.selector,
    degraded: running < requested ? reasons.join("; ") : null,
  };
}

/** One candidate, started. `cancel` is the interrupt of property 2 above. */
export interface StartedCandidate {
  runId: string;
  /** Resolves with the candidate's answer, or rejects. Either way it must have settled its cost first. */
  done: Promise<CandidateProduct>;
  /** Ask this candidate to stop. Best effort, idempotent, and never throws. */
  cancel: (reason: string) => void;
}

export interface CandidateProduct {
  text: string;
  costUsd: number;
  numTurns: number;
}

export interface CandidateOutcome {
  index: number;
  runId: string;
  state: "ready" | "cancelled" | "failed";
  text: string | null;
  costUsd: number;
  numTurns: number;
  error: string | null;
}

export interface CandidateSetResult {
  outcomes: CandidateOutcome[];
  /** For `first-verified`, the index that won. Null when nothing succeeded, and always null for `human`. */
  winner: number | null;
  costUsd: number;
}

export interface RunCandidateSetOpts {
  plan: CandidatePlan;
  /** Start candidate `index`. Throwing here is a failure of that candidate, never of the set. */
  start: (index: number) => StartedCandidate | Promise<StartedCandidate>;
  /**
   * Called once per candidate as soon as IT settles, before the set resolves, so
   * the durable record and the cost are written while the rest are still
   * running. A throw here is swallowed: bookkeeping must not lose a candidate.
   */
  onSettled?: (outcome: CandidateOutcome) => void;
  /** Told which candidates lost, so their scratch surfaces go. Never told about the winner. */
  onDiscard?: (outcome: CandidateOutcome) => void;
  log?: (msg: string) => void;
}

/**
 * Run the set. Resolves only when every started candidate has settled, which is
 * property 1: early stop cancels the losers and then WAITS for them, so the
 * set's total cost is complete before anything downstream reads it.
 */
export async function runCandidateSet(opts: RunCandidateSetOpts): Promise<CandidateSetResult> {
  const log = opts.log ?? (() => {});
  const n = opts.plan.running;
  const outcomes = new Array<CandidateOutcome | undefined>(n);
  const started: (StartedCandidate | null)[] = new Array(n).fill(null);
  /** Set once, by the first success under `first-verified`: the winner never gets cancelled. */
  let winner: number | null = null;
  let stopping = false;

  const settle = (index: number, outcome: CandidateOutcome): void => {
    outcomes[index] = outcome;
    try {
      opts.onSettled?.(outcome);
    } catch (err) {
      log(`candidate ${index} bookkeeping failed: ${(err as Error).message}`);
    }
  };

  const cancelOthers = (except: number, reason: string): void => {
    for (let i = 0; i < n; i++) {
      if (i === except) continue;
      if (outcomes[i]) continue;
      try {
        started[i]?.cancel(reason);
      } catch (err) {
        log(`candidate ${i} would not interrupt: ${(err as Error).message}`);
      }
    }
  };

  const runOne = async (index: number): Promise<void> => {
    let handle: StartedCandidate;
    try {
      handle = await opts.start(index);
    } catch (err) {
      settle(index, { index, runId: "", state: "failed", text: null, costUsd: 0, numTurns: 0, error: (err as Error).message });
      return;
    }
    started[index] = handle;
    // A cancel that arrived while this candidate was still being started has to
    // land, or an early stop leaks a run nobody is waiting for.
    if (stopping && winner !== index) {
      try {
        handle.cancel("another candidate already finished");
      } catch {
        /* best effort, exactly as above */
      }
    }
    try {
      const product = await handle.done;
      // Losing a race to a sibling is not a failure of this candidate: it
      // produced an answer and it is `ready`, whether or not it is chosen. Only
      // `first-verified` collapses that distinction, and it does so below.
      settle(index, { index, runId: handle.runId, state: "ready", text: product.text, costUsd: product.costUsd, numTurns: product.numTurns, error: null });
      if (opts.plan.selector === "first-verified" && winner === null) {
        winner = index;
        stopping = true;
        log(`candidate ${index} finished first; interrupting the rest`);
        cancelOthers(index, "another candidate already finished");
      }
    } catch (err) {
      const message = (err as Error).message;
      // An interrupted candidate reports what it spent before it died: the turn
      // leaves through the same `finally` every other turn leaves through, and
      // `cost` is attached to the error by the caller when it can be.
      const cost = Number((err as { costUsd?: number }).costUsd ?? 0);
      const state: CandidateOutcome["state"] = stopping && winner !== index ? "cancelled" : "failed";
      settle(index, { index, runId: handle.runId, state, text: null, costUsd: Number.isFinite(cost) ? cost : 0, numTurns: 0, error: message });
    }
  };

  await Promise.all(Array.from({ length: n }, (_, i) => runOne(i)));

  const final = outcomes.map((o, i) => o ?? { index: i, runId: "", state: "failed" as const, text: null, costUsd: 0, numTurns: 0, error: "candidate never settled" });
  // Under `first-verified` the losers are discarded here rather than at cancel
  // time, so a candidate that finished in the gap between the interrupt and its
  // own settle is discarded by the same path as one that never started.
  if (winner !== null) for (const o of final) if (o.index !== winner) opts.onDiscard?.(o);
  return { outcomes: final, winner, costUsd: final.reduce((n2, o) => n2 + o.costUsd, 0) };
}
