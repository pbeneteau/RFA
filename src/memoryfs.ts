/**
 * Gated agent memory v1 (RFA v0.4 spec section 5): ONE memory root per pack
 * (`agents/<name>/memory/`), exposed to the model as memory-tool verbs
 * (view/create/str_replace/insert/delete/rename, the memory_20250818 surface
 * served through an in-process MCP tool), with enforcement IN the handler:
 *
 * - path confinement: every path resolves inside the root, or the call fails;
 * - MemoryGate on every write payload: content that near-duplicates recent
 *   OTHER-sender room traffic is the worm trying to persist itself: rejected;
 * - Letta-style core blocks (`blocks/*.md` with {label, description, limit,
 *   read_only} frontmatter): limit and read_only enforced on write, compiled
 *   into the system prompt in the XML rendering with chars_current/chars_limit.
 *
 * Episodes (L2) live beside it in state/memory.db: append-only, every gated
 * room exchange with its verdict and boundary-wrapped form.
 */
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { Envelope } from "./model.js";
import type { MemoryGate } from "./client.js";

// ---------------------------------------------------------------- gated root

export class GatedMemory {
  constructor(
    private root: string,
    private gate: MemoryGate,
    private selfId: string,
  ) {
    fs.mkdirSync(path.join(root, "blocks"), { recursive: true });
    fs.mkdirSync(path.join(root, "notes"), { recursive: true });
  }

  /** Resolve a tool path ("/memories/..." or relative) inside the root, or throw. */
  private resolve(p: string): string {
    const rel = p.replace(/^\/?memories\/?/, "").replace(/^\/+/, "");
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes the memory root: ${p}`);
    }
    return abs;
  }

  private guardWrite(abs: string, content: string): void {
    const v = this.gate.inspectText(content, this.selfId);
    if (!v.ok) {
      throw new Error(
        `memory gate rejected this write: ${Math.round(v.similarity * 100)}% match with recent content from another member (possible replication). Do not store peer content verbatim; store your own conclusion instead.`,
      );
    }
    if (this.isBlock(abs)) {
      const meta = fs.existsSync(abs) ? parseBlock(fs.readFileSync(abs, "utf8")).meta : null;
      if (meta?.read_only) throw new Error(`block ${path.basename(abs)} is read_only`);
      const next = parseBlock(content);
      const limit = next.meta.limit ?? meta?.limit;
      if (limit && next.value.length > limit) {
        throw new Error(`block value exceeds its limit (${next.value.length} > ${limit} chars); condense it`);
      }
    }
  }

  private isBlock(abs: string): boolean {
    return abs.startsWith(path.join(this.root, "blocks") + path.sep) && abs.endsWith(".md");
  }

  view(p = "/memories", range?: [number, number]): string {
    const abs = this.resolve(p);
    if (!fs.existsSync(abs)) return `(not found: ${p})`;
    if (fs.statSync(abs).isDirectory()) {
      const list = listRec(abs, this.root);
      return list.length ? list.join("\n") : "(empty)";
    }
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    const [from, to] = range ?? [1, lines.length];
    return lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}: ${l}`)
      .join("\n");
  }

  create(p: string, content: string): string {
    const abs = this.resolve(p);
    this.guardWrite(abs, content);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return `created ${p} (${content.length} chars)`;
  }

  strReplace(p: string, oldStr: string, newStr: string): string {
    const abs = this.resolve(p);
    const cur = fs.readFileSync(abs, "utf8");
    const count = cur.split(oldStr).length - 1;
    if (count === 0) throw new Error(`old_str not found in ${p}`);
    if (count > 1) throw new Error(`old_str is not unique in ${p} (${count} matches)`);
    const next = cur.replace(oldStr, newStr);
    this.guardWrite(abs, next);
    fs.writeFileSync(abs, next);
    return `replaced in ${p}`;
  }

  insert(p: string, line: number, text: string): string {
    const abs = this.resolve(p);
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    if (line < 0 || line > lines.length) throw new Error(`insert_line ${line} out of range (0..${lines.length})`);
    lines.splice(line, 0, text);
    const next = lines.join("\n");
    this.guardWrite(abs, next);
    fs.writeFileSync(abs, next);
    return `inserted at line ${line} in ${p}`;
  }

  delete(p: string): string {
    const abs = this.resolve(p);
    if (this.isBlock(abs)) {
      const meta = fs.existsSync(abs) ? parseBlock(fs.readFileSync(abs, "utf8")).meta : null;
      if (meta?.read_only) throw new Error(`block ${path.basename(abs)} is read_only`);
    }
    fs.rmSync(abs, { recursive: true, force: true });
    return `deleted ${p}`;
  }

  rename(from: string, to: string): string {
    const a = this.resolve(from);
    const b = this.resolve(to);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return `renamed ${from} -> ${to}`;
  }

  /** Letta XML rendering of core blocks, for the system prompt (spec 5.1). */
  compileBlocks(): string {
    const dir = path.join(this.root, "blocks");
    const blocks = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseBlock(fs.readFileSync(path.join(dir, f), "utf8"), f.replace(/\.md$/, "")));
    if (blocks.length === 0) return "";
    const body = blocks
      .map((b) => {
        const attrs = [
          `label="${b.meta.label}"`,
          b.meta.description ? `description="${b.meta.description}"` : "",
          `chars_current="${b.value.length}"`,
          b.meta.limit ? `chars_limit="${b.meta.limit}"` : "",
          b.meta.read_only ? `read_only="true"` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return `<memory_block ${attrs}>\n${b.value}\n</memory_block>`;
      })
      .join("\n");
    return `<core_memory>\n${body}\n</core_memory>`;
  }

  /** The head of MEMORY.md (the index protocol), loaded at session start. */
  indexHead(maxLines = 40): string {
    const f = path.join(this.root, "MEMORY.md");
    if (!fs.existsSync(f)) return "";
    return fs.readFileSync(f, "utf8").split("\n").slice(0, maxLines).join("\n");
  }
}

