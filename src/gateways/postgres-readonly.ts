/**
 * The built-in read-only Postgres gateway (`gateways: { <name>: { builtin:
 * "postgres-readonly" } }` in rfa.json), shipped in this package so a database
 * agent needs ZERO operator code.
 *
 * Why it exists at all: the OS sandbox refuses raw TCP outright (measured
 * 2026-08-31: `connect: Operation not permitted` even to an allow-listed IP -
 * srt's egress is an HTTP-CONNECT proxy with no notion of a database socket).
 * So no pack process can speak Postgres, and neither can a command-form MCP
 * server, which is always sandboxed (rung 8). The one working door is HTTP
 * from the resident process itself: a `url`-form MCP server. This gateway is
 * that server - an OPERATOR process the supervisor runs beside the residents,
 * holding the credential and the raw TCP, exposing one `query_<target>` tool
 * per database over localhost.
 *
 * It was first hand-written into a hub directory to unblock the first real
 * database agent (ledger 85's measured case), which proved the shape and also
 * proved the problem: infrastructure every org needs cannot be a bespoke
 * script. `mcp_servers` already ships `builtin: linear` for exactly this
 * reason; this is the gateway counterpart.
 *
 * Read-only is enforced three ways, none trusting the others:
 *   1. The operator's DB role should be read-only - that is the REAL boundary,
 *      and this process cannot verify it for them; the docs say to verify.
 *   2. Every query runs inside `BEGIN READ ONLY` with a statement timeout,
 *      then ROLLBACK - a write errors at the transaction level regardless.
 *   3. A syntactic guard rejects anything whose first keyword is not read-
 *      shaped, and multi-statement strings. Belt to the braces.
 *
 * Config from the environment (the supervisor injects `env` and the values of
 * `env_secrets` from `.rfa/secrets.json`):
 *   GW_PORT (default 8899), GW_TARGETS (comma-separated names; default the
 *   single target "db"), and per target either GW_<NAME>_URL (one Postgres
 *   connection string - the form an rfa secret carries) or the discrete
 *   GW_<NAME>_{HOST,PORT,USER,PASS,DB}. GW_STMT_TIMEOUT_MS, GW_MAX_ROWS tune.
 *
 * Stateless streamable HTTP: a fresh McpServer + transport PER REQUEST. The
 * single-transport stateful pattern dropped the `initialized` notification
 * (measured 2026-08-31); one operator and low volume make correctness the
 * only thing worth optimizing.
 */
import * as http from "node:http";
import pg from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.GW_PORT || 8899);
const STMT_TIMEOUT_MS = Number(process.env.GW_STMT_TIMEOUT_MS || 15_000);
const MAX_ROWS = Number(process.env.GW_MAX_ROWS || 500);
const targets = (process.env.GW_TARGETS || "db").split(",").map((s) => s.trim()).filter(Boolean);

const READ_FIRST = /^\s*(select|with|explain|show|table|values)\b/i;

/** Reject anything not read-shaped, and multi-statement strings (exported for the test). */
export function assertReadOnly(sql: string): void {
  const trimmed = sql.replace(/^\s*--.*$/gm, "").trim();
  if (!READ_FIRST.test(trimmed)) throw new Error("only read queries are allowed (must start with SELECT/WITH/EXPLAIN/SHOW/TABLE/VALUES)");
  const withoutStrings = trimmed.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
  if (withoutStrings.replace(/;\s*$/, "").includes(";")) throw new Error("one statement per call");
}

function poolFor(name: string): pg.Pool {
  const v = (k: string) => process.env[`GW_${name.toUpperCase()}_${k}`];
  if (!v("URL") && !v("HOST")) {
    console.error(`gateway: no GW_${name.toUpperCase()}_URL or GW_${name.toUpperCase()}_HOST in the environment (declare it in env_secrets or env)`);
    process.exit(1);
  }
  return new pg.Pool({
    ...(v("URL") ? { connectionString: v("URL") } : { host: v("HOST"), port: Number(v("PORT") || 5432), user: v("USER"), password: v("PASS"), database: v("DB") }),
    max: 2,
    application_name: `rfa-gateway:${name}`,
    statement_timeout: STMT_TIMEOUT_MS,
  });
}

// Lazy: constructed on first use, so importing this module (the test imports
// `assertReadOnly`) has no side effect and no environment requirement.
const pools = new Map<string, pg.Pool>();
function pool(name: string): pg.Pool {
  let p = pools.get(name);
  if (!p) {
    p = poolFor(name);
    pools.set(name, p);
  }
  return p;
}

async function runQuery(name: string, sql: string): Promise<Record<string, unknown>> {
  assertReadOnly(sql);
  const client = await pool(name).connect();
  try {
    await client.query("begin read only");
    await client.query(`set local statement_timeout = ${STMT_TIMEOUT_MS}`);
    const res = await client.query(sql);
    await client.query("rollback");
    const rows = res.rows.slice(0, MAX_ROWS);
    return { rowCount: res.rowCount, returned: rows.length, truncated: (res.rowCount ?? rows.length) > MAX_ROWS, rows };
  } finally {
    try {
      await client.query("rollback");
    } catch {
      /* already rolled back */
    }
    client.release();
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "rfa-postgres-readonly", version: "1.0.0" });
  for (const name of targets) {
    server.registerTool(
      `query_${name}`,
      {
        title: `Query ${name} (read-only)`,
        description:
          `Run ONE read-only SQL query against the ${name} Postgres database and get JSON rows. ` +
          `Read-only is enforced three ways (role, READ ONLY transaction, syntactic guard). ` +
          `Max ${MAX_ROWS} rows; ${STMT_TIMEOUT_MS} ms statement timeout.`,
        inputSchema: { sql: z.string().describe("a single SELECT/WITH/EXPLAIN statement") },
      },
      async ({ sql }: { sql: string }) => {
        try {
          const out = await runQuery(name, sql);
          return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
        } catch (e) {
          return { content: [{ type: "text" as const, text: `query error: ${(e as Error).message}` }], isError: true };
        }
      },
    );
  }
  return server;
}

// Entry: only serve when run directly (the test imports assertReadOnly).
if (process.argv[1] && /postgres-readonly\.(ts|js)$/.test(process.argv[1])) {
  http
    .createServer((req, res) => {
      if (req.url !== "/mcp") return void res.writeHead(404).end("not found");
      const ra = req.socket.remoteAddress || "";
      if (!ra.includes("127.0.0.1") && !ra.includes("::1")) return void res.writeHead(403).end("localhost only");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let parsed: unknown;
        try {
          parsed = body ? JSON.parse(body) : undefined;
        } catch {
          parsed = undefined;
        }
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, parsed as never);
        } catch (e) {
          if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String((e as Error).message ?? e) }));
        }
      });
    })
    .listen(PORT, "127.0.0.1", () => {
      console.error(`rfa postgres-readonly gateway on http://127.0.0.1:${PORT}/mcp — tools: ${targets.map((t) => `query_${t}`).join(", ")}`);
    });
}
