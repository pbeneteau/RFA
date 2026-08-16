/**
 * Agent pack definitions (RFA v0.4 spec section 3): the ONE zod schema shared
 * by the resident runner, the supervisor, and (later) the console editor.
 *
 * A pack is a directory `agents/<name>/` whose `agent.md` is YAML frontmatter
 * (the definition, inert data) plus a markdown body (the system prompt).
 * The capability card and its digest are DERIVED from the definition, so a
 * definition edit rotates the digest and is visible in every roster.
 *
 * Spec delta (to fold into RFA-0.4 3.2): `offers` is the explicit list of
 * room-facing card skills; `skills` stays reserved for Agent SDK skill packs.
 * Deriving card skills from SKILL.md folders conflated two different things.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import * as z from "zod";
import { sha256hex } from "./jcs.js";
import type { AgentCard } from "./model.js";

export const agentDefSchema = z.object({
  rfa_agent: z.literal(1),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  tools: z
    .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
    .optional(),
  skills: z.array(z.string()).optional(),
  knowledge: z.array(z.string()).optional(),
  offers: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1).max(1024),
        input_schema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  memory: z
    .object({
      scope: z.literal("pack").default("pack"),
      blocks: z.array(z.string()).optional(),
      gate: z.literal("memory-gate").default("memory-gate"),
    })
    .optional(),
  sandbox: z
    .object({
      isolation: z.enum(["none", "worktree", "container"]).default("none"),
      permission_mode: z.enum(["default", "dontAsk"]).default("default"),
      network: z.enum(["none", "allowlist", "open"]).default("none"),
      allowed_domains: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    })
    .optional(),
  secrets: z.array(z.string()).optional(),
  budgets: z
    .object({
      max_turns: z.number().int().min(1).max(200).optional(),
      max_execution_s: z.number().int().min(1).optional(),
      max_rpm: z.number().int().min(1).optional(),
      max_retries: z.number().int().min(0).optional(),
      per_task_usd: z.number().positive().optional(),
      per_day_usd: z.number().positive().optional(),
    })
    .optional(),
  interrupt_on: z
    .record(
      z.string(),
      z.union([
        z.boolean(),
        z.object({ allowed_decisions: z.array(z.enum(["approve", "edit", "reject", "respond"])) }),
      ]),
    )
    .optional(),
  rooms: z
    .array(
      z.object({
        room: z.string().optional(),
        topic: z.string().optional(),
        role: z.enum(["participant", "observer"]).default("participant"),
        serve: z.boolean().default(true),
        presence_ttl_s: z.number().int().min(30).max(900).optional(),
        auto_resume: z.boolean().default(true),
      }),
    )
    .optional(),
  schedules: z
    .array(z.object({ cron: z.string(), timezone: z.string().optional(), prompt: z.string() }))
    .optional(),
});

export type AgentDef = z.infer<typeof agentDefSchema>;

export interface AgentPack {
  name: string;
  dir: string;
  def: AgentDef;
  /** The markdown body of agent.md: the system prompt. */
  prompt: string;
  /** sha256 over the full agent.md content: the deployed-version marker. */
  definitionHash: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse an agent.md string. Throws with a precise message on any invalid input. */
export function parseAgentMd(content: string): { def: AgentDef; prompt: string; definitionHash: string } {
  const m = FRONTMATTER.exec(content);
  if (!m) throw new Error("agent.md must start with a YAML frontmatter block (--- ... ---)");
  let raw: unknown;
  try {
    raw = YAML.parse(m[1]);
  } catch (err) {
    throw new Error(`agent.md frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = agentDefSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`agent.md definition invalid at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const def = parsed.data;
  const serves = (def.rooms ?? []).some((r) => r.serve && r.role === "participant");
  if (serves && !(def.offers ?? []).length) {
    throw new Error("a pack that serves a room as participant must declare at least one entry in `offers` (its card skills)");
  }
  const prompt = m[2].trim();
  if (!prompt) throw new Error("agent.md needs a markdown body: it is the system prompt");
  return { def, prompt, definitionHash: "sha256:" + sha256hex(content) };
}

/** Load a pack directory (`agents/<name>/`). */
export function loadPack(dir: string): AgentPack {
  const file = path.join(dir, "agent.md");
  const content = fs.readFileSync(file, "utf8");
  const { def, prompt, definitionHash } = parseAgentMd(content);
  return { name: def.name, dir, def, prompt, definitionHash };
}

/** List every pack under an agents root, skipping directories without agent.md. */
export function listPacks(root: string): AgentPack[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "agent.md")))
    .map((e) => loadPack(path.join(root, e.name)));
}

/**
 * The capability card DERIVED from the definition (spec 3.1): name,
 * description, offers as card skills, and the definition hash so a definition
 * edit rotates the roster digest (the deployed-version signal).
 */
export function deriveCard(pack: AgentPack): AgentCard {
  return {
    name: pack.def.name,
    description: pack.def.description,
    version: "0.4.0",
    skills: (pack.def.offers ?? []).map((o) => ({
      id: o.id,
      description: o.description,
      ...(o.input_schema ? { inputSchema: o.input_schema } : {}),
    })),
    definition_hash: pack.definitionHash,
  };
}

/** Resolve the pack's knowledge globs to existing absolute file paths (for prompt instructions, not stuffing). */
export function knowledgeFiles(pack: AgentPack): string[] {
  const out: string[] = [];
  for (const pattern of pack.def.knowledge ?? []) {
    const base = path.resolve(pack.dir, pattern.replace(/\*\*?.*$/, ""));
    if (pattern.includes("*")) {
      walk(base, out);
    } else if (fs.existsSync(base)) {
      out.push(base);
    }
  }
  return [...new Set(out)].filter((f) => f.endsWith(".md") && fs.existsSync(f));
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
}
