/**
 * The rung-2 commands against a directory with nothing running: rooms, packs,
 * bearers, humans, secrets and config, every mutation through the hub's own
 * verbs in process (src/cli/hubaccess.ts) and every file through src/hubdir.ts.
 */
import { strict as assert } from "node:assert";
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { before, test } from "node:test";
import YAML from "yaml";
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
  assert.equal(created.skill, "answer-fees-question", "name-derived, never the generic colliding id (dogfood F16)");
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

  // rfa agent edit, headless: the flags are the walkthrough's answers, one validated write.
  const edit = await rfa(["agent", "edit", "fees", "--model", "sonnet", "--per-day", "10", "--offer", "answer-fee-question", "--offer-description", "Answers fee questions from the docs, citing the file.", "--json"]);
  assert.equal(edit.code, 0, edit.stderr);
  const edited = json<{ changed: string[]; definition: { before: string; after: string } }>(edit);
  assert.deepEqual(edited.changed, ["model", "capability", "budgets"]);
  assert.notEqual(edited.definition.before, edited.definition.after, "a change rotates the definition");
  const shown = json<{ model: string; budgets: { per_day_usd: number; per_task_usd: number }; card: { skills: { id: string }[] } }>(await rfa(["agent", "show", "fees", "--json"]));
  assert.equal(shown.model, "sonnet");
  assert.equal(shown.budgets.per_day_usd, 10);
  assert.equal(shown.budgets.per_task_usd, 0.25, "a ceiling not named keeps its value");
  assert.equal(shown.card.skills[0].id, "answer-fee-question", "the card follows the definition");
  const same = await rfa(["agent", "edit", "fees", "--model", "sonnet"]);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /unchanged/, "the value it already has is a no-op, not an error");
  const bare = await rfa(["agent", "edit", "fees"]);
  assert.equal(bare.code, 2, "no flags on a pipe is the usage error, never a walkthrough");
  assert.match(bare.stderr, /--model/);
  const badMode = await rfa(["agent", "edit", "fees", "--mode", "plan"]);
  assert.equal(badMode.code, 1);
  assert.match(badMode.stderr, /no acting tool/);
  const more = await rfa(["agent", "edit", "fees", "--knowledge", "./docs", "--json"]);
  assert.equal(more.code, 0, more.stderr);
  assert.deepEqual(json<{ changed: string[] }>(more).changed, [], "the folder was attached at creation: adding it again changes nothing");

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
  assert.ok(fs.existsSync(path.join(h.paths.retired, archives[0], "pack", "knowledge")), "the whole pack folder went with it, not only agent.md");
  assert.ok(!fs.existsSync(path.join(h.paths.agents, "fees")), "the name is free again: a folder left behind blocked rfa agent new on the owner's first retire");
  const gone = await rfa(["agent", "ls", "--json"]);
  assert.deepEqual(json<unknown[]>(gone), [], "a retired pack is gone from the registry");
  const reborn = await rfa(["agent", "new", "fees", "--kind", "answerer", "--json"]);
  assert.equal(reborn.code, 0, reborn.stderr);
  assert.ok(fs.existsSync(path.join(h.paths.agents, "fees", "agent.md")));
  // A folder made by hand, with no definition, is taken over and its files kept.
  fs.mkdirSync(path.join(h.paths.agents, "handmade", "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(h.paths.agents, "handmade", "knowledge", "mine.md"), "# mine\n");
  const took = await rfa(["agent", "new", "handmade", "--kind", "answerer"]);
  assert.equal(took.code, 0, took.stderr);
  assert.match(took.stdout, /taken over/);
  assert.equal(fs.readFileSync(path.join(h.paths.agents, "handmade", "knowledge", "mine.md"), "utf8"), "# mine\n", "the operator's file is untouched");
  const dup = await rfa(["agent", "new", "handmade", "--kind", "answerer"]);
  assert.equal(dup.code, 1, "a folder WITH a definition is still refused");
  const after = await rfa(["agent", "ls", "--json"]);
  assert.deepEqual(json<{ name: string }[]>(after).map((a) => a.name).sort(), ["fees", "handmade"]);
});

