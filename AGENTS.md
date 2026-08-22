## Project Overview

agent-com (package name `agent-com`, CLI binary `rfa`) is a self-hosted hub for local and remote AI agents.

- The published npm package exposes two CLI entry points: `rfa` and `agent-com`, both resolving to `dist/cli/main.js`.
- The package is licensed under Apache-2.0.
- Node.js 22 or later is required by the engines field.

## Build & Dev Commands

- Run `pnpm build` (or `npm run build`) to compile TypeScript via `tsc`; the same compilation runs automatically on `prepare` and `prepublishOnly`.
- Run `npm run dev` to start the CLI without a prior compile step using `tsx src/cli/main.ts`.
- Run `npm start` to launch the hub server directly via `tsx src/main.ts`.
- Run `npm run supervisor` to start the supervisor process via `tsx src/supervisor.ts`.

## Testing

- Unit tests are run with `npm test`, which uses Node's built-in test runner: `node --import tsx --test test/*.test.ts`.
- End-to-end tests are run with `npm run e2e` (standard) or `npm run e2e:full` (full suite), both via `tsx scripts/e2e.ts`.
- Eval runs are invoked with `npm run evals` (`evals run`) or `npm run evals:judged` (`evals run --judged`), both via the CLI entry point.
- The cold-start operator test (`npm run coldstart`) packs the checkout, installs into a temp prefix, inits an empty folder, sends a question, and tears everything down; it is not part of `npm test` because it requires a model credential.

## Key Source Entry Points

- `src/cli/main.ts` is the CLI entry point used during development via `npm run dev`.
- `src/main.ts` is the hub server entry point.
- `src/supervisor.ts` is the supervisor process entry point.
- `src/agentdef.ts` exports `agentDefSchema`, `parseAgentMd`, `loadPack`, `listPacks`, and `deriveCard` — the single Zod schema shared by the resident runner, supervisor, and console editor for agent pack definitions.
- `src/bridge.ts` implements the approval bridge (spec 7.3), routing tool calls through the room's approval machinery when a pack declares `interrupt_on`.
- `src/chain.ts` provides offline verification of a room's hash chain as defined in wire spec section 13.

## Agent Pack Format

- An agent pack lives in `agents/<name>/agent.md` with a YAML frontmatter block (the definition) and a markdown body (the system prompt).
- The frontmatter must begin with `rfa_agent: 1` — the literal key checked by `agentDefSchema`.
- Fan-out subagent tools (`agent`, `task`) are denied by default; they require `tools.allow_subagents: true` in the pack definition.
- A pack that serves a room as participant must declare at least one entry in `offers`; `parseAgentMd` throws if this constraint is violated.
- The `definitionHash` is a `sha256:` prefixed hex digest over the full `agent.md` content; changing the file rotates the hash visible in every roster.
- The CLI rewrites only the `rooms:` or `knowledge:` block of `agent.md` it is asked to touch, and validates through the same schema before writing, via `src/cli/agentmd.ts`.

## Project Layout

- Agent pack directories live under `agents/` (e.g. `agents/pm-agent/`, `agents/linear-scribe/`).
- End-to-end and maintenance scripts live under `scripts/`.
- Eval case definitions live under `evals/cases/`.
- Pack and command templates live under `templates/` (subdirectories `service/`, `commands/`, `skills/`).
- Interoperability definitions are in `interop/` and `INTEROP.md`, both included in the published package `files` list.
- Specification documents live under `spec/`, included in the published package.
- Research notes are organized under `research/` with subdirectories for protocol, platform, reach-and-collaboration, and remote-agents topics.
- `.claude/commands/` and `.claude/skills/` hold Claude-specific command and skill configurations.

## Key Runtime Dependencies

- Agent SDK integration uses `@anthropic-ai/claude-agent-sdk`.
- MCP client, server, and SDK packages from `@modelcontextprotocol` are all direct dependencies.
- SQLite storage is handled via `better-sqlite3`.
- YAML frontmatter parsing uses the `yaml` package.
- Schema validation throughout uses `zod`.
- Cron scheduling uses `croner`.

## Hash-Chain Verification

- `verifyChain` reports every divergence in the chain, not just the first, and re-anchors after each break by continuing from the event's own computed link.
- Events that predate chain support (no `prev_hash` field) are counted as `unchainedPrefix` and skipped rather than treated as breaks.
- The constant `CHAIN_SCOPE_QUALIFIER` records the normative disclaimer that the chain proves only that no party other than the hub rewrote the log.

## Approval Bridge Conventions

- The default approval window when no `reply_by` deadline is present is 30 minutes (`DEFAULT_APPROVAL_WINDOW_MS = 30 * 60_000`).
- The sidekick observer membership is named `<residentName>-hitl` and is joined once per resident process via `joinSidekick`.
- A clock-expired approval returns `expired: true` and maps to wire reason `deadline_expired`; a human rejection maps to `declined`.
- `interruptMatch` supports trailing `*` glob patterns in `interrupt_on` keys, with exact rules taking priority over globs.
