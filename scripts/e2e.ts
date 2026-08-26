/**
 * RFA end-to-end harness: starts everything, tests everything, reports.
 *
 *   npm run e2e            fast run (~15-25s): all profiles over the real wire
 *   npm run e2e:full       adds the slow presence-expiry scenario (~+50s)
 *   npm run e2e -- --keep  keep the temp data dirs for inspection
 *
 * Exit code = number of failed scenarios. Reports land in reports/.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnTsx, stopTree } from "../src/proc.js";
import { generateSigningKey, signCard } from "../src/signing.js";

const FULL = process.argv.includes("--full");
const KEEP = process.argv.includes("--keep");
const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

// ---------------------------------------------------------------- scenario runner

interface StepResult {
  scenario: string;
  ok: boolean;
  ms: number;
  detail: string;
  error?: string;
}
const results: StepResult[] = [];

async function scenario(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = performance.now();
  process.stdout.write(`${dim("▸")} ${name} ... `);
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - t0);
    results.push({ scenario: name, ok: true, ms, detail });
    console.log(`${green("PASS")} ${dim(`${ms}ms`)} ${dim(detail)}`);
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const msg = (err as Error).message.split("\n")[0].slice(0, 300);
    results.push({ scenario: name, ok: false, ms, detail: "", error: msg });
    console.log(`${red("FAIL")} ${dim(`${ms}ms`)} ${red(msg)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------- hub process management

const children: ChildProcess[] = [];
const tmpDirs: string[] = [];

function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `rfa-e2e-${tag}-`));
  tmpDirs.push(d);
  return d;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

interface Hub {
  port: number;
  url: string;
  proc: ChildProcess;
  dataDir: string;
  stderr: string[];
}

async function startHub(opts: { dataDir?: string; extraArgs?: string[] } = {}): Promise<Hub> {
  const port = await freePort();
  const dataDir = opts.dataDir ?? tmpDir("hub");
  const proc = spawnTsx(path.join(ROOT, "src", "main.ts"), ["--http", String(port), "--data", dataDir, ...(opts.extraArgs ?? [])], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(proc);
  const stderr: string[] = [];
  proc.stderr!.on("data", (d) => stderr.push(String(d)));
  const hub: Hub = { port, url: `http://127.0.0.1:${port}/mcp`, proc, dataDir, stderr };
  // Readiness: poll modern server/discover.
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`hub exited at boot: ${stderr.join(" ").trim()}`);
    try {
      const r = await modernRpc(hub.url, "server/discover", {});
      if (r.supportedVersions) return hub;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("hub did not become ready within 10s");
}

async function stopHub(hub: Hub): Promise<void> {
  // stopTree, not proc.kill: signalling the pid leaves descendants holding the
  // port (src/proc.ts has the measurement).
  await stopTree(hub.proc, 2_500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- wire clients

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "rfa-e2e", version: "0.3.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function modernRpc(url: string, method: string, params: Record<string, unknown>): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name as string } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
  });
  const text = await res.text();
  const payload = text.startsWith("event:") || text.includes("\ndata: ")
    ? JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6))
    : JSON.parse(text);
  if (payload.error) throw new Error(`rpc ${method}: ${payload.error.message}`);
  return payload.result;
}

/** Modern-era tools/call returning the parsed RFA result (throws on RFA errors). */
async function call(url: string, tool: string, args: Record<string, unknown>): Promise<any> {
  const result = await modernRpc(url, "tools/call", { name: tool, arguments: args });
  let inner: any;
  try {
    inner = JSON.parse(result.content[0].text);
  } catch {
    throw new Error(`${tool}: non-JSON tool result: ${String(result.content[0].text).slice(0, 220)}`);
  }
  if (result.isError || inner.error) {
    const e = inner.error ?? { code: "unknown", message: "tool error" };
    const err = new Error(`${e.code}: ${e.message}`) as Error & { code: string };
    err.code = e.code;
    throw err;
  }
  return inner;
}

const card = (name: string, skill: string) => ({
  name,
  description: `${name} (e2e)`,
  version: "1.0.0",
  skills: [{ id: skill, description: `does ${skill}` }],
});

// ---------------------------------------------------------------- scenarios

console.log(bold(`\nRFA end-to-end harness ${dim(`(node ${process.version}, ${FULL ? "full" : "fast"} mode)`)}\n`));
const startedAt = new Date();

// 1. Unit + integration suite
await scenario("unit suite (test/hub.test.ts)", async () => {
  const out = await new Promise<string>((resolve) => {
    // The TAP reporter by name: Node 26 made `spec` the default on every stream,
    // and `spec` prints "ℹ tests N" where this parser reads "# tests N".
    const p = spawn("node", ["--import", "tsx", "--test", "--test-reporter=tap", "test/hub.test.ts"], { cwd: ROOT });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.stderr.on("data", (d) => (buf += d));
    p.on("exit", () => resolve(buf));
  });
  const tests = /# tests (\d+)/.exec(out)?.[1];
  const pass = /# pass (\d+)/.exec(out)?.[1];
  const fail = /# fail (\d+)/.exec(out)?.[1];
  assert(tests && pass && fail, "could not parse test output");
  assert(fail === "0", `${fail} unit tests failed`);
  return `${pass}/${tests} tests`;
});