test("a fresh hub directory is seeded with a scoreable eval corpus, and never with a baseline", async () => {
  // What is seeded: the judge rubric (whose sha rides every judge row), ONE
  // active replay case that scores with no hub, no model and no credential, and
  // one live concurrent-pair case shipped inert as case.yaml.example. So
  // `rfa evals run` means something on day one without needing money. A BASELINE
  // is deliberately not seeded: it is measured, and the gate's own rule is that
  // one captured while the stack was unhealthy is vacuous.
  assert.ok(fs.existsSync(path.join(dir, "evals", "rubric.md")), "the versioned judge rubric");
  const seeded = path.join(dir, "evals", "cases", "protocol-ask-cycle", "case.yaml");
  assert.ok(fs.existsSync(seeded), "one tenant-neutral replay case over the protocol itself");
  assert.ok(fs.existsSync(path.join(dir, "evals", "cases", "protocol-ask-cycle", "reference.ndjson")), "with the event slice it replays");
  assert.ok(!fs.existsSync(path.join(dir, "evals", "baseline.json")), "no baseline: rfa evals run --update-baseline measures the first one");
  // The other seeded case is live-concurrent - one trial is one simultaneous PAIR
  // of protocol questions, the only shape that can catch two conversations
  // bleeding into each other - and it ships INERT, as case.yaml.example. A live
  // case seeded active would mean a fresh hub's first `rfa evals run` needs a
  // room, a running resident, a credential and money, and with no room it exits 3
  // including under --update-baseline, which is the day-one baseline flow.
  const pairDir = path.join(dir, "evals", "cases", "protocol-concurrent-pair");
  assert.ok(!fs.existsSync(path.join(pairDir, "case.yaml")), "the concurrent pair is NOT active on day one");
  const exampleFile = path.join(pairDir, "case.yaml.example");
  assert.ok(fs.existsSync(exampleFile), "it ships as an example the operator activates by renaming it");
  const raw = fs.readFileSync(exampleFile, "utf8");
  assert.match(raw, /Rename this file to `case\.yaml`/, "the header says what to rename it to");
  assert.match(raw, /8 live[\s#]+answers, roughly 0\.22 dollars/, "and what activating it costs per run");
  const pair = YAML.parse(raw) as { subject_capability: string; asks: { must_mention: string[]; must_not_mention: string[] }[]; trials: number; expect_overlap?: boolean };
  assert.equal(pair.subject_capability, "answer-protocol-question", "the scaffolded spec-expert's capability, so the case resolves once activated");
  assert.equal(pair.asks.length, 2, "a tuple, not an ask");
  assert.equal(pair.trials, 4, "4 trials, because GATE_K is 4: below it the gate can only hold a point estimate");
  assert.equal(pair.expect_overlap, undefined, "unset on purpose: a correct concurrency-1 pack must not fail the gate");
  // The markers a CORRECT answer must survive: the bare word "evidence" fired on
  // ordinary prose ("as evidenced by"), so the forbidden marker is the field name.
  assert.deepEqual(pair.asks[1].must_not_mention, ["evidence_required"], "a forbidden marker must be a token only the sibling's answer can produce");
  // And ask 1 REQUIRES that same field name rather than accepting the bare word as
  // an alternative: its question names the field, and it is what makes ask 2's
  // forbidden token a real detector, since an ask-1 answer that only ever said
  // "evidence" would leave the sibling nothing to be contaminated BY.
  assert.deepEqual(pair.asks[0].must_mention, ["evidence_required", "accept"]);
  assert.match(pair.asks[1].must_mention.join(" "), /card_summary skill_ids/, "and ask 2 demands both, which is what its wording now asks for");
  const ls = await rfa(["evals", "ls", "--json"]);
  assert.equal(ls.code, 0, ls.stderr);
  assert.deepEqual(
    json<{ cases: { id: string; kind: string }[] }>(ls).cases.map((c) => [c.id, c.kind]),
    [["protocol-ask-cycle", "replay"]],
    "so the gate a fresh hub runs is exactly the case that needs nothing live",
  );
});

test("numeric flags are strict, and evals run refuses --json by name: NaN and silence never become behaviour", async () => {
  const t = await rfa(["ask", "x", "--timeout", "abc"]);
  assert.equal(t.code, 2, t.stderr);
  assert.match(t.stderr, /--timeout takes a number of at least 1, not "abc"/, "validated before the hub is even asked: NaN made a deadline that expired instantly");
  const m = await rfa(["task", "create", "t", "--max-attempts", "many"]);
  assert.equal(m.code, 2);
  assert.match(m.stderr, /--max-attempts takes a whole number from 1 to 20/);
  const l = await rfa(["logs", "-n", "abc"]);
  assert.equal(l.code, 2);
  assert.match(l.stderr, /--lines takes a whole number of at least 1/);
  const both = await rfa(["task", "create", "t", "--owner", "x", "--capability", "y"]);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /pass one or the other/);
  const nobody = await rfa(["task", "create", "t", "--room", "product", "--capability", "answer-question"]);
  assert.equal(nobody.code, 3, nobody.stderr);
  assert.match(nobody.stderr, /nobody in product offers answer-question right now/, "resolved at create time against the live roster, and said plainly when it cannot be");
  const e = await rfa(["evals", "run", "--json"]);
  assert.equal(e.code, 2);
  const refusal = JSON.parse(e.stdout) as { error: string; exit: number };
  assert.match(refusal.error, /no --json view/, "the runner never sees the flag, so swallowing it silently would lie to the script that passed it");
  assert.equal(refusal.exit, 2, "and under --json the refusal itself is JSON");
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

test("room adopt by alias: a recorded room without an operator membership (the migration's case) gets one, as supervisor, and the operator bearer is admitted", async () => {
  const created = await rfa(["room", "create", "adoptme", "--topic", "recorded without an operator, like after rfa migrate", "--json"]);
  assert.equal(created.code, 0, created.stderr);
  const handle = json<{ handle: string }>(created).handle;
  // What the migration leaves behind: the record, the secret, no operator membership.
  roomsStore(h).update((f) => {
    const rec = f.rooms.find((r) => r.alias === "adoptme")!;
    rec.operator = null;
  });
  const refused = await rfa(["room", "allow", "adoptme", "--token", "operator"]);
  assert.equal(refused.code, 3, "an admin verb without an operator membership is refused and names adopt");
  assert.match(refused.stderr, /rfa room adopt/);

  const adopted = await rfa(["room", "adopt", "adoptme"]);
  assert.equal(adopted.code, 0, adopted.stderr);
  assert.match(adopted.stdout, /adopted r_[a-f0-9]+ as adoptme/);
  const rec = roomsStore(h).read().rooms.find((r) => r.alias === "adoptme")!;
  assert.equal(rec.handle, handle);
  assert.equal(rec.operator?.role, "supervisor", "the operator joined as a human supervisor");
  const shown = await rfa(["room", "show", "adoptme", "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  const view = json<{ policies: { join_bearer_sha256?: string[] } | null }>(shown);
  const digest = tokensStore(h).read().tokens.find((t) => t.kind === "operator")!.sha256;
  assert.ok(view.policies?.join_bearer_sha256?.includes(digest), "the operator bearer is admitted by hash, so residents need no join secret");

  const twice = await rfa(["room", "adopt", "adoptme"]);
  assert.equal(twice.code, 2, "a room that already has an operator membership is not adopted again");
  const unknown = await rfa(["room", "adopt", "nosuch"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no recorded room named nosuch/);
});

// ---------------------------------------------------------------- RFA-0.8's observing surface
//
// The ladder shipped its SETTING surface (rfa agent edit --concurrency, the
// pack schema, the fence, resource claims) before anything could SEE it. These
// tests are written against the BROKEN state in each case, because the failure
// the rest of this file exists to prevent is a check that cannot fail: on
// 2026-08-27 this repository shipped an eval assertion whose metric was
// non-empty by construction and quoted it as proof (docs/LEDGER.md).

/** A hand-written pack, which is how every broken state below actually arrives. */
function writePack(name: string, frontmatter: string): void {
  const packDir = path.join(h.paths.agents, name);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, "agent.md"), `---\nrfa_agent: 1\nname: ${name}\ndescription: A pack written by hand for the doctor tests.\n${frontmatter}secrets: [RFA_TOKEN]\n---\nYou answer questions.\n`);
}

const verdicts = (checks: { id: string; verdict: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c.verdict]));
const textOf = (checks: { id: string; text: string }[], id: string) => checks.find((c) => c.id === id)?.text ?? "";

test("doctor reports the write-fence declaration, the concurrency gates and definition drift per pack, and never ticks door one", async () => {
  // Four packs, three of them in a state the ladder can produce and nothing could see.
  writePack("writer", "tools:\n  allow: [Read, Write]\n"); // a WRITING pack: door one has to hold its declaration
  writePack("unfenced", "tools:\n  allow: [Read, Write]\nsandbox:\n  permission_mode: acceptEdits\n"); // door one switched off before the callback
  writePack("fast", "concurrency: 2\ntools:\n  allow: [Read, Grep]\nbudgets:\n  per_day_usd: 5\n"); // two turns at once, gates passed
  writePack("broken", "concurrency: 3\ntools:\n  allow: [Read, Grep]\n"); // three at once with no daily ceiling: gate 3
  type Check = { id: string; verdict: string; text: string; fix?: string };
  const run = async () => json<Check[]>(await rfa(["doctor", "--json"]));
  let checks = await run();
  let by = verdicts(checks);

  // (a) The declaration half of door one, from the fence's own functions.
  assert.equal(by["fence-declaration-writer"], "ok", textOf(checks, "fence-declaration-writer"));
  assert.match(textOf(checks, "fence-declaration-writer"), /Write/);
  assert.equal(by["fence-declaration-unfenced"], "fail", "acceptEdits auto-approves the two tools door one exists to intercept");
  assert.match(textOf(checks, "fence-declaration-unfenced"), /acceptEdits/);
  // The other way door one goes off is the one no agent.md can express, because
  // the resident computes `allowedTools`: the guarded built-in ends up
  // pre-approved, and the bare entry auto-approves the call before canUseTool is
  // consulted. Constructed here rather than asserted to be impossible.
  const { fenceDeclarationCheck } = await import("../src/cli/commands/doctor.js");
  const { loadPack } = await import("../src/agentdef.js");
  const writerPack = loadPack(path.join(h.paths.agents, "writer"));
  const shadowed = fenceDeclarationCheck(writerPack, ["Read", "Write"])!;
  assert.equal(shadowed.verdict, "fail");
  assert.match(shadowed.text, /Write is listed bare in allowedTools/);
  assert.equal(fenceDeclarationCheck(writerPack, ["Read"])!.verdict, "ok", "the same pack, with the guarded tool kept out of the pre-approved set");
  assert.equal(fenceDeclarationCheck(loadPack(path.join(h.paths.agents, "fast")), ["Read"]), null, "a pack with no write surface gets no fence verdict at all");

  // (c) The gates, from the schema's own gate function, on the pack the schema REFUSED
  // (which is the only pack whose gates can fail: parseAgentMd throws on the others).
  assert.equal(by["concurrency-broken"], "fail");
  assert.match(textOf(checks, "concurrency-broken"), /per_day_usd/);
  assert.match(textOf(checks, "concurrency-broken"), /sect\. 10/);
  assert.equal(by["concurrency-fast"], "ok", textOf(checks, "concurrency-fast"));
  assert.match(textOf(checks, "concurrency-fast"), /2 turns at once/);
  // A pack that also carries a health report has to survive it: one unparseable
  // definition used to throw out of the middle of runChecks (listPacks maps
  // loadPack with no catch) and doctor printed a parse error instead of a report.
  assert.equal(by["pack-broken"], "fail", "the per-pack check still fires, and the rest of the report still arrives");
  assert.ok(checks.some((c) => c.id === "backups"), "including the checks after the packs");

  // The gates say nothing about the account cap, and a cap below the pack's own
  // number means the extra slot can never be used.
  assert.equal((await rfa(["config", "set", "agents.max_inflight", "1"])).code, 0);
  checks = await run();
  assert.equal(verdicts(checks)["concurrency-fast"], "warn", textOf(checks, "concurrency-fast"));
  assert.match(textOf(checks, "concurrency-fast"), /max_inflight is 1/);

  // ... and the cap IN FORCE is the ledger's, not the manifest's: `agents.max_inflight`
  // needs a restart to take effect, so reading it made doctor warn about a cap of 1
  // while `rfa status` printed the ledger's 0/2 in the same instance. The supervisor
  // mirrors the ledger cap into its state file, which is where this reads it from.
  const supStateFile = h.paths.supervisorState;
  const writeSupState = (cap: number) => {
    fs.mkdirSync(path.dirname(supStateFile), { recursive: true });
    fs.writeFileSync(supStateFile, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, agents: {}, account: { cap, in_flight: 0, paused_until: null } }));
  };
  writeSupState(2);
  checks = await run();
  assert.equal(verdicts(checks)["concurrency-fast"], "ok", `the ledger holds 2 and the pack declares 2, whatever the manifest still says: ${textOf(checks, "concurrency-fast")}`);
  assert.match(textOf(checks, "concurrency-fast"), /cap at 2/, "both numbers are named");
  assert.match(textOf(checks, "concurrency-fast"), /max_inflight on disk is 1/);
  assert.match(textOf(checks, "concurrency-fast"), /rfa restart/, "with the thing that would make the manifest edit live");
  // The reverse is the false reassurance the manifest read produced: the manifest
  // is raised, the supervisor still enforces the old cap, and the extra slot is
  // unusable. Reading the manifest here prints ok; reading the ledger warns.
  assert.equal((await rfa(["config", "set", "agents.max_inflight", "2"])).code, 0);
  writeSupState(1);
  checks = await run();
  assert.equal(verdicts(checks)["concurrency-fast"], "warn", `the manifest says 2 but nothing has applied it: ${textOf(checks, "concurrency-fast")}`);
  assert.match(textOf(checks, "concurrency-fast"), /in force is 1/);
  assert.match(textOf(checks, "concurrency-fast"), /max_inflight on disk is 2/);
  fs.rmSync(supStateFile, { force: true });

  // (b) Door two is established or refused on THIS host; door one is unverified,
  // and the assertion that matters is that it is never a tick.
  checks = await run();
  by = verdicts(checks);
  assert.ok(["ok", "fail"].includes(by["write-fence-sandbox"]), `a writing pack exists, so door two is answered either way: ${JSON.stringify(checks.find((c) => c.id === "write-fence-sandbox"))}`);
  assert.notEqual(by["write-fence-callback"], "ok", "door one cannot be proven without a model call, so a green tick here would be an assertion that cannot fail");
  assert.match(textOf(checks, "write-fence-callback"), /UNVERIFIED/);
  assert.match(textOf(checks, "write-fence-callback"), /fence-proof/);

  // (d) DEFINITION DRIFT, which is 2026-08-27's incident: the pack was edited to
  // concurrency 2 and the running resident kept serving the previous definition.
  // A stub process shaped exactly like a resident (src/procscan.ts is strict about
  // the shape), plus the state file a resident writes for itself.
  const stub = path.join(dir, "stub");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(path.join(stub, "resident.js"), "setTimeout(() => {}, 120000);\n");
  const stateDir = path.join(h.paths.agents, "fast", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const memberFile = path.join(stateDir, "member.json");
  const state = (hash: string) => JSON.stringify({ room: "r_stub", join_secret: null, membership_token: "t", member_id: "m_stub", name: "fast", cursor: 0, definition_hash: hash });
  fs.writeFileSync(memberFile, state("sha256:" + "0".repeat(64)));
  const child = spawn(process.execPath, [path.join(stub, "resident.js"), "--agent", "fast", "--dir", dir], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 400));
    checks = await run();
    assert.equal(verdicts(checks)["definition-fast"], "warn", textOf(checks, "definition-fast"));
    assert.match(textOf(checks, "definition-fast"), /restart owed/);
    assert.match(checks.find((c) => c.id === "definition-fast")?.fix ?? "", /rfa agent restart fast/);
    // And the converged state is not a warning: the same resident serving the same
    // definition on disk reports ok, so the check distinguishes the two.
    const onDisk = (await import("../src/agentdef.js")).loadPack(path.join(h.paths.agents, "fast")).definitionHash;
    fs.writeFileSync(memberFile, state(onDisk));
    checks = await run();
    assert.equal(verdicts(checks)["definition-fast"], "ok", textOf(checks, "definition-fast"));
  } finally {
    child.kill("SIGKILL");
  }
  // Nothing is serving the other packs, so nothing can drift for them.
  assert.equal(verdicts(await run())["definition-writer"], undefined, "a pack with no live resident gets no drift verdict, because there is nothing to compare");
});

