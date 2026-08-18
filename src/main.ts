#!/usr/bin/env node
/**
 * rfa-hub entrypoint (MCP v2 SDK: dual-era serving, server/discover native).
 *
 *   rfa-hub                    stdio MCP server, dual-era (for `claude mcp add`, Cursor, etc.)
 *   rfa-hub --http 8790        Streamable HTTP MCP server (stateless, modern era + legacy fallback)
 *   rfa-hub --data ./data      persistence directory (default ./data; "none" disables). Also holds
 *                              auth.log.ndjson: one aggregated row per window of POST /auth outcomes
 *                              plus, when --mcp-token is set, of /mcp transport-auth outcomes,
 *                              kept out of every room's event chain on purpose (spec 15.5).
 *   rfa-hub --trusted-keys k.json   provisioned {kid: publicJWK} map for card verification
 *   rfa-hub --require-signed        refuse joins whose card cannot be verified
 *   rfa-hub --human-key k1,k2       provisioned human-principal keys (joins presenting one get origin=human;
 *                                   required for room_admin approve and quarantine release). Also RFA_HUMAN_KEYS.
 *   rfa-hub --mcp-token t1,t2       OPT-IN transport bearers for /mcp (RFA-0.6 sect. 4.2). Also RFA_MCP_TOKENS.
 *                                   DEFAULT OFF: with none configured /mcp behaves exactly as it does today,
 *                                   uncredentialed, which is what the residents, the ask CLI, the console and
 *                                   the eval harness rely on. With one or more configured, every /mcp request
 *                                   must carry `Authorization: Bearer <token>` or it is refused 401. The hub
 *                                   only ever VALIDATES a token; there is no minting endpoint (sect. 4.3).
 *   rfa-hub --otel                  emit one compact stderr line per tool-call span (spec 13). Without this
 *                                   flag spans are no-ops unless the operator registers their own OTel SDK.
 *   rfa-hub --bind 0.0.0.0          HTTP bind address (default 127.0.0.1: loopback only, per MCP
 *                                   2026-07-28 Streamable HTTP guidance). Reach a loopback hub from
 *                                   another device with a proxy that terminates identity
 *                                   (`tailscale serve` proxies http://127.0.0.1), never by widening this.
 *   rfa-hub --push-url URL         notification-only push on approval-card creation and expiry (also
 *                                   RFA_PUSH_URL). Any webhook; ntfy header names are used. Carries a
 *                                   title and a link, NEVER a credential and never an action button.
 *   rfa-hub --console-url URL       public base URL the push link points at (also RFA_CONSOLE_URL),
 *                                   e.g. the tailnet name in front of this hub.
 *   rfa-hub --allow-origin a,b      extra browser origins allowed to POST (localhost forms are always
 *                                   allowed; a request with NO Origin header, i.e. any non-browser
 *                                   client, is unaffected). Rejections are logged with the value seen.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { listPacks, parseAgentMd } from "./agentdef.js";
import { createHubServer } from "./hub.js";
import { sha256hex } from "./jcs.js";
import { ObsStore } from "./obs.js";
import { RoomHub } from "./store.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dataArg = arg("--data") ?? "./data";
const trustedKeysPath = arg("--trusted-keys");
let hub: RoomHub;
try {
  hub = new RoomHub({
    dataDir: dataArg === "none" ? null : dataArg,
    trustedKeys: trustedKeysPath ? JSON.parse(fs.readFileSync(trustedKeysPath, "utf8")) : {},
    requireSignedCards: process.argv.includes("--require-signed"),
    humanKeys: (arg("--human-key") ?? process.env.RFA_HUMAN_KEYS ?? "").split(",").filter(Boolean),
    // Policy-gate checks (spec 12.2): a JSON array of GateCheck objects.
    gateChecks: arg("--gate") ? JSON.parse(fs.readFileSync(arg("--gate")!, "utf8")) : [],
  });
} catch (err) {
  console.error(`rfa-hub: ${(err as Error).message}`);
  process.exit(1);
}
const httpPort = arg("--http");

// ---------------------------------------------------------------- /mcp transport bearer (RFA-0.6 sect. 4.2)
// Operator-configured bearers for the MCP endpoint, same shape as
// --human-key/RFA_HUMAN_KEYS: comma-separated, the flag winning over the env var.
//
// DEFAULT OFF, and that is a requirement rather than a convenience. /mcp is
// uncredentialed today (sect. 4.1) and every live client POSTs there with no
// Authorization header: both residents, the ask CLI, the console page and the
// eval harness, because src/client.ts `rawCall` sends none. An empty list
// therefore MUST mean "behave exactly as before"; the startup banner states
// which of the two modes is in force so an operator never has to guess.
//
// UNRESOLVED, sect. 4.4 spike 11, UNRUN: it is not known whether a real MCP
// host (Claude Code, Cursor) can carry a static Authorization header into a
// registered server. If it cannot, the credential has to move into the tool
// arguments instead and this flag's shape changes. Nothing below is evidence
// that the header path works with a host: it is only known to work for a client
// that makes its own HTTP request.
// A flag value is visible in `ps`, so RFA_MCP_TOKENS is the better of the two paths for a real token.
const mcpTokens = (arg("--mcp-token") ?? process.env.RFA_MCP_TOKENS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// --otel: the built-in minimal exporter (one line per span on stderr). Serious
// deployments skip the flag and register a real OTel SDK; the hub only ever
// depends on @opentelemetry/api.
if (process.argv.includes("--otel")) {
  const { trace } = await import("@opentelemetry/api");
  const { BasicTracerProvider, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  // The obs bridge (spec 7.1): every hub tool-call span also lands as a run
  // row in the local trace store, joined to the caller's trace when present.
  const obsStore =
    dataArg === "none"
      ? null
      : new (await import("./obs.js")).ObsStore(`${dataArg === "none" ? "." : dataArg}/obs.db`);
  const hr = (t: [number, number]) => t[0] * 1e3 + t[1] / 1e6;
  const exporter = {
    export(spans: any[], done: (r: { code: number }) => void) {
      for (const s of spans) {
        const ms = (s.duration[0] * 1e3 + s.duration[1] / 1e6).toFixed(1);
        const a = s.attributes ?? {};
        const extras = ["rfa.room", "rfa.member", "rfa.seq", "rfa.error_code"]
          .filter((k) => a[k] !== undefined)
          .map((k) => `${k.slice(4)}=${a[k]}`)
          .join(" ");
        console.error(`otel ${s.name} ${ms}ms${extras ? " " + extras : ""}`);
        // room_listen long-polls dominate volume with zero diagnostic value when healthy; skip them.
        if (obsStore && s.name !== "rfa.room_listen") {
          try {
            obsStore.record({
              id: s.spanContext().spanId,
              trace_id: s.spanContext().traceId,
              parent_run_id: s.parentSpanContext?.spanId ?? null,
              name: s.name,
              run_type: "tool",
              status: s.status?.code === 2 ? "error" : "success",
              error: a["rfa.error_code"] ? String(a["rfa.error_code"]) : null,
              start_time: hr(s.startTime),
              end_time: hr(s.endTime),
              group_id: a["rfa.room"] ? String(a["rfa.room"]) : null,
              extra: { member: a["rfa.member"] ?? null, seq: a["rfa.seq"] ?? null, "mcp.tool.name": a["mcp.tool.name"] },
            });
          } catch {
            /* observability must never break serving */
          }
        }
      }
      done({ code: 0 });
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter as never)] });
  trace.setGlobalTracerProvider(provider);
  console.error(`rfa-hub: otel span logging on (stderr)${obsStore ? " + obs.db bridge" : ""}`);
}