// 2. Hub boot + lockfile guard
const E2E_HUMAN_KEY = "hk_e2e_human";
let mainHub!: Hub;
await scenario("hub boot + exclusive-store lockfile", async () => {
  mainHub = await startHub({ extraArgs: ["--human-key", E2E_HUMAN_KEY] });
  // A second hub over the SAME data dir must fail loudly.
  const port2 = await freePort();
  const clash = spawnTsx(path.join(ROOT, "src", "main.ts"), ["--http", String(port2), "--data", mainHub.dataDir], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(clash);
  let err = "";
  clash.stderr!.on("data", (d) => (err += d));
  for (let i = 0; i < 100 && clash.exitCode === null; i++) await sleep(100);
  assert(clash.exitCode === 1, "second hub on the same data dir should exit 1");
  assert(err.includes("already owned by a live rfa-hub"), "lock error should name the cause");
  return `booted :${mainHub.port}; contender refused with guidance`;
});

// 3. Dual-era serving on one endpoint
await scenario("dual-era: legacy initialize + modern server/discover", async () => {
  const discover = await modernRpc(mainHub.url, "server/discover", {});
  assert(discover.supportedVersions?.includes("2026-07-28"), "modern era not offered");
  const legacyRes = await fetch(mainHub.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-e2e", version: "0" } },
    }),
  });
  const text = await legacyRes.text();
  const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
  assert(data.result?.protocolVersion === "2025-06-18", "legacy initialize not served");
  const tools = await modernRpc(mainHub.url, "tools/list", {});
  assert(tools.tools.length === 12, `expected 12 tools, got ${tools.tools.length}`);
  // The console rides the same origin.
  const consoleRes = await fetch(mainHub.url.replace(/\/mcp$/, "/console"));
  assert(consoleRes.status === 200, `console not served: ${consoleRes.status}`);
  assert((await consoleRes.text()).includes("RFA console"), "console page content missing");
  return `2026-07-28 + 2025-06-18 on one endpoint; ${tools.tools.length} tools listed; console served`;
});

// 4. Core flow: the spec section 17 worked example over HTTP
let roomRef: { room: string; pmTok: string; devTok: string } | null = null;
await scenario("core flow: join contract, live ask, busy refusal, presence, streamed answer", async () => {
  const u = mainHub.url;
  const pm = await call(u, "room_create", { topic: "e2e checkout questions", name: "pm-agent", card: card("pm-agent", "answer-spec-question") });
  const dev = await call(u, "room_join", { room: pm.room, join_secret: pm.join_secret, name: "dev-agent", card: card("dev-agent", "implement-feature") });
  roomRef = { room: pm.room, pmTok: pm.you.membership_token, devTok: dev.you.membership_token };
  assert(dev.roster.length === 2 && dev.epoch === 2, "join contract roster/epoch wrong");

  const pmEntry = dev.roster.find((r: any) => r.name === "pm-agent");
  const described = await call(u, "agent_describe", { room: pm.room, membership_token: dev.you.membership_token, digest: pmEntry.digest });
  assert(described.card.name === "pm-agent", "digest-addressed describe failed");

  // PM parks a listen; dev asks; delivery must be live.
  const parked = call(u, "room_listen", { room: pm.room, membership_token: pm.you.membership_token, since: dev.history.cursor, timeout_ms: 15000 });
  await sleep(150);
  const ask = await call(u, "room_send", {
    room: pm.room, membership_token: dev.you.membership_token, message_id: "e2e_ask_q1", kind: "request",
    mentions: [pmEntry.id], reply_by: new Date(Date.now() + 120_000).toISOString(),
    body: [{ type: "text", text: "billing address mandatory for digital-only carts?" }],
  });
  assert(ask.recipients[0].delivery === "live", `expected live delivery, got ${ask.recipients[0].delivery}`);
  const pmInbox = await parked;
  assert(pmInbox.events[0]?.envelope?.message_id === "e2e_ask_q1", "parked listen did not wake with the ask");

  // Busy refusal with presence piggyback; dev sees it via mentions (reply correlation).
  await call(u, "room_send", {
    room: pm.room, membership_token: pm.you.membership_token, message_id: "e2e_refuse_1", kind: "refuse",
    in_reply_to: "e2e_ask_q1", conversation_id: ask.conversation_id,
    refusal: { reason: "busy", detail: "e2e", retry_after_s: 1 }, presence: "busy",
    body: [{ type: "text", text: "busy" }],
  });
  const refusal = await call(u, "room_listen", { room: pm.room, membership_token: dev.you.membership_token, since: ask.seq, timeout_ms: 5000 });
  assert(refusal.events.some((e: any) => e.envelope?.refusal?.reason === "busy"), "refusal not delivered");

  // Presence flip observed under wait_for=all; then a 3-chunk streamed answer.
  const watch = call(u, "room_listen", { room: pm.room, membership_token: dev.you.membership_token, since: refusal.cursor, timeout_ms: 15000, wait_for: "all" });
  await sleep(150);
  await call(u, "room_presence", { room: pm.room, membership_token: pm.you.membership_token, state: "ready" });
  const seen = await watch;
  assert(seen.events.some((e: any) => e.type === "presence" && e.member.state === "ready"), "presence event not observed");

  for (let i = 0; i < 3; i++) {
    await call(u, "room_send", {
      room: pm.room, membership_token: pm.you.membership_token, message_id: `e2e_answer_${i}`, kind: "response",
      in_reply_to: "e2e_ask_q1", conversation_id: ask.conversation_id, to: [dev.you.id],
      chunk: { index: i, final: i === 2 },
      body: i < 2 ? [{ type: "text", text: `part ${i}` }] : [{ type: "text", text: "No." }, { type: "json", value: { mandatory: false } }],
    });
  }
  const answer = await call(u, "room_listen", { room: pm.room, membership_token: dev.you.membership_token, since: seen.cursor, timeout_ms: 5000 });
  const chunks = answer.events.filter((e: any) => e.envelope?.kind === "response");
  assert(chunks.length === 3 && chunks[2].envelope.chunk.final === true, "streamed chunks incomplete or unordered");
  assert(chunks[2].envelope.body[1].value.mandatory === false, "structured payload missing");
  return "live delivery, refusal, presence event, 3 ordered chunks + json payload";
});

