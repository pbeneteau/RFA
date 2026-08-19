/**
 * v0.5.3: the retrieval hint that decides which knowledge file the model opens.
 * Tested over the REAL synced corpus when it is present, because the failure
 * this guards against only appears at corpus scale: a header on every file
 * makes a naive "first non-empty line" return the same hint 46 times.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileHint } from "../src/knowledge.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

function write(dir: string, name: string, body: string): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
}

test("a hint skips a provenance header and carries the page's title AND description", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-hint-"));
  const withHeader = write(
    dir,
    "page.md",
    [
      "<!-- rfa-provenance",
      "source: handbook MCP",
      "page: offre/scpi.md",
      "-->",
      "---",
      "title: SCPI et parts de SCPI",
      "description: whatever",
      "---",
      "",
      "# Un titre de premier niveau",
      "",
      "Du contenu.",
    ].join("\n"),
  );
  // Both halves, in that order. The title alone was the 6.3% flake: it says what
  // the page is CALLED, and a question about a fee needs to know what is IN it.
  assert.equal(fileHint(withHeader), "SCPI et parts de SCPI - whatever");

  const blockScalar = write(
    dir,
    "block.md",
    ["---", "title: Une page", "description: >", "  du texte replie", "---", "", "corps"].join("\n"),
  );
  assert.equal(fileHint(blockScalar), "Une page", "a YAML block indicator must not become the hint");

  const descOnly = write(dir, "desconly.md", ["---", 'description: "Ce que contient la page."', "---", "", "corps"].join("\n"));
  assert.equal(fileHint(descOnly), "Ce que contient la page.", "a description with no title still beats the filename");

  const noTitle = write(dir, "b.md", ["<!-- rfa-provenance", "page: x", "-->", "", "# Le vrai titre", "", "corps"].join("\n"));
  assert.equal(fileHint(noTitle), "Le vrai titre", "falls back to the first heading, not the comment");

  const plain = write(dir, "c.md", "Juste une premiere ligne de prose.\n");
  assert.equal(fileHint(plain), "Juste une premiere ligne de prose.");

  const onlyHeader = write(dir, "d.md", "<!-- rfa-provenance\npage: y\n-->\n");
  assert.equal(fileHint(onlyHeader), "d.md", "a file with nothing but a header falls back to its name, never to the header");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("over the real corpus, hints are distinct and none is a header fragment", (t) => {
  const corpus = path.join(ROOT, "agents", "pm-agent", "knowledge", "handbook");
  if (!fs.existsSync(corpus)) {
    t.skip("no synced corpus in this checkout (knowledge/ is gitignored)");
    return;
  }
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      return e.isDirectory() ? walk(full) : /\.mdx?$/.test(e.name) ? [full] : [];
    });
  const files = walk(corpus);
  assert.ok(files.length >= 40, `expected the full corpus, found ${files.length} files`);

  const hints = files.map((f) => ({ file: path.relative(corpus, f), hint: fileHint(f) }));
  for (const { file, hint } of hints) {
    assert.ok(hint.length > 0, `${file} produced an empty hint`);
    assert.ok(!/^\s*[>|]-?\s*$/.test(hint), `${file} produced a bare YAML block indicator: ${hint}`);
    assert.ok(!hint.includes("rfa-provenance"), `${file} leaked its provenance header into the hint`);
    assert.notEqual(hint.trim(), "---", `${file} leaked a frontmatter fence`);
    assert.ok(!/^(source|page|fetched_at|upstream|note):/.test(hint), `${file} leaked a provenance field: ${hint}`);
  }
  // The point of a hint is to discriminate. Index pages legitimately collide,
  // so allow a few, but a corpus where most hints repeat is a broken hint.
  const counts = new Map<string, number>();
  for (const { hint } of hints) counts.set(hint, (counts.get(hint) ?? 0) + 1);
  const duplicated = [...counts.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
  assert.ok(
    duplicated <= Math.ceil(files.length * 0.3),
    `${duplicated} of ${files.length} hints are shared with another file, so they cannot discriminate`,
  );
});
