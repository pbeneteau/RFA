/**
 * One model turn at a time within one process.
 *
 * The resident's serve loop is sequential by construction, but its schedule
 * timer fires on its own clock, so two brain turns could run at once and they
 * shared the run context (`currentLease` above all): whichever turn finished
 * first released the OTHER's account lease, freeing a slot that was still in
 * use, and approval cards carried the wrong run id (found 2026-08-25 by
 * inspection, before it bit live).
 *
 * A queue rather than a guard: a turn that arrives mid-turn waits its turn
 * instead of being dropped, so a due cron fires late, never never. FIFO by
 * chain order; a throwing turn still releases the next one.
 */
export function makeTurnLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => (release = r));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/**
 * One model turn at a time PER KEY within one process: the RFA-0.8 sect. 6.1
 * narrowing, from "one turn per process" to "one turn per session id".
 *
 * The key is the conversation key, which owns a session id (`src/sessions.ts`),
 * so per-key exclusion is per-session exclusion, which is the 1.1 invariant.
 *
 * This is the MECHANISM, not the policy. Rung 3's dispatcher (`src/dispatch.ts`)
 * already runs at most one job per conversation key, so for dispatched traffic
 * this lock never blocks. It exists for the callers that do NOT go through the
 * dispatcher and never will: the schedule timer, which fires on its own clock
 * and is the reason the process-wide lock was built on 2026-08-25. Narrowing the
 * scope without keeping a lock over every caller would have quietly un-fixed
 * that.
 *
 * The map is reaped as each key drains, so a resident that has served ten
 * thousand conversations holds no entry for any of them.
 */
export function makeKeyedTurnLock(): {
  <T>(key: string, fn: () => Promise<T>): Promise<T>;
} {
  const tails = new Map<string, Promise<void>>();
  const waiting = new Map<string, number>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    tails.set(key, mine);
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      const left = (waiting.get(key) ?? 1) - 1;
      if (left <= 0) {
        waiting.delete(key);
        // Only if nobody queued behind us while we ran: `tails` still pointing at
        // OUR promise is exactly that test.
        if (tails.get(key) === mine) tails.delete(key);
      } else {
        waiting.set(key, left);
      }
    }
  };
}
