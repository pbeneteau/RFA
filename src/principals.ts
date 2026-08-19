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
