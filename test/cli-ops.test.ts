/**
 * The rung-2 commands against a directory with nothing running: rooms, packs,
 * bearers, humans, secrets and config, every mutation through the hub's own
 * verbs in process (src/cli/hubaccess.ts) and every file through src/hubdir.ts.
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { before, test } from "node:test";
import { matchDigest } from "../src/credentials.js";
import { loadHubDir, principalsStore, roomsStore, secretsStore, tokensStore, type HubDir } from "../src/hubdir.js";
import { PrincipalSet } from "../src/principals.js";
import { nodeArgsFor } from "../src/proc.js";
import { roomsBlock, setRoomsBlock } from "../src/cli/agentmd.js";

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
function rfa(args: string[], opts: { stdin?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [...nodeArgsFor(CLI), ...args],
      { cwd: dir, env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}
const json = <T>(r: Run): T => JSON.parse(r.stdout) as T;

let h: HubDir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-ops-"));
  const r = await rfa(["init", "--yes", "--no-start", "--name", "ops", "--port", String(await freePort()), "--human", "paul", "--agent", "none", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  h = loadHubDir(dir);
});

test("agentmd: the rooms block is replaced in place, the scaffold placeholder removed, everything else kept byte for byte", () => {
  const scaffolded = `---\nrfa_agent: 1\nname: x\ndescription: d\n# No room binding yet, so this pack loads but never serves. Bind it:\n#   rfa agent bind <name> --room <alias>\n# rooms:\n#   - room: r_XXXXXXXXXX\n#     role: participant\n---\nprompt\n`;
  const bound = setRoomsBlock(scaffolded, roomsBlock("r_0123456789"));
  assert.ok(bound.includes("rooms:\n  - room: r_0123456789\n    role: participant"));
  assert.ok(!bound.includes("# rooms:"), "the placeholder is gone");
  assert.ok(bound.startsWith("---\nrfa_agent: 1\nname: x\ndescription: d\n"));
  assert.ok(bound.endsWith("---\nprompt\n"));
  const rebound = setRoomsBlock(bound, roomsBlock("r_abcdefabcd", { role: "observer", serve: false }));
  assert.ok(rebound.includes("room: r_abcdefabcd") && !rebound.includes("r_0123456789"));
  assert.ok(rebound.includes("role: observer") && rebound.includes("serve: false"));
  const withTrailing = `---\nname: x\nrooms:\n  - room: r_1\n    role: participant\nbudgets:\n  max_turns: 8\n---\nbody\n`;
  const kept = setRoomsBlock(withTrailing, roomsBlock("r_2"));
  assert.ok(kept.includes("budgets:\n  max_turns: 8"), "a key after the block survives");
  assert.equal((kept.match(/^rooms:/gm) ?? []).length, 1);
});

test("room create (in process) hosts the room, admits the operator bearer, records alias and membership; ls and show read it", async () => {
  const c = await rfa(["room", "create", "product", "--topic", "product questions", "--history", "member", "--json"]);
  assert.equal(c.code, 0, c.stderr);
  const created = json<{ alias: string; handle: string }>(c);
  const rec = roomsStore(h).read().rooms.find((r) => r.alias === "product")!;
  assert.equal(rec.handle, created.handle);
  assert.equal(rec.operator?.host, true);
  const meta = JSON.parse(fs.readFileSync(path.join(h.paths.roomLogs, `${rec.handle}.meta.json`), "utf8")) as { policies: { join_bearer_sha256?: string[]; history_visibility: string } };
  assert.equal(meta.policies.history_visibility, "member");
  assert.equal(meta.policies.join_bearer_sha256?.length, 1);
  const dup = await rfa(["room", "create", "product"]);
  assert.equal(dup.code, 2, "an alias is unique");
  const ls = await rfa(["room", "ls", "--json"]);
  const listed = json<{ source: string; rooms: { alias: string }[] }>(ls);
  assert.equal(listed.source, "snapshot", "nothing runs, so the snapshots are read");
  assert.deepEqual(listed.rooms.map((r) => r.alias).sort(), ["ops", "product"]);
  const show = await rfa(["room", "show", "product", "--json"]);
  assert.equal(show.code, 0, show.stderr);
  const view = json<{ handle: string; policies: { history_visibility: string }; roster: { name: string; role: string }[]; operator: { host: boolean } }>(show);
  assert.equal(view.handle, rec.handle);
  assert.equal(view.policies.history_visibility, "member");
  assert.ok(view.roster.some((m) => m.name === "paul"), "the operator's own membership is in the roster");
  const secret = await rfa(["room", "secret", "show", "product"]);
  assert.equal(secret.stdout.trim(), rec.join_secret);
  const pol = await rfa(["room", "policy", "product", "set", "max_members=8", "attention=all"]);
  assert.equal(pol.code, 0, pol.stderr);
  const meta2 = JSON.parse(fs.readFileSync(path.join(h.paths.roomLogs, `${rec.handle}.meta.json`), "utf8")) as { policies: { max_members: number; attention: string } };
  assert.equal(meta2.policies.max_members, 8);
  assert.equal(meta2.policies.attention, "all");
});

test("tokens: mint is hashed and shown once, room allow lists the digest, revoke removes it and disallow tidies the room", async () => {
  const mint = await rfa(["token", "mint", "laptop", "--kind", "client", "--expires", "30d", "--json"]);
  assert.equal(mint.code, 0, mint.stderr);
  const minted = json<{ token: string; id: string; kind: string; expires_at: string }>(mint);
  assert.match(minted.token, /^cli_/);
  const tokens = tokensStore(h).read().tokens;
  assert.equal(matchDigest(minted.token, tokens)?.label, "laptop");
  assert.ok(!JSON.stringify(tokens).includes(minted.token));
  const allow = await rfa(["room", "allow", "product", "--token", "laptop"]);
  assert.equal(allow.code, 0, allow.stderr);
  const rec = roomsStore(h).read().rooms.find((r) => r.alias === "product")!;
  const meta = () => JSON.parse(fs.readFileSync(path.join(h.paths.roomLogs, `${rec.handle}.meta.json`), "utf8")) as { policies: { join_bearer_sha256?: string[] } };
  assert.equal(meta().policies.join_bearer_sha256?.length, 2, "operator plus laptop");
  assert.ok(tokensStore(h).read().tokens.find((t) => t.label === "laptop")?.rooms?.includes(rec.handle));
  const dup = await rfa(["token", "mint", "laptop"]);
  assert.equal(dup.code, 2);
  const dis = await rfa(["room", "disallow", "product", "--token", "laptop"]);
  assert.equal(dis.code, 0, dis.stderr);
  assert.equal(meta().policies.join_bearer_sha256?.length, 1);
  const rev = await rfa(["token", "revoke", "laptop"]);
  assert.equal(rev.code, 0, rev.stderr);
  assert.equal(matchDigest(minted.token, tokensStore(h).read().tokens), null, "revoked: matches nothing");
  const op = await rfa(["token", "revoke", "operator"]);
  assert.equal(op.code, 2, "the operator bearer is rotated, never revoked");
});

test("humans: add is hashed and shown once, rotate replaces the id and keeps the CLI's own copy, remove refuses the last", async () => {
  const before = principalsStore(h).read().principals.length;
  const add = await rfa(["human", "add", "ana", "--json"]);
  assert.equal(add.code, 0, add.stderr);
  const ana = json<{ id: string; key: string; operator: boolean }>(add);
  assert.equal(ana.operator, false, "the first human (init) is the operator; the second is not");
  const list = principalsStore(h).read().principals;
  assert.equal(list.length, before + 1);
  assert.ok(PrincipalSet.fromRecords(list).match(ana.key));
  assert.ok(!JSON.stringify(list).includes(ana.key));
  const mine = secretsStore(h).read().RFA_HUMAN_KEY;
  const rot = await rfa(["human", "rotate", "paul", "--json"]);
  assert.equal(rot.code, 0, rot.stderr);
  const rotated = json<{ id: string; key: string; operator: boolean }>(rot);
  assert.equal(rotated.operator, true);
  assert.notEqual(secretsStore(h).read().RFA_HUMAN_KEY, mine, "the CLI's own copy rotated with it");
  assert.equal(PrincipalSet.fromRecords(principalsStore(h).read().principals).match(mine!), null, "the old key stops matching");
  const rm = await rfa(["human", "remove", "ana"]);
  assert.equal(rm.code, 0, rm.stderr);
  const last = await rfa(["human", "remove", "paul", "--force"]);
  assert.equal(last.code, 2, "never the last one");
  const ls = await rfa(["human", "ls", "--json"]);
  assert.deepEqual(json<{ label: string; operator: boolean }[]>(ls).map((p) => [p.label, p.operator]), [["paul", true]]);
});

test("secrets and config: values by name from stdin, names only on ls, the manifest through its schema", async () => {
  const set = await rfa(["secrets", "set", "LINEAR_API_KEY", "--stdin"], { stdin: "lin_secret_value\n" });
  assert.equal(set.code, 0, set.stderr);
  assert.equal(secretsStore(h).read().LINEAR_API_KEY, "lin_secret_value");
  const ls = await rfa(["secrets", "ls", "--json"]);
  const listed = json<{ secrets: { name: string; length: number }[] }>(ls);
  assert.ok(listed.secrets.some((s) => s.name === "LINEAR_API_KEY" && s.length === 16));
  assert.ok(!ls.stdout.includes("lin_secret_value"), "never the value");
  const bad = await rfa(["secrets", "set", "lowercase"]);
  assert.equal(bad.code, 2);
  const keep = await rfa(["secrets", "unset", "RFA_TOKEN"]);
  assert.equal(keep.code, 2, "the CLI's own credential is rotated, not unset");
  const unset = await rfa(["secrets", "unset", "LINEAR_API_KEY"]);
  assert.equal(unset.code, 0);
  assert.equal(secretsStore(h).read().LINEAR_API_KEY, undefined);

  const set2 = await rfa(["config", "set", "agents.env", "inherit"]);
  assert.equal(set2.code, 0, set2.stderr);
  assert.equal(loadHubDir(dir).manifest.agents.env, "inherit");
  const get = await rfa(["config", "get", "agents.env"]);
  assert.equal(get.stdout.trim(), "inherit");
  const invalid = await rfa(["config", "set", "hub.port", "notaport"]);
  assert.equal(invalid.code, 2, "the schema refuses it");
  const unknown = await rfa(["config", "set", "retnetion.obs_days", "3"]);
  assert.equal(unknown.code, 2, "an unknown key is a typo, never ignored");
  assert.equal(loadHubDir(dir).manifest.retention.obs_days, 14);
});

test("packs: new binds to the first room, validate checks what the supervisor would, show resolves knowledge, bind rewrites the block, retire archives", async () => {
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "fees.md"), "# Fees\nThe management fee is 0.5% per year.\n");
  const n = await rfa(["agent", "new", "fees", "--kind", "answerer", "--knowledge", "./docs", "--json"]);
  assert.equal(n.code, 0, n.stderr);
  const created = json<{ room: string; skill: string }>(n);
  const product = roomsStore(h).read().rooms.find((r) => r.alias === "product")!;
  assert.equal(created.room, product.handle, "bound to the first non-ops room by default");
  assert.equal(created.skill, "answer-question");
  const reserved = await rfa(["agent", "new", "hub-helper"]);
  assert.equal(reserved.code, 2, "a reserved first token is refused at write time");
  assert.match(reserved.stderr, /reserved/);
  const v = await rfa(["agent", "validate", "--json"]);
  assert.equal(v.code, 0, v.stderr);
  assert.deepEqual(json<{ name: string; ok: boolean }[]>(v), [{ name: "fees", ok: true, problems: [] }]);
  const show = await rfa(["agent", "show", "fees", "--json"]);
  const view = json<{ knowledge: { files: string[] }; binding: { alias: string }; secrets: { declared: string[]; missing: string[] } }>(show);
  assert.ok(view.knowledge.files.some((f) => f.endsWith("docs/fees.md")), `knowledge resolves into the out-of-pack folder: ${view.knowledge.files}`);
  assert.equal(view.binding.alias, "product");
  assert.deepEqual(view.secrets, { declared: ["RFA_TOKEN"], missing: [] });

  const design = await rfa(["room", "create", "design", "--json"]);
  const bind = await rfa(["agent", "bind", "fees", "--room", "design"]);
  assert.equal(bind.code, 0, bind.stderr);
  const agentMd = fs.readFileSync(path.join(h.paths.agents, "fees", "agent.md"), "utf8");
  assert.ok(agentMd.includes(`room: ${json<{ handle: string }>(design).handle}`));
  assert.ok(!agentMd.includes(product.handle));
  const again = await rfa(["agent", "bind", "fees", "--room", "design"]);
  assert.match(again.stdout, /already bound/);

  const tool = await rfa(["agent", "new", "scribe", "--kind", "tool", "--server", "linear", "--command", "rfa server linear", "--tool", "save_document", "--dry-run"]);
  assert.equal(tool.code, 0, tool.stderr);
  assert.ok(tool.stdout.includes("mcp_servers:") && tool.stdout.includes("mcp__linear__save_document"), "a tool user declares the server it brings");
  assert.ok(!fs.existsSync(path.join(h.paths.agents, "scribe")), "dry run writes nothing");

  const ls = await rfa(["agent", "ls", "--json"]);
  assert.deepEqual(json<{ name: string; status: string }[]>(ls).map((a) => [a.name, a.status]), [["fees", "not supervised"]]);

  const dry = await rfa(["agent", "retire", "fees", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(fs.existsSync(path.join(h.paths.agents, "fees", "agent.md")), "a dry run changes nothing");
  const retire = await rfa(["agent", "retire", "fees"]);
  assert.equal(retire.code, 0, retire.stderr);
  assert.ok(!fs.existsSync(path.join(h.paths.agents, "fees", "agent.md")), "the definition is moved aside");
  const archives = fs.readdirSync(h.paths.retired);
  assert.equal(archives.length, 1);
  assert.ok(fs.existsSync(path.join(h.paths.retired, archives[0], "agent.md")));
  const gone = await rfa(["agent", "ls", "--json"]);
  assert.deepEqual(json<unknown[]>(gone), []);
});

test("connect and peer: a client bearer is minted, admitted by hash, printed once; a guest home is refused with the gate named; revoke removes the admission", async () => {
  const c = await rfa(["connect", "mcp", "--room", "product", "--label", "laptop-mcp", "--json"]);
  assert.equal(c.code, 0, c.stderr);
  const conn = json<{ token: string; url: string; rooms: { alias: string; handle: string }[]; config: { mcpServers: { rfa: { url: string; headers: { Authorization: string } } } } }>(c);
  assert.match(conn.token, /^cli_/);
  assert.deepEqual(conn.rooms.map((r) => r.alias), ["product"]);
  assert.equal(conn.config.mcpServers.rfa.headers.Authorization, `Bearer ${conn.token}`);
  assert.ok(conn.url.endsWith("/mcp"));
  const product = roomsStore(h).read().rooms.find((r) => r.alias === "product")!;
  const meta = () => JSON.parse(fs.readFileSync(path.join(h.paths.roomLogs, `${product.handle}.meta.json`), "utf8")) as { policies: { join_bearer_sha256?: string[] } };
  const { tokenDigest } = await import("../src/credentials.js");
  assert.ok(meta().policies.join_bearer_sha256?.includes(tokenDigest(conn.token)), "admitted by hash at the room");
  assert.ok(!JSON.stringify(tokensStore(h).read()).includes(conn.token), "hashed at rest");

  const print = await rfa(["connect", "claude-code", "--print", "--room", "product", "--label", "laptop-cc", "--skill"]);
  assert.equal(print.code, 0, print.stderr);
  assert.ok(print.stdout.includes("claude mcp add --transport http -s user rfa"), "prints the registration command instead of running it");
  assert.ok(fs.existsSync(path.join(dir, ".claude", "skills", "consult-room", "SKILL.md")) && fs.existsSync(path.join(dir, ".claude", "commands", "ask-room.md")));
  const skill = fs.readFileSync(path.join(dir, ".claude", "skills", "consult-room", "SKILL.md"), "utf8");
  assert.ok(skill.includes(product.handle) && !skill.includes("{{"), "the skill carries the handle and no placeholder");
  assert.ok(!skill.includes(conn.token) && !skill.includes("join_secret:"), "no secret in the skill");

  const guest = await rfa(["peer", "add", "orgb-bot", "--home", "orgb.example"]);
  assert.equal(guest.code, 2);
  assert.match(guest.stderr, /gated on a counterparty/);
  const peer = await rfa(["peer", "add", "langchain-vps", "--room", "product", "--expires", "90d", "--json"]);
  assert.equal(peer.code, 0, peer.stderr);
  const p = json<{ token: string; expires_at: string; rooms: { handle: string }[] }>(peer);
  assert.match(p.token, /^peer_/);
  assert.ok(Date.parse(p.expires_at) > Date.now() + 80 * 86_400_000);
  assert.ok(meta().policies.join_bearer_sha256?.includes(tokenDigest(p.token)));
  const ls = await rfa(["peer", "ls", "--json"]);
  assert.deepEqual(json<{ label: string; aliases: string[] }[]>(ls).map((x) => [x.label, x.aliases]), [["langchain-vps", ["product"]]]);
  const rev = await rfa(["peer", "revoke", "langchain-vps"]);
  assert.equal(rev.code, 0, rev.stderr);
  assert.ok(!meta().policies.join_bearer_sha256?.includes(tokenDigest(p.token)), "the room no longer admits the revoked bearer");
  assert.equal(matchDigest(p.token, tokensStore(h).read().tokens), null);
  const expose = await rfa(["hub", "expose", "--tailscale", "--dry-run"]);
  assert.ok(expose.stdout.includes("tailscale serve --bg --https=443"), "the dry run prints the commands and changes nothing");
  assert.equal(loadHubDir(dir).manifest.hub && "port" in loadHubDir(dir).manifest.hub ? (loadHubDir(dir).manifest.hub as { public_url: string | null }).public_url : null, null);
});
