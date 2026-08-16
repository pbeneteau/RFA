# Project status and handoff

Last updated: 2026-08-16 (founding day + the platform pivot). **Read this first when resuming work.**

## What this is

RFA (Rooms for Agents): a communication protocol where AI agents join rooms, discover each other (name, presence, signed capability cards), and talk in real time, with MCP-style discovery ergonomics. Built from a 13-agent deep-research pass ([research/01-protocol/REPORT.md](research/01-protocol/REPORT.md), 70 papers), specified ([spec/RFA-0.1.md](spec/RFA-0.1.md)), implemented, field-tested, and dogfooded in one day.

**Direction since 2026-08-16 evening (owner decision): the platform pivot.** The protocol is the substrate; the product is a personal agent platform for daily Goodvest work: capable resident agents (tools, skills, memory, per-agent model/effort), an engine, sandboxes, observability, governance + budgets, evals, a workbench. Evidence: [research/02-platform/REPORT.md](research/02-platform/REPORT.md) (11-dimension sweep anchored on LangChain deep agents). Normative design: [spec/RFA-0.4-platform.md](spec/RFA-0.4-platform.md) with the v0.4.0-v0.4.6 build path. Core verdict: adopt the industry's schemas, reject its platforms; the Claude Agent SDK is the runtime.

## State at a glance

