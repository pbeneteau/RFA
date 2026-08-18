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
import { sha256hex } from "./jcs.js";
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

// ---------------------------------------------------------------- facts (L3 semantic, v0.4 spec 5.1)

/**
 * The semantic layer: durable facts distilled from episodes by background
 * consolidation. Mem0's reconciliation events over Graphiti's bi-temporal
 * columns: created_at/expired_at are TRANSACTION time (when we started and
 * stopped believing the row), valid_at/invalid_at are EVENT time (when the
 * fact held in the world). DELETE invalidates, never removes: "who said what
 * when" stays answerable in a moderated multi-agent space.
 */
export interface Fact {
  id: number;
  text: string;
  hash: string;
  importance: number;
  /** Trust tier from provenance: human > self (own conclusions) > agent (peer-derived). */
  source_origin: "human" | "self" | "agent";
  episode_ids: number[];
  supersedes: number | null;
  created_at: string;
  expired_at: string | null;
  valid_at: string | null;
  invalid_at: string | null;
}

/** Mem0's exact reconciliation item shape. */
export interface ReconciliationItem {
  id?: number;
  text: string;
  event: "ADD" | "UPDATE" | "DELETE" | "NONE";
  old_memory?: string;
  importance?: number;
}

export class FactStore {
  private db: Database.Database;

