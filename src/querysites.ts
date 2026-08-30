/**
 * The inventory of every model call this platform makes (RFA-0.9 sect. 6.3).
 *
 * v0.4 sect. 3.12 names three mechanisms that hold a resident's tool surface and
 * RFA-0.8 sect. 9 adds a fourth, and all four are written as properties of a
 * RESIDENT SERVING A TURN. The platform makes model calls that are not that, and
 * one of them (the consolidation and reflection lane) ran on untrusted room
 * episodes with no `tools` restriction, no callback, no sandbox, no connector
 * suppression, and a working directory holding `.rfa/secrets.json`. Probe E9
 * measured `Read` succeeding there and returning a file's contents; E12 measured
 * the same read executing under the lane's production `maxTurns: 1`.
 *
 * So the containment doctrine was written about one call site and read as
 * covering all of them. This module is the list, and `unlistedQueryModules`
 * below is the check that makes it a control rather than a wish: a module that
 * reaches the SDK's `query` and is not named here fails `npm test`.
 *
 * THE ANCHOR IS THE IMPORT, never the text `query(` (sect. 6.3 says so, and
 * says why: `query(` matches a GraphQL literal and two prose comments in this
 * repository and would make the check red on arrival). An injected seam - a
 * module that never imports the SDK but is handed its `query` by a caller - is
 * not findable that way at all, so seams are listed explicitly with the marker
 * that proves the seam is still there.
 *
 * A THIRD REACH EXISTS and the import anchor is blind to it: spawning the
 * `claude` CLI as a child process is a model call over the same account, with
 * the same connectors, and it carried none of sect. 6's declarations for as
 * long as nothing scanned for it - the evals judge ran rubric-plus-untrusted-
 * trajectory prompts from the HUB ROOT that way (audit 2026-08-30, rank 4). So
 * the scan anchors on the spawn too: reach "spawn", detected by
 * `spawnsClaudeCli` below.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface QuerySite {
  /** Path relative to the repository root. */
  module: string;
  /** What this lane is for, in the words its own file uses. */
  lane: string;
  /**
   * How this module reaches the model. `import` is a direct
   * `import { query } from "@anthropic-ai/claude-agent-sdk"`; `injected` is a
   * seam whose caller hands it one, which no import scan can find; `spawn` is a
   * child process running the `claude` CLI, which is the same account and the
   * same connectors with none of the SDK's options unless the argv carries them.
   */
  reach: "import" | "injected" | "spawn";
  /** What sect. 6.1 requires this site to declare, and the source token that proves it declares it. */
  declares: {
    /** The SDK's base tool set this lane passes. `tools: []` is the empty-surface form sect. 6.1 mandates. */
    tools: string;
    /** The working directory, which decides the read surface for any lane that has one (E9). */
    cwd: string;
    /** How undeclared tools are refused: a callback, or an empty tool set that leaves nothing to refuse. */
    refusal: string;
  };
  /**
   * Tokens that MUST appear in the module's source. Each one is a declaration
   * sect. 6.1 requires, and its absence is how this list catches a lane that
   * silently loses one.
   */
  markers: string[];
}