process.on("SIGINT", () => {
  hub.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  hub.close();
  process.exit(0);
});

if (httpPort) {
  const port = parseInt(httpPort, 10);
  // Modern-era stateless handler with legacy fallback on the same endpoint.
  const handler = createMcpHandler(() => createHubServer(hub), {
    legacy: "stateless",
    onerror: (e) => console.error(`rfa-hub http: ${e.message}`),
  });

// ---------------------------------------------------------------- workbench APIs (v0.4.5, spec 3.8)
// Session-token auth: the operator presents a provisioned human_key ONCE;
// the hub mints a short-lived token; every write carries it. Because the
// token chains to a human key, console decisions land as human-origin
// interventions through the ordinary room machinery.
//
// Reads are tokened too (v0.5.0). They were not, and the same release found the
// server binding every interface: agent definitions (the Goodvest system
// prompt), run payloads, and pending approval cards (whole draft documents)
// were readable by anything on the laptop's network. Read routes are cheap to
// gate because the console already sends the bearer and re-prompts on 401.

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const AGENTS_DIR = path.join(ROOT, "agents");
const sessions = new Map<string, number>(); // token -> expires (ms)
const SESSION_TTL_MS = 12 * 3600_000;
let obsStore: ObsStore | null = null;
function obs(): ObsStore | null {
  if (dataArg === "none") return null;
  obsStore ??= new ObsStore(path.join(dataArg, "obs.db"));
  return obsStore;
}

/** Extra browser origins the operator allowlisted (loopback forms are implicit). */
const extraOrigins = (arg("--allow-origin") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** True when this request may proceed: no Origin (non-browser client), a loopback origin, or an allowlisted one. */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (extraOrigins.includes(origin)) return true;
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------- capture path (v0.5.1, spec 17.5)
// The binding constraint on every instrument in this project is that it has
// produced a few dozen agent turns in its entire life, and the cheapest lever
// on that number is the five seconds between having a question and asking it.
// This is also the only spend-triggering write endpoint, on a credential with
// no revocation path, so it is rate limited per token.

const ASK_RATE_PER_HOUR = 20;
const askRate = new Map<string, number[]>(); // session token -> ms timestamps

function askRateOk(token: string): boolean {
  const now = Date.now();
  const hits = (askRate.get(token) ?? []).filter((t) => now - t < 3600_000);
  if (hits.length >= ASK_RATE_PER_HOUR) {
    askRate.set(token, hits);
    return false;
  }
  hits.push(now);
  askRate.set(token, hits);
  return true;
}

/** Answers we are still waiting for, so a phone can poll instead of holding a request open. */
const pendingAsks = new Map<string, { room: string; asked: string; conversationId: string | null; replyBy: string; asked_at: number }>();

/**
 * Notification-only push (spec 17.2 and 17.4): a title and a link, never a
 * credential and never an action button. A verdict arriving over a broadcast
 * channel carrying a bearer is a forgeable approval, so the console stays the
 * only surface where a decision can be made. Any webhook works: the body is
 * plain text with ntfy's header names, which Pushover and a bare webhook also
 * tolerate.
 */
const pushUrl = (arg("--push-url") ?? process.env.RFA_PUSH_URL ?? "").trim();
const consoleBase = (arg("--console-url") ?? process.env.RFA_CONSOLE_URL ?? "").trim();
const pushedCards = new Map<string, string>(); // request_id -> last state pushed

async function push(title: string, body: string, clickPath: string): Promise<void> {
  if (!pushUrl) return;
  try {
    await fetch(pushUrl, {
      method: "POST",
      headers: {
        Title: title.slice(0, 120),
        Priority: "default",
        Tags: "bell",
        ...(consoleBase ? { Click: `${consoleBase}${clickPath}` } : {}),
      },
      body: body.slice(0, 400),
    });
  } catch (err) {
    console.error(`rfa-hub push: ${(err as Error).message}`);
  }
}

/** Poll our own approval list rather than threading a callback through the store. */
function watchCards(): void {
  if (!pushUrl) return;
  setInterval(() => {
    let pending: ReturnType<RoomHub["pendingApprovals"]>;
    try {
      pending = hub.pendingApprovals();
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const card of pending) {
      seen.add(card.request_id);
      const state = card.status;
      if (pushedCards.get(card.request_id) === state) continue;
      pushedCards.set(card.request_id, state);
      if (state === "pending") {
        void push(
          `Approval needed: ${card.action}`,
          `${card.requester_name} in ${card.room}. Decide in the console; this notification cannot approve anything.`,
          `/console#${card.room}`,
        );
      } else {
        void push(`Approval expired: ${card.action}`, `Nobody decided in time. ${card.request_id}`, `/console#${card.room}`);
      }
    }
    for (const id of [...pushedCards.keys()]) if (!seen.has(id)) pushedCards.delete(id);
  }, 5_000).unref?.();
}

function authed(req: http.IncomingMessage): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) return false;
  sessions.set(m[1], Date.now() + SESSION_TTL_MS); // sliding
  return true;
}

