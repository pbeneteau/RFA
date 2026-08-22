/**
 * Credential files the hub loads and watches (RFA-0.7 sect. 2.4): human
 * principals and transport bearers, hashed at rest, reloaded on change.
 *
 * Two rules, both already stated by the specs and applied here early:
 *
 *   - Only a digest rests on disk (RFA-0.6 sect. 4.2 says so for the admission
 *     record's bearer). The plaintext is shown once to the person it was minted
 *     for; the operator's own copies live in the secrets file, which is the one
 *     file that holds values.
 *   - A watched file reloads without a restart, and a malformed edit is refused
 *     loudly with the previous set retained, never an empty set (RFA-0.6 sect.
 *     3.1's reload rule). Revoking a token has to mean "on the next request", and
 *     an empty set would be a hub that quietly forgot every credential it had.
 *
 * `fs.watch` drops events under load (the supervisor's command channel learned
 * this), so every watcher also polls the file's mtime.
 */
import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { sha256hex } from "./jcs.js";
import type { PrincipalRecord, PrincipalsFile, TokenRecord, TokensFile } from "./hubdir.js";

/**
 * Constant-time match of a presented secret against stored hex digests.
 *
 * Every record costs exactly one comparison whatever matches, and the verdict is
 * taken after the loop, for the same reason `matchPrincipal` in src/principals.ts
 * never returns early: a hit that short-circuits leaks the matching record's
 * position through timing. An expired record is compared like any other and then
 * discarded, so expiry does not change the timing profile either.
 */
export function matchDigest<T extends { sha256: string; expires_at?: string | null }>(presented: string, records: readonly T[], now: number = Date.now()): T | null {
  const digest = Buffer.from(sha256hex(presented), "hex");
  let found: T | null = null;
  for (const record of records) {
    const stored = Buffer.from(/^[0-9a-f]{64}$/.test(record.sha256) ? record.sha256 : "", "hex");
    const sameLength = stored.length === digest.length;
    const candidate = sameLength ? digest : Buffer.alloc(stored.length);
    const hit = timingSafeEqual(stored, candidate) && sameLength;
    const expired = record.expires_at ? Date.parse(record.expires_at) <= now : false;
    if (hit && !expired) found = record;
  }
  return found;
}

export const tokenDigest = (plaintext: string): string => sha256hex(plaintext);

/**
 * A JSON file whose parsed value the process keeps current.
 *
 * `parse` validates; when it throws, the previous value stays and `onError` is
 * told, which is the whole point: the hub must never run on an empty credential
 * set because an operator saved a file mid-edit.
 */
export class WatchedFile<T> {
  value: T;
  private watcher: fs.FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private lastMtime = 0;
  /** The bytes last loaded: an fs.watch event and the mtime poll both fire for one write, and one write is one reload. */
  private lastText: string | null = null;

  constructor(
    readonly file: string,
    private readonly parse: (raw: unknown) => T,
    private readonly empty: () => T,
    private readonly opts: { pollMs?: number; onError?: (err: Error) => void; onReload?: (value: T) => void } = {},
  ) {
    const first = this.load(true);
    this.value = first === null || first === WatchedFile.UNCHANGED ? empty() : first;
  }

  private static readonly UNCHANGED: unique symbol = Symbol("unchanged");

  /**
   * Read and validate. Returns the value, UNCHANGED when the bytes are the ones
   * already loaded, or null (and reports) when the file is unreadable. `initial`
   * makes a missing file the empty value rather than an error.
   */
  private load(initial = false): T | typeof WatchedFile.UNCHANGED | null {
    try {
      if (!fs.existsSync(this.file)) {
        this.lastMtime = 0;
        this.lastText = null;
        return this.empty();
      }
      this.lastMtime = fs.statSync(this.file).mtimeMs;
      const text = fs.readFileSync(this.file, "utf8");
      if (text === this.lastText) return WatchedFile.UNCHANGED;
      // Remembered before parsing: one write is one verdict. An fs.watch event
      // and the mtime poll both fire for a malformed save, and reporting the
      // same torn bytes twice is the noise that hides the next real edit.
      this.lastText = text;
      return this.parse(JSON.parse(text) as unknown);
    } catch (err) {
      if (!initial || fs.existsSync(this.file)) this.opts.onError?.(err as Error);
      return null;
    }
  }