export const QUERY_SITES: readonly QuerySite[] = [
  {
    module: "src/resident.ts",
    lane: "a resident serving a turn: the answer path, the task path and the candidate fan-out",
    reach: "import",
    declares: {
      tools: "posture.builtins - exactly the built-ins the pack declared, so every other one is ABSENT rather than merely denied",
      cwd: "the pack's own directory, or this run's scratch/<runId> when the pack is fenced (RFA-0.8 sect. 9)",
      refusal: "canUseTool, deny-by-default, hosting door one's path guard and the claim fence",
    },
    markers: ["tools: posture.builtins", "settings: { disableClaudeAiConnectors: true }", "canUseTool:"],
  },
  {
    module: "src/consolidate.ts",
    lane: "consolidation and reflection (`llmOnce`): untrusted room episodes distilled into facts, and the judged record distilled into lessons",
    reach: "import",
    declares: {
      tools: "[] - the empty set. sect. 6.1: a lane needing no tools passes `tools: []`, not merely `allowedTools: []`, because the first makes the tool ABSENT from the model's context and the second leaves it present behind a permission layer",
      cwd: "a fresh empty directory per call, never at or above the hub root (sect. 6.2, after E9 read a file out of the hub root through this lane)",
      refusal: "the empty tool set: there is nothing to refuse",
    },
    markers: ["tools: []", "settings: { disableClaudeAiConnectors: true }", "withIsolatedCwd("],
  },
  {
    module: "src/cli/draftpack.ts",
    lane: "the agent wizard's describe-first draft: the operator's own description of a wanted agent, composed into a proposed pack that is schema-validated before the wizard shows it and written only on approval",
    reach: "import",
    declares: {
      tools: "[] - the empty set. Drafting a pack needs no tools, so every built-in is ABSENT rather than merely denied (sect. 6.1)",
      cwd: "a fresh empty directory per call (withIsolatedCwd, the consolidation lane's own helper), never the hub root and never a caller's choice",
      refusal: "the empty tool set: there is nothing to refuse. The visible cost line sect. 6.1 asks for is the review screen's `drafted by <model> · $<cost>`",
    },
    markers: ["tools: []", "settings: { disableClaudeAiConnectors: true }", "withIsolatedCwd("],
  },
  {
    module: "scripts/egress-proof.ts",
    lane: "the live egress proof (sect. 10.2): sect. 4's obligations re-established against a real sandbox after every SDK bump",
    reach: "import",
    declares: {
      tools: '["Bash"] for the sandboxed-command probes, [] plus one MCP tool for the boundary probe, ["Task","Bash"] for the subagent one; the control runs vary deliberately, which is the point of a proof',
      cwd: "a fresh temp directory per probe, under one workspace removed at exit",
      refusal: "a RECORDING canUseTool where the question is whether door one is reached, and none where the question is whether the policy decides without it",
    },
    markers: ["settings: { disableClaudeAiConnectors: true }", "canUseTool:"],
  },
  {
    module: "src/fenceprobe.ts",
    lane: "the startup deny probe: one live call per guarded built-in, re-proving door one's fall-through against the installed SDK (RFA-0.8 sect. 9 item 1)",
    reach: "injected",
    declares: {
      tools: "[the guarded built-in under probe, plus the helpers it needs to reach it]",
      cwd: "a fresh temp directory holding only the probe's seed files",
      refusal: "canUseTool, which denies everything: the probe's whole question is whether the callback fires at all",
    },
    markers: ["export type ProbeQuery", "settings: { disableClaudeAiConnectors: true }", "canUseTool:"],
  },
  {
    module: "src/evals/judge.ts",
    lane: "the binary judge (RFA-0.5 sect. 20.1): a rubric plus an untrusted trajectory, spawned through the claude CLI on a cross-tier model",
    reach: "spawn",
    declares: {
      tools: '`--tools ""` - the CLI\'s empty-surface form: every built-in ABSENT, plus `--strict-mcp-config` with no config so no MCP server exists',
      cwd: "a fresh empty temp directory per call (withIsolatedCwd), never the hub root this spawn inherited until 2026-08-30",
      refusal: "the empty tool set: a verdict needs no tools, so there is nothing to refuse",
    },
    markers: ['"--tools", ""', '"--strict-mcp-config"', "disableClaudeAiConnectors: true", "withIsolatedCwd("],
  },
];

/** Directories the check walks. `test/` is excluded: a test may construct a fake `query` freely. */
const SCANNED = ["src", "scripts"];

/**
 * Does this source text import `query` from the SDK?
 *
 * Deliberately tolerant about formatting (a multi-line import block, an alias, a
 * type-only import beside it) and deliberately strict about the specifier: the
 * question sect. 6.3 asks is "does this module reach the SDK's query", and the
 * only honest answer comes from the import statement that would let it.
 */