// ------------------------------------------------- POST /auth hardening (spec 15.5)
// Since 15.2 this endpoint is the sole gate on every workbench route, reads
// included; the credential it guards is a long-lived operator-chosen static key
// with no absolute cap and no revocation; and the documented reach story (17.1)
// proxies the surface to a phone. Unthrottled guessing is therefore a larger
// residual risk than a timing side channel, which is why the attempt limit is a
// MUST and not a SHOULD.
const AUTH_MAX_FAILURES = 10; // a mistyped key on a phone keyboard must not lock the operator out on the first slip
const AUTH_FAIL_WINDOW_MS = 15 * 60_000; // failures decay: this many inside this window trip the lock
const AUTH_LOCKOUT_MS = 15 * 60_000; // ...then the source waits it out, capping a guesser near 40 tries/hour
const AUTH_SOURCE_CAP = 4096; // an unauthenticated caller must not grow the per-source map without bound
const AUTH_LOG_WINDOW_MS = 5 * 60_000; // one aggregated auth-log row per window, whatever the attempt volume

/**
 * Constant-time membership test for a presented secret. timingSafeEqual throws
 * on a length mismatch, so a wrong-length candidate is compared against a
 * same-length zero filler instead of short-circuiting: every configured secret
 * costs exactly one comparison of its own length whatever arrives, and the
 * length check that decides the verdict runs after the comparison, never
 * instead of it.
 *
 * Both credentials this hub validates go through here, the human_key on
 * POST /auth and the transport bearer on /mcp, because a second copy of this
 * loop is a second chance to get it wrong.
 */
function constantTimeMatch(presented: string, configured: readonly string[]): boolean {
  const p = Buffer.from(presented, "utf8");
  let ok = false;
  for (const secret of configured) {
    const k = Buffer.from(secret, "utf8");
    const sameLength = k.length === p.length;
    const candidate = sameLength ? p : Buffer.alloc(k.length);
    ok = (timingSafeEqual(k, candidate) && sameLength) || ok;
  }
  return ok;
}

/**
 * The join path (src/store.ts) still uses includes() and stays PENDING per
 * 15.5; it is guarded by a room handle and a join secret, not by this
 * endpoint's reach.
 */
function humanKeyMatches(presented: string): boolean {
  return constantTimeMatch(presented, hub.cfg.humanKeys);
}

type AuthAttempts = { failures: number; windowStart: number; lockedUntil: number };
const authAttempts = new Map<string, AuthAttempts>();

/**
 * The key the limit counts against: the socket address, deliberately never
 * X-Forwarded-For. That header is caller-controlled, so honouring it would let
 * one guesser present a fresh source per attempt and delete the limit. Behind
 * the 17.1 proxy every request instead shares the proxy's address and the limit
 * degrades to a global one, which fails in the safe direction.
 */