| Piece | State |
|---|---|
| Spec | Protocol v0.1.6: every profile implemented (core, push interim, signing, tasks, moderation); extension id `io.github.pbeneteau/rooms`; Apache-2.0. **Platform v0.4.0 draft: [spec/RFA-0.4-platform.md](spec/RFA-0.4-platform.md), not yet implemented** |
| Hub (`rfa-hub`) | v0.6.0 on MCP v2 SDK, dual-era (2026-07-28 + legacy on one endpoint), 12 tools (`room_admin`) + room console at GET /console + **OTel spans per tool call** (`--otel` for the built-in stderr exporter) |
| Client SDK | [src/client.ts](src/client.ts): RoomMember (create/resume/ask/serve/projectTools/wrapForModel/admin) + **sanitizeForMemory / MemoryGate** (Morris-II replication defense; wired into pm-agent's conversation memory) |
| Tests | `npm test` 48/48 (24 hub + 6 client + 12 moderation + 5 memory + 1 otel) · `npm run e2e` 9/9 fast ~4s · `e2e:full` 10/10 ~46s, reports in `reports/` |
| Repo | github.com/pbeneteau/agent-com (PRIVATE, personal account); commits: 98260e6 init, 6d318ec SDK+dogfood, 4e8ed8b autonomy |
| Dogfood | LIVE: resident `pm-agent` in standing room `r_9a25e48c0e`, Goodvest knowledge pack, answering in ~11s with citations |
| Artifacts (claude.ai) | Research report + spec published; same URLs redeploy |

## Runbook (after a reboot or to resume)

```bash
npm run start -- --http 8790 --human-key "$(cat dogfood/state/human-key.txt)" --otel   # the shared hub (owns ./data)
npm run supervisor                # spawns + restarts every resident from agents/*/agent.md (v0.4.0)
```

Residents live in `agents/<name>/` (agent.md definition + knowledge + state); the supervisor watches definitions and does a versioned drain on edit (the room sees the digest rotation). `npm run pm-agent` still runs the pm resident directly (no supervisor). Logs: `dogfood/state/supervisor.log`, `agents/pm-agent/state/resident.log`. Optional boot persistence: `deploy/install.sh` installs launchd agents for hub + supervisor (NOT auto-installed; stop the nohup processes first). Brain changes must pass the parity gate: `npx tsx dogfood/parity.ts` (baseline via `--capture`; fixtures in `dogfood/state/parity.json`).

Human principals (0.5.0): the live hub runs with `--human-key "$(cat dogfood/state/human-key.txt)"` (gitignored, 0600). Joining with that key grants `origin: human`: required for `role: supervisor`, `room_admin` approve, and quarantine release. Hub log: `dogfood/state/hub.log`. Verified live 2026-08-16: v0.5.0 migrated the standing room in place (old meta defaults), pm-agent kept serving through the swap (11.6s round-trip), supervisor join + interrupt intervention delivered.

Room console: `http://localhost:8790/console#r_9a25e48c0e`. Observer = read-only live view; supervisor (human key) = intervention buttons, floor control, approve/reject, inject. Includes the live agent graph (canvas: members on a circle, kind-colored message pulses, decaying communication edges, task dots pool->owner->fade, ripples for presence/floor/interventions/gone_quiet; reduced-motion aware; toggle in the header). Verified live in a real browser 2026-08-16: history replay, live long-poll stream, inject with @mention (the pm-agent even answered the injected chat and correctly refused it as out-of-scope), interrupt button round-trip, and the graph animating a full scripted lifecycle (ping/pong edges, task claim flight + completion fade, PM ask/response pulses, clean re-layout after leaves).

- Claude Code MCP registration (project-local): `rfa-hub` over HTTP at `http://localhost:8790/mcp` (stdio would lock-conflict with the running hub).
- Ask the PM: `/ask-pm <question>` (human shortcut) · sessions consult autonomously via the `consult-room` skill · SDK agents via `projectTools()`.
- Watch a room: `npm run tail -- data/rooms/<room>.ndjson --follow`.
- Room join info (handle + secret): `dogfood/ROOM.md` (gitignored).
- Knowledge pack: `dogfood/knowledge/**` (gitignored; Goodvest handbook exports + spec + README). Refresh by re-exporting handbook pages; the agent re-reads files on every answer.

## Findings ledger (evidence, not vibes)

- **4 real bugs found by live multi-agent testing, all fixed with regression tests** (none found by unit tests alone): `gone_quiet` unreachable by askers; explicit `ttl_s` could not shorten a lease; reply_by deadlines lost across hub restarts; plus the data-dir split-brain hazard (now a loud lockfile failure).
- **Presence detection ladder**: 13 min (blind polling, round 1) -> 41s (lease inference, verified live) -> ~1ms (room_watch push).
- **Answer latency** with haiku brain: ~11s typical, ~25s first/long answers. Wire overhead is milliseconds.
- **Dogfood product value on day one**: the PM agent flagged a real Goodvest handbook inconsistency (SCPI: 100k service threshold vs per-SCPI catalog minimums 5,000/300) and recommended human arbitration. Worth raising with the handbook owner.
- **Autonomy verified**: a session given a plain coding task (Goodlife form validation, zero mention of the room) consulted the PM by capability and used the answer.

## Known limitations and parked edges

- **Moderation implemented (0.1.5)** with three deliberate edges: the pre-delivery policy gate (spec 12.2, a SHOULD outside the conformance profile) is not implemented; `policies.join: "approve"` and `message_ttl_s` stay unimplemented; floor state is restart-transient by design. Human principals need the hub started with `--human-key <k1,k2>` (or `RFA_HUMAN_KEYS`); without one, `approve` and quarantine-release are impossible (that is the point).
- **Native push binding blocked upstream**: MCP v2 SDK's `SubscriptionFilterSchema` is a closed set (no extension-filter hook), so `subscriptions/listen` push waits on the SDK; `room_watch` (spec 11.2b) is the binding. Watch `McpHttpHandler.notify` as the future attachment point.
- `room_watch` needs a persistent connection (stdio); the stateless HTTP mode cannot push.
- Watchers/waiters are process-local (single-hub HA only); per-room event log fully in memory as well as on disk.
- `ask()` cannot run inside the same member's `serve()` loop (single loop owner; use a second member).
- Member already offline at boot with a pending reply gets no `gone_quiet` (deadline timeout covers it; deliberate).
- Extension id `io.github.pbeneteau/rooms` is a placeholder domain; no LICENSE file yet.

## What's next: the v0.4 platform build ([spec/RFA-0.4-platform.md](spec/RFA-0.4-platform.md) section 13 is the ladder)

1. ~~v0.4.0~~ **DONE 2026-08-16 night**: pm-agent runs on the Agent SDK (`src/resident.ts` generic runner, per-conversation session resume, knowledge via Read/Grep with auto-derived file hints, cost/turns recorded in every answer, MemoryGate kept); `agents/pm-agent/` pack + `src/agentdef.ts` (offers = explicit card skills, definition hash rotates the digest); `src/supervisor.ts` v0 (restart policy, heartbeat health, versioned drain verified live: edit -> drain -> respawn -> room announcement in <1s); `deploy/` launchd plists + install.sh (generated, not installed); parity gate `dogfood/parity.ts` passed 4/4 (it caught one real retrieval regression: haiku grepped the glossary instead of the product file; fixed with per-file retrieval hints; residual ~5% per-question flake is the v0.4.4 pass^k target, or bump the pack to sonnet). srt spike verdict: **resident-in-sandbox VIABLE** via `allowLocalBinding: true` (opens all loopback ports: mitigate with room secrets at the hub); port-scoped variant only works via the srt proxy (tool-in-sandbox fallback); package `@anthropic-ai/sandbox-runtime@0.0.73`, configs in the spike notes.
2. **v0.4.1** engine + memory v1 · **v0.4.2** governance (12.2 gate, approvals bridge, 3-layer budgets, secrets) + sandbox Tier 1 · **v0.4.3** observability (runs/feedback tables, panels, #ops alerts, retention + nightly backup) · **v0.4.4** evals (computed reward over room logs, baseline gate, promote-case flywheel) · **v0.4.5** workbench stages 2-6 with human_key session-token auth + handoff verb · **v0.4.6** the first real workload: `linear-scribe` + `rfa ask` CLI + Slack channel.
3. **The dogfood week keeps running underneath**: token economics of mention-gating; lease honesty across laptop sleep; ask-the-PM vs read-the-doc. Errata so far: the haiku thinking-fragment leak (pm-agent.log 13:09); standing rooms accumulate dead memberships (evicted 6 by hand 2026-08-16 evening; a `member_expiry_days` policy is a v0.2-protocol candidate).
4. Older protocol-tier items, parked behind the platform build: Python client; v2-native push (blocked upstream); T1 OAuth; framework adapters + card-URL join. Handoff moved INTO the v0.4 plan (spec 0.4 section 4.4). **Internal vs public remains Paul's decision.**
5. Deferred by user: CI (explicitly declined while in test/research/build stage; do not re-offer).

## Gotchas for future sessions

- Bash `cd` persists between calls; a leaked cd into node_modules once caused scary false alarms. Prefer absolute paths.
- Scratchpad `.ts` scripts run as CJS; name them `.mts` for top-level await.
- Envelope `message_id` minimum 8 chars; the v2 SDK returns input-validation failures as PLAIN TEXT tool results (not JSON).
- Claim-less legacy HTTP posts get SSE-framed responses (`data:` lines); scripted probes should speak the modern era (`Mcp-Method`/`Mcp-Name` headers + `_meta` protocolVersion) for plain JSON.
- Testing agent flows non-interactively: `claude -p "<prompt or /command>" --model sonnet --allowedTools "Skill,Read,mcp__rfa-hub__room_join,mcp__rfa-hub__room_send,mcp__rfa-hub__room_listen,mcp__rfa-hub__room_roster"`.
- Never commit `dogfood/knowledge|state|ROOM.md`, `data/`, `reports/` (gitignored on purpose: internal docs, secrets, runtime state).
