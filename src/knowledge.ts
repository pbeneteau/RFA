/**
 * Knowledge-pack helpers shared by the resident and its tests.
 *
 * Extracted from the resident because the resident boots a room member at
 * import time, so nothing inside it can be unit tested; a hint function that
 * decides what the model reads deserves a test over the real corpus.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The retrieval hint for a knowledge file: what this file is about, in one
 * line, so the model can pick the right file to open instead of grepping 50 of
 * them. Prefers the frontmatter `title:` PLUS its `description:`, then the first
 * heading, then the first line of prose.
 *
 * The description is the half that does the work, and leaving it out cost a
 * measured 6.3% answer flake for a month. A title is what the author CALLS the
 * page; a description is what the author says is IN it. Asked for the annual
 * management fee on plan A, the agent opened `offre/plan-a.md`, whose title
 * matches the question exactly and which holds a fund table with no fee, then
 * hunted: the fee is a table row in `offre/enveloppes.md`, whose title is the
 * single word "Enveloppes" and whose description names the contracts, their
 * entry conditions and their tax treatment. So the well-named file was a decoy
 * and the right file was unadvertised. Trials that gave up answered "not
 * documented" while citing a real file, and trials that kept hunting ran into
 * the pack's 8-turn ceiling and returned NOTHING (`error_max_turns`), which is
 * the same defect wearing two faces. 35 of this pack's 38 files carry a
 * description that was being thrown away.
 *
 * The skipping is load-bearing, not tidiness. A provenance header or a
 * frontmatter block at the top of every file makes a naive "first non-empty
 * line" return the same string for every file, and a hint list where all 46
 * entries read `<!-- rfa-provenance` is worse than no hints at all: it points
 * the model at nothing while costing tokens. Found the moment a synced corpus
 * arrived with headers on it.
 */
export function fileHint(f: string): string {
  const lines = fs.readFileSync(f, "utf8").slice(0, 4000).split("\n");

  // One pass, in the order a reader meets the file: strip HTML comments (the
  // provenance header), then frontmatter (preferring its `title`, which is the
  // author's own description of the page), then fall back to the first heading
  // or line of prose.
  let i = 0;
  const nextContent = (): string | null => {
    for (; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      if (line.startsWith("<!--")) {
        if (!line.includes("-->")) {
          for (i++; i < lines.length && !lines[i].includes("-->"); i++);
        }
        continue;
      }
      return line;
    }
    return null;
  };

  const scalar = (raw: string, cap: number): string | null => {
    // A YAML block scalar (`description: >`) carries its text on the following
    // lines; taking the indicator would put a lone ">" in the hint.
    const v = raw.replace(/^["']|["']$/g, "").trim();
    return v.length === 0 || v === ">" || v === "|" || v === ">-" || v === "|-" ? null : v.slice(0, cap);
  };

  const first = nextContent();
  if (first === null) return path.basename(f);
  if (first === "---") {
    let title: string | null = null;
    let description: string | null = null;
    for (i++; i < lines.length && lines[i].trim() !== "---"; i++) {
      const t = /^title:\s*(.+)$/.exec(lines[i]);
      if (t && title === null) title = scalar(t[1], 90);
      const d = /^description:\s*(.+)$/.exec(lines[i]);
      if (d && description === null) description = scalar(d[1], 150);
    }
    // Both when both exist: the title to recognize the page, the description to
    // know whether the answer is inside it.
    const combined = [title, description].filter(Boolean).join(" - ");
    if (combined.length > 0) return combined;
    i++; // past the closing fence
    const afterFrontmatter = nextContent();
    return (afterFrontmatter ?? path.basename(f)).replace(/^#+\s*/, "").trim().slice(0, 90);
  }
  return first.replace(/^#+\s*/, "").trim().slice(0, 90);
}