function authSource(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/** Remaining lockout for this source in ms; 0 when it may attempt. */
function authLockoutMs(source: string, now: number): number {
  const a = authAttempts.get(source);
  return a && a.lockedUntil > now ? a.lockedUntil - now : 0;
}

/** Count a refused attempt; true when this one tripped the lock. */
function authFailed(source: string, now: number): boolean {
  if (authAttempts.size > AUTH_SOURCE_CAP) {
    for (const [k, a] of authAttempts) {
      if (a.lockedUntil <= now && now - a.windowStart > AUTH_FAIL_WINDOW_MS) authAttempts.delete(k);
    }
  }
  let a = authAttempts.get(source);
  if (!a || now - a.windowStart > AUTH_FAIL_WINDOW_MS) {
    a = { failures: 0, windowStart: now, lockedUntil: 0 };
    authAttempts.set(source, a);
  }
  a.failures++;
  if (a.failures < AUTH_MAX_FAILURES) return false;
  a.lockedUntil = now + AUTH_LOCKOUT_MS; // the count restarts once the lock expires
  a.failures = 0;
  a.windowStart = now;
  return true;
}

// The auth log is deliberately NOT a room event log (15.5). A room's chain is
// per-room and seeded from its handle, while /auth is unauthenticated by
// definition: one event per failed attempt would hand an anonymous caller
// unbounded growth in the very audit trail being hardened. This log has its own
// genesis and carries aggregated counters, one row per window, so its size is
// bounded by elapsed time rather than by attempt volume. `failures` counts every
// refused request, including those refused by an active lock, so the row stays
// an honest volume signal; `lockouts` counts trips.
//
// /mcp transport-auth outcomes land in the SAME log and the same window, under
// their own three counters rather than a second file. Separate counters, not
// shared ones: /auth guards the workbench with a human_key and /mcp guards the
// protocol surface with an operator bearer, so folding a trip on one path into
// the other path's number would make the row unreadable as evidence. The three
// stay 0 unless --mcp-token/RFA_MCP_TOKENS is configured, since with the check
// off there is no outcome to record.
const AUTH_LOG_GENESIS = sha256hex("rfa-auth-log/v1");
const authLogFile = dataArg === "none" ? null : path.join(dataArg, "auth.log.ndjson");
type AuthWindow = {
  start: number;
  successes: number;
  failures: number;
  lockouts: number;
  mcpSuccesses: number;
  mcpFailures: number;
  mcpLockouts: number;
  sources: Set<string>;
};
let authWindow: AuthWindow | null = null;
let authChainHead: string | null = null;

/** Resume the chain from the last row so a restart continues the log instead of forking it. */
function authChainResume(file: string): string {
  if (authChainHead) return authChainHead;
  authChainHead = AUTH_LOG_GENESIS;
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const last = lines.length ? (JSON.parse(lines[lines.length - 1]) as { hash?: string }) : null;
    if (last?.hash) authChainHead = last.hash;
  } catch {
    /* no file yet, or a torn tail: start from genesis */
  }
  return authChainHead;
}

/** Write the open window as one aggregated row and close it. */
function flushAuthWindow(at: number = Date.now()): void {
  const w = authWindow;
  authWindow = null;
  if (!w || !authLogFile) return;
  const row = {
    window_start: new Date(w.start).toISOString(),
    window_end: new Date(Math.max(at, w.start)).toISOString(),
    successes: w.successes,
    failures: w.failures,
    distinct_sources: w.sources.size,
    lockouts: w.lockouts,
    mcp_successes: w.mcpSuccesses,
    mcp_failures: w.mcpFailures,
    mcp_lockouts: w.mcpLockouts,
    prev_hash: authChainResume(authLogFile),
  };
  const hash = sha256hex(JSON.stringify(row));
  try {
    fs.mkdirSync(path.dirname(authLogFile), { recursive: true });
    // 0600 at creation: these counters are evidence about the one credential
    // that guards every workbench route, and umask must not widen them.
    const created = !fs.existsSync(authLogFile);
    fs.appendFileSync(authLogFile, JSON.stringify({ ...row, hash }) + "\n", { mode: 0o600 });
    if (created) fs.chmodSync(authLogFile, 0o600);
    authChainHead = hash;
  } catch (err) {
    console.error(`rfa-hub auth log: ${(err as Error).message}`); // auditing must never break serving
  }
}

/** Which counter each outcome advances. One table so an outcome cannot land in two fields. */
const AUTH_AUDIT_COUNTER = {
  success: "successes",
  failure: "failures",
  lockout: "lockouts",
  mcp_success: "mcpSuccesses",
  mcp_failure: "mcpFailures",
  mcp_lockout: "mcpLockouts",
} as const;
type AuthOutcome = keyof typeof AUTH_AUDIT_COUNTER;

