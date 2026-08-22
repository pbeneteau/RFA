/**
 * Editing what the CLI owns in agent.md: the `rooms:` and `knowledge:` blocks, and the `mode:` line.
 *
 * The file is the operator's; the CLI rewrites only the block it is asked to,
 * keeps every other line byte for byte, and validates the result through the
 * same schema the supervisor uses before writing it, so a bind or a knowledge
 * attach can never produce a pack the platform then refuses.
 */
import * as fs from "node:fs";
import { parseAgentMd } from "../agentdef.js";

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/;

export function roomsBlock(room: string, opts: { role?: "participant" | "observer"; serve?: boolean; presenceTtlS?: number } = {}): string {
  return [
    "rooms:",
    `  - room: ${room}`,
    `    role: ${opts.role ?? "participant"}`,
    `    serve: ${opts.serve ?? true}          # false makes it a listener that never answers`,
    `    presence_ttl_s: ${opts.presenceTtlS ?? 180}  # the lease: miss two renewals and the room marks it offline`,
    "    auto_resume: true    # reuse the saved membership across restarts",
  ].join("\n");
}

export function knowledgeBlock(globs: string[]): string {
  return ["knowledge:", ...globs.map((g) => `  - ${JSON.stringify(g)}`)].join("\n");
}

/** The scaffold's commented-out placeholders, removed when a real block lands. */
const PLACEHOLDER: Record<string, RegExp> = {
  rooms: /^# (No room binding yet|  rfa agent bind|rooms:|  - room:|    role:|    serve:|    presence_ttl_s:|    auto_resume:)/,
  knowledge: /^# (No knowledge yet|  rfa knowledge add|knowledge:|  - "knowledge\/)/,
};

/** Replace (or add) one top-level block of an agent.md frontmatter. */
export function setTopBlock(text: string, key: "rooms" | "knowledge", block: string): string {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("agent.md must start with a YAML frontmatter block (--- ... ---)");
  const lines = m[2].split("\n");
  const out: string[] = [];
  let i = 0;
  let replaced = false;
  const head = new RegExp(`^${key}:`);
  while (i < lines.length) {
    const line = lines[i];
    if (head.test(line)) {
      // Skip the existing block: the key line and every indented or blank line under it.
      i++;
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === "")) i++;
      if (!replaced) {
        out.push(...block.split("\n"));
        replaced = true;
      }
      continue;
    }
    if (PLACEHOLDER[key].test(line)) {
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  if (!replaced) {
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push(...block.split("\n"));
  }
  return `${m[1]}${out.join("\n")}${m[3]}${m[4]}`;
}

export const setRoomsBlock = (text: string, block: string): string => setTopBlock(text, "rooms", block);

/** Rewrite the binding in a pack's agent.md, validated before the write. Returns the definition hashes. */
export function bindPack(file: string, room: string, opts: { role?: "participant" | "observer"; serve?: boolean } = {}): { before: string; after: string } {
  const text = fs.readFileSync(file, "utf8");
  const before = parseAgentMd(text).definitionHash;
  const next = setRoomsBlock(text, roomsBlock(room, opts));
  const after = parseAgentMd(next).definitionHash;
  if (after !== before) fs.writeFileSync(file, next);
  return { before, after };
}

/** Add knowledge globs to a pack's agent.md (deduplicated, order kept), validated before the write. */
export function addKnowledge(file: string, globs: string[]): { before: string; after: string; knowledge: string[] } {
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseAgentMd(text);
  const merged = [...new Set([...(parsed.def.knowledge ?? []), ...globs])];
  const next = setTopBlock(text, "knowledge", knowledgeBlock(merged));
  const after = parseAgentMd(next).definitionHash;
  if (after !== parsed.definitionHash) fs.writeFileSync(file, next);
  return { before: parsed.definitionHash, after, knowledge: merged };
}

/** Replace (or add, before `sandbox:` or at the end) one top-level scalar line of the frontmatter. */
export function setTopScalar(text: string, key: string, line: string): string {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("agent.md must start with a YAML frontmatter block (--- ... ---)");
  const lines = m[2].split("\n");
  const at = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (at >= 0) lines[at] = line;
  else {
    const before = lines.findIndex((l) => /^sandbox:/.test(l));
    if (before >= 0) lines.splice(before, 0, line);
    else lines.push(line);
  }
  return `${m[1]}${lines.join("\n")}${m[3]}${m[4]}`;
}

/** Set a pack's mode in its agent.md, validated before the write. */
export function setAgentMode(file: string, mode: "ask" | "plan" | "auto" | "bypass"): { before: string; after: string } {
  const text = fs.readFileSync(file, "utf8");
  const before = parseAgentMd(text).definitionHash;
  const next = setTopScalar(text, "mode", `mode: ${mode}   # ask: cards for every acting tool · plan: proposes, never acts · auto: the SDK's classifier decides · bypass: acts without asking`);
  const after = parseAgentMd(next).definitionHash;
  if (after !== before) fs.writeFileSync(file, next);
  return { before, after };
}
