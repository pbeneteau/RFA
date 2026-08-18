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
 * them. Prefers a frontmatter `title:`, then the first heading, then the first
 * line of prose.
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

  const first = nextContent();
  if (first === null) return path.basename(f);
  if (first === "---") {
    for (i++; i < lines.length && lines[i].trim() !== "---"; i++) {
      const m = /^title:\s*(.+)$/.exec(lines[i]);
      if (m) return m[1].replace(/^["']|["']$/g, "").trim().slice(0, 90);
    }
    i++; // past the closing fence
    const afterFrontmatter = nextContent();
    return (afterFrontmatter ?? path.basename(f)).replace(/^#+\s*/, "").trim().slice(0, 90);
  }
  return first.replace(/^#+\s*/, "").trim().slice(0, 90);
}
