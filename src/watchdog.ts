/**
 * Watchdog invariants (RFA-0.5 sect. 20.6).
 *
 * 20.6 is a shipping gate before it is a feature: an invariant MUST NOT ship
 * until it has been replayed against at least two weeks of room logs plus the
 * observability database and shown to fire on the known incidents AND NOTHING
 * ELSE. Any invariant that false-fires does not ship.
 *
 * This module holds the invariants, and it is the ONLY place they are written
 * down. `scripts/watchdog-replay.ts` is the gate that validates them and
 * `src/supervisor.ts` is the runtime that evaluates them; both import from here.
 * An invariant validated as one copy and shipped as another validates nothing,
 * and this repository has paid for that shape repeatedly (one fact in two
 * knowledge pages, `rfa status` printing the on-disk definition hash as if it
 * were the served one).
 *
 * Each invariant carries the verdict its replay MEASURED, and `shippedInvariants`
 * filters on it. That field is not a comment: the replay harness re-measures the
 * verdict on every run and exits non-zero when the measurement disagrees with
 * what is recorded here. It is where a check starts, never where it ends.
 *
 * What ships today is one invariant. The two observer candidates stay defined
 * here, unshipped, with their measured verdicts, so that shipping one later is a
 * re-replay of this same code rather than a rewrite of it.
 */
import type { Alert } from "./obs.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The columns of `runs` a watchdog invariant may read. */
export interface WatchdogRun {
  run_id: string;
  agent: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
}

/** One room's full member list at some instant. */
export interface RoomRoster {
  room: string;
  members: Record<string, unknown>[];
}

/**
 * The state an invariant reads, supplied by whoever is evaluating.
 *
 * `runs` MUST contain every run that the engine held in `running` at the
 * evaluation instant. The runtime satisfies that with `WHERE status = 'running'`,
 * which is exactly that set when `at` is now; the replay harness passes every
 * row and lets each `evaluate` re-derive the set at a past instant from
 * `started_at`/`ended_at`. Both are correct because the rows carry their own
 * timestamps, and the projection is the caller's business, not the invariant's.
 *
 * `rosters` is null when the caller cannot read room state. The supervisor
 * cannot: the hub owns the room store exclusively (RFA-0.7), so a second opener
 * is a defect and not an option. An invariant that needs what a caller cannot
 * supply is reported by `watchdogFailures` rather than silently never firing,
 * because an instrument that cannot report is the failure mode this ladder keeps
 * rediscovering.
 */
export interface WatchdogState {
  runs: WatchdogRun[];
  rosters: ((at: number) => RoomRoster[]) | null;
}

export interface Firing {
  at: number;
  detail: string;
}

/** What a replay of this invariant measured over the corpus. Only `clean` ships. */
export type ReplayVerdict = "clean" | "false-fires" | "silent";

export interface Invariant {
  id: string;
  /** The condition, in one sentence, as an operator reading an alert would want it. */
  what: string;
  /** The parts of `WatchdogState` `evaluate` reads. */
  needs: ("runs" | "rosters")[];
  /** The verdict the replay harness MEASURED. Re-measured on every replay run. */
  replay: ReplayVerdict;
  /** Why it carries that verdict, and what that means for shipping it. */
  why: string;
  evaluate(state: WatchdogState, at: number): Firing | null;
}

/**
 * Two hours, because it must clear every legitimate wait by a wide margin.
 *
 * The longest one a run can sit in is a human approval, whose ceiling is the ask
 * deadline: v0.5 deleted the ten-minute cap and named 30 minutes as the fallback,
 * and `rfa ask` defaults to 30 minutes. Four times the longest legitimate wait is
 * the distance between "slow" and "wedged".
 */
export const STUCK_AFTER_MS = 2 * HOUR;

/** The observer prune window the hub actually runs on (spec 20.6 names it). */
export const OBSERVER_PRUNE_MS = DAY;

export const INVARIANTS: Invariant[] = [
  {
    id: "engine-run-stuck-running",
    what: `an engine run has been 'running' for more than ${STUCK_AFTER_MS / HOUR}h`,
    needs: ["runs"],
    replay: "clean",
    why:
      "Replayed 2026-08-30 over 14.1 days (13 room logs, 9842 events, 1068 engine runs): 54 firing " +
      "buckets, 54 inside a recorded incident, 0 outside. Spec 20.6 REQUIRES this one, as the only " +
      "anomaly that was present in live state at the time of measurement.",
    evaluate: (state, at) => {
      const stuck = state.runs.filter((r) => {
        if (!r.started_at) return false;
        const started = Date.parse(r.started_at);
        if (!Number.isFinite(started) || started > at) return false;
        const ended = r.ended_at ? Date.parse(r.ended_at) : null;
        const runningAtT = ended === null || ended > at;
        return runningAtT && at - started > STUCK_AFTER_MS;
      });
      if (stuck.length === 0) return null;
      const age = (r: WatchdogRun) => at - Date.parse(r.started_at!);
      const oldest = stuck.reduce((a, b) => (age(a) >= age(b) ? a : b));
      const named = stuck.slice(0, 3).map((r) => `${r.run_id}/${r.agent}`).join(", ");
      return {
        at,
        detail:
          `${stuck.length} run(s) stuck 'running' (oldest ${(age(oldest) / HOUR).toFixed(1)}h): ` +
          `${named}${stuck.length > 3 ? ", …" : ""}`,
      };
    },
  },
  {
    id: "observers-present-but-lease-expired-NAIVE",
    what: "any observer is present with an expired lease",
    needs: ["rosters"],
    replay: "false-fires",
    why:
      "Spec 20.6 predicts this by construction and the replay confirmed it (2026-08-30: 2 firings " +
      "outside any recorded incident window). An expired lease is NORMAL for up to the 24h prune " +
      "window. DOES NOT SHIP; 20.6 requires reading it as the invariant below.",
    evaluate: (state, at) => {
      const hits = expiredObservers(state, at, 0);
      return hits.length === 0 ? null : { at, detail: `${hits.length}: ${hits.slice(0, 3).join(", ")}` };
    },
  },
  {
    id: "observers-expired-beyond-prune",
    what: `an observer's lease expired more than ${OBSERVER_PRUNE_MS / HOUR}h ago, so the prune should have taken it`,
    needs: ["rosters"],
    replay: "silent",
    why:
      "20.6's corrected form of the invariant above, and it never fired over the 14.1-day corpus " +
      "(2026-08-30). Silence is not validation: 20.6 asks that an invariant be SHOWN to fire on the " +
      "known incidents, and this one has not been shown to fire on anything. DOES NOT SHIP until a " +
      "corpus containing a real prune failure replays it clean.",
    evaluate: (state, at) => {
      const hits = expiredObservers(state, at, OBSERVER_PRUNE_MS);
      return hits.length === 0 ? null : { at, detail: `${hits.length}: ${hits.slice(0, 3).join(", ")}` };
    },
  },
];