// 5. Tasks profile: evidence gate + atomic claim race
await scenario("tasks: claim race, evidence gate, verifier != owner, unblock", async () => {
  const u = mainHub.url;
  const { room, pmTok, devTok } = roomRef!;
  const t = await call(u, "room_task", { room, membership_token: pmTok, action: "create", title: "e2e gated", evidence_required: true });
  const b = await call(u, "room_task", { room, membership_token: pmTok, action: "create", title: "e2e dependent", blocked_by: [t.id] });

  const race = await Promise.allSettled([
    call(u, "room_task", { room, membership_token: devTok, action: "claim", id: t.id }),
    call(u, "room_task", { room, membership_token: pmTok, action: "claim", id: t.id }),
  ]);
  const wins = race.filter((r) => r.status === "fulfilled").length;
  assert(wins === 1, `claim race: expected exactly 1 winner, got ${wins}`);
  const winnerTok = race[0].status === "fulfilled" ? devTok : pmTok;
  const loserTok = winnerTok === devTok ? pmTok : devTok;

  await assertRejectsCode(call(u, "room_task", { room, membership_token: winnerTok, action: "complete", id: t.id }), "bad_request");
  const sub = await call(u, "room_task", { room, membership_token: winnerTok, action: "complete", id: t.id, evidence: { summary: "done, see artifacts", artifacts: ["e2e"] } });
  assert(sub.verification.pending === true && sub.state === "working", "evidence submission should pend verification");
  await assertRejectsCode(call(u, "room_task", { room, membership_token: winnerTok, action: "verify", id: t.id, verdict: "accept" }), "unauthorized");
  const done = await call(u, "room_task", { room, membership_token: loserTok, action: "verify", id: t.id, verdict: "accept" });
  assert(done.state === "completed", "verified task should complete");
  const bNow = await call(u, "room_task", { room, membership_token: devTok, action: "get", id: b.id });
  assert(bNow.blocked_by.length === 0, "dependent task should be unblocked");
  return `1 claim winner, gate enforced, ${t.id} completed, ${b.id} unblocked`;
});

// 6. Signing profile: verified / tampered / strict hub
await scenario("signing: verified card, tamper detection, --require-signed enforcement", async () => {
  const key = generateSigningKey("EdDSA");
  const signed = signCard(card("signed-agent", "sign") as any, key);
  const u = mainHub.url;
  const a = await call(u, "room_create", { topic: "e2e signing", name: "signed-agent", card: signed });
  const me = a.roster.find((r: any) => r.name === "signed-agent");
  assert(me.card_verified === true, "signed card should verify");
  const tampered = { ...signed, description: "tampered by e2e" };
  const b = await call(u, "room_join", { room: a.room, join_secret: a.join_secret, name: "tampered-agent", card: tampered });
  assert(b.roster.find((r: any) => r.name === "tampered-agent").card_verified === false, "tampered card should flag false");
  await call(u, "room_end", { room: a.room, membership_token: a.you.membership_token });

  const strict = await startHub({ extraArgs: ["--require-signed"] });
  try {
    await assertRejectsCode(
      call(strict.url, "room_create", { topic: "strict", name: "nobody", card: card("nobody", "x") }),
      "join_denied",
    );
    const okStrict = await call(strict.url, "room_create", { topic: "strict", name: "signed-agent", card: signed });
    assert(okStrict.roster[0].card_verified === true, "strict hub should admit the signed card");
  } finally {
    await stopHub(strict);
  }
  return "verified=true, tampered=false, strict hub refuses unsigned";
});