export interface BlockMeta {
  label: string;
  description?: string;
  limit?: number;
  read_only?: boolean;
}

/** blocks/*.md = optional YAML frontmatter (meta) + body (the value). */
export function parseBlock(content: string, fallbackLabel = "block"): { meta: BlockMeta; value: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { meta: { label: fallbackLabel }, value: content.trim() };
  const meta = (YAML.parse(m[1]) ?? {}) as Partial<BlockMeta>;
  return { meta: { label: meta.label ?? fallbackLabel, description: meta.description, limit: meta.limit, read_only: meta.read_only }, value: m[2].trim() };
}

function listRec(dir: string, root: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listRec(p, root, out);
    else out.push("/memories/" + path.relative(root, p));
  }
  return out;
}

// ---------------------------------------------------------------- episodes (L2)

export interface Episode {
  id: number;
  ts: string;
  room: string;
  seq: number | null;
  from_id: string;
  from_name: string;
  origin: string;
  kind: string;
  gate_ok: number;
  gate_similarity: number | null;
  text: string;
  wrapped: string | null;
}

export class EpisodeLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        room TEXT NOT NULL,
        seq INTEGER,
        from_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        origin TEXT NOT NULL,
        kind TEXT NOT NULL,
        gate_ok INTEGER NOT NULL DEFAULT 1,
        gate_similarity REAL,
        text TEXT NOT NULL,
        wrapped TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_room ON episodes(room, seq);
    `);
  }

  recordInbound(env: Envelope, verdict: { ok: boolean; similarity?: number }, wrapped: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO episodes (ts, room, seq, from_id, from_name, origin, kind, gate_ok, gate_similarity, text, wrapped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(env.ts, env.room, env.seq, env.from.id, env.from.name, env.from.origin, env.kind, verdict.ok ? 1 : 0, verdict.similarity ?? null, text, wrapped);
  }

  recordOwn(room: string, selfId: string, selfName: string, text: string): void {
    this.db
      .prepare(
        `INSERT INTO episodes (ts, room, seq, from_id, from_name, origin, kind, gate_ok, text)
         VALUES (?, ?, NULL, ?, ?, 'agent', 'response', 1, ?)`,
      )
      .run(new Date().toISOString(), room, selfId, selfName, text);
  }

  recent(n = 20): Episode[] {
    return this.db.prepare(`SELECT * FROM episodes ORDER BY id DESC LIMIT ?`).all(n) as Episode[];
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
