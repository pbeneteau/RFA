/**
 * The hub directory (RFA-0.7 sect. 2): resolution, validation, the runtime
 * stores, and the one rule that keeps the separation honest: no source file
 * outside src/hubdir.ts may join a path onto an instance directory's name.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  defaultManifest,
  detectLegacyLayout,
  ensureRuntime,
  findHubRoot,
  HubDirError,
  hubUrlFor,
  JsonStore,
  loadHubDir,
  MANIFEST_FILE,
  maybeHubDir,
  requireHubDir,
  resolveHubRoot,
  roomsStore,
  writeJsonAtomic,
  writeManifest,
} from "../src/hubdir.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "rfa-hubdir-"));

function hubAt(root: string, name = "acme", port = 8790): string {
  fs.mkdirSync(root, { recursive: true });
  writeManifest(root, defaultManifest({ name, port }));
  return root;
}

test("a hub directory is found by walking up, like a git repository", () => {
  const root = hubAt(path.join(tmp(), "acme"));
  const deep = path.join(root, "agents", "pm", "knowledge");
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findHubRoot(deep), root);
  assert.equal(findHubRoot(root), root);
  assert.equal(findHubRoot(tmp()), null, "an unrelated temp dir has no manifest above it");
});

test("resolution precedence: --dir beats RFA_DIR beats the walk-up", () => {
  const a = hubAt(path.join(tmp(), "a"));
  const b = hubAt(path.join(tmp(), "b"), "b-hub");
  const c = hubAt(path.join(tmp(), "c"), "c-hub");
  assert.equal(resolveHubRoot({ dir: a, env: { RFA_DIR: b }, cwd: c }), a);
  assert.equal(resolveHubRoot({ env: { RFA_DIR: b }, cwd: c }), b);
  assert.equal(resolveHubRoot({ env: {}, cwd: path.join(c, "agents") }), c);
  assert.equal(resolveHubRoot({ env: {}, cwd: tmp() }), null);
});

test("loading validates, and every failure names its fix", () => {
  const empty = tmp();
  assert.throws(() => loadHubDir(empty), (err: HubDirError) => err.code === "not_found" && /rfa init/.test(err.hint));

  const badJson = tmp();
  fs.writeFileSync(path.join(badJson, MANIFEST_FILE), "{ not json");
  assert.throws(() => loadHubDir(badJson), (err: HubDirError) => err.code === "invalid" && /not valid JSON/.test(err.message));

  const unknownKey = tmp();
  fs.writeFileSync(path.join(unknownKey, MANIFEST_FILE), JSON.stringify({ rfa: 1, name: "x", hub: { port: 8790 }, retnetion: {} }));
  assert.throws(() => loadHubDir(unknownKey), (err: HubDirError) => err.code === "invalid", "an unknown key is a typo, never ignored");

  const badName = tmp();
  fs.writeFileSync(path.join(badName, MANIFEST_FILE), JSON.stringify({ rfa: 1, name: "Acme Corp", hub: { port: 8790 } }));
  assert.throws(() => loadHubDir(badName), (err: HubDirError) => err.code === "invalid" && /name/.test(err.message));

  const both = tmp();
  fs.writeFileSync(path.join(both, MANIFEST_FILE), JSON.stringify({ rfa: 1, name: "x", hub: { port: 8790, url: "https://h/mcp" } }));
  assert.throws(() => loadHubDir(both), (err: HubDirError) => err.code === "invalid", "a hub is local or remote, never both");
});

test("defaults: a minimal manifest gets every default, and both modes derive their hub URL", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify({ rfa: 1, name: "acme", hub: { port: 8791 } }));
  const h = loadHubDir(root);
  assert.equal(h.mode, "hub");
  assert.equal(h.hubUrl, "http://127.0.0.1:8791/mcp");
  assert.equal(h.manifest.agents.env, "minimal", "v0.4 sect. 6.3 as written is the default");
  assert.equal(h.manifest.agents.max_inflight, 2);
  assert.equal(h.manifest.retention.obs_days, 14);
  assert.equal(h.paths.agents, path.join(root, "agents"));
  assert.equal(h.paths.runtime, path.join(root, ".rfa"));
  assert.equal(h.paths.roomLogs, path.join(root, ".rfa", "data", "rooms"));
  assert.equal(h.paths.gate, path.join(root, "policies", "gate.json"));
  assert.equal(h.paths.backups, path.join(os.homedir(), "Backups", "rfa", "acme"), "<name> expands and ~ is the home directory");

  const remote = tmp();
  fs.writeFileSync(path.join(remote, MANIFEST_FILE), JSON.stringify({ rfa: 1, name: "laptop", hub: { url: "https://rfa.acme.example/mcp" } }));
  const r = loadHubDir(remote);
  assert.equal(r.mode, "remote");
  assert.equal(r.hubUrl, "https://rfa.acme.example/mcp");
  assert.equal(r.paths.gate, null, "a remote-hub directory runs no gate: it runs no hub");
  assert.equal(hubUrlFor(r.manifest), r.hubUrl);
});

test("a pre-0.7 checkout is recognized and the error says to migrate", () => {
  const legacy = tmp();
  fs.mkdirSync(path.join(legacy, "data", "rooms"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "dogfood", "state"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "dogfood", "ROOM.md"), "# room\n- Room: `r_0123456789`\n- Join secret: `js_x`\n");
  const found = detectLegacyLayout(legacy);
  assert.ok(found);
  assert.deepEqual(found.found.sort(), ["data/", "dogfood/ROOM.md", "dogfood/state/"].sort());
  assert.throws(() => requireHubDir({ env: {}, cwd: legacy }), (err: HubDirError) => err.code === "legacy" && /rfa migrate/.test(err.hint));
  assert.equal(detectLegacyLayout(tmp()), null, "an empty directory is not a legacy layout");
  const agentsOnly = tmp();
  fs.mkdirSync(path.join(agentsOnly, "agents"));
  assert.equal(detectLegacyLayout(agentsOnly), null, "a bare agents/ is not enough: a hub directory has one too");
});

test("maybeHubDir: bare when nothing names a directory, strict when something does", () => {
  assert.equal(maybeHubDir({ env: {}, cwd: tmp() }), null);
  const named = tmp();
  assert.throws(() => maybeHubDir({ dir: named }), (err: HubDirError) => err.code === "not_found", "an explicit --dir that is not a hub directory is an error, not bare mode");
  assert.throws(() => maybeHubDir({ env: { RFA_DIR: named }, cwd: tmp() }), (err: HubDirError) => err.code === "not_found");
  const root = hubAt(path.join(tmp(), "h"));
  assert.equal(maybeHubDir({ env: {}, cwd: root })?.root, root);
});

test("JsonStore writes atomically at 0600, leaves no temp file, and update() round-trips", () => {
  const root = hubAt(path.join(tmp(), "h"));
  const h = loadHubDir(root);
  ensureRuntime(h);
  assert.equal(fs.statSync(h.paths.runtime).mode & 0o777, 0o700, ".rfa is 0700: it holds the credential files");
  const rooms = roomsStore(h);
  assert.equal(rooms.exists(), false);
  assert.deepEqual(rooms.read(), { version: 1, rooms: [] }, "a missing file reads as empty");
  rooms.update((f) => {
    f.rooms.push({ alias: "product", handle: "r_0123456789", topic: "t", join_secret: null, operator: null, created_at: "2026-08-22T00:00:00Z" });
  });
  assert.equal(fs.statSync(h.paths.rooms).mode & 0o777, 0o600);
  assert.equal(rooms.read().rooms[0].alias, "product");
  assert.deepEqual(fs.readdirSync(h.paths.runtime).filter((f) => f.endsWith(".tmp")), [], "no temp file survives a write");
  // A file that exists and does not parse is an error, never silently the fallback.
  fs.writeFileSync(h.paths.rooms, "{ torn");
  assert.throws(() => rooms.read());
  const store = new JsonStore<{ n: number }>(path.join(h.paths.runtime, "x.json"), () => ({ n: 0 }), 0o644);
  writeJsonAtomic(store.file, { n: 1 }, 0o644);
  assert.equal(store.read().n, 1);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o644);
});

test("no source file outside hubdir.ts joins a path onto an instance directory name", () => {
  /**
   * `scripts/` is walked too, since 2026-08-31, and it was not before.
   * `scripts/watchdog-replay.ts` read `<repo>/data/rooms` and exited "no room
   * logs to replay against" on its first line of work from the day `data/` was
   * removed (2026-08-25) - while STATUS carried "re-run it and ship what is
   * still clean" as an actionable item that could never have run.
   * `scripts/repair-obs-cost.ts` had the same defect. A guard that walks only
   * half the tree finds only half the defects.
   */
  const roots = [path.resolve(import.meta.dirname, "..", "src"), path.resolve(import.meta.dirname, "..", "scripts")];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && entry.name !== "hubdir.ts") {
        const rel = path.relative(path.resolve(import.meta.dirname, ".."), full);
        fs.readFileSync(full, "utf8")
          .split("\n")
          .forEach((line, i) => {
            const flag = (why: string) => offenders.push(`${rel}:${i + 1}: ${why}: ${line.trim()}`);
            // The old shape: a repository root, then fixed instance names joined onto it.
            // A script legitimately resolves its own checkout to spawn a sibling
            // entry (fence-proof, e2e); what none of them may do is join an
            // INSTANCE directory onto it, which the two rules below catch.
            const isScript = full.startsWith(path.resolve(import.meta.dirname, "..", "scripts"));
            if (!isScript && /path\.(join|resolve)\(\s*ROOT\b/.test(line)) flag("joins onto a repository ROOT");
            if (!isScript && /import\.meta\.dirname[^)]*"\.\."\s*\)/.test(line) && entry.name !== "pkg.ts") flag("resolves the repository root");
            if (isScript && /path\.(join|resolve)\(\s*ROOT\s*,\s*["'](data|agents|dogfood)["']/.test(line)) flag("joins an instance directory onto the checkout");
            // Two instance subpaths as consecutive literals is a hard-coded layout (`"data", "runs.db"`).
            if (/["'](agents|data)["'],\s*["']/.test(line)) flag("hard-codes an instance layout");
            // The pre-0.7 directories have no business anywhere but the migration.
            // Scoped to src/: in a script `"deploy"` is a legitimate VALUE (an
            // approval-ext fixture names a `deploy` action), and the script rule
            // above already catches the real defect, which is joining an
            // instance directory onto the checkout.
            if (!isScript && /["'](dogfood|deploy)["']/.test(line) && entry.name !== "migrate.ts") flag("names a pre-0.7 directory");
          });
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], "every instance path goes through src/hubdir.ts");
});

test("manifest gateways: the operator's infrastructure processes, validated and defaulted", async () => {
  const { manifestSchema } = await import("../src/hubdir.js");
  const base = { rfa: 1, name: "x", hub: { port: 8790 } };
  // absent -> empty record, never undefined (the supervisor iterates it unconditionally)
  assert.deepEqual(manifestSchema.parse(base).gateways, {});
  // the measured case: a node process with env secrets by NAME
  const m = manifestSchema.parse({
    ...base,
    gateways: { "db-gateway": { command: "node", args: ["gateways/db-gateway.mjs"], env_secrets: ["AURORA_RO_URL"], cwd: "gateways" } },
  });
  assert.equal(m.gateways["db-gateway"].command, "node");
  assert.deepEqual(m.gateways["db-gateway"].env, {}, "env defaults to empty");
  // a name outside the grammar is refused, same rule as mcp_servers names
  assert.throws(() => manifestSchema.parse({ ...base, gateways: { "Bad Name": { command: "x" } } }));
  // values never sit in the manifest: env is k=v strings the operator chose to
  // write, env_secrets are NAMES - there is no field for a secret VALUE
  assert.throws(() => manifestSchema.parse({ ...base, gateways: { g: { command: "x", secrets: { KEY: "value" } } } }), /unrecognized|strict/i);
});
