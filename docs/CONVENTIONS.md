# Conventions

> Observed code conventions in rfa-hub (agent-com), derived from the source. Every rule cites a real example.

## Naming

**Identifiers:** `rid(prefix, bytes)` in `src/store.ts` generates prefixed hex IDs — `r_` (rooms), `m_` (members), `mt_` (membership tokens), `t_` (tasks), `c_` (conversations), `msg_` (messages), `ask_` (ask IDs), `st_` (session tokens). Pattern: `${prefix}_${randomBytes(bytes).toString("hex")}`.

**Constants:** SCREAMING_SNAKE_CASE for module-level constants — `AUTH_MAX_FAILURES`, `SESSION_TTL_MS`, `DRAIN_GRACE_MS`, `DEFAULT_MAX_ATTEMPTS` (all in `src/main.ts` and `src/store.ts`).

**Functions:** camelCase verbs — `acquireLock`, `touchLock`, `beginDrain`, `sessionPrincipal`, `authAudit`, `flushAuthWindow`, `originAllowed` (all in `src/main.ts`).

**Types/Interfaces:** PascalCase — `RoomHub`, `HubConfig`, `GateCheck`, `GateInput`, `GateMatchable`, `AuthWindow`, `AuthOutcome` (all in `src/store.ts`).

**Environment variables:** `RFA_TOKEN`, `RFA_MCP_TOKENS`, `RFA_HUMAN_KEYS`, `RFA_PUSH_URL`, `RFA_CONSOLE_URL`, `RFA_HUB_URL` — all referenced in `src/main.ts` and `dogfood/parity.ts`.

**Reserved name tokens:** `human`, `console`, `system`, `hub`, `rfa` — enforced via `RESERVED_FIRST_TOKENS` Set in both `src/store.ts` and `scripts/new-agent.ts`.

## File Organization

**Source layout:**
- `src/` — hub implementation; `src/main.ts` is the entrypoint (`bin.rfa-hub` in `package.json`)
- `src/evals/` — eval runner, judge, trajectory (`runner.ts`, `judge.ts`, `trajectory.ts`)
- `agents/<name>/agent.md` — agent pack definition; `agents/<name>/memory/blocks/` for core memory blocks (e.g. `agents/pm-agent/memory/blocks/persona.md`)
- `agents/*/knowledge/`, `agents/*/state/`, `agents/*/evals/cases/` — gitignored runtime directories
- `scripts/` — operator CLIs (`new-agent.ts`, `retire-agent.ts`, `sync-handbook.ts`, `e2e.ts`, `demo.ts`, etc.)
- `test/` — test files, all named `*.test.ts`; `test/hubproc.ts` is a helper (no `.test.` in name)
- `spec/` — normative specs (`RFA-0.1.md`, `RFA-0.4-platform.md`, `RFA-0.5-platform.md`, `RFA-0.6-remote.md`)
- `deploy/` — launchd plists (`com.rfa.hub.plist`, `com.rfa.supervisor.plist`), `gate.json`, `install.sh`
- `evals/` — eval cases (`evals/cases/`), `baseline.json`, `rubric.md`
- `research/` — four wave directories, each with `REPORT.md` and `notes/`; PDFs gitignored via `research/**/papers/*.pdf`
- `console/index.html` — single-file browser console
- `interop/rfa_min.py` — reference Python client

**Data files (gitignored):** `data/`, `dogfood/state/`, `dogfood/ROOM.md`, `reports/`

## Imports & Modules

**ESM throughout:** `"type": "module"` in `package.json`; `tsconfig.json` uses `"module": "Node16"`, `"moduleResolution": "node16"`.

**`.js` extensions on local imports** (Node16 ESM requirement) — `import { RoomHub } from "./store.js"`, `import { createHubServer } from "./hub.js"`, `import { ObsStore } from "./obs.js"` (all in `src/main.ts`).

**`import type` for type-only imports** — `import type { AgentCard, RfaEvent, ... } from "./model.js"` (in `src/store.ts`).

**Dynamic imports for optional heavy dependencies** — `await import("@opentelemetry/api")`, `await import("@opentelemetry/sdk-trace-base")`, `await import("@opentelemetry/context-async-hooks")` inside the `--otel` branch in `src/main.ts`.

