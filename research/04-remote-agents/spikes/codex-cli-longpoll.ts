/**
 * SPIKE: how long a blocking `room_listen` the OpenAI Codex CLI tolerates.
 *
 * Why this exists. RFA-0.6 sect. 12 item 6 wants a per-framework timeout table
 * and states no numbers, because sect. 13 makes a committed spike script the
 * price of any number entering normative text. One of the two uncommitted rows
 * was an OpenAI client cancelling a tool call after a few seconds, which turns
 * a 25-second `room_listen` into an error that reads to a stranger as "RFA is
 * broken". This script is the committed half for ONE client: the Codex CLI.
 *
 * What it measures, and why it is the client's own record. The subject is the
 * MCP client inside `codex`, not the model and not the hub. So the verdict is
 * read from `codex exec --json`, whose event stream brackets every tool call
 * with `item.started` / `item.completed` for the same item id and carries the
 * call's own `error` field. Two things are deliberately NOT the source:
 *
 *   - the model's prose ("it worked"). A first run of this by hand had the model
 *     mistype the membership token, and the resulting `not_a_member` refusal was
 *     reported as a failure at 45s. A transcription error is not a timeout.
 *   - the hub's otel span. `otel rfa.room_listen 60001.8ms` proves the HUB held
 *     the poll for the full duration; it says nothing about whether the client
 *     was still there to receive the answer. Only the client's end does.
 *
 * Hermetic by default (`--ignore-user-config`, MCP server passed with `-c`), for
 * two reasons. A number measured against one operator's `config.toml` is that
 * operator's number: their per-server `tool_timeout_sec`, their plugins and
 * hooks. And on the machine this was first run on, the user's own config gave
 * the model a node REPL, which it reached for instead of the tool under test.
 * `--user-config` opts back in when the question is "what will MY setup do".
 *
 * The ceiling this can and cannot establish. The hub caps `timeout_ms` at 60000
 * (`src/hub.ts`), so a pass at 60000 establishes "at least the longest poll RFA
 * can ask for" and NOT the client's actual limit. Finding the true limit needs a
 * deliberately slow MCP server, which is a different spike.
 *
 * Run it (from the repo root, with the hub up and a peer bearer admitted):
 *
 *   rfa peer add codex-spike --room <alias> --expires 1d      # prints the bearer
 *   RFA_TOKEN=<peer bearer> npx tsx research/04-remote-agents/spikes/codex-cli-longpoll.ts \
 *     --hub http://127.0.0.1:8790/mcp --room r_xxxxxxxxxx
 *
 * Exit codes: 0 every requested poll survived; 1 at least one was cancelled or
 * came back unexplained; 2 the spike could not run (no codex, no bearer, no hub).
 */
import { spawn } from "node:child_process";
import { rawCall } from "../../../src/client.js";

const CLIENT_INFO = { name: "rfa-spike-codex-longpoll", version: "1" };
/** The hub's own ceiling on `timeout_ms`; a request above it is refused, not held. */
const HUB_MAX_TIMEOUT_MS = 60_000;
/** A poll that returns this much earlier than asked did not run to term. */
const EARLY_MS = 1_000;

interface Row {
  requestedMs: number;
  attempt: number;
  verdict: "survived" | "cancelled" | "unexplained" | "no-call";
  elapsedMs: number | null;
  detail: string;
}

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function die(msg: string): never {
  console.error(`spike: ${msg}`);
  process.exit(2);
}

async function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (out += String(d)));
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out.trim()));
  });
}

/**
 * One codex run, one `room_listen`. The prompt is minimal and the arguments are
 * given verbatim: every degree of freedom left to the model is a way for the run
 * to measure something other than the client.
 */
