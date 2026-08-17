# 03-remote-tasks: task delegation across a trust boundary

Wave 04, dimension 03. Written 2026-08-17. Premise: RFA is a hub any organization self-hosts, and a room holds LOCAL agents (agent.md packs the operator supervises) plus REMOTE agents hosted elsewhere, possibly by another org, on another framework (LangChain/LangGraph), executing with their own tools the hub never sees. The author's explicit requirement for this dimension: a remote agent must be able to claim a task, do the work elsewhere, and report completion with evidence.

Repo read at commit `02025de` (protocol spec 0.1.7, hub 0.6.0).

---

## Verdict

**The task board is already 80% correct for a remote claimant, and the missing 20% is one concept: the claim is a lease with a fencing token.** Everything else in this dimension is either already shipped (evidence gate, hash chain, approval flow, memory admission gate, presence leases, `task_conflict` on claim races) or is a small additive field set. There is no case here for a new subsystem.

Three things are outright broken for a remote claimant today, all in `src/store.ts`, all cheap:

1. **A remote worker that goes dark holds the task forever.** `claim` sets `owner` and `state="working"` (`src/store.ts:1672-1674`) and nothing ever takes it back. The sweep notices the member going offline (`src/store.ts:1904-1910`) and even emits `gone_quiet`, but only to askers of pending *messages* (`src/store.ts:1908`), never to a task creator. `task_overdue` fires once and changes no state (`src/store.ts:1942-1956`). No lease, no requeue, no attempt counter.
2. **A remote worker that reconnects cannot finish its own task.** Every `room_join` mints a fresh member id (`rid("m")`, `src/store.ts:498`) and `complete` requires `task.owner === member.id` (`src/store.ts:1704`). A LangGraph process that restarts, or any client that loses its `membership_token`, is locked out of the work it did. This is the single most likely real-world failure and it produces the worst possible outcome: the work happened, the result exists, and the protocol refuses to record it.
3. **Peer text on the task path bypasses the policy gate entirely.** `evaluateGate` is called only from the send path (`src/store.ts:846`); `task()` (`src/store.ts:1574-1743`) calls it never. So `note`, `evidence.summary` and `evidence.artifacts[]` from an unaudited remote agent land in the room log, the console, a human's approval card and a local agent's context with zero inspection. Under wave 04's premise this is the highest-severity finding in the dimension, and the fix is a call site, not a design.

**On trust in the result, be blunt: nothing verifies an opaque worker's answer, and no 2026 mechanism changes that.** What the surveyed prior art actually buys is *decidable disputes*, not truth: a signed, digest-bound record of who claimed what, when, under which constraints, with which self-reported cost. RFA already computes the expensive half of that (JCS + SHA-256 hash chain, `src/jcs.ts`, `src/store.ts:2136`; JWS card signing with RFC 7638 thumbprint kids, `src/signing.ts`). The honest verification ladder, cheapest first: (1) evidence gate with a verifier who is not the claimant (shipped), (2) content-addressed artifacts so the bytes are checkable, (3) result signing reusing the card key, (4) the policy gate on peer text, (5) a human approval before any local side effect (shipped, `src/bridge.ts`), (6) opt-in spot-check re-execution for the rare task where it is affordable. Zero-knowledge proofs, TEE attestation, quorum-by-default, staking and reputation scores all fail a cost or a semantics test at this scale, and I say exactly why below.

