/**
 * Credentials hashed at rest and reloaded on change (RFA-0.7 sect. 2.4).
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { matchDigest, parsePrincipalsFile, parseTokensFile, tokenDigest, WatchedFile } from "../src/credentials.js";
import { principalIdFor, principalKeyDigest, principalRecordFor, PrincipalSet } from "../src/principals.js";
import type { TokenRecord, TokensFile } from "../src/hubdir.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "rfa-cred-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rec = (label: string, plaintext: string, extra: Partial<TokenRecord> = {}): TokenRecord => ({
  id: `tk_${label}`,
  label,
  kind: "operator",
  sha256: tokenDigest(plaintext),
  created_at: "2026-08-22T00:00:00Z",
  expires_at: null,
  ...extra,
});

test("matchDigest: a presented secret matches its digest and nothing else", () => {
  const records = [rec("a", "tok_aaaa"), rec("b", "tok_bbbb")];
  assert.equal(matchDigest("tok_aaaa", records)?.label, "a");
  assert.equal(matchDigest("tok_bbbb", records)?.label, "b");
  assert.equal(matchDigest("tok_cccc", records), null);
  assert.equal(matchDigest("", records), null);
  assert.equal(matchDigest("tok_aaaa", []), null, "no records means no match, never a default");
});

test("matchDigest: an expired record is compared like any other and then discarded", () => {
  const now = Date.parse("2026-08-22T12:00:00Z");
  const records = [rec("live", "tok_live", { expires_at: "2026-12-01T00:00:00Z" }), rec("dead", "tok_dead", { expires_at: "2026-08-01T00:00:00Z" })];
  assert.equal(matchDigest("tok_live", records, now)?.label, "live");
  assert.equal(matchDigest("tok_dead", records, now), null);
});

test("matchDigest: a malformed stored digest can never match", () => {
  const records = [{ ...rec("bad", "tok_x"), sha256: "not-hex" }];
  assert.equal(matchDigest("tok_x", records), null);
});

test("PrincipalSet: plaintext keys and hashed records resolve to the same principal ids", () => {
  const keyA = "hk_alpha_0123456789";
  const keyB = "hk_beta_0123456789";
  const fromKeys = PrincipalSet.fromKeys([keyA, keyB]);
  assert.equal(fromKeys.match(keyA), principalIdFor(keyA));
  assert.equal(fromKeys.match(keyB), principalIdFor(keyB));
  assert.equal(fromKeys.match("hk_wrong"), null);
  assert.equal(fromKeys.size, 2);

  const fromRecords = PrincipalSet.fromRecords([principalRecordFor(keyA, "paul")]);
  assert.equal(fromRecords.match(keyA), principalIdFor(keyA), "a record built from the key matches the key");
  assert.equal(fromRecords.match(keyB), null);
  assert.equal(principalRecordFor(keyA, "paul").key_sha256, principalKeyDigest(keyA));

  fromRecords.replace([principalRecordFor(keyB, "ana")]);
  assert.equal(fromRecords.match(keyA), null, "replace swaps the whole set: a removed human stops matching");
  assert.equal(fromRecords.match(keyB), principalIdFor(keyB));
});

test("parseTokensFile and parsePrincipalsFile refuse malformed records with the reason", () => {
  assert.throws(() => parseTokensFile({ version: 2, tokens: [] }), /version: 1/);
  assert.throws(() => parseTokensFile({ version: 1, tokens: [{ id: "x", label: "l", kind: "admin", sha256: "0".repeat(64) }] }), /kind/);
  assert.throws(() => parseTokensFile({ version: 1, tokens: [{ id: "x", label: "l", kind: "peer", sha256: "short" }] }), /sha256/);
  assert.throws(() => parseTokensFile({ version: 1, tokens: [rec("a", "t"), rec("b", "t")] }), /duplicate/);
  const ok = parseTokensFile({ version: 1, tokens: [{ id: "x", label: "l", kind: "client", sha256: "0".repeat(64) }] });
  assert.equal(ok.tokens[0].expires_at, null, "expires_at defaults to null");
  assert.throws(() => parsePrincipalsFile({ version: 1, principals: [{ id: "nope", label: "p", key_sha256: "0".repeat(64) }] }), /hp_/);
  assert.throws(() => parsePrincipalsFile({ version: 1, principals: [{ id: "hp_0123456789ab", label: "", key_sha256: "0".repeat(64) }] }), /label/);
});

test("WatchedFile reloads a valid edit, keeps the previous value on a malformed one, and reports it", async () => {
  const dir = tmp();
  const file = path.join(dir, "tokens.json");
  const errors: string[] = [];
  const reloads: number[] = [];
  const watched = new WatchedFile<TokensFile>(file, parseTokensFile, () => ({ version: 1, tokens: [] }), {
    pollMs: 25,
    onError: (err) => errors.push(err.message),
    onReload: (f) => reloads.push(f.tokens.length),
  });
  assert.deepEqual(watched.value, { version: 1, tokens: [] }, "a missing file is the empty value at startup, not an error");
  assert.equal(errors.length, 0);
  watched.start();
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, tokens: [rec("a", "tok_a")] }));
    for (let i = 0; i < 40 && reloads.length === 0; i++) await sleep(25);
    assert.deepEqual(reloads, [1], "the new record is live without a restart");
    assert.equal(matchDigest("tok_a", watched.value.tokens)?.label, "a");

    // A malformed edit: the previous set stays, and the operator is told.
    await sleep(30); // a distinct mtime
    fs.writeFileSync(file, "{ torn");
    for (let i = 0; i < 40 && errors.length === 0; i++) await sleep(25);
    assert.equal(errors.length, 1);
    assert.equal(watched.value.tokens.length, 1, "never an empty set because of a half-saved file");

    // Back to valid, with the record revoked: the match goes away on reload.
    await sleep(30);
    fs.writeFileSync(file, JSON.stringify({ version: 1, tokens: [] }));
    for (let i = 0; i < 40 && reloads.length < 2; i++) await sleep(25);
    assert.deepEqual(reloads, [1, 0]);
    assert.equal(matchDigest("tok_a", watched.value.tokens), null, "revocation takes effect on the next request");
  } finally {
    watched.stop();
  }
});
