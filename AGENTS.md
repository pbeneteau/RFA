# AGENTS.md

> Context for AI coding agents working in agent-com (rfa-hub). Generated and kept current by Kontrua; verified against the code on every update. Human-oriented docs: see README.md.

## Project

Reference hub implementation for RFA (Rooms for Agents): a protocol for AI agent discovery, presence, capability cards, and real-time messaging over MCP. Audience is organizations self-hosting a hub with local and remote agent members — not a single-user tool. Read `STATUS.md` before resuming any work; it holds current state, runbook, and next steps.

Active specifications (all four in force):
- `spec/RFA-0.1.md` — wire protocol 0.1.8 (draft); Appendix F is the implementation-status table
- `spec/RFA-0.4-platform.md` — platform layer (agent packs, engine, memory, sandboxes, observability, evals, console)
- `spec/RFA-0.5-platform.md` — v0.5 amendments; Section 22 is the single merged build ladder for v0.5 and v0.6
- `spec/RFA-0.6-remote.md` — v0.6 remote peers; depends on 0.1.8 and RFA-0.5

## Structure

| Path | Purpose |
|------|---------|
| `src/` | Hub, store, engine, supervisor, resident, client, secrets, obs, evals |
| `src/evals/` | Eval runner, judge, trajectory |
| `scripts/` | CLI utilities (ask, keygen, new-agent, retire-agent, verify-log, etc.) |
| `test/` | Unit tests — glob `test/*.test.ts`, 210 tests |
| `spec/` | Authoritative RFA specifications |
| `agents/` | Agent pack definitions (`agent.md` per agent) |
| `evals/` | Eval cases, rubric, baseline |
| `deploy/` | launchd plists, gate config, install script |
| `console/` | Self-contained browser console (`index.html`) |
| `interop/` | Minimal Python interop reference (`rfa_min.py`) |
| `dogfood/` | Parity test (`parity.ts`) for brain/knowledge changes |
| `research/` | Research reports and notes (01–04); treat wave 02–03 justifications as suspect (retired single-user assumption) |

## Setup & Commands

Commands are quoted verbatim from `package.json`.

| Task | Command | Working dir |
|------|---------|-------------|
| Build | `tsc` | repo root |
| Start hub (stdio) | `tsx src/main.ts` | repo root |
| Start hub (HTTP) | `tsx src/main.ts --http 8790 --allow-origin <origin>` | repo root |
| Unit tests | `node --import tsx --test test/*.test.ts` | repo root |
| E2E (wire scenarios) | `tsx scripts/e2e.ts` | repo root |
| E2E full | `tsx scripts/e2e.ts --full` | repo root |
| Evals (reliability gate) | `tsx src/evals/runner.ts` | repo root |
| Evals judged | `tsx src/evals/runner.ts --judged` | repo root |
| Parity check | `npx tsx dogfood/parity.ts` | repo root |
| New agent | `tsx scripts/new-agent.ts -- <name> [--kind tool]` | repo root |
| Retire agent | `tsx scripts/retire-agent.ts -- <name>` | repo root |
| Sync handbook | `tsx scripts/sync-handbook.ts` | repo root |
| Start supervisor | `tsx src/supervisor.ts` | repo root |
| Start PM agent | `tsx src/resident.ts --agent pm-agent` | repo root |
| Keygen | `tsx scripts/keygen.ts` | repo root |
| Sign card | `tsx scripts/sign-card.ts` | repo root |
| Verify log | `tsx scripts/verify-log.ts` | repo root |
| Ask CLI | `tsx scripts/ask.ts` | repo root |
| Init | `tsx scripts/init.ts` | repo root |

`npm test` = `node --import tsx --test test/*.test.ts`. `npm run e2e` writes `reports/latest.md`.

## Environment

Required environment variable names (never values):

- `RFA_TOKEN` — transport credential; read per call in `src/secrets.ts:transportToken()`, never captured at import
- `RFA_JOIN_SECRET` — room join secret for agent packs; must appear in `secrets` of every pack definition
- `RFA_HUMAN_KEYS` — comma-separated provisioned human-principal keys (also `--human-key` flag)
- `RFA_MCP_TOKENS` — comma-separated operator bearer tokens for `/mcp` transport auth (also `--mcp-token` flag); default off
- `RFA_PUSH_URL` — notification-only webhook URL for approval-card events (also `--push-url`)
- `RFA_CONSOLE_URL` — public base URL for push notification links (also `--console-url`)

