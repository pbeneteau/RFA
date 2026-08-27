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
 * So: a LIST plus an async-context store. `current()` answers with the binding
 * IN SCOPE, and falls back to the single live turn when nothing put one there.
 * Zero live turns, or two with no scope, is not a crash and not a guess, it is
 * `null`, and every caller degrades to the pre-rung-2 behaviour (no chain
 * propagated, no slot parked) with a log line naming why.
 *
 * Rung 2 shipped the list alone, and said what rung 3 would owe: the per-process
 * turn lock made two live turns unreachable, so the population WAS the answer,
 * and narrowing that lock to one turn per SESSION (rung 3) would start returning
 * null where it used to return the right binding. The store is that debt paid:
 * the binding now travels with its turn rather than being inferred. Failing
 * visibly at the boundary is still the point of this file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Lane } from "./account.js";
import type { ChainRef } from "./chainid.js";
import type { WriteProvenance } from "./memoryfs.js";

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
  /**
   * The candidate set this turn is one of (RFA-0.8 sect. 11), else null.
   *
   * Read by the two memory write paths, which is the whole reason it travels
   * with the turn: a candidate may lose, and a losing candidate's reasoning must
   * never become remembered fact. `/memories` mutating verbs refuse while this
   * is set, and the episode log's guard throws on an own-answer write.
   */
  candidateSet?: string | null;
  /**
   * The hub-derived `home` of whoever this turn is serving (wire 4.3), and the
   * room it is serving in. Travels with the turn so the memory write path can
   * read it from module scope, which is what RFA-0.8 sect. 4 item 5's cross-org
   * quarantine needs: a write is quarantined by WHO ASKED, and under
   * `concurrency: N` the process is serving several requesters at once, so the
   * answer cannot be a process-wide variable.
   */
  requesterHome?: string | null;
  room?: string | null;
}

/**
 * A turn's binding as `GatedMemory`'s write provenance (RFA-0.8 sect. 4 item 5).
 *
 * Shared code, not a copied expression, because it had already been copied once:
 * `scripts/e2e.ts`'s cross-org memory scenario restated the resident's provider
 * line for line, so a change to the resident's own provider (dropping
 * `requester_home`, capping the turn at construction) would have left the
 * scenario passing on its private copy and reporting the quarantine as working.
 * Both call it now.
 */
export const provenanceFromTurn = (t: TurnBinding | null): WriteProvenance | null =>
  t ? { requester_home: t.requesterHome ?? "local", room: t.room ?? null } : null;

export class TurnRegister {
  private live: TurnBinding[] = [];
  /**
   * The rung-3 answer to the paragraph above. `current()` used to be able to
   * answer only because the turn lock made two live turns impossible; under
   * `concurrency: N` two live turns are the point, so the binding travels WITH
   * the turn instead of being inferred from the register's population.
   *
   * ALS propagates through promise chains, so anything the turn awaits - the
   * query iteration, and the MCP tool handlers the SDK invokes from inside it -
   * sees the store. What this repository cannot prove is that the SDK never
   * invokes a handler from a context rooted outside that iteration; if it ever
   * does, the fallback below still covers N = 1, and at N > 1 the caller
   * degrades exactly as it does today, with a log line naming why.
   */
  private readonly als = new AsyncLocalStorage<TurnBinding>();

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

  /** Run a turn's whole body with its binding in scope, for the readers that cannot be handed one. */
  run<T>(binding: TurnBinding, fn: () => Promise<T>): Promise<T> {
    return this.als.run(binding, fn);
  }

  /**
   * THIS turn's binding: the one in scope, else the one live turn, else null.
   *
   * Never a guess. The ALS store is the turn that is actually asking. The
   * single-live-turn fallback covers a caller the store did not reach while the
   * process holds exactly one turn, which is the pre-rung-3 world and still the
   * default (`concurrency: 1`). With two live turns and no store there is no
   * answer that is right for both, and returning either would attach one turn's
   * chain to the other's ask, so the answer is null and the caller degrades.
   */
  current(): TurnBinding | null {
    return this.als.getStore() ?? (this.live.length === 1 ? this.live[0] : null);
  }

  /** How many turns are live: what a caller logs when `current()` gave it nothing. */
  liveCount(): number {
    return this.live.length;
  }
}
