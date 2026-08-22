## Project Overview

- The package is named `agent-com` and published under the Apache-2.0 license.
- The package exposes two CLI binary names: `rfa` and `agent-com`, both pointing to `dist/cli/main.js`.
- Node.js 22 or later is required.

## Build and Development Commands

- Run `npm run build` (or `pnpm build`) to compile TypeScript via `tsc`.
- Run `npm run dev` to start the CLI entry point without compiling, using `tsx src/cli/main.ts`.
- Run `npm run start` to start the hub server via `tsx src/main.ts`.
- Run `npm run supervisor` to start the supervisor process via `tsx src/supervisor.ts`.

## Testing

- Unit tests are run with `npm test`, which invokes `node --import tsx --test test/*.test.ts`.
- End-to-end tests are run with `npm run e2e`, executing `scripts/e2e.ts`.
- A fuller e2e suite is available via `npm run e2e:full`, passing `--full` to the same script.
- Evals are run with `npm run evals`, which calls `tsx src/cli/main.ts evals run`.
- Judged evals are run with `npm run evals:judged`, passing `--judged` to the evals runner.
- The cold-start operator test (`npm run coldstart`) packs the checkout, installs it into a temp prefix, inits an empty folder, and asserts a real model answer, then tears down.
- The `--keep` flag on the coldstart script retains the temp prefix and directory for inspection.

## Project Layout

- CLI source lives under `src/cli/`.
- Agent pack definitions live under `agents/`, with each agent in its own subdirectory containing `agent.md`.
- Eval cases live under `evals/cases/`.
- Spec documents live under `spec/`.
- Research documents are organized under `research/` in numbered subdirectories.
- Templates for new agents and commands are under `templates/`.
- MCP interoperability definitions are in `interop/`.
- The console (web UI) asset directory is `console/`.
- Scripts for maintenance and one-time operations are in `scripts/`.

## Agent Packs

- Each agent pack is a directory under `agents/<name>/` with an `agent.md` file containing YAML frontmatter (the definition) and a markdown body (the system prompt).
- The `agentDefSchema` Zod schema is the single shared schema used by the resident runner, supervisor, and console editor.
- `parseAgentMd` parses an agent.md string and throws with a precise message on invalid input.
- `loadPack` loads a pack directory from disk.
- `listPacks` enumerates all packs under an agents root, skipping directories without `agent.md`.
- `deriveCard` derives the capability card from an agent pack, including the definition hash as a deployed-version marker.
- A pack that serves a room as a participant must declare at least one entry in `offers`.
- Fan-out (subagent) tools are opt-in and require `tools.allow_subagents: true` in the pack definition.

## Human-in-the-Loop Approval Bridge

- `requestApproval` publishes an approval request for a pending tool call and blocks until a human decision, expiry, or timeout.
- The approval sidekick membership is named `<residentName>-hitl` and joins as an observer role.
- The default approval window when no `reply_by` is present is 30 minutes.
- `interruptMatch` matches a tool name against `interrupt_on` keys, with trailing `*` acting as a prefix glob.
- `refusalForOutcome` returns `deadline_expired` for clock-based denials and `declined` for human rejections.

## Hash-Chain Verification

- `verifyChain` walks an event log in order, checking each event's `prev_hash` link and reporting all divergences.
- Events predating the chain (no `prev_hash`) are counted as `unchainedPrefix` and skipped rather than treated as breaks.
- The `CHAIN_SCOPE_QUALIFIER` constant states that chain verification only proves no party other than the hub rewrote the log.
- `genesisFor` computes the genesis link as the hex SHA-256 of the room handle.

## agent.md Editing Conventions

- `bindPack` rewrites only the `rooms:` block of an agent.md file, validates the result through the pack schema before writing, and returns definition hashes before and after.
- `addKnowledge` merges new globs into the `knowledge:` block, deduplicates them, and validates before writing.
- `setTopBlock` replaces or adds one top-level YAML block in agent.md frontmatter without touching any other lines.

## Key Dependencies

- The Anthropic Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is a runtime dependency.
- MCP client and server packages (`@modelcontextprotocol/client`, `@modelcontextprotocol/server`, `@modelcontextprotocol/sdk`) are runtime dependencies.
- `better-sqlite3` is used for local SQLite storage (e.g., the observability store).
- `zod` is used for schema validation throughout the project.
- `tsx` is the dev-time TypeScript runner used in all `npm run` scripts that don't compile first.

## Maintenance Scripts

- `scripts/repair-obs-cost.ts` is a one-time repair script for observability rows whose `cost_usd` was incorrectly set to a day ledger total; it requires `--apply` to write changes.
- `scripts/watchdog-replay.ts` replays watchdog invariants against room logs and the observability store, and refuses to bless any invariant until the log corpus is at least 14 days.
- `scripts/demo-push.ts` demonstrates zero-polling push delivery over a real stdio MCP transport.
