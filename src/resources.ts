/**
 * Resource claims: the key grammar, the intersection rule and the disclosure
 * digest (wire 10.3's `resources[]` block, added in 0.1.9; RFA-0.8 rung 7).
 *
 * The claim is extended from "one owner per task" to "one owner per declared
 * resource". Everything here is pure so the rules can be driven without a hub,
 * and because one of them is the easiest thing in this rung to get wrong.
 *
 * THE RULE THAT LOOKS LIKE A STRING OPERATION AND IS NOT. Intersection is
 * prefix-or-equal on SEGMENTS, never on bytes: `local/agent-a` conflicts with
 * `local/agent-a/notes` and does NOT conflict with `local/agent-ab`. A naive
 * `startsWith` says the second pair conflicts, and the resulting bug is
 * invisible: two unrelated packs refuse each other's claims forever and nothing
 * in the log says why. `test/resources.test.ts` was written before this file for
 * that reason.
 *
 * The other property worth stating at the top: this module never waits. A claim
 * that intersects a live grant is REFUSED (wire 10.3 item 5), which together
 * with widening-as-a-fresh-mini-claim (item 6) breaks hold-and-wait and circular
 * wait at once and makes deadlock structurally impossible rather than merely
 * unlikely. There is deliberately no queue, no block and no retry loop anywhere
 * in the claim path.
 *
 * Scope, normative and repeated here because this is where an implementer meets
 * it (item 9): resource claims prevent WRITE-WRITE interference only. Write skew
 * through disjoint write sets survives by construction and is owned by
 * verification authority (10.4) and idempotent task design. Nothing in this file
 * tries to fix write skew.
 */
import { createHmac } from "node:crypto";

/** Wire 10.3 item 3. Both bounds are normative wire defaults owned by the spec. */
export const MAX_KEY_BYTES = 256;
export const MAX_KEYS = 16;

/** The one separator. */
const SEP = "/";

/**
 * `room` is a reserved `home` value (Appendix B) precisely because it matches the
 * home grammar while naming the shared authority segment: a hub that derived
 * `home === "room"` would make a key's first segment ambiguous.
 */
export const RESERVED_HOME = "room";

export function segmentsOf(key: string): string[] {
  return key.split(SEP);
}

/**
 * Do two keys name overlapping resources? Equal, or one's full segment sequence
 * is a prefix of the other's.
 */