export function importsSdkQuery(source: string): boolean {
  const code = stripComments(source);
  for (const hit of code.matchAll(/["']@anthropic-ai\/claude-agent-sdk["']/g)) {
    // The NEAREST preceding `import`, not a lazy match from the first one in the
    // file: this repository's own consolidate.ts opens with a usage line reading
    // `node --import tsx src/consolidate.ts`, and a lazy scan from the top
    // swallowed it and reported the real import as absent. Found by the test
    // below, which is what an enforced inventory is for.
    const head = code.lastIndexOf("import", hit.index);
    if (head < 0) continue;
    const clause = code.slice(head + "import".length, hit.index);
    if (!/\bfrom\s*$/.test(clause)) continue;
    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (!braces) continue;
    for (const spec of braces[1].split(",")) {
      const name = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name === "query") return true;
    }
  }
  return false;
}

/** Line and block comments removed, so a comment that MENTIONS the specifier is not an import of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * A missing scanned directory THROWS rather than contributing nothing.
 *
 * Silently returning `[]` is how this check passes vacuously: a caller that
 * computes the repository root wrongly (a percent-encoded `file://` pathname was
 * the real case) walks nothing, finds no unlisted importer, and reports a green
 * tick over a property nobody checked. That is the defect RFA-0.9 exists to
 * remove, so the scan refuses to be silent about its own blindness.
 */
function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) throw new Error(`query-site scan: ${dir} does not exist, so this check would pass without looking at anything`);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
}

/**
 * Does this source text spawn the `claude` CLI in PROMPT mode - a model call?
 *
 * The third reach: no import to anchor on, so the anchor is the process API
 * with the literal binary name AND `-p`/`--print` leading the argv, because the
 * binary name alone is not a model call: this repository legitimately runs
 * `claude auth status` (preflight) and `claude --version` (connect), which
 * spend no tokens and read no prompt, and the first draft of this detector
 * flagged both. A dynamically assembled argv would evade the anchor; this scan
 * is a control against drift, not an adversary, and a lane hiding its prompt
 * flag behind a variable has left "drift" territory already.
 */
export function spawnsClaudeCli(source: string): boolean {
  return /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*["']claude["']\s*,\s*\[\s*["'](?:-p|--print)["']/.test(stripComments(source));
}

/**
 * Every module under `src/` and `scripts/` that reaches the model - by
 * importing the SDK's `query` OR by spawning the `claude` CLI - and is NOT in
 * the inventory above. Empty is the only acceptable answer.
 */
export function unlistedQueryModules(root: string): string[] {
  const listed = new Set(QUERY_SITES.map((s) => s.module));
  const files: string[] = [];
  for (const d of SCANNED) walk(path.join(root, d), files);
  return files
    .filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return importsSdkQuery(source) || spawnsClaudeCli(source);
    })
    .map((f) => path.relative(root, f).split(path.sep).join("/"))
    .filter((rel) => !listed.has(rel))
    .sort();
}

/**
 * Every inventory entry whose module is missing, or which has lost one of the
 * declarations sect. 6.1 requires of it.
 *
 * The other half of the check, and the one that matters more: a list that only
 * catches NEW call sites lets an existing one quietly drop `tools` or the
 * connector suppression, which is exactly how the consolidation lane got where
 * E9 found it.
 */
export function siteDeclarationFailures(root: string): string[] {
  const out: string[] = [];
  for (const site of QUERY_SITES) {
    const file = path.join(root, site.module);
    if (!fs.existsSync(file)) {
      out.push(`${site.module} is in the query-site inventory and does not exist`);
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    if (site.reach === "import" && !importsSdkQuery(source)) {
      out.push(`${site.module} is listed as importing the SDK's query and does not; move it to reach "injected" or take it off the list`);
    }
    if (site.reach === "spawn" && !spawnsClaudeCli(source)) {
      out.push(`${site.module} is listed as spawning the claude CLI and does not; take it off the list or fix the detector`);
    }
    for (const marker of site.markers) {
      if (!source.includes(marker)) out.push(`${site.module} no longer contains ${JSON.stringify(marker)}, a declaration RFA-0.9 sect. 6.1 requires of it`);
    }
  }
  return out;
}