/** Fold one outcome into the open window, rolling the window over when it is due. */
function authAudit(outcome: AuthOutcome, source: string, now: number): void {
  if (!authLogFile) return; // --data none: the hub persists nothing, auth log included
  if (authWindow && now - authWindow.start >= AUTH_LOG_WINDOW_MS) flushAuthWindow(now);
  authWindow ??= {
    start: now,
    successes: 0,
    failures: 0,
    lockouts: 0,
    mcpSuccesses: 0,
    mcpFailures: 0,
    mcpLockouts: 0,
    sources: new Set(),
  };
  authWindow[AUTH_AUDIT_COUNTER[outcome]]++;
  // Capped for the same reason as the attempt map; distinct_sources is a floor once it is hit.
  // The socket address is what is counted, never the endpoint it hit, so one caller
  // reaching both /auth and /mcp stays one source.
  if (authWindow.sources.size < AUTH_SOURCE_CAP) authWindow.sources.add(source);
}

// A quiet hub must still land its rows on time, and one that dies must not lose
// the open window. The SIGINT/SIGTERM handlers above call process.exit, which
// fires "exit", where only synchronous work runs -- hence appendFileSync.
setInterval(() => {
  if (authWindow && Date.now() - authWindow.start >= AUTH_LOG_WINDOW_MS) flushAuthWindow();
}, 60_000).unref();
process.on("exit", () => flushAuthWindow());

// ------------------------------------------------- the /mcp credential check (RFA-0.6 sect. 4.2)
// With tokens configured the hub is an OAuth 2.1 *resource server* on this path
// and nothing more: it validates an opaque high-entropy string and never issues
// one. An authorization server inside the hub is rejected permanently (sect.
// 3.4), so there is no counterpart to POST /auth here and no minting route.
//
// Audience binding takes its equivalent form for an opaque bearer, which carries
// no `aud` claim to check: "this token was issued for this resource", which the
// operator-configured list establishes by construction, because a string that is
// not in this hub's own list is not a credential for this hub (sect. 4.2).
//
// Storage, since sect. 4.2 is specific about it: there it is the admission
// record that holds a hex SHA-256 and never the plaintext. This rung has no
// admission record, so the hub persists nothing at all; the tokens live in argv
// or the environment for the life of the process and are compared as plaintext,
// in constant time. When sect. 3's record lands, a digest comparison against it
// replaces this list.
//
// WHAT THIS IS NOT, because the difference decides whether a peer may be
// admitted. Both remaining halves need files outside this change:
//   - The transport principal is NOT recorded on the membership, so protocol
//     4.3's linkage rule (reject a call whose membership was admitted under a
//     different transport principal) is NOT enforced. That needs src/store.ts
//     and the admission record of sect. 3.
//   - room_create is NOT separately credentialed per sect. 4.2 item 2, and no
//     token here is peer-scoped: this is one flat operator credential for the
//     whole endpoint.
// A single operator-configured token list is the whole of rung v0.6.0a items 1
// to 3. It is NOT sufficient to admit a peer.

/**
 * Gate a request bound for the MCP handler. True when it may proceed; when
 * false, this function has already answered and the caller must return.
 *
 * The refusal is written for a client rather than for a human reading a log:
 * 401 with a JSON body and `WWW-Authenticate: Bearer`, so an MCP client can
 * tell "you need a credential" from "your call was malformed". RFC 9728
 * protected-resource metadata is deferred until a second peer exists (sect.
 * 4.2), hence a realm and no metadata URL in the challenge.
 *
 * Failures are rate-limited and audited on the same machinery as POST /auth,
 * with one difference: the attempt key is namespaced, so guessing at /mcp
 * cannot lock the operator out of the console and console typos cannot lock out
 * a peer.
 */
function mcpAuthorized(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (mcpTokens.length === 0) return true; // the default: no header expected, nothing audited, behavior unchanged
  // Answer without the MCP handler running. Drains the request first: Node
  // closes the socket on an unread body, and a client must read the 401 rather
  // than a connection reset.
  const refuse = (status: number, data: unknown, headers: Record<string, string>): false => {
    req.resume();
    send(res, status, data, headers);
    return false;
  };
  const now = Date.now();
  const source = authSource(req);
  const key = `mcp:${source}`;
  const locked = authLockoutMs(key, now);
  if (locked > 0) {
    authAudit("mcp_failure", source, now); // refused by the lock still counts as volume
    const retryS = Math.ceil(locked / 1000);
    return refuse(429, { error: "too many attempts", retry_after_s: retryS }, { "retry-after": String(retryS) });
  }
  const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (presented !== undefined && constantTimeMatch(presented, mcpTokens)) {
    authAttempts.delete(key); // a good token clears the source's record, exactly as a good human_key does
    authAudit("mcp_success", source, now);
    return true;
  }
  const tripped = authFailed(key, now);
  authAudit("mcp_failure", source, now);
  if (tripped) {
    authAudit("mcp_lockout", source, now);
    // One stderr line per trip, never per attempt.
    console.error(
      `rfa-hub http: locked out ${source} from ${req.method} ${(req.url ?? "/").split("?")[0]} for ${AUTH_LOCKOUT_MS / 1000}s after ${AUTH_MAX_FAILURES} bearer failures`,
    );
    const retryS = AUTH_LOCKOUT_MS / 1000;
    return refuse(429, { error: "too many attempts", retry_after_s: retryS }, { "retry-after": String(retryS) });
  }
  return refuse(
    401,
    { error: presented === undefined ? "Authorization: Bearer <token> required" : "invalid bearer token" },
    { "www-authenticate": 'Bearer realm="rfa-hub"' },
  );
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

function send(res: http.ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(data, null, 1));
}

