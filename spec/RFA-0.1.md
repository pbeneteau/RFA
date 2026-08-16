# RFA: Rooms for Agents

**Protocol specification, version 0.1.4 (draft)**
Status: Draft for implementation · Date: 2026-08-16 (0.1.1 errata same day, from live multi-agent field testing; see Appendix E) · License: intended Apache-2.0
Wire tag: `"rfa": "0.1"` · MCP extension id: `dev.agentcom/rooms` (replace with your final domain before publishing)

RFA lets AI agents join a shared **room**, discover the other members (name, presence state, typed capabilities), and exchange messages in real time, with the same discovery ergonomics as MCP tools. It is a **layer beside MCP, not a rival protocol**: a Room Hub is an MCP server, agents are MCP clients, and every room action is an MCP tool call.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as in RFC 2119. JSON examples elide irrelevant fields.

---

## 1. Design principles

Each principle traces to evidence gathered in [research/REPORT.md](../research/REPORT.md); the mapping is in Appendix C.

1. **Specify observable behavior only.** State machines, message sequences, and wire shapes. Never agent internals.
2. **The boring parts are the standard.** Join, naming, presence events, auth, errors, and delivery outcomes are normative, not left to implementations.
3. **Durable append is delivery.** A send succeeds when the room log write succeeds. Recipient wakefulness is a separate, observable concern.
4. **Membership is not presence.** The roster says who belongs; presence says who is awake. An offline agent is still a member.
5. **Presence is leased, never assumed.** Liveness expires naturally; crashed agents cannot look alive.
6. **Attention is mention-gated by default.** Broadcast exists, but unmentioned traffic is ambient context, not a turn. This is both the token-economics control and the prompt-infection control.
7. **A message from another agent is untrusted input.** Origin is server-stamped; message text never confers authority.
8. **Capability claims are attack surface.** Capabilities resolve by digest and member id, never by name alone.
9. **A minimal client does something useful in an afternoon.** Core profile is 6 tools; any MCP-speaking agent can join with zero SDK.
10. **LLM-legible.** Every schema is small JSON; every behavior is describable in the prose an agent reads.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Hub** | The server hosting rooms. Speaks MCP (tool plane) and optionally the RFA push extension and REST binding. |
| **Room** | A named, membership-scoped message log plus roster, presence, and policies. Identified by an opaque **room handle**. |
| **Member** | An identity admitted to a room. Has a stable **member id** (per membership), a unique-in-room **name**, a **role**, an **agent card**, and a **presence record**. |
| **Membership token** | Server-minted bearer secret returned by `room_join`; authenticates all subsequent calls for that membership. |
| **Roster** | The full list of members with presence records, stamped with the room **epoch**. |
| **Epoch** | Monotonic integer, incremented on every membership or role change (never on presence-only changes). |
| **seq** | Monotonic integer per room, assigned by the hub to every event in the room log. The replay cursor. |
| **Envelope** | The JSON shape of a message event (section 8). |
| **Agent card** | The member's capability descriptor (section 6), compatible with the A2A Agent Card schema. |
| **Digest** | Content hash of a member's capabilities document; travels with presence so capabilities are fetched at most once per unique version. |
| **Origin** | Server-stamped principal class of a message: `human`, `agent`, or `system`. |

---

## 3. Architecture

```
  dev agent (MCP client)          pm agent (MCP client)         human console
        |                               |                           |
        |  tools/call room_send         |  tools/call room_listen   |  observer/supervisor
        v                               v                           v
  +---------------------------------------------------------------------+
  |                            ROOM HUB (MCP server)                    |
  |                                                                     |
  |  Tool plane:  room_create/join/leave/send/listen/roster/presence... |
  |  Push plane:  MCP extension dev.agentcom/rooms over subscriptions/  |
  |               listen (2026-07-28 hosts); long-poll fallback (all)   |
  |  Per room:    append-only event log (seq) + roster (epoch)          |
  |               + presence leases + policies                          |
  +---------------------------------------------------------------------+
```

Two planes:

- **Tool plane (required).** All actions are MCP tool calls. Works on every MCP host, both protocol eras.
- **Push plane (optional).** For MCP 2026-07-28 hosts, the hub declares the `dev.agentcom/rooms` extension and pushes room events over the client's `subscriptions/listen` stream (section 11.2). Hosts without it poll with `room_listen`.

Hubs MUST target MCP 2026-07-28 semantics and SHOULD serve dual-era so 2025-11-25 hosts can join with poll-based presence. Hubs MUST NOT depend on MCP sessions (`Mcp-Session-Id`), sampling, elicitation, or roots. Cross-call state rides in **server-minted handles passed as ordinary tool arguments** (room handles, membership tokens, cursors), which keeps the hub horizontally scalable.

State model per room: one append-only event log (each entry has a `seq`), one roster (membership + presence, versioned by `epoch`), one policy object. Everything an agent can observe is derived from these three.

A hub instance MUST have exclusive ownership of its persistence store: two live hub processes over one store would keep independent seq/epoch state and interleave corrupt logs. Implementations MUST fail loudly on a contended store (e.g. a liveness-checked lockfile) and point operators at the shared topology (one network-reachable hub). (Added in 0.1.1 after a near-miss in field testing.)

---

## 4. Identity and authentication

### 4.1 Names and ids

- **Member id** (`m_` + opaque suffix, e.g. `m_7f3ka9`): minted by the hub at join, stable for the life of that membership, never reused within a room.
- **Name**: human-memorable, unique among *present* members of a room. Requested at join; on collision the hub MUST auto-suffix (`pm-agent` -> `pm-agent-2`) and return the assigned name. Names are UTF-8, 1-64 chars, matching `^[\p{L}\p{N}][\p{L}\p{N} _.-]*$`.
- Addressing accepts name or id. Names resolve at send time. If a name was rebound since the sender's last observed epoch (member left, another joined with the same name), the hub MUST reject the send with error `name_rebound` and include the current holder's id, unless the sender addressed by id. This prevents misdelivery after churn.

### 4.2 Authentication tiers

| Tier | Mechanism | Normative status | Intended span |
|---|---|---|---|
| T0 | Join secret (capability token in `room_join`) + membership token thereafter | MUST implement | Same team / trusted cluster |
| T1 | OAuth 2.1 client credentials at the MCP transport layer; RFC 8693 token exchange for on-behalf-of | SHOULD implement | Enterprise, cross-team |
| T2 | JWS-signed agent cards (JCS canonicalization, RFC 8785 + RFC 7515); per-message signature profile | Card signing SHOULD; message signing reserved for v0.2 | Cross-organization |

Rules that hold at every tier:

- The hub MUST mint a **membership token** at join and require it on every subsequent tool call (`membership_token` argument). Tokens MUST be unguessable, MUST be revocable (revocation = eviction takes effect on the next call and the next lease expiry), and SHOULD be short-lived with refresh.
- The hub MUST derive `origin` and `from` from the authenticated principal. A client-supplied `from` or `origin` field MUST be ignored.
- Agent principals MUST NOT be able to produce `origin: "human"`. Human consoles authenticate as human principals; hubs stamp accordingly.

---

## 5. Rooms

### 5.1 Creation

`room_create` mints a room and returns its handle. Policies fixed at creation (mutable only by the host/moderator):

```json
{
  "topic": "checkout-flow feature work",
  "policies": {
    "join": "open | invite | approve",
    "attention": "mentions | all",
    "mode": "open | sequential | moderator",
    "history_visibility": "member | joined_after",
    "message_ttl_s": null,
    "max_members": 32
  }
}
```

Defaults: `join: invite`, `attention: mentions`, `mode: open`, `history_visibility: member`.

### 5.2 Roles

Three roles, assigned at join or by the host afterward:

- **participant**: send + receive, discoverable, addressable.
- **observer**: authenticated read-only member. Receives all events; MUST NOT send `chat`/`request` messages; excluded from mention resolution and from capability discovery results. Visible in the roster by default (`silent_observer` policy flag MAY hide them; use with care and log it).
- **supervisor**: observer rights plus intervention verbs (section 12) and approval authority.

The creating member is the **host** (a participant or supervisor with room-admin rights: policy changes, eviction, `room_end`).

### 5.3 Epoch

The room epoch starts at 1 and increments on every join, leave, eviction, role change, or name rebinding. Presence changes do NOT bump the epoch. Every roster snapshot, roster event, and presence event carries the current epoch. A client whose stored epoch is stale MUST refresh via `room_roster` before trusting name-based addressing.

---

## 6. Agent cards and capability discovery

### 6.1 Card

Each member presents a card at join. The card is a subset-compatible A2A Agent Card so that room members can later be bridged to A2A mechanically:

```json
{
  "name": "pm-agent",
  "description": "Product manager for the checkout squad. Answers spec and priority questions.",
  "version": "1.4.0",
  "provider": { "organization": "Goodvest" },
  "skills": [
    {
      "id": "answer-spec-question",
      "name": "Answer a product spec question",
      "description": "Give the authoritative answer on checkout-flow requirements, with links to the spec.",
      "tags": ["product", "spec", "checkout"],
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain", "application/json"],
      "inputSchema": {
        "type": "object",
        "properties": { "question": { "type": "string" } },
        "required": ["question"]
      }
    }
  ],
  "signatures": []
}
```

Rules:

- `name`, `description`, and at least one `skills[]` entry with `id` + `description` are REQUIRED for participants (observers/supervisors MAY omit skills).
- `inputSchema`/`outputSchema` per skill are OPTIONAL JSON Schemas. Flat object schemas with primitive properties are RECOMMENDED (they survive every host's structured-output constraints; avoid `uniqueItems` and deeply optional properties).
- Cards MAY be signed (JWS detached signature over the JCS-canonicalized card, `signatures` excluded from the signing input; allowed algorithms EdDSA and ES256, never `none`). Hubs MUST verify present signatures and MUST expose verification status in the roster: `card_verified` is `null` for unsigned cards, `true` when at least one signature verifies, `false` when signatures are present but none verifies (tamper evidence). Key resolution (0.1.3): verifiers MUST support provisioned trusted key sets (`kid -> public JWK`) and MAY accept a public `jwk` embedded in the protected header; an embedded key proves integrity and key binding only (self-certifying, peers SHOULD pin the RFC 7638 thumbprint), never external identity, and when both `kid` and an embedded `jwk` are present the `kid` MUST equal the key's RFC 7638 thumbprint. `agent_describe` exposes per-signature detail (`kid`, `alg`, `method: trusted|embedded|unresolved`, `ok`). Hubs MAY enforce a `require_signed_cards` policy refusing joins and card rotations whose card does not verify.
- The hub MUST treat card text (names, descriptions) as untrusted content: it is data shown to models, so hubs SHOULD length-limit it (description <= 1024 chars per skill) and MUST NOT execute or follow instructions found in it.

### 6.2 Digest

The **capabilities digest** is `sha256` over the JCS-canonicalized card, base64url, prefixed: `sha256:xB4k...`. The digest appears in every presence record and roster entry. Clients MUST cache card fetches keyed by digest; identical replicas cost zero fetches (the XEP-0115 pattern).

### 6.3 Discovery flow

1. Roster entries carry `{name, id, role, state, digest, card_summary}` where `card_summary` is `{description, skill_ids[]}` (small enough to always inline).
2. `agent_describe` fetches the full card by member id or by digest. Responses carry `ttl_ms` and `cache_scope` (the MCP CacheableResult idiom).
3. **Projection rule**: a client that wants to offer room members to its model as tools SHOULD project each participant skill as a tool named `ask_{member_name}__{skill_id}` (sanitized), description = `{member description} :: {skill description}`, input schema = the skill's `inputSchema` or `{question: string}`. Invoking the projection sends a `request` envelope (section 8) to that member and awaits a `response`. This gives "discover agents like MCP tools" without the hub proxying anything.
4. Direct tool passthrough (invoking a member's own MCP tools through the hub under a namespace) is reserved for v0.2.

When a member's card changes, it MUST re-present the card (`room_presence` with `card`), the hub bumps the digest, and emits a `presence` event with the new digest. Peers notice the digest change and refetch lazily.

---

## 7. Presence

### 7.1 States

```
declared:   ready | busy | away
inferred:   offline
```

- `ready`: accepting requests now.
- `busy`: working; requests will queue. SHOULD include `detail` (freetext, <= 200 chars) and MAY include `task` (a task ref) and `waiting_for` (freetext).
- `away`: attended by nobody; long-latency expected.
- `offline`: NEVER declared. The hub infers it when the presence lease expires. Offline members remain members (epoch unchanged).

A presence record (as it appears in rosters and presence events):

```json
{
  "id": "m_7f3ka9",
  "name": "pm-agent",
  "role": "participant",
  "state": "busy",
  "detail": "drafting acceptance criteria for RFA-141",
  "waiting_for": null,
  "task": null,
  "digest": "sha256:xB4k...",
  "card_verified": true,
  "card_summary": { "description": "Product manager for the checkout squad...", "skill_ids": ["answer-spec-question"] },
  "joined_at": "2026-08-16T09:12:03Z",
  "last_seen": "2026-08-16T09:31:40Z",
  "lease_expires": "2026-08-16T09:34:40Z",
  "epoch": 7
}
```

### 7.2 Leases

- Every authenticated call by a member refreshes `last_seen`.
- The **presence lease** is refreshed by: `room_listen` (lease extends to the listen deadline plus `grace_s`), `room_presence`, and `room_send`. Default lease: **180 s**; hubs MAY accept `ttl_s` between 30 and 900. Renewals only ever EXTEND the lease, but an explicit `ttl_s` in `room_presence` RESETS it to `now + ttl_s` even if that shortens it: an agent declaring a short TTL is asking for fast failure detection and MUST get it (0.1.1).
- On lease expiry the hub MUST set the member's state to `offline` and emit a `presence` event. This is the **last-will rule**: a crashed agent goes visibly offline without any cooperation (MQTT LWT semantics, server-side).
- Hubs SHOULD debounce flapping: a member that goes offline and returns within `flap_window_s` (default 10 s) MAY have the offline event suppressed (MQTT will-delay semantics).
- A member returning from `offline` simply calls any tool; the hub restores its last declared state (or `ready` if none) and emits a `presence` event.

### 7.3 Declaring state

`room_presence` sets `{state, detail, waiting_for, task, ttl_s, card?}`. Additionally, `room_listen` and `room_send` accept an optional `presence` argument so agents can piggyback state changes on the calls they already make ("busy while I work on this").

---

## 8. Messages: the envelope

Every message event in the room log is an envelope:

```json
{
  "rfa": "0.1",
  "message_id": "01J8Z3V9M2C9QW4T",
  "seq": 4182,
  "ts": "2026-08-16T09:31:41.220Z",
  "room": "r_kx82mm",
  "from": { "id": "m_2dd01p", "name": "dev-agent", "origin": "agent" },
  "kind": "request",
  "to": ["m_7f3ka9"],
  "mentions": ["m_7f3ka9"],
  "conversation_id": "c_9ab3",
  "in_reply_to": null,
  "reply_by": "2026-08-16T09:36:41Z",
  "task": null,
  "body": [
    { "type": "text", "text": "For guest checkout: is the billing address mandatory when the cart only has digital goods?" }
  ],
  "chunk": null,
  "refusal": null,
  "_meta": {
    "traceparent": "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01"
  },
  "ext": {}
}
```

Field rules:

- `message_id`: sender-minted, globally unique (ULID/UUID). The hub MUST deduplicate on `(from.id, message_id)` so retries are idempotent.
- `seq`, `ts`, `from`: hub-assigned. `from.origin` is server-stamped (`human | agent | system`); clients cannot set it.
- `kind`: one of
  - `chat`: plain conversational content.
  - `request`: expects a `response` (or `refuse`). SHOULD carry `reply_by`.
  - `response`: MUST carry `in_reply_to` = the request's `message_id`, same `conversation_id`.
  - `refuse`: MUST carry `in_reply_to` and a `refusal` object (below).
  - `status`: presence-adjacent narration ("still working, 2 min"). Never turn-starting.
  - `system`: hub-emitted only (join/leave/eviction/timeout notices, delivery dispositions). Clients cannot send it.
- `to` / `mentions`: member refs (id preferred). `to` empty = room broadcast. `mentions` mark whose attention is requested; under `attention: mentions` policy, only mentioned members treat the message as turn-starting; everyone else receives it as ambient context (section 9.2).
- `conversation_id`: initiator-minted thread id; all replies carry it (FIPA conversation-id). `in_reply_to`: per-message correlation. `reply_by`: in-band soft deadline for the NEXT message in the flow; hubs emit a `system` timeout notice when it passes unanswered. Deadline tracking MUST be derived from the durable log so it survives hub restarts: a request is pending unless the log shows a `response`/`refuse` answering it or a timeout notice for it, and a deadline that expires while the hub is down fires on the first sweep after boot (0.1.1).
- `body`: ordered parts, `{type: "text"|"json"|"file", ...}`. `json` parts carry `value` (and optional `schema` URL). `file` parts carry `{name, mime, size, url | content_base64}`; hubs MUST cap inline content (default 64 KB) and SHOULD store larger payloads content-addressed.
- `chunk`: streaming marker for partial responses: `{"index": 0, "final": false}` ... `{"index": 7, "final": true}`. All chunks share `in_reply_to` and `conversation_id`. Interim chunks are the "interim report"; the `final: true` chunk is the result of record.
- `refusal` (on `kind: refuse`):

```json
{ "reason": "busy | ineligible | unauthorized | overloaded | expired | declined",
  "detail": "mid-release checklist, free in ~10m",
  "retry_after_s": 600 }
```

  `busy` means "capable, not now" (retry later); `ineligible` means "wrong agent" (re-route). This machine-readable split is what lets an asker decide between waiting and re-routing (Contract Net's BUSY vs INELIGIBLE).
- `_meta`: W3C trace context keys `traceparent`, `tracestate`, `baggage`, unprefixed (MCP SEP-414 convention). Everything else in `_meta` MUST be reverse-DNS namespaced.
- `ext`: namespaced extension data (`"com.example/thing": {...}`). Receivers MUST ignore unknown `ext` keys and unknown envelope fields (forward compatibility).

Size limits: hubs MUST enforce a max envelope size (default 256 KB inline) and return `payload_too_large` beyond it.

---

## 9. Sending and receiving

### 9.1 `room_send` and delivery outcomes

Send success = durable append: the hub assigned a `seq` and wrote the event. The result reports, for each mentioned recipient, what is knowable *now*:

```json
{
  "seq": 4182,
  "ts": "2026-08-16T09:31:41.220Z",
  "recipients": [
    { "member": "m_7f3ka9", "presence": "busy", "delivery": "queued" }
  ]
}
```

`delivery` is one of:

- `live`: recipient is listening now (active `room_listen` or push stream); the event is being handed to it.
- `queued`: recipient is a member but not currently listening; it will see the event on its next listen/sync.
- `held`: room policy held the message for review (moderation or an inbound-policy gate); a later `system` event reports release, refusal, or expiry (default hold TTL 5 min).
- `refused`: policy rejected delivery to this recipient (e.g. muted sender, not your turn); the send may still be appended for the others, or the whole call errors if no recipient remains.

Senders MUST NOT infer "answered soon" from `live`; it is a hint. Disposition changes (hold released/expired) arrive as `system` events referencing the original `message_id`.

Anti-loop requirements (hubs MUST implement): per-sender rate limit (default 30 messages/min/room), duplicate suppression (identical body from same sender within 30 s is dropped with `rate_limited`), and a per-member unread cap (default 200; beyond it, oldest ambient events are compacted into a `system` summary marker).

### 9.2 Attention rule

Under `attention: mentions` (the default):

- A message that mentions member M is **turn-starting** for M: delivered as an event M's client should act on.
- A message that does not mention M is **ambient** for M: delivered (or batched) as context. Clients SHOULD accumulate ambient traffic and present it as background context at the next turn boundary rather than waking the agent per message.

This single rule is the token-economics control (agents in a busy room do not process every message) and the infection-containment control (scoped attention approximates local messaging, which measurably slows prompt-infection spread).

### 9.3 `room_listen` (long-poll; also the sync primitive)

```json
{ "room": "r_kx82mm", "membership_token": "...", "since": 4180,
  "timeout_ms": 30000, "wait_for": "mentions", "presence": "ready" }
```

- Returns as soon as a matching event with `seq > since` exists, else at `timeout_ms` (hub cap: **60 000 ms**; clients SHOULD use <= 45 000 ms under interactive MCP hosts, many of which cancel tool calls at 60 s). Before parking, the hub MUST replay matching events already in the log with `seq > since` (this closes the poll-gap race).
- `timeout_ms: 0` = pure read: this is **sync/replay** for late joiners and reconnection. There is no other resume mechanism; the cursor is the contract.
- `wait_for`: `mentions` (default) | `all` | `conversation:{id}` | `from:{member}`. The `mentions` filter MUST match: message events that mention or address the caller or reply to a message the caller sent; system events that reference the caller (as `asker`, in `askers`, as `member`, or via a `message_id` the caller sent); and intervention events targeting the caller. Presence and roster events are ambient under `mentions`.
- Result: `{ "events": [...], "cursor": 4185, "epoch": 7, "lease_expires": "..." }`. `events[]` items are typed (section 9.4). An empty result with a fresh cursor is normal; quiet is not a stop signal.
- Listening stamps the presence lease to `now + timeout_ms + grace_s` (default grace 15 s).

### 9.4 Event types

Every event: `{seq, ts, type, ...payload}`. Types:

| type | payload | notes |
|---|---|---|
| `message` | the envelope (section 8) | |
| `presence` | one presence record | single-member change: state, detail, digest, lease expiry |
| `roster` | full roster snapshot + `epoch` + `reason: join\|leave\|evict\|role\|rebind` | full snapshot, never a diff (ordering-bug-proof) |
| `task` | task object (section 10) | only if tasks module enabled |
| `system` | `{event: timeout\|held\|hold_released\|hold_expired\|room_ending\|..., refs}` | hub-emitted |
| `intervention` | `{verb, actor, target, reason}` | supervisor actions, always auditable (section 12) |

Membership changes emit `roster` (full snapshot). Presence-only changes emit `presence` (single record). This split is deliberate: rosters change rarely and must be consistent; presence changes often and must be cheap.

### 9.5 Client obligations (added in 0.1.1)

An agent that has sent a `request` (especially with `reply_by`), or that has an unanswered `request` addressed to it, SHOULD remain listening (or keep another wake channel active) until the conversation resolves, times out, or the counterparty goes offline. Stop heuristics based on consecutive empty listens MUST be presence-aware: before giving up, check whether any conversation you participate in still has pending requests, and whether the members you are waiting on are still present. Rationale: in field testing, an answering agent whose stop rule was "N empty listens" went offline mid-conversation moments before the next question arrived; the protocol made the failure visible, but the stop rule caused it.

---

## 10. The ask lifecycle and the tasks module

### 10.1 Lightweight ask (core)

The dev-asks-PM scenario needs no task machinery: `request` -> (`response` | `refuse` | timeout `system` event), threaded by `conversation_id`, streamed via `chunk`, deadline via `reply_by`. Clarifying questions are just a `request` in the same `conversation_id` flowing the other way.

### 10.2 Tasks module (optional, `"tasks"` conformance)

For work that outlives a conversation. Task states are a strict subset mapped onto the A2A TaskState machine, so bridging is mechanical:

| RFA state | A2A TaskState |
|---|---|
| `submitted` | SUBMITTED |
| `working` | WORKING |
| `input_required` | INPUT_REQUIRED |
| `completed` | COMPLETED (terminal) |
| `failed` | FAILED (terminal) |
| `cancelled` | CANCELED (terminal) |
| `rejected` | REJECTED (terminal) |

Task object:

```json
{
  "id": "t_19",
  "room": "r_kx82mm",
  "title": "Confirm billing-address rule for digital-only carts",
  "state": "working",
  "created_by": "m_2dd01p",
  "owner": "m_7f3ka9",
  "parent_id": null,
  "conversation_id": "c_9ab3",
  "blocks": [], "blocked_by": [],
  "reply_by": "2026-08-16T10:00:00Z",
  "evidence_required": false,
  "evidence": null,
  "verification": { "pending": false, "verifier": null, "verdict": null, "note": null },
  "note": "checking with finance",
  "created_at": "2026-08-16T09:35:00Z",
  "updated_at": "2026-08-16T09:40:00Z"
}
```

`room_task` verbs (0.1.4 fixes the concrete semantics): `create` (title required; optional `owner`, `blocked_by[]`, `reply_by`, `evidence_required`, `parent_id`), `get`, `list`, `claim` (atomic: only a `submitted`, unowned, unblocked task; exactly one claimant wins, losers get `task_conflict`), `update` (state to `working | input_required | failed | rejected` and/or a `note`; `rejected` is creator/host only; answering an `input_required` task flips it back to `working`), `complete` (owner only), `verify` (verdict `accept | reject`), `cancel` (owner, creator, or host).

The evidence gate: if `evidence_required` is set, `complete` MUST carry `evidence {summary, artifacts[]}` and does NOT change state; it sets `verification.pending`. A verifier whose member id differs from the owner then calls `verify`: `accept` moves the task to `completed`; `reject` records the verdict and returns the task to `working` for rework (`rejected` the state stays reserved for declining a task outright, since it is terminal). Completing a task removes it from dependents' `blocked_by` and announces newly unblocked tasks with a `task` event (`action: "unblocked"`).

Task events carry `{action, actor, task}` and match the `mentions` filter for the task's owner, creator, and verifier. A task with `reply_by` past due (and not terminal) causes a one-shot `system {event: "task_overdue", refs: {task_id, title, owner, asker}}` notice. `parent_id` forms the super-task tree used in observability (section 13).

---

## 11. Bindings

### 11.1 MCP tool plane (required)

Tool names, with required arguments marked `*`. All tools take `membership_token*` except `room_create` and `room_join`. Full JSON Schemas in Appendix A.

| Tool | Purpose | Key arguments | Returns |
|---|---|---|---|
| `room_create` | Mint a room | `topic*, name*, card*, policies` | `room, join_secret, membership {id, name, token}, roster, cursor` |
| `room_join` | Join | `room*` (handle or short code), `join_secret`, `name*, card*, role, history_limit` | join contract (section 11.3) |
| `room_leave` | Leave | `room*` | `ok` |
| `room_send` | Append a message | `room*, body*, kind, to, mentions, conversation_id, in_reply_to, reply_by, message_id*, chunk, refusal, presence` | `seq, ts, recipients[]` |
| `room_listen` | Receive / sync | `room*, since*, timeout_ms, wait_for, presence` | `events[], cursor, epoch, lease_expires` |
| `room_roster` | Roster snapshot | `room*` | `roster, epoch, cursor` |
| `room_presence` | Declare state | `room*, state*, detail, waiting_for, task, ttl_s, card` | `lease_expires, epoch` |
| `agent_describe` | Fetch a card | `room*`, `member` or `digest` | `card, digest, verified, ttl_ms, cache_scope` |
| `room_task` | Tasks module | `room*, action*, ...` | task object(s) |
| `room_admin` | Host/supervisor verbs | `room*, verb*, target, reason` | `ok, epoch` |
| `room_end` | Close the room | `room*, summary` | `ok` |

Core profile = the first eight minus `room_task`. Tool descriptions served to models MUST include the operating hints agents need ("quiet listens are normal, call again with the same cursor"; "always address by id after a roster change").

### 11.2 MCP push plane (optional, `"push"` conformance)

For 2026-07-28 hosts, the hub declares in its `server/discover` capabilities:

```json
{ "capabilities": { "tools": {}, "extensions": { "dev.agentcom/rooms": { "version": "0.1" } } } }
```

A client subscribed via `subscriptions/listen` MAY include the extension filter:

```json
{ "method": "subscriptions/listen",
  "params": { "notifications": { "toolsListChanged": false },
              "dev.agentcom/rooms": { "rooms": [ { "room": "r_kx82mm", "membership_token": "...", "since": 4180, "wait_for": "all" } ] } } }
```

The hub then delivers `notifications/room/event` on that stream, each carrying one event object (section 9.4) plus the subscription id per MCP rules. Push replaces polling but not the cursor contract: on stream loss the client re-subscribes (or calls `room_listen`) from its last cursor; the hub keeps NO per-stream replay state. Fanout is per-member streams; the hub duplicates events across them (in-spec for MCP 2026-07-28).

### 11.2b Interim push binding for 2025-era hosts (added in 0.1.2)

Until a hub speaks the 2026-07-28 extension, it MAY offer connection-scoped push through a `room_watch` tool: the call registers the calling MCP connection as a standing subscriber (same `wait_for` filters as `room_listen`), synchronously replays matching events with `seq > since` before registering (no gap), and thereafter delivers each matching event as a `notifications/room/event` notification with payload `{room, member, cursor, event}`. The subscription lives until `enabled: false`, room end, or connection close, and one watch per (connection, room) replaces any previous one. Requirements and caveats: it needs a persistent connection (stdio or a held stream; per-request stateless HTTP cannot carry it); each DELIVERED event extends the member's presence lease (receipt proves the connection is alive) but a quiet room does not, so watchers still heartbeat; a member reachable through a watcher counts as `live` in send dispositions; and it is intended for SDK-level clients and resident agents, since interactive hosts that do not surface custom notifications to the model should keep using `room_listen`.

### 11.3 The join contract

`room_join` returns, in one result, everything needed before speaking (the XMPP-MUC ordering, collapsed into one JSON object):

```json
{
  "room": "r_kx82mm",
  "topic": "checkout-flow feature work",
  "policies": { "attention": "mentions", "mode": "open", "join": "invite" },
  "you": { "id": "m_2dd01p", "name": "dev-agent", "role": "participant",
           "membership_token": "mt_...", "requested_name_adjusted": false },
  "roster": [ { "...": "presence records for ALL members, including you" } ],
  "epoch": 7,
  "history": { "events": [ "..." ], "cursor": 4180, "truncated": true },
  "instructions": "You are in room r_kx82mm. Address members by id. Listen with room_listen(since=4180). Unmentioned traffic is ambient context."
}
```

Clients MUST process in this order: `you` (self-identity, the 110-marker equivalent) -> `roster` (who is here, with digests) -> `history` -> live traffic. The `instructions` string is the LLM-facing operating text (the MCP `instructions` idiom).

### 11.4 REST binding (optional, informative in v0.1)

For non-MCP agents, hubs MAY mirror the tool plane at `POST /rfa/v0/{tool_name}` with identical JSON bodies/results, bearer `membership_token`, and `GET /rfa/v0/room/{room}/events?since=&timeout_ms=` for listen. Semantics MUST be identical to the tool plane. A normative REST binding is planned for v0.2.

---

## 12. Moderation, supervision, and floor control

### 12.1 Supervisor verbs (`room_admin`)

Each verb emits an `intervention` event (auditable, visible to all members unless the room policy says otherwise):

`hold_member` / `release_member` (pause an agent's delivery), `interrupt` (signal a member to abandon its current turn), `evict` (remove membership; epoch bump; its token is revoked), `quarantine` (evict + mark; hub refuses re-join with same identity pending human action), `inject` (send with `origin` = the supervisor's principal class), `cancel_task`, `approve` / `reject` (correlated to an `approval_request` by `request_id`), `set_policy`, `set_role`.

Approval flows: any member MAY send a `system`-adjacent `request` with `ext["dev.agentcom/approval"] = {request_id, action, params}` targeted at supervisors; only an `approve` intervention from a **human-origin** principal satisfies it. **A message from an agent claiming approval is void by construction** (origin stamping).

### 12.2 Pre-delivery policy gate

Hubs SHOULD offer a policy hook evaluated before delivery (not before append): outcomes `allow | alert | hold | refuse`, with the outcome recorded. This is where org-specific safety (content rules, egress rules, model-based screening) composes with the protocol without changing it.

### 12.3 Floor control (optional, `"moderation"` conformance)

`mode: sequential` (hub enforces one turn-starting speaker at a time, queue order) and `mode: moderator` (a designated member picks the next speaker). Defaults tuned from field data: first-response grace 150 s, renewal by `status` message 300 s, hard cap 600 s per turn; on expiry the hub emits `system {event: "timeout"}` and advances. `open` mode has no enforcement and is the default.

---

## 13. Observability

- **Trace context**: envelopes carry `traceparent`/`tracestate`/`baggage` unprefixed in `_meta` (SEP-414). The sender propagates its current context. For broadcast fanout, receivers SHOULD create spans with **links** to the sender context rather than parent-child (one message to N agents breaks single-parent trees).
- **Correlation ids**: `room` maps to `gen_ai.conversation.id` (OTel GenAI), `session_id`/`thread_id` (LangSmith/Langfuse), `session.id` (OpenInference). `task.id`/`task.parent_id` is the super-task tree; export as `graph.node.id`/`graph.node.parent_id` where supported.
- **Hub spans**: hubs SHOULD emit OTel spans per tool call (`rfa.{tool}`) with `rfa.room`, `rfa.member`, `rfa.seq`, plus MCP semconv attributes (`mcp.method.name`).
- **Audit**: the room log IS the audit trail; hubs MUST retain `intervention`, `roster`, and `system` events for the room's retention window even if `message_ttl_s` expires chat. Optional hash-chain profile (v0.2): per-sender `prev_hash` + `signature` envelope fields, InterSAGE-style.
- **Omission signal**: hubs SHOULD emit a `system {event: "gone_quiet", refs: {member, name, askers[]}}` notice when a member owing a reply to an in-flight `request`/task goes offline or misses consecutive lease renewals. `refs.askers` MUST list the member ids owed replies, so the notice reaches them under the `mentions` filter: the askers are exactly who need to know. (0.1.1: `askers` added after field testing showed the waiting agent could not see the original member-only form and burned 13 minutes polling instead.) The two request/offline orderings are covered by different mechanisms and hubs MUST NOT conflate them: a request placed while the member is present is covered by `gone_quiet` at the member's later offline transition; a request placed when the member is already offline is covered synchronously by the send result's recipient disposition (`presence: "offline"`, `delivery: "queued"`), and no retroactive `gone_quiet` is emitted for it. Silence is a signal.

---

## 14. Security requirements (normative)

1. **Origin stamping.** `from` and `origin` are hub-derived from the authenticated principal. Agent principals can never produce `origin: "human"`.
2. **No authority from text.** Hubs and clients MUST NOT treat message content as authorization for anything. Authority flows only through authenticated verbs (`room_admin`, approval flows with human-origin `approve`).
3. **Untrusted content boundary.** Client SDKs MUST deliver peer messages to models wrapped in a data boundary (e.g. `<room-message from="pm-agent" origin="agent">...</room-message>`) with sender-name sanitization (strip control chars; allowlist `[\p{L}\p{N} _.-:]`), and SHOULD offer a sanitization hook before ingestion into any retrievable memory. Auto-ingest of peer messages into RAG stores without sanitization is a wormable design and MUST NOT be a default.
4. **Capability integrity.** Capabilities resolve by `(member_id, digest)`, never by name alone. Hubs MUST verify that served cards match their digest, MUST verify card signatures when present, and MUST reject skill-id collisions within a member. Clients invoking a projected skill MUST bind the invocation to the member id captured at projection time; if the member's digest changed since, re-project first (error `digest_changed`).
5. **Visibility scoping.** Default `attention: mentions`; hubs MUST NOT offer a mode that force-feeds full history into every member's turn. History replay is pull (`room_listen since`), never push-on-join beyond `history_limit`.
6. **Namespace hygiene.** Member ids are never reused within a room. Names free on leave but rebinding is guarded by `name_rebound` (4.1). Hub-level agent registries (out of scope for v0.1) MUST NOT free namespaces on account deletion.
7. **Rate and blast-radius limits.** Per-sender message rate limits, duplicate suppression, fan-out caps (`max mentions per message`, default 10), and per-member unread caps are REQUIRED (defaults in 9.1). These bound both token burn and worm spread.
8. **Eviction is real.** Membership-token revocation MUST take effect on the next call. Hubs MUST NOT deliver post-eviction events to revoked tokens. (Cryptographic ejection via group keys is a v0.2+ profile.)
9. **Transport.** TLS everywhere non-local. Join secrets and membership tokens are bearer credentials: never in URLs (use arguments/headers), never logged.

---

## 15. Errors

Tool-plane errors use MCP tool error results with a machine-readable `error` object:

```json
{ "code": "name_rebound", "message": "…", "retry_after_s": null,
  "data": { "name": "pm-agent", "current_holder": "m_9k2xw1", "epoch": 9 } }
```

Codes: `unknown_room`, `unknown_member`, `not_a_member`, `unauthorized`, `join_denied`, `name_rebound`, `stale_epoch`, `muted`, `not_your_turn`, `held`, `rate_limited`, `payload_too_large`, `digest_changed`, `room_ended`, `task_conflict` (claim races), `bad_cursor`, `lease_expired`.

`muted` and `not_your_turn` instruct the agent to listen, not retry.

---

## 16. Conformance profiles

| Profile | Requires |
|---|---|
| **core** | Tools `room_create/join/leave/send/listen/roster/presence`, `agent_describe`; envelope; presence leases; join contract; attention rule; delivery outcomes; errors; security section 14 items 1-3, 5, 7, 9 |
| **push** | core + the `dev.agentcom/rooms` subscriptions/listen extension, or the interim `room_watch` binding (11.2b) |
| **tasks** | core + `room_task` with the A2A-mapped state machine |
| **moderation** | core + roles observer/supervisor + `room_admin` verbs + floor-control modes |
| **signing** | core + JWS card verification (trusted-set and embedded-jwk resolution), `card_verified` surfacing, per-signature detail in `agent_describe`, optional `require_signed_cards` enforcement |

A hub advertises its profiles in `server/discover` extension settings: `{"dev.agentcom/rooms": {"version": "0.1", "profiles": ["core", "push", "tasks"]}}`.

---

## 17. Worked example: dev agent asks the PM agent

1. **Join.** `dev-agent` calls `room_join {room: "r_kx82mm", join_secret, name: "dev-agent", card}`. Gets `you {id: m_2dd01p, token}`, roster (sees `pm-agent`, `state: ready`, digest `sha256:xB4k`), history cursor 4180.
2. **Discover.** `dev-agent` already has `sha256:xB4k` cached from another room: zero fetches. It projects `ask_pm-agent__answer-spec-question` as a local tool for its model.
3. **Ask.** The model invokes the projection; the client sends
   `room_send {kind: "request", to: ["m_7f3ka9"], mentions: ["m_7f3ka9"], conversation_id: "c_9ab3", reply_by: "+5m", body: [{type: "text", text: "For guest checkout: is billing address mandatory for digital-only carts?"}], message_id: "01J8Z..."}`
   Result: `{seq: 4182, recipients: [{member: "m_7f3ka9", presence: "ready", delivery: "live"}]}`.
4. **PM is mid-task after all.** `pm-agent`'s listen returns the event; its client decides it is busy and replies
   `room_send {kind: "refuse", in_reply_to: "01J8Z...", conversation_id: "c_9ab3", refusal: {reason: "busy", detail: "in release review", retry_after_s: 480}, presence: "busy"}`.
5. **Dev waits, then retries** after the `retry_after_s` (or on seeing `presence: ready` in a `presence` event at seq 4190).
6. **Answer, streamed.** `pm-agent` responds in three chunks, same `conversation_id`, `chunk: {index: 0..2, final: true}` on the last, `body` carrying text plus a `json` part with `{mandatory: false, source: "spec §4.2"}`.
7. **Clarify (reverse flow).** If the PM needed detail first, it would send its own `request` in `c_9ab3` to `m_2dd01p`; nothing else changes.
8. **Crash safety.** Had `pm-agent` died at step 6, its lease would expire within 180 s, the hub would emit `presence {state: offline}` plus (because it owned an in-flight request) `system {event: "gone_quiet"}`, and `dev-agent` could re-route or escalate to a supervisor.

---

## Appendix A: tool schemas (normative)

Conventions: all schemas are draft 2020-12; `membership_token` is `{"type": "string", "minLength": 16}`; member refs accept id (`m_*`) or name.

```json
{
  "room_join": {
    "type": "object",
    "properties": {
      "room": { "type": "string", "description": "Room handle (r_*) or short join code" },
      "join_secret": { "type": "string" },
      "name": { "type": "string", "minLength": 1, "maxLength": 64 },
      "card": { "$ref": "#/defs/agent_card" },
      "role": { "type": "string", "enum": ["participant", "observer", "supervisor"], "default": "participant" },
      "history_limit": { "type": "integer", "minimum": 0, "maximum": 500, "default": 50 }
    },
    "required": ["room", "name", "card"]
  },
  "room_send": {
    "type": "object",
    "properties": {
      "room": { "type": "string" },
      "membership_token": { "type": "string" },
      "message_id": { "type": "string", "minLength": 8, "maxLength": 64 },
      "kind": { "type": "string", "enum": ["chat", "request", "response", "refuse", "status"], "default": "chat" },
      "body": { "type": "array", "items": { "$ref": "#/defs/part" }, "minItems": 1 },
      "to": { "type": "array", "items": { "type": "string" }, "maxItems": 10 },
      "mentions": { "type": "array", "items": { "type": "string" }, "maxItems": 10 },
      "conversation_id": { "type": "string" },
      "in_reply_to": { "type": "string" },
      "reply_by": { "type": "string", "format": "date-time" },
      "chunk": { "type": "object", "properties": { "index": { "type": "integer", "minimum": 0 }, "final": { "type": "boolean" } }, "required": ["index", "final"] },
      "refusal": { "type": "object", "properties": { "reason": { "type": "string", "enum": ["busy", "ineligible", "unauthorized", "overloaded", "expired", "declined"] }, "detail": { "type": "string", "maxLength": 200 }, "retry_after_s": { "type": "integer" } }, "required": ["reason"] },
      "presence": { "type": "string", "enum": ["ready", "busy", "away"] }
    },
    "required": ["room", "membership_token", "message_id", "body"]
  },
  "room_listen": {
    "type": "object",
    "properties": {
      "room": { "type": "string" },
      "membership_token": { "type": "string" },
      "since": { "type": "integer", "minimum": 0, "description": "Last seen seq; 0 = from beginning (subject to history policy)" },
      "timeout_ms": { "type": "integer", "minimum": 0, "maximum": 60000, "default": 30000, "description": "0 = non-blocking read (sync)" },
      "wait_for": { "type": "string", "default": "mentions", "description": "mentions | all | conversation:{id} | from:{member}" },
      "presence": { "type": "string", "enum": ["ready", "busy", "away"] }
    },
    "required": ["room", "membership_token", "since"]
  },
  "room_presence": {
    "type": "object",
    "properties": {
      "room": { "type": "string" }, "membership_token": { "type": "string" },
      "state": { "type": "string", "enum": ["ready", "busy", "away"] },
      "detail": { "type": "string", "maxLength": 200 },
      "waiting_for": { "type": "string", "maxLength": 200 },
      "task": { "type": "string" },
      "ttl_s": { "type": "integer", "minimum": 30, "maximum": 900 },
      "card": { "$ref": "#/defs/agent_card", "description": "Re-present to rotate the digest" }
    },
    "required": ["room", "membership_token", "state"]
  },
  "agent_describe": {
    "type": "object",
    "properties": {
      "room": { "type": "string" }, "membership_token": { "type": "string" },
      "member": { "type": "string" }, "digest": { "type": "string" }
    },
    "required": ["room", "membership_token"]
  },
  "defs": {
    "part": {
      "oneOf": [
        { "type": "object", "properties": { "type": { "const": "text" }, "text": { "type": "string" } }, "required": ["type", "text"] },
        { "type": "object", "properties": { "type": { "const": "json" }, "value": {}, "schema": { "type": "string" } }, "required": ["type", "value"] },
        { "type": "object", "properties": { "type": { "const": "file" }, "name": { "type": "string" }, "mime": { "type": "string" }, "size": { "type": "integer" }, "url": { "type": "string" }, "content_base64": { "type": "string" } }, "required": ["type", "name", "mime"] }
      ]
    },
    "agent_card": {
      "type": "object",
      "properties": {
        "name": { "type": "string" }, "description": { "type": "string", "maxLength": 1024 },
        "version": { "type": "string" },
        "provider": { "type": "object", "properties": { "organization": { "type": "string" } } },
        "skills": { "type": "array", "items": { "type": "object",
          "properties": { "id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string", "maxLength": 1024 },
            "tags": { "type": "array", "items": { "type": "string" } },
            "inputModes": { "type": "array", "items": { "type": "string" } },
            "outputModes": { "type": "array", "items": { "type": "string" } },
            "inputSchema": { "type": "object" }, "outputSchema": { "type": "object" } },
          "required": ["id", "description"] } },
        "signatures": { "type": "array", "items": { "type": "object",
          "properties": { "protected": { "type": "string" }, "signature": { "type": "string" } },
          "required": ["protected", "signature"] } }
      },
      "required": ["name", "description"]
    }
  }
}
```

(`room_create`, `room_leave`, `room_roster`, `room_task`, `room_admin`, `room_end` schemas follow the same conventions; normative shapes are fixed by the field tables in sections 5, 10, and 12.)

## Appendix B: reserved names and registries

- Envelope `kind`: registry seeded with `chat, request, response, refuse, status, system`. New kinds via spec revision only; experimental kinds go in `ext`.
- Event `type`: `message, presence, roster, task, system, intervention`.
- Refusal `reason`: `busy, ineligible, unauthorized, overloaded, expired, declined`.
- Error `code`: list in section 15.
- `_meta` keys: unprefixed `traceparent, tracestate, baggage` only; all else reverse-DNS.
- Extension id: `dev.agentcom/rooms`; sub-keys under `ext` reverse-DNS.

## Appendix C: design rationale (decision -> evidence)

| Decision | Evidence (see research/REPORT.md) |
|---|---|
| Hub as MCP server; rooms as tools | MCP 22-28x adoption lead; agent-behind-MCP community default; Coral + agent-room prove the surface; York study: MCP carries inter-agent coordination at ~half A2A's complexity |
| Extension `dev.agentcom/rooms` on subscriptions/listen | MCP 2026-07-28 extensions framework (SEP-2133) + tasks extension precedent (adds filters + notification types); per-member fanout is in-spec |
| No sampling/elicitation/roots/sessions | Deprecated or removed in MCP 2026-07-28; VS Code/Cursor lag argues dual-era serving |
| Card-compatible descriptors, not native A2A | A2A has zero multi-party primitives and unresolved discovery; cards are the universally implemented part; enterprise bridges become mechanical |
| Join contract ordering (self, roster, history, live) | XMPP MUC XEP-0045 join contract; status-code-110 self-echo |
| Capability digest in presence | XEP-0115 Entity Capabilities: fetch once per unique hash |
| Tiny closed presence enum + freetext detail | RFC 6121 show values; Claude Code tempo+detail (most copyable of 4 inspected systems) |
| Offline inferred by lease expiry + flap debounce | LMOS TTL directories; MQTT LWT + will-delay; agent-room listenUntil leases |
| Full-roster snapshots on membership change, single-record presence events | SLIM GROUP_UPDATE full-roster + UPDATE_PARTICIPANT_STATE split; snapshot-not-diff avoids ordering bugs |
| Membership epoch stamped everywhere | SLIM MLS-epoch-as-membership-version, minus the crypto |
| Durable-append delivery + delivered/held/refused | Convergence of all four inspected systems; Claude Code three-outcome model with sender-visible dispositions |
| Mention-gated attention, ambient buffering | AgentTeams/Matrix mention gating; Prompt Infection: local beats global messaging; practitioner reports on token burn |
| BUSY vs INELIGIBLE refusals, reply_by deadlines, conversation_id/in_reply_to | Smith 1980 Contract Net; FIPA-ACL envelope fields; fipa-request outcomes |
| Long-poll listen with replay-before-park, 60s cap | Coral waiter + replayAfter implementation; agent-room constants |
| Cursor-based sync, no server-held stream replay | MCP 2026-07-28 removed resumability; stateless-recoverable wins ProtocolBench fail-storm |
| Origin stamping, no authority from text | aiAuthZ 0% residual attack rate; Claude Code consent rule; OWASP ASI07 |
| Digest+id capability binding, never name-only | Wrong-provider execution VR up to 1.0; MCPTox tool poisoning; card poisoning |
| Rate limits, duplicate suppression, fan-out caps | Claude Code anti-loop; Morris-II/Prompt Infection blast-radius control |
| Trace keys in _meta, task tree ids, room_id mapping table | MCP SEP-414 (Final); York study super-task-id gap; OTel GenAI conventions |
| Observer/supervisor roles + intervention verbs | Gap confirmed across all protocols; verbs inventoried from Claude Code, Cursor, MS Agent Framework, GAAT |
| Evidence-gated task completion (optional) | agent-room anti-phantom-delivery gate |
| Auth tiers with optional crypto | ProtocolBench: DID/E2E stacks cost 17-36% latency; adoption physics |

## Appendix D: v0.2 backlog (explicitly out of scope for 0.1)

Tool passthrough (invoking a member's own MCP tools through the hub under a namespace); normative REST binding; per-message signature profile and hash-chain audit fields; webhook wake-ups (HMAC-signed) for resident agents; federation (cross-hub rooms; reserve `search_id`, `max_depth`, `scope` per FIPA federated search); contract-net task auction verbs; group E2E encryption (MLS profile); registry integration (publishing hub cards to ANS/NANDA-style directories); latent/binary body parts between homogeneous agents.

## Appendix E: changelog

**0.1.4 (2026-08-16)** - tasks profile semantics:
- Section 10.2: concrete task object shape (`evidence`, `verification`, `note`, `created_at`); full verb set incl. `get`/`list`/`verify`; atomic claim rules (submitted + unowned + unblocked); evidence gate flow (complete sets `verification.pending`, verify accept/reject, reject = rework not terminal); `unblocked` task events; `task_overdue` one-shot system notice; task events match the mentions filter for owner/creator/verifier.

**0.1.3 (2026-08-16)** - signing profile semantics:
- Section 6.1: `card_verified` tri-state defined precisely; allowed algorithms (EdDSA, ES256); two key-resolution paths (provisioned trusted sets MUST, embedded self-certifying `jwk` MAY, with kid = RFC 7638 thumbprint required); per-signature verification detail in `agent_describe`; optional `require_signed_cards` hub policy covering joins AND card rotations.

**0.1.2 (2026-08-16)** - interim push binding:
- Added section 11.2b: connection-scoped push via `room_watch` + `notifications/room/event` for 2025-era MCP hosts, with replay-before-register, per-(connection, room) replacement, lease extension on delivery, and `live` disposition through watchers. The 2026-07-28 `subscriptions/listen` binding remains the target.
- Conformance: the `push` profile is satisfiable by either binding.

**0.1.1 (2026-08-16)** - errata from the first live multi-agent field test (two interactive Claude Code sessions on the happy path; two autonomous subagents on the failure path, all through the reference hub):
- `gone_quiet` system events MUST carry `refs.askers` so the members owed replies see the notice under the `mentions` filter (section 13). Found live: an answering agent went offline mid-conversation; the asker could not see the original member-only notice and spent ~13 minutes polling.
- New section 9.5 "Client obligations": stay listening while conversations you participate in have pending requests; empty-listen stop rules must be presence-aware. This client behavior caused the failure above.
- `mentions` filter matching defined precisely, including system-event reference rules (section 9.3).
- Listen guidance: prefer `timeout_ms <= 45000` under interactive MCP hosts that cancel tool calls at 60 s (section 9.3). Found live: a 60 s listen collided with a host's 60 s client timeout.
- Hubs MUST own their persistence store exclusively and fail loudly on contention (section 3).
- An explicit `ttl_s` in `room_presence` RESETS the lease to the new horizon; plain renewals only ever extend it (section 7.2). Found live: a deterministic probe showed a short TTL losing to a longer existing lease, so an agent asking for fast failure detection silently did not get it. Verified fixed on the wire: 41s detection at `ttl_s: 30` + 10s flap.
- Clarified the two request/offline orderings: `gone_quiet` covers pending-then-offline; the send disposition covers send-to-already-offline; no retroactive `gone_quiet` (section 13).
- `reply_by` deadline tracking MUST be rebuilt from the durable log on boot; deadlines that expire during downtime fire on the first sweep after restart (section 8). Found live: a hub restart mid-conversation silently dropped a pending deadline and the asker never received its timeout notice; verified fixed by observing the restarted hub emit the orphaned notice from the log alone.

**0.1 (2026-08-16)** - initial draft.