  constructor(dbPath: string, private gate?: MemoryGate, private selfId = "self") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        hash TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        source_origin TEXT NOT NULL DEFAULT 'agent' CHECK (source_origin IN ('human','self','agent')),
        episode_ids TEXT NOT NULL DEFAULT '[]',
        supersedes INTEGER,
        created_at TEXT NOT NULL,
        expired_at TEXT,
        valid_at TEXT,
        invalid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_hash ON facts(hash);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, content='facts', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
    this.migrate();
  }

  /**
   * Schema migrations (spec 19.2). Each agent owns its own database, so a
   * schema change has to be applied per file at open time; `user_version` is
   * the only durable record of where a given file stands. Before this the
   * project contained no ALTER TABLE anywhere, which is why the columns below
   * needed a mechanism and not just a statement.
   *
   * Migrations MUST be additive and idempotent: a resident may be running an
   * older build against a newer file after a partial rollback.
   */
  private migrate(): void {
    const current = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (current < 1) {
      // Provenance for facts extracted from a source FILE (spec 19.2). All
      // nullable, and NULL means "no provenance", never "unverified": every
      // fact that exists today is an agent's own consolidation of room
      // episodes and legitimately has none.
      const cols = this.db.prepare("PRAGMA table_info(facts)").all() as { name: string }[];
      const have = new Set(cols.map((c) => c.name));
      for (const [name, type] of [
        ["source_uri", "TEXT"], // path within the tracked clone, not a URL to fetch
        ["source_author", "TEXT"], // from `git log -1 --format=%an <%ae>` on that file
        ["observed_at", "TEXT"], // extraction time, ISO 8601, same convention as the other columns
        ["revalidate_after", "TEXT"], // an absolute instant, so no consumer needs to know what it is relative to
      ] as const) {
        if (!have.has(name)) this.db.exec(`ALTER TABLE facts ADD COLUMN ${name} ${type}`);
      }
      this.db.pragma("user_version = 1");
    }
  }

  close(): void {
    this.db.close();
  }

  /** Live facts loosely matching a query: the reconciliation candidate set. */
  candidates(query: string, k = 5): Fact[] {
    return this.search(query, k).map((r) => r.fact);
  }

  /**
   * Retrieval for the answer path: FTS BM25 reranked by recency x importance
   * (Generative Agents' shape). Live facts only.
   */
  retrieve(query: string, k = 5): Fact[] {
    const now = Date.now();
    return this.search(query, k * 3)
      .map((r) => {
        const ageDays = (now - Date.parse(r.fact.created_at)) / 86_400_000;
        const recency = Math.exp(-ageDays / 30);
        return { fact: r.fact, score: r.bm25 * (0.4 + 0.6 * recency) * (0.4 + 0.6 * r.fact.importance) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => r.fact);
  }

  private search(query: string, k: number): { fact: Fact; bm25: number }[] {
    const terms = query
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .slice(0, 12);
    if (terms.length === 0) return [];
    // Prefix match per term (spec 19.3): FTS5 here has no stemmer, so "frais"
  // would not reach "frai" and "gestion" would not reach "gestionnaire". One
  // character, no migration. A tokenizer change is NOT the same size and is
  // deliberately not attempted here (19.3 second bullet).
  const match = terms.map((t) => `"${t}"*`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT f.*, bm25(facts_fts) AS rank FROM facts_fts
         JOIN facts f ON f.id = facts_fts.rowid
         WHERE facts_fts MATCH ? AND f.expired_at IS NULL AND f.invalid_at IS NULL
         ORDER BY rank LIMIT ?`,
      )
      .all(match, k) as (FactRow & { rank: number })[];
    // bm25() is smaller-is-better; normalize to a positive score.
    return rows.map((r) => ({ fact: hydrateFact(r), bm25: 1 / (1 + Math.max(0, r.rank)) }));
  }

  live(limit = 200): Fact[] {
    const rows = this.db
      .prepare(`SELECT * FROM facts WHERE expired_at IS NULL AND invalid_at IS NULL ORDER BY id DESC LIMIT ?`)
      .all(limit) as FactRow[];
    return rows.map(hydrateFact);
  }

  /** Apply one Mem0 reconciliation item. Returns what happened (gate rejections skip). */
  apply(item: ReconciliationItem, episodeIds: number[], origin: Fact["source_origin"]): "added" | "updated" | "invalidated" | "skipped" {
    const now = new Date().toISOString();
    if (item.event === "NONE") return "skipped";
    if (item.event === "DELETE") {
      if (item.id == null) return "skipped";
      this.db.prepare(`UPDATE facts SET invalid_at = ?, expired_at = ? WHERE id = ? AND expired_at IS NULL`).run(now, now, item.id);
      return "invalidated";
    }
    // ADD / UPDATE write new text: the gate holds at this door too (a fact that
    // near-duplicates recent peer content is the worm asking to be remembered).
    if (this.gate) {
      const v = this.gate.inspectText(item.text, this.selfId);
      if (!v.ok) return "skipped";
    }
    const hash = sha256hex(item.text.toLowerCase().replace(/\s+/g, " ").trim()).slice(0, 32);
    const dup = this.db.prepare(`SELECT id FROM facts WHERE hash = ? AND expired_at IS NULL`).get(hash);
    if (dup) return "skipped";
    let supersedes: number | null = null;
    if (item.event === "UPDATE" && item.id != null) {
      this.db.prepare(`UPDATE facts SET expired_at = ? WHERE id = ? AND expired_at IS NULL`).run(now, item.id);
      supersedes = item.id;
    }
    this.db
      .prepare(
        `INSERT INTO facts (text, hash, importance, source_origin, episode_ids, supersedes, created_at, valid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(item.text, hash, clamp01(item.importance ?? 0.5), origin, JSON.stringify(episodeIds), supersedes, now, now);
    return item.event === "UPDATE" ? "updated" : "added";
  }

  count(): { live: number; total: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM facts`).get() as { n: number }).n;
    const live = (this.db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE expired_at IS NULL AND invalid_at IS NULL`).get() as { n: number }).n;
    return { live, total };
  }
}

interface FactRow {
  id: number;
  text: string;
  hash: string;
  importance: number;
  source_origin: "human" | "self" | "agent";
  episode_ids: string;
  supersedes: number | null;
  created_at: string;
  expired_at: string | null;
  valid_at: string | null;
  invalid_at: string | null;
}

function hydrateFact(r: FactRow): Fact {
  return { ...r, episode_ids: JSON.parse(r.episode_ids) as number[] };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

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

  /** Episodes after a marker, oldest first (the consolidation input). */
  since(id: number, limit = 100): Episode[] {
    return this.db.prepare(`SELECT * FROM episodes WHERE id > ? ORDER BY id LIMIT ?`).all(id, limit) as Episode[];
  }

  /** Tiny KV beside the episodes (e.g. the consolidation watermark): same DB, no state-file races. */
  getMeta(key: string): string | null {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