function agentStatus(): unknown[] {
  const stateFile = path.join(ROOT, "data", "supervisor-state.json");
  const sup = fs.existsSync(stateFile)
    ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { agents?: Record<string, unknown> })
    : { agents: {} };
  return listPacks(AGENTS_DIR).map((p) => {
    const hb = path.join(p.dir, "state", "heartbeat");
    const hbAge = fs.existsSync(hb) ? Math.round((Date.now() - Number(fs.readFileSync(hb, "utf8"))) / 1000) : null;
    return {
      name: p.name,
      description: p.def.description,
      model: p.def.model ?? "inherit",
      effort: p.def.effort ?? null,
      definition_hash: p.definitionHash,
      rooms: p.def.rooms ?? [],
      offers: (p.def.offers ?? []).map((o) => o.id),
      heartbeat_age_s: hbAge,
      supervisor: (sup.agents as Record<string, unknown>)?.[p.name] ?? null,
    };
  });
}

async function workbench(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  try {
    if (req.method === "POST" && pathname === "/auth") {
      const now = Date.now();
      const source = authSource(req);
      // The lock gates the endpoint, not just wrong keys: a locked source never
      // reaches the comparison, so the limit cannot be outrun.
      const locked = authLockoutMs(source, now);
      if (locked > 0) {
        authAudit("failure", source, now);
        const retryS = Math.ceil(locked / 1000);
        return send(res, 429, { error: "too many attempts", retry_after_s: retryS }, { "retry-after": String(retryS) });
      }
      const b = await body(req);
      if (typeof b.human_key !== "string" || !humanKeyMatches(b.human_key)) {
        const tripped = authFailed(source, now);
        authAudit("failure", source, now);
        if (!tripped) return send(res, 401, { error: "invalid human_key" });
        authAudit("lockout", source, now);
        // One stderr line per trip, never per attempt: a silent throttle is as
        // undiagnosable as a silent 403, but an anonymous caller must not be
        // able to write the log a line at a time.
        console.error(`rfa-hub http: locked out ${source} from POST /auth for ${AUTH_LOCKOUT_MS / 1000}s after ${AUTH_MAX_FAILURES} failures`);
        const retryS = AUTH_LOCKOUT_MS / 1000;
        return send(res, 429, { error: "too many attempts", retry_after_s: retryS }, { "retry-after": String(retryS) });
      }
      authAttempts.delete(source); // a good key clears the source's record
      authAudit("success", source, now);
      const token = "st_" + randomBytes(24).toString("base64url");
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      return send(res, 200, { session_token: token, ttl_s: SESSION_TTL_MS / 1000 });
    }
    // Every route below this line is operator-only: reads included.
    if (!authed(req)) return send(res, 401, { error: "session token required (POST /auth)" });
    if (req.method === "GET" && pathname === "/api/agents") return send(res, 200, agentStatus());
    const defMatch = /^\/api\/agents\/([\w.-]+)\/definition$/.exec(pathname);
    if (defMatch) {
      const file = path.join(AGENTS_DIR, defMatch[1], "agent.md");
      if (!fs.existsSync(file)) return send(res, 404, { error: "no such agent" });
      if (req.method === "GET") return send(res, 200, { content: fs.readFileSync(file, "utf8") });
      if (req.method === "PUT") {
        if (!authed(req)) return send(res, 401, { error: "session token required (POST /auth)" });
        const b = await body(req);
        if (typeof b.content !== "string") return send(res, 400, { error: "body.content required" });
        try {
          const parsed = parseAgentMd(b.content);
          fs.writeFileSync(file, b.content); // the supervisor's file watch does the versioned drain
          return send(res, 200, { definition_hash: parsed.definitionHash });
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }
      }
    }
    const lifeMatch = /^\/api\/agents\/([\w.-]+)\/lifecycle$/.exec(pathname);
    if (req.method === "POST" && lifeMatch) {
      if (!authed(req)) return send(res, 401, { error: "session token required" });
      const b = await body(req);
      if (!["start", "stop", "restart"].includes(String(b.action))) return send(res, 400, { error: "action: start|stop|restart" });
      fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
      fs.appendFileSync(
        path.join(ROOT, "data", "supervisor-commands.ndjson"),
        JSON.stringify({ ts: new Date().toISOString(), agent: lifeMatch[1], action: b.action, principal: "console" }) + "\n",
      );
      return send(res, 202, { queued: true });
    }
    if (req.method === "GET" && pathname === "/api/runs") {
      const store = obs();
      if (!store) return send(res, 200, []);
      const u = new URL("http://x" + (req.url ?? ""));
      const trace = u.searchParams.get("trace");
      if (trace) return send(res, 200, store.trace(trace));
      return send(res, 200, store.runs({
        group_id: u.searchParams.get("group") ?? undefined,
        run_type: (u.searchParams.get("type") as never) ?? undefined,
        needs_review: u.searchParams.get("review") === "1" ? true : undefined,
        limit: Number(u.searchParams.get("limit") ?? 50),
      }));
    }
    if (req.method === "GET" && pathname === "/api/summary") {
      const store = obs();
      const u = new URL("http://x" + (req.url ?? ""));
      const windowM = Number(u.searchParams.get("window_m") ?? 60);
      return send(res, 200, store ? store.summary(windowM * 60_000) : null);
    }
    if (req.method === "POST" && pathname === "/api/feedback") {
      if (!authed(req)) return send(res, 401, { error: "session token required" });
      const store = obs();
      if (!store) return send(res, 400, { error: "no obs store" });
      const b = await body(req);
      if (typeof b.run_id !== "string" || typeof b.key !== "string") return send(res, 400, { error: "run_id and key required" });
      store.feedback({
        run_id: b.run_id, key: b.key, score: typeof b.score === "number" ? b.score : null,
        comment: typeof b.comment === "string" ? b.comment : null, source_type: "human",
      });
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && pathname === "/api/approvals") return send(res, 200, hub.pendingApprovals());

    // POST /api/ask (spec 17.5): asynchronous by construction, because a
    // 30-minute reply window cannot be held open on an HTTP request. Returns
    // 202 with an id to poll.
    if (req.method === "POST" && pathname === "/api/ask") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      if (!askRateOk(token)) {
        return send(res, 429, { error: "ask rate limit reached", retry_after_s: 300 }, { "Retry-After": "300" });
      }
      const b = await body(req);
      const question = typeof b.question === "string" ? b.question.trim() : "";
      const room = typeof b.room === "string" ? b.room : "";
      if (!room || !question) return send(res, 400, { error: "room and question are required" });
      if (question.length > 4000) return send(res, 400, { error: "question exceeds 4000 chars" });
      const replyByS = Number.isFinite(Number(b.reply_by_s)) ? Math.max(60, Number(b.reply_by_s)) : 1800;
      let membership: { membership_token: string; member_id: string };
      try {
        // Not the console membership: a supervisor cannot send (spec 12.1).
        membership = hub.captureMembership(room);
      } catch (err) {
        return send(res, 404, { error: (err as Error).message });
      }
      // Select by capability exactly as the CLI does, and refuse rather than
      // guess when the room is ambiguous.
      const roster = hub.roster({ room, membership_token: membership.membership_token }).roster;
      const capability = typeof b.capability === "string" ? b.capability : null;
      const candidates = roster.filter(
        (m) =>
          m.id !== membership.member_id &&
          m.role === "participant" &&
          (capability ? (m.card_summary.skill_ids ?? []).includes(capability) : (m.card_summary.skill_ids ?? []).length > 0),
      );
      if (candidates.length === 0) return send(res, 409, { error: "no_capable_member", capability });
      if (candidates.length > 1 && !capability) return send(res, 409, { error: "ambiguous_capability", candidates: candidates.map((m) => m.id) });
      const target = candidates.find((m) => m.state === "ready") ?? candidates[0];
      const askId = `ask_${randomBytes(8).toString("base64url")}`;
      const replyBy = new Date(Date.now() + replyByS * 1000).toISOString();
      const sent = await hub.send({
        room,
        membership_token: membership.membership_token,
        message_id: askId,
        kind: "request",
        mentions: [target.id],
        reply_by: replyBy,
        body: [{ type: "text", text: question }],
      });
      pendingAsks.set(askId, { room, asked: target.id, conversationId: sent.conversation_id, replyBy, asked_at: Date.now() });
      return send(res, 202, {
        ask_id: askId,
        asked_member: target.id,
        asked_name: target.name,
        conversation_id: sent.conversation_id,
        reply_by: replyBy,
        poll: `/api/ask/${askId}`,
      });
    }
    const askMatch = /^\/api\/ask\/([\w.-]+)$/.exec(pathname);
    if (req.method === "GET" && askMatch) {
      const rec = pendingAsks.get(askMatch[1]);
      if (!rec) return send(res, 404, { error: "unknown ask id" });
      const membership = hub.captureMembership(rec.room);
      const events = (await hub.listen({
        room: rec.room,
        membership_token: membership.membership_token,
        since: 0,
        timeout_ms: 0,
        wait_for: "all",
      })) as { events: { type: string; envelope?: Record<string, unknown> }[] };
      const reply = events.events.find(
        (e) => e.type === "message" && (e.envelope as { in_reply_to?: string })?.in_reply_to === askMatch[1],
      );
      if (!reply) {
        const expired = Date.parse(rec.replyBy) < Date.now();
        return send(res, 200, { ask_id: askMatch[1], state: expired ? "no_reply" : "pending", reply_by: rec.replyBy });
      }
      const env = reply.envelope as {
        kind: string;
        body: { type: string; text?: string }[];
        refusal?: { reason: string; detail?: string };
      };
      return send(res, 200, {
        ask_id: askMatch[1],
        state: env.kind === "refuse" ? "refused" : "answered",
        text: env.body.filter((p) => p.type === "text").map((p) => p.text).join("\n"),
        refusal: env.refusal ?? null,
      });
    }
    if (req.method === "POST" && pathname === "/api/approvals/decide") {
      if (!authed(req)) return send(res, 401, { error: "session token required" });
      const b = await body(req);
      if (typeof b.room !== "string" || typeof b.request_id !== "string" || !["approve", "reject"].includes(String(b.verb))) {
        return send(res, 400, { error: "room, request_id, verb: approve|reject required" });
      }
      const membership = hub.consoleMembership(b.room);
      const result = await hub.admin({
        room: b.room,
        membership_token: membership.membership_token,
        verb: b.verb as "approve" | "reject",
        target: b.request_id,
        ...(b.params && typeof b.params === "object" ? { params: b.params as Record<string, unknown> } : {}),
      });
      return send(res, 200, result);
    }
    send(res, 404, { error: "no such workbench route" });
  } catch (err) {
    send(res, 500, { error: (err as Error).message });
  }
}

  // The room console: a static, self-contained page that speaks MCP to /mcp
  // on this same origin. Read per request so edits show up without a restart.
  const consoleFile = path.join(import.meta.dirname ?? ".", "..", "console", "index.html");
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = (req.url ?? "/").split("?")[0];
      // DNS-rebinding defense (MCP 2026-07-28 Streamable HTTP: Origin
      // validation is a MUST, loopback binding a SHOULD). Only BROWSER
      // requests carry Origin, so a missing header is a non-browser client and
      // passes; a present-but-unlisted one is refused and logged, because
      // whether a proxy rewrites Host or Origin is deployment-specific and a
      // silent 403 on the first phone request is impossible to diagnose.
      if (!originAllowed(req)) {
        console.error(
          `rfa-hub http: refused cross-origin ${req.method} ${pathname} (origin=${req.headers.origin ?? "-"} host=${req.headers.host ?? "-"}); allow it with --allow-origin`,
        );
        return send(res, 403, { error: "origin not allowed" });
      }
      if (pathname === "/auth" || pathname.startsWith("/api/")) {
        await workbench(req, res, pathname);
        return;
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/console")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store", // the file is read per request; never let a browser pin an old build
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        });
        res.end(fs.readFileSync(consoleFile, "utf8"));
        return;
      }
      // Everything from here down falls through to the MCP handler, so this is
      // the credential check sect. 4.2 item 1 requires "before the MCP handler
      // sees it". It gates the whole fall-through rather than the literal /mcp
      // path, because any other pathname reaches the same handler. A no-op
      // unless --mcp-token/RFA_MCP_TOKENS is configured.
      //
      // The workbench routes and the console document handled above are
      // deliberately outside this gate: they keep the session token from
      // POST /auth and the private-network posture of v0.5 sect. 17.1. Two
      // audiences, two proxies, two credentials (sect. 4.5), and a browser
      // cannot put a bearer on a document load in any case.
      if (!mcpAuthorized(req, res)) return;
      const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const hasBody = chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers,
        body: hasBody ? new Uint8Array(Buffer.concat(chunks)) : undefined,
      });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      console.error(`rfa-hub http: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  // Loopback by default: the previous `listen(port)` bound every interface, so
  // any device on the laptop's network could read the workbench.
  const bindHost = arg("--bind") ?? "127.0.0.1";
  watchCards();
  server.listen(port, bindHost, () => {
    console.error(
      `rfa-hub: Streamable HTTP MCP at http://localhost:${port}/mcp (data: ${dataArg}, dual-era); console at http://localhost:${port}/console`,
    );
    if (pushUrl) {
      console.error(
        `rfa-hub: notification-only push on (${new URL(pushUrl).host}${consoleBase ? `, links to ${consoleBase}` : ", no --console-url so notifications carry no link"}). Never a credential, never an approve button: the console is the only verdict surface`,
      );
    }
    console.error(
      `rfa-hub: bound ${bindHost}${bindHost === "127.0.0.1" ? " (loopback only; proxy a tailnet to it rather than passing --bind)" : " -- REACHABLE OFF-HOST: every workbench read needs a session token, but prefer --bind 127.0.0.1 behind a proxy"}`,
    );
    // Never make an operator guess which mode is in force: the two differ by
    // whether room_create takes a credential at all.
    console.error(
      mcpTokens.length
        ? `rfa-hub: /mcp AUTHENTICATED: Authorization: Bearer required on every request (${mcpTokens.length} operator token${mcpTokens.length === 1 ? "" : "s"}; 401 otherwise, failures rate-limited and counted in auth.log.ndjson). Clients without a header, src/client.ts included, will be refused`
        : `rfa-hub: /mcp UNAUTHENTICATED: no --mcp-token/RFA_MCP_TOKENS set, so anything that reaches this listener can call room_create. This is the default and the loopback bind is the only gate; set tokens before exposing /mcp through any proxy`,
    );
  });
} else {
  serveStdio(() => createHubServer(hub), {
    legacy: "serve",
    onerror: (e) => console.error(`rfa-hub stdio: ${e.message}`),
  });
  console.error(`rfa-hub: MCP server on stdio (data: ${dataArg}, dual-era)`);
  if (mcpTokens.length) {
    // Silently ignoring a configured credential is how an operator comes to
    // believe a surface is guarded when it is not.
    console.error(
      "rfa-hub: --mcp-token/RFA_MCP_TOKENS has no effect on stdio (no HTTP transport to authenticate; the process boundary is the gate). Pass --http to use it",
    );
  }
}