/** Observers whose lease expired more than `graceMs` before `at`, as `room/name`. */
function expiredObservers(state: WatchdogState, at: number, graceMs: number): string[] {
  const hits: string[] = [];
  for (const { room, members } of state.rosters?.(at) ?? []) {
    for (const m of members) {
      const exp = m.lease_expires ? Date.parse(String(m.lease_expires)) : NaN;
      if (String(m.role ?? "") === "observer" && Number.isFinite(exp) && at - exp > graceMs) {
        hits.push(`${room}/${String(m.name)}`);
      }
    }
  }
  return hits;
}

/**
 * The verdict a replay measures for one invariant, from what it saw.
 *
 * This rule lives beside the invariants and not in the harness because it is the
 * rule that DECIDES what ships: `clean` means it fired only where an incident
 * claims it, `false-fires` means 20.6 forbids it outright, and `silent` means it
 * has not been shown to fire on anything, which is not the same as being right.
 */
export function measureVerdict(firings: number, outside: number): ReplayVerdict {
  return firings === 0 ? "silent" : outside === 0 ? "clean" : "false-fires";
}

/**
 * Where a replay's measurements contradict the verdicts recorded here.
 *
 * The `replay` field is a licence to run in production, and a licence nobody
 * re-checks cannot expire. So the harness measures every invariant afresh and
 * hands the results back here, and any disagreement - including an invariant
 * that was never replayed at all - fails its run.
 */
export function verdictDrift(measured: { id: string; verdict: ReplayVerdict }[]): string[] {
  const out: string[] = [];
  for (const m of measured) {
    const inv = INVARIANTS.find((i) => i.id === m.id);
    if (!inv) out.push(`${m.id}: replayed, but no such invariant is defined in src/watchdog.ts`);
    else if (inv.replay !== m.verdict) out.push(`${m.id}: recorded \`${inv.replay}\`, this corpus measures \`${m.verdict}\``);
  }
  for (const inv of INVARIANTS) {
    if (!measured.some((m) => m.id === inv.id)) out.push(`${inv.id}: defined and never replayed, so its \`${inv.replay}\` verdict is unbacked`);
  }
  return out;
}

/** The invariants whose replay verdict allows them to run in production (20.6). */
export function shippedInvariants(): Invariant[] {
  return INVARIANTS.filter((i) => i.replay === "clean");
}

/**
 * Shipped invariants this state cannot answer, as operator-readable lines.
 *
 * A shipped invariant that can never fire is worse than an unshipped one: it
 * reads as coverage. The supervisor calls this once at start and says so out
 * loud rather than evaluating a permanent null.
 */
export function watchdogFailures(state: WatchdogState): string[] {
  const out: string[] = [];
  for (const inv of shippedInvariants()) {
    if (inv.needs.includes("rosters") && state.rosters === null) {
      out.push(`${inv.id} needs room rosters, which this evaluator cannot read: it would never fire`);
    }
  }
  return out;
}

/** Every shipped invariant that fires against this state at `at`. */
export function evaluateWatchdog(state: WatchdogState, at: number): { invariant: Invariant; firing: Firing }[] {
  const out: { invariant: Invariant; firing: Firing }[] = [];
  for (const inv of shippedInvariants()) {
    if (inv.needs.includes("rosters") && state.rosters === null) continue;
    const firing = inv.evaluate(state, at);
    if (firing) out.push({ invariant: inv, firing });
  }
  return out;
}

/**
 * The firings, as `#ops` alerts.
 *
 * `key` is per-invariant and not per-kind: the cooldown map in the supervisor is
 * keyed on it, so a second watchdog invariant would otherwise be silenced for
 * half an hour by the first one to speak.
 *
 * Every one of these is a STATE check, so none of them carries a minimum-volume
 * guard and none of them may grow one. A rate needs a denominator; a wedged run
 * is complete evidence on its own, and the guard that made sense for the error
 * triad is exactly what kept a 100%-failing credential silent on a quiet hub.
 */
export function watchdogAlerts(state: WatchdogState, at: number): Alert[] {
  return evaluateWatchdog(state, at).map(({ invariant, firing }) => ({
    kind: "watchdog" as const,
    key: `watchdog:${invariant.id}`,
    message: `${invariant.id}: ${firing.detail}`,
  }));
}