**Node built-ins use `node:` prefix** — `import { randomBytes } from "node:crypto"`, `import * as fs from "node:fs"`, `import * as path from "node:path"` (in `src/main.ts`).

## TypeScript Patterns

**Strict mode:** `"strict": true` in `tsconfig.json`; target `ES2022`.

**Non-null assertion on verified argv reads** — `arg("--gate")!` in `src/main.ts` (used after `arg("--gate") ?` guard).

**`as never` for exporter type mismatch** — `new SimpleSpanProcessor(exporter as never)` in `src/main.ts` to satisfy SDK types without a full type declaration.

**`const` enums as plain objects** — `GATE_SEVERITY: Record<GateOutcome, number>` and `AUTH_AUDIT_COUNTER` as `const` objects with `as const` (in `src/store.ts` and `src/main.ts`).

**Discriminated union filters** — `Filter` type in `src/store.ts` uses `{ kind: "all" } | { kind: "mentions"; memberId: string } | ...`.

**Interface over type alias for object shapes** — `HubConfig`, `GateCheck`, `Member`, `Room`, `Waiter` are all `interface` (in `src/store.ts`); `type` used for unions and aliases (`GateOutcome`, `AdminVerb`, `Filter`).

**`ReturnType<>` for inferred return types** — `let pending: ReturnType<RoomHub["pendingApprovals"]>` in `src/main.ts`.

## Error Handling

**`RfaError` class** from `src/errors.ts` — thrown for all RFA tool-plane errors; carries `code`, `message`, `retry_after_s`, `data`. Used in `interop/rfa_min.py` as the Python equivalent.

**`send(res, status, data, headers?)` helper** in `src/main.ts` — all HTTP error responses go through this; never writes directly to `res` in workbench routes.

**`try/catch` with `(err as Error).message`** — consistent cast pattern: `console.error(`rfa-hub: ${(err as Error).message}`)` (in `src/main.ts`).

**Observability must never break serving** — `catch { /* observability must never break serving */ }` in the OTel exporter in `src/main.ts`; same pattern in `touchLock`.

**`die()` helper in scripts** — `scripts/new-agent.ts` defines `function die(message: string, ...rest: string[]): never` that logs and calls `process.exit(2)`.

**`process.exit(1)` on hub startup failure** — `RoomHub` constructor wrapped in `try/catch` in `src/main.ts`; exits 1 with the error message.

**`flushAuthWindow` on process exit** — `process.on("exit", () => flushAuthWindow())` uses synchronous `appendFileSync` because only synchronous work runs in `exit` handlers (noted in `src/main.ts`).

## Testing Patterns

**Node built-in test runner** — `"test": "node --import tsx --test test/*.test.ts"` in `package.json`; glob picks up any new `*.test.ts` file automatically.

**In-memory hub for unit tests** — `scripts/demo.ts` uses `new RoomHub({ dataDir: null })` with `InMemoryTransport` from the MCP SDK.

**`spawnTsx` + `stopTree` for process-based tests** — `scripts/e2e.ts` imports `{ spawnTsx, stopTree }` from `src/proc.ts`; never uses `npx` directly.

**`Promise.allSettled` for race scenarios** — `scripts/e2e.ts` uses `await Promise.allSettled([call(...claim...), call(...claim...)])` to test atomic claim races.

**`assertRejectsCode` helper** — used in `scripts/e2e.ts` to assert a specific RFA error code is thrown (e.g. `assertRejectsCode(..., "bad_request")`, `assertRejectsCode(..., "join_denied")`).

**Eval gate:** `evals/baseline.json` stores `{ gate: { k: 4, band: 0.15 }, cases: { ... } }`; runner is `src/evals/runner.ts` invoked via `npm run evals`.

**Parity gate:** `dogfood/parity.ts` — run twice (`npx tsx dogfood/parity.ts`); checks `must_mention` substrings and citation presence against live resident answers.

## Logging & Observability

**`console.error` for all hub operational output** — startup banners, OTel span lines, push errors, drain notices all go to stderr via `console.error(...)` (in `src/main.ts`).

**OTel span naming:** `rfa.{tool_name}` — e.g. `rfa.room_listen`, `rfa.room_send`; attributes `rfa.room`, `rfa.member`, `rfa.seq`, `rfa.error_code`, `rfa.gate_verdict`, `rfa.gate_check` (in `src/main.ts` exporter).

