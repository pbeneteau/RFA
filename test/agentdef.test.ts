/** Agent pack definitions (RFA v0.4 section 3): schema, card derivation, digest semantics. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deriveCard, knowledgeFiles, listPacks, loadPack, parseAgentMd } from "../src/agentdef.js";
import { digestCard } from "../src/jcs.js";

const VALID = `---
rfa_agent: 1
name: test-agent
description: A test agent.
model: haiku
effort: low
tools:
  allow: [Read, Grep]
offers:
  - id: answer-things
    description: Answers things.
budgets:
  max_turns: 5
  per_task_usd: 0.1
rooms:
  - room: r_abc
    serve: true
---

You are the test agent. Answer things.
`;

test("parseAgentMd: valid definition parses; body is the prompt; hash covers the whole file", () => {
  const { def, prompt, definitionHash } = parseAgentMd(VALID);
  assert.equal(def.name, "test-agent");
  assert.equal(def.model, "haiku");
  assert.equal(def.budgets?.max_turns, 5);
  assert.equal(def.rooms?.[0].serve, true);
  assert.ok(prompt.startsWith("You are the test agent"));
  assert.match(definitionHash, /^sha256:[0-9a-f]{64}$/);
  // Any byte change rotates the hash (the deployed-version marker).
  const other = parseAgentMd(VALID.replace("Answer things.", "Answer things?"));
  assert.notEqual(other.definitionHash, definitionHash);
});

test("parseAgentMd: precise rejections", () => {
  assert.throws(() => parseAgentMd("no frontmatter here"), /frontmatter/);
  assert.throws(() => parseAgentMd("---\n: bad: [yaml\n---\nbody"), /YAML|invalid/);
  assert.throws(() => parseAgentMd(VALID.replace("rfa_agent: 1", "rfa_agent: 2")), /rfa_agent/);
  // A serving participant must offer at least one card skill.
  assert.throws(
    () => parseAgentMd(VALID.replace(/offers:[\s\S]*?description: Answers things\.\n/, "")),
    /offers/,
  );
  // The body is the system prompt; an empty one is a broken pack.
  assert.throws(() => parseAgentMd(VALID.replace(/---\n\nYou are[\s\S]*$/, "---\n")), /body/);
});

test("deriveCard: card comes from the definition and its digest rotates with it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-pack-"));
  fs.mkdirSync(path.join(dir, "test-agent"));
  fs.writeFileSync(path.join(dir, "test-agent", "agent.md"), VALID);
  const pack = loadPack(path.join(dir, "test-agent"));
  const card = deriveCard(pack);
  assert.equal(card.name, "test-agent");
  assert.deepEqual(card.skills?.map((s) => s.id), ["answer-things"]);
  assert.equal(card.definition_hash, pack.definitionHash);
  const digest1 = digestCard(card);
  // Editing the definition (even only the prompt body) rotates the card digest.
  fs.writeFileSync(path.join(dir, "test-agent", "agent.md"), VALID + "\nMore prompt.\n");
  const digest2 = digestCard(deriveCard(loadPack(path.join(dir, "test-agent"))));
  assert.notEqual(digest2, digest1);
  // listPacks skips non-pack directories.
  fs.mkdirSync(path.join(dir, "not-a-pack"));
  assert.deepEqual(listPacks(dir).map((p) => p.name), ["test-agent"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("knowledgeFiles: resolves globs and plain paths to existing .md files only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-know-"));
  const packDir = path.join(dir, "a");
  fs.mkdirSync(path.join(packDir, "knowledge", "sub"), { recursive: true });
  fs.writeFileSync(path.join(packDir, "agent.md"), VALID.replace("rooms:", "knowledge:\n  - \"knowledge/**/*.md\"\n  - \"../plain.md\"\nrooms:"));
  fs.writeFileSync(path.join(packDir, "knowledge", "one.md"), "x");
  fs.writeFileSync(path.join(packDir, "knowledge", "sub", "two.md"), "x");
  fs.writeFileSync(path.join(packDir, "knowledge", "ignored.txt"), "x");
  fs.writeFileSync(path.join(dir, "plain.md"), "x");
  const files = knowledgeFiles(loadPack(packDir)).map((f) => path.basename(f)).sort();
  assert.deepEqual(files, ["one.md", "plain.md", "two.md"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
