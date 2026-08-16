/**
 * JCS-style canonical JSON (RFC 8785 subset) + capability digest (spec 6.2).
 *
 * Notes on conformance: RFC 8785 adopts ECMAScript's number-to-string and
 * string escaping rules, which JSON.stringify implements, so serializing
 * primitives with JSON.stringify and sorting object keys by UTF-16 code units
 * is canonical for the JSON subset agent cards use (no non-finite numbers).
 */
import { createHash } from "node:crypto";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("non-finite numbers are not allowed in canonical JSON");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v === undefined ? null : v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** sha256 over the JCS form, base64url, prefixed. `signatures` excluded per spec 6.2. */
export function digestCard(card: Record<string, unknown>): string {
  const { signatures: _sig, ...rest } = card;
  const hash = createHash("sha256").update(canonicalize(rest), "utf8").digest("base64url");
  return `sha256:${hash}`;
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
