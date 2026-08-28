/**
 * Verifying a room's hash chain, offline (wire sect. 13).
 *
 * The hub already computes this chain in three places, but only ever forwards:
 * it stamps `prev_hash` from its running head and advances the head. Nothing
 * ever walked a log backwards and asked whether the links hold, except two test
 * files that each carried a private copy of the loop. So the chain has been a
 * claim about the log rather than a checked property of it, which is the gap this
 * closes.
 *
 * Kept as a pure function over an already-parsed array, deliberately: sect. 13
 * says tamper evidence must be verifiable OFFLINE, so nothing here reads a file,
 * constructs a `RoomHub`, or makes a network call. `scripts/verify-log.ts` is the
 * only thing that touches the disk.
 *
 * Three properties of the construction that a verifier has to get exactly right,
 * each of which has already cost this project something:
 *
 *   1. `wrapped` is stripped. It is a RESULT field the hub derives at read time
 *      and never stores, so an event received over the wire carries one and the
 *      logged form does not. Sect. 13 names it as the one field to remove.
 *   2. NOTHING ELSE is stripped. `envelope.seq` and `envelope.ts` used to be
 *      stamped AFTER the event was serialized, so the bytes on disk carried
 *      `seq: 0` while the in-memory copy carried the real value, and a verifier
 *      had to zero both fields to reproduce a hash. That was fixed on 2026-08-18
 *      (stamp before hashing) and the extra exclusions are now WRONG: applying
 *      them fails every message link. INTEROP.md still told peers to do it in
 *      three places.
 *   3. An event carrying `content_hash` is verified through it, not by
 *      recomputing over the served bytes. Two things produce that field and both
 *      are legitimate rewrites that would otherwise read as tampering: a sect.
 *      12.1 redaction, which blanks the body for everyone and also sets
 *      `redacted: true`; and the per-reader grant redaction of sect. 10.3 item
 *      7, which rewrites a task event's grant keys for ONE reader and sets
 *      `content_hash` alone. The rule is one line either way - if the field is
 *      there, it IS this event's link - which is the whole reason 10.3 reuses
 *      12.1's field instead of adding a second one.
 */
import { canonicalize, sha256hex } from "./jcs.js";

/** The genesis link: the hex SHA-256 of the room handle (wire sect. 13). */
export function genesisFor(roomHandle: string): string {
  return sha256hex(roomHandle);
}

/** The hashed form of an event: what the hub actually appended. */
export function hashedForm(event: Record<string, unknown>): Record<string, unknown> {
  // Destructure rather than delete, so the caller's object is never mutated: these
  // events are frequently the hub's own live objects.
  const { wrapped: _wrapped, ...stored } = event;
  return stored;
}

/**
 * The link a given event contributes to the chain.
 *
 * For an ordinary event this is JCS-SHA256 over its hashed form. For an event
 * carrying `content_hash` it is that field, which is the same construction over
 * the form the hub APPENDED (sect. 12.1 for a redaction, sect. 10.3 item 7 for a
 * per-reader grant redaction), so a verifier has one hash function and one
 * canonicalization rather than two.
 *
 * The test is the field's presence, not `redacted === true`. It was the pair
 * until 2026-08-28, when item 7's per-reader redaction became a second producer
 * that stamps `content_hash` WITHOUT `redacted`, because it removes nothing from
 * the record: a verifier that demanded the flag would have rejected a served
 * event whose stamp was sitting right there.
 */
export function linkOf(event: Record<string, unknown>): { hash: string; source: "computed" | "content_hash" } {
  if (typeof event.content_hash === "string") {
    return { hash: event.content_hash, source: "content_hash" };
  }
  return { hash: sha256hex(canonicalize(hashedForm(event))), source: "computed" };
}

export interface ChainDivergence {
  /** The seq of the event whose `prev_hash` did not match. */
  seq: number;
  type: string;
  expected: string;
  found: string;
  /**
   * Which event is implicated. A `prev_hash` mismatch at seq N means the bytes of
   * event N-1 changed (or N's own link was rewritten); the verifier reports both
   * rather than guessing, because a reader who assumes the wrong one looks at the
   * wrong event.
   */
  suspect: string;
}