// 7. Moderation profile: supervisor semantics, floor control, approval over the wire
await scenario("moderation: human supervisor, inject, floor control, approval, quarantine", async () => {
  const u = mainHub.url;
  const host = await call(u, "room_create", { topic: "e2e moderated", name: "mod-host", card: card("mod-host", "hosting") });
  const alice = await call(u, "room_join", { room: host.room, join_secret: host.join_secret, name: "mod-alice", card: card("mod-alice", "working") });
  const bob = await call(u, "room_join", { room: host.room, join_secret: host.join_secret, name: "mod-bob", card: card("mod-bob", "working") });
  // Supervisor joins need the provisioned human key; agents claiming it are refused.
  await assertRejectsCode(
    call(u, "room_join", { room: host.room, join_secret: host.join_secret, name: "mod-eve", card: card("mod-eve", "supervising"), role: "supervisor" }),
    "join_denied",
  );
  const eve = await call(u, "room_join", {
    room: host.room, join_secret: host.join_secret, name: "mod-eve", card: card("mod-eve", "supervising"),
    role: "supervisor", human_key: E2E_HUMAN_KEY,
  });
  assert(eve.you.origin === "human", "human key should mint a human principal");

  // Supervisors are read-only on the message plane; inject is their voice.
  await assertRejectsCode(
    call(u, "room_send", { room: host.room, membership_token: eve.you.membership_token, message_id: "e2e_mod_sup1", body: [{ type: "text", text: "x" }] }),
    "unauthorized",
  );
  const injected = await call(u, "room_admin", {
    room: host.room, membership_token: eve.you.membership_token, verb: "inject",
    params: { text: "supervisor online", mentions: [alice.you.id] },
  });
  assert(typeof injected.message_id === "string", "inject should return the message id");

  // Sequential floor: alice takes it, bob queues, yield advances, bob is notified.
  await call(u, "room_admin", {
    room: host.room, membership_token: eve.you.membership_token, verb: "set_policy",
    params: { policies: { mode: "sequential" } },
  });
  await call(u, "room_send", { room: host.room, membership_token: alice.you.membership_token, message_id: "e2e_mod_a1", body: [{ type: "text", text: "my turn" }] });
  await assertRejectsCode(
    call(u, "room_send", { room: host.room, membership_token: bob.you.membership_token, message_id: "e2e_mod_b1", body: [{ type: "text", text: "me too" }] }),
    "not_your_turn",
  );
  await call(u, "room_send", { room: host.room, membership_token: alice.you.membership_token, message_id: "e2e_mod_a2", body: [{ type: "text", text: "done" }], yield_floor: true });
  const bobView = await call(u, "room_listen", { room: host.room, membership_token: bob.you.membership_token, since: 0, timeout_ms: 0 });
  assert(bobView.events.some((e: any) => e.type === "system" && e.event === "floor_granted" && e.refs.member === bob.you.id), "floor_granted notice missing");
  await call(u, "room_send", { room: host.room, membership_token: bob.you.membership_token, message_id: "e2e_mod_b2", body: [{ type: "text", text: "thanks" }], yield_floor: true });

  // Approval flow: registered via ext, satisfied only by the human supervisor.
  // (Alice's request is turn-starting: it takes the now-free floor.)
  await call(u, "room_send", {
    room: host.room, membership_token: alice.you.membership_token, message_id: "e2e_mod_apr", kind: "request",
    mentions: [eve.you.id], body: [{ type: "text", text: "permission to deploy?" }],
    // tool_name and input_preview are REQUIRED as of 0.1.8 (spec 12.5): a hub
    // enforcing it refuses an ext without them, which is the point of the rule.
    ext: {
      "io.github.pbeneteau/approval": {
        request_id: "apr_e2e_1",
        action: "deploy to prod",
        tool_name: "ops__deploy_prod",
        input_preview: "env: prod\nrelease: 1.0",
      },
    },
  });
  const verdict = await call(u, "room_admin", { room: host.room, membership_token: eve.you.membership_token, verb: "approve", target: "apr_e2e_1" });
  assert(verdict.status === "approved", "human approve should succeed");
  const aliceView = await call(u, "room_listen", { room: host.room, membership_token: alice.you.membership_token, since: 0, timeout_ms: 0 });
  assert(
    aliceView.events.some((e: any) => e.type === "intervention" && e.verb === "approve" && e.refs.request_id === "apr_e2e_1"),
    "requester did not see the approval intervention",
  );

  // Quarantine bites on the very next call and blocks the identity's re-join.
  await call(u, "room_admin", { room: host.room, membership_token: eve.you.membership_token, verb: "quarantine", target: bob.you.id, reason: "e2e" });
  await assertRejectsCode(
    call(u, "room_send", { room: host.room, membership_token: bob.you.membership_token, message_id: "e2e_mod_b3", body: [{ type: "text", text: "?" }] }),
    "not_a_member",
  );
  await assertRejectsCode(
    call(u, "room_join", { room: host.room, join_secret: host.join_secret, name: "mod-bob", card: card("mod-bob", "working") }),
    "join_denied",
  );
  await call(u, "room_end", { room: host.room, membership_token: host.you.membership_token });
  return "human principal, inject, sequential floor + yield, approval, quarantine: all enforced on the wire";
});

// 8. Push over a real stdio transport (legacy client compat included)
await scenario("push over stdio: room_watch notifications, zero polling", async () => {
  const client = new Client({ name: "e2e-push", version: "0.3.0" });
  const pushed: any[] = [];
  (client as any).fallbackNotificationHandler = async (n: any) => {
    if (n.method === "notifications/room/event") pushed.push(n.params);
  };
  await client.connect(new StdioClientTransport({ command: "npx", args: ["-y", "tsx", "src/main.ts", "--data", "none"], cwd: ROOT }));
  try {
    const cc = async (name: string, args: Record<string, unknown>) => {
      const res = (await client.callTool({ name, arguments: args })) as any;
      const inner = JSON.parse(res.content[0].text);
      if (res.isError) throw new Error(`${inner.error.code}: ${inner.error.message}`);
      return inner;
    };
    const a = await cc("room_create", { topic: "e2e push", name: "watcher", card: card("watcher", "watch") });
    const b = await cc("room_join", { room: a.room, join_secret: a.join_secret, name: "sender", card: card("sender", "send") });
    await cc("room_watch", { room: a.room, membership_token: a.you.membership_token, since: a.history.cursor, wait_for: "all" });
    const t0 = performance.now();
    await cc("room_send", { room: a.room, membership_token: b.you.membership_token, message_id: "e2e_push_1", mentions: [a.you.id], body: [{ type: "text", text: "pushed" }] });
    for (let i = 0; i < 100 && pushed.length < 2; i++) await sleep(20);
    const latency = Math.round(performance.now() - t0);
    assert(pushed.length >= 2, `expected >=2 pushed events (roster replay + message), got ${pushed.length}`);
    assert(pushed.some((p) => p.event?.envelope?.message_id === "e2e_push_1"), "message push missing");
    return `${pushed.length} events pushed, message within ${latency}ms, 0 listen calls`;
  } finally {
    await client.close();
  }
});