**Two prior-wave parks genuinely unpark because of this dimension**: a **normative REST binding** (a stranger's LangGraph agent claiming a task with three HTTP calls is the acceptance test for the whole premise, and MCP tool-call plumbing is the wrong ask for a non-MCP framework) and **signed results** (the narrow, useful half of the parked per-message signature profile: sign the one object a local actor will act on, not every chat line). **Webhook wake-ups** unpark one step behind the REST binding. **Contract-net auction verbs stay parked** with a named trigger. **Tool passthrough should stay parked and this dimension argues against it**: the point of remote delegation is that the remote agent uses *its own* tools; passthrough would import a stranger's tools into the local trust boundary, which is the exact inverse.

### Recommendations

| # | Recommendation | Verdict | Effort | Spec impact |
|---|---|---|---|---|
| R1 | **Claim returns a `claim_id` fencing token**, per attempt, unguessable; `progress`/`complete`/`update`/`release` accept it; a stale one fails with the already-declared-but-unused `lease_expired` code. A valid `claim_id` from a *new* member id re-binds ownership (fixes the reconnect lockout) | adopt | 0.5 d | Spec 10.2: `claim` result gains `claim`, mutating verbs gain `claim_id`; section 15 uses `lease_expired` |
| R2 | **Claim lease + hub requeue**: `lease_ttl_s` (default 300), `task_lease_grace_s` (default 60, Chubby's lock-delay), `task_max_attempts` (default 3). Sweep clears owner, `attempts++`, back to `submitted`, emits `task_lease_expired` + `task{action:"requeued"}`; on exhaustion, `failed` | adopt | 0.5 d | Spec 10.2 state machine + new system events; room policies |
| R3 | **Presence renews the claim implicitly**: when `member.task === task.id`, any lease renewal (`room_listen`/`room_presence`) renews the claim. Zero new verbs for the v1 happy path | adopt | 2 h | Spec 7 + 10.2 cross-reference |
| R4 | **`progress` verb**: `{id, claim_id, note?, pct?, eta?}`, renews the lease, emits `task{action:"progress"}`, rate-limited to one event per `progress_min_interval_s` (default 15), result echoes `lease_expires` + `poll_interval_s` | adopt | 0.5 d | Spec 10.2 verb list + `rate_limited` |
| R5 | **Structured `result` on `complete`**, reusing the existing `Part` union plus a `digest` on file parts; hub computes `result_digest = sha256(JCS(result minus signature))`. `evidence.artifacts[]` accepts `sha256:` digests | adopt | 0.5 d | Spec 10.2 task object; `Part` gains `digest` |
| R6 | **Run the policy gate on task peer text** (`note`, `evidence.summary`, text parts of `result`): refuse or alert, audited, no parking machinery | adopt | 0.5 d | Spec 12.2: gate covers task actions, not only sends |
| R7 | **Provenance block on approval cards** whose params derive from a remote result (`task_id`, claimant, org, card digest + verified, `result_digest`, signature verified, `verification_status`), plus the rule that such a tool call is `interrupt_on` by default | adopt | 0.5 d | Spec 7.3 approval ext; 0.4 platform 4.x |
| R8 | **Retryable vs terminal failure**: `update {state:"failed", retryable:bool, failure:{code, detail, retry_after_s?}}`; `retryable:true` requeues (attempt++), false is terminal. Plus `decline` (looked and refused) returning the task to `submitted` with a `Refusal` | adopt | 0.5 d | Spec 10.2 verbs + reuse of `Refusal` |
| R9 | **Four clocks, named after Temporal's four timeouts**: `claim_by` (schedule-to-start), `attempt_timeout_s` (start-to-close), existing `reply_by` (schedule-to-close), `lease_ttl_s` (heartbeat). Two of the four are new fields, and `reply_by` stops being overloaded | adopt | 0.5 d | Spec 10.2 task object |
| R10 | **Rate/quota per remote member**: extend `member_rpm` to mutating `room_task` actions (today the counter only advances in the send path, `src/store.ts:918`), add `max_concurrent_claims` (default 3) and `task_claims_per_hour`; `rate_limited` with `retry_after_s` | adopt | 0.5 d | Spec 9.1 + room policies |
| R11 | **Normative REST binding for the task verbs** (`POST /rooms/{room}/tasks/{id}/claim|progress|complete`, `GET /rooms/{room}/tasks`), same auth as the MCP plane. This is what makes "a stranger's agent" true rather than aspirational | **unpark, adopt** | 1.5 d | New spec section 11.4 (was "planned v0.2") |
| R12 | **Sign the result, not every message**: detached JWS over the canonical result via the existing `src/signing.ts` path, verified against the same trusted key set as cards; `verification_status: self_reported \| counter_signed \| third_party_attested` (AIP's enum, verbatim) | **unpark, adapt** | 1 d | Spec 4.2 T2 (message signing narrowed to results); 10.2 |
| R13 | **`verify_scope` room policy** (`any \| different_org \| local \| human`, default `different_org` when the claimant is remote), enforced on the signing kid when cards are signed and advisory on `provider.organization` when they are not. Say "advisory" in the spec | adopt | 0.5 d | Spec 10.2 evidence gate + policies |
| R14 | **`delegation` field**: `{root_principal, depth, max_depth (default 3), chain[{member, org, at, context, budget_usd_ceiling}]}`. Hub enforces exactly two rules (`max_depth`, non-empty `context`) because those are the two a signed token cannot catch; everything else is audit annotation and must be labelled as such | adapt | 0.5 d | Spec 10.2 + 0.4 platform 7.4 |
| R15 | **Webhook wake-ups for remote members** (`notify: {url, token}` at join; signed POST carrying only `{room, event_type, task_id, seq}`, never content) so a remote worker need not long-poll | **unpark, defer** behind R11 | 1 d | Spec 11.x push plane |
| R16 | **Idempotency key on `create`** (creator-supplied; same key returns the existing task; same key with a different payload is `task_conflict`) | adopt | 2 h | Spec 10.2 `create` |
| R17 | Contract-net auction verbs (`cfp`/`propose`/`accept-proposal`/`reject-proposal`) | **defer**, trigger named below | 2 d when triggered | Reserved list stays; field names pre-agreed |
| R18 | Quorum / redundant execution as a default | **reject**; keep as an opt-in `spot_check_rate` on high-stakes tasks | 0.5 d for the opt-in | One optional field, no default behaviour |
| R19 | Zero-knowledge proofs of remote inference | **reject** | - | Nothing |
| R20 | TEE / remote attestation (RFC 9334) of the remote worker | **reject for now**, revisit only if a counterparty offers it | - | Reserve the `verification_status` value `third_party_attested` |
| R21 | Reputation scores, staking, economic bonds, payment rails | **reject**; the free version is a per-member accepted/rejected verify tally read off the existing log | - | Nothing |
| R22 | Cross-hub federation, Postgres swap, tool passthrough | **stay parked** (tasks give no new argument; passthrough is actively counter-indicated) | - | Nothing |

### The wire design

#### State machine (extends spec 10.2; no new terminal states)

```
submitted --claim(lease_ttl_s?)-------------> working        [claim{claim_id, attempt, lease_expires}]
working   --progress(claim_id)-------------> working         [lease renewed]
working   --presence(task=id)--------------> working         [lease renewed implicitly]
working   --release(claim_id, reason)-----> submitted        [owner cleared, attempts++]
working   --[lease_expires + grace < now]-> submitted        [hub sweep; attempts++; task_lease_expired]
working   --[attempts >= max_attempts]----> failed           [terminal; task{action:"exhausted"}]
working   --decline(reason)---------------> submitted        [owner cleared; refusal recorded; attempts unchanged]
working   --update(failed, retryable=true)-> submitted       [attempts++]
working   --update(failed, retryable=false)-> failed         [terminal]
working   --update(input_required)---------> input_required   [lease PAUSED]
input_required --update(working)----------> working          [lease re-armed]
working   --complete(no evidence_required)-> completed       [terminal]
working   --complete(evidence_required)---> working + verification.pending
verification.pending --verify accept------> completed        [terminal]
verification.pending --verify reject------> working          [rework; lease re-armed; attempts unchanged]
any non-terminal --cancel / cancel_task---> cancelled        [terminal; cooperative only]
terminal --anything---------------------> task_conflict
```

Two deliberate departures from a naive port:

- **`input_required` pauses the lease.** A remote worker blocked on a question it asked the room must not lose its claim because a human took an hour. This is the generalisation of ledger bug 6 (heartbeat starvation during an approval wait, `STATUS.md`).
- **A2A's `TASK_STATE_AUTH_REQUIRED` maps to `input_required` with `blocked_on: "auth"`, not to a new state.** This costs the 1:1 A2A mapping for one value and saves a state. Say so in the spec's mapping table rather than pretending the mapping is still total.

#### Task object additions

```jsonc
{
  // ... existing RfaTask fields (src/model.ts:96-115) unchanged ...
  "claim": {                       // null when unclaimed
    "claim_id": "cl_t19_1_9f3ac2b1",   // fencing token, per attempt, >=16 bytes entropy
    "attempt": 1,
    "claimed_by": "m_7f3ka9",
    "claimed_at": "2026-08-17T10:02:11Z",
    "lease_ttl_s": 300,
    "lease_expires": "2026-08-17T10:07:11Z",
    "progress": { "note": "fetched 3 of 5 sources", "pct": 60, "at": "2026-08-17T10:05:02Z" }
  },
  "attempts": 1,
  "max_attempts": 3,
  "claim_by": "2026-08-17T10:30:00Z",     // schedule-to-start; unclaimed past this -> task_overdue
  "attempt_timeout_s": 1800,              // start-to-close; one attempt's wall clock
  // reply_by stays schedule-to-close (the requester's SLA)
  "result": {
    "parts": [
      { "type": "text", "text": "Rule confirmed: billing address required above 50 EUR." },
      { "type": "json", "value": { "threshold_eur": 50 }, "schema": "https://example.org/rule.v1.json" },
      { "type": "file", "name": "audit.pdf", "mime": "application/pdf", "size": 183221,
        "url": "https://acme.example/artifacts/9f3a", "digest": "sha256:e3b0c44298fc1c14…" }
    ],
    "cost": { "usd": 0.19, "tokens": 41233, "model": "self-reported" },
    "tool_trace": [ { "name": "web.search", "at": "2026-08-17T10:03:00Z", "status": "ok" } ],
    "signature": { "protected": "eyJhbGciOiJFZERTQSIsImtpZCI6Ii4uLiJ9", "signature": "…" },
    "verification_status": "self_reported"
  },
  "result_digest": "sha256:Zm9vYmFy…",    // hub-computed, JCS over result minus signature
  "failure": { "code": "upstream_timeout", "detail": "vendor API 504", "retry_after_s": 120 },
  "retryable": false,
  "delegation": {
    "root_principal": "m_human_paul",
    "depth": 1, "max_depth": 3,
    "chain": [ { "member": "m_7f3ka9", "org": "acme.example",
                 "at": "2026-08-17T10:02:11Z",
                 "context": "acme's research agent holds the vendor contract corpus",
                 "budget_usd_ceiling": 0.50 } ]
  }
}
```

`verification` (existing) gains `{verifier_org, verifier_card_digest, verifier_origin}` so the log answers "who checked this, and were they the same shop as the claimant".

#### Verb table (additions only)

| Action | New arguments | Authorization | Emits |
|---|---|---|---|
| `create` | `idempotency_key?`, `claim_by?`, `attempt_timeout_s?`, `max_attempts?`, `evidence_required?` (exists), `delegation?` | any participant | `task{create}` |
| `claim` | `lease_ttl_s?` (clamped to `[30, 3600]`) | participant, task `submitted` + unowned + unblocked (existing rules) | `task{claim}` with `claim` block |
| `progress` | `claim_id*`, `note?`, `pct?`, `eta?` | claim holder | `task{progress}`, rate-limited |
| `complete` | `claim_id*`, `result?`, `evidence?` (exists) | claim holder OR `owner` | `task{complete}` / `task{complete_submitted}` |
| `release` | `claim_id*`, `reason?` | claim holder | `task{released}` |
| `decline` | `reason*` (`Refusal` shape), `detail?`, `retry_after_s?` | claim holder or an invited member | `task{declined}` |
| `update` | `retryable?`, `failure?`, `blocked_on?` | existing rules + `claim_id` when the caller is a claim holder | `task{update}` |
| `verify` | unchanged | subject to `verify_scope` policy | `task{verify_accept|verify_reject}` |
| `cancel` | unchanged, plus the normative "cooperative only" sentence | owner, creator, host | `task{cancel}` |

New `system` events: `task_lease_expired {task_id, owner, attempt, lease_expires}`, `task_requeued {task_id, attempt}`, `task_exhausted {task_id, attempts}`, `late_completion {task_id, claim_id, state}`. `gone_quiet` gains `refs.task_id` and MUST list the task creator in `refs.askers` (the same fix shape as 0.1.1's message-side `askers`).

**Error codes: none new.** `lease_expired` (declared at `src/errors.ts:21`, thrown nowhere today) becomes the stale-fence and expired-lease code, carrying `data: {current_attempt, current_owner, task_state}`. `task_conflict` covers terminal-state writes, duplicate idempotency keys with a different payload, and late completions. `rate_limited` covers progress flooding and claim quotas. `unauthorized` covers verify-scope violations. `policy_refused` covers gated peer text. Refusing to mint new codes is deliberate: the error surface is already at the edge of what a stranger's agent will bother to handle.

#### Composition with what exists

- **Evidence gate**: unchanged. `evidence_required` still means `complete` does not terminate the task; a different member must `verify`. The additions are `verify_scope` (R13) and provenance in `verification`. Do not redesign this; it was the right call and it is exactly the anti-phantom-delivery control a remote claimant needs.
- **Hash chain**: unchanged and free. Task events already run through `appendEvent` with `prev_hash` (`src/store.ts:2136`), so claim, progress, result digest, verify verdict and requeue all land in the chain in order. This is why every one of these mechanisms must be a room event and never a side channel: `draft-sharif-agent-audit-trail-00`'s rule `prev_hash(N) = hex(SHA-256(JCS(record(N-1))))` is byte-identical to what `src/jcs.ts` computes, so RFA's log already *is* the delegation audit trail.
- **Approval flow**: unchanged mechanism, one new payload field (R7). The remote result never becomes an action by itself; a local write is still a `canUseTool` interception blocking on a human-origin decision (`src/bridge.ts:60-101`).
- **Memory admission gate**: unchanged and load-bearing. `MemoryGate.inspectText` already rejects persisting peer verbatim, so a remote result cannot silently become a durable "fact" (`src/memoryfs.ts`, memory v2 consolidation rebuilds the gate window from the batch).
- **Moderation**: unchanged. `hold_member` already blocks mutating `room_task` actions; `quarantine` keyed by name + capability digest already refuses a re-join. Those are the levers an operator needs when a remote org misbehaves, and they exist.

### The smallest first version a stranger's agent could exercise

Ship as protocol 0.1.8 / hub 0.7.0. Ordered so each step is independently useful:

1. **R1 + R2 + R3** (claim lease, fence, sweep requeue, implicit renewal via presence). About 80 lines in `src/store.ts` plus the sweep branch next to the existing `task_overdue` loop.
2. **R6** (gate on task peer text). Hoist `evaluateGate` to take a content bundle, call it from `task()`.
3. **R5** (structured `result`, `result_digest`, `Part.digest`).
4. **R11** (REST binding, three routes plus a list, attached to the existing router in `src/main.ts:213-340`).
5. **R4 + R8 + R10** (progress, retryable failure/decline, per-member task quotas).
6. **R7** (approval provenance block).
7. **Conformance script**: `npm run remote-conformance -- <room-url> <credential>` that a stranger points at a demo room and that walks claim -> progress -> complete-with-evidence -> a deliberate lease expiry -> a stale-fence rejection, printing pass/fail per step. This doubles as the e2e test and as the documentation.

Deliberately NOT in the first version: result signing (R12; wait until a second org and a real trusted-key set exist), webhooks (R15), delegation chains (R14), contract net (R17), any attestation, any payment.

**Prerequisite from another dimension, and it is hard**: task claiming is only as safe as admission control. T0 is one shared join secret (`spec/RFA-0.1.md:91`), so one leak grants a stranger the right to claim tasks and post results into a human's approval card. The cheap step before T1 OAuth is per-member join credentials (one revocable secret per remote org, recorded on the roster). Whoever owns dimension 01/02 should ship that in the same release; this design assumes it.

### Ceremony rejected, explicitly

- **No new conformance profile.** Remote claiming folds into the existing `tasks` profile advertised in `server/discover` (`spec/RFA-0.1.md:594`). A `tasks-remote` tier with one implementation is a label, not interoperability.
- **No task auction in v1.** `claim` plus `max_concurrent_claims` plus capability-addressed `create` covers the realistic case (one competent claimant per skill). FIPA's field names are pre-agreed so v2 is mechanical.
- **No cost ledger in the hub.** The hub has zero cost knowledge today (wave 03 verified `grep usd src/store.ts` is empty) and inventing one to police another org's tokens is fiction: `total_cost_usd` is a client-side estimate even locally. `result.cost` is self-reported and must be rendered as such.
- **No streaming artifacts in v1.** A2A's `append` / `last_chunk` names are recorded below for the day it matters.
- **No `tasks/list`-style enumeration for remote members beyond the room they joined.** MCP's tasks extension removed `tasks/list` precisely because scoping it safely is unsolvable; RFA's scope is the room, which is a real boundary, so `list` stays room-scoped and never global.

---

## Evidence

### E1. A claim is a lease: forty years of prior art says the same thing

**Chubby (Burrows, OSDI 2006)** is the primary source for the fencing token and for the requeue grace period. From the paper's description of the lock service ([usenix.org/conference/osdi-06/chubby-lock-service-loosely-coupled-distributed-systems](https://www.usenix.org/conference/osdi-06/chubby-lock-service-loosely-coupled-distributed-systems), paper PDF mirrored at [andrew.cmu.edu/course/14-848/applications/ln/Chubby.pdf](https://www.andrew.cmu.edu/course/14-848/applications/ln/Chubby.pdf)): a client holding a lock may request a **sequencer**, passes it to the server it wants to act against, and that server validates the sequencer before acting; for servers that cannot check sequencers, Chubby offers a **lock-delay** (typically one minute) during which the lock is not reissued after a holder fails. Both ideas map exactly: `claim_id` is the sequencer that the hub (playing the role of the file server) validates on every mutating task action, and `task_lease_grace_s` is the lock-delay that stops a flapping remote worker from losing its task to a race.

**Amazon SQS visibility timeout** is the same mechanism at industrial scale ([docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)), verbatim:

> "The visibility timeout starts as soon as a message is delivered to you. During this period, you're expected to process and delete the message. If you don't delete it before the timeout expires, the message becomes visible again in the queue and can be retrieved by another consumer. The default visibility timeout for a queue is 30 seconds"

> "If you don't process and delete a message before the visibility timeout expires [...] the message becomes visible again in the queue."  (the elided clause reads "due to application errors, crashes, or connectivity problems")

> "Implement a heartbeat mechanism to periodically extend the visibility timeout, ensuring the message remains invisible until processing is complete."

> "the visibility timeout has a maximum limit of 12 hours from when the message is first received. Extending the timeout doesn't reset this 12-hour limit."

> "due to the at-least-once delivery model of Amazon SQS, there's no absolute guarantee that a message won't be delivered more than once during the visibility timeout period."

Also: `ChangeMessageVisibility` with `VisibilityTimeout` set to 0 is the *voluntary release* (RFA's `release` verb), and a dead-letter queue after N receives is the *attempt exhaustion* (RFA's `max_attempts` then `failed`).

**Kafka consumer groups** give the two-clock pattern with real defaults ([kafka.apache.org/40/generated/consumer_config.html](https://kafka.apache.org/40/generated/consumer_config.html)), verbatim: `session.timeout.ms` default **45000**, "If no heartbeats are received by the broker before the expiration of this session timeout, then the broker will remove this client from the group and initiate a rebalance"; `heartbeat.interval.ms` default **3000**; `max.poll.interval.ms` default **300000**, "If poll() is not called before expiration of this timeout, then the consumer is considered failed and the group will rebalance in order to reassign the partitions to another member." The RFA analogue of the 15:1 heartbeat-to-timeout ratio: with `lease_ttl_s: 300`, a remote worker should renew every 30 to 60 seconds, which is what the presence lease already does by default (`defaultLeaseS: 180`, `src/store.ts:103`).

**Temporal** supplies the field names for the four clocks ([docs.temporal.io/encyclopedia/detecting-activity-failures](https://docs.temporal.io/encyclopedia/detecting-activity-failures)): Schedule-To-Start, Start-To-Close, Schedule-To-Close, and the Heartbeat Timeout ("the maximum time between Activity Heartbeats"; on expiry "the Activity Task fails and a retry occurs if a Retry Policy dictates it"). The decisive sentence for why a lease is mandatory rather than nice: "The Temporal Server doesn't detect failures when a Worker loses communication with the Server or crashes. Therefore, the Temporal Server relies on the Start-To-Close Timeout to force Activity retries." A hub cannot detect a dark remote agent either; only a clock can.

**MCP's own tasks extension has the same lease, spelled `ttlMs`** ([modelcontextprotocol.io tasks extension, local copy `research/01-protocol/papers/mcp-ext-tasks-spec.md`; SEP-2663 status **Final**, created 2026-04-27, `research/01-protocol/papers/mcp-sep-2663-tasks-extension.md`]): "Time-to-live duration from creation in integer milliseconds, null for unlimited. The server may discard the task after the TTL elapses. This value MAY change over the lifetime of a task." And: "servers **MAY** mark a task as `failed` at any point after the TTL elapses, and subsequently delete it at any time." Note the direction: in MCP the *server* holds the task and the *client* polls; in RFA the *hub* holds the task and the remote worker acts on it. The lease belongs on whichever side can go dark, which is the worker.

Historical anchor for the concept: Gray and Cheriton, "Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency", SOSP 1989 ([dl.acm.org/doi/10.1145/74850.74870](https://dl.acm.org/doi/10.1145/74850.74870)). RFA already uses leases for presence, which is why R3 (presence renews the claim) is free rather than new.

### E2. At-most-once vs at-least-once, duplicate suppression, idempotency

Every mature queue makes the same admission, and RFA's spec should copy the sentence rather than invent a softer one.

**Sidekiq** ([github.com/sidekiq/sidekiq/wiki/Best-Practices](https://github.com/sidekiq/sidekiq/wiki/Best-Practices)), verbatim: "Sidekiq will execute your job **at least** once, not **exactly** once", "your job might be half-processed, throw an error, and then be re-executed over and over until it successfully completes", and the arguments rule that also applies to a cross-org task payload: "The arguments you pass to `perform_async` **must** be composed of simple JSON datatypes".

**Celery** ([docs.celeryq.dev/en/stable/userguide/configuration.html](https://docs.celeryq.dev/en/stable/userguide/configuration.html)): `task_acks_late` default **Disabled**, "Late ack means the task messages will be acknowledged after the task has been executed, not right before"; `task_acks_on_failure_or_timeout` default **Enabled**; `task_reject_on_worker_lost` default **Disabled**, with the warning "Enabling this can cause message loops; make sure you know what you're doing"; `broker_transport_options = {'visibility_timeout': 18000}` for Redis/SQS transports. The RFA read: `complete` is the late ack. A remote worker that dies after doing the work but before calling `complete` has produced an unacknowledged side effect, and no protocol can fix that. Only the requester's idempotency can.

**SQS FIFO deduplication** is the shape of the dedupe window ([docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-exactly-once-processing.html)): "If you retry the `SendMessage` action within the 5-minute deduplication interval, Amazon SQS doesn't introduce any duplicates into the queue", with either an explicit `MessageDeduplicationId` or content-based deduplication using "a SHA-256 hash to generate the message deduplication ID using the body of the message". RFA already ships the content-based variant for messages: `bodyHashes` over `sha256hex(canonicalize(body))` within `dupWindowS` (30 s) at `src/store.ts:801-805`. R16 is the explicit-id variant for `create`.

**`Idempotency-Key`** gives the header name and the three server behaviours ([draft-ietf-httpapi-idempotency-key-header-07](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header), published 15 October 2025, **expired 18 April 2026**, no -08 published as of this writing, so treat as a de-facto convention rather than a standard): value is an Item Structured Header String; "an idempotency key is a unique value generated by the client which the resource uses to recognize subsequent retries of the same request"; keys "MUST be unique and MUST NOT be reused with another request with a different request payload"; a retried key after completion returns the previously completed result; a concurrent retry returns **409**; a key reused with a different payload returns **422**. RFA maps 409 and 422 both onto `task_conflict` with `data` explaining which, because adding two codes for a case a stranger's agent hits once is not worth the surface.

**Temporal retry policy** supplies the retryable/non-retryable split ([docs.temporal.io/encyclopedia/retry-policies](https://docs.temporal.io/encyclopedia/retry-policies)): Initial Interval 1 second, Backoff Coefficient 2.0, Maximum Interval 100x initial, Maximum Attempts unlimited, Non-Retryable Errors empty by default, and the guidance "Permanent failures, by definition, require you to make some change to your logic or your input. Therefore, it is better to surface them than to retry them." That is R8: a remote failure without a `retryable` flag forces the hub to guess, and the current code guesses "terminal" (`failed` is in `TERMINAL_TASK_STATES`, `src/model.ts:89`), which silently discards recoverable work.

RFA's normative sentence should be, in the spec, plainly: **task execution is at-least-once; a side-effecting task MUST be idempotent or fenced by `claim_id`, and the hub does not and cannot guarantee a single execution.**

### E3. Progress reporting from a peer you cannot inspect

Three specs, three answers, and they agree on the honest limit: progress is a self-report whose only enforceable property is its cadence.

**MCP progress notifications** ([modelcontextprotocol.io/specification/2026-07-28/basic/utilities/progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/progress)), verbatim: a `progressToken` in `params._meta`, "MUST be a string or integer value", "MUST be unique across all active requests"; the notification is `notifications/progress` with `{progressToken, progress, total?, message?}`; "The `progress` value **MUST** increase with each notification, even if the total is unknown"; "The `message` field **SHOULD** provide relevant human readable progress information"; and "Both parties **SHOULD** implement rate limiting to prevent flooding". RFA copies the monotonic rule for `pct`, the free-text `note` for `message`, and the rate limit as an enforced `progress_min_interval_s`.

**MCP tasks extension** replaces push with a poll budget: `statusMessage` ("Progress descriptions for `working`"), `pollIntervalMs` ("Suggested polling interval in integer milliseconds. Clients SHOULD honor this value to avoid overwhelming the server. This value MAY change over the lifetime of a task"), and "Servers **MAY** rate-limit clients polling more frequently than the recorded `pollIntervalMs`". RFA returns `poll_interval_s` from `claim`/`progress` for the same reason: a remote agent needs to be told the cadence, not guess it.

**A2A** streams progress as events ([a2a-protocol.org/latest/definitions/](https://a2a-protocol.org/latest/definitions/), v1.0, released 2026-04-09 under Linux Foundation governance per [linuxfoundation.org press release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) and [a2a-protocol.org/latest/announcing-1.0/](https://a2a-protocol.org/latest/announcing-1.0/)): `TaskStatusUpdateEvent {task_id, context_id, status, metadata}` where `TaskStatus {state, message, timestamp}`; the stream "MUST begin with the Task object, followed by zero or more TaskStatusUpdateEvent or TaskArtifactUpdateEvent objects" and "MUST close when the task reaches a terminal state". For the disconnect case A2A points at re-subscription: "If an SSE connection drops while a task remains active, the client can attempt to reconnect to the stream using the `SubscribeToTask` RPC method" ([a2a-protocol.org/latest/topics/streaming-and-async/](https://a2a-protocol.org/latest/topics/streaming-and-async/)). RFA needs none of this: `room_listen` with a cursor is already a resumable stream, and `room_watch` is the push binding.

**A2A push notifications** are the model for R15, including the security shape ([same page](https://a2a-protocol.org/latest/topics/streaming-and-async/)): `PushNotificationConfig {url, token, authentication}`; the recommended scheme is a JWT signed by the sender with `kid` in the header, public key from a JWKS endpoint, and the receiver validating `iss`, `aud`, `iat`, `exp`, `jti`; "Use unique identifiers like JWT's `jti` claim to prevent duplicate processing"; and the pattern of notify-then-fetch, where the webhook body is a trigger and the client then calls `GetTask` for the real content. RFA's version should carry *only* `{room, event_type, task_id, seq}` for exactly that reason: the notification is a doorbell, and a leaked doorbell must not leak content.

**LangGraph Platform** is the most likely shape of an actual remote counterparty and it prefers a completion webhook over progress ([docs.langchain.com/langgraph-platform/langgraph-server](https://docs.langchain.com/langgraph-platform/langgraph-server); detail captured verbatim in `research/02-platform/notes/02-langgraph-runtime.md:277-355`): run creation accepts `webhook` ("called when the run completes"), `multitaskStrategy: reject | interrupt | rollback | enqueue`, `interruptBefore`/`interruptAfter`; `POST /threads/{id}/runs/{run_id}/cancel?action=interrupt|rollback`; `GET /threads/{id}/runs/{run_id}/join` blocks for the result; `GET …/stream` resumes with `Last-Event-ID`. Read this as the integration contract: a LangGraph agent will happily POST once at the end and does not want to hold a connection. So the RFA design must make a *single* `complete` call sufficient, with `progress` strictly optional. It is.

### E4. Artifacts: results that are large, or are files

**A2A** is the most developed answer and its names are worth copying ([a2a-protocol.org/latest/definitions/](https://a2a-protocol.org/latest/definitions/)). `Artifact {artifact_id, name, description, parts, metadata, extensions}` hangs off `Task {id, context_id, status, artifacts, history, metadata}`. Streaming an artifact uses `TaskArtifactUpdateEvent {task_id, context_id, artifact, append, last_chunk, metadata}`: `append` says "add to the artifact you already have", `last_chunk` says "that was the end". The v1.0 `Part` collapses the older FilePart/FileWithBytes/FileWithUri split into one shape with a `oneof` content: `text`, `raw` (bytes), `url`, `data`, plus `metadata`, `filename`, `media_type`. RFA's existing `Part` (`src/model.ts:30-33`) already has the same three-way choice (`text` / `json` / `file` with `url` or `content_base64`, plus `name`, `mime`, `size`). The one missing field is a **digest**, and it is the field that matters most across a trust boundary: without it, a `url` artifact is a promise, and the bytes can change after the verifier looked.

**MCP** offers the by-reference form for tool results ([modelcontextprotocol.io/specification/2026-07-28/server/tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)): `{"type": "resource_link", "uri": "file:///project/src/main.rs", "name": "main.rs", "description": "…", "mimeType": "text/x-rust"}`, with the caveat "Resource links returned by tools are not guaranteed to appear in the results of a `resources/list` request". It also offers the typed form: `structuredContent` validated against the tool's `outputSchema`, where "Servers MUST provide structured results that conform to this schema" and "Clients SHOULD validate structured results against this schema". That is the right precedent for RFA's `json` part with a `schema` URL, and it is how a requester gets a machine-checkable result instead of prose. A schema check is not truth, but it is the cheapest possible non-trivial check on a stranger's output, and it is the only one that costs nothing per task.

RFA's practical limit today: `maxInlineBytes: 262_144` (256 KiB) enforced on message bodies at `src/store.ts:780` with `payload_too_large`. Task evidence is currently unbounded because `task()` never checks size. So R5 must also bound `result` (same 256 KiB, same error), and anything larger travels as a `file` part with `url` + `digest`. Where the bytes live is deliberately out of scope for the protocol: the remote org's own storage with a short-lived signed URL is the default, and the hub stores only the digest. This keeps the hub something a small team can run (no blob store, no S3 dependency) and it keeps a hostile artifact out of the hub's disk. The platform spec already sets the local precedent: "Payloads/tool results above ~20k tokens offload to files with a 10-line preview; references travel in envelopes" (`spec/RFA-0.4-platform.md:127`).

### E5. Evidence and verification when you cannot see the tools

**RFC 9334 (RATS Architecture, January 2023, Informational)** is the correct vocabulary and also the source of the honest limit ([rfc-editor.org/rfc/rfc9334.html](https://www.rfc-editor.org/rfc/rfc9334.html)). Roles: **Attester** (produces Evidence), **Verifier** (appraises Evidence against Reference Values and Endorsements, produces Attestation Results), **Relying Party** (acts on Attestation Results), **Endorser**, **Reference Value Provider**, plus the two Owners who set appraisal policy. Two topologies: **passport model** (Attester gets Attestation Results and presents them onward) and **background-check model** (Relying Party forwards Evidence to a Verifier). Freshness comes from synchronised clocks, nonces, or epoch IDs.

Mapping RFA onto those roles is instructive and slightly deflating: the remote agent is the Attester, the hub is at best a Relying Party, and **there is no Verifier and no Reference Value Provider**, because nobody has a reference measurement of "what a correct answer to this question looks like". Attestation, when it exists, proves *which code ran*. It never proves the answer is right. Any design that presents attestation as result verification is selling the wrong property.

**The one production example of attested remote inference** is Apple Private Cloud Compute ([security.apple.com/blog/private-cloud-compute/](https://security.apple.com/blog/private-cloud-compute/), [security.apple.com/blog/pcc-security-research/](https://security.apple.com/blog/pcc-security-research/)): PCC nodes present a signed measurement of the software image they run, the client daemon validates it, and Apple publishes every production release's measurements in an append-only cryptographically verifiable transparency log so devices refuse to send requests to software that is not in the log. That is real engineering, and it is also exactly why R20 is a reject: it required a vertically integrated vendor to build attested hardware, an attestation service, a transparency log and a client enforcement daemon. No LangChain agent, no other org's product agent, and no commercial model API in 2026 offers a per-response attestation a hub could check. Keep the `third_party_attested` enum value reserved for the day a counterparty offers it.

**in-toto attestations** give the shape of a receipt that binds a claim to bytes ([github.com/in-toto/attestation/blob/main/spec/v1/statement.md](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)), verbatim fields: `_type` = `"https://in-toto.io/Statement/v1"`, `subject` (array of resource descriptors with `name` and `digest: {"<ALGORITHM>": "<HEX_VALUE>"}`), `predicateType` (URI), `predicate` (object, "MAY be omitted if predicateType fully describes the predicate"). The transferable idea is `subject.digest`: an attestation is *about* specific bytes. RFA's `result_digest` plus per-file `digest` is the same idea with a tenth of the machinery, and it is what makes the hash chain useful: the log records a digest, so a later dispute about "what did they actually send us" is decidable.

**AIP (arXiv 2603.24775, March 2026, local copy `research/01-protocol/papers/aip-agent-identity-protocol.pdf`)** already gave wave 03 the completion-block design, and it is the best available fit. Verbatim, the Block N+1 (Completion) content: "the executing agent may append a completion block recording the result hash, verification status, resource consumption, and cost." Its trust-escalation enum, adopted verbatim in R12: "(1) **self-reported** (default), where the executing agent reports its own results; (2) **counter-signed**, where the delegator independently verifies the result and appends an attestation block; and (3) **third-party attested**, where an external verifier… human reviewer, or audit service signs an attestation block." And the sentence that should appear in RFA's spec because it names the honest default: self-reported is the default, and it is the only tier a remote agent can reach unilaterally.

**The 2026 "agent receipts" space is a pile of individual drafts with no adoption. Adopt the shape, not any draft.** Two representative examples, both individual submissions, both flagged: `draft-farley-acta-signed-receipts-01` ("Signed Decision Receipts for Machine-to-Machine Access Control", published 25 April 2026, expires 27 October 2026, Informational, individual submission by T. Farley, [ietf.org/archive/id/draft-farley-acta-signed-receipts-01.html](https://www.ietf.org/archive/id/draft-farley-acta-signed-receipts-01.html)) specifies a `{payload, signature{alg, kid, sig}}` envelope, Ed25519 baseline with `"alg": "EdDSA"`, JCS per RFC 8785 before signing, key resolution via `kid` at a recommended `/.well-known/acta-keys.json`, and the property that matters: "Any party with the issuer's public key can verify a receipt without network access or API calls." And `draft-mih-agent-bilateral-attestation-01` ("Bilateral Attestation of Cross-Organization Agent Actions", 19 July 2026, expires 20 January 2027, individual submission, [datatracker.ietf.org/doc/html/draft-mih-agent-bilateral-attestation-01](https://datatracker.ietf.org/doc/html/draft-mih-agent-bilateral-attestation-01)) proposes exactly the two-sided shape this dimension needs, a request attestation from the asking org and an action attestation from the performing org, where action attestations reference request attestations "by digest" and record "constraint results and the disposition" over the vocabulary "executed, blocked, denied, timeout, errored, deferred, expired, escalated". Its honest state: "Wire encodings for the four objects are TBD for a future revision", with a promise that a future revision "MUST specify JCS… as the deterministic canonicalization". So: nothing to implement against, but the disposition vocabulary is a better failure taxonomy than RFA's four terminal states, and `failure.code` should draw from it.

**The decisive practical fact: RFA can produce a signed, digest-bound result receipt today with about fifty lines**, because `src/signing.ts` already does JWS over JCS with `EdDSA` or `ES256`, `kid` = RFC 7638 thumbprint, a provisioned trusted-key map, and an embedded-JWK self-certifying path with thumbprint pinning. The same `cardPayload`-style canonicalisation applied to a `result` object is the whole feature. That is why R12 is an unpark rather than a defer: the parked item was "sign every message", the useful item is "sign the one object someone will act on", and the code is already written.

### E6. Redundant execution and quorum: what the data actually says

**Knight and Leveson, 1986** is the classic refutation of the independence assumption ([paper PDF](https://www.csc.kth.se/utbildning/kth/kurser/DA2210/vettig13/Seminarier/KnightLeveson.pdf)): 27 independently written versions of the same specification, one million test cases, individually reliable programs, and coincident failures far above what independence predicts.

**The 2026 replication with coding agents is the source to cite**, because it tests precisely the configuration a room of remote agents would be ([arXiv 2606.20158v1, "N-Version Programming with Coding Agents", Javier Ron, Benoit Baudry, Martin Monperrus, 18 June 2026](https://arxiv.org/html/2606.20158v1)): 48 implementations of the Launch Interceptor Program across 5 agent systems, 23 models and 3 languages, one million randomised test cases against a reference oracle. Result: "the experiment produces 429 coincident-failure cases where the independence model predicts only 115.36", a **3.7x excess**, z = 29.20. And the other half, which is why R18 is "opt-in" rather than "never": majority voting over triples cut the mean failure count from **387.44 to 130.99**, and **11,844 of 17,296** three-version units showed zero observed failures.

Read both numbers together and the conclusion is sharp: **agreement between two remote agents is weak evidence of correctness (they fail together 3.7x more often than chance), but voting still helps a lot when you can afford it.** So quorum is a legitimate tool for a high-stakes task, at a cost the wave 03 cost table already priced (2.3x for a critic pass, up to 5.8x tokens and 5.9x latency for orchestrated multi-agent on single-domain work, `research/03-reach-and-collaboration/notes/03-multi-agent.md:3.3`). Hence the design: one optional `spot_check_rate` field on a task, no default behaviour, and no protocol machinery for vote aggregation. If a room wants two answers it creates two tasks; the board already supports that, and `parent_id` already groups them.

### E7. Economic and cryptographic verification: what is theater

**Zero-knowledge proofs of LLM inference: reject.** zkLLM ([arXiv 2404.16109](https://arxiv.org/abs/2404.16109), ACM CCS 2024, [dl.acm.org/doi/10.1145/3658644.3670334](https://dl.acm.org/doi/10.1145/3658644.3670334)) is the state of the art and its own numbers disqualify it here: for a 13-billion-parameter model, proof generation for one inference takes **under 15 minutes** with a fully parallelised CUDA implementation, producing a proof under **200 kB**. Three reasons that is the wrong tool, in order of severity: (1) it proves that a *committed set of weights* was applied to an input, which requires open weights and a weight commitment the verifier trusts, so it cannot cover a commercial API model; (2) a remote *agent* is not one inference, it is a loop of inferences interleaved with tool calls against private systems, and the tool calls are the part you actually cannot see; (3) 15 GPU-minutes and a CUDA rig per answer, to verify a task whose honest execution cost 19 cents, is an inversion no org will pay.

**Staking, bonds and verification games: reject, and the reason is not squeamishness about crypto, it is the verifier's dilemma.** Luu, Teutsch, Kulkarni, Saxena, "Demystifying Incentives in the Consensus Computer", ACM CCS 2015 ([eprint.iacr.org/2015/702.pdf](https://eprint.iacr.org/2015/702.pdf), [dl.acm.org/doi/10.1145/2810103.2813659](https://dl.acm.org/doi/10.1145/2810103.2813659)) shows that when verifying is expensive, rational participants skip verification to stay competitive, so the punishment mechanism never fires because nobody checks. Every bonding scheme for agent work inherits this: the bond only deters if detection is likely, detection requires re-execution, and re-execution is exactly the cost you were trying to avoid. On top of that a bond needs money rails, an arbiter and a dispute procedure, none of which a self-hosted hub has or should have. What survives from this literature is the cheap part RFA already has: make the record undeniable so a *human* can adjudicate later.

**Reputation scores: reject as a protocol feature, keep the free version.** EigenTrust (Kamvar, Schlosser, Garcia-Molina, WWW 2003, [nlp.stanford.edu/pubs/eigentrust.pdf](https://nlp.stanford.edu/pubs/eigentrust.pdf), [dl.acm.org/doi/10.1145/775152.775242](https://dl.acm.org/doi/10.1145/775152.775242)) computes global trust as local trust values weighted by the raters' own global reputations, via power iteration over a peer network. It needs two things RFA rooms do not have: many raters, and identity that is expensive to mint. A room with five members produces a reputation estimate that is noise, and wave 03 already made the sample-size argument for this project's data volumes ("35 real agent serve turns in its entire life"). The free and honest substitute: the log already records every `verify accept`/`verify_reject` with actor and task, so a per-member tally is a SQL query over `data/obs.db` and the room log, computed on demand, never a protocol field. Where identity *is* scarce is the useful lever, and it is admission control: a human admits each remote org, which is worth more than any score.

**Deterministic re-execution: mostly not applicable, occasionally free.** Re-running a remote agent's work is impossible when the work touched its own private systems, which is the entire reason to delegate to it. It is affordable in exactly one shape: the result is a *checkable artifact* rather than a judgement (a computation, a query result, a document that must satisfy a schema or a lint). For those, the cheap check is the one already in the repo: the eval harness's protocol lints and `r_state x r_output x r_protocol` reward (`src/evals/trajectory.ts`, v0.4.4), pointed at a remote result instead of a local one. That is the single highest-value verification investment in this dimension and it needs no protocol change at all.

### E8. Partial failure and refusal semantics

**FIPA already solved the vocabulary in 2002 and the acts map cleanly.** From `FIPA Contract Net Interaction Protocol Specification`, document number **SC00029H**, status **Standard**, dated **2002/12/03** (local copy `research/01-protocol/papers/fipa-sc00029-contract-net.pdf`), verbatim: "Once the Participant has completed the task, it sends a completion message to the Initiator in the form of an `inform-done` or a more explanatory version in the form of an `inform-result`. However, if the Participant fails to complete the task, a `failure` message is sent." Plus the third case, which RFA lacks: "At any point in the IP, the receiver of a communication can inform the sender that it did not understand what was communicated. This is accomplished by returning a `not-understood` message… The communication of a `not-understood` within an interaction protocol may terminate the entire IP and termination of the interaction may imply that any commitments made during the interaction are null and void."

Four distinct outcomes, and RFA today has two states for them: `failed` and `rejected`. The design needs the full four because a remote agent will produce all four:

| FIPA act | Meaning | RFA today | RFA after R8 |
|---|---|---|---|
| `inform-done` | done, nothing to report | `complete` without evidence | unchanged |
| `inform-result` | done, here is the result | `complete` with evidence | `complete` with `result` |
| `failure` | tried, could not | `update state=failed` (terminal, guesses) | `failed` + `retryable` + `failure{code, detail}` |
| `refuse` | will not, before committing | nothing | `decline` with a `Refusal` |
| `not-understood` | your request is malformed | nothing | `decline` with `reason: "ineligible"` + detail, or `input_required` |

**A2A's state enum names the two cases RFA merges** ([a2a-protocol.org/latest/definitions/](https://a2a-protocol.org/latest/definitions/)): `TASK_STATE_REJECTED` ("agent declined to perform", terminal) is distinct from `TASK_STATE_FAILED` ("finished with error", terminal), and `TASK_STATE_AUTH_REQUIRED` ("authentication required", interrupted) is a first-class state, which matters precisely for a cross-org worker whose credential for its own upstream expired mid-task. RFA maps that onto `input_required` with `blocked_on: "auth"` rather than growing a state; the cost is one line in the mapping table.

**MCP's tasks extension draws the protocol-vs-semantic error line explicitly**, and it is a line RFA should copy for `result` handling: "The `failed` status **MUST NOT** be used to represent non-JSON-RPC errors, such as a tool result that completed with `isError: true`. Errors within the context of a protocol method result **MUST** use the `completed` status with the error details in the `result` field. This maintains a strong separation between protocol-level faults (which use the `failed` status) and other faults." Translated: a remote agent that successfully determined "there is no answer" has *completed* the task, and should not be recorded as having failed it. `result.parts` carrying a negative finding with `evidence.summary` is a completion. Only the machinery breaking is a failure.

### E9. Cancellation from the requester's side

Every spec that has thought about this says the same thing, and RFA's spec should say it too instead of implying otherwise. MCP tasks extension, verbatim: "Cancellation is **cooperative**: The request signals intent, and the server decides whether and when to honor it. A server is not obligated to actually stop the work; it is only obligated to acknowledge the request. Eventual transition to `cancelled` is not guaranteed." Also: "Cancellation processing is *eventually consistent*[...] the task's observable status **MAY** remain `working`… and **MAY** ultimately reach a terminal status other than `cancelled` if the work finished before cancellation could take effect", and the notification-channel rule "The `notifications/cancelled` notification **MUST NOT** be used for task cancellation."

A2A adds the refusal case: cancellation can fail with `TaskNotCancelableError` ([a2a-protocol.org/latest/specification/](https://a2a-protocol.org/latest/specification/)), and terminality is absolute: "Once a task reaches a terminal state (completed, canceled, rejected, or failed), it cannot restart. Any subsequent interaction related to that task, such as a refinement, must initiate a new task within the same `contextId`" ([a2a-protocol.org/latest/topics/life-of-a-task/](https://a2a-protocol.org/latest/topics/life-of-a-task/)). RFA matches this already (`TERMINAL_TASK_STATES`, `src/model.ts:89`; terminal writes throw `task_conflict`), which is worth noting as a place the existing design is right and needs no change.

LangGraph offers the stronger primitive because it owns the executor: `cancel?action=interrupt|rollback`, where rollback "cancel[s] and delete[s] the existing run, roll[s] the thread back to the state before it started" (`research/02-platform/notes/02-langgraph-runtime.md:312`). A hub can never offer rollback across a trust boundary. So the normative sentence for RFA is: **`cancel` marks the task and notifies; it does not stop a remote process and it does not undo a side effect the remote worker already caused.** With the corollary that a late `complete` after `cancel` must be recorded (`system {event: "late_completion"}`) rather than silently dropped, because that event is the operator's only signal that a cancelled task may have produced a real-world write anyway.

### E10. Contract net: what to copy verbatim if the auction ever ships

All from `FIPA SC00029H` (Standard, 2002/12/03), local PDF, pages 2 to 3:

- Protocol token: "`fipa-contract-net` as the value of the `protocol` parameter of the ACL message."
- Roles: Initiator (the manager, "wishes to have some task performed by one or more other agents") and Participants ("potential contractors").
- Flow: `cfp` (call for proposals, "specifies the task, as well any conditions the Initiator is placing upon the execution of the task") -> each Participant answers `propose` or `refuse` -> Initiator sends `accept-proposal` to the chosen l agents and `reject-proposal` to the other k -> the accepted Participant answers `failure`, `inform-done`, or `inform-result`.
- The commitment rule, which is the whole reason an auction is more than a poll: "The proposals are binding on the Participant, so that once the Initiator accepts the proposal, the Participant acquires a commitment to perform the task."
- The deadline rule, and note RFA already has the field name: "the `cfp` includes a deadline by which replies should be received by the Initiator. Proposals received after the deadline are automatically rejected with the given reason that the proposal was late. The deadline is specified by the `reply-by` parameter of the ACL message."
- Threading: "Any interaction using this interaction protocol is identified by a globally unique, non-null `conversation-id` parameter, assigned by the Initiator." RFA's `conversation_id` on both envelopes and tasks is the same field.
- Cancellation is a separate meta-protocol: "At any point in the IP, the initiator of the IP may cancel the interaction protocol… The semantics of cancel should roughly be interpreted as meaning that the initiator is no longer interested in continuing the interaction, and that it should be terminated in a manner acceptable to both the Initiator and the Participant. The Participant either informs the Initiator that the interaction is done using an `inform-done`, or indicates the failure of the cancellation using a `failure`."

**Trigger for unparking R17**: more than one remote member in a room advertises a skill that matches the same task, and the log shows either repeated `task_conflict` on claim races or systematic claiming by the wrong-fit member. Until then `claim` plus `max_concurrent_claims` plus addressing the `create` event at matching capabilities is the same outcome for one tenth of the machinery, and the field names above make v2 a rename exercise rather than a redesign.

### E11. Accounting across orgs: who pays, and what the hub should refuse to track

**The correct semantics come from AIP and they are a ceiling, not a balance.** Verbatim (arXiv 2603.24775, quoted in `research/03-reach-and-collaboration/notes/03-multi-agent.md:4.1`):

> "Budget values in IBCTs are expressed as integer cents (forced by Biscuit Datalog's lack of floating-point types). Budget fields represent **per-token authorization ceilings**, not running balances. When Agent A delegates to Agent B with budget:50, A asserts that B may spend up to 50 cents on this task. At invocation time, the verifier checks that the declared budget is non-negative; it does not track cumulative spend. Completion blocks record actual cost for audit. **Aggregate spend enforcement is the runtime's responsibility, not the token's.**"

Applied to a cross-org room, the answer to "who pays for a remote agent's tokens" is: **the remote org pays, because it holds the keys and the runtime, and nothing else is enforceable.** The hub should therefore track exactly three things and refuse the fourth:

1. `budget_usd_ceiling` on the task or in the `delegation` chain: a declaration of what the work is worth to the requester, useful because it lets a remote agent `decline` early instead of burning 4 dollars on a 20-cent question. Advisory, and label it advisory.
2. `result.cost` self-reported by the claimant, recorded for audit exactly as AIP's completion block does ("resource consumption, and cost").
3. Rate and concurrency quotas per member, which are the *real* control, because they bound the blast radius in the unit the hub actually controls (calls), not in a currency it cannot observe.
4. Refuse: a cross-org cost ledger, invoicing, netting, or any attempt to charge another org's spend against a local budget. Wave 03 verified the hub has zero cost knowledge (`grep usd src/store.ts` is empty) and that even locally `total_cost_usd` is a client-side estimate against a subscription. Building a ledger on two layers of estimate produces numbers that look authoritative and are not.

**The delegation-chain field the prior wave proposed carries this** (`research/03-reach-and-collaboration/notes/03-multi-agent.md:4.1-4.3`): `root_principal` (the human at the top, which RFA can stamp for free because origin is hub-derived), the ordered chain with per-hop `context` and narrowing ceilings, `depth`/`max_depth`, and per-hop identity. Two enforcement facts, both from AIP's adversarial table (100 iterations per attack, six categories, AIP 100% rejected, unsigned 0%, plain signed JWT 67%): a plain signed token catches scope widening, expired replay, wrong-key verification and forgery, and **misses exactly two things, `max_depth` violations and empty-context audit evasion**, because both are semantic rather than cryptographic. Those two are therefore precisely what RFA's hub must check itself, and it can, with no crypto at all. Everything else in the chain is an audit annotation and the spec must say so rather than implying enforcement.

**The interoperable expression of the same idea already exists in OAuth**, and matching its shape costs nothing: RFC 8693 (OAuth 2.0 Token Exchange, January 2020, Standards Track, [rfc-editor.org/rfc/rfc8693.html](https://www.rfc-editor.org/rfc/rfc8693.html)) defines `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` with `subject_token`/`subject_token_type` (REQUIRED), `actor_token`/`actor_token_type`, `audience`, `resource`, `scope`, `requested_token_type`; and the `act` claim: "The `act` (actor) claim provides a means within a JWT to express that delegation has occurred and identify the acting party", where "A chain of delegation can be expressed by nesting one `act` claim within another", outermost being the current actor, plus `may_act` ("makes a statement that one party is authorized to become the actor and act on behalf of another party"). RFA's `delegation.chain` should be ordered root-first with the current actor last, so it converts to a nested `act` chain mechanically the day T1 ships. Write that mapping into the spec now; it is one sentence and it prevents a rewrite.

**The payments answer, for completeness and to close the door**: AP2 (Agent Payments Protocol, an extension in the A2A ecosystem, [ap2-protocol.org/](https://ap2-protocol.org/), spec pages under `ap2/specification/`, `ap2/checkout_mandate/`, `ap2/payment_mandate/`; the current spec text refers to "Agentic Payment Protocol (v0.2)") chains cryptographically signed mandates as SD-JWTs, identifying each schema by an exact `vct` string with a version suffix, with "Implementations MUST match the exact `vct` string, including the version suffix", and JWT claims including `cnf` (the agent's public key), `exp`, `checkout_hash`, `transaction_id`. Notably its own scope statement says "Agent-to-Agent Delegation" is "outside the scope of the current specification". The transferable idea, and it is a good one, is the mandate shape: a signed object that carries a *price cap, a time window, an allowlist and a human-readable playback of what was authorised*. That is precisely the `delegation` block plus `budget_usd_ceiling` plus mandatory non-empty `context`. The payment rails are not RFA's problem and should not become one.

**Rate limiting as abuse control, with the header names for the HTTP binding**: `draft-ietf-httpapi-ratelimit-headers-11` ([datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/), Internet-Draft, expires 24 November 2026, still not an RFC) defines two fields, `RateLimit` and `RateLimit-Policy`, superseding the widely deployed de-facto `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` trio from earlier versions. RFA already returns `retry_after_s` inside the `rate_limited` error, which is the right thing on the MCP plane; the REST binding (R11) should also emit `RateLimit` and `Retry-After` so an off-the-shelf HTTP client backs off without RFA-specific code.

### E12. Why T0 cannot carry this, in one paragraph of evidence

`spec/RFA-0.1.md:91` makes T0 "Join secret (capability token in `room_join`) + membership token thereafter", intended span "Same team / trusted cluster", and it is the only tier implemented. Under this dimension's premise the join secret is a bearer credential that authorises claiming tasks and posting results that a human will act on, shared by every member of the room, with no per-org revocation and no rotation story. The MCP 2026-07-28 authorization spec is the ready-made target and it is not vague ([modelcontextprotocol.io/specification/2026-07-28/basic/authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), captured verbatim in `research/03-reach-and-collaboration/notes/01-remote-reach.md:2.2`): authorization servers "MUST implement OAuth 2.1"; MCP servers "MUST implement OAuth 2.0 Protected Resource Metadata (RFC9728)"; clients MUST send RFC 8707 `resource` on both authorization and token requests, "regardless of whether authorization servers support it"; servers "MUST validate that access tokens were issued specifically for them as the intended audience" and "MUST NOT accept or transit any other tokens"; and if the server calls an upstream API it "MUST NOT pass through the token it received from the MCP client". Note also that the current spec's T1 line is already stale: it names client credentials plus RFC 8693, whereas the 2026 requirement is a resource-server posture (RFC 9728 + RFC 8707) with Client ID Metadata Documents. Two more relevant details from the same revision, both cheap wins for a task API: MCP's own guidance that a state handle "is a name, not a capability. The server should validate the caller's authorization against the handle on every call" and, for unauthenticated cases, that a handle "is necessarily a bearer token, it should be generated with sufficient entropy (e.g., a UUIDv4) and given a bounded lifetime" ([modelcontextprotocol.io/specification/2026-07-28/server/tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), "Stateful Tools"). That is the exact security contract for `claim_id`, and the tasks extension repeats it: "A server MAY use task IDs as bearer tokens for a server's stored state. Servers MUST generate them with sufficient entropy that a third party cannot enumerate or guess them."

---

## What RFA already solves

Do not redesign any of this.

| Need | Already shipped | Location |
|---|---|---|
| Task object with A2A-mapped states | 7 states, 4 terminal, 1:1 A2A mapping table | `src/model.ts:88-115`, `spec/RFA-0.1.md:391-402` |
| Atomic claim with exactly-one-winner | `submitted` + unowned + unblocked check, losers get `task_conflict` | `src/store.ts:1663-1675` |
| Evidence gate (anti phantom-delivery) | `evidence_required` -> `complete` sets `verification.pending`, state stays `working`; a *different* member must `verify`; reject is rework not terminal | `src/store.ts:1701-1732`, `spec/RFA-0.1.md:426` |
| Dependencies and unblocking | `blocked_by`/`blocks`, `unblockDependents`, `task{action:"unblocked"}` events | `src/store.ts:1745-1757` |
| Requester deadline | `reply_by` + one-shot `system {event:"task_overdue", refs:{task_id,title,owner,asker}}`, survives hub restart (ledger bug 3) | `src/store.ts:1941-1957` |
| Attention routing for task events | mentions filter matches owner, creator and verifier | `src/store.ts:2086-2089` |
| Tamper-evident ordering | every event carries `prev_hash` = SHA-256 over JCS of the previous event | `src/store.ts:2136`, `src/jcs.ts` |
| Cross-org identity primitives | JWS card signing (EdDSA/ES256), `kid` = RFC 7638 thumbprint, trusted key map, embedded-JWK self-certifying path, `--require-signed` | `src/signing.ts`, `src/store.ts:2096-2099`, `src/main.ts:39-45` |
| Card digest change detection | `digest_changed`, `agent_describe` with `verified` + `verification[]` | `src/store.ts:1880-1892` |
| Org field on the card | `provider.organization` | `src/model.ts:26` |
| Human-in-the-loop before a side effect | approval ext + `canUseTool` bridge + human-origin-only approve + edit-before-approve merge + expiry sweep | `src/bridge.ts`, `src/store.ts:1360-1370`, `spec/RFA-0.1.md:521` |
| Origin stamping (agents cannot claim to be human) | `resolveOrigin`, human keys provisioned out of band, wrong key is a loud `join_denied` | `src/store.ts:463-471` |
| Peer content quarantine into memory | MemoryGate rejects persisting peer verbatim; consolidation rebuilds the gate window from the batch | `src/memoryfs.ts`, `src/consolidate.ts` |
| Policy gate over peer text (messages only) | rules/command tiers, most-severe-wins, fail-closed-to-hold, audited | `src/store.ts:843-915` |
| Operator levers against a bad member | `hold_member` (blocks mutating `room_task`), `evict`, `quarantine` by name + digest, `cancel_task`, `set_policy` | `src/store.ts:1300-1460`, `spec/RFA-0.1.md:508-518` |
| Liveness detection primitives | presence leases (`defaultLeaseS: 180`), flap debounce, offline inference in the sweep, `gone_quiet` with `askers[]`, `member.task` already on the presence record | `src/store.ts:1897-1915`, `src/model.ts:77` |
| Duplicate suppression precedent | content-hash dedupe within `dupWindowS`; duplicate approval `request_id` is `task_conflict` | `src/store.ts:801-805`, `src/store.ts:756` |
| Rate budgets | `member_rpm`, `max_pending_requests`, `rate_limited` with `retry_after_s` | `src/store.ts:785-799` |
| Size ceiling with a real error | `maxInlineBytes: 262_144` -> `payload_too_large` | `src/store.ts:780` |
| An HTTP surface to hang a REST binding on | router with `/mcp`, `/auth`, `/api/*`, `/console`; session tokens on every workbench route; loopback default bind | `src/main.ts:213-340` |
| Result-quality machinery | trajectory conversion, 6 protocol lints, `r_state x r_output x r_protocol`, judge, pass^k | `src/evals/trajectory.ts` (v0.4.4) |

### ...and what breaks for a remote claimant

Ordered by severity. All line numbers at commit `02025de`.

1. **No lease on a claim, so a dark remote worker holds the task forever.** `claim` sets `owner` + `working` (`src/store.ts:1672-1674`); nothing in `sweep()` (`src/store.ts:1897-1990`) looks at task ownership. `task_overdue` fires once and mutates nothing (`src/store.ts:1948-1956`). There is no attempt counter, no requeue, no `release`.
2. **A reconnecting remote worker cannot complete its own task.** Join always mints a new id (`src/store.ts:498`, `id: rid("m")`) and `complete` requires `task.owner === member.id` (`src/store.ts:1704`). The only defence today is client-side token persistence, which the residents learned the hard way (ledger bug: "room-joining residents never retained the join secret"). A stranger's agent will get this wrong.
3. **Task text bypasses the policy gate.** `evaluateGate` is called only in the send path (`src/store.ts:846`); `task()` never calls it. `note`, `evidence.summary` and `evidence.artifacts[]` from an unaudited peer flow straight into the log, the console, the approval card and a local agent's prompt.
4. **`verify` permits collusion.** The only check is verifier != owner (`src/store.ts:1722`). Two agents from the same remote org, or one org with two memberships, can complete and verify each other's work and the evidence gate reports a clean pass.
5. **Evidence artifacts are untyped strings.** `TaskEvidence {summary: string; artifacts?: string[]}` (`src/model.ts:91-94`): no mime, no size, no URL semantics, no digest. Nothing about a remote artifact is checkable, and nothing bounds its size (the 256 KiB check is in `send` only).
6. **`failed` is unconditionally terminal** (`src/model.ts:89`), so a transient remote failure such as a vendor 504 permanently kills the task; the only recovery is a human creating a new task and losing the thread.
7. **No progress channel at all.** `update` with a `note` is the closest thing, and it is not rate limited, does not renew anything, and is authorised for the creator too, so it cannot be read as "the worker is alive".
8. **`gone_quiet` never fires for tasks.** The sweep's `owedTo` computation only looks at `room.pendingReplies` message mentions (`src/store.ts:1906-1908`), so a task creator gets no notice when the owner goes offline. This is the exact bug shape 0.1.1 fixed for messages (`askers[]` added after a waiting agent burned 13 minutes polling), unfixed on the task path.
9. **`member_rpm` does not cover task actions.** The counter only advances in the send path (`src/store.ts:918`), so a remote member can hammer `room_task` at will: claim/release loops, note spam, `list` polling.
10. **No idempotency on `create`**, so a retrying requester silently creates duplicate tasks that two members can then claim in parallel.
11. **`claim` cannot take a pre-assigned task.** `create` accepts `owner` (`src/store.ts:1624`) but `claim` requires `owner === null` (`src/store.ts:1665`), so "assigned to you, please pick it up" is unrepresentable: an assigned task starts `submitted` with an owner and can never move to `working` except through `update`, which requires being that owner. Minor, but a stranger's agent will hit it on day one.
12. **Nothing distinguishes a local member from a remote one.** There is no `locality` on the presence record, so a policy like "remote members get a lower rpm and cannot verify each other" has nothing to key on. `provider.organization` is self-declared and unverified unless cards are signed.

---

## Open questions and spikes

### Open questions

1. **Is the remote counterparty's transport MCP or HTTP?** Every "any org can play" claim in this design rests on R11. If the answer is "remote agents will happily run an MCP client", R11 shrinks to documentation. Nothing in the repo or the research answers this, because no remote agent has ever joined an RFA room. This is the single biggest unknown in the wave.
2. **Does anyone but the author's own agents ever verify?** `verify_scope: different_org` presumes a second competent party exists in the room. If the realistic configuration is one remote worker plus one local human, then `verify_scope: human` is the only meaningful value and R13's org logic is dead code. Watch the first real deployment before building the org comparison.
3. **What does `lease_ttl_s` want to be for an agent task?** Kafka picked 45 s for a poll loop, SQS defaults to 30 s, Temporal leaves it unset, MCP leaves `ttlMs` to the server. Agent tasks run 10 s to 30 min. The default of 300 s with a 60 s grace is a guess anchored on RFA's own presence lease (180 s) and answer latencies (11 to 25 s, `STATUS.md`).
4. **Where do artifact bytes live when the remote org has no public storage?** The design says "their storage, signed URL, hub keeps the digest". A LangGraph agent in a private VPC may have nowhere to put a 5 MB PDF that the hub can reach. The fallback (base64 in a `file` part under the 256 KiB ceiling) covers documents and not much else. An upload endpoint on the hub is the obvious answer and it is also the first thing that turns the hub into a file server with a hostile-upload surface. Deliberately unresolved.
5. **Does the evidence gate survive contact with a remote worker's incentives?** A remote agent optimising for "task marked completed" will write plausible evidence. Nothing in the surveyed literature stops that; the eval-harness lints are the only automated counter and they only work on checkable outputs.
6. **Should a requeue tell the previous claimant?** Kafka rebalances silently; SQS never tells the old consumer. A polite `task {action:"requeued"}` event reaches the previous owner under the mentions filter, which is free, but a resurrected worker that reads it may still be mid-work with side effects in flight. The fence handles correctness; nothing handles the wasted work.

### Spikes, cheapest first

| # | Spike | Time | Proves / settles |
|---|---|---|---|
| S1 | **The stranger test, by hand.** Write a 60-line Python script with no RFA dependency that joins the standing room over HTTP, claims a task, posts a progress note, and completes with evidence. Count the number of times the MCP framing gets in the way | 2 h | Whether R11 is documentation or a real binding. This is the highest-information spike in the dimension and it needs no code changes first |
| S2 | **Kill the worker mid-task.** Claim a task from a second process, `kill -9`, watch the sweep. Then restart, rejoin (new member id), and try to `complete` | 1 h | Reproduces breaks 1, 2 and 8 as failing tests before any design lands. These become the regression tests for R1/R2 |
| S3 | **Gate the task path.** Put an injection marker in `evidence.summary` and complete a task with it; then read the console's approval card and a local agent's prompt | 1 h | Break 3, and whether the existing `deploy/gate.json` rules fire unchanged on a content bundle that is not an envelope |
| S4 | **Fence-token semantics under a real race.** Two processes claim the same task; requeue after expiry; the original worker completes with the stale `claim_id` | 2 h | That `lease_expired` + rebinding actually resolves the resurrection case, and that the error data is enough for a client to recover without a human |
| S5 | **Sign one result** with the existing `src/signing.ts` path and verify it from a second process with only the public JWK | 2 h | R12's fifty-line claim, and whether the trusted-key plumbing (`--trusted-keys`) needs anything for results that it does not already do for cards |
| S6 | **Spot-check re-execution on a real task.** Take one completed task from the standing room, have a local agent redo it, and score both with the existing eval reward | 3 h | Whether R18's opt-in check produces a usable signal or just two plausible answers that disagree. Directly tests the E6 conclusion against RFA's own data |
| S7 | **Progress flood.** Hammer `progress` at 10/s from a scripted member | 1 h | R4's rate limit and R10's extension of `member_rpm` to task actions, plus whether the room log and console survive it |
| S8 | **Artifact by reference.** Complete a task whose result is a 5 MB file at an https URL with a digest; change the bytes at the URL afterwards; see whether anything notices | 2 h | That `digest` is load-bearing rather than decorative, and whether a verifier ever actually fetches |

### What would change my mind

- **On R11 (REST binding, unpark):** S1 showing that a plain HTTP client can already drive `room_task` through the MCP endpoint with acceptable ergonomics. Then it is a docs task, not a spec section.
- **On R12 (result signing, unpark):** if a year passes with exactly one remote org whose key the operator provisioned by hand, signing adds nothing over the hub's own authenticated record, and this drops back to parked. The trigger for keeping it is a *second* org, or any dispute about what a peer actually sent.
- **On R18 (quorum rejected):** a task class emerges where the local side can check cheaply (a computation, a schema-bound extraction, a lint-checkable document). Then run the check on 100% rather than a sampled fraction, and it stops being quorum and becomes validation, which is strictly better.
- **On R20 (attestation rejected):** a counterparty offers a verifiable attestation over its agent runtime, in the shape RFC 9334 describes, with a public reference measurement. Then the work is filling in `verification_status: third_party_attested` and a verifier hook, not a redesign. Watch for cloud vendors shipping this on hosted agent products, since that is where it would appear first.
- **On R14 (delegation chain adapted, not adopted whole):** if a delegated task ever crosses two remote orgs (A asks B, B asks C), the depth and context checks stop being ceremony and become the only record of who authorised what. Today no chain longer than one hop exists, so build the field and enforce two rules, nothing more.
- **On the whole dimension:** if the first real remote member turns out to be another instance of the *same* org's stack (a second laptop, a colleague's hub), then almost all of this is over-built and the honest first version is R1 plus R2 plus R6 and nothing else. Sequence the build so that is a valid stopping point.