function runOnce(opts: {
  hub: string;
  room: string;
  token: string;
  timeoutMs: number;
  userConfig: boolean;
  server: string;
}): Promise<{ elapsedMs: number | null; error: string | null; sawCall: boolean; failure: string | null }> {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--json",
    // The sandbox is irrelevant to the measurement and its prompts are not: this
    // run must never block on an approval it cannot be answered.
    "--dangerously-bypass-approvals-and-sandbox",
    ...(opts.userConfig ? [] : ["--ignore-user-config"]),
    "-c",
    `mcp_servers.${opts.server}.url="${opts.hub}"`,
    "-c",
    // The bearer travels by env var name, never inline: this command line ends up
    // in process listings and in whatever captures this script's output.
    `mcp_servers.${opts.server}.bearer_token_env_var="RFA_TOKEN"`,
    `Call the tool room_listen on the MCP server named ${opts.server}, exactly once, with arguments ` +
      JSON.stringify({
        room: opts.room,
        membership_token: opts.token,
        since: 0,
        timeout_ms: opts.timeoutMs,
        wait_for: "mentions",
      }) +
      `. The room is quiet, so the call is EXPECTED to block for ${Math.round(opts.timeoutMs / 1000)} seconds and then ` +
      `return an empty result: that is success, not a problem. Do not shorten the timeout, do not change the ` +
      `arguments, do not retry it, do not call any other tool. Then reply with one word: done.`,
  ];

  return new Promise((resolve) => {
    const p = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let startedAt: number | null = null;
    let itemId: string | null = null;
    let out: { elapsedMs: number | null; error: string | null; sawCall: boolean; failure: string | null } = {
      elapsedMs: null,
      error: null,
      sawCall: false,
      failure: null,
    };
    let buf = "";

    const onLine = (line: string) => {
      if (!line.startsWith("{")) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const item = ev.item;
      const isSubject = item?.type === "mcp_tool_call" && item?.tool === "room_listen";
      // The clock is this process's, taken as each event is read. codex's JSONL
      // carries no timestamps of its own, so anything finer would be invented.
      if (ev.type === "item.started" && isSubject) {
        startedAt = Date.now();
        itemId = item.id ?? null;
        out.sawCall = true;
      } else if (ev.type === "item.completed" && isSubject && (itemId === null || item.id === itemId)) {
        out.elapsedMs = startedAt === null ? null : Date.now() - startedAt;
        out.error = item.error === null || item.error === undefined ? null : String(item.error);
        if (out.error === null && item.status && item.status !== "completed") out.error = `status=${item.status}`;
      } else if (ev.type === "turn.failed" || ev.type === "error") {
        out.failure = JSON.stringify(ev).slice(0, 300);
      }
    };

    p.stdout.on("data", (d) => {
      buf += String(d);
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) onLine(l.trim());
    });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += String(d)));
    p.on("error", (err) => resolve({ ...out, failure: `spawn failed: ${(err as Error).message}` }));
    p.on("close", (code) => {
      if (buf.trim()) onLine(buf.trim());
      if (!out.sawCall && out.failure === null && code !== 0) {
        out.failure = `codex exited ${code}: ${stderr.trim().slice(-300) || "(no stderr)"}`;
      }
      resolve(out);
    });
  });
}

