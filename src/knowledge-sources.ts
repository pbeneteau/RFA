/**
 * Knowledge sources for agent packs (RFA v0.5 sect. 19).
 *
 * A pack reads its knowledge through globs in agent.md. A source is either a
 * directory the operator already has (attached as a glob relative to the pack)
 * or a git remote, cloned under `agents/<pack>/knowledge/<name>-clone/`
 * (gitignored by the hub directory template) and attached the same way. The
 * pack reads a TRACKED CLONE, not an export: a clone carries per-file
 * provenance for free (`git log` gives author, commit time and sha for the
 * exact file a fact came from), it is fresh the moment someone pushes, and it
 * needs no credential at answer time. Seven files copied by hand once drifted
 * from a 46-page handbook without anyone noticing.
 *
 * Explicitly NOT an option (sect. 19.1, third bullet): binding a pack to an
 * account-managed MCP connector, which assembles private data, untrusted
 * content and egress in one process.
 *
 * Was scripts/sync-handbook.ts, which named one tenant's layout; now
 * `rfa knowledge add|sync|status|pin` over any pack and any source.
 * (`src/knowledge.ts` beside this is the resident's retrieval hints, a different thing.)
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { knowledgeFiles, scanPacks, type AgentPack, type BrokenPack } from "./agentdef.js";
import type { HubDir } from "./hubdir.js";

const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const CLONE_SUFFIX = "-clone";

/** `git@host:org/handbook.git` or `https://host/org/handbook` -> `handbook`. */
export function cloneNameFor(remote: string): string {
  const last = remote.replace(/[/:]+$/, "").split(/[/:]/).pop() ?? "source";
  const base = last.replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "source") + CLONE_SUFFIX;
}

export function isGitRemote(s: string): boolean {
  return /^(git@|ssh:\/\/|https?:\/\/|git:\/\/|file:\/\/)/.test(s) || /\.git$/.test(s);
}

export interface CloneInfo {
  dir: string;
  name: string;
  remote: string | null;
  head: string | null;
  committedAt: string | null;
  documents: number;
}

export function countDocs(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) n += countDocs(full);
    else if (/\.mdx?$/.test(entry.name)) n += 1;
  }
  return n;
}

/**
 * What a directory attach did NOT match, grouped by extension - so the "N files
 * match" line stops hiding what it left out (dogfood 2026-08-30, F12/F14: an
 * attach reported 623 matches while 616 were node_modules and the 262 files the
 * pack existed for were excluded). `node_modules`, `.git` and dot-entries are
 * NOT counted as skipped: the matcher excludes them by rule, and reporting a
 * vendored tree as "skipped knowledge" would be its own noise.
 */
export function skippedByExtension(root: string, matched: Iterable<string>): { ext: string; count: number }[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const keep = new Set([...matched].map((f) => path.resolve(f)));
  const counts = new Map<string, number>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (!keep.has(path.resolve(full))) {
        const ext = path.extname(e.name).toLowerCase() || "(no extension)";
        counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }
  };
  walk(root);
  return [...counts.entries()].map(([ext, count]) => ({ ext, count })).sort((a, b) => b.count - a.count);
}

/** The clones under a pack's knowledge directory, with what git says about each. */
export function packClones(pack: AgentPack): CloneInfo[] {
  const kdir = path.join(pack.dir, "knowledge");
  if (!fs.existsSync(kdir)) return [];
  return fs
    .readdirSync(kdir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.endsWith(CLONE_SUFFIX))
    .map((e) => {
      const dir = path.join(kdir, e.name);
      const cloned = fs.existsSync(path.join(dir, ".git"));
      const safe = (args: string[]) => {
        try {
          return cloned ? git(args, dir) : null;
        } catch {
          return null;
        }
      };
      return { dir, name: e.name, remote: safe(["remote", "get-url", "origin"]), head: safe(["rev-parse", "HEAD"]), committedAt: safe(["log", "-1", "--format=%cI"]), documents: countDocs(dir) };
    });
}

/** Clone on first use (shallow: a reading copy), fast-forward after. */
export function syncClone(dir: string, remote: string, opts: { depth?: number; stdio?: "inherit" | "pipe" } = {}): { head: string; fresh: boolean; created: boolean } {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "--depth", String(opts.depth ?? 50), remote, dir], { stdio: opts.stdio ?? "pipe" });
    return { head: git(["rev-parse", "HEAD"], dir), fresh: true, created: true };
  }
  const before = git(["rev-parse", "HEAD"], dir);
  git(["pull", "--ff-only"], dir);
  const after = git(["rev-parse", "HEAD"], dir);
  return { head: after, fresh: before !== after, created: false };
}

