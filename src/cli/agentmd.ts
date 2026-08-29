/**
 * Editing what the CLI owns in agent.md: the `rooms:` and `knowledge:` blocks,
 * the `mode:` line, and since `rfa agent edit` became a walkthrough, the
 * settings a pack has (description, model, the capability, the budgets).
 *
 * The file is the operator's; the CLI rewrites only the line or block it is
 * asked to, keeps every other line byte for byte, and validates the result
 * through the same schema the supervisor uses before writing it, so an edit can
 * never produce a pack the platform then refuses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { parseAgentMd, type AgentDef } from "../agentdef.js";
import { effectiveMode, type AgentMode } from "../posture.js";

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

/**
 * Replace (or add) one top-level block of an agent.md frontmatter. The comment
 * lines the scaffold puts at the head of a block (the reason the block exists)
 * survive a rewrite; the entries under them are the caller's.
 */
export function setTopBlock(text: string, key: string, block: string): string {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("agent.md must start with a YAML frontmatter block (--- ... ---)");
  const lines = m[2].split("\n");
  const out: string[] = [];
  let i = 0;
  let replaced = false;
  const head = new RegExp(`^${key}:`);
  const placeholder = PLACEHOLDER[key];
  while (i < lines.length) {
    const line = lines[i];
    if (head.test(line)) {
      // Skip the existing block: the key line and every indented or blank line under it, keeping its leading comments.
      i++;
      const comments: string[] = [];
      while (i < lines.length && /^\s+#/.test(lines[i])) comments.push(lines[i++]);
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === "")) i++;
      if (!replaced) {
        const [first, ...rest] = block.split("\n");
        out.push(first, ...comments, ...rest);
        replaced = true;
      }
      continue;
    }
    if (placeholder?.test(line)) {
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
  const dir = path.dirname(file);
  const before = parseAgentMd(text, { dir }).definitionHash;
  const next = setRoomsBlock(text, roomsBlock(room, opts));
  const after = parseAgentMd(next, { dir }).definitionHash;
  if (after !== before) fs.writeFileSync(file, next);
  return { before, after };
}

/** Add knowledge globs to a pack's agent.md (deduplicated, order kept), validated before the write. */
export function addKnowledge(file: string, globs: string[]): { before: string; after: string; knowledge: string[] } {
  const text = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const parsed = parseAgentMd(text, { dir });
  const merged = [...new Set([...(parsed.def.knowledge ?? []), ...globs])];
  const next = setTopBlock(text, "knowledge", knowledgeBlock(merged));
  const after = parseAgentMd(next, { dir }).definitionHash;
  if (after !== parsed.definitionHash) fs.writeFileSync(file, next);
  return { before: parsed.definitionHash, after, knowledge: merged };
}

/**
 * Replace (or add) one top-level scalar line of the frontmatter. A missing line
 * goes after the key named in `after` when that one exists, else before
 * `sandbox:`, else at the end.
 */
export function setTopScalar(text: string, key: string, line: string, opts: { after?: string } = {}): string {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("agent.md must start with a YAML frontmatter block (--- ... ---)");
  const lines = m[2].split("\n");
  const at = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (at >= 0) lines[at] = line;
  else {
    const anchor = opts.after ? lines.findIndex((l) => new RegExp(`^${opts.after}:`).test(l)) : -1;
    const before = lines.findIndex((l) => /^sandbox:/.test(l));
    if (anchor >= 0) lines.splice(anchor + 1, 0, line);
    else if (before >= 0) lines.splice(before, 0, line);
    else lines.push(line);
  }
  return `${m[1]}${lines.join("\n")}${m[3]}${m[4]}`;
}

/**
 * Remove one key line from inside a nested block of the frontmatter, together
 * with the comment lines that continue it, and remove the block header too when
 * nothing is left under it.
 *
 * This exists for RFA-0.9 sect. 4.6: `sandbox.network` and
 * `sandbox.allowed_domains` were INERT settings written into every scaffolded
 * pack, and the cleanup has to reach packs already on disk. It removes a LINE
 * rather than re-serializing the block, for the same reason every other function
 * in this file does: the file is the operator's, and a YAML round-trip would
 * rewrite comments and ordering the operator wrote by hand.
 *
 * The header goes when the block empties because YAML would otherwise read
 * `sandbox:` with nothing under it as `null`, which the schema refuses - a
 * cleanup that leaves the pack unloadable is worse than the line it removed.
 */
export function dropNestedKey(text: string, block: string, key: string): string {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error("agent.md must start with a YAML frontmatter block (--- ... ---)");
  const lines = m[2].split("\n");
  const head = lines.findIndex((l) => new RegExp(`^${block}:`).test(l));
  if (head < 0) return text;
  const out = lines.slice(0, head + 1);
  let i = head + 1;
  let removed = false;
  let remaining = 0;
  while (i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === "")) {
    const line = lines[i];
    const indent = /^(\s*)/.exec(line)![1].length;
    if (new RegExp(`^\\s+${key}:`).test(line)) {
      removed = true;
      i++;
      // The comment lines that continue this key: comment-only and indented
      // deeper than the key itself (how the scaffold writes a multi-line note).
      while (i < lines.length && /^\s+#/.test(lines[i]) && /^(\s*)/.exec(lines[i])![1].length > indent) i++;
      continue;
    }
    if (/^\s+\S/.test(line) && !/^\s+#/.test(line)) remaining++;
    out.push(line);
    i++;
  }
  if (!removed) return text;
  // Nothing left under the header: drop the header (and any comment-only
  // remnants that belonged to it) rather than leaving `sandbox: null`.
  if (remaining === 0) out.length = head;
  out.push(...lines.slice(i));
  return `${m[1]}${out.join("\n")}${m[3]}${m[4]}`;
}

export const MODE_LINE = (mode: AgentMode): string => `mode: ${mode}   # ask: cards for every acting tool · plan: proposes, never acts · bypass: acts without asking`;

/** Set a pack's mode in its agent.md, validated before the write. */
export function setAgentMode(file: string, mode: "ask" | "plan" | "bypass"): { before: string; after: string } {
  const text = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const before = parseAgentMd(text, { dir }).definitionHash;
  const next = setTopScalar(text, "mode", MODE_LINE(mode));
  const after = parseAgentMd(next, { dir }).definitionHash;
  if (after !== before) fs.writeFileSync(file, next);
  return { before, after };
}

// ---------------------------------------------------------------- the edit engine

/** A YAML plain scalar when it can be one, a double-quoted one otherwise. */
export function yamlScalar(v: string): string {
  return /^[\p{L}\p{N}][\p{L}\p{N} _.,;'!?()/-]*$/u.test(v) && !/: |\s#|^(true|false|null|yes|no|~)$/i.test(v) && !/^\d/.test(v) ? v : JSON.stringify(v);
}

/**
 * What `rfa agent edit` can change, from its flags or from the walkthrough.
 * Every field is optional: an absent one is "leave it"; a present one equal to
 * what is there is a no-op, so applying the same change twice is harmless.
 */
export interface PackChanges {
  description?: string;
  /** A model tier; "inherit" removes nothing, it is what an unset model reads as. */
  model?: string;
  /** The first capability the card advertises (further offers are kept as they are). */
  offer?: { id: string; description: string };
  budgets?: { per_task_usd?: number; per_day_usd?: number; max_turns?: number };
  mode?: AgentMode;
  /** The room handle to bind to, replacing the binding (role and serve kept). */
  room?: string;
  /** Knowledge globs to add (deduplicated); removal is an edit by hand. */
  knowledge?: string[];
  /**
   * Turns this pack may run at once (RFA-0.8 sect. 10). Refused above 1 unless
   * the pack passes all three gates, by the same schema every other caller uses:
   * the validation below is what reports the reason, so an operator learns which
   * gate failed instead of getting a bare rejection.
   */
  concurrency?: number;
  /**
   * How many CANDIDATES this pack runs for one task by default (RFA-0.8
   * sect. 11): N independent runs, one kept. Gated with `concurrency` by the
   * same schema, and additionally requiring `concurrency >= candidates`,
   * because N candidates IS N turns at once.
   */
  candidates?: number;
  /**
   * Strip the inert `sandbox.network` and `sandbox.allowed_domains` lines
   * (RFA-0.9 sect. 4.6). Every pack `rfa agent new` wrote before rung 1 carries
   * `network: none`, a line with no reader anywhere, and a setting that reads as
   * a control while doing nothing is the exact defect RFA-0.9 exists to remove.
   * `rfa doctor` names the pack and this flag as its fix.
   */
  dropNetwork?: boolean;
}

export interface EditResult {
  before: string;
  after: string;
  /** The settings that actually changed, in the order they are listed on the review screen. */
  changed: string[];
}

/** The settings as `rfa agent edit` reads them, for the walkthrough's list and the no-op check. */
export function currentSettings(def: AgentDef): Required<Pick<PackChanges, "description" | "model">> & { offer: { id: string; description: string } | null; budgets: { per_task_usd: number | null; per_day_usd: number | null; max_turns: number | null }; mode: AgentMode | "read-only"; room: string | null; knowledge: string[]; concurrency: number; candidates: number } {
  return {
    description: def.description,
    model: def.model ?? "inherit",
    offer: def.offers?.[0] ? { id: def.offers[0].id, description: def.offers[0].description } : null,
    budgets: { per_task_usd: def.budgets?.per_task_usd ?? null, per_day_usd: def.budgets?.per_day_usd ?? null, max_turns: def.budgets?.max_turns ?? null },
    mode: effectiveMode(def),
    room: def.rooms?.[0]?.room ?? null,
    knowledge: def.knowledge ?? [],
    concurrency: def.concurrency,
    candidates: def.candidates,
  };
}

/**
 * Apply a set of changes to a pack's agent.md: one line or block per setting,
 * the rest byte for byte, the whole validated once before a single write. The
 * same function behind the flags and the walkthrough, so the two cannot differ.
 */
export function editPack(file: string, c: PackChanges): EditResult {
  const original = fs.readFileSync(file, "utf8");
  const packDir = path.dirname(file);
  const parsed = parseAgentMd(original, { dir: packDir });
  const def = parsed.def;
  const now = currentSettings(def);
  let text = original;
  const changed: string[] = [];
  if (c.description !== undefined && c.description !== now.description) {
    text = setTopScalar(text, "description", `description: ${yamlScalar(c.description)}`, { after: "name" });
    changed.push("description");
  }
  if (c.model !== undefined && c.model !== now.model) {
    text = setTopScalar(text, "model", `model: ${c.model}   # haiku for retrieval and answers, sonnet when it has to compose`, { after: "description" });
    changed.push("model");
  }
  if (c.offer) {
    const offers = def.offers ?? [];
    const next = offers.length ? [{ ...offers[0], id: c.offer.id, description: c.offer.description }, ...offers.slice(1)] : [c.offer];
    if (JSON.stringify(next) !== JSON.stringify(offers)) {
      text = setTopBlock(text, "offers", YAML.stringify({ offers: next }).trimEnd());
      changed.push("capability");
    }
  }
  if (c.budgets) {
    const merged: Record<string, number> = { ...(def.budgets as Record<string, number> | undefined) };
    for (const [k, v] of Object.entries(c.budgets)) if (v !== undefined) merged[k] = v;
    if (JSON.stringify(merged) !== JSON.stringify(def.budgets ?? {})) {
      text = setTopBlock(text, "budgets", YAML.stringify({ budgets: merged }).trimEnd());
      changed.push("budgets");
    }
  }
  if (c.mode !== undefined) {
    if (now.mode === "read-only") throw new Error(`${def.name} has no acting tool (nothing in interrupt_on); a mode would change nothing`);
    if (c.mode !== now.mode) {
      text = setTopScalar(text, "mode", MODE_LINE(c.mode));
      changed.push("mode");
    }
  }
  if (c.room !== undefined && c.room !== now.room) {
    const b = def.rooms?.[0];
    text = setRoomsBlock(text, roomsBlock(c.room, { role: b?.role, serve: b?.serve, presenceTtlS: b?.presence_ttl_s }));
    changed.push("room");
  }
  if (c.knowledge?.length) {
    const merged = [...new Set([...now.knowledge, ...c.knowledge])];
    if (merged.length !== now.knowledge.length) {
      text = setTopBlock(text, "knowledge", knowledgeBlock(merged));
      changed.push("knowledge");
    }
  }
  if (c.concurrency !== undefined && c.concurrency !== now.concurrency) {
    text = setTopScalar(text, "concurrency", `concurrency: ${c.concurrency}   # turns at once; each one is a full claude CLI child process`, { after: "model" });
    changed.push("concurrency");
  }
  if (c.candidates !== undefined && c.candidates !== now.candidates) {
    text = setTopScalar(text, "candidates", `candidates: ${c.candidates}   # ways to answer ONE task; you pay for all of them, one is kept`, { after: "concurrency" });
    changed.push("candidates");
  }
  if (c.dropNetwork) {
    const stripped = dropNestedKey(dropNestedKey(text, "sandbox", "network"), "sandbox", "allowed_domains");
    if (stripped !== text) {
      text = stripped;
      changed.push("sandbox.network (inert, removed)");
    }
  }
  // Validated as a whole before anything touches the disk: a refused edit leaves the file as it was.
  const after = parseAgentMd(text, { dir: packDir }).definitionHash;
  if (after !== parsed.definitionHash) fs.writeFileSync(file, text);
  return { before: parsed.definitionHash, after, changed };
}
