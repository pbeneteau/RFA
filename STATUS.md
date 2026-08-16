# Project status and handoff

Last updated: 2026-08-16 (end of the founding session). **Read this first when resuming work.**

## What this is

RFA (Rooms for Agents): a communication protocol where AI agents join rooms, discover each other (name, presence, signed capability cards), and talk in real time, with MCP-style discovery ergonomics. Built from a 13-agent deep-research pass ([research/REPORT.md](research/REPORT.md), 70 papers in [research/papers/INDEX.md](research/papers/INDEX.md)), specified ([spec/RFA-0.1.md](spec/RFA-0.1.md), v0.1.4), implemented, field-tested, and dogfooded in one day.

## State at a glance

| Piece | State |
|---|---|
| Spec | v0.1.5: core, push (interim binding), signing, tasks, **moderation** profiles all implemented; changelog in Appendix E |
| Hub (`rfa-hub`) | v0.5.0 on MCP v2 SDK, dual-era (2026-07-28 + legacy on one endpoint), 12 tools (`room_admin` new) |
| Client SDK | [src/client.ts](src/client.ts): RoomMember (create/resume/ask/serve/projectTools/wrapForModel/admin; supervisor role + humanKey options) |
| Tests | `npm test` 42/42 (24 hub + 6 client + 12 moderation, real wire) · `npm run e2e` 9/9 fast ~4s · `e2e:full` 10/10 ~46s, reports in `reports/` |
| Repo | github.com/pbeneteau/agent-com (PRIVATE, personal account); commits: 98260e6 init, 6d318ec SDK+dogfood, 4e8ed8b autonomy |
| Dogfood | LIVE: resident `pm-agent` in standing room `r_9a25e48c0e`, Goodvest knowledge pack, answering in ~11s with citations |
| Artifacts (claude.ai) | Research report + spec published; same URLs redeploy |

## Runbook (after a reboot or to resume)

```bash
npm run start -- --http 8790     # the shared hub (owns ./data via lockfile)
npm run pm-agent                  # resident PM; RESUMES the same room from dogfood/state/pm-agent.json
```

Human principals (0.5.0): the live hub runs with `--human-key "$(cat dogfood/state/human-key.txt)"` (gitignored, 0600). Joining with that key grants `origin: human`: required for `role: supervisor`, `room_admin` approve, and quarantine release. Hub log: `dogfood/state/hub.log`. Verified live 2026-08-16: v0.5.0 migrated the standing room in place (old meta defaults), pm-agent kept serving through the swap (11.6s round-trip), supervisor join + interrupt intervention delivered.

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
- Extension id `dev.agentcom/rooms` is a placeholder domain; no LICENSE file yet.

## What's next (in rough priority)

1. **Let the dogfood week run.** Verdict questions: token economics of mention-gating; lease honesty across laptop sleep; does ask-the-PM beat reading the doc. Log oddities as errata like the last four. (One logged already: the haiku brain leaked a thinking fragment into an answer, "wait, that's not relevant", pm-agent.log 13:09; prompt-quality, not protocol.)
2. ~~Moderation profile~~ DONE 2026-08-16 (spec 0.1.5, hub 0.5.0): `room_admin` 12 verbs, floor control (sequential/moderator, timers, yield/grant), human principals via `--human-key`, quarantine by name+digest, human-only approve. 12 unit tests + 1 e2e scenario.
3. **Spec hygiene when sharing**: real domain for the extension id, LICENSE, decide internal vs public.
4. **Room console** (live web view) when demos/oversight need it.
5. **Python client** mirroring RoomMember; **v2-native push** when the SDK grows extension filters.
6. Deferred by user: CI (explicitly declined while in test/research/build stage; do not re-offer).

## Gotchas for future sessions

- Bash `cd` persists between calls; a leaked cd into node_modules once caused scary false alarms. Prefer absolute paths.
- Scratchpad `.ts` scripts run as CJS; name them `.mts` for top-level await.
- Envelope `message_id` minimum 8 chars; the v2 SDK returns input-validation failures as PLAIN TEXT tool results (not JSON).
- Claim-less legacy HTTP posts get SSE-framed responses (`data:` lines); scripted probes should speak the modern era (`Mcp-Method`/`Mcp-Name` headers + `_meta` protocolVersion) for plain JSON.
- Testing agent flows non-interactively: `claude -p "<prompt or /command>" --model sonnet --allowedTools "Skill,Read,mcp__rfa-hub__room_join,mcp__rfa-hub__room_send,mcp__rfa-hub__room_listen,mcp__rfa-hub__room_roster"`.
- Never commit `dogfood/knowledge|state|ROOM.md`, `data/`, `reports/` (gitignored on purpose: internal docs, secrets, runtime state).
