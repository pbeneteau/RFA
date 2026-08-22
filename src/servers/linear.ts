/**
 * The Linear tools as a stdio MCP server: `search_project` and `save_document`
 * (v0.4.6), moved OUT of the generic resident runner in v0.7.
 *
 * They used to be an in-process tool server hard-coded into `src/resident.ts`,
 * which meant every agent pack on every hub carried one tenant's Linear
 * integration, and a pack that brought a different tool had no way to load it.
 * A pack now declares the servers it brings (`mcp_servers`, v0.4 sect. 3.2);
 * this one is declared as `{ builtin: "linear" }` and runs through the tool's
 * own entry, with `LINEAR_API_KEY` injected by NAME from the hub directory's
 * secrets file.
 *
 * Without `LINEAR_API_KEY` it runs in dry-run mode: `save_document` writes the
 * draft to `RFA_DRAFTS_DIR` (the pack's `state/drafts/`) for a human to paste.
 * The parent-required preflight that used to sit in the runner is now the
 * generic `require_one_of` on the pack's `interrupt_on` rule, so a parentless
 * save is bounced back to the model BEFORE a human is paged.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";

const KEY = process.env.LINEAR_API_KEY;
const DRAFTS = process.env.RFA_DRAFTS_DIR ?? path.join(process.cwd(), "drafts");

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
const error = (err: unknown) => ({ content: [{ type: "text" as const, text: `error: ${(err as Error).message}` }], isError: true });

async function gql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: KEY! },
    body: JSON.stringify({ query, variables }),
  });
  const data = (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] };
  if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join("; "));
  return data.data ?? {};
}

export function buildLinearServer(): McpServer {
  const server = new McpServer({ name: "linear", version: "0.7.0" });
  server.registerTool(
    "search_project",
    {
      description: "Find a Linear project or team by name (returns ids). ALWAYS use before save_document: a live save requires exactly one parent (project_id or team_id).",
      inputSchema: { query: z.string() },
    },
    async ({ query }) => {
      if (!KEY) return text("[dry-run] LINEAR_API_KEY not configured: skip project linking and save without a project.");
      try {
        const data = await gql(
          `query($q: String!) {
             projects(filter: { name: { containsIgnoreCase: $q } }, first: 5) { nodes { id name state } }
             teams(filter: { name: { containsIgnoreCase: $q } }, first: 5) { nodes { id name key } }
           }`,
          { q: query },
        );
        return text({ projects: (data.projects as { nodes: unknown[] }).nodes, teams: (data.teams as { nodes: unknown[] }).nodes });
      } catch (err) {
        return error(err);
      }
    },
  );
  server.registerTool(
    "save_document",
    {
      description:
        "Create a Linear document with the final draft. REQUIRES human approval (the call pauses on an approve/edit/reject decision). Call exactly once, with the complete markdown. Linear requires exactly one parent: pass project_id OR team_id (find either with search_project first).",
      inputSchema: { title: z.string(), content: z.string(), project_id: z.string().optional(), team_id: z.string().optional() },
    },
    async ({ title, content, project_id, team_id }) => {
      if (!KEY) {
        fs.mkdirSync(DRAFTS, { recursive: true });
        const file = path.join(DRAFTS, `${new Date().toISOString().slice(0, 19).replace(/[:]/g, "-")}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`);
        fs.writeFileSync(file, `# ${title}\n\n${content}\n`);
        return text(`[dry-run] LINEAR_API_KEY not configured; draft saved to ${file}. A human can paste it into Linear.`);
      }
      // Linear enforces exactly one parent at runtime (found live: the first
      // approved save died on it, wasting a human decision).
      if (!project_id && !team_id) return error(new Error("Linear requires exactly one parent for a document. Call search_project, then retry with project_id or team_id."));
      try {
        const data = await gql(
          `mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { success document { id title url } } }`,
          { input: { title, content, ...(project_id ? { projectId: project_id } : { teamId: team_id }) } },
        );
        return text((data.documentCreate as { document: unknown }).document);
      } catch (err) {
        return error(err);
      }
    },
  );
  return server;
}

export async function serveLinear(): Promise<void> {
  await buildLinearServer().connect(new StdioServerTransport());
}

if (/servers[\\/]linear\.(ts|js)$/.test(process.argv[1] ?? "")) await serveLinear();
