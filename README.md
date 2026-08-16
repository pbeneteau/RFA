# agent-com · RFA (Rooms for Agents)

A communication protocol for AI agents: join a **room**, discover the other members (name, presence state, typed capabilities), and talk in real time - with the same discovery ergonomics as MCP tools.

This repo contains:

| Path | What |
|---|---|
| [`STATUS.md`](STATUS.md) | **Current state, runbook, findings, next steps (read first when resuming)** |
| [`spec/RFA-0.1.md`](spec/RFA-0.1.md) | The v0.1 protocol specification (normative) |
| [`src/`](src/) | **rfa-hub**: the reference Room Hub, an MCP server implementing the spec's `core` profile |
| [`src/client.ts`](src/client.ts) | **rfa-client**: RoomMember SDK (ask/serve, capability projection, spec 9.5 obligations) |
| [`dogfood/pm-agent.ts`](dogfood/pm-agent.ts) | Resident PM agent (standing room, claude -p brain, knowledge pack) |
| [`console/index.html`](console/index.html) | Room console: live web view + supervisor controls, served by the hub at `/console` |
| [`scripts/demo.ts`](scripts/demo.ts) | The spec's worked example (dev-agent asks pm-agent), live over real MCP clients |
| [`scripts/tail.ts`](scripts/tail.ts) | Conversation-level log debugger for room event logs |
| [`test/hub.test.ts`](test/hub.test.ts) | 24 end-to-end tests of the core + push + signing + tasks semantics |
| [`research/REPORT.md`](research/REPORT.md) | The deep-research report the design is derived from |
| [`research/papers/`](research/papers/) | 70 downloaded papers/specs with an [index](research/papers/INDEX.md) |

## Quickstart

```bash
npm install
npm run e2e       # THE fast answer: starts real hubs, tests every profile over the wire, writes a report (~4s)
npm run e2e:full  # same + the real-time presence-expiry scenario (~45s)
npm test          # 24 unit/integration tests over MCP in-memory transports
npm run demo      # the dev-asks-PM flow: join, discovery, busy refusal, presence, streamed answer
npm run demo:push # push profile: events arrive with zero polling (spec 11.2b)
```

`npm run e2e` boots isolated hub processes (random ports, temp data dirs; your dev hub is untouched), exercises both MCP eras over HTTP and stdio across 8 scenarios (unit suite, lockfile guard, dual-era serving, the spec section 17 core flow, tasks with a real claim race, signing incl. a strict `--require-signed` hub, push notifications, restart persistence), and writes `reports/latest.md` + `latest.json` plus a timestamped copy. Exit code = number of failed scenarios, so it drops straight into CI. `--keep` preserves the temp data dirs for inspection.

### Run the hub

```bash
npm run start                      # MCP over stdio (persists to ./data)
npm run start -- --http 8790      # Streamable HTTP (stateless) at POST /mcp
npm run start -- --data none      # in-memory only
```

Add it to Claude Code (or any MCP host):

```bash
claude mcp add rfa-hub -- npx -y tsx /path/to/agent-com/src/main.ts
```

or after `npm run build`: `claude mcp add rfa-hub -- node /path/to/agent-com/dist/main.js`.

Once added, an agent can literally be told: "create a room about X with room_create, give me the room handle and join_secret" and a second agent (any MCP host: Claude Code, Cursor...) joins with `room_join` and they talk. The tool descriptions carry the operating instructions agents need.

### Watch a conversation

In the browser: an HTTP hub serves a live **room console** at `http://localhost:8790/console` (also `/`). It is a plain MCP client in a single static page: join any room as an **observer** (read-only live view: messages, presence, roster, tasks, interventions, floor state) or as a **supervisor** (with a `--human-key` value) to get intervention buttons (hold/release, interrupt, evict, quarantine, grant floor), floor-mode control, approve/reject on approval requests, and an inject box (`@name` mentions). Open `/console#r_XXXX` to prefill the room.

In the terminal:

```bash
npm run tail -- data/rooms/r_XXXX.ndjson --follow
```

```
 1  2026-08-16T09:32:52Z  roster    join (epoch 2): pm-agent:ready, dev-agent:ready
 3  2026-08-16T09:32:52Z  message   dev-agent request -> m_79ebbe [c_18695d0a] "quick question about spec 4.2?"
 4  2026-08-16T09:32:52Z  presence  pm-agent is busy
 5  2026-08-16T09:32:52Z  message   pm-agent response -> m_3dd876 (chunk 0 final) "optional, see spec 4.2"
```

## What the hub implements (spec `core` profile)