export function intersects(a: string, b: string): boolean {
  const x = segmentsOf(a);
  const y = segmentsOf(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

export interface ClaimantContext {
  /** Hub-derived (wire 4.3), never claimant-chosen. */
  home: string;
  /** The handle of the room the claim is being made in. */
  roomHandle: string;
}

export type KeyValidation = { ok: true; keys: string[] } | { ok: false; reason: string };

/**
 * Validate and canonicalize one claim's `resources[]` (wire 10.3 items 2, 3, 4).
 *
 * A key failing validation is `bad_request` and NOT a refusal: the client sent
 * something malformed, which is a different thing from the board being busy, and
 * conflating them would teach a client to back off from a bug.
 */
export function validateKeys(keys: readonly string[], ctx: ClaimantContext): KeyValidation {
  // A member whose home is the reserved value cannot be reasoned about at all:
  // `room/...` would mean both "the shared namespace" and "this member's own".
  // The join path must never mint one; this is the second door.
  if (ctx.home === RESERVED_HOME) {
    return { ok: false, reason: `\`${RESERVED_HOME}\` is a reserved home value (Appendix B) and no member may carry it` };
  }
  if (keys.length > MAX_KEYS) {
    return { ok: false, reason: `a claim may name at most ${MAX_KEYS} keys, got ${keys.length}` };
  }
  const out: string[] = [];
  for (const raw of keys) {
    if (typeof raw !== "string" || raw.length === 0) {
      return { ok: false, reason: `a resource key must be a non-empty string` };
    }
    // NFC first, so every later check and every stored key sees one spelling of
    // one name (item 3). Two spellings of `café` are one resource, and storing
    // both would admit two writers into it.
    const key = raw.normalize("NFC");
    const bytes = Buffer.byteLength(key, "utf8");
    if (bytes > MAX_KEY_BYTES) {
      return { ok: false, reason: `resource key exceeds ${MAX_KEY_BYTES} bytes (${bytes}): ${key.slice(0, 40)}…` };
    }
    const segs = segmentsOf(key);
    if (segs.length < 2) {
      return { ok: false, reason: `resource key \`${key}\` needs at least two segments: an authority segment (\`room/${ctx.roomHandle}\`, \`local\`, or \`${ctx.home}\`) and a name` };
    }
    if (segs.some((s) => s.length === 0)) {
      return { ok: false, reason: `resource key \`${key}\` has an empty segment; \`/\` is the one separator and never doubles` };
    }
    if (segs.some((s) => s === "." || s === "..")) {
      return { ok: false, reason: `resource key \`${key}\` contains a \`.\` or \`..\` segment, which is not canonical form` };
    }
    const authority = segs[0];
    if (authority === RESERVED_HOME) {
      // `room/<handle>/...`: any member of THAT room. The only namespace where
      // local and remote claims legitimately intersect.
      if (segs[1] !== ctx.roomHandle) {
        return { ok: false, reason: `resource key \`${key}\` names another room; keys under \`room/\` must be \`room/${ctx.roomHandle}/…\` in this room` };
      }
      if (segs.length < 3) {
        return { ok: false, reason: `resource key \`${key}\` needs a name after \`room/${ctx.roomHandle}/\`` };
      }
    } else if (authority === "local") {
      if (ctx.home !== "local") {
        return { ok: false, reason: `resource key \`${key}\` is under \`local/\`, claimable only by members whose home is local (yours is \`${ctx.home}\`)` };
      }
    } else if (authority !== ctx.home) {
      // `<home>/...`: only the peer whose hub-derived home matches. A peer's keys
      // outside `room/...` are unverifiable declarations whose sole effect is
      // hub-side intersection refusal (item 8's last sentence), which is exactly
      // why the authority segment has to be checked even though the name cannot.
      return {
        ok: false,
        reason: `resource key \`${key}\` claims authority \`${authority}\`, which is neither \`room/${ctx.roomHandle}\`, \`local\`, nor your own home \`${ctx.home}\``,
      };
    }
    // One real resource, one key (item 4). A client naming the same key twice is
    // redundant, not wrong.
    if (!out.includes(key)) out.push(key);
  }
  return { ok: true, keys: out };
}

/** A grant: the keys one claim holds, and who holds them. Persisted on the task (item 7). */
export interface ResourceGrant {
  keys: string[];
  /** The member the grant was taken for. */
  owner: string;
  /** The claim generation it belongs to, so a stale grant is recognizable. */
  attempt: number;
  /** `claim`: taken by the claimant. `reservation`: taken on the creator's authority (item 6). */
  source: "claim" | "reservation";
  granted_at: string;
}

/** A live grant somewhere in the room, and which task it sits on. */
export interface LiveGrant {
  taskId: string;
  grant: ResourceGrant;
}

/**
 * The first key of `wanted` that intersects a live grant, or null. Returns the
 * blocking side too, because the refusal has to name it (item 8) and a caller
 * that had to re-derive it would disclose the wrong one half the time.
 */
export function findBlocking(wanted: readonly string[], live: readonly LiveGrant[]): { wanted: string; blocking: string; holder: LiveGrant } | null {
  for (const w of wanted) {
    for (const l of live) {
      for (const held of l.grant.keys) {
        if (intersects(w, held)) return { wanted: w, blocking: held, holder: l };
      }
    }
  }
  return null;
}

/** The prefix every disclosed digest carries, so a reader can tell one from a key. */
export const DIGEST_PREFIX = "hmac-sha256:";

/** The documented digest: HMAC-SHA256 over the UTF-8 key, hex, with its prefix (item 8). */
export function digestKey(key: string, secret: Buffer): string {
  return `${DIGEST_PREFIX}${createHmac("sha256", secret).update(key, "utf8").digest("hex")}`;
}

/**
 * Is this string an opaque disclosure rather than a resource key?
 *
 * A UI that prints one as the other invents a path that exists nowhere: the
 * digest is an HMAC under a hub-held secret, it is stable only for the lifetime
 * of the blocking grant, and it is all a non-local claimant is ever told
 * (item 8). `rfa task show` labels it instead of rendering it as a key.
 */
export function isDigestKey(key: string): boolean {
  return key.startsWith(DIGEST_PREFIX);
}

/**
 * What a refused claimant is told the blocking key is (item 8).
 *
 * A non-local claimant blocked by a `local/...` key gets an opaque keyed digest
 * instead of the key, because the operator's private resource-key layout is not
 * a counterparty's business, and an UNSALTED hash of a guessable key shape is
 * confirmable by dictionary and would disclose the layout anyway. Every other
 * combination gets the key: a local claimant has nothing to be protected from,
 * and `room/...` is a namespace both parties already share.
 */
export function discloseKey(key: string, opts: { claimantHome: string; secret: Buffer }): string {
  const isLocalKey = segmentsOf(key)[0] === "local";
  if (isLocalKey && opts.claimantHome !== "local") return digestKey(key, opts.secret);
  return key;
}

/**
 * What a READER may be told a live grant's keys are (item 7, amended 2026-08-28).
 *
 * THE HOLE THIS CLOSES, and it is worth stating because the two rules only make
 * sense together. Item 8 digests the operator's `local/...` layout in a REFUSAL
 * so a guest cannot map it. Item 7 puts grants on the task object, and
 * `room_task get`/`list` handed that same guest every live grant's raw keys, so
 * the refusal path hid the layout while the board published it: the digest
 * protected nothing while LOOKING like a protection, which is worse than not
 * existing at all. Found on 2026-08-27 by driving rung 7's guest branches
 * against a real hub (docs/LEDGER.md), invisible until then because no member
 * on any hub here had ever carried a non-local home.
 *
 * THE RULE. Coordination needs to know THAT a resource is taken, not the
 * operator's internal name for it, so a non-local reader gets the digest for
 * every key it could not have named itself, and the key everywhere it could:
 *
 * - reader `home === "local"`: every key verbatim, INCLUDING a peer's own
 *   `<home>/...` keys. Local members need the real keys to work, `rfa task
 *   show` prints them, and an operator who cannot see which peer resource is
 *   held cannot answer a question about their own board. This is the one
 *   branch that is not symmetric, and it is a deliberate asymmetry: the hub is
 *   the operator's.
 * - `room/<this room's handle>/...`: verbatim to everyone. Shared ground by
 *   definition, and the namespace where local and remote claims legitimately
 *   meet, so this is the disclosure that makes back-off possible at all.
 * - the reader's OWN `<home>/...`: verbatim. Item 2 makes that namespace
 *   claimable only by the peer whose home it is, so those are the peer's own
 *   names and never the operator's layout; two memberships of one home really
 *   do collide inside it, so the peer needs to see contention there for the
 *   same reason it needs it under `room/`; and item 8 already hands that peer
 *   exactly these keys in a refusal, so digesting them here would recreate the
 *   very disagreement between the two rules that this amendment removes.
 * - everything else (`local/...`, another peer's `<home>/...`): the digest of
 *   item 8, through `digestKey`, never a second implementation.
 *
 * The digest is stable for the grant's lifetime, so a reader can still tell one
 * held resource from another and tell that the thing which blocked it before is
 * still held. That is what a back-off consumer needs and it is all it gets.
 */
export function discloseGrantKey(key: string, opts: { readerHome: string; roomHandle: string; secret: Buffer }): string {
  if (opts.readerHome === "local") return key;
  const segs = segmentsOf(key);
  if (segs[0] === RESERVED_HOME && segs[1] === opts.roomHandle) return key;
  if (segs[0] === opts.readerHome) return key;
  return digestKey(key, opts.secret);
}

/** `discloseGrantKey` over one grant's key list, preserving order and the rest of the grant. */
export function redactGrantsFor(
  grants: readonly ResourceGrant[],
  opts: { readerHome: string; roomHandle: string; secret: Buffer },
): ResourceGrant[] {
  return grants.map((g) => ({ ...g, keys: g.keys.map((k) => discloseGrantKey(k, opts)) }));
}
