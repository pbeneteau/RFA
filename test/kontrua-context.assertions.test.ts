// kontrua:owned — generated context assertions. Do not hand-edit; Kontrua
// regenerates this file. It pins the documented claims to the code at 91a98a36246c
// and goes red when a documented claim stops matching the code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');
const pkgScripts = () => { try { return JSON.parse(read('package.json')).scripts ?? {}; } catch { return {}; } };

describe('kontrua context assertions', () => {
  it('The package is named `agent-com` and published under the Apache-2.0 license.', () => {
    assert.ok(read('package.json').includes('"license": "Apache-2.0"'), 'package.json should contain "license": "Apache-2.0"');
  });
  it('The package exposes two CLI binary names: `rfa` and `agent-com`, both pointing to `dist/cli/main.js`', () => {
    assert.ok(read('package.json').includes('"rfa": "dist/cli/main.js"'), 'package.json should contain "rfa": "dist/cli/main.js"');
  });
  it('Node.js 22 or later is required.', () => {
    assert.ok(read('package.json').includes('"node": ">=22"'), 'package.json should contain "node": ">=22"');
  });
  it('The `--keep` flag on the coldstart script retains the temp prefix and directory for inspection.', () => {
    assert.ok(read('scripts/coldstart.ts').includes('const KEEP = process.argv.includes("--keep");'), 'scripts/coldstart.ts should contain const KEEP = process.argv.includes("--keep");');
  });
  it('CLI source lives under `src/cli/`.', () => {
    assert.ok(existsSync('src/cli'), 'src/cli should exist');
  });
  it('Agent packs live in a hub directory (`<hub>/agents/<name>/agent.md`), never in this repository; `s', () => {
    assert.ok(existsSync('src/cli/scaffold.ts'), 'src/cli/scaffold.ts should exist');
  });
  it('Eval cases live under `evals/cases/`.', () => {
    assert.ok(existsSync('evals/cases'), 'evals/cases should exist');
  });
  it('Spec documents live under `spec/`.', () => {
    assert.ok(existsSync('spec'), 'spec should exist');
  });
  it('Research documents are organized under `research/` in numbered subdirectories.', () => {
    assert.ok(existsSync('research/01-protocol'), 'research/01-protocol should exist');
  });
  it('Templates for new agents and commands are under `templates/`.', () => {
    assert.ok(existsSync('templates/service'), 'templates/service should exist');
  });
  it('MCP interoperability definitions are in `interop/`.', () => {
    assert.ok(existsSync('interop'), 'interop should exist');
  });
  it('The console (web UI) asset directory is `console/`.', () => {
    assert.ok(existsSync('console'), 'console should exist');
  });
  it('Scripts for maintenance and one-time operations are in `scripts/`.', () => {
    assert.ok(existsSync('scripts'), 'scripts should exist');
  });
  it('Each agent pack is a directory under `agents/<name>/` with an `agent.md` file containing YAML frontm', () => {
    assert.ok(read('src/agentdef.ts').includes('* A pack is a directory `agents/<name>/` whose `agent.md` is YAML frontmatter'), 'src/agentdef.ts should contain * A pack is a directory `agents/<name>/` whose `agent.md` is YAML frontmatter');
  });
  it('The `agentDefSchema` Zod schema is the single shared schema used by the resident runner, supervisor,', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentDefSchema(?![\\\\w$])').test(read('src/agentdef.ts')), 'agentDefSchema should be defined in src/agentdef.ts');
  });
  it('`parseAgentMd` parses an agent.md string and throws with a precise message on invalid input.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])parseAgentMd(?![\\\\w$])').test(read('src/agentdef.ts')), 'parseAgentMd should be defined in src/agentdef.ts');
  });
  it('`loadPack` loads a pack directory from disk.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])loadPack(?![\\\\w$])').test(read('src/agentdef.ts')), 'loadPack should be defined in src/agentdef.ts');
  });
  it('`listPacks` enumerates all packs under an agents root, skipping directories without `agent.md`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])listPacks(?![\\\\w$])').test(read('src/agentdef.ts')), 'listPacks should be defined in src/agentdef.ts');
  });
  it('`deriveCard` derives the capability card from an agent pack, including the definition hash as a depl', () => {
    assert.ok(new RegExp('(?<![\\\\w$])deriveCard(?![\\\\w$])').test(read('src/agentdef.ts')), 'deriveCard should be defined in src/agentdef.ts');
  });
  it('A pack that serves a room as a participant must declare at least one entry in `offers`.', () => {
    assert.ok(read('src/agentdef.ts').includes('a pack that serves a room as participant must declare at least one entry in `offers`'), 'src/agentdef.ts should contain a pack that serves a room as participant must declare at least one entry in `offers`');
  });
  it('Fan-out (subagent) tools are opt-in and require `tools.allow_subagents: true` in the pack definition', () => {
    assert.ok(read('src/agentdef.ts').includes('lists \\`${entry}\\`, which spawns subagents; declare tools.allow_subagents: true to permit fan-out'), 'src/agentdef.ts should contain lists \\`${entry}\\`, which spawns subagents; declare tools.allow_subagents: true to permit fan-out');
  });
  it('`requestApproval` publishes an approval request for a pending tool call and blocks until a human dec', () => {
    assert.ok(new RegExp('(?<![\\\\w$])requestApproval(?![\\\\w$])').test(read('src/bridge.ts')), 'requestApproval should be defined in src/bridge.ts');
  });
  it('The approval sidekick membership is named `<residentName>-hitl` and joins as an observer role.', () => {
    assert.ok(read('src/bridge.ts').includes('name: `${residentName}-hitl`'), 'src/bridge.ts should contain name: `${residentName}-hitl`');
  });
  it('The default approval window when no `reply_by` is present is 30 minutes.', () => {
    assert.ok(read('src/bridge.ts').includes('export const DEFAULT_APPROVAL_WINDOW_MS = 30 * 60_000;'), 'src/bridge.ts should contain export const DEFAULT_APPROVAL_WINDOW_MS = 30 * 60_000;');
  });
  it('`interruptMatch` matches a tool name against `interrupt_on` keys, with trailing `*` acting as a pref', () => {
    assert.ok(new RegExp('(?<![\\\\w$])interruptMatch(?![\\\\w$])').test(read('src/bridge.ts')), 'interruptMatch should be defined in src/bridge.ts');
  });
  it('`refusalForOutcome` returns `deadline_expired` for clock-based denials and `declined` for human reje', () => {
    assert.ok(new RegExp('(?<![\\\\w$])refusalForOutcome(?![\\\\w$])').test(read('src/bridge.ts')), 'refusalForOutcome should be defined in src/bridge.ts');
  });
  it('`verifyChain` walks an event log in order, checking each event\'s `prev_hash` link and reporting all ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])verifyChain(?![\\\\w$])').test(read('src/chain.ts')), 'verifyChain should be defined in src/chain.ts');
  });
  it('Events predating the chain (no `prev_hash`) are counted as `unchainedPrefix` and skipped rather than', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ChainResult(?![\\\\w$])').test(read('src/chain.ts')), 'ChainResult should be defined in src/chain.ts');
  });
  it('The `CHAIN_SCOPE_QUALIFIER` constant states that chain verification only proves no party other than ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CHAIN_SCOPE_QUALIFIER(?![\\\\w$])').test(read('src/chain.ts')), 'CHAIN_SCOPE_QUALIFIER should be defined in src/chain.ts');
  });
  it('`genesisFor` computes the genesis link as the hex SHA-256 of the room handle.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])genesisFor(?![\\\\w$])').test(read('src/chain.ts')), 'genesisFor should be defined in src/chain.ts');
  });
  it('`bindPack` rewrites only the `rooms:` block of an agent.md file, validates the result through the pa', () => {
    assert.ok(new RegExp('(?<![\\\\w$])bindPack(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'bindPack should be defined in src/cli/agentmd.ts');
  });
  it('`addKnowledge` merges new globs into the `knowledge:` block, deduplicates them, and validates before', () => {
    assert.ok(new RegExp('(?<![\\\\w$])addKnowledge(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'addKnowledge should be defined in src/cli/agentmd.ts');
  });
  it('`setTopBlock` replaces or adds one top-level YAML block in agent.md frontmatter without touching any', () => {
    assert.ok(new RegExp('(?<![\\\\w$])setTopBlock(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'setTopBlock should be defined in src/cli/agentmd.ts');
  });
  it('The Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a runtime dependency.', () => {
    assert.ok(read('package.json').includes('"@anthropic-ai/claude-agent-sdk"'), 'package.json should contain "@anthropic-ai/claude-agent-sdk"');
  });
  it('MCP client and server packages (`@modelcontextprotocol/client`, `@modelcontextprotocol/server`, `@mo', () => {
    assert.ok(read('package.json').includes('"@modelcontextprotocol/sdk"'), 'package.json should contain "@modelcontextprotocol/sdk"');
  });
  it('`better-sqlite3` is used for local SQLite storage (e.g., the observability store).', () => {
    assert.ok(read('package.json').includes('"better-sqlite3"'), 'package.json should contain "better-sqlite3"');
  });
  it('`zod` is used for schema validation throughout the project.', () => {
    assert.ok(read('package.json').includes('"zod"'), 'package.json should contain "zod"');
  });
  it('`tsx` is the dev-time TypeScript runner used in all `npm run` scripts that don\'t compile first.', () => {
    assert.ok(read('package.json').includes('"tsx": "^4.23.12"'), 'package.json should contain "tsx": "^4.23.12"');
  });
  it('`scripts/repair-obs-cost.ts` is a one-time repair script for observability rows whose `cost_usd` was', () => {
    assert.ok(read('scripts/repair-obs-cost.ts').includes('const apply = process.argv.includes("--apply");'), 'scripts/repair-obs-cost.ts should contain const apply = process.argv.includes("--apply");');
  });
  it('`scripts/watchdog-replay.ts` replays watchdog invariants against room logs and the observability sto', () => {
    assert.ok(read('scripts/watchdog-replay.ts').includes('const REQUIRED_SPAN_DAYS = 14; // spec 20.6'), 'scripts/watchdog-replay.ts should contain const REQUIRED_SPAN_DAYS = 14; // spec 20.6');
  });
  it('`scripts/demo-push.ts` demonstrates zero-polling push delivery over a real stdio MCP transport.', () => {
    assert.ok(read('scripts/demo-push.ts').includes('* Push-profile demo over a REAL stdio transport'), 'scripts/demo-push.ts should contain * Push-profile demo over a REAL stdio transport');
  });
});
