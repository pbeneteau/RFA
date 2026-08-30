/**
 * Resolving a trial to a RUN, without taking the subject's word for it
 * (wire 14 item 12: a peer's self-report MUST NOT be an input to an automated
 * decision).
 *
 * THE DEFECT THIS CLOSES. A resident composes `{run_id, cost_usd, num_turns,
 * day_spend_usd}` into its own answer body, and the harness read `run_id` back
 * out and used it as the key for two writes: the evaluator score, and the
 * `needs_review` flag that puts a bad answer in front of a human. Both are
 * `... WHERE id = ?` against a store with no foreign key, so a wrong or stale id
 * is not an error - it attaches the score to another run, or to nothing at all,
 * and the failing answer never reaches the review queue. A subject could also
 * stamp two invented distinct ids and satisfy the concurrent case's
 * distinctness assertion outright.
 *
 * THE SECOND DEFECT, same root. A trial whose answer came back `kind: "refuse"`
 * was dropped from pass^k entirely, on the strength of the subject's own
 * declared state. That let a member lower the denominator of its own reliability
 * gate by refusing. The exclusion itself is right and was earned live (a $3/day
 * answerer hit its ceiling mid-run and the gate reported two REGRESSIONS), so
 * the fix is not to count every refusal as a failure: it is to require the
 * subject's OWN RECORD to corroborate the refusal.
 *
 * WHAT COUNTS AS CORROBORATION. The record is the observability store's `runs`
 * table, which is the store the writes target, so corroborating anywhere else
 * would prove the wrong thing. A resident stamps one row per answered turn
 * (`serve:<pack>`), so within the window of one ask:
 *
 *   no row              the subject never started a turn. That is what a
 *                       pre-flight refusal looks like - budget, overload, busy -
 *                       so the refusal is corroborated and the trial is excluded
 *   row, not success    it started and failed. Corroborated, excluded
 *   row, success        it completed a turn and THEN declared a refusal. Its own
 *                       record contradicts its self-report, so the trial COUNTS
 *   store unreadable    nothing can be corroborated. The trial COUNTS, and the
 *                       reason is reported: "we could not tell" is not "it was
 *                       refused for a good reason", and this is the same
 *                       fail-closed direction `openRunWindows` takes for the
 *                       overlap metric
 *
 * The residual, stated rather than papered over: a subject that declares a
 * refusal without ever starting a turn is indistinguishable from one that
 * genuinely could not start, because both leave no row. Closing that needs a
 * hub-stamped correlation id on the answer event, which is a wire change. What
 * this module removes is the case where the subject's record CONTRADICTS its
 * claim, and it reports every exclusion so a run whose trials vanished is
 * visible to a person rather than silent.
 */

/** One row of the store the harness writes to, narrowed to what resolution needs. */
export interface RunRecord {
  id: string;
  name: string;
  group_id: string | null;
  status: string;
  start_time: number;
  end_time: number;
}

/** Rows for one subject inside one window. `null` means the store could not be read at all. */
export type RunLookup = (input: { agent: string; from: number; to: number }) => RunRecord[] | null;

export type RunResolution =
  | { ok: true; runId: string; source: "corroborated" | "resolved-by-window" }
  | { ok: false; reason: string };

/**
 * Which run this trial actually was.
 *
 * A claimed id is accepted only when a row with that id exists for THIS subject
 * inside THIS ask's window: that is the difference between reading a self-report
 * and checking one. Failing that, the window is asked directly, and it answers
 * only when it answers unambiguously. Anything else refuses, and the caller must
 * report the refusal rather than writing.
 */
export function resolveRun(input: { claimed: string | null; agent: string; from: number; to: number; lookup: RunLookup }): RunResolution {
  const rows = input.lookup({ agent: input.agent, from: input.from, to: input.to });
  if (rows === null) {
    return { ok: false, reason: `the observability store could not be read, so the run this trial produced cannot be identified; the subject claimed ${input.claimed ?? "no id"} and a claim is not a measurement` };
  }
  if (input.claimed) {
    const hit = rows.find((r) => r.id === input.claimed);
    if (hit) return { ok: true, runId: hit.id, source: "corroborated" };
  }
  if (rows.length === 1) return { ok: true, runId: rows[0].id, source: "resolved-by-window" };
  if (rows.length === 0) {
    return {
      ok: false,
      reason:
        `no run row for ${input.agent} inside this trial's window` +
        (input.claimed ? `, and the id it reported (${input.claimed}) is not one either` : "") +
        `: nothing is recorded against a run that cannot be found`,
    };
  }
  return {
    ok: false,
    reason:
      `${rows.length} runs for ${input.agent} fall inside this trial's window (${rows.map((r) => r.id).join(", ")})` +
      (input.claimed ? `, and the id it reported (${input.claimed}) is not among them` : "") +
      `: an ambiguous window is not a measurement`,
  };
}

export interface RefusalVerdict {
  /** True when the trial is left out of pass^k, which only a corroborated refusal earns. */
  excluded: boolean;
  detail: string;
}

/** Does the subject's own record support the refusal it declared? See the header for the table. */
export function corroborateRefusal(input: { agent: string; from: number; to: number; lookup: RunLookup }): RefusalVerdict {
  const rows = input.lookup({ agent: input.agent, from: input.from, to: input.to });
  if (rows === null) {
    return { excluded: false, detail: "the observability store could not be read, so the refusal could not be corroborated and the trial counts (wire 14 item 12)" };
  }
  if (rows.length === 0) {
    return { excluded: true, detail: "corroborated: the subject started no turn in this window, which is what a pre-flight refusal looks like" };
  }
  const succeeded = rows.filter((r) => r.status === "success");
  if (succeeded.length === rows.length) {
    return {
      excluded: false,
      detail: `CONTRADICTED: the subject completed ${rows.length === 1 ? "a turn" : `${rows.length} turns`} in this window (${succeeded.map((r) => r.id).join(", ")}) and then declared a refusal, so the trial counts (wire 14 item 12)`,
    };
  }
  return { excluded: true, detail: `corroborated: the subject's own run row is ${rows.map((r) => r.status).join(", ")}` };
}
