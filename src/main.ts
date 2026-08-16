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
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createHubServer } from "./hub.js";
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
      }
      done({ code: 0 });
    },
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter as never)] });
  trace.setGlobalTracerProvider(provider);
  console.error("rfa-hub: otel span logging on (stderr)");
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
  // The room console: a static, self-contained page that speaks MCP to /mcp
  // on this same origin. Read per request so edits show up without a restart.
  const consoleFile = path.join(import.meta.dirname ?? ".", "..", "console", "index.html");
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = (req.url ?? "/").split("?")[0];
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
  server.listen(port, () => {
    console.error(
      `rfa-hub: Streamable HTTP MCP at http://localhost:${port}/mcp (data: ${dataArg}, dual-era); console at http://localhost:${port}/console`,
    );
  });
} else {
  serveStdio(() => createHubServer(hub), {
    legacy: "serve",
    onerror: (e) => console.error(`rfa-hub stdio: ${e.message}`),
  });
  console.error(`rfa-hub: MCP server on stdio (data: ${dataArg}, dual-era)`);
}
