/**
 * Rung 4: the instruments and the operator duties over a hub directory with
 * nothing running: knowledge sources, the offline chain verifier, backup and
 * restore, and the service units rendered without installing anything.
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { before, test } from "node:test";
import { loadHubDir, secretsStore, type HubDir } from "../src/hubdir.js";
import { nodeArgsFor } from "../src/proc.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "src", "cli", "main.ts");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
let dir: string;
function rfa(args: string[], cwd = dir): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [...nodeArgsFor(CLI), ...args],
      { cwd, env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end();
  });
}
const json = <T>(r: Run): T => JSON.parse(r.stdout) as T;

let h: HubDir;
let roomHandle: string;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-inst-"));
  const r = await rfa(["init", "--yes", "--no-start", "--name", "inst", "--port", String(await freePort()), "--human", "paul", "--agent", "none", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  h = loadHubDir(dir);
  const room = await rfa(["room", "create", "product", "--topic", "the product room", "--json"]);
  assert.equal(room.code, 0, room.stderr);
  roomHandle = json<{ handle: string }>(room).handle;
  // Two human injections so the log has links to verify: a fresh room holds one roster event,
  // and a chain of one event checks its genesis link and nothing else.
  for (const text of ["first", "second"]) {
    const inj = await rfa(["room", "inject", "product", text, "--json"]);
    assert.equal(inj.code, 0, inj.stderr);
  }
});

test("knowledge add attaches a directory as pack-relative globs; status counts the files and flags a page that exists twice", async () => {
  const made = await rfa(["agent", "new", "scribe", "--kind", "answerer", "--json"]);
  assert.equal(made.code, 0, made.stderr);
  const docsA = path.join(dir, "docs-a");
  const docsB = path.join(dir, "docs-b", "nested");
  fs.mkdirSync(docsA, { recursive: true });
  fs.mkdirSync(docsB, { recursive: true });
  fs.writeFileSync(path.join(docsA, "fees.md"), "# Fees\n1 % per year.\n");
  fs.writeFileSync(path.join(docsA, "plans.md"), "# Plans\n");
  fs.writeFileSync(path.join(docsB, "fees.md"), "# Fees (old copy)\n");

  const added = await rfa(["knowledge", "add", "scribe", docsA, "--json"]);
  assert.equal(added.code, 0, added.stderr);
  const a = json<{ globs: string[]; files: number; definition_changed: boolean }>(added);
  assert.equal(a.files, 2);
  assert.ok(a.definition_changed);
  assert.ok(a.globs.every((g) => g.startsWith("../../docs-a/")), `globs are relative to the pack, got ${a.globs.join(" ")}`);
  const agentMd = fs.readFileSync(path.join(h.paths.agents, "scribe", "agent.md"), "utf8");
  assert.match(agentMd, /knowledge:\n  # Globs are relative to this directory[^\n]*\n  - "knowledge\/\*\*\/\*\.md"\n  - "\.\.\/\.\.\/docs-a\/\*\*\/\*\.md"\n  - "\.\.\/\.\.\/docs-a\/\*\*\/\*\.mdx"/, "the new globs join the scaffold's own, quoted, under the scaffold's reason for the block, in agent.md");

  const again = await rfa(["knowledge", "add", "scribe", docsA, "--json"]);
  assert.equal(json<{ definition_changed: boolean }>(again).definition_changed, false, "attaching the same source twice changes nothing");

  const addedB = await rfa(["knowledge", "add", "scribe", path.join(dir, "docs-b"), "--json"]);
  assert.equal(addedB.code, 0, addedB.stderr);
  const status = await rfa(["knowledge", "status", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  const s = json<{ agents: { pack: string; files: number; duplicates: { name: string; paths: string[] }[] }[] }>(status).agents.find((x) => x.pack === "scribe")!;
  assert.equal(s.files, 3);
  assert.deepEqual(s.duplicates.map((d) => d.name), ["fees.md"], "the same page from two sources is the one-fact-one-file rule broken");
  assert.equal(s.duplicates[0].paths.length, 2);

  const missing = await rfa(["knowledge", "add", "scribe", path.join(dir, "nowhere")]);
  assert.equal(missing.code, 2);
  const noPack = await rfa(["knowledge", "add", "ghost", docsA]);
  assert.equal(noPack.code, 2);
  assert.match(noPack.stderr, /no agent named ghost/);
});

test("log verify: the room's own log is intact; a tampered copy diverges and exits 1; a chainless file is NOT-CHAINED, not intact", async () => {
  const ok = await rfa(["log", "verify", "--json"]);
  assert.equal(ok.code, 0, ok.stderr);
  const reports = json<{ reports: { handle: string; verdict: string; linksChecked: number }[] }>(ok).reports;
  const mine = reports.find((r) => r.handle === roomHandle);
  assert.ok(mine, "every room log in .rfa/data/rooms is verified when no room is named");
  assert.equal(mine.verdict, "INTACT");
  assert.ok(mine.linksChecked >= 1, "intact means links were actually checked");
  const named = await rfa(["log", "verify", "product"]);
  assert.equal(named.code, 0, named.stderr);
  assert.match(named.stdout, /INTACT/);
  assert.match(named.stdout, /genesis link matches/);

  // A copy with one byte of one event changed: the chain must say so, and say where.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-logs-"));
  const src = path.join(h.paths.roomLogs, `${roomHandle}.ndjson`);
  const lines = fs.readFileSync(src, "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, "the room log has at least two events");
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  first.ts = "1999-01-01T00:00:00.000Z";
  lines[0] = JSON.stringify(first);
  const tampered = path.join(scratch, `${roomHandle}.ndjson`);
  fs.writeFileSync(tampered, lines.join("\n") + "\n");
  const bad = await rfa(["log", "verify", "--file", tampered]);
  assert.equal(bad.code, 1, "a divergence is an exit 1 so the verifier can gate something");
  assert.match(bad.stdout, /DIVERGED/);
  assert.match(bad.stdout, /BREAK at seq/);

  // A log with no chain at all: nothing verified, and the verdict says so instead of a green light.
  const plain = path.join(scratch, "r_legacy.ndjson");
  fs.writeFileSync(plain, lines.map((l) => {
    const e = JSON.parse(l) as Record<string, unknown>;
    delete e.prev_hash;
    delete e.hash;
    return JSON.stringify(e);
  }).join("\n") + "\n");
  const legacy = await rfa(["log", "verify", "--file", plain]);
  assert.equal(legacy.code, 0);
  assert.match(legacy.stdout, /NOT-CHAINED/);
  assert.match(legacy.stdout, /carry no chain to verify/);
  fs.rmSync(scratch, { recursive: true, force: true });

  const unknown = await rfa(["log", "verify", "nosuchroom"]);
  assert.equal(unknown.code, 2);
});

test("backup now writes the plan's archive outside the directory; restore refuses without --yes, then puts a deleted runtime file back after a safety backup", async () => {
  const backups = path.join(dir, "..", `rfa-inst-backups-${path.basename(dir)}`);
  const set = await rfa(["config", "set", "retention.backup_dir", backups]);
  assert.equal(set.code, 0, set.stderr);
  h = loadHubDir(dir);
  assert.equal(h.paths.backups, backups);

  const now = await rfa(["backup", "now", "--json"]);
  assert.equal(now.code, 0, now.stderr);
  const b = json<{ dest: string; files: string[]; kept: string[] }>(now);
  const day = path.basename(b.dest);
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(fs.existsSync(path.join(b.dest, "dirs.tar.gz")), "the archive of room logs, supervisor state and runtime files");
  const ls = await rfa(["backup", "ls", "--json"]);
  assert.equal(json<{ backups: { day: string }[] }>(ls).backups.map((x) => x.day).join(","), day);

  const roomsFile = h.paths.rooms;
  const before = fs.readFileSync(roomsFile, "utf8");
  fs.rmSync(roomsFile);
  const dry = await rfa(["backup", "restore", day, "--dry-run", "--json"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(json<{ plan: { archiveEntries: number } }>(dry).plan.archiveEntries >= 3, "rooms.json, secrets.json, the room log: all in the archive");
  assert.ok(!fs.existsSync(roomsFile), "a dry run restores nothing");

  const refused = await rfa(["backup", "restore", day]);
  assert.equal(refused.code, 2, "no prompt can be shown on a pipe, so --yes is required");
  assert.ok(!fs.existsSync(roomsFile));

  const restored = await rfa(["backup", "restore", day, "--yes", "--json"]);
  assert.equal(restored.code, 0, restored.stderr);
  assert.equal(fs.readFileSync(roomsFile, "utf8"), before, "the runtime file is back, byte for byte");
  const safety = json<{ safety_backup: string }>(restored).safety_backup;
  assert.match(path.basename(safety), /^pre-restore-/);
  assert.ok(fs.existsSync(path.join(safety, "dirs.tar.gz")), "what was there before the restore is kept");
  fs.rmSync(backups, { recursive: true, force: true });
});

test("service install --print renders both units for launchd and systemd, naming the directory and never a secret", async () => {
  const token = secretsStore(h).read().RFA_TOKEN;
  assert.ok(token, "the operator bearer exists in secrets.json");
  const mac = await rfa(["service", "install", "--print", "--platform", "darwin"]);
  assert.equal(mac.code, 0, mac.stderr);
  assert.match(mac.stdout, /rfa\.inst\.hub\.plist/);
  assert.match(mac.stdout, /rfa\.inst\.supervisor\.plist/);
  assert.match(mac.stdout, /<string>rfa\.inst\.hub<\/string>/);
  assert.ok(mac.stdout.includes(`'hub' 'run' '--dir' '${fs.realpathSync(h.root)}'`), `the unit runs the same foreground entry rfa up daemonizes, for this directory:\n${mac.stdout}`);
  assert.ok(mac.stdout.includes("StandardOutPath"));
  assert.ok(!mac.stdout.includes(token!), "a unit file is world-readable; the bearer stays in secrets.json");

  const linux = await rfa(["service", "install", "--print", "--platform", "linux"]);
  assert.equal(linux.code, 0, linux.stderr);
  assert.match(linux.stdout, /rfa-inst-hub\.service/);
  assert.match(linux.stdout, /\[Service\]/);
  assert.match(linux.stdout, /WorkingDirectory=/);
  assert.ok(!linux.stdout.includes(token!));

  const unsupported = await rfa(["service", "install", "--print", "--platform", "win32"]);
  assert.equal(unsupported.code, 2);

  const status = await rfa(["service", "status", "--platform", process.platform === "linux" ? "linux" : "darwin", "--json"]);
  assert.equal(status.code, 0, status.stderr);
  const units = json<{ units: { id: string; installed: boolean }[] }>(status).units;
  assert.deepEqual(units.map((u) => u.id), ["hub", "supervisor"]);
  assert.ok(units.every((u) => !u.installed), "nothing was installed by --print");
});

test("evals ls ignores the scaffold's example case (a placeholder that runs fails the gate), and promote refuses an unlinked conversation", async () => {
  const ls = await rfa(["evals", "ls", "--json"]);
  assert.equal(ls.code, 0, ls.stderr);
  const cases = json<{ cases: { id: string; kind: string; where: string }[] }>(ls).cases;
  // The seeded corpus is one ACTIVE case: the concurrent pair ships as
  // case.yaml.example, so a fresh hub's gate needs no room and no credential.
  assert.deepEqual(cases.map((c) => c.id), ["protocol-ask-cycle"], "only the active case rfa init seeded from templates/evals");
  assert.ok(!cases.some((c) => c.where.includes("agents/")), "an answerer's scaffolded case is an example the runner ignores: a placeholder that runs fails the gate by construction");
  assert.ok(fs.existsSync(path.join(h.paths.agents, "scribe", "evals", "cases", "scribe-01", "case.yaml.example")), "the template is there to edit into a real case");
  const nothing = await rfa(["evals", "promote", "product", "--conversation", "c_none", "--id", "c1"]);
  assert.equal(nothing.code, 1, "nothing linked to that conversation is an error, not an empty case");
  assert.match(nothing.stderr, /nothing linked to c_none/);
});