async function main(): Promise<void> {
  const hub = flag("hub", process.env.RFA_HUB_URL ?? "http://127.0.0.1:8790/mcp")!;
  const room = flag("room");
  const server = flag("server", "rfa")!;
  const repeat = Number(flag("repeat", "1"));
  const userConfig = has("user-config");
  const timeouts = (flag("timeouts", "25000,45000,60000")!)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!room) die("--room <room handle> is required (rfa room ls --json)");
  if (!process.env.RFA_TOKEN) die("RFA_TOKEN must hold the peer bearer (rfa peer add prints it once)");
  const version = await capture("codex", ["--version"]);
  if (!version) die("no `codex` on PATH: this spike measures the Codex CLI's own MCP client");
  const over = timeouts.filter((t) => t > HUB_MAX_TIMEOUT_MS);
  if (over.length > 0) {
    die(`the hub refuses timeout_ms > ${HUB_MAX_TIMEOUT_MS} (${over.join(", ")}), so nothing would be held that long`);
  }

  // Join as the spike's own member rather than borrowing a resident's token: the
  // `mentions` filter then matches nothing, which is what makes every poll run to
  // term instead of returning early on somebody else's traffic.
  let joined: any;
  try {
    joined = await rawCall(hub, CLIENT_INFO, "room_join", {
      room,
      name: `codex-longpoll-spike`,
      card: {
        name: "codex-longpoll-spike",
        description: "measures how long a blocking room_listen this MCP client tolerates",
        skills: [{ id: "probe", description: "holds one room_listen open and reports whether the client stayed" }],
      },
    });
  } catch (err) {
    die(`room_join failed: ${(err as Error).message}`);
  }
  // The join contract nests identity under `you` (hub.ts: "your identity
  // (you.id, you.name, membership_token)"), not at the top level.
  const token: string = joined?.you?.membership_token ?? joined?.membership_token;
  if (!token) die(`room_join returned no membership_token: ${JSON.stringify(joined).slice(0, 200)}`);

  const rows: Row[] = [];
  for (const requestedMs of timeouts) {
    for (let attempt = 1; attempt <= repeat; attempt++) {
      const r = await runOnce({ hub, room, token, timeoutMs: requestedMs, userConfig, server });
      let verdict: Row["verdict"];
      let detail = "";
      if (r.failure !== null && !r.sawCall) {
        verdict = "no-call";
        detail = r.failure;
      } else if (!r.sawCall) {
        verdict = "no-call";
        detail = "the run made no room_listen call";
      } else if (r.elapsedMs === null) {
        verdict = "unexplained";
        detail = "the call started and never completed in the event stream";
      } else if (r.error !== null) {
        verdict = "cancelled";
        detail = r.error;
      } else if (r.elapsedMs < requestedMs - EARLY_MS) {
        // Not a client timeout: an event matched, or the hub answered early.
        verdict = "unexplained";
        detail = `returned ${requestedMs - r.elapsedMs}ms early with no error`;
      } else {
        verdict = "survived";
      }
      rows.push({ requestedMs, attempt, verdict, elapsedMs: r.elapsedMs, detail });
      console.log(
        `  ${String(requestedMs).padStart(6)}ms  attempt ${attempt}/${repeat}  ${verdict.padEnd(11)}` +
          `${r.elapsedMs === null ? "" : ` held ${(r.elapsedMs / 1000).toFixed(1)}s`}${detail ? `  ${detail}` : ""}`,
      );
    }
  }

  // The stamps ARE the result. A timeout row without its client version and its
  // transport era is a number with no shelf life (RFA-0.6 sect. 12 item 6).
  console.log("");
  console.log("codex CLI long-poll tolerance");
  console.log(`  measured        ${new Date().toISOString()}`);
  console.log(`  client          ${version}`);
  console.log(`  config          ${userConfig ? "the operator's own config.toml" : "hermetic (--ignore-user-config)"}`);
  console.log(`  transport       streamable HTTP on ${hub}, Authorization: Bearer (peer bearer)`);
  console.log(`  hub ceiling     timeout_ms <= ${HUB_MAX_TIMEOUT_MS}, so a pass at the top is ">= 60s", not a limit`);
  const worst = rows.filter((r) => r.verdict !== "survived");
  const top = rows.filter((r) => r.verdict === "survived").reduce((m, r) => Math.max(m, r.requestedMs), 0);
  console.log(`  survived up to  ${top === 0 ? "nothing" : `${top}ms`}`);
  if (worst.length > 0) {
    console.log("");
    for (const r of worst) console.log(`  ! ${r.requestedMs}ms attempt ${r.attempt}: ${r.verdict} ${r.detail}`);
  }
  process.exit(worst.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