export interface ChainResult {
  events: number;
  /** Links actually checked. Lower than `events - 1` when a pre-chain prefix is skipped. */
  linksChecked: number;
  /**
   * Leading events with no `prev_hash` at all, from before the chain shipped in
   * 0.1.7. Real: the standing room's first 269 events have none. A verifier that
   * treated a missing link as a break would report the project's own main room as
   * tampered, which is how a tamper detector gets switched off.
   */
  unchainedPrefix: number;
  /**
   * Links taken from a `content_hash` stamp rather than recomputed.
   *
   * Called `redactedLinks` until 2026-08-28, when 10.3 item 7's per-reader grant
   * redaction became a second producer of the stamp. On a log read off disk the
   * count is still 12.1 redactions and nothing else, because that stamp is the
   * only one the hub ever WRITES; on a stream of received events it may also be
   * item 7's. The name no longer asserts which.
   */
  stampedLinks: number;
  genesisOk: boolean | null;
  divergences: ChainDivergence[];
  ok: boolean;
  /**
   * True when the log is entirely pre-chain, so NOTHING was verified.
   *
   * Distinguished from `ok` because conflating them is how a tamper detector stops
   * meaning anything: four of this hub's thirteen room logs predate the chain
   * entirely, and reporting them as "intact" would print a green light for a log
   * nobody checked. Not contradicted is not the same as verified.
   */
  unverifiable: boolean;
}

/**
 * Walk the chain. `events` must be in log order.
 *
 * Every divergence is reported, not just the first: an operator asking "what was
 * touched" is asking about all of it, and stopping at the first mismatch hides
 * whether one event or a hundred changed. The chain re-anchors after each break by
 * continuing from the event's own computed link.
 */
export function verifyChain(
  events: Record<string, unknown>[],
  opts: { genesis?: string } = {},
): ChainResult {
  const divergences: ChainDivergence[] = [];
  let linksChecked = 0;
  let stampedLinks = 0;
  let genesisOk: boolean | null = null;

  // Skip the pre-chain prefix: events appended before 0.1.7 carry no prev_hash.
  let start = 0;
  while (start < events.length && events[start].prev_hash === undefined) start++;
  const unchainedPrefix = start;

  if (start < events.length && opts.genesis !== undefined) {
    // The genesis link is only assertable when the chain starts at the log's own
    // first event. On a room whose chain began mid-log there is nothing to compare
    // the first prev_hash against, so it stays null rather than false: reporting a
    // failure for an unanswerable question is worse than reporting no answer.
    if (start === 0) {
      genesisOk = events[0].prev_hash === opts.genesis;
      if (!genesisOk) {
        divergences.push({
          seq: Number(events[0].seq ?? 0),
          type: String(events[0].type ?? "?"),
          expected: opts.genesis,
          found: String(events[0].prev_hash ?? ""),
          suspect: "the genesis link: either the room handle differs or event 0 was rewritten",
        });
      }
    }
  }

  for (let i = start + 1; i < events.length; i++) {
    const prev = events[i - 1];
    const link = linkOf(prev);
    if (link.source === "content_hash") stampedLinks++;
    const found = events[i].prev_hash;
    if (typeof found !== "string") {
      divergences.push({
        seq: Number(events[i].seq ?? i),
        type: String(events[i].type ?? "?"),
        expected: link.hash,
        found: found === undefined ? "(absent)" : String(found),
        suspect: `event ${String(events[i].seq ?? i)} has no prev_hash while earlier events in this log do`,
      });
      continue;
    }
    linksChecked++;
    if (found !== link.hash) {
      divergences.push({
        seq: Number(events[i].seq ?? i),
        type: String(events[i].type ?? "?"),
        expected: link.hash,
        found,
        suspect:
          `either event ${String(prev.seq ?? i - 1)} was altered (its bytes no longer hash to this link) ` +
          `or event ${String(events[i].seq ?? i)}'s own prev_hash was rewritten`,
      });
    }
  }

  return {
    events: events.length,
    linksChecked,
    unchainedPrefix,
    stampedLinks,
    genesisOk,
    divergences,
    ok: divergences.length === 0,
    unverifiable: linksChecked === 0 && genesisOk !== true,
  };
}

/**
 * What the chain is and is not worth, in the words sect. 13 makes normative.
 *
 * Sect. 13 requires this qualifier "wherever the chain is offered as evidence" and
 * forbids a hub from describing the chain to a counterparty as protection against
 * itself. So it is a string in the library rather than a line in one CLI: any
 * surface that reports a verification result can print the same sentence, and none
 * of them can quietly drop it.
 */
export const CHAIN_SCOPE_QUALIFIER =
  "What this proves: no party OTHER THAN THE HUB rewrote the log. " +
  "The hub holds the only chain head and can re-link a whole log it has edited, so this is not evidence against the operator running it. " +
  "Against the operator it is worth nothing, and it MUST NOT be offered to a counterparty as if it were.";