test("doctor's sandbox check establishes door two rather than asking about it, and refuses loudly when it cannot", async () => {
  const { writeFenceHostChecks } = await import("../src/cli/commands/doctor.js");
  // The case the dependency checks cannot see (RFA-0.8 sect. 9 A6): srt says the
  // platform is supported and the primitives are there, and the first wrapped
  // command dies. doctor must report FAIL, not "supported".
  const refused = await writeFenceHostChecks({ writing: ["writer"], establish: async () => ({ ok: false, platform: "linux", detail: "Creating new namespace failed: Operation not permitted" }) });
  const sandbox = refused.find((c) => c.id === "write-fence-sandbox")!;
  assert.equal(sandbox.verdict, "fail");
  assert.match(sandbox.text, /Operation not permitted/);
  assert.match(sandbox.fix ?? "", /refuses to serve/);

  // Established: the one verdict that may be green, because something was run.
  const good = await writeFenceHostChecks({ writing: ["writer"], establish: async () => ({ ok: true, platform: "darwin", detail: "established" }) });
  assert.equal(good.find((c) => c.id === "write-fence-sandbox")!.verdict, "ok");
  // ... and door one is STILL not green, whatever door two did. This is the
  // assertion that fires if anyone ever turns the unverified state into a tick.
  for (const set of [refused, good]) {
    const callback = set.find((c) => c.id === "write-fence-callback")!;
    assert.notEqual(callback.verdict, "ok");
    assert.match(callback.text, /npm run fence-proof/);
  }
  // No writing pack: nothing is claimed at all, and the text says what would prove it.
  const idle = await writeFenceHostChecks({ writing: [] });
  assert.deepEqual(idle.map((c) => [c.id, c.verdict]), [["write-fence", "skip"]]);
  assert.match(idle[0].text, /fence-proof/);
});

