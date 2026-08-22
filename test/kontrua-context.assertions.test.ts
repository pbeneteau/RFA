// kontrua:owned — generated context assertions. Do not hand-edit; Kontrua
// regenerates this file. It pins the documented claims to the code at 542c2cadfe4f
// and goes red when a documented claim stops matching the code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');
const pkgScripts = () => { try { return JSON.parse(read('package.json')).scripts ?? {}; } catch { return {}; } };

describe('kontrua context assertions', () => {
  it('Node.js 22 or later is required.', () => {
    assert.ok(read('package.json').includes('"node": ">=22"'), 'package.json should contain "node": ">=22"');
  });
  it('Two CLI bin aliases are provided: `rfa` and `agent-com`, both pointing to `dist/cli/main.js`.', () => {
    assert.ok(read('package.json').includes('"rfa": "dist/cli/main.js"'), 'package.json should contain "rfa": "dist/cli/main.js"');
  });
  it('Unit tests are executed with `node --import tsx --test` over `test/*.test.ts`.', () => {
    assert.ok(read('package.json').includes('"test": "node --import tsx --test test/*.test.ts"'), 'package.json should contain "test": "node --import tsx --test test/*.test.ts"');
  });
  it('The cold-start integration test (`scripts/coldstart.ts`) packs the checkout, installs the tarball gl', () => {
    assert.ok(read('scripts/coldstart.ts').includes('not in `npm test`'), 'scripts/coldstart.ts should contain not in `npm test`');
  });
  it('Agent pack definitions live under `agents/`, each in its own subdirectory containing an `agent.md` f', () => {
    assert.ok(existsSync('agents/pm-agent'), 'agents/pm-agent should exist');
  });
  it('CLI source files are under `src/cli/`.', () => {
    assert.ok(existsSync('src/cli'), 'src/cli should exist');
  });
  it('Eval source files are under `src/evals/`.', () => {
    assert.ok(existsSync('src/evals'), 'src/evals should exist');
  });
  it('Research notes are under `research/`, divided into numbered topic directories.', () => {
    assert.ok(existsSync('research/01-protocol'), 'research/01-protocol should exist');
  });
  it('Specification files are in `spec/`.', () => {
    assert.ok(existsSync('spec'), 'spec should exist');
  });
  it('Interoperability definitions are in `interop/`.', () => {
    assert.ok(existsSync('interop'), 'interop should exist');
  });
  it('Agent and command templates are in `templates/`.', () => {
    assert.ok(existsSync('templates/service'), 'templates/service should exist');
  });
  it('The web console asset is in `console/`.', () => {
    assert.ok(existsSync('console'), 'console should exist');
  });
  it('Published package files include `dist`, `console`, `templates`, `interop`, `spec`, and `README.md`.', () => {
    assert.ok(read('package.json').includes('"dist",\n    "console",\n    "templates",\n    "interop"'), 'package.json should contain "dist",\n    "console",\n    "templates",\n    "interop"');
  });
  it('An agent pack is a directory under `agents/<name>/` whose `agent.md` begins with YAML frontmatter (t', () => {
    assert.ok(new RegExp('(?<![\\\\w$])parseAgentMd(?![\\\\w$])').test(read('src/agentdef.ts')), 'parseAgentMd should be defined in src/agentdef.ts');
  });
  it('The frontmatter schema is `agentDefSchema`, validated with Zod.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentDefSchema(?![\\\\w$])').test(read('src/agentdef.ts')), 'agentDefSchema should be defined in src/agentdef.ts');
  });
  it('The frontmatter must declare `rfa_agent: 1` as a literal field.', () => {
    assert.ok(read('src/agentdef.ts').includes('rfa_agent: z.literal(1)'), 'src/agentdef.ts should contain rfa_agent: z.literal(1)');
  });
  it('A pack that serves a room as participant must declare at least one entry in `offers`.', () => {
    assert.ok(read('src/agentdef.ts').includes('a pack that serves a room as participant must declare at least one entry in `offers`'), 'src/agentdef.ts should contain a pack that serves a room as participant must declare at least one entry in `offers`');
  });
  it('Sub-agent fan-out tools (`agent`, `task`) are deny-listed by default and require `tools.allow_subage', () => {
    assert.ok(new RegExp('(?<![\\\\w$])SUBAGENT_TOOLS(?![\\\\w$])').test(read('src/agentdef.ts')), 'SUBAGENT_TOOLS should be defined in src/agentdef.ts');
  });
  it('The capability card is derived from the pack definition via `deriveCard`, including a `definition_ha', () => {
    assert.ok(new RegExp('(?<![\\\\w$])deriveCard(?![\\\\w$])').test(read('src/agentdef.ts')), 'deriveCard should be defined in src/agentdef.ts');
  });
  it('All secret names a pack requires are collected by `declaredSecretNames`, covering both `secrets` and', () => {
    assert.ok(new RegExp('(?<![\\\\w$])declaredSecretNames(?![\\\\w$])').test(read('src/agentdef.ts')), 'declaredSecretNames should be defined in src/agentdef.ts');
  });
  it('Tool calls matching an `interrupt_on` rule in the pack definition are routed through the approval br', () => {
    assert.ok(new RegExp('(?<![\\\\w$])requestApproval(?![\\\\w$])').test(read('src/bridge.ts')), 'requestApproval should be defined in src/bridge.ts');
  });
  it('The bridge uses a lazy observer sidekick membership named `<residentName>-hitl` to watch for decisio', () => {
    assert.ok(new RegExp('(?<![\\\\w$])joinSidekick(?![\\\\w$])').test(read('src/bridge.ts')), 'joinSidekick should be defined in src/bridge.ts');
  });
  it('The default approval window when no `reply_by` is present is 30 minutes.', () => {
    assert.ok(read('src/bridge.ts').includes('DEFAULT_APPROVAL_WINDOW_MS = 30 * 60_000'), 'src/bridge.ts should contain DEFAULT_APPROVAL_WINDOW_MS = 30 * 60_000');
  });
  it('Clock-expired approvals use the wire reason `deadline_expired`; human refusals use `declined`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])refusalForOutcome(?![\\\\w$])').test(read('src/bridge.ts')), 'refusalForOutcome should be defined in src/bridge.ts');
  });
  it('Tool names are matched against `interrupt_on` keys with trailing-`*` glob support via `interruptMatc', () => {
    assert.ok(new RegExp('(?<![\\\\w$])interruptMatch(?![\\\\w$])').test(read('src/bridge.ts')), 'interruptMatch should be defined in src/bridge.ts');
  });
  it('Offline chain verification is implemented in `src/chain.ts` as a pure function over a pre-parsed eve', () => {
    assert.ok(new RegExp('(?<![\\\\w$])verifyChain(?![\\\\w$])').test(read('src/chain.ts')), 'verifyChain should be defined in src/chain.ts');
  });
  it('Each event\'s link is JCS-SHA256 over its stored form; for redacted events the `content_hash` field i', () => {
    assert.ok(new RegExp('(?<![\\\\w$])linkOf(?![\\\\w$])').test(read('src/chain.ts')), 'linkOf should be defined in src/chain.ts');
  });
  it('The `wrapped` field is stripped before hashing; no other fields are excluded.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])hashedForm(?![\\\\w$])').test(read('src/chain.ts')), 'hashedForm should be defined in src/chain.ts');
  });
  it('Events with no `prev_hash` (written before chain support shipped in 0.1.7) are counted as an `unchai', () => {
    assert.ok(read('src/chain.ts').includes('unchainedPrefix'), 'src/chain.ts should contain unchainedPrefix');
  });
  it('A normative scope qualifier string is exported as `CHAIN_SCOPE_QUALIFIER`, stating that the chain on', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CHAIN_SCOPE_QUALIFIER(?![\\\\w$])').test(read('src/chain.ts')), 'CHAIN_SCOPE_QUALIFIER should be defined in src/chain.ts');
  });
  it('The Anthropic Claude Agent SDK is used as the agent runtime.', () => {
    assert.ok(read('package.json').includes('"@anthropic-ai/claude-agent-sdk"'), 'package.json should contain "@anthropic-ai/claude-agent-sdk"');
  });
  it('MCP client and server packages from `@modelcontextprotocol` are used for the tool protocol.', () => {
    assert.ok(read('package.json').includes('"@modelcontextprotocol/sdk"'), 'package.json should contain "@modelcontextprotocol/sdk"');
  });
  it('SQLite persistence is provided by `better-sqlite3`.', () => {
    assert.ok(read('package.json').includes('"better-sqlite3"'), 'package.json should contain "better-sqlite3"');
  });
  it('Cron scheduling is handled by `croner`.', () => {
    assert.ok(read('package.json').includes('"croner"'), 'package.json should contain "croner"');
  });
  it('YAML frontmatter parsing uses the `yaml` package.', () => {
    assert.ok(read('package.json').includes('"yaml"'), 'package.json should contain "yaml"');
  });
  it('Schema validation uses `zod`.', () => {
    assert.ok(read('package.json').includes('"zod"'), 'package.json should contain "zod"');
  });
});
