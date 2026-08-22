/**
 * The pre-0.7 checkout becomes a hub directory (RFA-0.7 sect. 7), tested on a
 * synthetic legacy layout: the plan names every move, the apply performs exactly
 * the plan, and a live store is refused.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { matchDigest } from "../src/credentials.js";
import { loadHubDir, principalsStore, roomsStore, secretsStore, tokensStore } from "../src/hubdir.js";
import { applyMigration, lockStatus, parseRoomMd, planMigration } from "../src/migrate.js";
import { principalIdFor, PrincipalSet } from "../src/principals.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "rfa-migrate-"));

const HUMAN_KEY = "hk_legacy_human_0123456789";
const TOKEN = "tok_legacy_operator_0123456789";
const JOIN_SECRET = "js_legacy_0123456789";

/** What a pre-0.7 checkout looks like after a week of use. */
function legacyCheckout(root: string, opts: { liveLock?: boolean; staleLock?: boolean } = {}): void {
  const w = (rel: string, content: string, mode?: number): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, mode ? { mode } : undefined);
  };
  w("data/rooms/r_0123456789.ndjson", '{"seq":1,"type":"roster"}\n');
  w("data/rooms/r_0123456789.meta.json", '{"handle":"r_0123456789","topic":"standing","members":[]}\n');
  w("data/runs.db", "sqlite-bytes");
  w("data/runs.db-wal", "wal-bytes");
  w("data/obs.db", "sqlite-bytes");
  w("data/auth.log.ndjson", "{}\n");
  w("data/secrets.json", JSON.stringify({ RFA_TOKEN: TOKEN, RFA_JOIN_SECRET: JOIN_SECRET, LINEAR_API_KEY: "lin_x" }), 0o600);
  w("data/supervisor-state.json", '{"agents":{}}');
  w("data/supervisor-commands.ndjson", "");
  w("data/ops-room.json", JSON.stringify({ room: "r_ops0000000", membershipToken: "mt_x", memberId: "m_x", name: "platform", joinSecret: "js_ops" }));
  w("data/ops-digest.json", '{"last_at":1}');
  w("data/retired/old-2026-08-01/agent.md", "---\n---\nx");
  w("dogfood/ROOM.md", "# Standing product room (dogfood)\n\n- Hub: `http://127.0.0.1:8790/mcp`\n- Room: `r_0123456789`\n- Join secret: `" + JOIN_SECRET + "`\n");
  w("dogfood/state/human-key.txt", HUMAN_KEY + "\n", 0o600);
  w("dogfood/state/hub.log", "log\n");
  w("dogfood/state/parity.json", "[]");
  w("agents/pm/agent.md", "---\nrfa_agent: 1\nname: pm\ndescription: d\n---\nprompt\n");
  w("agents/pm/state/member.json", '{"room":"r_0123456789"}');
  w("deploy/gate.json", "[]");
  w("evals/baseline.json", "{}");
  w("evals/cases/c1/case.yaml", "id: c1\n");
  if (opts.liveLock) w("data/.hub.lock", JSON.stringify({ pid: 1, nonce: "n", heartbeat: Date.now() }));
  if (opts.staleLock) w("data/.hub.lock", JSON.stringify({ pid: 1, nonce: "n", heartbeat: Date.now() - 3600_000 }));
}

test("parseRoomMd reads the handle and the secret the resident published", () => {
  assert.deepEqual(parseRoomMd("- Hub: `http://h/mcp`\n- Room: `r_0123456789`\n- Join secret: `js_x`\n"), { handle: "r_0123456789", secret: "js_x", hub: "http://h/mcp" });
  assert.equal(parseRoomMd("nothing here"), null);
});

test("lockStatus tells a live store from a stale or absent lock", () => {
  const root = tmp();
  assert.equal(lockStatus(root), "none");
  fs.writeFileSync(path.join(root, ".hub.lock"), JSON.stringify({ heartbeat: Date.now() }));
  assert.equal(lockStatus(root), "live");
  fs.writeFileSync(path.join(root, ".hub.lock"), JSON.stringify({ heartbeat: Date.now() - 120_000 }));
  assert.equal(lockStatus(root), "stale");
  fs.writeFileSync(path.join(root, ".hub.lock"), "torn");
  assert.equal(lockStatus(root), "stale", "a corrupt lock is abandoned, as the store itself treats it");
});

test("the plan names every move, and a live store is a warning the apply turns into a refusal", () => {
  const legacy = tmp();
  legacyCheckout(legacy, { liveLock: true });
  const plan = planMigration(legacy, path.join(tmp(), "acme"), { name: "acme", port: 8790 });
  assert.equal(plan.inPlace, false);
  assert.ok(plan.warnings.some((w) => /fresh heartbeat/.test(w)), "a serving hub is named before anything moves");
  const moves = plan.steps.filter((s) => s.kind === "move").map((s) => path.relative(legacy, s.from!));
  for (const expected of ["data/rooms", "data/runs.db", "data/runs.db-wal", "data/obs.db", "data/secrets.json", "data/ops-room.json", "data/retired", "agents", "evals", "deploy/gate.json", "dogfood/state/parity.json", "dogfood/state/hub.log"]) {
    assert.ok(moves.includes(expected), `plans to move ${expected}`);
  }
  assert.ok(!moves.includes("data/.hub.lock"), "the lock is never moved");
  assert.ok(plan.steps.some((s) => s.kind === "record" && /principal/.test(s.detail)));
  assert.ok(plan.afterwards.some((a) => /rfa up/.test(a)));
  assert.throws(() => applyMigration(plan), /serving .*stop it/);
  assert.ok(fs.existsSync(path.join(legacy, "data", "runs.db")), "nothing moved");
});