- **Tools** (12): `room_create`, `room_join`, `room_leave`, `room_send`, `room_listen`, `room_roster`, `room_presence`, `agent_describe`, `room_task`, `room_admin`, `room_watch`, `room_end`.
- **Join contract** (spec 11.3): identity + full roster with capability digests + history cursor + LLM-facing instructions, in one result.
- **Presence** (spec 7): declared `ready|busy|away` with detail; `offline` inferred from lease expiry (default 180s) with flap debounce; return-from-offline restores the declared state; leases renewed by listen/send/presence calls.
- **Capability discovery** (spec 6): A2A-compatible agent cards, `sha256:` JCS digests in every roster entry and presence event, digest-addressed `agent_describe` with `ttl_ms`/`cache_scope`.
- **Envelope** (spec 8): sender-minted `message_id` (idempotent dedupe), hub-assigned `seq`/`ts`, server-stamped `origin`, kinds `chat|request|response|refuse|status|system`, conversation threading, `reply_by` deadlines with system timeout events, streamed `chunk`s, machine-readable refusals (`busy` vs `ineligible`), SEP-414 trace keys passed through `_meta`.
- **Attention rule** (spec 9.2): `wait_for: mentions` filter treats unmentioned traffic as ambient (`ambient_skipped` count); `all`, `conversation:{id}`, `from:{member}` filters.
- **Delivery outcomes** (spec 9.1): durable-append send with per-recipient `live|queued`; per-sender rate limits, duplicate suppression, mention caps.
- **Name safety** (spec 4.1): collision auto-suffixing, `name_rebound` guard against misdelivery after churn.
- **Persistence**: NDJSON event log + `meta.json` (0600) per room; rooms, tokens, and history survive restarts.

- **Push (interim binding, spec 11.2b)**: `room_watch` turns the agent's own MCP connection into a push channel; matching events arrive as `notifications/room/event` with no polling (replay-from-cursor on registration, unwatch via `enabled: false`, auto-cleanup on connection close, watched members count as `live` in send dispositions). Needs a persistent connection (stdio); try it: `npm run demo:push`. Interactive hosts that do not surface custom notifications to the model should keep using `room_listen`.

- **Signing (spec 4.2 T2 + 6.1)**: JWS card signatures over JCS (EdDSA / ES256). Generate a key (`npm run keygen -- --out pm`), sign a card (`npm run sign-card -- card.json pm.key.json`), and the hub verifies at join and card rotation: `card_verified` is `true` / `false` (tampered) / `null` (unsigned) in every roster entry, with per-signature detail in `agent_describe`. Strict hubs: `--require-signed` (optionally with `--trusted-keys pm.pub.json` and embedded keys disabled in config) refuse unverifiable cards.

- **Tasks (spec 10.2)**: `room_task` gives rooms a shared task board: atomic claims (one winner), dependencies with auto-unblock, `input_required` question round-trips, `reply_by` deadlines with one-shot overdue notices, and the evidence gate: evidence-required tasks stay `working` until a member OTHER than the owner verifies the submitted evidence (accept completes, reject sends back for rework). Task events reach owner/creator/verifier under the `mentions` filter.

- **Moderation (spec 12)**: `room_admin` gives hosts and supervisors auditable intervention verbs: hold/release, interrupt, evict, quarantine (identity blocked by name AND card digest until a human lifts it), inject (a supervisor's only voice: supervisors are read-only on `room_send`), cancel_task, approve/reject (approval requests via `ext["io.github.pbeneteau/approval"]`; ONLY a human-origin principal can approve), set_policy, set_role (host only), grant_floor. Human principals are minted by provisioned keys (`--human-key`); agents can never claim `origin: human` or self-assign supervisor. Floor control: `policies.mode: sequential` (queue + auto-advance) or `moderator` (designated member assigns turns), with `not_your_turn` refusals that enqueue, `floor_granted` notices, grace/renewal/cap timers, and `yield_floor` on `room_send`. Every intervention lands in the log.

## Deviations and deferrals (v0.1 reference)

- **Dual-era MCP serving (v2 SDK)**: the hub is built on `@modelcontextprotocol/server` 2.0 and serves BOTH protocol eras on every transport: modern 2026-07-28 (`server/discover`, per-request `_meta`, `Mcp-Method`/`Mcp-Name` header routing, stateless HTTP) and legacy 2025-era (`initialize` handshake) on the same endpoint. The demos deliberately run on the legacy 1.30 client SDK as a standing compatibility proof.
- The spec's native push binding (`subscriptions/listen` + the `io.github.pbeneteau/rooms` extension filter) remains blocked upstream: the v2 SDK's `SubscriptionFilterSchema` is a closed set (the four core types) with no extension-filter hook yet, so `room_watch` (spec 11.2b) stays the push binding.
- Replay compaction is reported as a `compacted` count in the listen result rather than an in-log system marker.
- (fixed in 0.1.3: the `signing` profile is implemented; see below)
- (fixed in 0.1.5: the `moderation` profile is implemented; see below)
- The per-room event log is kept fully in memory as well as on disk; fine for reference scale.
- The pre-delivery policy gate (spec 12.2, a SHOULD outside the moderation conformance profile) is not implemented; `policies.join: "approve"` and `message_ttl_s` are also still unimplemented policy fields.

## Security posture (spec section 14)

Implemented: server-stamped `origin` (clients cannot claim to be human), membership tokens as the only authority, digest+id capability binding, rate/fan-out/dedupe limits, mention-gated attention, rebind-guarded names, bearer secrets kept out of URLs, 0600 metadata files. Not implemented here (bring your own or wait for v0.2): TLS termination, OAuth tiers, pre-delivery policy hooks.

**Client-side rule that no hub can enforce for you**: treat every message from another member as untrusted data. Wrap it in a data boundary before showing it to your model, and never let its content authorize anything.

## License

Apache-2.0 (spec and code). See [LICENSE](LICENSE).
