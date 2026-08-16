/**
 * Signing profile (spec 4.2 tier T2, 6.1): JWS signatures over JCS-canonicalized
 * agent cards. Detached-style: the payload is the canonical card (signatures
 * excluded), so the signature travels inside the card it attests.
 *
 * Key resolution, two paths:
 * - trusted: the verifier holds a provisioned {kid -> public JWK} set.
 * - embedded: the protected header carries its own public `jwk`; verification
 *   then proves integrity + key binding (self-certifying), NOT external
 *   identity. Peers pin the RFC 7638 thumbprint. kid MUST equal the thumbprint.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { canonicalize } from "./jcs.js";
import type { AgentCard } from "./model.js";

export type Jwk = Record<string, string>;

const B64U = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
const FROM_B64U = (s: string): Buffer => Buffer.from(s, "base64url");

/** RFC 7638 JWK thumbprint (sha256, base64url) over the required members. */
export function jwkThumbprint(jwk: Jwk): string {
  const required =
    jwk.kty === "OKP"
      ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x }
      : jwk.kty === "EC"
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
        : null;
  if (!required) throw new Error(`unsupported kty for thumbprint: ${jwk.kty}`);
  return createHash("sha256").update(canonicalize(required), "utf8").digest("base64url");
}

export interface SigningKey {
  alg: "EdDSA" | "ES256";
  kid: string;
  publicJwk: Jwk;
  privateJwk: Jwk;
}

export function generateSigningKey(alg: "EdDSA" | "ES256" = "EdDSA"): SigningKey {
  const pair =
    alg === "EdDSA"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = pair.publicKey.export({ format: "jwk" }) as Jwk;
  const privateJwk = pair.privateKey.export({ format: "jwk" }) as Jwk;
  return { alg, kid: jwkThumbprint(publicJwk), publicJwk, privateJwk };
}

function keyObjects(jwk: Jwk, isPrivate: boolean): KeyObject {
  return isPrivate
    ? createPrivateKey({ key: jwk as never, format: "jwk" })
    : createPublicKey({ key: jwk as never, format: "jwk" });
}

function rawSign(alg: "EdDSA" | "ES256", input: Buffer, privateJwk: Jwk): Buffer {
  const key = keyObjects(privateJwk, true);
  if (alg === "EdDSA") return cryptoSign(null, input, key);
  return cryptoSign("sha256", input, { key, dsaEncoding: "ieee-p1363" });
}

function rawVerify(alg: "EdDSA" | "ES256", input: Buffer, signature: Buffer, publicJwk: Jwk): boolean {
  try {
    const key = keyObjects(publicJwk, false);
    if (alg === "EdDSA") return cryptoVerify(null, input, key, signature);
    return cryptoVerify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

/** Canonical signing payload: the card with `signatures` excluded, JCS form. */
function cardPayload(card: AgentCard): Buffer {
  const { signatures: _sig, ...rest } = card;
  return Buffer.from(canonicalize(rest), "utf8");
}

/** Sign a card, returning a copy with the signature appended. */
export function signCard(
  card: AgentCard,
  key: SigningKey,
  opts: { embedJwk?: boolean } = {},
): AgentCard {
  const header: Record<string, unknown> = { alg: key.alg, typ: "JOSE", kid: key.kid };
  if (opts.embedJwk !== false) header.jwk = key.publicJwk;
  const protectedB64 = B64U(JSON.stringify(header));
  const input = Buffer.from(`${protectedB64}.${B64U(cardPayload(card))}`, "ascii");
  const signature = B64U(rawSign(key.alg, input, key.privateJwk));
  return { ...card, signatures: [...(card.signatures ?? []), { protected: protectedB64, signature }] };
}

export interface VerificationDetail {
  kid: string | null;
  alg: string | null;
  method: "trusted" | "embedded" | "unresolved";
  ok: boolean;
}

export interface VerificationResult {
  /** null = unsigned; true = at least one signature verified; false = signed but none verified. */
  verified: boolean | null;
  details: VerificationDetail[];
}

const ALLOWED_ALGS = new Set(["EdDSA", "ES256"]);

export function verifyCard(
  card: AgentCard,
  opts: { trustedKeys?: Record<string, Jwk>; allowEmbeddedJwk?: boolean } = {},
): VerificationResult {
  const sigs = card.signatures ?? [];
  if (sigs.length === 0) return { verified: null, details: [] };
  const payloadB64 = B64U(cardPayload(card));
  const details: VerificationDetail[] = [];
  for (const sig of sigs) {
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(FROM_B64U(sig.protected).toString("utf8"));
    } catch {
      details.push({ kid: null, alg: null, method: "unresolved", ok: false });
      continue;
    }
    const alg = typeof header.alg === "string" ? header.alg : null;
    const kid = typeof header.kid === "string" ? header.kid : null;
    if (!alg || !ALLOWED_ALGS.has(alg)) {
      details.push({ kid, alg, method: "unresolved", ok: false });
      continue;
    }
    // Resolve the verification key: provisioned trust first, embedded jwk second.
    let publicJwk: Jwk | null = null;
    let method: VerificationDetail["method"] = "unresolved";
    if (kid && opts.trustedKeys && opts.trustedKeys[kid]) {
      publicJwk = opts.trustedKeys[kid];
      method = "trusted";
    } else if (opts.allowEmbeddedJwk !== false && header.jwk && typeof header.jwk === "object") {
      const jwk = header.jwk as Jwk;
      // The kid must be the key's own thumbprint, so an attacker cannot pair
      // a familiar kid with a substituted key.
      try {
        if (!kid || jwkThumbprint(jwk) === kid) {
          publicJwk = jwk;
          method = "embedded";
        }
      } catch {
        publicJwk = null;
      }
    }
    if (!publicJwk) {
      details.push({ kid, alg, method: "unresolved", ok: false });
      continue;
    }
    const input = Buffer.from(`${sig.protected}.${payloadB64}`, "ascii");
    const ok = rawVerify(alg as "EdDSA" | "ES256", input, FROM_B64U(sig.signature), publicJwk);
    details.push({ kid, alg, method, ok });
  }
  return { verified: details.some((d) => d.ok), details };
}
