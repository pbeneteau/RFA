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
import { knowledgeFiles, listPacks, type AgentPack } from "./agentdef.js";
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

export function knowledgeStatus(h: HubDir): PackKnowledge[] {
  return listPacks(h.paths.agents).map((pack) => {
    const files = knowledgeFiles(pack);
    const byName = new Map<string, string[]>();
    for (const f of files) {
      const key = path.basename(f).toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), path.relative(pack.dir, f)]);
    }
    const duplicates = [...byName].filter(([, p]) => p.length > 1).map(([name, paths]) => ({ name, paths }));
    return { pack: pack.name, globs: pack.def.knowledge ?? [], files: files.length, clones: packClones(pack), duplicates };
  });
}

/** The eval corpus is a PINNED sha (sect. 19.4), so an upstream edit cannot read as a regression. */
export function pinCorpus(baselineFile: string, sha: string, now = new Date()): void {
  const baseline = fs.existsSync(baselineFile) ? (JSON.parse(fs.readFileSync(baselineFile, "utf8")) as Record<string, unknown>) : {};
  baseline.corpus_version = sha;
  baseline.corpus_pinned_at = now.toISOString();
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 1) + "\n");
}