## Code Style & Conventions

- TypeScript ESM (`"type": "module"`, `tsconfig.json`); import with `.js` extensions in source
- All child processes via `src/proc.ts:spawnTsx` + `stopTree` — never `npx tsx` directly (see Gotchas)
- Transport credential always resolved through `src/secrets.ts:transportToken()` at call time
- Agent lifecycle always scripted (`npm run new-agent`, `npm run retire-agent`, `npm run sync-handbook`) — never hand-rolled
- One knowledge fact in exactly one file; check for duplicates before adding a source
- `src/principals.ts:constantTimeMatch` for all credential comparisons (shared by wire join path and `/auth`)

## Testing

- Unit tests: `node --import tsx --test test/*.test.ts` — any new `test/*.test.ts` file is picked up automatically
- E2E wire scenarios: `tsx scripts/e2e.ts` — output in `reports/latest.md`
- Parity (brain/knowledge changes): `npx tsx dogfood/parity.ts` — run **twice**; a single pass has hidden real regressions
- Evals reliability gate: `tsx src/evals/runner.ts` — pass^4, band 0.15, ~32 live trials, ~$2/run; budget one per day
- A baseline captured while the stack was unhealthy is vacuous; re-baseline after any incident

## Boundaries

- Do not force-add `dogfood/knowledge/`, `dogfood/state/`, `dogfood/ROOM.md`, `data/`, or `reports/` — gitignored intentionally (internal docs, secrets, runtime state)
- Do not spawn child processes with `npx tsx`; use `src/proc.ts:spawnTsx` + `stopTree`
- Do not hand-write agent packs; use `npm run new-agent` — missing `RFA_TOKEN` or `RFA_JOIN_SECRET` in `secrets` surfaces as opaque auth errors
- Do not infer feature absence from `spec/RFA-0.6-remote.md` section 12's status table — it was wrong for 10 of 15 rows for two days while features were shipped; check the code and use `npm run verify-log` + `/healthz`
- Do not infer enforcement from a MUST in the wire spec; the spec leads the code in several places (Appendix F is authoritative)
- The hub must own `data/rooms` and its lockfile exclusively; for shared use run one HTTP hub (`tsx src/main.ts --http 8790`)

## Gotchas

- **Long-lived processes serve old code.** Hub, supervisor, and residents all outlive an edit. After changing `src/`, restart what you are testing: residents via `data/supervisor-commands.ndjson`, supervisor and hub by hand. The exact hub command needs `--allow-origin` for the phone console.
- **`npx tsx x.ts` is three processes; SIGKILL cannot be forwarded.** Killing the `spawn` return leaves the real process running. 119 orphaned hubs holding 5.3 GB were found this way; a SIGKILLed resident kept serving its membership while a replacement started. Use `spawnTsx` + `stopTree` in `src/proc.ts`.
- **`transportToken()` in `src/secrets.ts` reads `RFA_TOKEN` per call.** The supervisor is also a hub client; it had no credential and its `#ops` alerts 401'd silently for a day.
- **Threshold-based alerts hide total outages.** The `#ops` triad requires 5 runs before calling an error rate bad; an expired credential failing 100% of 1 run raised nothing for hours. Rates need volume guards; states need a direct check.
- **`/mcp` has no hard lockout by design.** A per-source lock on `/mcp` stops all agents (every local request arrives as `127.0.0.1` through the loopback proxy). Failures are rate-limited with a delay instead. `/auth` retains its lockout (human-paced, survivable).
- **Evals: one run is ~$2.** Budget one per day. `npm run evals` prints its measured flake rate.
- **Parity must run twice.** `npx tsx dogfood/parity.ts` — a single pass has hidden a real regression.
- **Duplicate knowledge sources cause phantom eval flakes.** One knowledge fact must live in exactly one file; attaching a new source without removing what it superseded produced duplicate pages and cost a day chasing a phantom eval flake.
- **`/mcp` transport auth is off by default.** With no `--mcp-token`/`RFA_MCP_TOKENS` configured, `/mcp` is unauthenticated and `src/client.ts` sends no `Authorization` header. Turning tokens on requires every client (residents, ask CLI, console, eval harness) to carry a bearer.
- **`spec/RFA-0.5-platform.md` Section 22** is the single merged build ladder for v0.5 and v0.6 — consult it for implementation sequencing.