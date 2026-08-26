/**
 * The session book: which SDK session serves which conversation, and the
 * mechanical half of the v0.8 invariant.
 *
 * > An agent's loop is serial per session. At most one live writer per session
 * > id. (RFA-0.8 sect. 1.1, unanimous across the surveyed products and runtimes.)
 *
 * Concurrent resume of one session id is documented corruption, so this is not a
 * preference. Until 2026-08-25 the invariant held INCIDENTALLY, as a consequence
 * of the per-process turn lock, in a bare `Map<string, string>` that nothing
 * guarded: any future narrowing of that lock (rung 3 narrows it from one turn per
 * PROCESS to one turn per SESSION) would have silently removed the only thing
 * enforcing it. So the map gains the guard now, while the turn lock still makes
 * it unreachable: `enter` throws rather than corrupting a transcript, and rung
 * 3's dispatcher inherits an invariant that is checked instead of assumed.
 *
 * Deliberately NOT a dispatcher (RFA-0.8 sect. 6.2, whose design is rung 3's
 * first task and explicitly open): no queues, no fairness, no backpressure. It
 * answers two questions only, which session does this conversation resume, and
 * is anybody already writing it.
 */

export class SessionBook {
  /** conversation key -> the SDK session serving it. */
  private byConvo = new Map<string, string>();
  /** conversation keys with a turn in flight, and the session each entered with. */
  private live = new Map<string, string | null>();

  /** The session id to resume for this conversation, or undefined for a fresh one. */
  resumeFor(convoKey: string): string | undefined {
    return this.byConvo.get(convoKey);
  }

  /**
   * Mark a turn as the writer for this conversation. Throws if one is already in
   * flight, because the alternative is two writers on one transcript.
   */
  enter(convoKey: string): void {
    if (this.live.has(convoKey)) {
      throw new Error(
        `a turn is already in flight for conversation ${convoKey} (session ${this.live.get(convoKey) ?? "new"}): ` +
          `one session id tolerates one writer (RFA-0.8 sect. 1.1)`,
      );
    }
    this.live.set(convoKey, this.byConvo.get(convoKey) ?? null);
  }

  /** Release the writer. Idempotent: a throwing turn's `finally` must not throw. */
  leave(convoKey: string): void {
    this.live.delete(convoKey);
  }

  /**
   * Record the session the SDK actually gave this turn. Refuses to point a
   * conversation at a session another conversation already owns: two conversation
   * keys sharing one session id is the same one-writer violation by another route
   * (a forked session gets a NEW id, which is why this can only be a bug).
   */
  adopt(convoKey: string, sessionId: string): void {
    for (const [other, id] of this.byConvo) {
      if (id === sessionId && other !== convoKey) {
        throw new Error(`session ${sessionId} already serves conversation ${other}; it cannot also serve ${convoKey}`);
      }
    }
    this.byConvo.set(convoKey, sessionId);
    if (this.live.has(convoKey)) this.live.set(convoKey, sessionId);
  }

  /** True while some turn holds this conversation. */
  isLive(convoKey: string): boolean {
    return this.live.has(convoKey);
  }

  /** How many conversations have a turn in flight: what a cap or a meter reads. */
  liveCount(): number {
    return this.live.size;
  }

  /** The durable half, for the resident's state file. */
  toJSON(): Record<string, string> {
    return Object.fromEntries(this.byConvo);
  }

  /**
   * Restore the durable half. A saved file predates this guard, so a duplicate
   * session id in it is DROPPED rather than left to throw on the next `adopt`: a
   * resident that refuses to serve because of a historical state file would be a
   * worse failure than the one being prevented. The owner's live files carried no
   * duplicates when this shipped; the dropped conversation simply starts a fresh
   * session, which is what a missing entry already means.
   */
  load(saved: Record<string, string> | undefined): { loaded: number; dropped: string[] } {
    const seen = new Set<string>();
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(saved ?? {})) {
      if (seen.has(v)) {
        dropped.push(k);
        continue;
      }
      seen.add(v);
      this.byConvo.set(k, v);
    }
    return { loaded: this.byConvo.size, dropped };
  }
}
