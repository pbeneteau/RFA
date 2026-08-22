/**
 * How a human proves who they are, in one place (RFA-0.6 sect. 4.4, rung v0.6.4).
 *
 * Two defects this closes, both named in sect. 4.4 as "not remote-specific":
 *
 *   1. **Which human?** A provisioned human key granted `origin: "human"` and
 *      nothing else. Every key was interchangeable, so the hash-chained log could
 *      prove an approval happened and could not say who gave it. Sect. 4.4 puts it
 *      bluntly: a log that cannot say which human approved undermines the pitch.
 *      Every human key now maps to a stable `principal_id`.
 *   2. **A timing side channel on the join path.** `POST /auth` was fixed to
 *      compare in constant time; `room_join`'s `human_key` check was left using
 *      `Array.includes` and documented as PENDING, on the reasoning that it sits
 *      behind a room handle and a join secret. That reasoning has thinned: `/mcp`
 *      now takes a transport credential that every resident holds, and the join
 *      secret lives in a file on the same machine. One implementation, used by
 *      both paths, was the stated intent all along ("a second copy of this loop is
 *      a second chance to get it wrong").
 *
 * A principal id is deliberately NOT the key and not a truncation of it: it is a
 * domain-separated hash, so it is safe to write into an event log, a refs object
 * and a member name, none of which are places a secret may go.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { PrincipalRecord } from "./hubdir.js";

/** Domain separation, so a principal id can never collide with any other hash this project stores. */
const PRINCIPAL_DOMAIN = "rfa-human-principal:v1:";

/** The public half of a human key: `hp_` plus 12 hex. Safe to log, never reversible to the key. */
export function principalIdFor(humanKey: string): string {
  return "hp_" + createHash("sha256").update(PRINCIPAL_DOMAIN + humanKey).digest("hex").slice(0, 12);
}

/**
 * The console's own membership name for a principal.
 *
 * `console-<hex>` rather than a bare `console`: one shared console membership meant
 * every decision from the console was attributed to the same member, whoever was
 * holding the phone. The first token stays `console`, which the reserved-name rule
 * already requires be human-origin, so the existing authority check is unchanged.
 */
export function consoleNameFor(principalId: string): string {
  return "console-" + principalId.replace(/^hp_/, "");
}

/**
 * Constant-time membership test for a presented secret.
 *
 * `timingSafeEqual` throws on a length mismatch, so a wrong-length candidate is
 * compared against a same-length zero filler instead of short-circuiting: every
 * configured secret costs exactly one comparison of its own length whatever
 * arrives, and the length check that decides the verdict runs after the comparison
 * rather than instead of it.
 */
export function constantTimeMatch(presented: string, configured: readonly string[]): boolean {
  const p = Buffer.from(presented, "utf8");
  let ok = false;
  for (const secret of configured) {
    const k = Buffer.from(secret, "utf8");
    const sameLength = k.length === p.length;
    const candidate = sameLength ? p : Buffer.alloc(k.length);
    ok = (timingSafeEqual(k, candidate) && sameLength) || ok;
  }
  return ok;
}

/**
 * Which principal presented this key, in constant time, or null.
 *
 * The loop runs over every configured key whatever matches, for the same reason
 * `constantTimeMatch` does: returning early on a hit would leak the matching key's
 * POSITION in the list through timing, which on a two-operator hub is one bit
 * saying which of them it was.
 */
export function matchPrincipal(presented: string, configured: readonly string[]): string | null {
  const p = Buffer.from(presented, "utf8");
  let found: string | null = null;
  for (const secret of configured) {
    const k = Buffer.from(secret, "utf8");
    const sameLength = k.length === p.length;
    const candidate = sameLength ? p : Buffer.alloc(k.length);
    if (timingSafeEqual(k, candidate) && sameLength) found = principalIdFor(secret);
  }
  return found;
}

/** Hex SHA-256 of a human key: what rests on disk in `.rfa/principals.json`, never the key. */
export function principalKeyDigest(humanKey: string): string {
  return createHash("sha256").update(humanKey, "utf8").digest("hex");
}

/** The record `rfa human add` writes for a freshly minted key. */
export function principalRecordFor(humanKey: string, label: string, now: Date = new Date()): PrincipalRecord {
  return { id: principalIdFor(humanKey), label, key_sha256: principalKeyDigest(humanKey), created_at: now.toISOString() };
}

/**
 * The set of human principals a hub recognizes, matched by digest (RFA-0.7 sect. 2.4).
 *
 * One object, shared by the HTTP layer (`POST /auth`) and the wire join path
 * (`room_join` with `human_key`), and REPLACED in place when the principals file
 * reloads, so a revoked key stops matching on the next request everywhere at
 * once. Built from plaintext keys for tests and throwaway hubs (`--human-key`,
 * `RFA_HUMAN_KEYS`), or from records for a hub directory.
 *
 * The match is constant time over digests, every record costing one comparison
 * and the verdict taken after the loop, for the same reason `matchPrincipal`
 * never returns early.
 */
export class PrincipalSet {
  private records: PrincipalRecord[] = [];

  static fromKeys(keys: readonly string[], now: Date = new Date()): PrincipalSet {
    const set = new PrincipalSet();
    set.records = keys.filter(Boolean).map((k, i) => principalRecordFor(k, `key-${i + 1}`, now));
    return set;
  }

  static fromRecords(records: readonly PrincipalRecord[]): PrincipalSet {
    const set = new PrincipalSet();
    set.records = [...records];
    return set;
  }

  /** Swap the whole set: what a file reload does. */
  replace(records: readonly PrincipalRecord[]): void {
    this.records = [...records];
  }

  get size(): number {
    return this.records.length;
  }

  list(): readonly PrincipalRecord[] {
    return this.records;
  }

  /** Which principal presented this key, or null. */
  match(presented: string): string | null {
    const digest = Buffer.from(principalKeyDigest(presented), "hex");
    let found: string | null = null;
    for (const record of this.records) {
      const stored = Buffer.from(/^[0-9a-f]{64}$/.test(record.key_sha256) ? record.key_sha256 : "", "hex");
      const sameLength = stored.length === digest.length;
      const candidate = sameLength ? digest : Buffer.alloc(stored.length);
      if (timingSafeEqual(stored, candidate) && sameLength) found = record.id;
    }
    return found;
  }

  has(presented: string): boolean {
    return this.match(presented) !== null;
  }
}
