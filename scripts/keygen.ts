/**
 * Generate a signing key for the RFA signing profile.
 *
 *   npm run keygen                 Ed25519 (EdDSA), prints the key JSON
 *   npm run keygen -- es256        ECDSA P-256
 *   npm run keygen -- --out pm    writes pm.key.json (private, 0600) + pm.pub.json
 */
import * as fs from "node:fs";
import { generateSigningKey } from "../src/signing.js";

const alg = process.argv.includes("es256") ? "ES256" : "EdDSA";
const outIdx = process.argv.indexOf("--out");
const key = generateSigningKey(alg);

if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const prefix = process.argv[outIdx + 1];
  fs.writeFileSync(`${prefix}.key.json`, JSON.stringify(key, null, 2), { mode: 0o600 });
  fs.writeFileSync(`${prefix}.pub.json`, JSON.stringify({ [key.kid]: key.publicJwk }, null, 2));
  console.log(`wrote ${prefix}.key.json (private, keep safe) and ${prefix}.pub.json (kid -> public JWK, for --trusted-keys)`);
  console.log(`kid: ${key.kid}`);
} else {
  console.log(JSON.stringify(key, null, 2));
}