test("rooms are listed in a decided order: named first, ended last, in rfa room ls and rfa status alike", async () => {
  const { byRoomInterest } = await import("../src/cli/ui.js");
  // The live shape this fixes: ten unaliased test rooms from 2026-08-16 sitting
  // above the two rooms the operator works in.
  const live = [
    ...Array.from({ length: 10 }, (_, i) => ({ alias: null, handle: `r_${String(i).padStart(4, "0")}`, ended: i % 3 === 0 })),
    { alias: "product", handle: "r_9a25e48c0e", ended: false },
    { alias: "ops", handle: "r_fb3993fc90", ended: false },
    { alias: "old-demo", handle: "r_dead", ended: true },
  ];
  assert.deepEqual([...live].sort(byRoomInterest).map((r) => r.alias ?? r.handle), ["ops", "product", "old-demo", "r_0001", "r_0002", "r_0004", "r_0005", "r_0007", "r_0008", "r_0000", "r_0003", "r_0006", "r_0009"], "aliased first by alias, then unaliased by handle, ended last within each group");

  // Through the commands. `aaa-old` sorts first among the aliases and is ENDED,
  // so it proves the two rules do not collapse into one; `design` loses its
  // record, which is how an unaliased room happens (rooms.json is the CLI's
  // file, the room itself lives on the hub).
  assert.equal((await rfa(["room", "create", "aaa-old", "--topic", "an ended room whose alias sorts first"])).code, 0);
  assert.equal((await rfa(["room", "end", "aaa-old"])).code, 0);
  const design = roomsStore(h).read().rooms.find((r) => r.alias === "design")!;
  roomsStore(h).update((f) => {
    f.rooms = f.rooms.filter((r) => r.alias !== "design");
  });
  const listed = json<{ rooms: { alias: string | null; handle: string; ended?: boolean }[] }>(await rfa(["room", "ls", "--json"])).rooms;
  const aliases = listed.map((r) => r.alias);
  // RELATIVE order, not the whole list: this used to assert the exact four rooms
  // the earlier tests in this file happen to leave behind, so one new room
  // anywhere above broke two assertions that have nothing to do with it.
  const at = (alias: string) => listed.findIndex((r) => r.alias === alias);
  const liveAliased = listed.filter((r) => r.alias && !r.ended).map((r) => r.alias!);
  assert.ok(liveAliased.length > 0, `the instance needs at least one live named room for this to mean anything: ${JSON.stringify(aliases)}`);
  assert.deepEqual(liveAliased, [...liveAliased].sort((x, y) => x.localeCompare(y)), `live named rooms in alias order: ${JSON.stringify(aliases)}`);
  for (const alias of liveAliased) assert.ok(at(alias) < at("aaa-old"), `${alias} is live and named, so it sorts above the ENDED aaa-old whose alias sorts first: ${JSON.stringify(aliases)}`);
  assert.equal(aliases.at(-1), null, `the room nobody named is last, not first: ${JSON.stringify(aliases)}`);
  assert.equal(listed.at(-1)!.handle, design.handle);
  // rfa status reads rooms.json when no hub answers, and a record carries no
  // ended flag, so there the order is the alias order alone.
  const statusAliases = json<{ rooms: { alias: string }[] }>(await rfa(["status", "--json"])).rooms.map((r) => r.alias);
  assert.ok(statusAliases.includes("aaa-old"), `the ended room is still listed there: ${JSON.stringify(statusAliases)}`);
  assert.deepEqual(statusAliases, [...statusAliases].sort((x, y) => x.localeCompare(y)), "the same comparator behind rfa status, so the dashboard cannot disagree with the command, and with no ended flag the order is the alias order alone");
});

