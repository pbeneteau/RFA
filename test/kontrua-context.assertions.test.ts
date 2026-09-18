// kontrua:owned — generated context assertions. Do not hand-edit; Kontrua
// regenerates this file. It pins the documented claims to the code at 1d21db21b76c
// and goes red when a documented claim stops matching the code.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const read = (p: string) => readFileSync(p, 'utf8');
const pkgScripts = () => { try { return JSON.parse(read('package.json')).scripts ?? {}; } catch { return {}; } };

describe('kontrua context assertions', () => {
  // AGENTS.md
  it('This repository is `agent-com`, the RFA (Rooms for Agents) hub and operator CLI.', () => {
    assert.ok(read('package.json').includes('agent-com'), 'package.json should contain agent-com');
  });
  it('It is a TypeScript package whose source lives under `src/`.', () => {
    assert.ok(existsSync('src/'), 'src/ should exist');
  });
  it('with CLI commands in `src/cli/commands/`,', () => {
    assert.ok(existsSync('src/cli/commands/'), 'src/cli/commands/ should exist');
  });
  it('TUI components in `src/cli/tui/`,', () => {
    assert.ok(existsSync('src/cli/tui/'), 'src/cli/tui/ should exist');
  });
  it('and eval harness in `src/evals/`.', () => {
    assert.ok(existsSync('src/evals/'), 'src/evals/ should exist');
  });
  it('The package is built with `tsc` (configured by `tsconfig.json`) and publishes two binaries, `rfa` an', () => {
    assert.ok(existsSync('tsconfig.json'), 'tsconfig.json should exist');
  });
  it('Specifications live in `spec/`,', () => {
    assert.ok(existsSync('spec/'), 'spec/ should exist');
  });
  it('research in `research/`,', () => {
    assert.ok(existsSync('research/'), 'research/ should exist');
  });
  it('and operator-facing templates in `templates/`.', () => {
    assert.ok(existsSync('templates/'), 'templates/ should exist');
  });
  it('`src/` - hub daemon, engine, CLI, TUI, and eval harness source; the only directory compiled by `tsc`', () => {
    assert.ok(existsSync('src/'), 'src/ should exist');
  });
  it('`src/cli/commands/` - one file per CLI sub-command', () => {
    assert.ok(existsSync('src/cli/commands/'), 'src/cli/commands/ should exist');
  });
  it('`src/cli/tui/` - Ink/React TUI components for the dashboard and onboarding', () => {
    assert.ok(existsSync('src/cli/tui/'), 'src/cli/tui/ should exist');
  });
  it('`src/evals/` - eval runner, gate, judge, label, parity, promote, and trajectory modules', () => {
    assert.ok(existsSync('src/evals/'), 'src/evals/ should exist');
  });
  it('`spec/` - all seven RFA specification documents that govern wire protocol, platform, CLI, concurrenc', () => {
    assert.ok(existsSync('spec/'), 'spec/ should exist');
  });
  it('`templates/` - files seeded into a new hub directory by `rfa init`, including the eval rubric and ca', () => {
    assert.ok(existsSync('templates/'), 'templates/ should exist');
  });
  it('`test/` - all test files globbed by the `test` script', () => {
    assert.ok(existsSync('test/'), 'test/ should exist');
  });
  it('`scripts/` - standalone runnable scripts for e2e, coldstart, demo, fence-proof, egress-proof, and TU', () => {
    assert.ok(existsSync('scripts/'), 'scripts/ should exist');
  });
  it('`interop/` - the `rfa_min.py` minimal interop artifact', () => {
    assert.ok(existsSync('interop/rfa_min.py'), 'interop/rfa_min.py should exist');
  });
  it('`src/proc.ts` - required spawn helper; child processes must be spawned through this module, never vi', () => {
    assert.ok(existsSync('src/proc.ts'), 'src/proc.ts should exist');
  });
  it('`src/writefence.ts` - keeps `Write`, `Edit`, and `NotebookEdit` out of `allowedTools` for every pack', () => {
    assert.ok(existsSync('src/writefence.ts'), 'src/writefence.ts should exist');
  });
  it('`src/fenceprobe.ts` - re-proves the fall-through with a live deny probe per guarded built-in at ever', () => {
    assert.ok(existsSync('src/fenceprobe.ts'), 'src/fenceprobe.ts should exist');
  });
  it('`src/toolclass.ts` - defines `fenceApplies`, the coverage predicate for the two-door write fence', () => {
    assert.ok(new RegExp('(?<![\\\\w$])fenceApplies(?![\\\\w$])').test(read('src/toolclass.ts')), 'fenceApplies should be defined in src/toolclass.ts');
  });
  it('`src/secrets.ts` - provides `transportToken()`, which resolves the transport credential; clients mus', () => {
    assert.ok(new RegExp('(?<![\\\\w$])transportToken(?![\\\\w$])').test(read('src/secrets.ts')), 'transportToken should be defined in src/secrets.ts');
  });
  it('`RFA_TOKEN` - transport credential read per call by `transportToken()` in `src/secrets.ts`; must app', () => {
    assert.ok(read('src/secrets.ts').includes('RFA_TOKEN'), 'src/secrets.ts should contain RFA_TOKEN');
  });
  it('Spawn child processes through `spawnEntry` and `stopTree` in `src/proc.ts`, never `npx`; `spawnEntry', () => {
    assert.ok(new RegExp('(?<![\\\\w$])spawnEntry(?![\\\\w$])').test(read('src/proc.ts')), 'spawnEntry should be defined in src/proc.ts');
  });
  it('Resolve the hub directory through `src/hubdir.ts` exclusively; no source file under `src/` may resol', () => {
    assert.ok(read('CLAUDE.md').includes('Nothing under `src/` may resolve `agents/`, `data/` or `dogfood/` from the repository root'), 'CLAUDE.md should contain Nothing under `src/` may resolve `agents/`, `data/` or `dogfood/` from the repository root');
  });
  it('Find a resident in the process table using `src/procscan.ts`, never a substring match', () => {
    assert.ok(existsSync('src/procscan.ts'), 'src/procscan.ts should exist');
  });
  it('The fence coverage predicate is `fenceApplies` in `src/toolclass.ts`, never `hasWriteSurface`; a pac', () => {
    assert.ok(new RegExp('(?<![\\\\w$])fenceApplies(?![\\\\w$])').test(read('src/toolclass.ts')), 'fenceApplies should be defined in src/toolclass.ts');
  });
  it('A check that compares configured against happening must read the running system\'s own record, not th', () => {
    assert.ok(read('CLAUDE.md').includes('A check that compares CONFIGURED against HAPPENING must read the running system\'s own record, never the file the operator edited'), 'CLAUDE.md should contain A check that compares CONFIGURED against HAPPENING must read the running system\'s own record, never the file the operator edited');
  });
  it('One knowledge fact must live in exactly one file; check for duplicates before adding a source', () => {
    assert.ok(read('CLAUDE.md').includes('One knowledge fact must live in exactly ONE file'), 'CLAUDE.md should contain One knowledge fact must live in exactly ONE file');
  });
  it('Never start anything interactive when stdout or stdin is not a TTY', () => {
    assert.ok(read('CLAUDE.md').includes('Never start anything interactive when stdout or stdin is not a TTY'), 'CLAUDE.md should contain Never start anything interactive when stdout or stdin is not a TTY');
  });
  it('The `rfa evals parity` gate must be run twice; a single pass has hidden a real regression', () => {
    assert.ok(read('CLAUDE.md').includes('run it TWICE: a single pass has hidden a real regression here'), 'CLAUDE.md should contain run it TWICE: a single pass has hidden a real regression here');
  });
  it('After changing `src/`, restart the affected long-lived process: `rfa agent restart <name>` for a res', () => {
    assert.ok(read('CLAUDE.md').includes('After changing `src/`, restart what you are testing'), 'CLAUDE.md should contain After changing `src/`, restart what you are testing');
  });
  it('The `tsconfig.json` `rootDir` is `src` and `outDir` is `dist`; only files under `src/` are compiled', () => {
    assert.ok(read('tsconfig.json').includes('"rootDir": "src"'), 'tsconfig.json should contain "rootDir": "src"');
  });
  it('The `tsconfig.json` target is `ES2022` with `module` set to `Node16`', () => {
    assert.ok(read('tsconfig.json').includes('"target": "ES2022"'), 'tsconfig.json should contain "target": "ES2022"');
  });
  it('JSX is compiled with `react-jsx` as set in `tsconfig.json`', () => {
    assert.ok(read('tsconfig.json').includes('"jsx": "react-jsx"'), 'tsconfig.json should contain "jsx": "react-jsx"');
  });
  it('Test files live in `test/`', () => {
    assert.ok(existsSync('test/'), 'test/ should exist');
  });
  it('A new test file in `test/` is picked up immediately by the glob without any registration step', () => {
    assert.ok(read('CLAUDE.md').includes('the script globs `test/*.test.ts` and `test/*.test.tsx`, so a new file counts immediately'), 'CLAUDE.md should contain the script globs `test/*.test.ts` and `test/*.test.tsx`, so a new file counts immediately');
  });
  it('Deterministic concurrency ordering tests live in `test/interleaving.test.ts`, which drives every ord', () => {
    assert.ok(existsSync('test/interleaving.test.ts'), 'test/interleaving.test.ts should exist');
  });
  it('Stress loops are kept out of `npm test`; nondeterminism belongs in an opt-in soak mode', () => {
    assert.ok(read('CLAUDE.md').includes('Stress loops stay OUT of `npm test`'), 'CLAUDE.md should contain Stress loops stay OUT of `npm test`');
  });
  it('This repository carries no instance: no `agents/`, `data/`, or `dogfood/` directories (all removed 2', () => {
    assert.ok(read('CLAUDE.md').includes('This repository carries no instance'), 'CLAUDE.md should contain This repository carries no instance');
  });
  it('The hub must own its store (`<hub directory>/.rfa/data`) and its lockfile exclusively; `rfa up` runs', () => {
    assert.ok(read('CLAUDE.md').includes('The hub must own its store'), 'CLAUDE.md should contain The hub must own its store');
  });
  it('The engine DB (`.rfa/data/runs.db`, WAL) is separate and shared by supervisor and residents; a resid', () => {
    assert.ok(read('CLAUDE.md').includes('`.rfa/data/runs.db`, WAL) is separate and shared by supervisor + residents'), 'CLAUDE.md should contain `.rfa/data/runs.db`, WAL) is separate and shared by supervisor + residents');
  });
  it('A writing pack that cannot establish both doors of the write fence refuses to serve rather than serv', () => {
    assert.ok(read('CLAUDE.md').includes('A writing pack that cannot establish both doors refuses to serve rather than serving with one'), 'CLAUDE.md should contain A writing pack that cannot establish both doors refuses to serve rather than serving with one');
  });
  it('The fan-out for candidates is local: the room sees one task, one owner, one completion, and only a s', () => {
    assert.ok(read('CLAUDE.md').includes('The fan-out is LOCAL by decision'), 'CLAUDE.md should contain The fan-out is LOCAL by decision');
  });
  it('`reports/`, `dist/`, and every hub directory\'s `.rfa/` are gitignored; never force-add them', () => {
    assert.ok(read('CLAUDE.md').includes('`reports/`, `dist/` and every hub directory\'s `.rfa/` are gitignored'), 'CLAUDE.md should contain `reports/`, `dist/` and every hub directory\'s `.rfa/` are gitignored');
  });
  it('Every pack gets `view/create/insert/str_replace` on `/memories` and only those by default; `delete`,', () => {
    assert.ok(read('CLAUDE.md').includes('Every pack now gets `view/create/insert/str_replace` on `/memories` and only those'), 'CLAUDE.md should contain Every pack now gets `view/create/insert/str_replace` on `/memories` and only those');
  });
  it('A pack\'s MCP servers of the `command` and `builtin` forms are spawned through `src/mcplaunch.ts`; th', () => {
    assert.ok(existsSync('src/mcplaunch.ts'), 'src/mcplaunch.ts should exist');
  });
  it('A threshold tuned to suppress noise will hide a total outage; rates need volume guards and states ne', () => {
    assert.ok(read('CLAUDE.md').includes('A threshold tuned to suppress noise will hide a total outage'), 'CLAUDE.md should contain A threshold tuned to suppress noise will hide a total outage');
  });
  it('Non-interactive shells default to fnm Node 20; the `pretest` script rejects Node < 22 with an explic', () => {
    assert.ok(read('package.json').includes('Non-interactive shells default to fnm Node 20; see the gotcha in STATUS.md'), 'package.json should contain Non-interactive shells default to fnm Node 20; see the gotcha in STATUS.md');
  });
  it('The `better-sqlite3` binding needs Node 24 per the `pretest` error message', () => {
    assert.ok(read('package.json').includes('the better-sqlite3 binding needs Node 24'), 'package.json should contain the better-sqlite3 binding needs Node 24');
  });
  it('Never delete `dist/` without running `npm run build` after, since the linked `rfa` binary executes i', () => {
    assert.ok(read('CLAUDE.md').includes('never delete `dist/` without `npm run build` after'), 'CLAUDE.md should contain never delete `dist/` without `npm run build` after');
  });
  it('Long-lived processes (hub, supervisor, residents) serve old code after an edit; restart them explici', () => {
    assert.ok(read('CLAUDE.md').includes('Long-lived processes serve old code'), 'CLAUDE.md should contain Long-lived processes serve old code');
  });
  it('A bare `allowedTools` entry auto-approves a built-in call before the `canUseTool` callback fires; th', () => {
    assert.ok(read('CLAUDE.md').includes('CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'), 'CLAUDE.md should contain CLAUDE_SDK_CAN_USE_TOOL_SHADOWED');
  });
  it('A Read built-in inside the session cwd is auto-approved and never reaches the `canUseTool` callback;', () => {
    assert.ok(read('CLAUDE.md').includes('a read INSIDE the session cwd is auto-approved and NEVER reaches the callback'), 'CLAUDE.md should contain a read INSIDE the session cwd is auto-approved and NEVER reaches the callback');
  });
  it('`allowUnsandboxedCommands` defaults to true, leaving `dangerouslyDisableSandbox` live; a model used ', () => {
    assert.ok(read('CLAUDE.md').includes('`allowUnsandboxedCommands` defaults to true, leaving `dangerouslyDisableSandbox` live'), 'CLAUDE.md should contain `allowUnsandboxedCommands` defaults to true, leaving `dangerouslyDisableSandbox` live');
  });
  it('The supervisor is a hub client and must resolve its transport credential through `transportToken()`;', () => {
    assert.ok(read('CLAUDE.md').includes('the SUPERVISOR itself, which is a hub client as well as a process manager: it had no credential and its #ops alerts 401\'d silently'), 'CLAUDE.md should contain the SUPERVISOR itself, which is a hub client as well as a process manager: it had no credential and its #ops alerts 401\'d silently');
  });
  // docs/API.md
  it('`RfaError` is an exception class carrying a machine-readable `code`, a `message`, an optional `retry', () => {
    assert.ok(new RegExp('(?<![\\\\w$])RfaError(?![\\\\w$])').test(read('interop/rfa_min.py')), 'RfaError should be defined in interop/rfa_min.py');
  });
  it('`Hub` manages a single MCP endpoint URL and bearer token, exposing a `call` method that retries idem', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Hub(?![\\\\w$])').test(read('interop/rfa_min.py')), 'Hub should be defined in interop/rfa_min.py');
  });
  it('`read_result` unwraps one tool result from either SSE-framed or plain JSON, returning the parsed inn', () => {
    assert.ok(new RegExp('(?<![\\\\w$])read_result(?![\\\\w$])').test(read('interop/rfa_min.py')), 'read_result should be defined in interop/rfa_min.py');
  });
  it('`prune` drops keys whose value is `None` from a dict, because the hub\'s schemas reject explicit null', () => {
    assert.ok(new RegExp('(?<![\\\\w$])prune(?![\\\\w$])').test(read('interop/rfa_min.py')), 'prune should be defined in interop/rfa_min.py');
  });
  it('`neutralize` strips C0 control characters, bidi overrides, and invisible Unicode from text, and repl', () => {
    assert.ok(new RegExp('(?<![\\\\w$])neutralize(?![\\\\w$])').test(read('interop/rfa_min.py')), 'neutralize should be defined in interop/rfa_min.py');
  });
  it('`strip_tag_block` removes Unicode TAG characters in the range U+E0000–U+E007F from text, which are i', () => {
    assert.ok(new RegExp('(?<![\\\\w$])strip_tag_block(?![\\\\w$])').test(read('interop/rfa_min.py')), 'strip_tag_block should be defined in interop/rfa_min.py');
  });
  it('`attr` allowlists attribute values to alphanumerics and the characters space, underscore, period, hy', () => {
    assert.ok(new RegExp('(?<![\\\\w$])attr(?![\\\\w$])').test(read('interop/rfa_min.py')), 'attr should be defined in interop/rfa_min.py');
  });
  it('`wrap_for_model` renders one peer message envelope as an untrusted-data boundary tag, identical to t', () => {
    assert.ok(new RegExp('(?<![\\\\w$])wrap_for_model(?![\\\\w$])').test(read('interop/rfa_min.py')), 'wrap_for_model should be defined in interop/rfa_min.py');
  });
  it('`text_of` extracts raw text from a message envelope for logging and length checks only, and must nev', () => {
    assert.ok(new RegExp('(?<![\\\\w$])text_of(?![\\\\w$])').test(read('interop/rfa_min.py')), 'text_of should be defined in interop/rfa_min.py');
  });
  it('`Member` manages one room membership: joining, leaving, listening, presence, task work, and message ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Member(?![\\\\w$])').test(read('interop/rfa_min.py')), 'Member should be defined in interop/rfa_min.py');
  });
  it('`headless` runs the CLI in a subprocess with captured output, used by the smoke test to drive non-in', () => {
    assert.ok(new RegExp('(?<![\\\\w$])headless(?![\\\\w$])').test(read('scripts/tui-drive.py')), 'headless should be defined in scripts/tui-drive.py');
  });
  it('`free_port` binds a socket on port 0 and returns the OS-assigned port number, then closes the socket', () => {
    assert.ok(new RegExp('(?<![\\\\w$])free_port(?![\\\\w$])').test(read('scripts/tui-drive.py')), 'free_port should be defined in scripts/tui-drive.py');
  });
  it('`smoke` drives both the dashboard and the onboarding scenarios inside real pseudo-terminals against ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])smoke(?![\\\\w$])').test(read('scripts/tui-drive.py')), 'smoke should be defined in scripts/tui-drive.py');
  });
  it('`Lane` is the union type `"serve" | "schedule" | "background"` representing the three admission prio', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Lane(?![\\\\w$])').test(read('src/account.ts')), 'Lane should be defined in src/account.ts');
  });
  it('`LANES` is the ordered tuple `["serve", "schedule", "background"]` listing all admission lanes.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])LANES(?![\\\\w$])').test(read('src/account.ts')), 'LANES should be defined in src/account.ts');
  });
  it('`UNSUPERVISED_CAP` is `3`, the fallback concurrency cap used when no supervisor has written a cap to', () => {
    assert.ok(new RegExp('(?<![\\\\w$])UNSUPERVISED_CAP(?![\\\\w$])').test(read('src/account.ts')), 'UNSUPERVISED_CAP should be defined in src/account.ts');
  });
  it('`RATE_LIMIT_PAUSE_FLOOR_MS` is `60_000`, the minimum account-wide hold duration after a provider rat', () => {
    assert.ok(new RegExp('(?<![\\\\w$])RATE_LIMIT_PAUSE_FLOOR_MS(?![\\\\w$])').test(read('src/account.ts')), 'RATE_LIMIT_PAUSE_FLOOR_MS should be defined in src/account.ts');
  });
  it('`VIABLE_BUDGET_USD` is `0.05`, the minimum remaining budget below which admission is refused rather ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])VIABLE_BUDGET_USD(?![\\\\w$])').test(read('src/account.ts')), 'VIABLE_BUDGET_USD should be defined in src/account.ts');
  });
  it('`BudgetRequest` carries the optional per-day and per-task USD ceilings, the spend day string, and th', () => {
    assert.ok(new RegExp('(?<![\\\\w$])BudgetRequest(?![\\\\w$])').test(read('src/account.ts')), 'BudgetRequest should be defined in src/account.ts');
  });
  it('`spendDay` formats a `Date` as a `YYYY-MM-DD` string representing the budget day, defaulting to the ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])spendDay(?![\\\\w$])').test(read('src/account.ts')), 'spendDay should be defined in src/account.ts');
  });
  it('`Lease` describes one row in `account_leases`, including the lease id, agent, lane, run id, pid, tim', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Lease(?![\\\\w$])').test(read('src/account.ts')), 'Lease should be defined in src/account.ts');
  });
  it('`Admission` is the result of an `acquire` call: an `ok` flag, the granted `Lease` or null, a refusal', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Admission(?![\\\\w$])').test(read('src/account.ts')), 'Admission should be defined in src/account.ts');
  });
  it('`Settlement` records the attribution of one completed lease: agent, lane, run id, spend day, granted', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Settlement(?![\\\\w$])').test(read('src/account.ts')), 'Settlement should be defined in src/account.ts');
  });
  it('`RateLimitReport` is one row from `account_rate_limits`, carrying the agent, run id, detail string, ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])RateLimitReport(?![\\\\w$])').test(read('src/account.ts')), 'RateLimitReport should be defined in src/account.ts');
  });
  it('`AccountSnapshot` describes the current ledger state: cap, in-flight and parked counts, per-lane and', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AccountSnapshot(?![\\\\w$])').test(read('src/account.ts')), 'AccountSnapshot should be defined in src/account.ts');
  });
  it('`isRateLimitError` returns `true` when an error\'s message matches patterns for HTTP 429, rate-limit,', () => {
    assert.ok(new RegExp('(?<![\\\\w$])isRateLimitError(?![\\\\w$])').test(read('src/account.ts')), 'isRateLimitError should be defined in src/account.ts');
  });
  it('`AUTH_FAILURE_MARKERS` is the canonical list of LIKE-syntax patterns used to identify credential fai', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AUTH_FAILURE_MARKERS(?![\\\\w$])').test(read('src/account.ts')), 'AUTH_FAILURE_MARKERS should be defined in src/account.ts');
  });
  it('`isAuthError` returns `true` when an error\'s message matches any pattern in `AUTH_FAILURE_MARKERS`, ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])isAuthError(?![\\\\w$])').test(read('src/account.ts')), 'isAuthError should be defined in src/account.ts');
  });
  it('`pidAlive` sends signal 0 to a pid and returns `true` if the process exists or is owned by another u', () => {
    assert.ok(new RegExp('(?<![\\\\w$])pidAlive(?![\\\\w$])').test(read('src/account.ts')), 'pidAlive should be defined in src/account.ts');
  });
  it('`AccountLedger` manages the SQLite-backed admission table, providing `acquire`, `release`, `park`, `', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AccountLedger(?![\\\\w$])').test(read('src/account.ts')), 'AccountLedger should be defined in src/account.ts');
  });
  it('`ACTION_IDENTITY_EXT` is the wire extension key `"io.github.pbeneteau/action-identity"` used to carr', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ACTION_IDENTITY_EXT(?![\\\\w$])').test(read('src/actionid.ts')), 'ACTION_IDENTITY_EXT should be defined in src/actionid.ts');
  });
  it('`EFFECT_CLASS_EXT` is the wire extension key `"io.github.pbeneteau/effect-class"` used to carry the ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])EFFECT_CLASS_EXT(?![\\\\w$])').test(read('src/actionid.ts')), 'EFFECT_CLASS_EXT should be defined in src/actionid.ts');
  });
  it('`EffectClass` is the union type `"irreversible" | "reversible_with_cost" | "reversible"` classifying', () => {
    assert.ok(new RegExp('(?<![\\\\w$])EffectClass(?![\\\\w$])').test(read('src/actionid.ts')), 'EffectClass should be defined in src/actionid.ts');
  });
  it('`EFFECT_CLASSES` is the tuple `["irreversible", "reversible_with_cost", "reversible"]` listing all v', () => {
    assert.ok(new RegExp('(?<![\\\\w$])EFFECT_CLASSES(?![\\\\w$])').test(read('src/actionid.ts')), 'EFFECT_CLASSES should be defined in src/actionid.ts');
  });
  it('`DEFAULT_EFFECT_CLASS` is `"irreversible"`, the safe default applied when an effect class is absent ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])DEFAULT_EFFECT_CLASS(?![\\\\w$])').test(read('src/actionid.ts')), 'DEFAULT_EFFECT_CLASS should be defined in src/actionid.ts');
  });
  it('`effectClassOf` returns the `EffectClass` for a raw value, falling back to `DEFAULT_EFFECT_CLASS` fo', () => {
    assert.ok(new RegExp('(?<![\\\\w$])effectClassOf(?![\\\\w$])').test(read('src/actionid.ts')), 'effectClassOf should be defined in src/actionid.ts');
  });
  it('`mayRetryUnsettled` returns `true` when an unsettled claim on the given `EffectClass` may be taken o', () => {
    assert.ok(new RegExp('(?<![\\\\w$])mayRetryUnsettled(?![\\\\w$])').test(read('src/actionid.ts')), 'mayRetryUnsettled should be defined in src/actionid.ts');
  });
  it('`normalizeInput` recursively normalises a tool input value for identity purposes: NFC-trimming strin', () => {
    assert.ok(new RegExp('(?<![\\\\w$])normalizeInput(?![\\\\w$])').test(read('src/actionid.ts')), 'normalizeInput should be defined in src/actionid.ts');
  });
  it('`actionIdentity` computes a stable `act1_`-prefixed SHA-256 identity for an action from its tool nam', () => {
    assert.ok(new RegExp('(?<![\\\\w$])actionIdentity(?![\\\\w$])').test(read('src/actionid.ts')), 'actionIdentity should be defined in src/actionid.ts');
  });
  it('`actionScope` returns a scope string for an action derived from its task id, conversation id, or roo', () => {
    assert.ok(new RegExp('(?<![\\\\w$])actionScope(?![\\\\w$])').test(read('src/actionid.ts')), 'actionScope should be defined in src/actionid.ts');
  });
  it('`InterruptRule` describes one matched interrupt rule, carrying the tool name pattern and the interru', () => {
    assert.ok(new RegExp('(?<![\\\\w$])InterruptRule(?![\\\\w$])').test(read('src/bridge.ts')), 'InterruptRule should be defined in src/bridge.ts');
  });
  it('`interruptMatch` returns the first `InterruptRule` from a pack\'s `interrupt_on` list whose pattern m', () => {
    assert.ok(new RegExp('(?<![\\\\w$])interruptMatch(?![\\\\w$])').test(read('src/bridge.ts')), 'interruptMatch should be defined in src/bridge.ts');
  });
  it('`ApprovalOutcome` carries the result of a human approval wait: the verdict, the decliner\'s identity ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ApprovalOutcome(?![\\\\w$])').test(read('src/bridge.ts')), 'ApprovalOutcome should be defined in src/bridge.ts');
  });
  it('`DEFAULT_APPROVAL_WINDOW_MS` is `30 * 60_000` (30 minutes), the fallback approval window when no rep', () => {
    assert.ok(new RegExp('(?<![\\\\w$])DEFAULT_APPROVAL_WINDOW_MS(?![\\\\w$])').test(read('src/bridge.ts')), 'DEFAULT_APPROVAL_WINDOW_MS should be defined in src/bridge.ts');
  });
  it('`approvalWindowMs` derives the approval window from the asker\'s `reply_by` deadline, clamped so the ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])approvalWindowMs(?![\\\\w$])').test(read('src/bridge.ts')), 'approvalWindowMs should be defined in src/bridge.ts');
  });
  it('`refusalForOutcome` maps an `ApprovalOutcome` to the wire refusal reason `"deadline_expired"` or `"d', () => {
    assert.ok(new RegExp('(?<![\\\\w$])refusalForOutcome(?![\\\\w$])').test(read('src/bridge.ts')), 'refusalForOutcome should be defined in src/bridge.ts');
  });
  it('`humanAction` returns a human-readable label for a tool name, used in approval card descriptions.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])humanAction(?![\\\\w$])').test(read('src/bridge.ts')), 'humanAction should be defined in src/bridge.ts');
  });
  it('`previewLines` formats a tool input record as a short multi-line preview string for display in an ap', () => {
    assert.ok(new RegExp('(?<![\\\\w$])previewLines(?![\\\\w$])').test(read('src/bridge.ts')), 'previewLines should be defined in src/bridge.ts');
  });
  it('`requestApproval` sends an approval card to the room via the sidekick member and waits for a human v', () => {
    assert.ok(new RegExp('(?<![\\\\w$])requestApproval(?![\\\\w$])').test(read('src/bridge.ts')), 'requestApproval should be defined in src/bridge.ts');
  });
  it('`joinSidekick` joins a hub room as the resident\'s sidekick observer member and returns the resulting', () => {
    assert.ok(new RegExp('(?<![\\\\w$])joinSidekick(?![\\\\w$])').test(read('src/bridge.ts')), 'joinSidekick should be defined in src/bridge.ts');
  });
  it('`GeneratedArtifactRecord` describes one generated artifact: its path, content hash, and the run that', () => {
    assert.ok(new RegExp('(?<![\\\\w$])GeneratedArtifactRecord(?![\\\\w$])').test(read('src/artifacts.ts')), 'GeneratedArtifactRecord should be defined in src/artifacts.ts');
  });
  it('`ArtifactsFile` is the shape of the `artifacts.json` store, holding an array of `GeneratedArtifactRe', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ArtifactsFile(?![\\\\w$])').test(read('src/artifacts.ts')), 'ArtifactsFile should be defined in src/artifacts.ts');
  });
  it('`artifactsStore` returns a `JsonStore<ArtifactsFile>` backed by `<hub>/runtime/artifacts.json`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])artifactsStore(?![\\\\w$])').test(read('src/artifacts.ts')), 'artifactsStore should be defined in src/artifacts.ts');
  });
  it('`recordGeneratedArtifacts` appends or updates artifact records in the hub\'s `artifacts.json` store f', () => {
    assert.ok(new RegExp('(?<![\\\\w$])recordGeneratedArtifacts(?![\\\\w$])').test(read('src/artifacts.ts')), 'recordGeneratedArtifacts should be defined in src/artifacts.ts');
  });
  it('`ArtifactDrift` describes a generated artifact whose on-disk content no longer matches the hash reco', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ArtifactDrift(?![\\\\w$])').test(read('src/artifacts.ts')), 'ArtifactDrift should be defined in src/artifacts.ts');
  });
  it('`artifactDrift` compares a list of `GeneratedArtifactRecord` entries against live file hashes and re', () => {
    assert.ok(new RegExp('(?<![\\\\w$])artifactDrift(?![\\\\w$])').test(read('src/artifacts.ts')), 'artifactDrift should be defined in src/artifacts.ts');
  });
  it('`CANDIDATE_SELECTORS` is the tuple `["human", "first-verified"]` listing the valid candidate selecti', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CANDIDATE_SELECTORS(?![\\\\w$])').test(read('src/candidates.ts')), 'CANDIDATE_SELECTORS should be defined in src/candidates.ts');
  });
  it('`CandidateSelector` is the union type of the values in `CANDIDATE_SELECTORS`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CandidateSelector(?![\\\\w$])').test(read('src/candidates.ts')), 'CandidateSelector should be defined in src/candidates.ts');
  });
  it('`isCandidateSelector` is a type guard returning `true` when a value is a valid `CandidateSelector`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])isCandidateSelector(?![\\\\w$])').test(read('src/candidates.ts')), 'isCandidateSelector should be defined in src/candidates.ts');
  });
  it('`SELECTOR_NOTES` maps each `CandidateSelector` to a human-readable description string.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])SELECTOR_NOTES(?![\\\\w$])').test(read('src/candidates.ts')), 'SELECTOR_NOTES should be defined in src/candidates.ts');
  });
  it('`CandidatePlan` describes a resolved fan-out plan: the number of candidates, the selector, and the p', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CandidatePlan(?![\\\\w$])').test(read('src/candidates.ts')), 'CandidatePlan should be defined in src/candidates.ts');
  });
  it('`planCandidates` validates and resolves a candidate fan-out request into a `CandidatePlan`, enforcin', () => {
    assert.ok(new RegExp('(?<![\\\\w$])planCandidates(?![\\\\w$])').test(read('src/candidates.ts')), 'planCandidates should be defined in src/candidates.ts');
  });
  it('`StartedCandidate` carries the run id and task reference for one candidate turn that has been dispat', () => {
    assert.ok(new RegExp('(?<![\\\\w$])StartedCandidate(?![\\\\w$])').test(read('src/candidates.ts')), 'StartedCandidate should be defined in src/candidates.ts');
  });
  it('`CandidateProduct` holds the output of one completed candidate run: its answer text and cost.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CandidateProduct(?![\\\\w$])').test(read('src/candidates.ts')), 'CandidateProduct should be defined in src/candidates.ts');
  });
  it('`CandidateOutcome` pairs a `StartedCandidate` with its `CandidateProduct` or failure reason.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CandidateOutcome(?![\\\\w$])').test(read('src/candidates.ts')), 'CandidateOutcome should be defined in src/candidates.ts');
  });
  it('`CandidateSetResult` is the result of a full fan-out: all outcomes, the selected winner index, and t', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CandidateSetResult(?![\\\\w$])').test(read('src/candidates.ts')), 'CandidateSetResult should be defined in src/candidates.ts');
  });
  it('`RunCandidateSetOpts` carries the inputs to `runCandidateSet`: the plan, the task, the agent context', () => {
    assert.ok(new RegExp('(?<![\\\\w$])RunCandidateSetOpts(?![\\\\w$])').test(read('src/candidates.ts')), 'RunCandidateSetOpts should be defined in src/candidates.ts');
  });
  it('`runCandidateSet` runs N candidate turns in parallel for one task, applies the selector, and returns', () => {
    assert.ok(new RegExp('(?<![\\\\w$])runCandidateSet(?![\\\\w$])').test(read('src/candidates.ts')), 'runCandidateSet should be defined in src/candidates.ts');
  });
  it('`roomsBlock` generates the YAML `rooms:` block for an agent.md frontmatter given a room name and bin', () => {
    assert.ok(new RegExp('(?<![\\\\w$])roomsBlock(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'roomsBlock should be defined in src/cli/agentmd.ts');
  });
  it('`knowledgeBlock` generates the YAML `knowledge:` block for an agent.md frontmatter from a list of gl', () => {
    assert.ok(new RegExp('(?<![\\\\w$])knowledgeBlock(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'knowledgeBlock should be defined in src/cli/agentmd.ts');
  });
  it('`setTopBlock` rewrites a named top-level YAML block in agent.md text, replacing it with the provided', () => {
    assert.ok(new RegExp('(?<![\\\\w$])setTopBlock(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'setTopBlock should be defined in src/cli/agentmd.ts');
  });
  it('`setRoomsBlock` rewrites the `rooms:` block in agent.md text using `setTopBlock`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])setRoomsBlock(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'setRoomsBlock should be defined in src/cli/agentmd.ts');
  });
  it('`bindPack` rewrites the `rooms:` block in a pack\'s agent.md file on disk, validated before the write', () => {
    assert.ok(new RegExp('(?<![\\\\w$])bindPack(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'bindPack should be defined in src/cli/agentmd.ts');
  });
  it('`addKnowledge` appends or merges glob patterns into the `knowledge:` block of a pack\'s agent.md file', () => {
    assert.ok(new RegExp('(?<![\\\\w$])addKnowledge(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'addKnowledge should be defined in src/cli/agentmd.ts');
  });
  it('`setTopScalar` rewrites a named top-level scalar key in agent.md text, with options to insert it if ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])setTopScalar(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'setTopScalar should be defined in src/cli/agentmd.ts');
  });
  it('`dropNestedKey` removes a named key from a named top-level YAML block in agent.md text.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])dropNestedKey(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'dropNestedKey should be defined in src/cli/agentmd.ts');
  });
  it('`MODE_LINE` is a function returning the `mode: <mode>` YAML line string for a given `AgentMode`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])MODE_LINE(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'MODE_LINE should be defined in src/cli/agentmd.ts');
  });
  it('`setAgentMode` rewrites the `mode:` scalar in a pack\'s agent.md file on disk to one of `ask`, `plan`', () => {
    assert.ok(new RegExp('(?<![\\\\w$])setAgentMode(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'setAgentMode should be defined in src/cli/agentmd.ts');
  });
  it('`yamlScalar` returns a YAML-safe scalar string, quoting the value when necessary.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])yamlScalar(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'yamlScalar should be defined in src/cli/agentmd.ts');
  });
  it('`PackChanges` carries the set of optional fields that `editPack` may update: description, model, per', () => {
    assert.ok(new RegExp('(?<![\\\\w$])PackChanges(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'PackChanges should be defined in src/cli/agentmd.ts');
  });
  it('`EditResult` carries the outcome of an `editPack` call: the updated text, the parsed definition, and', () => {
    assert.ok(new RegExp('(?<![\\\\w$])EditResult(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'EditResult should be defined in src/cli/agentmd.ts');
  });
  it('`currentSettings` extracts the current description, model, and other editable settings from an `Agen', () => {
    assert.ok(new RegExp('(?<![\\\\w$])currentSettings(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'currentSettings should be defined in src/cli/agentmd.ts');
  });
  it('`editPack` applies a `PackChanges` to agent.md text, validates the result, and returns an `EditResul', () => {
    assert.ok(new RegExp('(?<![\\\\w$])editPack(?![\\\\w$])').test(read('src/cli/agentmd.ts')), 'editPack should be defined in src/cli/agentmd.ts');
  });
  it('`CHAIN_EXT` is the wire extension key `"io.github.pbeneteau/chain"` carrying the hash-linked chain r', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CHAIN_EXT(?![\\\\w$])').test(read('src/chainid.ts')), 'CHAIN_EXT should be defined in src/chainid.ts');
  });
  it('`COUNTER_ASK_EXT` is the wire extension key `"io.github.pbeneteau/pending-counter-ask"` annotating a', () => {
    assert.ok(new RegExp('(?<![\\\\w$])COUNTER_ASK_EXT(?![\\\\w$])').test(read('src/chainid.ts')), 'COUNTER_ASK_EXT should be defined in src/chainid.ts');
  });
  it('`CHAIN_DEPTH_CAP` is `8`, the maximum chain hop depth at which the chain extension stops propagating', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CHAIN_DEPTH_CAP(?![\\\\w$])').test(read('src/chainid.ts')), 'CHAIN_DEPTH_CAP should be defined in src/chainid.ts');
  });
  it('`ChainRef` carries the chain id, depth, and parent hash for one hop in a request chain.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ChainRef(?![\\\\w$])').test(read('src/chainid.ts')), 'ChainRef should be defined in src/chainid.ts');
  });
  it('`readChain` extracts a `ChainRef` from an extension bag, returning `null` if absent or malformed.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])readChain(?![\\\\w$])').test(read('src/chainid.ts')), 'readChain should be defined in src/chainid.ts');
  });
  it('`mintChainId` generates a new random chain id string.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])mintChainId(?![\\\\w$])').test(read('src/chainid.ts')), 'mintChainId should be defined in src/chainid.ts');
  });
  it('`nextChain` advances a `ChainRef` by one hop, returning `null` when the depth cap is reached.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])nextChain(?![\\\\w$])').test(read('src/chainid.ts')), 'nextChain should be defined in src/chainid.ts');
  });
  it('`BlockedChains` tracks in-flight chain ids to detect deadlock cycles, exposing `add`, `remove`, and ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])BlockedChains(?![\\\\w$])').test(read('src/chainid.ts')), 'BlockedChains should be defined in src/chainid.ts');
  });
  it('`wouldDeadlockDetail` returns a human-readable string describing the deadlock a given `ChainRef` wou', () => {
    assert.ok(new RegExp('(?<![\\\\w$])wouldDeadlockDetail(?![\\\\w$])').test(read('src/chainid.ts')), 'wouldDeadlockDetail should be defined in src/chainid.ts');
  });
  it('`genesisFor` returns the genesis hash string for a room\'s event chain, derived from the room handle.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])genesisFor(?![\\\\w$])').test(read('src/chain.ts')), 'genesisFor should be defined in src/chain.ts');
  });
  it('`hashedForm` returns a copy of an event record with its hash field populated, used when appending to', () => {
    assert.ok(new RegExp('(?<![\\\\w$])hashedForm(?![\\\\w$])').test(read('src/chain.ts')), 'hashedForm should be defined in src/chain.ts');
  });
  it('`linkOf` extracts the chain link object from an event record.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])linkOf(?![\\\\w$])').test(read('src/chain.ts')), 'linkOf should be defined in src/chain.ts');
  });
  it('`ChainDivergence` describes a point where the event chain fails verification, naming the seq and the', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ChainDivergence(?![\\\\w$])').test(read('src/chain.ts')), 'ChainDivergence should be defined in src/chain.ts');
  });
  it('`ChainResult` carries the outcome of `verifyChain`: a `valid` flag and any `ChainDivergence` found.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ChainResult(?![\\\\w$])').test(read('src/chain.ts')), 'ChainResult should be defined in src/chain.ts');
  });
  it('`verifyChain` walks an array of event records and returns a `ChainResult` indicating whether the has', () => {
    assert.ok(new RegExp('(?<![\\\\w$])verifyChain(?![\\\\w$])').test(read('src/chain.ts')), 'verifyChain should be defined in src/chain.ts');
  });
  it('`CHAIN_SCOPE_QUALIFIER` is the fixed string appended to chain verification output explaining what th', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CHAIN_SCOPE_QUALIFIER(?![\\\\w$])').test(read('src/chain.ts')), 'CHAIN_SCOPE_QUALIFIER should be defined in src/chain.ts');
  });
  it('`MEMORY_DESTRUCTIVE_TOOLS` is the tuple `["mcp__memory__delete", "mcp__memory__rename", "mcp__memory', () => {
    assert.ok(new RegExp('(?<![\\\\w$])MEMORY_DESTRUCTIVE_TOOLS(?![\\\\w$])').test(read('src/agentdef.ts')), 'MEMORY_DESTRUCTIVE_TOOLS should be defined in src/agentdef.ts');
  });
  it('`agentDefSchema` is the Zod schema that validates a parsed agent.md frontmatter object into an `Agen', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentDefSchema(?![\\\\w$])').test(read('src/agentdef.ts')), 'agentDefSchema should be defined in src/agentdef.ts');
  });
  it('`CONCURRENCY_GATE_LABELS` is the array of human-readable labels for each concurrency gate check.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])CONCURRENCY_GATE_LABELS(?![\\\\w$])').test(read('src/agentdef.ts')), 'CONCURRENCY_GATE_LABELS should be defined in src/agentdef.ts');
  });
  it('`concurrencyGateFailures` returns the list of gate failure messages for a definition that does not s', () => {
    assert.ok(new RegExp('(?<![\\\\w$])concurrencyGateFailures(?![\\\\w$])').test(read('src/agentdef.ts')), 'concurrencyGateFailures should be defined in src/agentdef.ts');
  });
  it('`writeSurfaceDefFailures` returns validation failure messages for a pack\'s declared write surface.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])writeSurfaceDefFailures(?![\\\\w$])').test(read('src/agentdef.ts')), 'writeSurfaceDefFailures should be defined in src/agentdef.ts');
  });
  it('`resolvePackCwd` resolves a pack\'s declared `cwd` relative to its pack directory, returning the abso', () => {
    assert.ok(new RegExp('(?<![\\\\w$])resolvePackCwd(?![\\\\w$])').test(read('src/agentdef.ts')), 'resolvePackCwd should be defined in src/agentdef.ts');
  });
  it('`reachAcknowledgementFailure` returns a failure message when a pack\'s reach declaration is missing r', () => {
    assert.ok(new RegExp('(?<![\\\\w$])reachAcknowledgementFailure(?![\\\\w$])').test(read('src/agentdef.ts')), 'reachAcknowledgementFailure should be defined in src/agentdef.ts');
  });
  it('`fencedCwdFailure` returns a failure message when a fenced pack\'s declared `cwd` is outside the perm', () => {
    assert.ok(new RegExp('(?<![\\\\w$])fencedCwdFailure(?![\\\\w$])').test(read('src/agentdef.ts')), 'fencedCwdFailure should be defined in src/agentdef.ts');
  });
  it('`AgentDef` is the TypeScript type inferred from `agentDefSchema`, representing a fully parsed and va', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AgentDef(?![\\\\w$])').test(read('src/agentdef.ts')), 'AgentDef should be defined in src/agentdef.ts');
  });
  it('`declaredSecretNames` returns the union of secret names declared by a pack\'s own `secrets` field and', () => {
    assert.ok(new RegExp('(?<![\\\\w$])declaredSecretNames(?![\\\\w$])').test(read('src/agentdef.ts')), 'declaredSecretNames should be defined in src/agentdef.ts');
  });
  it('`AgentPack` carries a loaded pack\'s directory path, parsed `AgentDef`, and raw agent.md content.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AgentPack(?![\\\\w$])').test(read('src/agentdef.ts')), 'AgentPack should be defined in src/agentdef.ts');
  });
  it('`splitAgentMd` splits agent.md content into its YAML frontmatter string and body string.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])splitAgentMd(?![\\\\w$])').test(read('src/agentdef.ts')), 'splitAgentMd should be defined in src/agentdef.ts');
  });
  it('`parseAgentMd` parses agent.md content into a validated `AgentDef`, throwing on schema violations.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])parseAgentMd(?![\\\\w$])').test(read('src/agentdef.ts')), 'parseAgentMd should be defined in src/agentdef.ts');
  });
  it('`loadPack` reads and parses the agent.md in a pack directory, returning an `AgentPack`.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])loadPack(?![\\\\w$])').test(read('src/agentdef.ts')), 'loadPack should be defined in src/agentdef.ts');
  });
  it('`listPacks` returns all valid `AgentPack` entries found under an `agents/` root directory.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])listPacks(?![\\\\w$])').test(read('src/agentdef.ts')), 'listPacks should be defined in src/agentdef.ts');
  });
  it('`BrokenPack` carries the name and parse error for a pack directory whose agent.md could not be valid', () => {
    assert.ok(new RegExp('(?<![\\\\w$])BrokenPack(?![\\\\w$])').test(read('src/agentdef.ts')), 'BrokenPack should be defined in src/agentdef.ts');
  });
  it('`scanPacks` returns both valid `AgentPack` entries and `BrokenPack` entries found under an `agents/`', () => {
    assert.ok(new RegExp('(?<![\\\\w$])scanPacks(?![\\\\w$])').test(read('src/agentdef.ts')), 'scanPacks should be defined in src/agentdef.ts');
  });
  it('`packByName` looks up a single pack by name under an `agents/` root, throwing if not found or broken', () => {
    assert.ok(new RegExp('(?<![\\\\w$])packByName(?![\\\\w$])').test(read('src/agentdef.ts')), 'packByName should be defined in src/agentdef.ts');
  });
  it('`declaredPackNames` returns the sorted union of names from valid packs, broken packs, and an existin', () => {
    assert.ok(new RegExp('(?<![\\\\w$])declaredPackNames(?![\\\\w$])').test(read('src/agentdef.ts')), 'declaredPackNames should be defined in src/agentdef.ts');
  });
  it('`deriveCard` builds an `AgentCard` from a loaded `AgentPack`, used when joining a room.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])deriveCard(?![\\\\w$])').test(read('src/agentdef.ts')), 'deriveCard should be defined in src/agentdef.ts');
  });
  it('`knowledgeFiles` returns the list of file paths matched by a pack\'s knowledge glob patterns.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])knowledgeFiles(?![\\\\w$])').test(read('src/agentdef.ts')), 'knowledgeFiles should be defined in src/agentdef.ts');
  });
  it('`Attachment` describes one knowledge source attachment: its local path, remote URL, and sync state.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Attachment(?![\\\\w$])').test(read('src/cli/attach.ts')), 'Attachment should be defined in src/cli/attach.ts');
  });
  it('`AttachError` is thrown by `attachKnowledge` when a knowledge source cannot be attached, carrying a ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AttachError(?![\\\\w$])').test(read('src/cli/attach.ts')), 'AttachError should be defined in src/cli/attach.ts');
  });
  it('`attachKnowledge` clones or links a knowledge source into a pack\'s directory and updates the pack\'s ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])attachKnowledge(?![\\\\w$])').test(read('src/cli/attach.ts')), 'attachKnowledge should be defined in src/cli/attach.ts');
  });
  it('`agentNew` is the `CommandDef` for `rfa agent new`, which creates a new agent pack interactively or ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentNew(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentNew should be defined in src/cli/commands/agent.ts');
  });
  it('`agentLs` is the `CommandDef` for `rfa agent ls`, which lists all packs in the hub directory.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentLs(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentLs should be defined in src/cli/commands/agent.ts');
  });
  it('`agentShow` is the `CommandDef` for `rfa agent show`, which prints the parsed definition of a named ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentShow(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentShow should be defined in src/cli/commands/agent.ts');
  });
  it('`agentValidate` is the `CommandDef` for `rfa agent validate`, which validates a pack\'s agent.md and ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentValidate(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentValidate should be defined in src/cli/commands/agent.ts');
  });
  it('`agentBind` is the `CommandDef` for `rfa agent bind`, which rewrites a pack\'s room binding in its ag', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentBind(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentBind should be defined in src/cli/commands/agent.ts');
  });
  it('`supervisorCommand` sends a start, stop, or restart command for a named agent to the running supervi', () => {
    assert.ok(new RegExp('(?<![\\\\w$])supervisorCommand(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'supervisorCommand should be defined in src/cli/commands/agent.ts');
  });
  it('`agentStart` is the `CommandDef` for `rfa agent start`, which starts a named agent via the superviso', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentStart(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentStart should be defined in src/cli/commands/agent.ts');
  });
  it('`agentStop` is the `CommandDef` for `rfa agent stop`, which stops a named agent via the supervisor.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentStop(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentStop should be defined in src/cli/commands/agent.ts');
  });
  it('`agentRestart` is the `CommandDef` for `rfa agent restart`, which restarts a named agent via the sup', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentRestart(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentRestart should be defined in src/cli/commands/agent.ts');
  });
  it('`EditOutcome` extends `EditResult` with the applied pack name and whether the agent was restarted af', () => {
    assert.ok(new RegExp('(?<![\\\\w$])EditOutcome(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'EditOutcome should be defined in src/cli/commands/agent.ts');
  });
  it('`applyPackEdit` validates and writes a `PackChanges` to a pack\'s agent.md, optionally restarting the', () => {
    assert.ok(new RegExp('(?<![\\\\w$])applyPackEdit(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'applyPackEdit should be defined in src/cli/commands/agent.ts');
  });
  it('`editInEditor` opens a pack\'s agent.md in the operator\'s `$EDITOR` and returns the exit code.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])editInEditor(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'editInEditor should be defined in src/cli/commands/agent.ts');
  });
  it('`changesFromFlags` builds a `PackChanges` object from CLI flag values, returning `null` when no flag', () => {
    assert.ok(new RegExp('(?<![\\\\w$])changesFromFlags(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'changesFromFlags should be defined in src/cli/commands/agent.ts');
  });
  it('`agentEdit` is the `CommandDef` for `rfa agent edit`, which edits a pack\'s settings interactively or', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentEdit(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentEdit should be defined in src/cli/commands/agent.ts');
  });
  it('`agentReflect` is the `CommandDef` for `rfa agent reflect`, which distills a pack\'s judged eval reco', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentReflect(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentReflect should be defined in src/cli/commands/agent.ts');
  });
  it('`agentMode` is the `CommandDef` for `rfa agent mode`, which sets a pack\'s operating mode to `ask`, `', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentMode(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentMode should be defined in src/cli/commands/agent.ts');
  });
  it('`agentRetire` is the `CommandDef` for `rfa agent retire`, which removes a pack from the hub director', () => {
    assert.ok(new RegExp('(?<![\\\\w$])agentRetire(?![\\\\w$])').test(read('src/cli/commands/agent.ts')), 'agentRetire should be defined in src/cli/commands/agent.ts');
  });
  it('`completionScript` returns the shell completion script string for the given shell type.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])completionScript(?![\\\\w$])').test(read('src/cli/commands/completion.ts')), 'completionScript should be defined in src/cli/commands/completion.ts');
  });
  it('`complete` returns completion candidates for the given word list against the router\'s command tree.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])complete(?![\\\\w$])').test(read('src/cli/commands/completion.ts')), 'complete should be defined in src/cli/commands/completion.ts');
  });
  it('`completionCommands` returns the `CommandDef` array for the `completion` subcommand group.', () => {
    assert.ok(new RegExp('(?<![\\\\w$])completionCommands(?![\\\\w$])').test(read('src/cli/commands/completion.ts')), 'completionCommands should be defined in src/cli/commands/completion.ts');
  });
  it('`clientHubUrl` returns the hub URL a CLI client should connect to, derived from the hub directory\'s ', () => {
    assert.ok(new RegExp('(?<![\\\\w$])clientHubUrl(?![\\\\w$])').test(read('src/cli/commands/connect.ts')), 'clientHubUrl should be defined in src/cli/commands/connect.ts');
  });
  it('`writeProjectSkill` writes the MCP skill configuration for a room into a Claude or Cursor project di', () => {
    assert.ok(new RegExp('(?<![\\\\w$])writeProjectSkill(?![\\\\w$])').test(read('src/cli/commands/connect.ts')), 'writeProjectSkill should be defined in src/cli/commands/connect.ts');
  });
  it('`connectClaude` is the `CommandDef` for `rfa connect claude`, which writes the MCP configuration for', () => {
    assert.ok(new RegExp('(?<![\\\\w$])connectClaude(?![\\\\w$])').test(read('src/cli/commands/connect.ts')), 'connectClaude should be defined in src/cli/commands/connect.ts');
  });
  it('`connectCursor` is the `CommandDef` for `rfa connect cursor`, which prints the MCP configuration for', () => {
    assert.ok(new RegExp('(?<![\\\\w$])connectCursor(?![\\\\w$])').test(read('src/cli/commands/connect.ts')), 'connectCursor should be defined in src/cli/commands/connect.ts');
  });
  it('`connectMcp` is the `CommandDef` for `rfa connect mcp`, which prints the generic MCP configuration b', () => {
    assert.ok(new RegExp('(?<![\\\\w$])connectMcp(?![\\\\w$])').test(read('src/cli/commands/connect.ts')), 'connectMcp should be defined in src/cli/commands/connect.ts');
  });
  // docs/ARCHITECTURE.md
  it('The CLI entry point is `src/cli/main.ts`, which installs as the `rfa` and `agent-com` binaries from ', () => {
    assert.ok(existsSync('src/cli/main.ts'), 'src/cli/main.ts should exist');
  });
  it('The hub process (`src/main.ts`) serves HTTP and persists state in a SQLite store under the hub direc', () => {
    assert.ok(existsSync('src/main.ts'), 'src/main.ts should exist');
  });
  it('External services are reached through the Anthropic Claude Agent SDK and the MCP client and server p', () => {
    assert.ok(existsSync('package.json'), 'package.json should exist');
  });
  it('`src/` - core runtime: hub, engine, dispatch, sessions, store, credentials, signing, egress, and all', () => {
    assert.ok(existsSync('src/'), 'src/ should exist');
  });
  it('`src/cli/` - operator CLI: routing, prompts, scaffolding, and command implementations that front eve', () => {
    assert.ok(existsSync('src/cli/'), 'src/cli/ should exist');
  });
  it('`src/cli/commands/` - individual CLI command modules (agent, connect, creds, dash, doctor, init, ops', () => {
    assert.ok(existsSync('src/cli/commands/'), 'src/cli/commands/ should exist');
  });
  it('`src/cli/tui/` - Ink/React terminal UI components including the dashboard, onboarding wizard, agent ', () => {
    assert.ok(existsSync('src/cli/tui/'), 'src/cli/tui/ should exist');
  });
  it('`src/evals/` - evaluation pipeline: runner, judge, gate, parity, label, promote, trajectory, and con', () => {
    assert.ok(existsSync('src/evals/'), 'src/evals/ should exist');
  });
  it('`src/servers/` - MCP server integrations (Linear)', () => {
    assert.ok(existsSync('src/servers/'), 'src/servers/ should exist');
  });
  it('`src/hub.ts` - hub HTTP server', () => {
    assert.ok(existsSync('src/hub.ts'), 'src/hub.ts should exist');
  });
  it('`src/engine.ts` - agent run engine', () => {
    assert.ok(existsSync('src/engine.ts'), 'src/engine.ts should exist');
  });
  it('`src/dispatch.ts` - task dispatch', () => {
    assert.ok(existsSync('src/dispatch.ts'), 'src/dispatch.ts should exist');
  });
  it('`src/supervisor.ts` - process supervisor for resident agents', () => {
    assert.ok(existsSync('src/supervisor.ts'), 'src/supervisor.ts should exist');
  });
  it('`src/writefence.ts` - two-door write fence keeping `Write`, `Edit`, and `NotebookEdit` out of `allow', () => {
    assert.ok(existsSync('src/writefence.ts'), 'src/writefence.ts should exist');
  });
  it('`src/fenceprobe.ts` - live deny probe run at every boot to re-prove write-fence fall-through per gua', () => {
    assert.ok(existsSync('src/fenceprobe.ts'), 'src/fenceprobe.ts should exist');
  });
  it('`src/egress.ts` - egress and declared surface enforcement', () => {
    assert.ok(existsSync('src/egress.ts'), 'src/egress.ts should exist');
  });
  it('`src/toolclass.ts` - tool classification including the `fenceApplies` coverage predicate', () => {
    assert.ok(new RegExp('(?<![\\\\w$])fenceApplies(?![\\\\w$])').test(read('src/toolclass.ts')), 'fenceApplies should be defined in src/toolclass.ts');
  });
  it('`src/hubdir.ts` - the single module that resolves paths onto the hub directory', () => {
    assert.ok(existsSync('src/hubdir.ts'), 'src/hubdir.ts should exist');
  });
  it('`src/proc.ts` - child-process spawning via `spawnEntry` and `stopTree`, used instead of `npx`', () => {
    assert.ok(new RegExp('(?<![\\\\w$])spawnEntry(?![\\\\w$])').test(read('src/proc.ts')), 'spawnEntry should be defined in src/proc.ts');
  });
  it('`src/procscan.ts` - process-table scanning to locate residents without substring matching', () => {
    assert.ok(existsSync('src/procscan.ts'), 'src/procscan.ts should exist');
  });
  it('`src/secrets.ts` - transport credential resolution via `transportToken()`', () => {
    assert.ok(new RegExp('(?<![\\\\w$])transportToken(?![\\\\w$])').test(read('src/secrets.ts')), 'transportToken should be defined in src/secrets.ts');
  });
  it('`src/signing.ts` - log signing', () => {
    assert.ok(existsSync('src/signing.ts'), 'src/signing.ts should exist');
  });
  it('`src/logverify.ts` - log verification', () => {
    assert.ok(existsSync('src/logverify.ts'), 'src/logverify.ts should exist');
  });
  it('`src/knowledge.ts` and `src/knowledge-sources.ts` - knowledge source tracking and sync', () => {
    assert.ok(existsSync('src/knowledge.ts'), 'src/knowledge.ts should exist');
  });
  it('`src/mcplaunch.ts` - spawns MCP servers of the `command` and `builtin` forms through srt, one instan', () => {
    assert.ok(existsSync('src/mcplaunch.ts'), 'src/mcplaunch.ts should exist');
  });
  it('`src/mcpsandbox.ts` - MCP sandbox configuration', () => {
    assert.ok(existsSync('src/mcpsandbox.ts'), 'src/mcpsandbox.ts should exist');
  });
  it('`src/memoryfs.ts` - memory filesystem', () => {
    assert.ok(existsSync('src/memoryfs.ts'), 'src/memoryfs.ts should exist');
  });
  it('`src/consolidate.ts` - memory consolidation', () => {
    assert.ok(existsSync('src/consolidate.ts'), 'src/consolidate.ts should exist');
  });
  it('`src/candidates.ts` - candidate fan-out for parallel task runs', () => {
    assert.ok(existsSync('src/candidates.ts'), 'src/candidates.ts should exist');
  });
  it('`src/turnlock.ts` - turn lock enforcing the serial-loop invariant', () => {
    assert.ok(existsSync('src/turnlock.ts'), 'src/turnlock.ts should exist');
  });
  it('`src/account.ts` - account and budget ledger', () => {
    assert.ok(existsSync('src/account.ts'), 'src/account.ts should exist');
  });
  it('`src/obs.ts` - observability', () => {
    assert.ok(existsSync('src/obs.ts'), 'src/obs.ts should exist');
  });
  it('`src/bridge.ts` - room bridge', () => {
    assert.ok(existsSync('src/bridge.ts'), 'src/bridge.ts should exist');
  });
  it('`src/posture.ts` - exposure posture', () => {
    assert.ok(existsSync('src/posture.ts'), 'src/posture.ts should exist');
  });
  it('`src/principals.ts` - principal identity', () => {
    assert.ok(existsSync('src/principals.ts'), 'src/principals.ts should exist');
  });
  it('`src/credentials.ts` - credential management', () => {
    assert.ok(existsSync('src/credentials.ts'), 'src/credentials.ts should exist');
  });
  it('`src/migrate.ts` - hub directory migration', () => {
    assert.ok(existsSync('src/migrate.ts'), 'src/migrate.ts should exist');
  });
  it('`interop/rfa_min.py` - minimal Python interop reference implementation', () => {
    assert.ok(existsSync('interop/rfa_min.py'), 'interop/rfa_min.py should exist');
  });
  it('`scripts/` - operator scripts: e2e, coldstart, demo-push, fence-proof, egress-proof, watchdog-replay', () => {
    assert.ok(existsSync('scripts/'), 'scripts/ should exist');
  });
  it('`spec/` - RFA specification documents (versions 0.1 through 0.9)', () => {
    assert.ok(existsSync('spec/'), 'spec/ should exist');
  });
  it('`templates/` - files seeded into new hub directories by `rfa init`, including the eval rubric, servi', () => {
    assert.ok(existsSync('templates/'), 'templates/ should exist');
  });
  it('`console/` - web console static assets', () => {
    assert.ok(existsSync('console/'), 'console/ should exist');
  });
  it('An operator request enters through `src/cli/main.ts`, which routes to a command in `src/cli/commands', () => {
    assert.ok(existsSync('src/cli/main.ts'), 'src/cli/main.ts should exist');
  });
  it('Commands that need hub state open the store via `src/hubdir.ts` when no hub is running, or call the ', () => {
    assert.ok(existsSync('src/hubdir.ts'), 'src/hubdir.ts should exist');
  });
  it('A task dispatched through `src/dispatch.ts` is picked up by `src/engine.ts`, which launches a reside', () => {
    assert.ok(existsSync('src/dispatch.ts'), 'src/dispatch.ts should exist');
  });
  it('Observability events flow through `src/obs.ts`, and the completed run\'s episode is available to the ', () => {
    assert.ok(existsSync('src/obs.ts'), 'src/obs.ts should exist');
  });
  it('Transport credential resolution is centralised in `transportToken()` in `src/secrets.ts`; callers re', () => {
    assert.ok(new RegExp('(?<![\\\\w$])transportToken(?![\\\\w$])').test(read('src/secrets.ts')), 'transportToken should be defined in src/secrets.ts');
  });
  it('Child-process lifecycle is managed through `spawnEntry` and `stopTree` in `src/proc.ts` to ensure SI', () => {
    assert.ok(new RegExp('(?<![\\\\w$])stopTree(?![\\\\w$])').test(read('src/proc.ts')), 'stopTree should be defined in src/proc.ts');
  });
  it('Write-fence enforcement is applied at startup by `src/writefence.ts`, which keeps `Write`, `Edit`, a', () => {
    assert.ok(read('src/writefence.ts').includes('Write'), 'src/writefence.ts should contain Write');
  });
  it('Boot-time fence probing is performed by `src/fenceprobe.ts`; `bypassed` and `inconclusive` results a', () => {
    assert.ok(read('src/fenceprobe.ts').includes('bypassed'), 'src/fenceprobe.ts should contain bypassed');
  });
  it('Tool surface classification uses `fenceApplies` in `src/toolclass.ts` to determine whether the write', () => {
    assert.ok(new RegExp('(?<![\\\\w$])fenceApplies(?![\\\\w$])').test(read('src/toolclass.ts')), 'fenceApplies should be defined in src/toolclass.ts');
  });
  it('Log integrity is provided by `src/signing.ts` (signing) and `src/logverify.ts` (verification)', () => {
    assert.ok(existsSync('src/logverify.ts'), 'src/logverify.ts should exist');
  });
  it('Observability is collected in `src/obs.ts`', () => {
    assert.ok(existsSync('src/obs.ts'), 'src/obs.ts should exist');
  });
  it('Error types are centralised in `src/errors.ts`', () => {
    assert.ok(existsSync('src/errors.ts'), 'src/errors.ts should exist');
  });
  it('Background knowledge sync takes a drain barrier in the account lease table before pulling, coordinat', () => {
    assert.ok(existsSync('src/account.ts'), 'src/account.ts should exist');
  });
  it('`templates/service/launchd.plist` - launchd service definition for macOS deployment', () => {
    assert.ok(existsSync('templates/service/launchd.plist'), 'templates/service/launchd.plist should exist');
  });
  it('`templates/service/systemd.service` - systemd service definition for Linux deployment', () => {
    assert.ok(existsSync('templates/service/systemd.service'), 'templates/service/systemd.service should exist');
  });
  it('The `build` script compiles TypeScript sources from `src/` to `dist/` via `tsc`', () => {
    assert.ok(read('package.json').includes('"build": "tsc"'), 'package.json should contain "build": "tsc"');
  });
  it('The `engines` field in `package.json` requires Node.js `>=22`', () => {
    assert.ok(read('package.json').includes('"node": ">=22"'), 'package.json should contain "node": ">=22"');
  });
  it('The `pretest` script enforces Node.js major version 22 or above before running tests', () => {
    assert.ok(read('package.json').includes('"pretest": "node -e \\"if(+process.versions.node.split(\'.\')[0]<22)'), 'package.json should contain "pretest": "node -e \\"if(+process.versions.node.split(\'.\')[0]<22)');
  });
  // docs/CONVENTIONS.md
  it('Lane types use string union literals declared as `export type Lane = "serve" | "schedule" | "backgro', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Lane(?![\\\\w$])').test(read('src/account.ts')), 'Lane should be defined in src/account.ts');
  });
  it('Constants that are re-exported from another module keep their original name, e.g. `EFFECTIVE_DEFAULT', () => {
    assert.ok(read('src/account.ts').includes('export { EFFECTIVE_DEFAULT_CAP }'), 'src/account.ts should contain export { EFFECTIVE_DEFAULT_CAP }');
  });
  it('Extension wire keys follow reverse-domain notation, e.g. `"io.github.pbeneteau/action-identity"` ass', () => {
    assert.ok(new RegExp('(?<![\\\\w$])ACTION_IDENTITY_EXT(?![\\\\w$])').test(read('src/actionid.ts')), 'ACTION_IDENTITY_EXT should be defined in src/actionid.ts');
  });
  it('Boolean predicate functions are prefixed with `is`, e.g. `isRateLimitError` and `isAuthError` in `sr', () => {
    assert.ok(new RegExp('(?<![\\\\w$])isRateLimitError(?![\\\\w$])').test(read('src/account.ts')), 'isRateLimitError should be defined in src/account.ts');
  });
  it('Admission result interfaces use noun phrases, e.g. `Admission`, `Lease`, `Settlement`, `BudgetReques', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Admission(?![\\\\w$])').test(read('src/account.ts')), 'Admission should be defined in src/account.ts');
  });
  it('Effect class values are lowercase kebab string literals: `"irreversible"`, `"reversible_with_cost"`,', () => {
    assert.ok(new RegExp('(?<![\\\\w$])EFFECT_CLASSES(?![\\\\w$])').test(read('src/actionid.ts')), 'EFFECT_CLASSES should be defined in src/actionid.ts');
  });
  it('Private class fields use the `private` keyword rather than `#` syntax, e.g. `private db: Database.Da', () => {
    assert.ok(read('src/account.ts').includes('private db: Database.Database'), 'src/account.ts should contain private db: Database.Database');
  });
  it('Duration constants are suffixed `_MS` for milliseconds, e.g. `LEASE_TTL_MS`, `UNPARK_GRACE_MS`, `RAT', () => {
    assert.ok(read('src/account.ts').includes('const LEASE_TTL_MS = 120_000'), 'src/account.ts should contain const LEASE_TTL_MS = 120_000');
  });
  it('The identity prefix encodes the normalization version as a string literal `"act1_"` prepended to the', () => {
    assert.ok(read('src/actionid.ts').includes('act1_'), 'src/actionid.ts should contain act1_');
  });
  it('Core runtime modules live directly under `src/`', () => {
    assert.ok(existsSync('src/'), 'src/ should exist');
  });
  it('CLI entry point and command modules live under `src/cli/`', () => {
    assert.ok(existsSync('src/cli/'), 'src/cli/ should exist');
  });
  it('CLI subcommands are individual files under `src/cli/commands/`', () => {
    assert.ok(existsSync('src/cli/commands/'), 'src/cli/commands/ should exist');
  });
  it('TUI components are TypeScript/TSX files under `src/cli/tui/`', () => {
    assert.ok(existsSync('src/cli/tui/'), 'src/cli/tui/ should exist');
  });
  it('Eval pipeline modules live under `src/evals/`', () => {
    assert.ok(existsSync('src/evals/'), 'src/evals/ should exist');
  });
  it('MCP server integrations live under `src/servers/`', () => {
    assert.ok(existsSync('src/servers/'), 'src/servers/ should exist');
  });
  it('All test files live under `test/` and are named `*.test.ts` or `*.test.tsx`', () => {
    assert.ok(existsSync('test/'), 'test/ should exist');
  });
  it('Operator scripts (e2e, coldstart, proofs) live under `scripts/`', () => {
    assert.ok(existsSync('scripts/'), 'scripts/ should exist');
  });
  it('Wire and platform specifications live under `spec/`', () => {
    assert.ok(existsSync('spec/'), 'spec/ should exist');
  });
  it('Seed templates for hub directory initialization live under `templates/`', () => {
    assert.ok(existsSync('templates/'), 'templates/ should exist');
  });
  it('The interoperability reference client lives at `interop/rfa_min.py`', () => {
    assert.ok(existsSync('interop/rfa_min.py'), 'interop/rfa_min.py should exist');
  });
  it('Node built-ins are imported with the `node:` protocol prefix, e.g. `import Database from "better-sql', () => {
    assert.ok(read('src/account.ts').includes('import { randomBytes } from "node:crypto"'), 'src/account.ts should contain import { randomBytes } from "node:crypto"');
  });
  it('The project uses ES module syntax (`"type": "module"` in `package.json`) with `.js` extensions on lo', () => {
    assert.ok(read('package.json').includes('"type": "module"'), 'package.json should contain "type": "module"');
  });
  it('Internal modules are imported by relative path with `.js` extension as required by Node16 module res', () => {
    assert.ok(read('scripts/egress-proof.ts').includes('from "../src/egress.js"'), 'scripts/egress-proof.ts should contain from "../src/egress.js"');
  });
  it('`tsconfig.json` sets `"moduleResolution": "node16"` and `"module": "Node16"`, enforcing explicit ext', () => {
    assert.ok(read('tsconfig.json').includes('"moduleResolution": "node16"'), 'tsconfig.json should contain "moduleResolution": "node16"');
  });
  it('The `@modelcontextprotocol/sdk` client is imported from its scoped subpath, e.g. `from "@modelcontex', () => {
    assert.ok(read('scripts/demo-push.ts').includes('from "@modelcontextprotocol/sdk/client/index.js"'), 'scripts/demo-push.ts should contain from "@modelcontextprotocol/sdk/client/index.js"');
  });
  it('JSX is compiled with `"jsx": "react-jsx"` in `tsconfig.json`, used by TUI components under `src/cli/', () => {
    assert.ok(read('tsconfig.json').includes('"jsx": "react-jsx"'), 'tsconfig.json should contain "jsx": "react-jsx"');
  });
  it('Domain errors are typed classes extending `Error`, e.g. `RfaError` in `interop/rfa_min.py` carries `', () => {
    assert.ok(read('interop/rfa_min.py').includes('class RfaError(Exception):'), 'interop/rfa_min.py should contain class RfaError(Exception):');
  });
  it('`HubDirError` is caught by name and its `.hint` field is printed before `process.exit(2)`, e.g. in `', () => {
    assert.ok(read('scripts/repair-obs-cost.ts').includes('if (err instanceof HubDirError)'), 'scripts/repair-obs-cost.ts should contain if (err instanceof HubDirError)');
  });
  it('Admission refusals are typed via the `reason` discriminant on the `Admission` interface: `"account_p', () => {
    assert.ok(new RegExp('(?<![\\\\w$])Admission(?![\\\\w$])').test(read('src/account.ts')), 'Admission should be defined in src/account.ts');
  });
  it('Auth failures are detected by `isAuthError` using a shared `AUTH_FAILURE_RE` regex derived from `AUT', () => {
    assert.ok(new RegExp('(?<![\\\\w$])isAuthError(?![\\\\w$])').test(read('src/account.ts')), 'isAuthError should be defined in src/account.ts');
  });
  it('Rate-limit detection is centralised in `isRateLimitError` in `src/account.ts` and matched by `RATE_L', () => {
    assert.ok(new RegExp('(?<![\\\\w$])isRateLimitError(?![\\\\w$])').test(read('src/account.ts')), 'isRateLimitError should be defined in src/account.ts');
  });
  it('Mutating RPC calls in `interop/rfa_min.py` are not retried blindly; only idempotent reads listed in ', () => {
    assert.ok(read('interop/rfa_min.py').includes('IDEMPOTENT = {"room_listen", "room_roster", "room_presence", "agent_describe"}'), 'interop/rfa_min.py should contain IDEMPOTENT = {"room_listen", "room_roster", "room_presence", "agent_describe"}');
  });
  it('Process exit codes are explicit: `process.exit(1)` for operational failure, `process.exit(2)` for ba', () => {
    assert.ok(read('scripts/repair-obs-cost.ts').includes('process.exit(2)'), 'scripts/repair-obs-cost.ts should contain process.exit(2)');
  });
  it('The test runner is Node\'s built-in `--test` flag, invoked as `node --import tsx --test test/*.test.t', () => {
    assert.ok(read('package.json').includes('"test": "node --import tsx --test test/*.test.ts test/*.test.tsx"'), 'package.json should contain "test": "node --import tsx --test test/*.test.ts test/*.test.tsx"');
  });
  it('Concurrency interleaving tests live in `test/interleaving.test.ts` and use barriers rather than timi', () => {
    assert.ok(existsSync('test/interleaving.test.ts'), 'test/interleaving.test.ts should exist');
  });
  it('The write-fence deterministic half lives in `test/writefence.test.ts`', () => {
    assert.ok(existsSync('test/writefence.test.ts'), 'test/writefence.test.ts should exist');
  });
  it('Hub directory path-resolution is regression-tested in `test/hubdir.test.ts`', () => {
    assert.ok(existsSync('test/hubdir.test.ts'), 'test/hubdir.test.ts should exist');
  });
  it('The observability store is a SQLite database accessed via `better-sqlite3`, with a separate `runs.db', () => {
    assert.ok(read('scripts/repair-obs-cost.ts').includes('SELECT id, name, cost_usd, (end_time - start_time) AS ms, error'), 'scripts/repair-obs-cost.ts should contain SELECT id, name, cost_usd, (end_time - start_time) AS ms, error');
  });
  it('Spend attribution is written to `lease_settlements` with columns `lease_id`, `agent`, `lane`, `run_i', () => {
    assert.ok(read('src/account.ts').includes('CREATE TABLE IF NOT EXISTS lease_settlements'), 'src/account.ts should contain CREATE TABLE IF NOT EXISTS lease_settlements');
  });
  it('Rate-limit events are recorded to `account_rate_limits` with `agent`, `run_id`, `detail`, `at` and `', () => {
    assert.ok(read('src/account.ts').includes('CREATE TABLE IF NOT EXISTS account_rate_limits'), 'src/account.ts should contain CREATE TABLE IF NOT EXISTS account_rate_limits');
  });
  it('Auth failure markers are defined as `AUTH_FAILURE_MARKERS` in `src/account.ts` in SQL LIKE syntax an', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AUTH_FAILURE_MARKERS(?![\\\\w$])').test(read('src/account.ts')), 'AUTH_FAILURE_MARKERS should be defined in src/account.ts');
  });
  it('The `AccountSnapshot` interface exposes `in_flight`, `parked`, `by_lane`, `by_agent`, `paused_until`', () => {
    assert.ok(new RegExp('(?<![\\\\w$])AccountSnapshot(?![\\\\w$])').test(read('src/account.ts')), 'AccountSnapshot should be defined in src/account.ts');
  });
  it('Script language is inconsistent: operator scripts are TypeScript (`scripts/e2e.ts`, `scripts/fence-p', () => {
    assert.ok(read('scripts/tui-drive.py').includes('#!/usr/bin/env python3'), 'scripts/tui-drive.py should contain #!/usr/bin/env python3');
  });
  it('Retry logic style differs between layers: `interop/rfa_min.py` uses an explicit `RETRY_DELAYS_S` lis', () => {
    assert.ok(read('interop/rfa_min.py').includes('RETRY_DELAYS_S = [0.25, 1.0, 3.0]'), 'interop/rfa_min.py should contain RETRY_DELAYS_S = [0.25, 1.0, 3.0]');
  });
  // README.md
  it('**Room protocol** - agents join rooms, discover members by capability digest, and exchange messages ', () => {
    assert.ok(existsSync('src/main.ts'), 'src/main.ts should exist');
  });
  it('**Operator CLI (`rfa`)** - the front door for onboarding, the dashboard, agent lifecycle, room manag', () => {
    assert.ok(new RegExp('(?<![\\\\w$])main(?![\\\\w$])').test(read('src/cli/main.ts')), 'main should be defined in src/cli/main.ts');
  });
  it('**Agent packs and supervisor** - local agents are defined as packs and managed by `src/supervisor.ts', () => {
    assert.ok(existsSync('src/supervisor.ts'), 'src/supervisor.ts should exist');
  });
  it('**Two-door write fence** - implemented in `src/writefence.ts`, keeping `Write`, `Edit`, and `Noteboo', () => {
    assert.ok(existsSync('src/writefence.ts'), 'src/writefence.ts should exist');
  });
  it('**TUI dashboard** - implemented in `src/cli/tui/dashboard.tsx`', () => {
    assert.ok(existsSync('src/cli/tui/dashboard.tsx'), 'src/cli/tui/dashboard.tsx should exist');
  });
  it('**Room console** - a live web view served by the hub, located at `console/index.html`', () => {
    assert.ok(existsSync('console/index.html'), 'console/index.html should exist');
  });
  it('**Interop reference client** - `interop/rfa_min.py` is a dependency-free Python reference client for', () => {
    assert.ok(existsSync('interop/rfa_min.py'), 'interop/rfa_min.py should exist');
  });
  it('**Service templates** - `templates/service/launchd.plist` and `templates/service/systemd.service` fo', () => {
    assert.ok(existsSync('templates/service/launchd.plist'), 'templates/service/launchd.plist should exist');
  });
  it('**OTel observability** - one span per tool call via `src/obs.ts`, joining the caller\'s trace when `_', () => {
    assert.ok(existsSync('src/obs.ts'), 'src/obs.ts should exist');
  });
  it('Node.js `>=22` is required, as declared in the `engines` field of `package.json`', () => {
    assert.ok(read('package.json').includes('"node": ">=22"'), 'package.json should contain "node": ">=22"');
  });
  it('The package name is `agent-com` and the installed binary is `rfa`, as declared in the `bin` field of', () => {
    assert.ok(read('package.json').includes('"rfa": "dist/cli/main.js"'), 'package.json should contain "rfa": "dist/cli/main.js"');
  });
  it('Install from the repository with `npm install -g git+ssh://git@github.com/pbeneteau/agent-com.git`', () => {
    assert.ok(read('package.json').includes('"url": "git+https://github.com/pbeneteau/agent-com.git"'), 'package.json should contain "url": "git+https://github.com/pbeneteau/agent-com.git"');
  });
  it('Run `npm install` to install dependencies after cloning', () => {
    assert.ok(existsSync('package-lock.json'), 'package-lock.json should exist');
  });
  it('The `pretest` script checks that Node.js major version is at least 22 before running tests, because ', () => {
    assert.ok(read('package.json').includes('"pretest": "node -e \\"if(+process.versions.node.split(\'.\')[0]<22)'), 'package.json should contain "pretest": "node -e \\"if(+process.versions.node.split(\'.\')[0]<22)');
  });
  it('Run evals with `npm run evals` (equivalent to `tsx src/cli/main.ts evals run`)', () => {
    assert.ok(read('package.json').includes('"evals": "tsx src/cli/main.ts evals run"'), 'package.json should contain "evals": "tsx src/cli/main.ts evals run"');
  });
  it('Run judged evals with `npm run evals:judged` (equivalent to `tsx src/cli/main.ts evals run --judged`', () => {
    assert.ok(read('package.json').includes('"evals:judged": "tsx src/cli/main.ts evals run --judged"'), 'package.json should contain "evals:judged": "tsx src/cli/main.ts evals run --judged"');
  });
  it('Run the parity gate with `npm run parity` (equivalent to `tsx src/cli/main.ts evals parity`)', () => {
    assert.ok(read('package.json').includes('"parity": "tsx src/cli/main.ts evals parity"'), 'package.json should contain "parity": "tsx src/cli/main.ts evals parity"');
  });
  it('Run the TUI smoke test with `npm run tui:smoke` (invokes `python3 scripts/tui-drive.py --smoke`)', () => {
    assert.ok(read('package.json').includes('"tui:smoke": "python3 scripts/tui-drive.py --smoke"'), 'package.json should contain "tui:smoke": "python3 scripts/tui-drive.py --smoke"');
  });
  it('The CLI entry point is `src/cli/main.ts`; the hub entry point is `src/main.ts`', () => {
    assert.ok(existsSync('src/cli/main.ts'), 'src/cli/main.ts should exist');
  });
  it('`RFA_TOKEN` - the transport credential read per call by `transportToken()` in `src/secrets.ts`', () => {
    assert.ok(read('CLAUDE.md').includes('RFA_TOKEN'), 'CLAUDE.md should contain RFA_TOKEN');
  });
  it('`RFA_HUMAN_KEYS` - environment form for human principal keys', () => {
    assert.ok(read('README.md').includes('RFA_HUMAN_KEYS'), 'README.md should contain RFA_HUMAN_KEYS');
  });
  it('`RFA_MCP_TOKENS` - environment form for MCP transport bearers', () => {
    assert.ok(read('README.md').includes('RFA_MCP_TOKENS'), 'README.md should contain RFA_MCP_TOKENS');
  });
  it('`RFA_PUSH_URL` - environment form for the push notification URL', () => {
    assert.ok(read('README.md').includes('RFA_PUSH_URL'), 'README.md should contain RFA_PUSH_URL');
  });
  it('`RFA_CONSOLE_URL` - environment form for the console URL', () => {
    assert.ok(read('README.md').includes('RFA_CONSOLE_URL'), 'README.md should contain RFA_CONSOLE_URL');
  });
  it('`.rfa/` is the runtime directory (gitignored, 0700) holding `secrets.json`, `principals.json`, `toke', () => {
    assert.ok(read('README.md').includes('.rfa/               runtime the tool owns, gitignored, 0700: secrets.json, principals.json'), 'README.md should contain .rfa/               runtime the tool owns, gitignored, 0700: secrets.json, principals.json');
  });
  it('`policies/gate.json` is the pre-delivery policy gate; the template ships at `templates/gate.json`', () => {
    assert.ok(existsSync('templates/gate.json'), 'templates/gate.json should exist');
  });
  it('`src/env.ts` is the module that handles environment variable access', () => {
    assert.ok(existsSync('src/env.ts'), 'src/env.ts should exist');
  });
  it('Run the unit and integration test suite with `npm test` (globs `test/*.test.ts` and `test/*.test.tsx', () => {
    assert.ok(read('package.json').includes('"test": "node --import tsx --test test/*.test.ts test/*.test.tsx"'), 'package.json should contain "test": "node --import tsx --test test/*.test.ts test/*.test.tsx"');
  });
  it('Run end-to-end scenarios with `npm run e2e` (invokes `tsx scripts/e2e.ts`; writes `reports/latest.md', () => {
    assert.ok(read('package.json').includes('"e2e": "tsx scripts/e2e.ts"'), 'package.json should contain "e2e": "tsx scripts/e2e.ts"');
  });
  it('Run the full e2e suite with `npm run e2e:full` (invokes `tsx scripts/e2e.ts --full`)', () => {
    assert.ok(read('package.json').includes('"e2e:full": "tsx scripts/e2e.ts --full"'), 'package.json should contain "e2e:full": "tsx scripts/e2e.ts --full"');
  });
  it('Build TypeScript sources with `npm run build` (invokes `tsc`; output goes to `dist/`)', () => {
    assert.ok(read('tsconfig.json').includes('"outDir": "dist"'), 'tsconfig.json should contain "outDir": "dist"');
  });
  it('The TypeScript compiler targets `ES2022` with `module` set to `Node16`', () => {
    assert.ok(read('tsconfig.json').includes('"target": "ES2022"'), 'tsconfig.json should contain "target": "ES2022"');
  });
  it('JSX is compiled with `react-jsx` transform, as set in `tsconfig.json`', () => {
    assert.ok(read('tsconfig.json').includes('"jsx": "react-jsx"'), 'tsconfig.json should contain "jsx": "react-jsx"');
  });
  it('The deterministic concurrency test lives in `test/interleaving.test.ts`', () => {
    assert.ok(existsSync('test/interleaving.test.ts'), 'test/interleaving.test.ts should exist');
  });
  it('A launchd service template is provided at `templates/service/launchd.plist`', () => {
    assert.ok(existsSync('templates/service/launchd.plist'), 'templates/service/launchd.plist should exist');
  });
  it('A systemd service template is provided at `templates/service/systemd.service`', () => {
    assert.ok(existsSync('templates/service/systemd.service'), 'templates/service/systemd.service should exist');
  });
  it('The published package includes `dist`, `console`, `templates`, `interop`, `INTEROP.md`, `spec`, `REA', () => {
    assert.ok(read('package.json').includes('"files": [\n    "dist",\n    "console",\n    "templates",\n    "interop",\n    "INTEROP.md",\n    "spec",\n    "README.md",\n    "LICENSE"\n  ]'), 'package.json should contain "files": [\n    "dist",\n    "console",\n    "templates",\n    "interop",\n    "INTEROP.md",\n    "spec",\n    "README.md",\n    "LICENSE"\n  ]');
  });
  it('Licensed under Apache-2.0, as declared in `package.json` and the `LICENSE` file', () => {
    assert.ok(read('package.json').includes('"license": "Apache-2.0"'), 'package.json should contain "license": "Apache-2.0"');
  });
  it('`npm test` runs', () => {
    assert.doesNotThrow(() => execSync('npm test', { stdio: 'ignore' }));
  });
});
