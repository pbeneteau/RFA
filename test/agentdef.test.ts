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

test("tools.allow_subagents: fan-out is opt-in and the refusal names the tool (spec 18.7)", () => {
  // Default false, so an existing pack keeps its meaning without declaring it.
  assert.equal(parseAgentMd(VALID).def.tools?.allow_subagents, false);
  for (const entry of ["Agent", "Task", "task", "Agent(explore)"]) {
    assert.throws(
      () => parseAgentMd(VALID.replace("allow: [Read, Grep]", `allow: [Read, ${entry}]`)),
      (err: Error) => {
        // The error must NAME the offending tool and the field that unlocks it.
        assert.match(err.message, /tools\.allow/);
        assert.ok(err.message.includes(entry), `error should name ${entry}: ${err.message}`);
        assert.match(err.message, /allow_subagents/);
        return true;
      },
      `${entry} in tools.allow must fail validation`,
    );
  }
  // Declared explicitly, the same definition is valid.
  const opted = parseAgentMd(VALID.replace("allow: [Read, Grep]", "allow: [Read, Agent]\n  allow_subagents: true"));
  assert.equal(opted.def.tools?.allow_subagents, true);
  assert.deepEqual(opted.def.tools?.allow, ["Read", "Agent"]);
  // `deny` is not an admission, and a lookalike tool name is not fan-out.
  assert.ok(parseAgentMd(VALID.replace("allow: [Read, Grep]", "allow: [Read]\n  deny: [Agent, Task]")));
  assert.ok(parseAgentMd(VALID.replace("allow: [Read, Grep]", "allow: [Read, TaskBoard, AgentCard]")));
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

// ---------------------------------------------------------------- concurrency (RFA-0.8 sect. 10)

const CONC = (extra: string) => `---
rfa_agent: 1
name: conc-agent
description: A concurrent answerer.
tools:
  allow: [Read, Grep]
offers:
  - id: answer-things
    description: Answers things.
${extra}---
Body.
`;

test("concurrency: defaults to 1, and above 1 needs all three gates of RFA-0.8 sect. 10", () => {
  assert.equal(parseAgentMd(CONC("")).def.concurrency, 1, "a pack that says nothing runs one turn at a time");
  assert.equal(parseAgentMd(CONC("concurrency: 1\n")).def.concurrency, 1);

  // Gate 3, the ceiling. A warning is not a control at N > 1: it scales the
  // exposure by N and changes nothing.
  assert.throws(() => parseAgentMd(CONC("concurrency: 2\n")), /per_day_usd/);

  // All three passing.
  const ok = parseAgentMd(CONC("concurrency: 3\nbudgets:\n  per_day_usd: 5\n")).def;
  assert.equal(ok.concurrency, 3);

  // Gate 1, posture: a pack with acting tools waits for the fence of sect. 9.
  assert.throws(
    () =>
      parseAgentMd(
        CONC("concurrency: 2\nbudgets:\n  per_day_usd: 5\ninterrupt_on:\n  \"mcp__linear__*\": true\n").replace("allow: [Read, Grep]", "allow: [Read, mcp__linear__save_document]"),
      ),
    /read-only/,
  );

  // Gate 2, memory topology: a destructive memory verb belongs to the
  // consolidation lane (sect. 4 item 2).
  assert.throws(
    () => parseAgentMd(CONC("concurrency: 2\nbudgets:\n  per_day_usd: 5\n").replace("allow: [Read, Grep]", "allow: [Read, mcp__memory__delete]")),
    /destructive memory verbs/,
  );
  // ... and it is fine at concurrency 1, which is what makes it a gate and not a ban.
  assert.equal(parseAgentMd(CONC("").replace("allow: [Read, Grep]", "allow: [Read, mcp__memory__delete]")).def.concurrency, 1);

  // Every failing gate is named at once, so an operator fixes the pack in one pass.
  assert.throws(
    () => parseAgentMd(CONC("concurrency: 2\n").replace("allow: [Read, Grep]", "allow: [Read, mcp__memory__rename]")),
    /does not pass 2 gates/,
  );
  assert.throws(() => parseAgentMd(CONC("concurrency: 0\nbudgets:\n  per_day_usd: 5\n")), /concurrency/);
});

test("sandbox.isolation accepts only what is implemented: a dead safety setting is refused by name", () => {
  // Found 2026-08-26 at rung 6's trigger check: the field accepted three values
  // and no production module read any of them, so `container` bought nothing and
  // said nothing. RFA-0.8 sect. 8.1.
  const withIsolation = (v: string) => VALID.replace("effort: low\n", `effort: low\nsandbox:\n  isolation: ${v}\n`);

  assert.equal(parseAgentMd(withIsolation("none")).def.sandbox?.isolation, "none");
  // Absent stays legal and defaults, so no existing pack is broken by the refusal.
  assert.equal(parseAgentMd(VALID).def.sandbox, undefined);

  for (const dead of ["worktree", "container"]) {
    assert.throws(
      () => parseAgentMd(withIsolation(dead)),
      /only .none. is implemented/,
      `${dead} must be refused by name, not silently honoured as none`,
    );
  }
  // The refusal names what each value would require, so the operator learns the
  // state of the world rather than just being told no.
  assert.throws(() => parseAgentMd(withIsolation("worktree")), /rejected on the merits/);
  assert.throws(() => parseAgentMd(withIsolation("container")), /parked/);
  assert.throws(() => parseAgentMd(withIsolation("clone")), /becomes legal with RFA-0\.8 rung 6a/);
  // A value that is not even in the enum must not be told that three refused
  // values are legal, which is zod's default enum error (RFA-0.8 sect. 8.1).
  assert.throws(() => parseAgentMd(withIsolation("vm")), /only .none. is implemented/);
});