test("agent show and status show concurrency and candidates, with the reason the number is allowed", async () => {
  // Its own fixtures, idempotently: consuming the doctor test's packs made this
  // test unrunnable alone (`--test-name-pattern` on it failed), and a test that
  // only passes in file order is a test nobody can bisect with.
  writePack("fast", "concurrency: 2\ntools:\n  allow: [Read, Grep]\nbudgets:\n  per_day_usd: 5\n");
  writePack("writer", "tools:\n  allow: [Read, Write]\n");
  const view = json<{ concurrency: number; candidates: number; concurrency_gates: string[] }>(await rfa(["agent", "show", "fast", "--json"]));
  assert.equal(view.concurrency, 2);
  assert.equal(view.candidates, 1);
  assert.deepEqual(view.concurrency_gates, [], "the schema's own gate function, so this cannot claim a gate the loader does not enforce");
  const human = await rfa(["agent", "show", "fast"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /concurrency\s+2 turns at once, 1 candidate per task/);
  assert.match(human.stdout, /sect\. 10's gates/, "above 1 the line says WHY it is allowed");
  const serial = await rfa(["agent", "show", "writer"]);
  assert.match(serial.stdout, /1 turn at once \(serial\)/);

  const agents = json<{ agents: { name: string; concurrency: number; candidates: number }[] }>(await rfa(["status", "--json"])).agents;
  assert.equal(agents.find((a) => a.name === "fast")!.concurrency, 2, "so an operator reading the account cap can see WHICH agent may use both slots");
  assert.equal(agents.find((a) => a.name === "writer")!.concurrency, 1);
  const table = await rfa(["status"]);
  assert.match(table.stdout, /fast\s+.*2 at once/);
  assert.ok(!/writer\s+.*at once/.test(table.stdout), "a serial pack renders nothing there, so the column costs no width on an instance without one");
});

test("task show renders the resource grant, and a key returned as a digest is labelled a digest, never a path", async () => {
  const { renderGrants } = await import("../src/cli/commands/talk.js");
  const { Ui } = await import("../src/cli/ui.js");
  const ui = new Ui({ color: false, json: false, quiet: false, tty: false });
  const capture = (fn: () => void): string => {
    const out: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      fn();
    } finally {
      process.stdout.write = orig;
    }
    return out.join("");
  };

  const held = capture(() =>
    renderGrants(ui, {
      attempt: 2,
      owner: "m_worker",
      lease_expires: new Date(Date.now() + 120_000).toISOString(),
      resource_grants: [{ keys: ["local/agent-a/notes", "room/r_9a25e48c0e/board"], owner: "m_worker", attempt: 2, source: "claim", granted_at: new Date().toISOString() }],
    }),
  );
  assert.match(held, /local\/agent-a\/notes/, "the keys the claim holds, which is what a task_conflict names");
  assert.match(held, /room\/r_9a25e48c0e\/board/);
  assert.match(held, /attempt 2/);
  assert.match(held, /owner m_worker/);
  assert.match(held, /lease until/);

  // What a NON-LOCAL claimant is given instead of a local key (wire 10.3 item 8):
  // an HMAC under a hub-held secret. Printed as a key it invents a path.
  const digest = "hmac-sha256:" + "ab".repeat(32);
  const opaque = capture(() => renderGrants(ui, { attempt: 1, owner: "m_guest", lease_expires: null, resource_grants: [{ keys: [digest], owner: "m_guest", attempt: 1, source: "claim", granted_at: new Date().toISOString() }] }));
  assert.match(opaque, /opaque digest, NOT a path/);
  assert.ok(!/authority hmac-sha256/.test(opaque), "it is never rendered as if its first segment were an authority");
  assert.match(opaque, /no lease/);

  // An expired lease is said so rather than printed as a date the reader has to
  // compare by eye: every grant dies with the claim's release.
  const expired = capture(() => renderGrants(ui, { attempt: 3, owner: "m_worker", lease_expires: new Date(Date.now() - 60_000).toISOString(), resource_grants: [] }));
  assert.match(expired, /lease EXPIRED/);
  assert.match(expired, /no grant/, "and a claim with no resources blocks nobody, which is also worth saying");

  // Through the command, on a real task with no claim on it.
  const created = await rfa(["task", "create", "a task with no claim", "--room", "product", "--json"]);
  assert.equal(created.code, 0, created.stderr);
  const id = json<{ id: string }>(created).id;
  const shown = await rfa(["task", "show", id, "--room", "product"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /"id": "t_/, "the task object is still printed in full");
  assert.match(shown.stdout, /no grant/);
  assert.match(shown.stdout, /unclaimed/);
});

test("one unparseable pack does not stop `rfa up` or `rfa down` from working, and is named", async () => {
  // `listPacks` maps `loadPack` with no catch, deliberately, because the
  // supervisor wants a loud failure. Every CLI caller that LISTS or STOPS the
  // instance needs the opposite: doctor and collectStatus were fixed on
  // 2026-08-27, upAll and strayResidents the same day (docs/LEDGER.md).
  //
  // The invalid pack fails an RFA-0.8 sect. 10 gate rather than YAML syntax, so
  // this also pins that a SCHEMA refusal reaches these callers the same way a
  // parse error does.
  const bad = path.join(h.paths.agents, "broken-pack");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(
    path.join(bad, "agent.md"),
    ["---", "rfa_agent: 1", "name: broken-pack", "description: Declares concurrency with no day ceiling, which sect. 10 gate 3 refuses.", "concurrency: 3", "tools:", "  allow: [Read, Grep]", "offers:", "  - id: answer-question", "    description: Answers.", "---", "body"].join("\n"),
  );
  try {
    // --only supervisor reaches the pack listing (it runs before the daemon is
    // spawned, which is exactly where the throw used to land) without touching
    // the hub. The supervisor that starts will itself refuse to reconcile, which
    // is the behaviour the warning describes.
    const up = await rfa(["up", "--only", "supervisor"]);
    assert.doesNotMatch(up.stderr, /definition invalid|ZodError/, "rfa up must not die with the pack's own parse error");
    assert.match(up.stdout + up.stderr, /broken-pack/, "the invalid pack must be named");
    assert.match(up.stdout + up.stderr, /does not parse/, "and the operator must be told no resident will start");

    // `rfa down` reaches strayResidents, whose name set must still include a
    // pack that no longer parses: a resident of one would otherwise go
    // unreported and keep serving its membership.
    const down = await rfa(["down"]);
    assert.equal(down.code, 0, down.stderr);
    assert.doesNotMatch(down.stderr, /definition invalid|ZodError/, "rfa down must not die with the pack's own parse error");

    // collectStatus (fixed earlier the same day) stays tolerant too.
    const status = await rfa(["status", "--json"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /broken-pack/);
  } finally {
    await rfa(["down"]);
    fs.rmSync(bad, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the rest of the listPacks sweep (2026-08-27)
//
// `listPacks` maps `loadPack` with no catch and keeps doing so on purpose. The
// four callers fixed earlier that day (doctor, collectStatus, upAll,
// strayResidents) are covered by the test above; these cover the seven that
// followed. The rule, per site: a command that LISTS or operates ACROSS the
// instance is tolerant AND names the broken pack, and a command that targets ONE
// pack by name stays loud for THAT pack while no longer dying over a different
// one.

/**
 * A pack directory whose definition cannot be read at all, with files under it
 * worth keeping.
 *
 * Broken by SCHEMA (concurrency: 3 with no `budgets.per_day_usd`, RFA-0.8 sect.
 * 10 gate 3) and not by YAML syntax, because a schema refusal and a parse error
 * must reach every caller identically and it is the schema half that arrives in
 * real life: the operator raised a number, not corrupted a file.
 */
function writeUnreadablePack(name: string): string {
  const dir = path.join(h.paths.agents, name);
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.writeFileSync(path.join(dir, "memory", "note.md"), "# a fact this pack learned\n");
  fs.writeFileSync(
    path.join(dir, "agent.md"),
    ["---", "rfa_agent: 1", `name: ${name}`, "description: Declares concurrency with no day ceiling, which sect. 10 gate 3 refuses.", "concurrency: 3", "tools:", "  allow: [Read, Grep]", "offers:", "  - id: answer-question", "    description: Answers.", "---", "body"].join("\n"),
  );
  return dir;
}

test("rfa agent ls survives an unparseable pack and gives it a row of its own", async () => {
  const good = await rfa(["agent", "new", "sweep-ok", "--kind", "answerer", "--json"]);
  assert.equal(good.code, 0, good.stderr);
  const bad = writeUnreadablePack("sweep-bad");
  try {
    const ls = await rfa(["agent", "ls", "--json"]);
    assert.equal(ls.code, 0, ls.stderr);
    const rows = json<{ name: string; status: string; broken?: string | null }[]>(ls);
    const ok = rows.find((r) => r.name === "sweep-ok");
    assert.ok(ok, "the pack that parses is listed at all, which the throw prevented for every pack at once");
    assert.equal(ok.broken ?? null, null, "and it is not marked broken");
    const shown = rows.find((r) => r.name === "sweep-bad");
    // A ROW, not an omission. Silently skipping is the failure mode this asserts
    // against: a pack absent from `agent ls` reads as a RETIRED pack, and the
    // next move after that misreading is `rfa agent new` on a name in use.
    assert.ok(shown, "the broken pack is named, by its directory, because the declared name is what is unreadable");
    assert.equal(shown.status, "definition invalid");
    assert.match(shown.broken ?? "", /RFA-0\.8 sect\. 10/, "with the loader's own first line, so nobody has to re-run the parse to find out why");

    const human = await rfa(["agent", "ls"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /sweep-bad/, "the table names it too, not only --json");
    assert.match(human.stdout, /sweep-ok/);
    assert.match(human.stdout + human.stderr, /does not parse/, "and says what it means: nothing supervises that pack");
    assert.doesNotMatch(human.stderr, /definition invalid at|ZodError/, "never the raw loader error as the command's own failure");
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
    fs.rmSync(path.join(h.paths.agents, "sweep-ok"), { recursive: true, force: true });
  }
});

test("a by-name command stays loud for the pack it was asked about and no longer dies over a different one", async () => {
  const good = await rfa(["agent", "new", "sweep-named", "--kind", "answerer", "--json"]);
  assert.equal(good.code, 0, good.stderr);
  const bad = writeUnreadablePack("sweep-other");
  try {
    // Half one: a DIFFERENT pack is broken, and the question asked about
    // sweep-named is answered. This is the half `listPacks(...).find(...)` got
    // wrong: it threw sweep-other's error before ever looking for this name.
    const other = await rfa(["agent", "mode", "sweep-named", "--json"]);
    assert.equal(other.code, 0, other.stderr);
    assert.equal(json<{ name: string; mode: string }>(other).name, "sweep-named");

    // Half two: the NAMED pack is the broken one, so it fails, with its own
    // error and a way to fix it. The operator asked about this pack
    // specifically; answering "no pack" or answering nothing would both be lies.
    const named = await rfa(["agent", "mode", "sweep-other"]);
    assert.equal(named.code, 1, `expected a loud failure, got ${named.code}: ${named.stdout}${named.stderr}`);
    assert.match(named.stderr, /does not parse/);
    assert.match(named.stderr, /RFA-0\.8 sect\. 10/, "the loader's reason, not a generic refusal");
    assert.match(named.stderr, /rfa agent validate sweep-other/, "and the command that shows it in full");

    // Third branch, unchanged: a name that is not there at all is still the
    // not-found error, which must not be confused with the broken case.
    const absent = await rfa(["agent", "mode", "sweep-absent"]);
    assert.equal(absent.code, 2, absent.stderr);
    assert.match(absent.stderr, /no pack agents\/sweep-absent/);
    assert.doesNotMatch(absent.stderr, /does not parse/);
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
    fs.rmSync(path.join(h.paths.agents, "sweep-named"), { recursive: true, force: true });
  }
});

test("the backup planner is tolerant of an unparseable pack, and backs up strictly MORE than the loud version did", async () => {
  const { backupPlan } = await import("../src/platform.js");
  const bad = writeUnreadablePack("sweep-backup");
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-backup-"));
  try {
    const plan = backupPlan(h);
    assert.ok(
      plan.broken.some((b) => b.name === "sweep-backup" && /RFA-0\.8 sect\. 10/.test(b.error)),
      "the plan names the pack it could not read, so `rfa backup now` can say so",
    );
    // The point of the whole site: nothing in this plan comes from a parsed
    // definition, so a pack whose agent.md is refused STILL has its state and
    // its memory backed up. A "tolerant" fix that merely skipped the broken pack
    // would pass a test that only checked the command's exit code, and would
    // quietly stop backing up the memory of the one pack in trouble.
    assert.ok(plan.dbs.includes(path.join(h.paths.agents, "sweep-backup", "state", "memory.db")), "its memory DB is in the plan");
    assert.ok(plan.dirs.includes(path.relative(h.root, path.join(h.paths.agents, "sweep-backup", "memory"))), "so is its memory directory");
    assert.ok(plan.dbs.includes(h.paths.runsDb), "and the engine DB, which the throw took down with everything else");

    // End to end, because "in the plan" is not "in the archive".
    const cfg = await rfa(["config", "set", "retention.backup_dir", dest]);
    assert.equal(cfg.code, 0, cfg.stderr);
    const now = await rfa(["backup", "now", "--json"]);
    assert.equal(now.code, 0, now.stderr);
    const res = json<{ dest: string; files: string[]; broken_packs: { name: string }[] }>(now);
    assert.deepEqual(res.broken_packs.map((b) => b.name).filter((n) => n === "sweep-backup"), ["sweep-backup"]);
    // The human run, because `ui.warn` is a deliberate no-op under --json (the
    // JSON field above is that mode's channel). What the operator is told
    // matters as much as the fact: the pack was INCLUDED, not skipped.
    const human = await rfa(["backup", "now"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stderr, /sweep-backup/);
    assert.match(human.stderr, /in the backup anyway/);
    const tar = res.files.find((f) => f.endsWith("dirs.tar.gz"));
    assert.ok(tar, "the archive was written");
    const listing = execFileSync("tar", ["-tzf", tar], { encoding: "utf8" });
    assert.match(listing, /agents\/sweep-backup\/memory\/note\.md/, "the unreadable pack's own file is really in the archive");
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("the remaining cross-instance listings stay up and name the pack they could not read", async () => {
  const good = await rfa(["agent", "new", "sweep-listed", "--kind", "answerer", "--json"]);
  assert.equal(good.code, 0, good.stderr);
  const bad = writeUnreadablePack("sweep-unread");
  try {
    // knowledge status: a pack missing from this listing reads as a pack with no
    // knowledge, and the duplicate-page detector it carries is the cheapest
    // instrument against the one-fact-one-file rule. Both were off.
    const know = await rfa(["knowledge", "status", "--json"]);
    assert.equal(know.code, 0, know.stderr);
    const ks = json<{ agents: { pack: string }[]; broken: { name: string; error: string }[] }>(know);
    assert.ok(ks.agents.some((a) => a.pack === "sweep-listed"));
    assert.ok(ks.broken.some((b) => b.name === "sweep-unread" && /RFA-0\.8 sect\. 10/.test(b.error)));
    const knowHuman = await rfa(["knowledge", "status"]);
    assert.equal(knowHuman.code, 0, knowHuman.stderr);
    assert.match(knowHuman.stdout + knowHuman.stderr, /sweep-unread/);

    // secrets ls: the "declared by" column is the whole point of the listing, so
    // a broken pack's declarations being unreadable has to be said. Without it a
    // secret only that pack needs reads as "declared by no pack".
    const sec = await rfa(["secrets", "ls"]);
    assert.equal(sec.code, 0, sec.stderr);
    assert.match(sec.stdout + sec.stderr, /sweep-unread/);
    assert.match(sec.stderr, /missing from the column above/);

    // eval cases: found by directory, so a broken pack's cases are still listed
    // rather than the whole corpus being lost with them.
    const { listCases } = await import("../src/cli/commands/instruments.js");
    fs.mkdirSync(path.join(bad, "evals", "cases", "sweep-unread-01"), { recursive: true });
    fs.writeFileSync(path.join(bad, "evals", "cases", "sweep-unread-01", "case.yaml"), "id: sweep-unread-01\nkind: replay\nsubject: answer-question\n");
    assert.ok(
      listCases(h).some((c) => c.id === "sweep-unread-01"),
      "a case.yaml is a file on disk; losing the corpus over an unrelated definition was the worst trade of the seven sites",
    );

    // tab completion: it never crashed (a catch already swallowed the throw) but
    // it silently offered NO pack name at all, and the name most worth
    // completing at that moment is the broken pack's own.
    const comp = await rfa(["__complete", "--", "agent", "validate", ""]);
    assert.equal(comp.code, 0, comp.stderr);
    assert.match(comp.stdout, /sweep-unread/);
    assert.match(comp.stdout, /sweep-listed/);
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
    fs.rmSync(path.join(h.paths.agents, "sweep-listed"), { recursive: true, force: true });
  }
});
