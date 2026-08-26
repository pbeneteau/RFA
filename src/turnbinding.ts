/**
 * Which turn owns this process right now, for the two things that need to reach
 * it from module scope: the nested-ask tool (`mcp__rfa__ask`, registered once at
 * load) and anything else that must know a running turn's lease or its call
 * chain.
 *
 * Why a register and not a variable. The obvious shape is a module-level
 * `currentTurn` cell, and this repository has already paid for that one: a
 * `currentLease` cell meant a scheduled run and a serve run overwrote each
 * other, so whichever finished first released the OTHER's account lease and
 * freed a slot that was still in use. The lesson is not "never module state",
 * it is "never state a second writer can silently overwrite".
 *
 * So: a LIST, and `current()` returns a binding only when exactly one turn is
 * live. Zero or two is not a crash and not a guess, it is `null`, and every
 * caller degrades to the pre-rung-2 behaviour (no chain propagated, no slot
 * parked) with a log line naming why. Today the per-process turn lock
 * (`src/turnlock.ts`) makes the two-turn case unreachable; rung 3 narrows that
 * lock to one turn per SESSION, at which point the dispatcher must thread a
 * binding per run and `current()` starts returning null instead of the wrong
 * answer. Failing visibly at that boundary is the point of this file.
 */
import type { Lane } from "./account.js";
import type { ChainRef } from "./chainid.js";

export interface TurnBinding {
  runId: string;
  /** This turn's account lease, or null when it never got one. */
  leaseId: string | null;
  agent: string;
  lane: Lane;
  /** The call chain this turn is serving (wire 8, 0.1.9), or null at a root. */
  chain: ChainRef | null;
  /** The asker's deadline, when the turn is serving a request that carried one. */
  replyBy: string | null;
  /** The scope an action taken in this turn serves (RFA-0.8 sect. 6.4 item 1). */
  conversationId: string | null;
  taskId: string | null;
}

export class TurnRegister {
  private live: TurnBinding[] = [];

  /** Bind a turn for its lifetime; the returned function unbinds it, once. */
  bind(binding: TurnBinding): () => void {
    this.live.push(binding);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const i = this.live.indexOf(binding);
      if (i >= 0) this.live.splice(i, 1);
    };
  }

  /**
   * The one live turn, or null when there is no turn or more than one. Never a
   * guess: with two live turns there is no answer that is right for both, and
   * returning either would attach one turn's chain to the other's ask.
   */
  current(): TurnBinding | null {
    return this.live.length === 1 ? this.live[0] : null;
  }

  /** How many turns are live: what a caller logs when `current()` gave it nothing. */
  liveCount(): number {
    return this.live.length;
  }
}
