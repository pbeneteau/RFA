/**
 * Chain ids and the `would_deadlock` refusal (wire 0.1.9 section 8, transplanted
 * from RFA-0.8 sect. 2.2; built as RFA-0.8 rung 2).
 *
 * Request chains exist the moment members serve each other: a member serving a
 * request may make its own request, and a cycle in that graph deadlocks by
 * SILENCE. Measured shape: A asks B, B asks A, and A's serve loop is doubly
 * serial, so B's request is not merely queued behind A's turn, it is UNREAD
 * until `reply_by`. 120 seconds of dead air, then a timeout that names nothing.
 *
 * What this module is NOT. It is not admission control and it is not a
 * distributed deadlock detector. Chain ids are ADVISORY refusal hints: a
 * counterparty on another framework will not propagate them, so detection fails
 * open at every hop crossing such a member, and the cross-organization backstop
 * is the hub-stamped `reply_by` clock (wire section 8, `cross_home_reply_by_default_s`).
 * A hub MUST NOT refuse admission or delivery on chain-id grounds, and nothing
 * here is reachable from a hub path.
 *
 * Naming note: `src/chain.ts` is the log HASH chain and has nothing to do with
 * this. Two different chains, deliberately two different files.
 */
import { randomBytes } from "node:crypto";

/** The registered ext key (wire Appendix B, 0.1.9). Reverse-DNS, per wire section 8. */
export const CHAIN_EXT = "io.github.pbeneteau/chain";

/**
 * The advisory 2-cycle annotation the HUB stamps (wire section 8): R asks A
 * while A's request to R is still unanswered. Never a refusal, because a
 * counter-ask is the legitimate clarifying-question idiom.
 */
export const COUNTER_ASK_EXT = "io.github.pbeneteau/pending-counter-ask";

/**
 * Hop cap, owned as a registry constant in wire Appendix B. At the cap the ext
 * stops PROPAGATING rather than the request being refused: a chain longer than
 * this is not proof of a cycle, and refusing it would convert an advisory hint
 * into an admission control, which the same section forbids.
 *
 * 8 traces to no external source and the spec says so; Dapr defaults to 32.
 */
export const CHAIN_DEPTH_CAP = 8;

export interface ChainRef {
  id: string;
  depth: number;
}

/** Envelope `ext` as it arrives: unknown keys, unknown shapes, all untrusted. */
type ExtBag = Record<string, unknown> | null | undefined;

/**
 * Read a chain ref out of an envelope's `ext`, or null.
 *
 * Validating rather than casting, because this is peer-supplied data on the
 * wire: a `depth` of `"lots"`, of -1, or of 1e9 must read as "no chain", never
 * as a chain that then propagates a garbage depth onward. An id longer than a
 * ULID is refused for the same reason: it ends up in a log line and in a
 * refusal detail.
 */
export function readChain(ext: ExtBag): ChainRef | null {
  const raw = ext?.[CHAIN_EXT];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, depth } = raw as { id?: unknown; depth?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  if (!Number.isInteger(depth) || (depth as number) < 1) return null;
  return { id, depth: depth as number };
}

/** A fresh root chain id, minted by the member serving the request made while serving nothing. */
export function mintChainId(): string {
  return `chn_${randomBytes(8).toString("hex")}`;
}

/**
 * The chain ext for a request made WHILE SERVING `incoming` (null when serving
 * nothing, which is the root).
 *
 * Three outcomes, and the third is the one people get wrong:
 *   - serving nothing: mint an id, depth 1. The root request itself carries no
 *     ext (it was made while serving nothing); the first HOP is what is tagged.
 *   - serving a chained request below the cap: same id, depth + 1, unchanged
 *     id by requirement.
 *   - serving a chained request AT the cap: null, i.e. send the request with no
 *     ext at all. Not a refusal. Recovery falls back to the `reply_by` clock,
 *     consistent with the fail-open posture the section requires.
 */
export function nextChain(incoming: ChainRef | null | undefined): ChainRef | null {
  if (!incoming) return { id: mintChainId(), depth: 1 };
  if (incoming.depth >= CHAIN_DEPTH_CAP) return null;
  return { id: incoming.id, depth: incoming.depth + 1 };
}

/**
 * The chain ids this member is currently BLOCKED on, i.e. has an outstanding
 * ask riding.
 *
 * A counter, not a set: one member may legitimately have two asks out on one
 * chain (a fan-out inside a turn), and the second returning must not clear the
 * block the first still holds.
 */
export class BlockedChains {
  private counts = new Map<string, number>();

  /** Enter a blocked wait on this chain; the returned function leaves it, once. */
  enter(chainId: string): () => void {
    this.counts.set(chainId, (this.counts.get(chainId) ?? 0) + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const n = (this.counts.get(chainId) ?? 1) - 1;
      if (n <= 0) this.counts.delete(chainId);
      else this.counts.set(chainId, n);
    };
  }

  has(chainId: string | null | undefined): boolean {
    return chainId != null && this.counts.has(chainId);
  }

  get size(): number {
    return this.counts.size;
  }
}

/**
 * The detail a `would_deadlock` refusal carries. The asker gets the chain id it
 * itself propagated, so "why was I refused" is a lookup rather than an
 * inference, and the depth says how far the cycle had already run.
 */
export function wouldDeadlockDetail(chain: ChainRef): string {
  return `already blocked on call chain ${chain.id} (depth ${chain.depth}); answering would close the cycle`;
}