// 9. Restart persistence: rooms, tokens, history, tasks survive
await scenario("restart persistence: state survives SIGTERM + reboot on the same store", async () => {
  const { room, devTok } = roomRef!;
  await stopHub(mainHub);
  mainHub = await startHub({ dataDir: mainHub.dataDir, extraArgs: ["--human-key", E2E_HUMAN_KEY] });
  const roster = await call(mainHub.url, "room_roster", { room, membership_token: devTok });
  assert(roster.roster.length === 2, "roster lost across restart");
  const history = await call(mainHub.url, "room_listen", { room, membership_token: devTok, since: 0, timeout_ms: 0, wait_for: "all" });
  assert(history.events.some((e: any) => e.envelope?.message_id === "e2e_ask_q1"), `history lost across restart: got ${history.events.length} events, types=${JSON.stringify(history.events.map((e: any) => e.type).slice(0, 12))}`);
  const tasks = await call(mainHub.url, "room_task", { room, membership_token: devTok, action: "list" });
  assert(tasks.tasks.length === 2, "tasks lost across restart");
  assert(tasks.tasks.every((t: any) => ["completed", "submitted"].includes(t.state)), "task states corrupted");
  return `roster, ${history.events.length} events, ${tasks.tasks.length} tasks intact with old token`;
});

// 10. Slow: presence lease expiry -> offline + gone_quiet (only with --full)
if (FULL) {
  await scenario("presence expiry (slow): ttl_s=30 lease -> offline + gone_quiet ~40s", async () => {
    const u = mainHub.url;
    const a = await call(u, "room_create", { topic: "e2e presence", name: "asker", card: card("asker", "ask") });
    const b = await call(u, "room_join", { room: a.room, join_secret: a.join_secret, name: "flaky", card: card("flaky", "flake") });
    await call(u, "room_presence", { room: a.room, membership_token: b.you.membership_token, state: "ready", ttl_s: 30 });
    const t0 = performance.now();
    await call(u, "room_send", {
      room: a.room, membership_token: a.you.membership_token, message_id: "e2e_gone_quiet_q", kind: "request",
      mentions: [b.you.id], reply_by: new Date(Date.now() + 300_000).toISOString(),
      body: [{ type: "text", text: "alive?" }],
    });
    let cursor = 0;
    for (let i = 0; i < 5; i++) {
      const got = await call(u, "room_listen", { room: a.room, membership_token: a.you.membership_token, since: cursor, timeout_ms: 20000 });
      cursor = got.cursor;
      const gq = got.events.find((e: any) => e.type === "system" && e.event === "gone_quiet");
      if (gq) {
        await call(u, "room_end", { room: a.room, membership_token: a.you.membership_token });
        return `gone_quiet after ${((performance.now() - t0) / 1000).toFixed(1)}s, askers=${JSON.stringify(gq.refs.askers)}`;
      }
    }
    throw new Error("gone_quiet never arrived within 5 listen windows");
  });
}

async function assertRejectsCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    if ((err as { code?: string }).code === code) return;
    throw new Error(`expected error ${code}, got: ${(err as Error).message}`);
  }
  throw new Error(`expected error ${code}, but the call succeeded`);
}

// 10. The operator CLI's lifecycle (RFA-0.7): a fresh hub directory, the daemons up and down, nothing left behind.
await scenario("rfa: init --yes, up, status, down leaves no process", async () => {
  const dir = tmpDir("rfa");
  const port = await freePort();
  const { execFile } = await import("node:child_process");
  const { nodeArgsFor } = await import("../src/proc.js");
  const cli = path.join(ROOT, "src", "cli", "main.ts");
  const rfa = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) =>
      execFile(process.execPath, [...nodeArgsFor(cli), ...args], { cwd: dir, env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      ),
    );
  const init = await rfa(["init", "--yes", "--no-start", "--name", "e2e", "--port", String(port), "--human", "e2e", "--agent", "none", "--json"]);
  assert(init.code === 0, `init failed: ${init.stderr.trim()}`);
  try {
    const up = await rfa(["up", "--json"]);
    assert(up.code === 0, `up failed: ${up.stderr.trim()}`);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert(health.status === 200, "the daemon hub answers /healthz");
    const st = await rfa(["status", "--json"]);
    assert(st.code === 0, `status failed: ${st.stderr.trim()}`);
    const status = JSON.parse(st.stdout) as { hub: { healthy: boolean; pid: number }; supervisor: { running: boolean; pid: number }; rooms: { alias: string }[]; rooms_source: string };
    assert(status.hub.healthy && status.supervisor.running, "both daemons report running");
    assert(status.rooms_source === "hub" && status.rooms.length === 1 && status.rooms[0].alias === "ops", `rooms from the hub: ${JSON.stringify(status.rooms)}`);
    const down = await rfa(["down", "--json"]);
    assert(down.code === 0, `down failed: ${down.stderr.trim()}`);
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    assert(gone(status.hub.pid) && gone(status.supervisor.pid), "both pids are gone after down");
    const after = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => "up", () => "down");
    assert(after === "down", "the port is released");
    return `port ${port}: hub pid ${status.hub.pid}, supervisor pid ${status.supervisor.pid}, both gone after down`;
  } finally {
    await rfa(["down"]).catch(() => {});
  }
});

