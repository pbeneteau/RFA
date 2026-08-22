/**
 * One way for the CLI to call hub tools, whether or not the hub daemon is up.
 *
 * Over HTTP when `GET /healthz` answers (the same `rawCall` every resident uses,
 * bearer included). In-process otherwise: the hub directory's own store opened
 * here, behind the same MCP server the daemon serves, over an in-memory
 * transport, so `room_create`, `set_policy` and `room_join` run through exactly
 * the code they run through on the wire. That is what lets `rfa init` provision
 * rooms before anything is started and `rfa migrate`'s follow-up work with the
 * daemons down. The store lock makes the two exclusive: an in-process open
 * against a live hub fails loudly, which is the right answer.
 *
 * The in-process path knows no transport bearer (request context is only set by
 * the HTTP layer), so joins there use the join secret or the human key; the
 * CLI's own memberships are human-origin anyway.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "node:fs";
import { rawCall, RfaClientError } from "../client.js";
import { parsePrincipalsFile } from "../credentials.js";
import { createHubServer } from "../hub.js";
import { readJsonFile, type HubDir } from "../hubdir.js";
import { packageVersion } from "../pkg.js";
import { PrincipalSet } from "../principals.js";
import { RoomHub } from "../store.js";
import { CliError, type CliContext } from "./context.js";

export interface HubCall {
  transport: "http" | "inproc";
  call(tool: string, args: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

const clientInfo = () => ({ name: "rfa-cli", version: packageVersion() });

export async function openHubCall(ctx: CliContext, opts: { prefer?: "http" | "inproc" } = {}): Promise<HubCall> {
  const h = ctx.hubdir();
  ctx.armTransport();
  const up = opts.prefer === "inproc" ? false : await ctx.healthz();
  if (up) {
    const url = ctx.hubUrl();
    return {
      transport: "http",
      call: (tool, args) => rawCall(url, clientInfo(), tool, args),
      close: async () => {},
    };
  }
  if (h.mode !== "hub") {
    throw new CliError(3, `the hub at ${h.hubUrl} is not answering and this directory does not run one`, "check the far hub, or its URL in rfa.json");
  }
  return openInProcess(h);
}

/** The hub directory's store, in this process, behind the real MCP server. Throws when a live hub holds the lock. */
export async function openInProcess(h: HubDir): Promise<HubCall> {
  const principals = PrincipalSet.fromRecords(readJsonFile(h.paths.principals, () => ({ version: 1 as const, principals: [] }), parsePrincipalsFile).principals);
  let hub: RoomHub;
  try {
    hub = new RoomHub({
      dataDir: h.paths.data,
      principals,
      gateChecks: h.paths.gate && fs.existsSync(h.paths.gate) ? JSON.parse(fs.readFileSync(h.paths.gate, "utf8")) : [],
      trustedKeys: h.paths.trustedKeys && fs.existsSync(h.paths.trustedKeys) ? JSON.parse(fs.readFileSync(h.paths.trustedKeys, "utf8")) : {},
      requireSignedCards: "port" in h.manifest.hub ? h.manifest.hub.require_signed_cards : false,
    });
  } catch (err) {
    throw new CliError(3, `cannot open the store in this process: ${(err as Error).message}`, "a hub is serving it; use it over HTTP (rfa status), or stop it first");
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createHubServer(hub);
  const client = new Client(clientInfo());
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    transport: "inproc",
    async call(tool, args) {
      const res = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      let inner: any;
      try {
        inner = JSON.parse(res.content[0].text);
      } catch {
        throw new RfaClientError("bad_tool_result", `${tool}: ${String(res.content?.[0]?.text).slice(0, 200)}`);
      }
      if (res.isError || inner.error) {
        const e = inner.error ?? { code: "unknown", message: "tool error" };
        throw new RfaClientError(e.code, e.message, e.data ?? {});
      }
      return inner;
    },
    async close() {
      await client.close().catch(() => {});
      hub.close();
    },
  };
}