  /** Re-read now. True when the value changed to a valid new one. */
  reload(): boolean {
    const next = this.load();
    if (next === null || next === WatchedFile.UNCHANGED) return false;
    this.value = next;
    this.opts.onReload?.(next);
    return true;
  }

  start(): void {
    if (this.poll) return;
    const pollMs = this.opts.pollMs ?? 5_000;
    this.poll = setInterval(() => {
      try {
        const mtime = fs.existsSync(this.file) ? fs.statSync(this.file).mtimeMs : 0;
        if (mtime !== this.lastMtime) this.reload();
      } catch {
        /* transient: the next tick tries again */
      }
    }, pollMs);
    this.poll.unref?.();
    try {
      // Watching the directory rather than the file: an atomic write replaces
      // the inode, and a watcher on the old inode never fires again.
      const dir = this.file.slice(0, this.file.lastIndexOf("/")) || ".";
      const base = this.file.slice(this.file.lastIndexOf("/") + 1);
      this.watcher = fs.watch(dir, (_event, name) => {
        if (name === base || name === null) this.reload();
      });
      this.watcher.on("error", () => {
        /* the poll covers it */
      });
      this.watcher.unref?.();
    } catch {
      /* no directory yet, or a platform without fs.watch: the poll covers it */
    }
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

// ---------------------------------------------------------------- the two files

const HEX64 = /^[0-9a-f]{64}$/;

export function parseTokensFile(raw: unknown): TokensFile {
  const f = raw as Partial<TokensFile>;
  if (!f || typeof f !== "object" || f.version !== 1 || !Array.isArray(f.tokens)) throw new Error("tokens file must be {version: 1, tokens: []}");
  const seen = new Set<string>();
  for (const t of f.tokens as TokenRecord[]) {
    if (typeof t.id !== "string" || typeof t.label !== "string") throw new Error("each token needs an id and a label");
    if (!["operator", "client", "peer"].includes(t.kind)) throw new Error(`token ${t.label}: kind must be operator, client or peer`);
    if (typeof t.sha256 !== "string" || !HEX64.test(t.sha256)) throw new Error(`token ${t.label}: sha256 must be 64 lowercase hex characters`);
    if (t.expires_at !== null && t.expires_at !== undefined && Number.isNaN(Date.parse(t.expires_at))) throw new Error(`token ${t.label}: expires_at is not a date`);
    if (seen.has(t.sha256)) throw new Error(`token ${t.label}: duplicate digest`);
    seen.add(t.sha256);
  }
  return { version: 1, tokens: (f.tokens as TokenRecord[]).map((t) => ({ ...t, expires_at: t.expires_at ?? null })) };
}

export function parsePrincipalsFile(raw: unknown): PrincipalsFile {
  const f = raw as Partial<PrincipalsFile>;
  if (!f || typeof f !== "object" || f.version !== 1 || !Array.isArray(f.principals)) throw new Error("principals file must be {version: 1, principals: []}");
  for (const p of f.principals as PrincipalRecord[]) {
    if (typeof p.id !== "string" || !/^hp_[0-9a-f]{12}$/.test(p.id)) throw new Error("each principal needs an hp_ id");
    if (typeof p.label !== "string" || !p.label) throw new Error(`principal ${p.id}: a label is required`);
    if (typeof p.key_sha256 !== "string" || !HEX64.test(p.key_sha256)) throw new Error(`principal ${p.label}: key_sha256 must be 64 lowercase hex characters`);
  }
  return { version: 1, principals: f.principals as PrincipalRecord[] };
}
