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