/**
 * A clone's HEAD, read from the files rather than through git (RFA-0.8 sect. 7
 * item 2).
 *
 * This runs at the START and the END of every model turn, so it must cost
 * nothing and must never throw: two small reads beat spawning `git rev-parse`
 * twice a turn, and a clone with no `.git` (a plain attached directory) simply
 * has no head, which is not an error. `packed-refs` is the case a fresh
 * `git clone` actually produces, so it is handled rather than assumed away; git
 * itself is the last resort.
 */
export function cloneHead(dir: string): string | null {
  const gitDir = path.join(dir, ".git");
  try {
    if (!fs.existsSync(gitDir)) return null;
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(4).trim();
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim() || null;
    const packed = path.join(gitDir, "packed-refs");
    if (fs.existsSync(packed)) {
      for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
        const [sha, name] = line.trim().split(/\s+/);
        if (name === ref && /^[0-9a-f]{40}$/.test(sha ?? "")) return sha;
      }
    }
    return git(["rev-parse", "HEAD"], dir) || null;
  } catch {
    return null;
  }
}

/**
 * Every knowledge clone under a pack, and where each one's HEAD is right now.
 * The stamp a turn compares against itself: a mismatch between start and end
 * means the corpus moved under the answer, whatever caused it - the drain
 * barrier being bypassed, or an operator's own hand-run `git pull`, which is
 * exactly the case a barrier alone can never catch.
 */
export function cloneHeads(packDir: string): Record<string, string> {
  const kdir = path.join(packDir, "knowledge");
  const out: Record<string, string> = {};
  if (!fs.existsSync(kdir)) return out;
  for (const entry of fs.readdirSync(kdir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(CLONE_SUFFIX)) continue;
    const head = cloneHead(path.join(kdir, entry.name));
    if (head) out[entry.name] = head;
  }
  return out;
}

/** Per-file provenance from the clone's own history: free, and exactly what a hosted connector cannot give. */
export function fileProvenance(clone: string, relative: string): { author: string; committed_at: string; sha: string } | null {
  try {
    const out = git(["log", "-1", "--format=%an <%ae>%x00%cI%x00%H", "--", relative], clone);
    if (!out) return null;
    const [author, committed_at, sha] = out.split("\u0000");
    return { author, committed_at, sha };
  } catch {
    return null;
  }
}

export interface PackKnowledge {
  pack: string;
  globs: string[];
  files: number;
  clones: CloneInfo[];
  /** The same page name resolved from two places: the cheapest detector of the one-fact-one-file rule being broken. */
  duplicates: { name: string; paths: string[] }[];
}

/**
 * What every pack reads, plus the packs whose definition could not be read at
 * all.
 *
 * TOLERANT across the instance: `listPacks` maps `loadPack` with no catch, so one
 * unparseable `agent.md` answered `rfa knowledge status` with a parse error
 * instead of the corpus, which also took the duplicate-page detector with it -
 * the cheapest instrument against the one-fact-one-file rule, off, because of an
 * unrelated pack. The broken names ride in the shape rather than being dropped:
 * a pack missing from a knowledge listing reads as a pack with no knowledge.
 */
export function knowledgeStatus(h: HubDir): { agents: PackKnowledge[]; broken: BrokenPack[] } {
  const { packs, broken } = scanPacks(h.paths.agents);
  const agents = packs.map((pack) => {
    const files = knowledgeFiles(pack);
    const byName = new Map<string, string[]>();
    for (const f of files) {
      const key = path.basename(f).toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), path.relative(pack.dir, f)]);
    }
    const duplicates = [...byName].filter(([, p]) => p.length > 1).map(([name, paths]) => ({ name, paths }));
    return { pack: pack.name, globs: pack.def.knowledge ?? [], files: files.length, clones: packClones(pack), duplicates };
  });
  return { agents, broken };
}

/** The eval corpus is a PINNED sha (sect. 19.4), so an upstream edit cannot read as a regression. */
export function pinCorpus(baselineFile: string, sha: string, now = new Date()): void {
  const baseline = fs.existsSync(baselineFile) ? (JSON.parse(fs.readFileSync(baselineFile, "utf8")) as Record<string, unknown>) : {};
  baseline.corpus_version = sha;
  baseline.corpus_pinned_at = now.toISOString();
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 1) + "\n");
}
