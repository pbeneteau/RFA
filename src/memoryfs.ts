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
 *
 * PER-VERB CONCURRENCY CONTRACT (RFA-0.8 sect. 4 item 1). Memory is SHARED
 * across a pack's concurrent runs on purpose: partitioning it per run would
 * create the diverging-replica case no shipped system merges. So each verb
 * carries its own contract instead of one coarse lock:
 *
 * - appends stay concurrent;
 * - `str_replace` keeps its accidental optimistic concurrency DELIBERATELY: a
 *   unique `old_str` is a compare-and-swap, and a stale one fails loudly so the
 *   model re-reads. Pinned by test/interleaving.test.ts, not incidental;
 * - `create` is EXCLUSIVE. It used to clobber unconditionally, which is a
 *   silently lost update the moment two turns pick the same path; now an
 *   existing path with different content keeps the incumbent and the arriving
 *   content survives beside it as a named conflict file (Syncthing's shape),
 *   named in the error;
 * - `create` over existing, `insert` and `delete` accept a fail-if-changed
 *   content hash (`expected_hash`), and the stale error carries the CURRENT
 *   hash so the retry needs no guessing.
 *
 * Deliberately NOT here: making the hash visible in `view`'s output. That is a
 * prompt-surface change on every turn (a parity-gated behaviour change), and the
 * write-path errors carry the hash, which is enough to use the precondition.
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

  /**
   * The content hash a write-path precondition compares against: the same value
   * `expected_hash` takes, and the one the stale-precondition error reports.
   */
  contentHash(p: string): string {
    const abs = this.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`no such memory file: ${p}`);
    return hashContent(fs.readFileSync(abs, "utf8"));
  }

  /**
   * Fail-if-changed (RFA-0.8 sect. 4 item 1). Enforced only when the caller
   * supplies a hash: a verb whose caller passed none is exactly as concurrent as
   * it was, and the error is what teaches the model the retry.
   */
  private requireUnchanged(abs: string, p: string, expected: string | undefined): void {
    if (expected === undefined) return;
    const current = fs.existsSync(abs) ? hashContent(fs.readFileSync(abs, "utf8")) : null;
    if (current === expected) return;
    throw new Error(
      `${p} changed since you read it (you expected ${expected}, current is ${current ?? "(the file is gone)"}): ` +
        `another turn wrote it. Re-read it with view and retry with the current expected_hash.`,
    );
  }

  /**
   * Create-exclusive. An existing path is NOT overwritten unless the caller
   * proves it read the current content (`expectedHash`); otherwise the incumbent
   * stays and the arriving content lands beside it as a conflict file, so a
   * concurrent write is never silently discarded.
   */
  create(p: string, content: string, opts: { expectedHash?: string } = {}): string {
    const abs = this.resolve(p);
    // The gate first, always: gated content must not reach disk, conflict file
    // included.
    this.guardWrite(abs, content);
    if (fs.existsSync(abs)) {
      const current = fs.readFileSync(abs, "utf8");
      // Re-creating a path with the content it already holds is a no-op, not a
      // conflict: the common benign retry must not litter the memory root.
      if (current === content) return `${p} unchanged (identical content already there)`;
      if (opts.expectedHash !== undefined) {
        this.requireUnchanged(abs, p, opts.expectedHash);
        fs.writeFileSync(abs, content);
        return `overwrote ${p} (${content.length} chars, precondition held)`;
      }
      const conflict = conflictPath(abs);
      fs.writeFileSync(conflict, content);
      throw new Error(
        `${p} already exists with different content and create does not overwrite. Your content was kept as ` +
          `/memories/${path.relative(this.root, conflict)} so nothing is lost. Re-read ${p}, then either ` +
          `str_replace the part you meant to change, or create again passing expected_hash=${hashContent(current)}.`,
      );
    }
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

  insert(p: string, line: number, text: string, opts: { expectedHash?: string } = {}): string {
    const abs = this.resolve(p);
    this.requireUnchanged(abs, p, opts.expectedHash);
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    if (line < 0 || line > lines.length) throw new Error(`insert_line ${line} out of range (0..${lines.length})`);
    lines.splice(line, 0, text);
    const next = lines.join("\n");
    this.guardWrite(abs, next);
    fs.writeFileSync(abs, next);
    return `inserted at line ${line} in ${p}`;
  }

  delete(p: string, opts: { expectedHash?: string } = {}): string {
    const abs = this.resolve(p);
    this.requireUnchanged(abs, p, opts.expectedHash);
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
      // A conflict file is a preserved LOSER, not a block: compiling it would put
      // two versions of one block in the system prompt.
      .filter((f) => f.endsWith(".md") && !f.includes(CONFLICT_MARKER))
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

/** The infix that marks a preserved losing write; `view` shows them, `compileBlocks` skips them. */
export const CONFLICT_MARKER = ".conflict-";

/** 64 bits of the content's SHA-256: an optimistic-concurrency token, not a digest anyone verifies. */
export function hashContent(content: string): string {
  return sha256hex(content).slice(0, 16);
}

/**
 * Where a losing `create` lands: Syncthing's shape, extension last so the file
 * is still what it is. The instant is in the name because two losers on one path
 * must not overwrite each other, and the hash because the same turn retrying
 * twice in one millisecond must not either.
 */
function conflictPath(abs: string): string {
  const ext = path.extname(abs);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${abs.slice(0, abs.length - ext.length)}${CONFLICT_MARKER}${stamp}${ext}`;
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
      -- Gate skips (RFA-0.8 sect. 4 item 3). A gate-skipped fact used to vanish
      -- into a bare "skipped", which blinds consolidation's contradiction
      -- detector with its own front door: a measured near-duplicate gate rejected
      -- 206 of 400 contradictory writes before the detector saw them. The skip is
      -- now a durable row carrying hash, similarity and the episodes behind it.
      CREATE TABLE IF NOT EXISTS fact_gate_skips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        hash TEXT NOT NULL,
        text TEXT NOT NULL,
        similarity REAL,
        matched_from TEXT,
        event TEXT NOT NULL,
        episode_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_gate_skips_hash ON fact_gate_skips(hash);
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
    if (current < 2) {
      // RFA-0.8 sect. 3 item 1: the live-fact set enforces hash uniqueness in the
      // STORE, not in the reader. `apply` was a SELECT-then-INSERT with no
      // transaction over a non-unique index, and the resident's consolidation
      // timer and `rfa agent reflect --apply` open this same file from two
      // processes: a cross-process check-then-insert that produces silent
      // duplicates.
      //
      // A store that already holds duplicate live hashes cannot take the index,
      // so collapse first. The collapse is EXPIRY, never deletion: this store is
      // bi-temporal and invalidation is expiry (spec sect. 4), so "who believed
      // what when" stays answerable. The SURVIVOR is the lowest id, the earliest
      // `created_at`, because belief in that text began then and has never
      // stopped; the losers' `episode_ids` are merged FORWARD into the survivor,
      // because episode ids are provenance and dropping them would lose which
      // conversation produced the fact.
      const now = new Date().toISOString();
      const dupes = this.db
        .prepare(`SELECT hash, COUNT(*) AS n FROM facts WHERE expired_at IS NULL GROUP BY hash HAVING n > 1`)
        .all() as { hash: string; n: number }[];
      let collapsed = 0;
      for (const d of dupes) {
        const rows = this.db
          .prepare(`SELECT id, episode_ids FROM facts WHERE hash = ? AND expired_at IS NULL ORDER BY id`)
          .all(d.hash) as { id: number; episode_ids: string }[];
        const [survivor, ...losers] = rows;
        const merged = new Set<number>(JSON.parse(survivor.episode_ids) as number[]);
        for (const l of losers) for (const e of JSON.parse(l.episode_ids) as number[]) merged.add(e);
        this.db
          .prepare(`UPDATE facts SET episode_ids = ? WHERE id = ?`)
          .run(JSON.stringify([...merged].sort((a, b) => a - b)), survivor.id);
        for (const l of losers) {
          // expired_at only, NOT invalid_at: these rows were never known false in
          // the world, they are duplicate records of a fact still believed.
          this.db.prepare(`UPDATE facts SET expired_at = ? WHERE id = ?`).run(now, l.id);
          collapsed++;
        }
      }
      if (collapsed > 0) {
        console.error(
          `[memory] collapsed ${collapsed} duplicate live-hash row(s) across ${dupes.length} hash(es) by expiry ` +
            `(episode provenance merged into the surviving row) before taking the unique live-fact index`,
        );
      }
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_live_hash ON facts(hash) WHERE expired_at IS NULL`);
      this.db.pragma("user_version = 2");
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

  /**
   * Apply one Mem0 reconciliation item. Returns what happened (gate rejections
   * skip, and the skip is recorded).
   *
   * ONE TRANSACTION (RFA-0.8 sect. 3 item 1). The check-then-insert used to sit
   * bare over a non-unique index while two processes held this file open, so two
   * consolidations could both miss the duplicate and both insert. The IMMEDIATE
   * transaction plus the unique partial index on `hash WHERE expired_at IS NULL`
   * makes the store, not the reader, the authority: the loser of a genuine race
   * gets the constraint and is reported as the skip it always should have been.
   */
  apply(item: ReconciliationItem, episodeIds: number[], origin: Fact["source_origin"]): "added" | "updated" | "invalidated" | "skipped" {
    if (item.event === "NONE") return "skipped";
    // The gate is CPU work over an in-memory window: keep it OUT of the write
    // transaction, so a rejected write never opens one.
    if (item.event === "ADD" || item.event === "UPDATE") {
      if (this.gate) {
        const v = this.gate.inspectText(item.text, this.selfId);
        if (!v.ok) {
          this.recordGateSkip(item, episodeIds, v.similarity, v.matchedFrom);
          return "skipped";
        }
      }
    }
    const tx = this.db.transaction((): "added" | "updated" | "invalidated" | "skipped" => {
      const now = new Date().toISOString();
      if (item.event === "DELETE") {
        if (item.id == null) return "skipped";
        this.db.prepare(`UPDATE facts SET invalid_at = ?, expired_at = ? WHERE id = ? AND expired_at IS NULL`).run(now, now, item.id);
        return "invalidated";
      }
      const hash = factHash(item.text);
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
    });
    try {
      return tx.immediate();
    } catch (err) {
      // The other process committed the same live hash first. Same outcome the
      // in-transaction check reports, reached from the other side of the race.
      if (isLiveHashConflict(err)) return "skipped";
      throw err;
    }
  }

  /**
   * A gate-skipped fact, kept (RFA-0.8 sect. 4 item 3). It carries the hash, the
   * similarity and the episodes behind it, so consolidation can see
   * contradiction-shaped near-duplicates instead of being blinded by its own
   * front door.
   */
  private recordGateSkip(item: ReconciliationItem, episodeIds: number[], similarity: number, matchedFrom: string): void {
    this.db
      .prepare(
        `INSERT INTO fact_gate_skips (at, hash, text, similarity, matched_from, event, episode_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), factHash(item.text), item.text, similarity, matchedFrom, item.event, JSON.stringify(episodeIds));
  }

  /** What the gate refused, newest first: consolidation's input, and a forensic record. */
  gateSkips(limit = 50): GateSkip[] {
    const rows = this.db
      .prepare(`SELECT * FROM fact_gate_skips ORDER BY id DESC LIMIT ?`)
      .all(limit) as (Omit<GateSkip, "episode_ids"> & { episode_ids: string })[];
    return rows.map((r) => ({ ...r, episode_ids: JSON.parse(r.episode_ids) as number[] }));
  }

  countGateSkips(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM fact_gate_skips`).get() as { n: number }).n;
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

/** The dedupe key: normalized text, so casing and whitespace are not two facts. */
export function factHash(text: string): string {
  return sha256hex(text.toLowerCase().replace(/\s+/g, " ").trim()).slice(0, 32);
}

/** The unique live-fact index firing, i.e. the other process won the race. */
function isLiveHashConflict(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? "";
  return code.startsWith("SQLITE_CONSTRAINT") && /idx_facts_live_hash|facts\.hash|UNIQUE/i.test((err as Error).message ?? "");
}

/** A write the gate refused, kept rather than dropped (RFA-0.8 sect. 4 item 3). */
export interface GateSkip {
  id: number;
  at: string;
  hash: string;
  text: string;
  similarity: number | null;
  matched_from: string | null;
  event: string;
  episode_ids: number[];
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

  /**
   * @param withhold A guard consulted before an OWN answer is recorded: return a
   * reason and the write throws (RFA-0.8 sect. 11, rung 4).
   *
   * It exists for one rule: **a losing candidate's reasoning must never become
   * remembered fact.** N candidates for one task, each recording an episode,
   * means consolidation later distils the rejected candidates too, which is the
   * fact store learning from work a human threw away. So a candidate turn writes
   * NO episode; its answer lives in `candidate_runs` in the engine DB, and only
   * the SELECTED winner's answer is recorded here, on the selection path, in
   * normal id order ahead of the consolidation watermark.
   *
   * The alternative shape (tag every candidate's episode and filter them out of
   * the consolidation input) was rejected for a concrete reason: consolidation
   * advances its watermark to the last id of its batch, so a filtered-out
   * episode would be stepped over and a candidate promoted afterwards would
   * never be consolidated at all. That shape needs a watermark that can go
   * backwards, which is what rung 1's compare-and-set exists to prevent.
   *
   * This guard is what makes the rule enforced at the write rather than
   * remembered: the candidate path does not call `recordOwn`, so the throw is a
   * tripwire for a future author, not a runtime path.
   */
  constructor(dbPath: string, private withhold?: () => string | null) {
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
    const reason = this.withhold?.();
    if (reason) throw new Error(`this answer must not be recorded as an episode: ${reason}`);
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

  /**
   * Compare-and-set (RFA-0.8 sect. 3 item 2): write `value` only if the key still
   * holds `expected`. False means somebody else moved it, and the caller's whole
   * read-process-write was against a stale view.
   *
   * The named single-flight lock is what stops two passes STARTING; this is what
   * stops a pass whose lock lapsed mid-flight from stomping the watermark its
   * successor already advanced. Both, because a lock is a lease and a lease can
   * be lost while its holder is still running.
   */
  casMeta(key: string, expected: string | null, value: string): boolean {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
      const current = row?.value ?? null;
      if (current !== expected) return false;
      this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
      return true;
    });
    return tx.immediate();
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
