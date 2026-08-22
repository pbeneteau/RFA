## Build & Run

- The project is compiled with TypeScript via the `build` script.
- The CLI entry point is `src/cli/main.ts`, run in development via the `dev` script.
- The hub server entry point is `src/main.ts`, run via the `start` script.
- Node.js 22 or later is required.
- Two CLI bin aliases are provided: `rfa` and `agent-com`, both pointing to `dist/cli/main.js`.

## Tests & Evaluations

Unit tests, e2e scripts, and eval commands are each separate scripts.

- Unit tests are executed with `node --import tsx --test` over `test/*.test.ts`.
- End-to-end tests are run via the `e2e` script (`scripts/e2e.ts`).
- Evaluations are run through the CLI with `tsx src/cli/main.ts evals run`, aliased as the `evals` script.
- Judged evaluations add `--judged` and are available as the `evals:judged` script.
- Parity evaluation is available as the `parity` script.
- The cold-start integration test (`scripts/coldstart.ts`) packs the checkout, installs the tarball globally into a temp prefix, and verifies a full init-ask-down cycle; it is not part of `npm test` and requires a model credential.

## Project Layout

- Agent pack definitions live under `agents/`, each in its own subdirectory containing an `agent.md` file.
- CLI source files are under `src/cli/`.
- Eval source files are under `src/evals/`.
- Research notes are under `research/`, divided into numbered topic directories.
- Specification files are in `spec/`.
- Interoperability definitions are in `interop/`.
- Agent and command templates are in `templates/`.
- The web console asset is in `console/`.
- Published package files include `dist`, `console`, `templates`, `interop`, `spec`, and `README.md`.

## Agent Pack Format

- An agent pack is a directory under `agents/<name>/` whose `agent.md` begins with YAML frontmatter (the definition) followed by a markdown body used as the system prompt.
- The frontmatter schema is `agentDefSchema`, validated with Zod.
- The frontmatter must declare `rfa_agent: 1` as a literal field.
- A pack that serves a room as participant must declare at least one entry in `offers`.
- Sub-agent fan-out tools (`agent`, `task`) are deny-listed by default and require `tools.allow_subagents: true` in the definition.
- The capability card is derived from the pack definition via `deriveCard`, including a `definition_hash` so roster entries rotate on any definition edit.
- All secret names a pack requires are collected by `declaredSecretNames`, covering both `secrets` and per-MCP-server `env_secrets`/`bearer_secret`.

## Human-in-the-Loop Approval Bridge

- Tool calls matching an `interrupt_on` rule in the pack definition are routed through the approval bridge in `src/bridge.ts`.
- The bridge uses a lazy observer sidekick membership named `<residentName>-hitl` to watch for decisions without consuming the main member's event cursor.
- The default approval window when no `reply_by` is present is 30 minutes.
- Clock-expired approvals use the wire reason `deadline_expired`; human refusals use `declined`.
- Tool names are matched against `interrupt_on` keys with trailing-`*` glob support via `interruptMatch`.

## Hash Chain Verification

- Offline chain verification is implemented in `src/chain.ts` as a pure function over a pre-parsed event array.
- Each event's link is JCS-SHA256 over its stored form; for redacted events the `content_hash` field is used instead of recomputing.
- The `wrapped` field is stripped before hashing; no other fields are excluded.
- Events with no `prev_hash` (written before chain support shipped in 0.1.7) are counted as an `unchainedPrefix` rather than treated as breaks.
- A normative scope qualifier string is exported as `CHAIN_SCOPE_QUALIFIER`, stating that the chain only proves non-hub parties did not rewrite the log.

## Key Dependencies

- The Anthropic Claude Agent SDK is used as the agent runtime.
- MCP client and server packages from `@modelcontextprotocol` are used for the tool protocol.
- SQLite persistence is provided by `better-sqlite3`.
- Cron scheduling is handled by `croner`.
- YAML frontmatter parsing uses the `yaml` package.
- Schema validation uses `zod`.