**`rfa.room_listen` excluded from obs.db** — `if (obsStore && s.name !== "rfa.room_listen")` in the OTel exporter; long-polls dominate volume with no diagnostic value when healthy.

**Auth log:** `data/auth.log.ndjson` (0600) — hash-chained, one aggregated row per 5-minute window; written with `appendFileSync` at mode `0o600`; `flushAuthWindow()` called on `process.on("exit")` (in `src/main.ts`).

**Obs store:** `ObsStore` from `src/obs.ts` — SQLite at `data/obs.db`; lazily initialized via `obs()` helper in `src/main.ts`; supports `record()`, `feedback()`, `markReview()`, `trace()`, `runs()`, `summary()`.

**Session TTL:** `SESSION_TTL_MS = 12 * 3600_000` (12 hours, sliding on authenticated requests) — defined in `src/main.ts`.

## State Management

**Exclusive data-dir lock:** `data/.hub.lock` — acquired with `O_EXCL` in `acquireLock()` in `src/store.ts`; heartbeated every `LOCK_HEARTBEAT_MS` (10s); stale after `LOCK_STALE_MS` (60s). `serving()` checks `storeLost` flag set by `touchLock()`.

**NDJSON event log per room:** `data/rooms/<room>.ndjson` + `meta.json` — written by `RoomHub` in `src/store.ts`; 0600 mode on meta files.

**Transport credential resolution:** `transportToken()` in `src/secrets.ts` — reads `RFA_TOKEN` per call, never captured at import; used by `dogfood/parity.ts` and scripts.

**Supervisor commands:** `data/supervisor-commands.ndjson` — lifecycle actions (`start`/`stop`/`restart`) appended by the workbench `POST /api/agents/:name/lifecycle` route in `src/main.ts`.

**Agent heartbeat:** `agents/<name>/state/heartbeat` — file containing a ms timestamp; read by `agentStatus()` in `src/main.ts` to compute `heartbeat_age_s`.

**`void push(...)` fire-and-forget** — push notifications use `void push(...)` in `watchCards()` in `src/main.ts`; errors are caught inside `push()` and logged, never propagated.

## Agent Pack Conventions

**`agent.md` front-matter** parsed by `parseAgentMd()` in `src/agentdef.ts` — required keys: `rfa_agent: 1`, `name`, `description`; common keys: `model`, `tools`, `offers`, `secrets`, `budgets`, `rooms`, `memory`, `sandbox`, `effort`, `interrupt_on`.

**`secrets` must declare `RFA_TOKEN` and `RFA_JOIN_SECRET`** — enforced by convention in `scripts/new-agent.ts`; omitting either produces opaque auth errors at runtime.

**Pack directory structure** (written by `scripts/new-agent.ts`):
- `agent.md` — definition + system prompt
- `knowledge/` — markdown files reached with Read/Grep
- `memory/blocks/` — core memory rendered into prompt every turn (e.g. `persona.md`)
- `memory/notes/` — longer notes written and re-read on demand
- `memory/MEMORY.md` — index whose first 40 lines load at session start
- `skills/<name>/SKILL.md` — procedure files read when task matches
- `evals/cases/<name>-01/case.yaml` — eval case stub
- `state/` — runtime, gitignored

**Lifecycle scripts** (never hand-roll): `npm run new-agent -- <name> [--kind tool]`, `npm run retire-agent -- <name>`, `npm run sync-handbook`.

## Inconsistencies

**`arg()` vs `process.env` for config:** CLI flags win over env vars for most options (`--mcp-token` wins over `RFA_MCP_TOKENS`, `--human-key` wins over `RFA_HUMAN_KEYS`), but the pattern is stated as a preference rather than enforced uniformly — `RFA_PUSH_URL` and `RFA_CONSOLE_URL` are env-only fallbacks with no flag priority comment. Dominant: flag-wins-over-env.

**`interface` vs `type` for object shapes:** `src/store.ts` uses `interface` for all major shapes (`HubConfig`, `Member`, `Room`), but `type` for some internal shapes (`GateOutcome`, `Filter`, `AuthOutcome`). Dominant: `interface` for exported/major shapes, `type` for unions and aliases.

**`console.error` vs structured logging:** all operational output uses `console.error` (stderr); no structured JSON logging in the hub process itself. The obs store (`data/obs.db`) is the structured record for tool-call spans. Dominant: `console.error` for process output.