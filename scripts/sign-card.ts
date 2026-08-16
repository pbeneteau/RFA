/**
 * Sign an agent card with a key produced by keygen.
 *
 *   npm run sign-card -- card.json pm.key.json > card.signed.json
 */
import * as fs from "node:fs";
import { signCard, verifyCard } from "../src/signing.js";

const [cardPath, keyPath] = process.argv.slice(2);
if (!cardPath || !keyPath) {
  console.error("usage: npm run sign-card -- <card.json> <key.json>   (key.json from keygen)");
  process.exit(1);
}
const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));
const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
const signed = signCard(card, key);
const check = verifyCard(signed);
console.error(`signed with kid ${key.kid} (${key.alg}); self-check verified=${check.verified}`);
console.log(JSON.stringify(signed, null, 2));
