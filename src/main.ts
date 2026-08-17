#!/usr/bin/env node
/**
 * rfa-hub entrypoint (MCP v2 SDK: dual-era serving, server/discover native).
 *
 *   rfa-hub                    stdio MCP server, dual-era (for `claude mcp add`, Cursor, etc.)
 *   rfa-hub --http 8790        Streamable HTTP MCP server (stateless, modern era + legacy fallback)
 *   rfa-hub --data ./data      persistence directory (default ./data; "none" disables)
 *   rfa-hub --trusted-keys k.json   provisioned {kid: publicJWK} map for card verification
 *   rfa-hub --require-signed        refuse joins whose card cannot be verified
 *   rfa-hub --human-key k1,k2       provisioned human-principal keys (joins presenting one get origin=human;
 *                                   required for room_admin approve and quarantine release). Also RFA_HUMAN_KEYS.
 *   rfa-hub --otel                  emit one compact stderr line per tool-call span (spec 13). Without this
 *                                   flag spans are no-ops unless the operator registers their own OTel SDK.
 *   rfa-hub --bind 0.0.0.0          HTTP bind address (default 127.0.0.1: loopback only, per MCP
 *                                   2026-07-28 Streamable HTTP guidance). Reach a loopback hub from
 *                                   another device with a proxy that terminates identity
 *                                   (`tailscale serve` proxies http://127.0.0.1), never by widening this.
 *   rfa-hub --allow-origin a,b      extra browser origins allowed to POST (localhost forms are always
 *                                   allowed; a request with NO Origin header, i.e. any non-browser
 *                                   client, is unaffected). Rejections are logged with the value seen.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { listPacks, parseAgentMd } from "./agentdef.js";
import { createHubServer } from "./hub.js";
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

function authed(req: http.IncomingMessage): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) return false;
  sessions.set(m[1], Date.now() + SESSION_TTL_MS); // sliding
  return true;
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

function send(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
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
      const b = await body(req);
      if (typeof b.human_key !== "string" || !hub.cfg.humanKeys.includes(b.human_key)) {
        return send(res, 401, { error: "invalid human_key" });
      }
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
  server.listen(port, bindHost, () => {
    console.error(
      `rfa-hub: Streamable HTTP MCP at http://localhost:${port}/mcp (data: ${dataArg}, dual-era); console at http://localhost:${port}/console`,
    );
    console.error(
      `rfa-hub: bound ${bindHost}${bindHost === "127.0.0.1" ? " (loopback only; proxy a tailnet to it rather than passing --bind)" : " -- REACHABLE OFF-HOST: every workbench read needs a session token, but prefer --bind 127.0.0.1 behind a proxy"}`,
    );
  });
} else {
  serveStdio(() => createHubServer(hub), {
    legacy: "serve",
    onerror: (e) => console.error(`rfa-hub stdio: ${e.message}`),
  });
  console.error(`rfa-hub: MCP server on stdio (data: ${dataArg}, dual-era)`);
}
