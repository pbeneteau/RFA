/**
 * The `rfa` command line (RFA-0.7 sect. 3 and 5): routing, help, the JSON
 * shapes and exit codes, and a real non-interactive `init` into a temp
 * directory with nothing started, followed by the commands that read it.
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadHubDir, principalsStore, roomsStore, secretsStore, tokensStore } from "../src/hubdir.js";
import { matchDigest } from "../src/credentials.js";
import { PrincipalSet } from "../src/principals.js";
import { Router, type CommandDef } from "../src/cli/router.js";
import { Ui, visibleLength } from "../src/cli/ui.js";
import { nodeArgsFor } from "../src/proc.js";
import * as net from "node:net";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "src", "cli", "main.ts");
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "rfa-cli-"));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
function rfa(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...nodeArgsFor(CLI), ...args],
      { cwd: opts.cwd ?? ROOT, env: { ...process.env, RFA_DIR: "", NO_COLOR: "1", ...(opts.env ?? {}) }, encoding: "utf8", timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const noop: CommandDef["run"] = async () => {};

test("router: command words skip global options and their values, and stop at a command's own option", () => {
  assert.deepEqual(Router.commandWords(["--dir", "x", "agent", "new", "foo", "--kind", "tool"]), ["agent", "new"]);
  assert.deepEqual(Router.commandWords(["status", "--json"]), ["status"]);
  assert.deepEqual(Router.commandWords(["--json", "--dir=/x", "room", "create", "p"]), ["room", "create"]);
  assert.deepEqual(Router.commandWords(["--unknown", "value", "status"]), [], "an unknown option before the command ends the scan");
  const r = new Router();
  r.register({ path: ["agent"], summary: "g", run: noop }, { path: ["agent", "new"], summary: "n", run: noop }, { path: ["status"], summary: "s", run: noop });
  assert.equal(r.find(["agent", "new", "foo"])?.def.path.join(" "), "agent new", "the two-word path wins over the group");
  assert.deepEqual(r.find(["--dir", "x", "agent", "new", "foo", "--kind", "tool"])?.rest, ["--dir", "x", "foo", "--kind", "tool"]);
  assert.equal(r.find(["nothing"]), null);
});

test("router: strict parsing names an unknown option and the usage", () => {
  const r = new Router();
  const def: CommandDef = { path: ["x"], summary: "x", usage: "<name> [--kind k]", options: { kind: { type: "string" } }, run: noop };
  r.register(def);
  const parsed = r.parse(def, ["foo", "--kind", "tool", "--json"]);
  assert.deepEqual(parsed.positionals, ["foo"]);
  assert.equal(parsed.values.kind, "tool");
  assert.equal(parsed.values.json, true);
  assert.throws(() => r.parse(def, ["--bogus"]), (e: Error & { usage?: string }) => /unknown option/.test(e.message) && e.usage === "rfa x <name> [--kind k]");
  const help = r.help(["x"]);
  assert.ok(help.includes("rfa x <name> [--kind k]") && help.includes("--kind"));
});

test("ui: tables align on visible width, ignoring color codes", () => {
  const lines: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    const ui = new Ui({ color: true, json: false, quiet: false, tty: false });
    ui.table([
      [ui.good("●"), "pm", "$0.31"],
      [ui.dim("○"), "linear-scribe", "$12.00"],
    ], { align: ["l", "l", "r"] });
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.equal(plain.length, 2);
  assert.equal(plain[0].indexOf("$"), plain[1].indexOf("$") + 1, "the dollar column is right-aligned");
  assert.equal(visibleLength("\x1b[32m●\x1b[0m"), 1);
});

test("a spinner on a pipe prints a line per CHANGE, never a line per poll", () => {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const ui = new Ui({ color: false, json: false, quiet: false, tty: false });
    const sp = ui.spinner("waiting for an answer");
    sp.update("waiting for an answer"); // the ask's approval watch re-affirms every 3s
    sp.update("waiting for an answer");
    sp.update("pm-agent is waiting for YOUR decision");
    sp.update("pm-agent is waiting for YOUR decision");
    sp.stop({ ok: true, text: "answered" });
  } finally {
    process.stdout.write = write;
  }
  const spins = lines.filter((l) => l.includes("◐"));
  assert.equal(spins.length, 2, `the start line and the one real change, not one per poll: ${JSON.stringify(spins)}`);
  assert.ok(spins[1].includes("YOUR decision"));
});

test("a bare group is its own listing, a typo a real guess, a wrong flag one clean line (JSON included), a NaN port refused", async () => {
  const group = await rfa(["agent"]);
  assert.equal(group.code, 2, "nothing ran");
  assert.ok(group.stdout.includes("rfa agent new") && group.stdout.includes("rfa agent retire"), "the group's own listing, on stdout, never a typo guess");
  assert.ok(!(group.stdout + group.stderr).includes("did you mean"));
  const typo = await rfa(["agnet", "restrt"]);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /did you mean: rfa agent restart/);
  assert.ok(!typo.stderr.includes("evals flag"), "fuzzysort 4 scores in [0,1]: the old negative threshold accepted every candidate and this guess with it");
  const flag = await rfa(["version", "--bogus"]);
  assert.equal(flag.code, 2);
  assert.ok(flag.stderr.includes("unknown option --bogus") && !flag.stderr.includes("positional"), `one clean line, not Node's whole paragraph: ${flag.stderr}`);
  const j = await rfa(["version", "--bogus", "--json"]);
  assert.equal(j.code, 2);
  const parsed = JSON.parse(j.stdout) as { error: string; exit: number };
  assert.equal(parsed.exit, 2);
  assert.match(parsed.error, /unknown option --bogus/, "a script that asked for JSON gets its error as JSON, usage errors included");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-badport-"));
  const port = await rfa(["init", "--yes", "--no-start", "--agent", "none", "--port", "abc"], { cwd: tmp });
  assert.equal(port.code, 2);
  assert.match(port.stderr, /--port takes a whole number from 1 to 65535/);
  assert.ok(!fs.existsSync(path.join(tmp, "rfa.json")), "refused at the door: nothing was written");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("rfa --help lists the groups; an unknown command exits 2 with a guess; bare rfa on a pipe is the help, never the dashboard", async () => {
  const help = await rfa(["--help"]);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("init") && help.stdout.includes("Global flags"));
  const bare = await rfa([]);
  assert.equal(bare.code, 0);
  assert.ok(bare.stdout.includes("Commands:") && bare.stdout.includes("dashboard"), "on a pipe the front door is the help");
  const unknown = await rfa(["frobnicate"]);
  assert.equal(unknown.code, 2);
  const typo = await rfa(["agnet", "restrt", "pm"]);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /did you mean: rfa agent restart/);
  const zsh = await rfa(["completion", "zsh"]);
  assert.equal(zsh.code, 0);
  assert.ok(zsh.stdout.includes("#compdef rfa") && zsh.stdout.includes("rfa __complete"), "the script defers to the CLI at every tab");
  const fish = await rfa(["completion", "fish"]);
  assert.ok(fish.stdout.includes("complete -c rfa"));
  const groups = await rfa(["__complete", "--", ""]);
  assert.ok(groups.stdout.includes("agent:") && groups.stdout.includes("dashboard:"), "top-level candidates carry descriptions for zsh");
  const dash = await rfa(["dashboard"]);
  assert.equal(dash.code, 2, "the dashboard refuses a pipe and names rfa status --json");
  assert.match(dash.stderr, /needs a terminal/);
  const v = await rfa(["version", "--json"]);
  assert.equal(v.code, 0);
  const parsed = JSON.parse(v.stdout) as { protocol: string; manifest: number };
  assert.equal(parsed.protocol, "0.1.8");
  assert.equal(parsed.manifest, 1);
});

test("outside a hub directory, a command that needs one exits 3 and names rfa init", async () => {
  const r = await rfa(["status"], { cwd: tmp() });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /rfa init/);
});

test("rfa init --yes --no-start provisions a directory in process: manifest, hashed credentials, rooms, a pack; re-running rotates nothing", async () => {
  const dir = tmp();
  const port = await freePort();
  const r = await rfa(["init", "--yes", "--no-start", "--name", "clitest", "--port", String(port), "--human", "tester", "--agent", "spec-expert", "--room", "product", "--json"], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { dir: string; agent: string; room: string; started: boolean; human_key: string };
  assert.equal(out.agent, "spec-expert");
  assert.match(out.room, /^r_/);
  assert.equal(out.started, false);
  assert.match(out.human_key, /^hk_/);

  const h = loadHubDir(dir);
  assert.equal(h.manifest.name, "clitest");
  assert.equal(fs.statSync(h.paths.runtime).mode & 0o777, 0o700);
  const secrets = secretsStore(h).read();
  assert.equal(secrets.RFA_HUMAN_KEY, out.human_key, "the CLI keeps the operator's own key");
  assert.match(secrets.RFA_TOKEN, /^tok_/);
  const tokens = tokensStore(h).read().tokens;
  assert.equal(matchDigest(secrets.RFA_TOKEN, tokens)?.label, "operator");
  assert.ok(!JSON.stringify(tokens).includes(secrets.RFA_TOKEN), "hashed at rest");
  const principals = principalsStore(h).read().principals;
  assert.equal(principals[0].label, "tester");
  assert.ok(PrincipalSet.fromRecords(principals).match(out.human_key));
  assert.ok(!JSON.stringify(principals).includes(out.human_key));
  const rooms = roomsStore(h).read().rooms;
  assert.deepEqual(rooms.map((x) => x.alias).sort(), ["ops", "product"]);
  for (const room of rooms) {
    assert.equal(room.operator?.host, true, "the operator hosts every room the CLI created");
    assert.equal(room.operator?.name, "tester");
    const meta = JSON.parse(fs.readFileSync(path.join(h.paths.roomLogs, `${room.handle}.meta.json`), "utf8")) as { policies: { join_bearer_sha256?: string[]; history_visibility: string } };
    assert.ok(meta.policies.join_bearer_sha256?.length === 1, "the operator bearer is allowed in at create");
    assert.equal(meta.policies.history_visibility, "joined_after");
  }
  const agentMd = fs.readFileSync(path.join(h.paths.agents, "spec-expert", "agent.md"), "utf8");
  assert.ok(agentMd.includes(`room: ${out.room}`), "the pack is bound to the room by handle");
  assert.ok(agentMd.includes("secrets: [RFA_TOKEN]"), "no join secret is declared or needed");
  assert.ok(fs.existsSync(path.join(h.paths.agents, "spec-expert", "knowledge", "RFA-0.1.md")), "spec-expert carries the spec");
  assert.ok(fs.existsSync(h.paths.gate) && fs.existsSync(h.paths.gitignore));

  // Idempotent: nothing rotates, nothing duplicates.
  const again = await rfa(["init", "--yes", "--no-start", "--json"], { cwd: dir });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(JSON.parse(again.stdout).human_key, null, "no key minted the second time");
  assert.equal(secretsStore(h).read().RFA_TOKEN, secrets.RFA_TOKEN);
  assert.equal(roomsStore(h).read().rooms.length, 2);

  // The readers, with nothing running.
  const st = await rfa(["status", "--json"], { cwd: dir });
  assert.equal(st.code, 0, st.stderr);
  const status = JSON.parse(st.stdout) as { hub: { running: boolean; healthy: boolean }; agents: { name: string }[]; rooms: { alias: string }[]; rooms_source: string };
  assert.equal(status.hub.running, false);
  assert.equal(status.agents[0].name, "spec-expert");
  assert.equal(status.rooms_source, "file");
  const doc = await rfa(["doctor", "--json"], { cwd: dir });
  const checks = JSON.parse(doc.stdout) as { id: string; verdict: string }[];
  const byId = Object.fromEntries(checks.map((c) => [c.id, c.verdict]));
  assert.equal(byId["hub-directory"], "ok");
  assert.equal(byId["operator-token"], "ok");
  assert.equal(byId["human-key"], "ok");
  assert.equal(byId["gate"], "ok");
  assert.equal(byId["pack-spec-expert"], "ok", JSON.stringify(checks.find((c) => c.id === "pack-spec-expert")));
  assert.equal(byId["room-product"], "ok");
  assert.equal(byId["hub"], "warn", "not running is a warning, not a failure");
  const down = await rfa(["down"], { cwd: dir });
  assert.equal(down.code, 0);
  assert.match(down.stdout, /was not running/);
});

test("rfa init refuses a pre-0.7 checkout and points at migrate; rfa docs hands out the interop guide", async () => {
  const legacy = tmp();
  fs.mkdirSync(path.join(legacy, "data"));
  const r = await rfa(["init", "--yes", "--no-start"], { cwd: legacy });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /rfa migrate/);
  const d = await rfa(["docs", "interop", "--path"]);
  assert.equal(d.code, 0);
  assert.ok(d.stdout.trim().endsWith("INTEROP.md"));
});
