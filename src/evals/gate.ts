/**
 * The eval gate's arithmetic (RFA-0.4 spec section 8, spec 20.3), extracted from
 * the runner so it can be TESTED as shipped code.
 *
 * It lives here because `src/evals/runner.ts` calls `main()` at import: nothing
 * can import a symbol out of it, so the gate's arithmetic used to be re-typed by
 * hand inside `test/evalgate.test.ts`, and a test that re-types the code it is
 * about exercises nothing. Every number the gate compares now comes from here,
 * and both the runner and the test call the same functions.
 */
import { passHatK } from "./trajectory.js";

/**
 * The gate's k and band (spec 20.3). Both are CHOSEN, not measured: k=4 is the
 * value the pass^k estimator was already run at, and 0.15 absolute is a guess at
 * a band wide enough to swallow the observed flake. Neither may be tightened
 * before the gate's own false-positive rate has been measured by repeated
 * no-change runs, which is why every verdict prints the flake rate beside it.
 */
export const GATE_K = 4;
export const GATE_BAND = 0.15;

/** One case's stored baseline. */
export interface CaseBaseline {
  /** pass^k at `k`, or the point score when `estimated` is false. */
  passk: number;
  /**
   * The k this number was ACTUALLY measured at, never the gate's k by default:
   * a run of 2 trials cannot produce a pass^4, and storing 4 beside a point
   * estimate made every later comparison a comparison of two different
   * quantities while claiming to be one.
   */
  k: number;
  /**
   * True when `passk` is a pass^k estimate at `k`. False when the case ran fewer
   * than k trials and `passk` is the point score over `k` trials, which is a
   * DIFFERENT quantity and not comparable to a pass^k.
   */
  estimated: boolean;
  /** The agent definition this baseline was measured against, so a definition change is not read as a quality change. */
  definition_hash: string | null;
}

/** What a case measured this run, in the same terms the baseline stores. */
export interface GateValue {
  value: number;
  k: number;
  estimated: boolean;
}

/**
 * pass^k at the gate's k, or the point score when a case ran too few trials to
 * estimate one. The returned `k` is what the value was measured at, which is the
 * number the baseline must store: see CaseBaseline.k.
 */
export function gateValue(trials: boolean[]): GateValue {
  if (trials.length >= GATE_K) return { value: passHatK([trials], GATE_K), k: GATE_K, estimated: true };
  return {
    value: trials.length > 0 ? trials.filter(Boolean).length / trials.length : 0,
    k: trials.length,
    estimated: false,
  };
}

/**
 * A baseline as READ from evals/baseline.json. `estimated` is ABSENT on every row
 * written before the honest-k fix, and those rows are the reason this type exists
 * separately: the file is older than the code reading it, always.
 */
export type StoredBaseline = Omit<CaseBaseline, "estimated"> & { estimated?: boolean };

/**
 * A stored row with the pre-fix rows resolved. Those wrote `k: GATE_K`
 * unconditionally, so their k cannot itself say whether the number was a pass^k;
 * the only safe reading is the one the old gate used, `k >= GATE_K`. Without this,
 * every baseline measured before the fix would have become INCOMPARABLE on the
 * next run and the whole gate would have gone to "did not check" overnight.
 */
function storedShape(base: StoredBaseline): { k: number; estimated: boolean } {
  return { k: base.k, estimated: base.estimated ?? base.k >= GATE_K };
}

export type Comparison =
  /** Nothing stored: the first run of a case is never a regression. */
  | { verdict: "no-baseline" }
  /**
   * The stored number and this run's number are not the same quantity (a
   * different k, or a point estimate against a pass^k). REFUSED rather than
   * guessed: the gate says so and the case counts as unchecked.
   */
  | { verdict: "incomparable"; detail: string }
  | { verdict: "ok"; drop: number }
  | { verdict: "regressed"; drop: number };

const shape = (k: number, estimated: boolean): string => (estimated ? `pass^${k}` : `a point estimate over ${k} trial(s)`);

/**
 * Compare one case against its stored baseline. A drop wider than the band is a
 * regression; a stored number measured at another k is INCOMPARABLE, because
 * pass^4 and a two-trial point estimate are different quantities and reading one
 * as the other is how a "regression" gets invented (or hidden).
 */
export function compareToBaseline(current: GateValue, base: StoredBaseline | undefined): Comparison {
  if (base === undefined) return { verdict: "no-baseline" };
  const stored = storedShape(base);
  if (stored.k !== current.k || stored.estimated !== current.estimated) {
    return {
      verdict: "incomparable",
      detail: `baseline holds ${shape(stored.k, stored.estimated)} = ${base.passk.toFixed(2)}, this run measured ${shape(current.k, current.estimated)} = ${current.value.toFixed(2)}: re-baseline, or run the case at the same trial count`,
    };
  }
  const drop = base.passk - current.value;
  return drop > GATE_BAND ? { verdict: "regressed", drop } : { verdict: "ok", drop };
}

/** The minimum of a case result the baseline write needs. */
export interface BaselineInput {
  id: string;
  trials: boolean[];
  /** Set when the case DID NOT RUN: no room, every trial refused, an unresolvable subject, a malformed case. */
  blocked?: string;
  definition_hash?: string | null;
}

/**
 * What `--update-baseline` writes.
 *
 * A BLOCKED case keeps whatever baseline it had and never gets a new one: a
 * refusal is not a measurement, an unresolvable capability is a configuration
 * state, and a malformed case did not run. Writing any of them as a number would
 * put "this case scores 0" into the file as though it had been measured, and
 * nothing can then drop below it.
 *
 * Everything else is stored with the k it was ACTUALLY measured at.
 */
export function nextBaseline(results: BaselineInput[], previous: Record<string, StoredBaseline>): Record<string, CaseBaseline> {
  const next: Record<string, CaseBaseline> = {};
  for (const r of results) {
    if (r.blocked) {
      // Kept as it was, with the pre-fix row's implied `estimated` written down
      // rather than left implicit: the comparison already reads it that way, and a
      // field only one side knows about is how the two drift apart again.
      if (previous[r.id]) next[r.id] = { ...previous[r.id], ...storedShape(previous[r.id]) };
      continue;
    }
    const { value, k, estimated } = gateValue(r.trials);
    next[r.id] = { passk: value, k, estimated, definition_hash: r.definition_hash ?? null };
  }
  return next;
}