// 11. An approval decided from the CLI lands as a human-origin intervention carrying the principal (RFA-0.7 sect. 3.4, v0.5 sect. 17.2 as amended).
await scenario("rfa: approvals reject from the CLI is a human-origin intervention with a principal", async () => {
  const dir = tmpDir("rfa-appr");
  const port = await freePort();
  const { execFile } = await import("node:child_process");
  const { nodeArgsFor } = await import("../src/proc.js");
  const { RoomMember } = await import("../src/client.js");
  const cli = path.join(ROOT, "src", "cli", "main.ts");
  const rfa = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) =>
      execFile(process.execPath, [...nodeArgsFor(cli), ...args], { cwd: dir, env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      ),
    );
  const init = await rfa(["init", "--yes", "--no-start", "--name", "appr", "--port", String(port), "--human", "e2e", "--agent", "none", "--room", "work", "--json"]);
  assert(init.code === 0, `init failed: ${init.stderr.trim()}`);
  const room = (JSON.parse(init.stdout) as { room: string }).room;
  const secrets = JSON.parse(fs.readFileSync(path.join(dir, ".rfa", "secrets.json"), "utf8")) as { RFA_TOKEN: string };
  const up = await rfa(["up", "--only", "hub"]);
  assert(up.code === 0, `up failed: ${up.stderr.trim()}`);
  try {
    // A local worker joins on the operator bearer alone (bearer-implied admission) and raises an approval card.
    process.env.RFA_TOKEN = secrets.RFA_TOKEN;
    const worker = await RoomMember.create({ hubUrl: `http://127.0.0.1:${port}/mcp`, room, name: "worker", card: { name: "worker", description: "raises an approval", skills: [{ id: "work", description: "works" }] } });
    const requestId = `apr_e2e_${Date.now().toString(36)}`;
    await worker.send({
      kind: "request",
      body: "APPROVAL NEEDED: save a document",
      ext: { "io.github.pbeneteau/approval": { request_id: requestId, action: "save document", tool_name: "mcp__linear__save_document", input_preview: "title: Spec\nproject_id: PRJ-1", params: { title: "Spec" }, allowed_decisions: ["approve", "edit", "reject"], expires_at: new Date(Date.now() + 300_000).toISOString() } },
    });
    const ls = await rfa(["approvals", "ls", "--json"]);
    assert(ls.code === 0, `approvals ls failed: ${ls.stderr.trim()}`);
    const cards = JSON.parse(ls.stdout) as { request_id: string; status: string; requester_home: string }[];
    const card = cards.find((c) => c.request_id === requestId);
    assert(card && card.status === "pending" && card.requester_home === "local", `the card is listed as pending and local: ${ls.stdout}`);
    const cursor = worker.cursor;
    const rej = await rfa(["approvals", "reject", requestId, "--yes"]);
    assert(rej.code === 0, `reject failed: ${rej.stderr.trim()}`);
    worker.cursor = cursor;
    let intervention: { verb: string; actor: string; refs: { request_id?: string; principal?: string } } | null = null;
    for (let i = 0; i < 3 && !intervention; i++) {
      const events = await worker.listenOnce({ timeoutMs: 3000, waitFor: "all" });
      intervention = (events.find((e: { type: string; verb?: string; refs?: { request_id?: string } }) => e.type === "intervention" && e.verb === "reject" && e.refs?.request_id === requestId) as never) ?? null;
    }
    assert(intervention, "the rejection landed as an intervention event");
    assert(/^hp_[0-9a-f]{12}$/.test(intervention.refs.principal ?? ""), `the intervention names the deciding human principal, got ${JSON.stringify(intervention.refs)}`);
    await worker.leave();
    return `card ${requestId} rejected by ${intervention.actor} as ${intervention.refs.principal}`;
  } finally {
    delete process.env.RFA_TOKEN;
    await rfa(["down"]).catch(() => {});
  }
});

// 12. Bearer-implied admission end to end, and revocation without a restart (RFA-0.7 sect. 2.4, wire 4.3 first slice).
await scenario("rfa: a connect bearer joins with no secret; a revoked peer is refused on its next request, no restart", async () => {
  const dir = tmpDir("rfa-bearer");
  const port = await freePort();
  const { execFile } = await import("node:child_process");
  const { nodeArgsFor } = await import("../src/proc.js");
  const { RoomMember } = await import("../src/client.js");
  const cli = path.join(ROOT, "src", "cli", "main.ts");
  const rfa = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) =>
      execFile(process.execPath, [...nodeArgsFor(cli), ...args], { cwd: dir, env: { ...process.env, RFA_DIR: "", RFA_TOKEN: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      ),
    );
  const init = await rfa(["init", "--yes", "--no-start", "--name", "bearer", "--port", String(port), "--human", "e2e", "--agent", "none", "--room", "work", "--json"]);
  assert(init.code === 0, `init failed: ${init.stderr.trim()}`);
  const room = (JSON.parse(init.stdout) as { room: string }).room;
  const hubUrl = `http://127.0.0.1:${port}/mcp`;
  const up = await rfa(["up", "--only", "hub"]);
  assert(up.code === 0, `up failed: ${up.stderr.trim()}`);
  const saved = process.env.RFA_TOKEN;
  try {
    const card = { name: "x", description: "a client", skills: [{ id: "ask", description: "asks" }] };
    // No bearer at all: the transport refuses before any tool runs.
    delete process.env.RFA_TOKEN;
    await assertRejectsCode(RoomMember.create({ hubUrl, room, name: "anon", card }), "unauthorized");
    // A client bearer minted by connect, admitted into the room by hash: joins with no secret.
    const conn = await rfa(["connect", "mcp", "--room", "work", "--label", "laptop", "--json"]);
    assert(conn.code === 0, `connect failed: ${conn.stderr.trim()}`);
    const clientToken = (JSON.parse(conn.stdout) as { token: string }).token;
    process.env.RFA_TOKEN = clientToken;
    const session = await RoomMember.create({ hubUrl, room, name: "laptop-session", card });
    assert(session.roster.some((m) => m.name === "laptop-session"), "the session is in the roster");
    await session.leave();
    // A peer bearer works the same way, and stops working the moment it is revoked: the hub reloads tokens.json.
    const peer = await rfa(["peer", "add", "bot", "--room", "work", "--json"]);
    assert(peer.code === 0, `peer add failed: ${peer.stderr.trim()}`);
    const peerToken = (JSON.parse(peer.stdout) as { token: string }).token;
    process.env.RFA_TOKEN = peerToken;
    const bot = await RoomMember.create({ hubUrl, room, name: "bot", card });
    const rev = await rfa(["peer", "revoke", "bot"]);
    assert(rev.code === 0, `revoke failed: ${rev.stderr.trim()}`);
    let refused = false;
    for (let i = 0; i < 30 && !refused; i++) {
      try {
        await bot.refreshRoster();
        await sleep(250);
      } catch (err) {
        refused = (err as { code?: string }).code === "unauthorized";
      }
    }
    assert(refused, "the revoked bearer is refused on a later request without a hub restart");
    return `anonymous 401, connect bearer joined ${room} secretless, peer bearer refused after revoke (reload, no restart)`;
  } finally {
    if (saved === undefined) delete process.env.RFA_TOKEN;
    else process.env.RFA_TOKEN = saved;
    await rfa(["down"]).catch(() => {});
  }
});