test("apply performs the plan into a fresh directory: paths, hashed credentials, rooms, gitignore", () => {
  const legacy = tmp();
  legacyCheckout(legacy, { staleLock: true });
  const target = path.join(tmp(), "acme");
  const plan = planMigration(legacy, target, { name: "acme", port: 8795, human: "paul", roomAlias: "product" });
  const { done, skipped } = applyMigration(plan);
  assert.equal(skipped.length, 0, skipped.join("; "));
  assert.ok(done.length > 5);

  const h = loadHubDir(target);
  assert.equal(h.manifest.name, "acme");
  assert.equal(h.hubUrl, "http://127.0.0.1:8795/mcp");
  // The store, moved whole.
  assert.ok(fs.existsSync(path.join(h.paths.roomLogs, "r_0123456789.ndjson")));
  assert.ok(fs.existsSync(path.join(h.paths.roomLogs, "r_0123456789.meta.json")));
  assert.ok(fs.existsSync(h.paths.runsDb));
  assert.ok(fs.existsSync(path.join(h.paths.data, "runs.db-wal")), "the WAL travels with its database");
  assert.ok(fs.existsSync(h.paths.obsDb));
  assert.ok(fs.existsSync(h.paths.authLog));
  assert.ok(!fs.existsSync(path.join(legacy, "data", "rooms")), "moved, not copied: one store");
  assert.ok(!fs.existsSync(path.join(legacy, "data", ".hub.lock")), "the stale lock is gone");
  assert.ok(fs.existsSync(h.paths.supervisorState));
  assert.ok(fs.existsSync(h.paths.opsRoom));
  assert.ok(fs.existsSync(path.join(h.paths.retired, "old-2026-08-01", "agent.md")));
  // Packs and operator material.
  assert.ok(fs.existsSync(path.join(h.paths.agents, "pm", "agent.md")));
  assert.ok(fs.existsSync(path.join(h.paths.agents, "pm", "state", "member.json")), "state travels with the pack so the resident resumes its membership");
  assert.ok(fs.existsSync(h.paths.gate!));
  assert.ok(fs.existsSync(h.paths.evalBaseline));
  assert.ok(fs.existsSync(path.join(h.paths.evalCases, "c1", "case.yaml")));
  assert.ok(fs.existsSync(h.paths.evalParity));
  assert.ok(fs.existsSync(path.join(h.paths.logs, "hub.log")));
  // Credentials: hashed at rest, the operator's plaintext in secrets.
  const secrets = secretsStore(h).read();
  assert.equal(secrets.RFA_TOKEN, TOKEN);
  assert.equal(secrets.RFA_HUMAN_KEY, HUMAN_KEY);
  assert.equal(secrets.LINEAR_API_KEY, "lin_x", "every other secret travels untouched");
  assert.equal(fs.statSync(h.paths.secrets).mode & 0o777, 0o600);
  const principals = principalsStore(h).read();
  assert.equal(principals.principals.length, 1);
  assert.equal(principals.principals[0].label, "paul");
  assert.equal(principals.principals[0].id, principalIdFor(HUMAN_KEY), "the id the hub already derives for this key");
  assert.equal(PrincipalSet.fromRecords(principals.principals).match(HUMAN_KEY), principalIdFor(HUMAN_KEY));
  assert.ok(!JSON.stringify(principals).includes(HUMAN_KEY), "no plaintext in principals.json");
  const tokens = tokensStore(h).read();
  assert.equal(tokens.tokens.length, 1);
  assert.equal(tokens.tokens[0].kind, "operator");
  assert.equal(matchDigest(TOKEN, tokens.tokens)?.label, "operator");
  assert.ok(!JSON.stringify(tokens).includes(TOKEN), "no plaintext in tokens.json");
  // Rooms.
  const rooms = roomsStore(h).read().rooms;
  assert.deepEqual(rooms.map((r) => [r.alias, r.handle, r.join_secret]).sort(), [["ops", "r_ops0000000", "js_ops"], ["product", "r_0123456789", JOIN_SECRET]].sort());
  assert.equal(rooms.every((r) => r.operator === null), true, "operator memberships are created later by rfa room adopt, which needs the hub");
  // The gitignore.
  const ignore = fs.readFileSync(h.paths.gitignore, "utf8");
  assert.ok(ignore.includes(".rfa/") && ignore.includes("agents/*/state/"));
  // ROOM.md is left where it was and is simply no longer read.
  assert.ok(fs.existsSync(path.join(legacy, "dogfood", "ROOM.md")));
});

test("apply in place keeps the checkout's agents and evals where they are and moves only the instance state", () => {
  const root = tmp();
  legacyCheckout(root);
  const plan = planMigration(root, root, { name: "dev" });
  assert.equal(plan.inPlace, true);
  applyMigration(plan);
  const h = loadHubDir(root);
  assert.ok(fs.existsSync(path.join(root, "agents", "pm", "agent.md")), "agents/ did not move");
  assert.ok(fs.existsSync(path.join(root, "evals", "baseline.json")), "evals/ did not move");
  assert.ok(fs.existsSync(path.join(root, "deploy", "gate.json")), "deploy/gate.json is copied in place, the repository keeps it");
  assert.ok(fs.existsSync(h.paths.gate!));
  assert.ok(fs.existsSync(path.join(h.paths.roomLogs, "r_0123456789.ndjson")));
  assert.ok(!fs.existsSync(path.join(root, "data")), "the old data/ is empty and gone");
});

test("apply is re-runnable: a second run skips what already moved and refuses an existing manifest", () => {
  const legacy = tmp();
  legacyCheckout(legacy);
  const target = path.join(tmp(), "acme");
  applyMigration(planMigration(legacy, target, { name: "acme" }));
  assert.throws(() => planMigration(legacy, target, { name: "acme" }), /already holds rfa.json/);
});
