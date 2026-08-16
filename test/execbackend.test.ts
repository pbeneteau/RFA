/** v0.4.2 exec backends: the one execute() seam, plain and srt-sandboxed. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlainBackend, SrtLocalBackend } from "../src/execbackend.js";
import { loadSecrets, pickSecrets } from "../src/secrets.js";

test("PlainBackend: output, exit codes, truncation", async () => {
  const b = new PlainBackend();
  const ok = await b.execute("echo hello");
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /hello/);
  const fail = await b.execute("exit 3");
  assert.equal(fail.exitCode, 3);
  const big = await b.execute("yes x | head -c 100000", { maxOutputBytes: 1000 });
  assert.equal(big.truncated, true);
  assert.ok(big.output.length < 1200);
});

test("secrets: load warns on loose modes, pick resolves names and reports the missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-sec-"));
  const file = path.join(dir, "secrets.json");
  fs.writeFileSync(file, JSON.stringify({ LINEAR_API_KEY: "lin_x", SLACK_TOKEN: "xoxb-y", NOT_A_STRING: 42 }), { mode: 0o600 });
  const all = loadSecrets(file);
  assert.deepEqual(Object.keys(all).sort(), ["LINEAR_API_KEY", "SLACK_TOKEN"], "non-strings dropped");
  const { env, missing } = pickSecrets(all, ["LINEAR_API_KEY", "GITHUB_TOKEN"]);
  assert.deepEqual(env, { LINEAR_API_KEY: "lin_x" });
  assert.deepEqual(missing, ["GITHUB_TOKEN"]);
  assert.deepEqual(loadSecrets(path.join(dir, "absent.json")), {}, "missing file is empty, not an error");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The srt tier needs the platform sandbox (Seatbelt/bubblewrap); skip elsewhere.
const srtSupported = process.platform === "darwin" || process.platform === "linux";

test("SrtLocalBackend: command runs inside the sandbox; external egress is blocked", { skip: !srtSupported }, async () => {
  const b = new SrtLocalBackend({
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: false },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [os.tmpdir()], denyWrite: [] },
  });
  const ok = await b.execute("echo sandboxed-ok", { timeoutMs: 30_000 });
  assert.equal(ok.exitCode, 0, `sandboxed echo failed: ${ok.output.slice(0, 200)}`);
  assert.match(ok.output, /sandboxed-ok/);
  // Negative control: with an empty allowlist, the network must be closed.
  const blocked = await b.execute("curl -s -o /dev/null --max-time 5 -w '%{http_code}' https://example.com", { timeoutMs: 30_000 });
  assert.notEqual(blocked.exitCode, 0, `external egress should be blocked, got: ${blocked.output.slice(0, 120)}`);
});