// 13. RFA-0.8 rung T item 2: two asks against ONE pack. The regression canary for
// the 2026-08-25 lease-race class (a shared current-lease cell, so whichever turn
// finished first released the OTHER's lease and freed a slot still in use).
//
// Today it asserts STRICT SERIALIZATION and per-ask run-id billing. At rung 3,
// when pack concurrency lands, it flips to overlap-allowed with invariants (the
// lease cap held during the overlap, distinct session ids, no torn memory files).
// The overlap is made reliable with one deliberately SLOW ask, never sleep tuning.
//
// It drives the real concurrency modules (the turn lock, the account ledger across
// two connections to one runs.db, the engine's run rows, the session book) in a
// child process against a real hub directory. It deliberately does NOT call a
// model: `npm run e2e` must not need a credential or cost money, and the machinery
// this canary guards is the machinery around the model call, not the call.
await scenario("rfa-0.8: two asks against one pack serialize, each billed to its own run id", async () => {
  const dir = tmpDir("rfa-concurrency");
  const port = await freePort();
  const { execFile } = await import("node:child_process");
  const { nodeArgsFor } = await import("../src/proc.js");
  const cli = path.join(ROOT, "src", "cli", "main.ts");
  const rfa = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) =>
      execFile(process.execPath, [...nodeArgsFor(cli), ...args], { cwd: dir, env: { ...process.env, RFA_DIR: "", NO_COLOR: "1" }, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      ),
    );
  const init = await rfa(["init", "--yes", "--no-start", "--name", "conc", "--port", String(port), "--human", "e2e", "--agent", "none", "--json"]);
  assert(init.code === 0, `init failed: ${init.stderr.trim()}`);

  // The driver runs in its own process so the modules under test are loaded the
  // way a resident loads them, and so the run rows are written by a pid this
  // harness does not own.
  // `.mts`, not `.ts`: a loose file outside a package with `"type": "module"` is
  // treated as CJS and top-level await fails to transform (the same trap
  // STATUS.md records for scratchpad scripts).
  const driver = path.join(dir, "two-asks.mts");
  fs.writeFileSync(
    driver,
    `import { AccountLedger } from ${JSON.stringify(path.join(ROOT, "src", "account.js"))};
import { Engine } from ${JSON.stringify(path.join(ROOT, "src", "engine.js"))};
import { makeTurnLock } from ${JSON.stringify(path.join(ROOT, "src", "turnlock.js"))};
import { SessionBook } from ${JSON.stringify(path.join(ROOT, "src", "sessions.js"))};
import { loadHubDir } from ${JSON.stringify(path.join(ROOT, "src", "hubdir.js"))};

const h = loadHubDir(process.argv[2]);
const engine = new Engine(h.paths.runsDb);
// Two connections to one file: the multi-process case, which is what a lease is for.
const account = new AccountLedger(h.paths.runsDb);
const other = new AccountLedger(h.paths.runsDb);
const oneTurn = makeTurnLock();
const sessions = new SessionBook();
const live = new Set<string>();
const trace: string[] = [];
let maxOverlap = 0;
let maxLeases = 0;

/** The resident's turn shape: run row, slot, lease into the set, session entered, settle, release exactly your own. */
async function ask(label: string, slowMs: number) {
  const { runId } = engine.createRun({ agent: 'pm-agent', threadId: 'convo-' + label, kind: 'serve' });
  return oneTurn(async () => {
    const slot = await account.waitForSlot({ agent: 'pm-agent', lane: 'serve', runId }, { timeoutMs: 30_000 });
    if (!slot.ok) throw new Error('no slot for ' + label + ': ' + slot.detail);
    const mine = slot.lease!.lease_id;
    live.add(mine);
    sessions.enter('convo-' + label);
    trace.push(label + ':start');
    maxOverlap = Math.max(maxOverlap, live.size);
    try {
      // The keepalive's job, from the other connection: renew EVERY lease held.
      const renew = setInterval(() => account.renewAll(live), 20);
      try {
        sessions.adopt('convo-' + label, 'sess_' + label);
        await new Promise((r) => setTimeout(r, slowMs));
        maxLeases = Math.max(maxLeases, other.leases().length);
      } finally {
        clearInterval(renew);
      }
      // Per-ask billing: this run's cost, on this run's row.
      engine.completeRun(runId, { output: { label }, costUsd: label === 'slow' ? 0.11 : 0.02, numTurns: 1, checkpoint: { claude_session_id: sessions.resumeFor('convo-' + label) } });
      trace.push(label + ':end');
      return runId;
    } finally {
      live.delete(mine);
      account.release(mine);
      sessions.leave('convo-' + label);
    }
  });
}

// One deliberately SLOW ask and one fast one, entered concurrently. Sleep tuning
// is not the mechanism: the slow ask is slow by construction.
const [slowRun, fastRun] = await Promise.all([ask('slow', 700), ask('fast', 0)]);
const runs = engine.runs({ agent: 'pm-agent' });
console.log(JSON.stringify({
  trace,
  maxOverlap,
  maxLeases,
  leasesLeft: other.leases().length,
  liveConversations: sessions.liveCount(),
  runs: runs.map((r) => ({ id: r.run_id, status: r.status, cost: r.cost_usd, session: (r.checkpoint as { claude_session_id?: string } | null)?.claude_session_id, owner: r.owner_pid })),
  slowRun,
  fastRun,
}));
engine.close();
account.close();
other.close();
`,
  );
  const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(process.execPath, [...nodeArgsFor(driver), dir], { cwd: ROOT, encoding: "utf8", timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
  assert(out.code === 0, `driver failed: ${out.stderr.trim().slice(0, 400)}`);
  const res = JSON.parse(out.stdout.trim().split("\n").pop()!) as {
    trace: string[];
    maxOverlap: number;
    maxLeases: number;
    leasesLeft: number;
    liveConversations: number;
    runs: { id: string; status: string; cost: number | null; session?: string; owner: number | null }[];
    slowRun: string;
    fastRun: string;
  };

  // STRICT SERIALIZATION: the two turns never interleave, and the trace proves it
  // by shape rather than by timing (start,end,start,end and never start,start).
  assert(res.maxOverlap === 1, `at most one turn in flight, saw ${res.maxOverlap} (trace ${res.trace.join(" ")})`);
  assert(res.trace.length === 4, `four trace points, got ${res.trace.join(" ")}`);
  assert(res.trace[0].endsWith(":start") && res.trace[1].endsWith(":end"), `the first turn finished before the second began: ${res.trace.join(" ")}`);
  assert(res.trace[0].split(":")[0] === res.trace[1].split(":")[0], `no interleaving: ${res.trace.join(" ")}`);
  assert(res.maxLeases <= 1, `one turn per pack means one lease at a time, saw ${res.maxLeases}`);

  // PER-ASK RUN-ID BILLING: two runs, distinct ids, each carrying its OWN cost.
  // This is the assertion the lease-race class would have broken: the bug billed a
  // slot wait to the previous turn's run id.
  assert(res.slowRun !== res.fastRun, "each ask got its own run id");
  const byId = new Map(res.runs.map((r) => [r.id, r]));
  assert(byId.get(res.slowRun)?.cost === 0.11, `the slow ask is billed 0.11, got ${byId.get(res.slowRun)?.cost}`);
  assert(byId.get(res.fastRun)?.cost === 0.02, `the fast ask is billed 0.02, got ${byId.get(res.fastRun)?.cost}`);
  assert(res.runs.every((r) => r.status === "success"), `both runs settled: ${JSON.stringify(res.runs)}`);
  assert(res.runs.every((r) => r.owner === null), "a settled run owns nothing, so the zero-traffic sweep cannot mistake it for a corpse");
  const sessionIds = res.runs.map((r) => r.session);
  assert(new Set(sessionIds).size === sessionIds.length, `distinct session ids per conversation: ${sessionIds.join(", ")}`);

  // NOTHING LEFT BEHIND: no lease outlives its turn, and no conversation stays held.
  assert(res.leasesLeft === 0, `every lease released by its own turn, ${res.leasesLeft} left`);
  assert(res.liveConversations === 0, "every conversation released");
  return `serialized (${res.trace.join(" ")}), 2 run ids billed 0.11/0.02, max ${res.maxLeases} lease and ${res.maxOverlap} turn in flight`;
});

// ---------------------------------------------------------------- report

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
const totalMs = results.reduce((a, r) => a + r.ms, 0);

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const reportDir = path.join(ROOT, "reports");
fs.mkdirSync(reportDir, { recursive: true });

const md = [
  `# RFA E2E report`,
  ``,
  `- Date: ${startedAt.toISOString()}`,
  `- Hub: rfa-hub ${pkg.version} · node ${process.version} · mode: ${FULL ? "full" : "fast"}`,
  `- Result: **${pass}/${results.length} scenarios passed** in ${(totalMs / 1000).toFixed(1)}s`,
  ``,
  `| # | Scenario | Status | ms | Detail |`,
  `|---|---|---|---|---|`,
  ...results.map((r, i) => `| ${i + 1} | ${r.scenario} | ${r.ok ? "PASS" : "FAIL"} | ${r.ms} | ${r.ok ? r.detail : r.error} |`),
  ``,
].join("\n");

fs.writeFileSync(path.join(reportDir, `e2e-${stamp}.md`), md);
fs.writeFileSync(path.join(reportDir, "latest.md"), md);
fs.writeFileSync(
  path.join(reportDir, "latest.json"),
  JSON.stringify({ date: startedAt.toISOString(), version: pkg.version, node: process.version, mode: FULL ? "full" : "fast", pass, fail, totalMs, results }, null, 1),
);

console.log(`\n${bold(fail === 0 ? green(`ALL ${pass}/${results.length} SCENARIOS PASS`) : red(`${fail}/${results.length} SCENARIOS FAILED`))} ${dim(`in ${(totalMs / 1000).toFixed(1)}s`)}`);
console.log(dim(`report: reports/e2e-${stamp}.md (+ reports/latest.md, latest.json)`));

// ---------------------------------------------------------------- cleanup

for (const hub of []) void hub;
await Promise.all(children.map((c) => stopTree(c, 1_500)));
if (!KEEP) for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
else console.log(dim(`kept temp dirs:\n  ${tmpDirs.join("\n  ")}`));

process.exit(fail);
