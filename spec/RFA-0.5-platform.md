# RFA v0.5: Platform Amendments

**Platform amendment, version 0.5.0 (draft)**
Status: Draft for implementation · Date: 2026-08-17 · License: Apache-2.0 (see LICENSE)

**This document is an AMENDMENT to [spec/RFA-0.4-platform.md](RFA-0.4-platform.md), not a replacement.** RFA-0.4-platform.md remains in force in full. Every change below is stated as *amends section N of RFA-0.4-platform.md* or *adds section N*, and the v0.4 text is not reproduced here. An implementer needs both documents, plus the wire protocol [spec/RFA-0.1.md](RFA-0.1.md) (**currently 0.1.8 draft**), which stays authoritative for everything on the wire. Where this document and the wire spec disagree, the wire spec governs; where this document states a stricter platform-side obligation than a wire SHOULD, it says so explicitly at the point of use.

**Reading order with RFA-0.6-remote.md.** This document is v0.5 and remains in force. [spec/RFA-0.6-remote.md](RFA-0.6-remote.md) is v0.6 and depends on it: its per-peer spend ceiling reads the cost meter that section 18 of this document builds. The two ladders are merged into one ordered table in section 22 so an implementer holds one sequence, not two. RFA-0.6 restarts its own section numbering at 1, so a bare section number is ambiguous across the two files: this document always writes "v0.4 sect. N" or "RFA-0.6 sect. N" when it means another document.

Evidence: every requirement below traces to a recommendation that survived the adversarial verification pass in [research/03-reach-and-collaboration/REPORT.md](../research/03-reach-and-collaboration/REPORT.md) (cited as **W3 sect. N**). Where that report's verifier refuted or corrected a recommendation, the correction is what is specified here; where the report says the evidence is thin, this document says so too (Appendix A). Wave 04 ([research/04-remote-agents/REPORT.md](../research/04-remote-agents/REPORT.md), cited as **W4 sect. N**) sets v0.6 and is out of scope except in section 23, where it re-judges parked items a reader might otherwise expect to find here.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are as in RFC 2119.

**The v0.5 theme is trust, not reach.** The wave was commissioned as "remote reach and collaboration" and its own evidence retired half that title: the approval cards that died did not die because the hub was hard to reach, and the hub was already reachable by every device on the operator's network. v0.5 therefore reduces exposure, stops a clock from forging a human refusal, makes the meters honest, and buys reach as one thin slice on top. It adds no second collaborating agent and no channel adapter (section 23).

**Implementation-status markers.** Each normative subsection carries one of:

| Marker | Meaning |
|---|---|
| **SHIPPED** | Implemented in the reference hub at commit `e066d4c` and verified live; the requirement describes existing behavior |
| **PENDING** | Specified here, not implemented at `e066d4c`; the file and line of the current defect are named |

**Status staleness rule (added 2026-08-21, after these markers cost real time twice):** the
markers in this document date from the commit above and are corrected only opportunistically.
The LIVE per-requirement table is wire spec RFA-0.1 **Appendix F**; per-rung status is the
**STATUS.md header**. Where this file disagrees with either, this file is the stale one, and a
reader planning work from a PENDING here without checking those two will rebuild shipped code
(it happened with this file's section 22 and with RFA-0.6 section 12).
| **SPECIFIED, UNIMPLEMENTED** | Normative, with no implementation anywhere and no near-term one; stated so that no reader assumes enforcement |

---

## 15. Exposure posture (adds section 15; amends sections 9 and 10)

**Rung v0.5.0. SHIPPED** (landed in commit `82dc7c7`, present at `e066d4c`; three regression tests, verified live).

This section **amends section 9** of RFA-0.4-platform.md, whose last paragraph reads that read-only tabs stay tokenless and the hub keeps binding to localhost. The first half is struck (reads are now tokened); the second half is kept and promoted from an aside to a normative default with an override rule.

**Why, on the record.** `server.listen(port, cb)` omitted the host argument, so Node bound every interface (`lsof` confirmed `TCP *:8790`), and four `GET /api/*` routes answered without a session token. Fetching `http://<lan-ip>:8790/api/agents/linear-scribe/definition` from another device on the same Wi-Fi returned the full pack. Any device on that network could read agent system prompts, run payloads (question and answer text), and pending approval cards, which carry entire draft documents. Writes were always gated and `data/secrets.json` was never served, so no credential leaked (STATUS.md findings ledger, 2026-08-17; W3 sect. 1, 2, 7.1).

### 15.1 Bind

- **"Loopback" means** an address in `127.0.0.0/8`, `::1`, or the name `localhost`. That set is stated here so it is the same set 15.3 uses.
- The hub's HTTP listener MUST bind a loopback address by default.
- An operator override MAY be provided (the reference hub's `--bind`). When the bound address is outside the loopback set the hub MUST emit a startup warning on stderr naming the address. *Implementation note: the reference check is narrower than the rule, testing `bindHost === "127.0.0.1"` (`src/main.ts:380`), so `--bind ::1` and `--bind localhost` warn unnecessarily. Over-warning is harmless; a second implementation should use the set above.*
- Reach from another device MUST be obtained by proxying to the loopback listener (section 17), **never** by widening the bind. The distinction is not stylistic, and the property it turns on is defined once in 17.1.

### 15.2 Every workbench route requires the session token, reads included

- **"Workbench route" means** every HTTP path the hub serves other than `POST /auth`, the static console document, `GET /healthz`, and `POST /mcp`. That definition is load-bearing: without it the MUST below reads as if it covered the MCP endpoint, which it does not.
- `POST /auth` exchanges a provisioned `human_key` for a session token. Every workbench route MUST require that token, **including reads**, and MUST answer `401` with a machine-readable error when it is absent or expired.
- Read routes are cheap to gate because the console already carries the bearer and re-prompts on `401`. Gating them is what removes the exposure class above: definitions, runs, summaries and approval cards are operator-only data.
- **`POST /mcp` is out of scope of this section and is NOT protected by it.** It carries its own credential (the agent tier below), which does not exist yet. Until it does, **an operator MUST NOT expose `/mcp` through the proxy of section 17**, because `room_listen` returns full message bodies and approval-card `ext` payloads, `room_roster` plus `agent_describe` return every member's card, `room_task list` returns notes and evidence, and `room_create` mints rooms.
- The credential tiers. Only the human row restates v0.4 section 9; the other two are new here, and the middle one is a requirement, not a description:

| Principal | Credential | Lifetime | Status and notes |
|---|---|---|---|
| Human at the console | `human_key` presented once to `POST /auth`; the hub mints a session token | 12 h sliding today; an absolute cap and a revocation endpoint are 15.5 | **SHIPPED.** Token chains to a human key, so console decisions land as `origin: "human"` through the ordinary room machinery |
| Agent at `/mcp` | One static bearer per principal, resolved by the supervisor from `data/secrets.json`, checked **before** the MCP handler dispatches, and audience-bound per wire spec 4.2's T1 row | Long-lived, rotated by hand | **SHIPPED 2026-08-18** (`--mcp-token`/`RFA_MCP_TOKENS`, checked by `mcpAuthorized` in `src/main.ts` before the handler dispatches; optional, and off by default with a startup warning). What follows is the defect as it stood when this row was written, kept as the rationale: `src/main.ts` routes every path that is not `/auth`, `/api/*`, `/` or `/console` straight into `handler.fetch(request)` (`:341` onward) with no credential inspection, and `src/secrets.ts` resolves per-pack environment names, not transport bearers. `room_create` is therefore an uncredentialed resource-creation primitive. The work is scheduled as RFA-0.6 rung v0.6.0 (see the merged ladder in section 22); Claude Code's documented static `headers` with `${ENV_VAR}` expansion is sufficient, and a shell-executing `headersHelper` is unnecessary until rotation is automatic |
| Push notification | **None. A link only** | n/a | **SHIPPED** (17.3; `--push-url`/`RFA_PUSH_URL`, a title and a link only, exactly this row's design cell). A bearer in a broadcast push payload is a standing grant to the workbench for any reader of the topic |

The session token SHOULD additionally be rotated on first auth and on each approval decision, which bounds a stolen token's authority over the one surface that produces external side effects. **PENDING.** Wave 03 sect. 7.4 carried this alongside the absolute cap; it is recorded here rather than dropped silently.

### 15.3 Origin validation

- The hub MUST validate the `Origin` header of browser requests against an allowlist and MUST answer `403` on a mismatch. The loopback forms of 15.1 are implicitly allowed; the operator extends the list by configuration (the reference hub's comma-separated `--allow-origin`, `src/main.ts:151`). *The flag is read once (`arg()` returns the value after the first occurrence, `src/main.ts:33`), so passing `--allow-origin a --allow-origin b` silently keeps only `a`. It is comma-separated, not repeatable; wave 03's "repeatable" belonged to the proposed `--allow-host`, which never shipped.*
- **A request with no `Origin` header is a non-browser client and MUST NOT be blocked.** Origin validation is a DNS-rebinding defense, and rebinding is a browser attack; treating an absent header as hostile breaks every CLI, SDK and MCP client for no security gain.
- Refusals MUST be logged with **the value that was seen** and the configuration that would have allowed it. A silent `403` on the first request from a new device is undiagnosable, and this is the single most likely operational failure of the whole posture.

### 15.4 Host allowlist

- A hub fronted by a proxy SHOULD additionally validate the `Host` header against an operator allowlist. This is **not** a MUST: whether a proxy forwards the original `Host` or rewrites it to the loopback target is unmeasured (Appendix A), and a wrong guess `403`s the first request from the operator's phone.
- **Implementation status: PENDING.** The reference hub validates `Origin` only. `--allow-host` is reserved for this (Appendix B).

### 15.5 Key comparison, attempt limiting, and the auth log

- The hub MUST compare a presented `human_key` in constant time.
  **SHIPPED** for `POST /auth` (`humanKeyMatches` in `src/main.ts`: every configured key costs one `timingSafeEqual` of its own length, and a wrong-length candidate walks the same path). The join path now resolves through `matchPrincipal` in `src/principals.ts` (constant-time; **SHIPPED**, it previously used `includes()`); it is a lesser exposure, guarded by a room handle plus a join secret rather than by the endpoint this section is about.
- The hub **MUST** apply a per-source attempt limit with lockout to `POST /auth`, and MUST log lockouts to the separate auth log of the bullet below. **SHIPPED** (10 failures per source per 15 minutes, then a 15-minute lockout returning 429 with `Retry-After`; the lock is checked before the body is read and before any comparison, and a success clears the counter). This is a MUST and not a SHOULD because after 15.2 `/auth` is the sole gate on every workbench route including all reads, the credential it guards is a long-lived operator-chosen static key with no absolute cap and no revocation (below), and section 17.1 puts the whole surface behind a proxy reachable from a phone. Unlimited unthrottled guessing against that endpoint is the dominant residual risk of this posture, and it is a larger one than a timing side channel on a local `includes`.
- Authentication events MUST NOT be appended to a room's hash-chained event log. `src/store.ts` seeds `room.chainHead` from the room handle and every append carries `prev_hash` from that room object, so the chain is per-room by construction, while `/auth` is unauthenticated by definition: appending one event per failed attempt would hand an unauthenticated caller unbounded growth in the very audit trail being hardened. Auth events belong in a **separate append-only log with its own genesis, writing aggregated counters per time window**. **SHIPPED**: `<data>/auth.log.ndjson`, mode 0600, one row per 5-minute window carrying successes, failures, distinct sources and lockouts, hash-chained from its own genesis `sha256hex("rfa-auth-log/v1")` and never from a room's chain head (W3 sect. 2, verifier correction).
- Session tokens today are 12-hour sliding with no absolute cap and no revocation (`src/main.ts:142`, `:174`). An absolute cap and a revocation endpoint with a persisted `revoked_before` SHOULD be added. A hub MUST NOT bind a session token to a source IP **unless the operator declares a fixed-egress deployment**: in the common case the operating humans' devices roam, and a pin then locks them out for no gain; in an organization with fixed egress the pin is cheap and correct. **PENDING.**

### 15.6 Amends section 10 (deployment)

The deployment manifest and launchd plists are unchanged. Add: the documented reach procedure is "run the hub on loopback and proxy to it", and the runbook MUST state the proxy command rather than a bind flag, so that the fast path is the safe one.

---

## 16. The card clock (adds section 16; amends section 7.3 and section 12)

**Rung v0.5.0. SHIPPED** (see STATUS.md header).

Three clocks currently disagree, and the shortest one wins by accident.

| Clock | Current value and site | Defect |
|---|---|---|
| Approval-bridge default | `src/bridge.ts:59`, `opts.timeoutMs ?? 10 * 60_000` | A fixed ten-minute platform default with no relation to the asker |
| Resident narrowing | `src/resident.ts:394`, `Math.max(60_000, Math.min(10 * 60_000, replyByMs))` | Ten minutes is a hard **ceiling** on every path, so a longer asker deadline cannot buy a longer human window |
| Held-message TTL | `src/store.ts:126`, `holdTtlS: 300` | A gate-held message dies in five minutes from the same Inbox, so fixing only the approval clock leaves the symptom reachable through the other door |
| Expiry resolution | `src/store.ts:1970-1971`, sweep sets `approval.status = "rejected"` | A clock produces a record indistinguishable from a considered human refusal |

### 16.1 The window derives from the asker

- The approval window MUST derive from the asker's own deadline (`reply_by`), minus a small delivery margin, with a floor so that a nearly-expired ask still gets a real chance. The reference implementation's margin is 30 seconds and its floor is 60 seconds; both are retained.
- **When the asking envelope carries no `reply_by`**, the approval window MUST fall back to a stated platform default of **30 minutes**, matching the `npm run ask` default below. This is a live path, not a hypothetical: `src/resident.ts:394` spreads `timeoutMs` only when `replyByMs` is finite, so an ask with no `reply_by` falls through to `opts.timeoutMs ?? 10 * 60_000` at `src/bridge.ts:59`. The defect is the fixed **ceiling**, not the existence of a fallback; deleting the ceiling without naming a fallback leaves the window undefined.
- The platform MUST NOT impose a fixed maximum on the approval window **below the asker's deadline**. The ten-minute ceiling in `src/resident.ts:394` and the ten-minute default in `src/bridge.ts:59` are the defect, not the fix. The card must never outlive its audience, and it must never die before it either.
- **A stated maximum supported deadline is a different thing and is permitted.** A platform MAY refuse an ask at ask time whose `reply_by` is beyond what an in-process run can survive (16.4 concedes that is minutes to an hour, not hours and not a day), and when it does it MUST refuse with the specification's `overloaded` refusal naming the maximum it supports. It MUST NOT accept such an ask and then let the card expire, which converts a capacity limit into a phantom human non-decision.
- `npm run ask` MUST default `reply_by` to **30 minutes**. This is what actually buys "I stepped away".
  **Code discrepancy, noted rather than laundered:** W3 sect. 7.2 says the current default is 600 s; the code says otherwise. `scripts/ask.ts:26` reads `Number(flag("--timeout") ?? 180)` and `src/client.ts:287` derives `reply_by` from that timeout, so today's default asker window is **180 seconds**. The 600 s figure in the report and in the STATUS ledger belongs to one live invocation, not to the default.

### 16.2 Expiry is `expired`, not `rejected`

- A pending approval that passes its `expires_at` MUST resolve to a distinct resolution **`expired`**, and the asker's refusal reason MUST be **`deadline_expired`**.
- Expiry still fails closed: nothing is approved, nothing is delivered, the side effect does not happen. What changes is only the record. A hash-chained log whose whole purpose is to answer "who decided what" MUST NOT record a clock as a human "no".
- `allowed_decisions` gains no member. This is a **resolution** vocabulary change, not a decision vocabulary change.
- **Already normative on the wire.** Both tokens landed in protocol 0.1.8: wire spec 12.4 makes the `expired` resolution and the `deadline_expired` refusal reason MUSTs, its Appendix B registers `resolution` and the refusal reason, and its Appendix A carries `deadline_expired` in `room_send`'s enum. This section states only the **platform-side obligation**, and it inherits two details from 12.4 that the first draft of this document did not carry: the resolution rides `system {event: "approval_expired", refs: {..., resolution: "expired"}}` plus the `room_admin approve`/`reject` result, and the `deadline_expired` refusal is sent by the requesting member's own client rather than synthesized by the hub.
- **Amends section 12 of RFA-0.4-platform.md.** That section lists four protocol deltas targeted at 0.1.7; three landed in 0.1.7 and the fourth, the handoff verb, was parked by wave 03 and again by wave 04 and appears nowhere in 0.1.8. **Strike v0.4 section 12 and read it as: the protocol deltas of record are the wire spec's own Appendix E changelog.** Nothing else in this document, and nothing in RFA-0.6-remote.md, retargets that list.

### 16.3 The hold clock, and expiry that surfaces

- **`holdTtlS` is not one number any more, because the approval window is not one number any more.** The rule, stated so it is computable: when a held envelope carries its own `reply_by`, its hold TTL MUST be derived from that deadline by the rule of 16.1 (deadline minus a 30 s margin, floor 60 s). When it does not, the room-configuration default applies, and that default MUST be at least **1800 s**, matching the `npm run ask` default. This **raises wire spec 12.2's normative 300 s default** and is stricter than wire 12.4's "the hold TTL SHOULD equal the approval window"; both are deliberate strengthenings by the platform layer over the wire, and are named as such rather than applied silently. `src/store.ts:126` is the single constant today.
- A hold that expires MUST be **surfaced in the operator's Inbox as expired**, not dropped silently. The rule is: fail closed on delivery, fail open on visibility. Wire spec 12.4 now governs hold expiry and requires three things, not one: fail closed, `system {event: "hold_expired"}` on the log, an `expired` **disposition to the sender**, and the same expired resolution in whatever review surface the hub offers. This section adds only the platform-side obligation that **the operator's Inbox is that review surface**; the sender-facing disposition is a wire requirement and a platform that implements only the Inbox half is non-conformant.

### 16.4 The honest limit of this fix

A longer window is bounded by what the run can survive. The pending decision exists only as an in-process `while (Date.now() < deadline)` loop inside `canUseTool`, inside the serve handler, holding a live Agent SDK query, a presence lease, an observer sidekick and a budget window. The achievable window is however long that survives, which is minutes-to-an-hour, **not hours and not a day**. Persisting the intent and re-materialising it on approval (card "parking") is a different and much larger change and is a non-goal for v0.5 with a stated trigger (section 23).

### 16.5 Evidence quality, stated plainly

The originating complaint, two approval cards lost while the operator was away from the desk, is **operator report and is not in the repository's findings ledger**. The only documented live approval succeeded, 18 seconds after the card appeared. W3 sect. 2 states this plainly rather than laundering it, and so does this specification: the code-level defects in the table above are directly readable and stand entirely on their own, but the incident that motivated the priority ordering is not measured evidence.

---

## 17. Reach (adds section 17; amends section 9)

**Rung v0.5.1. SHIPPED** (see STATUS.md header).

### 17.1 Topology

- **Definition, because this term is load-bearing and was previously undefined.** A proxy **terminates identity** when both hold: (a) it refuses to forward any request whose client is not on an operator-controlled allowlist, and (b) it is the only network path to the loopback listener. Note what the property is and is not: the hub derives **no principal** from such a proxy, which is why 17.1's fourth bullet below can forbid using its identity assertion as an authentication factor without contradiction. What the property buys is that unauthenticated network reach is removed, not that a caller is identified.
- The hub MUST stay on loopback (section 15.1). Remote reach is a proxy with the property above, on an operator-controlled private network, forwarding to `http://127.0.0.1:<port>`. Any product satisfying (a) and (b) qualifies: an SSO reverse proxy, an mTLS gateway, or a mesh VPN. **One worked example**, not a requirement: Tailscale Serve on the operator's tailnet, with an ACL limited to that operator's own devices and the MagicDNS name in the `Host` allowlist when 15.4 ships. Carry wave 03's own licensing caveat with it: the free plan of that product is documented as suitable for non-commercial use only, with a paid per-user tier otherwise, so an organization deploying this must price it or pick another proxy.
- A tunnel or proxy that fails (a) MUST NOT front the hub. Tailscale Funnel is the named case: its own documentation states that Funnel traffic is publicly available and does not include identity headers, so fronting the hub with it publishes a credential-less endpoint to the internet, and `/mcp` behind it is unauthenticated today (15.2).
- The hub MUST NOT be relocated to a rented host as a way of obtaining reach. That moves the API keys, the knowledge pack, the memory databases and the hash chain onto someone else's machine, which is a change of trust model wearing a change of hostname.
- Identity headers injected by the proxy MUST NOT be treated as an authentication factor. On a single-principal tailnet the injected value is a constant that every one of the operator's devices knows, and a constant is not a factor; an off-tailnet request cannot reach the hub at all, so the header adds nothing to what the ACL already enforces. The session token of section 15.2 remains the only credential (W3 sect. 2, verifier correction).

### 17.2 The console is the sole verdict surface

In v0.5, a human verdict on an approval card MUST be delivered through the console, authenticated by the session token of section 15.2. **No other surface may accept a verdict, and no relay is authorized in v0.5, including the documented remote-control fallback.** This is the invariant that makes every rule in 17.3 and 17.4 enforceable rather than aspirational. Section 17.4 states the rules a relay MUST satisfy **before it may be adopted in any later release**; it does not authorize one here.

### 17.3 Push is notification-only

- Push notifications on card creation and card resolution MUST be **notification-only**. The payload MUST contain no credential and MUST NOT offer an action button or any other verdict path. It carries a title, the tool name, a short alias for the card, and a deep link to the console.
- A second notification SHOULD be published when the card resolves, because a notification tap gives no visual feedback and the operator otherwise cannot tell whether their decision landed.
- **Why this is a MUST and not a preference.** A per-card bearer inside an action button sits in a broadcast message that the push service caches after delivery, protected only by a topic ACL; any read-subscriber to that topic can then approve the real card and produce a genuine external write stamped `origin: "human"`. It also violates the permission-relay rule that a gate keys on **sender identity**, because a push action button carries no sender identity at all. A verdict arriving over a broadcast transport with a bearer in it is a forgeable approval (W3 sect. 2, verifier correction, which rejected the notes' own proposal outright).

### 17.4 Permission-relay rules

No relay is authorized in v0.5 (17.2). These are the preconditions any relay MUST satisfy before a later release may adopt one, stated now because they are cheap to state and expensive to retrofit. Any such relay MUST obey all five:

1. A verdict is accepted **only against a server-issued id**. Nothing that the relay itself invents is a valid target.
2. A verdict against an unknown or wrong id is **dropped silently**. No error that confirms which ids exist.
3. The **local surface stays live**. A relay never disables or pre-empts the console; the console remains decidable throughout.
4. **First answer wins.** A second verdict on a resolved card is a no-op, not a re-decision (`task_conflict` on the wire).
5. **Previews are sanitized** and length-capped before they leave the hub.

Additionally: the decide call MUST be a **deterministic non-model command** bound to the server-issued id, and the log MUST record both the channel and the fact that a model relayed the intent. Approving through a free-text channel that a model interprets and then chooses to execute puts a language model in the provenance chain of an `origin: "human"` stamp, which is exactly what that stamp exists to exclude.

### 17.5 The capture path

The platform SHOULD provide `POST /api/ask` behind the session token, so that a question can be asked from a phone shortcut or a desktop hotkey without a terminal. This is not convenience decoration: the binding constraint on every instrument in section 20 is that the system has produced 35 agent serve turns in its entire life, and the cheapest lever on that number is the five seconds between having a question and asking it (W3 sect. 7.3, the demand-side hole no dimension owned).

It is also the only new **spend-triggering** write endpoint in the release, on a credential that 15.5 admits has no revocation path, so its shape is specified rather than sketched.

```json
// request
{ "room": "r_9a25e48c0e",
  "capability": "answer-spec-question",
  "question": "What is the minimum ticket on plan A?",
  "reply_by_s": 1800 }

// 202 response
{ "run_id": "run_01J8Z3V9M2", "asked_member": "m_7f3ka9", "conversation_id": "c_9ab3",
  "reply_by": "2026-08-17T15:26:41Z", "poll": "/api/runs/run_01J8Z3V9M2" }
```

- `room` (string, required), `question` (string, required, max 4000 chars), `capability` (string, optional): the skill id to select a responder by, exactly as `npm run ask --capability` does. With no `capability` the hub selects the single participant offering a matching skill and returns `409 {"error":"ambiguous_capability"}` when more than one does.
- `reply_by_s` (integer seconds from now, optional, **default 1800**, matching 16.1). A hub MAY refuse a value beyond what a run survives with `400 {"error":"deadline_too_long","max_s":N}` (16.1).
- The call is **asynchronous**: it returns `202` with a `run_id` and the caller polls `/api/runs/{run_id}`. A synchronous variant is not specified, because a 30-minute window cannot be held open on an HTTP request.
- Error codes: `401` no or expired session token; `404` unknown room; `409 no_capable_member` when no roster member offers a matching capability; `409 ambiguous_capability`; `429` when the per-token request rate limit below trips; `503` during drain, with `Retry-After`.
- **Budget and rate binding, required rather than implied.** A request accepted here MUST pass the same per-day ledger check as any other pickup (18.1) before any model call, and MUST be refused with the `overloaded` refusal carrying `spend=X budget=Y` when it does not. The hub MUST additionally apply a per-session-token request rate limit to this endpoint (RECOMMENDED 20 per hour); an unthrottled spend-triggering endpoint behind a non-revocable credential is a standing bill.

### 17.6 Unmeasured precondition

**MEASURED 2026-08-18, and it passes.** `tailscale serve --bg --https=443 http://127.0.0.1:8790` was configured on the reference deployment and a 20-second `room_listen` long-poll was parked THROUGH the proxy while a mentioning message was appended from loopback at t=3s. The response returned after **3.02s**, not at the 20s window close, carrying one message event with its `wrapped` rendering intact and SSE framing preserved. So Serve does not buffer a long-poll and the console's live stream works through it; `X-Accel-Buffering: no` was not needed. Also verified through the proxy: the console document serves (200, valid tailnet certificate) and a tokenless workbench read is still refused (401), so the loopback bind plus the session token survive the proxy rather than being bypassed by it.

One operational note that is NOT a Serve problem: the MagicDNS name did not resolve from a shell on the host itself, so the measurement pinned the name to the tailnet IP. A phone using Tailscale's own resolver is unaffected. If the host needs to reach its own tailnet name, enable Tailscale's DNS override in the app.

## 18. Honest meters and the account layer (adds section 18; amends section 7.4)

**Rung v0.5.2.**

Framing, because it changes what these requirements are for: across 433 recorded spans, **zero runs have ever hit a ceiling**, and lifetime spend is $2.65 against $3 and $5 day caps. This is pre-failure hygiene, and its real payoff is that the day ceiling stops being derived from a number known to be low.

### 18.1 The per-task budget is a minimum, with a viability floor

- The budget passed to a run MUST be `min(per_task_usd, per_day_usd - spend)`.
  **SHIPPED**: `taskCeiling = min(per_task_usd, per_day remainder)` with the viability floor, in `src/resident.ts` (the defect as written: `per_task_usd` was passed alone, so the last run of a day could spend a full task budget past the day ceiling).
- **When a pack declares no `per_task_usd`**, the budget passed to a run MUST be `per_day_usd - spend`; when it declares neither, the run has no cost ceiling and the platform MUST log that fact once per pack at startup. A `min()` over an absent operand is not a ceiling, and 18.5 shows the absent case is reachable in shipped code.
- The check MUST use a **viability floor**, not `> 0`. Because the cap is enforced between model requests, a two-cent remainder burns a real request per question and returns a truncated refusal; refusing at pickup with the clean "daily budget exhausted" wording that `src/resident.ts:348` already produces is both cheaper and more honest. **The wording is right; the delivery is not.** That line is `throw new Error(...)`, which is exactly the generic thrown error 18.3 forbids for the same cause, so the requirement is: keep the text, deliver it as the `overloaded` refusal of 18.3.

### 18.2 Cost is recorded on error paths

- A run that ends in error MUST still record its cost. **PENDING** and mechanical: the `subtype !== "success"` guard at `src/resident.ts:418` **throws**, so `spend.usd += costUsd` at `:429` is never reached and the catch-path `obs.record` omits `cost_usd` entirely, writing NULL rather than a real number. The `total_cost_usd` read MUST be hoisted above the guard, and `cost_usd` MUST be added to the error-path record.
- Consequence if unfixed: every capped or errored run is invisible to the meter that decides whether the next run may start.

### 18.3 Budget refusals carry the numbers

- **All three** budget stops MUST surface as the specification's `overloaded` refusal carrying `spend=X budget=Y` (v0.4 section 7.4 layer 1): the per-day check at pickup (18.1), `error_max_budget_usd`, and `error_max_turns`. None of them may reach the asker as a thrown `Error`.
  **SHIPPED**: budget and account stops return the spec 18.3 `overloaded` refusal carrying the numbers, and an auth failure returns `unauthorized` (the defect as written: both threw and reached the asker as a generic failure).
- A pending human approval SHOULD outrank a budget stop rather than racing it. **Unmeasured:** what actually happens to the card, the asker and the observer sidekick when a budget stop lands mid-approval has never been observed, and this exact interaction has already produced two live bugs. Treat the requirement as a target to verify, not as described behavior (Appendix A).

### 18.4 Consolidation spends from the same ledger

Background consolidation MUST count against the same daily ledger as answer-path work. **SHIPPED**: consolidation cost is folded into the same daily ledger (`spend.usd += r.cost_usd` in `src/resident.ts`). The defect as written: its spend never reached `spend.usd`, hiding roughly 3% of the resident's day.

### 18.5 Amends section 7.4, layer 1: strike "lagged enforcement" for the per-task layer

v0.4 section 7.4 describes cost enforcement as checked "at task pickup and run completion (lagged enforcement)". That is now wrong for the per-task layer and MUST be read as amended:

- **Per-task cost is enforced by the runtime between model requests**, whenever there is a per-task cost to enforce. `src/resident.ts:406` passes `maxBudgetUsd` into `query()` **only when the pack declares `per_task_usd`** (it is a conditional spread), and the Agent SDK then enforces it between requests, so overshoot is bounded at one model request rather than at a whole run. A pack that declares no `per_task_usd` gets **no** per-task ceiling at all, which is why 18.1 has to define the absent case rather than leaving `min()` with one operand.
- The **per-day** ceiling remains lagged: it is a pickup-time check against an in-process counter (`src/resident.ts:346-348`) that resets on the date and dies with the process.
- Per-token or mid-request interrupts are not adopted. The reference runtime's own hosted equivalent enforces between model requests for the same reason, and bounds overshoot the same way.

### 18.6 Layer 3, the account layer: specified, unimplemented

**SHIPPED** (rung v0.5.2): `AccountLedger` in `src/account.ts` is live in the serve path (`src/resident.ts` waits for a lane slot; the supervisor logs the cap at startup) with lane priorities and the account-wide rate-limit pause. The defect as written: no implementation existed and a grep for concurrency returned nothing. It is restated here as normative because the resource it arbitrates is the one that actually binds: a single subscription window shared between every resident, every background pass, and the operating humans' own interactive sessions.

- The supervisor MUST hold a global cap on model turns in flight across all residents and background passes.
- Admission MUST follow the priority order v0.4 already states: pending approvals and human-facing serves first; scheduled jobs next; consolidation, evals and judges last.
- On a provider rate-limit error the run parks as `interrupted` and the supervisor MUST pause pickup **account-wide**, not per-resident.
- **Sequencing rule, normative:** no new background loop may be added before layer 3 exists. v0.5 admits at most **one** new scheduled job, the `#ops` digest of section 20.5. Everything else that wanted a timer (a reflective pass, a goal-adherence lint, a fact-revalidation sweep, a catch-up sync, a channel-adapter process) is out, and section 23 gives each its trigger.

### 18.7 Fan-out and lifecycle guards

- The pack schema gains `tools.allow_subagents` (boolean, default `false`). A definition listing `Agent` or `Task` in `tools.allow` while `allow_subagents` is absent or `false` MUST fail validation with the offending tool named. The field is named here because 3.1 of v0.4 makes the definition one shared zod schema, and two implementations of an unnamed field do not interoperate on the same `agent.md`. **SHIPPED**: `tools.allow_subagents` (default false) with the superRefine assertion naming the offending tool, exactly as specified (`src/agentdef.ts`). Today neither live pack allows them and `canUseTool` default-denies, so no resident can spawn a subagent; the durable control is a validation assertion at the layer where the risk would arrive, not a runtime check on a path that does not exist yet.
- Agent retirement MUST be a **script**, not a runbook checklist: stop via the supervisor command channel, leave rooms and sidekick, evict remnants with `room_admin`, archive `state/memory.db`, keep feedback-bearing observability rows, and remove the definition file so the digest vanishes from every roster. The ledger's own failure mode is that under time pressure step 1 happens and nothing else does. Note that dropping secret names is hygiene and not control: the supervisor injects only the names the definition declares, so removing the definition already ends injection.

---

## 19. Knowledge (adds section 19; amends sections 3.1, 3.2, 5.1 and 8)

**Rung v0.5.3. SHIPPED but for its one operator step** (the tracked handbook clone needs the operator's remote and credentials; a labelled snapshot serves meanwhile; see STATUS.md).

Measured defect: the resident answers from 7 static files (48K, 6,642 words) while the source corpus holds 46 pages, including none of the regulatory-analysis or best-practice sections. **Coverage and provenance are the defect; retrieval is not.** Locally measured on the same laptop, FTS5 answers in 8.4 ms at 20,000 chunks, which is two orders of magnitude beyond this corpus, so latency cannot be an argument in either direction.

### 19.1 Sources are tracked clones, not copies (amends section 3.1)

- A knowledge source that is itself a version-controlled repository SHOULD be attached to a pack as a **tracked clone**, not as an exported copy: clone to a gitignored path, add one knowledge glob to the pack definition (out-of-pack globs already work), and pull in the existing nightly supervisor duty.
- Per-file provenance (author, commit time, sha) MUST be derived from the clone's own history rather than recorded in a parallel table. This is the provenance a hosted connector does not expose, and it is free.
- A pack MUST NOT be bound to an account-managed remote MCP connector to reach knowledge, and residents MUST NOT be started with `settingSources: ['user']`. The shortcut is not a shortcut: it injects every connector configured on the operator's personal account into an agent pack, assembling the exact private-data-plus-untrusted-content-plus-egress combination the rest of this specification exists to prevent (W3 sect. 5, verifier correction).
- **Discrepancy with v0.4, noted:** the frontmatter example in v0.4 section 3.2 shows an `mcp_servers` key. `src/agentdef.ts` has no such field, and `src/resident.ts` hardcodes three in-process servers. Read the v0.4 example as illustrative, not normative, until a schema field exists.

### 19.2 Facts carry a source, an author, and a revalidation horizon (amends section 5.1, L3)

- The `facts` table MUST gain exactly these four columns, with these types, all nullable, all matching the bi-temporal ISO-8601 text convention the table already uses (`src/memoryfs.ts:238-243`):

```sql
ALTER TABLE facts ADD COLUMN source_uri       TEXT NULL; -- absolute URI or repo-relative path of the file the fact came from
ALTER TABLE facts ADD COLUMN source_author    TEXT NULL; -- git author identity verbatim, "Name <email>"
ALTER TABLE facts ADD COLUMN observed_at      TEXT NULL; -- ISO-8601 UTC instant: when this platform read the source
ALTER TABLE facts ADD COLUMN revalidate_after TEXT NULL; -- ISO-8601 UTC INSTANT, not a duration
```

  `revalidate_after` is an absolute instant, not an interval, so that no consumer has to know what it is relative to. **Derivation for a tracked clone** (19.1, the only producer specified): for the file a fact was extracted from, `source_uri` is its path within the clone, `source_author` is `git log -1 --format=%an <%ae> -- <file>`, `observed_at` is the extraction time. A fact with no file source (an agent's own consolidation of room episodes, which is all seven live facts) carries all four as NULL, and a consumer MUST treat NULL as "no provenance", never as "unverified".
- These MUST land behind a real migration mechanism (a `user_version` pragma in the memory layer), because each agent owns its own database and the project today contains no `ALTER TABLE` anywhere.
- `valid_at` MUST stay NULL unless the text itself states a date. Setting it from a source document's `updated_at` records transaction time at the source as if it were validity time in the world, which mis-dates exactly the case bi-temporality exists for and corrupts the recency term in retrieval.
- The platform MUST NOT mirror source bodies into a local table. Cite upstream, derive locally. A `sources` table with a `body` column and a `UNIQUE(uri, content_sha256)` key stores every revision of every internal document forever in an unencrypted local file, which contradicts the principle it was proposed to serve, and it has no tombstone path, so a retracted document stays answerable forever.

### 19.3 Retrieval (amends section 5.1, L3 retrieval)

- The FTS5 MATCH builder SHOULD apply the prefix operator to each term. `src/memoryfs.ts:287` currently builds `"term" OR "term"`; appending `*` recovers the inflected forms that a stemmer misses, at one character of change, with no migration.
- A tokenizer change is **not** a one-line edit and MUST NOT be specified as one: `src/memoryfs.ts:246` creates the FTS table with `IF NOT EXISTS`, the live tables carry no `tokenize=` clause, and FTS5 has no ALTER path for a tokenizer, so editing the source string is a silent no-op. The real change is DROP, CREATE with the new tokenizer, rebuild, per agent database, behind 19.2's migration mechanism, and it is a separately verified step.

### 19.4 Evals pin a corpus version (amends section 8)

- Eval and parity runs MUST read a **pinned snapshot** of the knowledge corpus: a recorded commit sha for a cloned source, and a `corpus_version` recorded in `evals/baseline.json`. Live answers read the working clone. **`corpus_version` is defined as the full commit sha of the pinned upstream clone**, not a date and not a monotonic integer, so it is checkable with one `git rev-parse`. The baseline file's new shape is given in 20.3.
- Without this, an upstream edit by the document's own owner becomes an `exit 1` regression that is not one. This is not hypothetical: the corpus contains a live contradiction whose owner is expected to fix it, and that fix would silently break the gate.

### 19.5 Contradiction surfacing is an obligation, not a feature

- **The obligation is on the operator and is checkable; the model's compliance is measured, not asserted.** A pack whose knowledge spans multiple sources MUST carry a system-prompt instruction to name both sources and request human arbitration on a detected disagreement, and the eval set MUST contain at least one case asserting that behavior against a known corpus contradiction. Stating "the agent MUST name both sources" as an RFC 2119 requirement on a language model's output would be a MUST that nothing enforces, which is precisely the defect this document criticizes elsewhere.
- This behavior is already the observed and valued one: the resident produced it unprompted on a real corpus contradiction (a service threshold of 100,000 against per-product catalogue minimums), and that finding is in the ledger. Observed once is why it is worth an eval case, not why it can be asserted.
- A deterministic contradiction **detector** is not adopted in v0.5. The proposed version is two regular expressions fitted to two examples; validating it across the whole corpus is a gate on adopting it at all, not a fallback tweak.

### 19.6 Not adopted here

Embeddings, approximate-nearest-neighbour indexes, rerankers and hypothetical-document expansion are non-goals with a measured trigger (section 23). The honest reason to defer is dependency surface plus the absence of a measured retrieval failure, not cost (embedding this corpus is about half a cent) and not latency (the measurement at the head of this section). The trigger is a **measurement**, and one instance of the failure it names is already present: cross-source vocabulary drift, where two sources use different phrases for the same concept and no lexical fix bridges them.

---

## 20. Instruments (adds section 20; amends sections 7.1 and 8)

**Rung v0.5.4. SHIPPED but for its human/calendar items** (the labelling sitting and the deliberate-use week; see STATUS.md header).

The instruments currently report what they were built to report and not what is true. Measured: the eval baseline is five keys, all valued `1`, all cases at `trials: 1`, against a recorded per-question flake of about 5%, so a no-change run has roughly a 19% chance of printing a false regression. The feedback corpus is 33 rows, of which **1** is human, and the negative class has **two** members.

### 20.1 A binary judge with a versioned rubric

- The judge MUST emit a **binary** verdict. The current five-point choice set is a Likert scale in disguise over a corpus with no calibration data.
- The rubric MUST live in a versioned file (`evals/rubric.md`) and its hash MUST be recorded on every judge feedback row, so a rubric edit is visible as a rubric edit rather than as a quality movement. **This amends v0.4 section 7.1**, which fixes the universal feedback record at `{run_id, key, score, value, comment, correction, source_type}`. The added column is `rubric_hash TEXT`, the SHA-256 hex digest of `evals/rubric.md` as read at judge time, REQUIRED when `source_type = "model"` and NULL otherwise. Hex SHA-256 is chosen to match the project's only existing hash convention (the JCS-SHA256 chain).
- The judge SHOULD be anchored with two or three few-shot critiques drawn from the operator's own labels.
- **Cross-tier judging is required:** the judge MUST run at a different model tier than the subject it judges. Self-preference is a causally demonstrated effect, and cross-tier judging is the only mitigation available under a single subscription. The current call site passes no options at all.
- The judge MAY set `needs_review` and MUST NOT gate. This adds a write path; it removes no authority, because the runner computes regressions from the case score alone and the judge cannot gate today in any case.
- **Calibration is blocked, and that is stated rather than scheduled.** True-positive and true-negative rates need a negative class; the negative class has two members, and labelling 30 to 50 traces would exhaust the 35-trace lifetime corpus and still not compute a rate. The rule for v0.5 is: label every trace as it arrives, revisit calibration at 10 confirmed failures.

### 20.2 Case provenance is stamped at promotion

- `case.yaml` MUST carry five provenance keys, stamped by the promotion script at the moment the case is cut from a real room log, with these types:

```yaml
origin_run_id:   run_01J8Z3V9M2          # string, the engine run id
origin_room:     r_9a25e48c0e            # string, the room handle
origin_seq_range: { from: 512, to: 534 } # object of two integers, inclusive
promoted_at:     2026-08-17T15:56:33Z    # string, ISO-8601 UTC instant
failure_mode:    retrieval-wrong-file    # string, free text, the label used in the findings ledger
```

- These fields are free: the case loader is an unvalidated YAML parse, so unknown keys pass today.
- `tier` and `last_failed_at` are **not** adopted. They require the runner to mutate gitignored pack-local case files and to filter by tier at discovery, which is real work with no consumer yet.

### 20.3 The eval gate

- The gate MUST NOT compare a run's point-estimate score against a stored point estimate of `1` at `trials: 1`. Raising trials against a hard `1.0` target makes the false-regression rate worse, not better.
- **The normative gate is pass^k with a stated k and band**, and storing the baseline as a full distribution is a MAY rather than a co-equal alternative, because a MUST offering a free choice between two mechanisms with no default is not implementable. **k = 4** (the value the existing `passHatK` tau-bench estimator is already run at) and the tolerance band is **0.15 absolute**: a case regresses when its measured pass^4 falls more than 0.15 below the stored baseline pass^4. Both numbers are **chosen, not measured**, which is exactly why 20.3's last bullet and section 22 require the gate's own false-positive rate to be measured by repeated no-change runs before it is tightened.
- Every verdict MUST print the **measured flake rate** beside it.
- The gate MUST record the per-case definition hash and the corpus version (19.4). The current case set spans two agent definitions plus a replay case with none, so a "regression" today may be a definition change, a corpus change, or noise, and the report does not distinguish them.
- `evals/baseline.json` is today a flat `{caseId: number}` map (five keys, all `1`). Its new shape:

```json
{
  "schema": 2,
  "corpus_version": "4f1c9a2e7b3d51806cf2ad9e0b74c1359ad2e6f0",
  "k": 4,
  "band": 0.15,
  "cases": {
    "pm-fees-basic": { "pass_hat_k": 1.0, "trials": 4, "definition_hash": "sha256:9c1f…", "measured_at": "2026-08-17T16:02:00Z" }
  }
}
```

### 20.4 Anti-ossification

- A review period whose pass rate is 100% MUST be logged in the findings ledger in the form "reviewed N traces, no new failure modes". A 100% rate with no such entry is an unaudited instrument, and only the written record distinguishes an instrument that has finished from one that has gone blind. (This is the checkable form. "A 100% pass rate MUST be read as a warning" was an RFC 2119 keyword applied to how a human interprets a number; it has no implementation, no test and no observable failure state, and using MUST there devalues the checkable MUSTs in 20.3 and 20.6.)
- Labelling is the scarce resource in this release, and the requirement is a single sitting rather than four campaigns: one pass over the same traces MUST produce the binary label, the gold source reference, and the promotion with provenance together. Pricing four separate labelling campaigns at zero was the wave's most expensive unpriced assumption.

### 20.5 The review lane is a digest

- The two expressible review queues (feedback at or below zero or flagged `needs_review`; cost or latency above p90) SHOULD be posted as counts into the existing `#ops` room on the existing supervisor tick. This is the one new scheduled job v0.5 admits (18.6).
- A console review lane is a non-goal until the queues are non-empty for three consecutive weeks (section 23). Measured today: queue 1 yields **2 rows in project history**; the judge-versus-computed disagreement queue yields 0 and structurally cannot yield more.
- A third queue over capability or tool outcomes is **not expressible** over the current observability schema: there is no capability column, no agent-side tool-name column, and gate outcomes are room-log system events. Saying so is the requirement; pretending it is a third SELECT is the defect.

### 20.6 Watchdog invariants ship only after replay

- A watchdog invariant MUST NOT ship until it has been replayed against at least two weeks of room event logs plus the observability database and shown to fire on the known incidents **and nothing else**. Any invariant that false-fires does not ship.
- The proposed "present-but-lease-expired observers > 0" invariant false-fires by construction against the shipped 24-hour observer prune and MUST be read as "expired for longer than the observer prune window".
- The one anomaly present in live state was not in the proposed set and MUST be included: engine runs stuck in `running` (3 of 10 for one resident at the time of measurement).

---

## 21. Cross-cutting invariants (adds section 21)

These cost nothing to state, they generalize bugs already in the ledger, and they bind any future work in their area even though that work is out of scope for v0.5. Each carries its own implementation-status marker, per the convention of section 14, because their statuses genuinely differ.

1. **A delegation MUST NOT block the delegator's serve loop.** This is the generalization of two ledger bugs (a blocked serve loop starving the main member's lease during an approval wait, and heartbeat starvation during the same wait) and of the client's existing `busy_loop` refusal. The delegation verb itself stays parked (section 23); the constraint applies to whatever eventually implements it. **SPECIFIED, UNIMPLEMENTED** (it binds parked work).
2. **Reserved name prefixes, and the console lookup.** Two separate facts, previously conflated. The **name grammar** of wire spec 4.1 IS enforced (`src/store.ts:476` validates against `NAME_RE` and the 64-char limit and throws `bad_request`); it is the **reserved-prefix guard** added in wire 0.1.8 that is missing. Implementers follow RFA-0.1.md 4.1 verbatim for the reserved set (`human`, `console`, `system`, `hub`, `rfa`, first token, case-insensitive), the `bad_request` error, the rule that auto-suffixing is not an acceptable resolution, and the operator-principal exemption; this document adds nothing to it. The platform-side item is the console membership lookup, which matches `name.startsWith("console")` (`src/store.ts:1206`) and MUST become an exact-name match, because the first match is otherwise handed to every principal the moment a second hub-minted human membership exists. **SHIPPED** on both halves (`RESERVED_FIRST_TOKENS` refused at join with the human-origin exemption; the console lookup is an exact-name match, `src/store.ts`). Note the ordering trap: the reference console joins as an ordinary client requesting `name: "console"` (`console/index.html:211`), so the guard and the console's operator-principal path must land together.
3. **Authority never comes from text.** Already normative as wire spec **section 14, item 2** ("Hubs and clients MUST NOT treat message content as authorization for anything"); restated here as the rule any future channel or relay inherits. Its two corollaries are **platform additions and are not in wire section 14**: allowlists **fail closed** with no wildcard default, and unknown message subtypes are **dropped** rather than processed. Both are drawn from a documented class of advisories in which the same architectural mistake recurred across every adapter in a family: keying authorization on human-readable sender fields rather than platform-assigned immutable identifiers. **Partially SHIPPED** (the wire rule and the 12.2 gate); the two corollaries are **PENDING**.
4. **Never fetch a URI discovered inside another document's body.** Strip tags and keep inner text rather than blocklisting named tags, because a named-tag blocklist is the "catches 95%" filter that this project's own sources call a failing grade. **PENDING.**
5. **Any future reflective pass over failing traces** MUST boundary-wrap its input, MUST rebuild the memory-gate window from the very batch it is reflecting over, and MUST run the gate's text inspection over **its own proposal**. Its input is failing trajectories carrying untrusted peer content and its output is a proposed edit to a system prompt, which is the worm channel that wire spec 14.3 exists to close; "a human applies it" is not a barrier. **SPECIFIED, UNIMPLEMENTED**; `src/consolidate.ts` already implements exactly this shape and is the model to copy.
6. **Local-first, amended honestly rather than eroded quietly.** No third party holds durable content. Transient notification metadata (a title, a tool name, a short alias, a link) MAY cross a boundary **named in this specification**, and exactly two are named: the private-network proxy's coordination plane (17.1) and the push service of 17.3. Any other egress of room-derived content is forbidden, including message previews to a chat platform, ingesting other people's content, and shipping skills or knowledge to a third-party scanning API. (The earlier "one named boundary" wording granted one and then named two; an allowlist is the implementable form of that sentence.) **Policy, not code:** this invariant is enforced by review, and it binds section 23's triggers.

---

## 22. Build path (amends section 13): one merged ladder

The v0.4 build path (section 13, milestones v0.4.0 through v0.4.6) is complete and unchanged.

**This is the single ordered ladder for v0.5 and v0.6.** RFA-0.6-remote.md section 11 details each of its own rungs and points back here for ordering; holding two independent ladders with an unstated interleaving and one undeclared cross-dependency was the largest coherence risk in the pair. Every rung is independently shippable and live-verifiable in days, and lands behind the gates of the "verification discipline" paragraph below.

| # | Rung | Document | Content | Prerequisite | Status |
|---|---|---|---|---|---|
| 1 | **v0.5.0** | this, 15 / 16 / 21.2 | Loopback bind with a warned override; Origin allowlist with logged refusals; the session token on every workbench route including reads; constant-time key compare, **mandatory** attempt limiting, the separate auth log; then the clocks: `expired` resolution with `deadline_expired`, the ten-minute ceiling deleted with the 30-minute fallback named, `npm run ask` defaulting to 30 minutes, the hold TTL derived per 16.3 with expiry surfaced to the operator **and to the sender**. Plus the wire 4.1 reserved-prefix guard and the exact-name console fix, landed together | none | **SHIPPED** (exposure, 15.5, the clocks, reserved prefixes, the console fix). Remaining from this rung: 21.2's `overloaded` refusal for an ask whose deadline exceeds what a run survives, which belongs at ask-admission in the hub |
| 2 | **v0.6.3a** (pulled forward) | RFA-0.6, 5.4 / 8.3 / 8.4 | Atomic snapshot with fsync and rebuild-from-log; the append-ordering fix so a winning claim cannot revert; restart-durable send idempotency with the degraded replayed result of wire 9.1; `O_EXCL` plus heartbeat in the store lock; `db.backup()` replacing the CLI shell-out | none | **SHIPPED** except `db.backup()` (still the CLI shell-out in `src/supervisor.ts`). Tasks now reconcile from the log on load, an unreadable snapshot rebuilds the room instead of skipping it, and the lock judges liveness on a heartbeat rather than a PID |
| 3 | **v0.5.1** | this, 17 | The identity-terminating proxy per 17.1's definition; notification-only push on card creation and resolution; `POST /api/ask` with the shape of 17.5, behind the session token and bound to the budget | rung 1 (the token gates the proxy) | SHIPPED |
| 4 | **v0.5.2** | this, 18 | `min(per_task, per_day - spend)` with a viability floor and the absent-`per_task_usd` case defined; cost on error paths; all three budget stops as `overloaded` refusals carrying the numbers; consolidation folded into the ledger; layer 3; `tools.allow_subagents`; the retire-agent script; the "lagged enforcement" correction landed as prose | rung 1 | SHIPPED |
| 5 | **v0.6.0a: the locally-correct half** | RFA-0.6, 4 / 6 / 7.3 | Transport authentication on `/mcp` and a credentialed `room_create`; the persisted join sequence and the `since` clamp (a live, confirmed defect); `home` stamped and defaulting to `"local"`; `wrapped` in listen results; SDK validation failures wrapped as `bad_request`; extensions plus `spec_version` in `server/discover`; an `Authorization` path in the client; `INTEROP.md` with `rfa_min.py` | rung 1 | SHIPPED |
| 6 | **v0.5.3** | this, 19 | Knowledge as a tracked clone with per-file provenance; the first migration mechanism carrying the four typed provenance columns; the FTS5 prefix operator; a pinned `corpus_version`; contradiction surfacing in the pack prompt plus its eval case | rung 4 (no new loop before layer 3) | SHIPPED but for the operator's one clone command (a labelled snapshot serves meanwhile) |
| 7 | **v0.5.4** | this, 20 | Binary judge with a versioned rubric and `rubric_hash`, cross-tier judging; case provenance stamped at promotion; the eval gate on pass^4 with the 0.15 band, printing the flake rate; the `#ops` digest (the one new scheduled job); replay-validated watchdog invariants; one labelling sitting; then a deliberate week of real use with the findings ledger as the deliverable | Strictly after rung 4: 18.6's sequencing rule forbids a new scheduled job before layer 3 | SHIPPED but for the labelling sitting and the deliberate-use week |
| 8 | **v0.6.1** | RFA-0.6, 5 | The claim lease end to end: `attempt`, `lease_expires`, `claim_token`, release on offline/leave/eviction/`release`, the bounds as room policies, restart grace, `lease_expired` finally thrown | rung 5 (`home` must exist first) | SHIPPED, except the restart grace and `lease_expired` (a stale token is `unauthorized`); the claim_token re-bind on complete/update landed 2026-08-21 |
| 9 | **v0.6.2** | RFA-0.6, 5.7 / 7.2 / 7.4 / 7.6 | The gate over mutating task actions with its versioned check-input contract; task field size caps; the widened sanitizer set; `evidence_required` forced at claim; the verifier rule with capped rejections; the structured approval ext **with `src/bridge.ts` updated in the same change**; console guest rendering | rung 8 | SHIPPED |
| 10 | **v0.6.3b** | RFA-0.6, 7.7 / 8.7-8.9 | `room_admin redact`; retention in the join contract and per-member export; `verify-log`; `/healthz`; Docker and compose; `SECURITY.md`, supported versions, CI | rung 2 | PARTIAL: `verify-log` and `/healthz` SHIPPED; `redact`, retention/export and `SECURITY.md` not built; container packaging waits on the exposure answer of RFA-0.6 sect. 8.2; CI declined by decision |
| 11 | **v0.6.0b: the admission half** | RFA-0.6, 3 / 7.2 | `deploy/peers.json`; `room_admin invite`; membership expiry tied to `expires_at`; quarantine keyed on `peer_id`; the transport-principal linkage rule; the `admitted` event; `invite_invalid` | **A named counterparty exists.** Gated, not scheduled | PARKED with a trigger. None of it fixes a defect in an all-local hub; it is remote machinery for a peer that does not exist yet |
| 12 | **v0.6.4** | RFA-0.6, 4.4 / 7.1 | `usd_per_day` enforced at pickup; `member_rpm` per `(sender, recipient home)`; per-human `principal_id` with constant-time comparison and per-principal console memberships; retrieval set and gate verdict recorded per answer | rung 4 for the meter; the per-human half needs only rung 1 and may land with it | Split: the per-human half is **locally correct and cheap** and should not wait on a peer; the per-peer half is gated with rung 11 |
| 13 | **v0.6.5** | RFA-0.6, 9 | The sixty-day decision, not a feature | rung 5's cold-start test green for sixty days | The deliverable is one line in STATUS.md |

**Amends section 13's closing line** ("Deferred beyond v0.4: ..."): that list is superseded by section 23 of this document, which restates each item with its unpark trigger.

**Amends section 14 (verification discipline).** Unchanged in substance: every rung lands behind `npm test`, `npm run e2e`, the parity gate, live wire verification against the standing room, and a findings entry in STATUS.md. Three additions specific to v0.5:

- The exposure rung's live proof is negative as well as positive: from a second device on the same network the port must connect to nothing, a hostile `Origin` must return 403, and a tokenless read must return 401.
- The clock rung's live proof is a real card left to sit for most of a 30-minute window and then approved, plus a second card left to lapse whose log shows resolution `expired` and whose asker's refusal reads `deadline_expired`.
- The eval gate may not be tightened before its own false-positive rate is measured by running it repeatedly with no code changes (20.3).

**The last rung is a week of deliberate use, and that is deliberate.** The scarce resource in v0.5 is not compute, credentials or code; it is traces and one human's attention. The instruments in section 20 are starved by construction, and the week of use is what earns the next release's decisions.

---

## 23. Non-goals, with the trigger that unparks each (adds section 23)

Nothing in this table may be built in v0.5. Each line states what would unpark it. A reader who expects to find one of these specified above should read the trigger instead.

### 23.1 Parked by wave 03 (this release)

| Non-goal | Trigger to unpark |
|---|---|
| Verdict-by-push (any transport, any action button) | Card parking works, the console has been the sole verdict surface for a week of real use, and cards still get missed. Then exactly **one** transport, with a single-use server-issued nonce and never a bearer |
| Telegram or a push service as a verdict path | Same trigger as above, and it inherits every rule in 17.4. Telegram additionally sends card previews to a third party, which 21.6 forbids |
| Slack beyond drafting | A workspace administrator says yes **in writing** to a named scope list. Measure demand first with the connector already installed: 30 days of mention-shaped requests |
| Slack-clicker approvals | Never in this shape. It converts the approval credential from a file on the operator's disk into a chat-account session, and attributes a decision to a person who holds no provisioned key. Requires one provisioned human key per approving human |
| Card **parking** (persist the intent, end the run, re-materialise on approval) and a `deferred` disposition | One deliberate week of real use in which cards still die inside the 30-minute window. Then budget a protocol edit, a durable card-plus-input store, and a model-free execution path. It is not a TTL change (16.4) |
| The handoff verb | A deterministic lint plateaus with judgement-call residual edits over at least 20 promoted eval cases. Five exist. Test the critic hypothesis with an in-session subagent first: same configuration, zero protocol cost |
| A reviewer agent, or any second collaborating resident | Same trigger. The measured cost multipliers are consistent (roughly 6x tokens and latency, with a controlled benchmark finding multi-agent **less** accurate), and the discriminator for a useful critic is external information, not agent count. If the extra information is a checklist, the checklist is a lint |
| A second human principal | A named person actually needs to approve something. The park is load-bearing: admitting one fires the taint-rule trigger and the delegation-token reversal at the same time |
| Embeddings, vector indexes, reranking | Recall@5 below 0.85 or nDCG@10 below 0.60 on a labelled set built from the operator's own real questions. Try contextual chunk enrichment first: a preprocessing prompt, no new model, no vector store |
| Definition A/B comparison | 20 cases at `trials >= 4`, plus subject-by-member-id in the live runner, a memory story for the staged pack, and a scratch room. None of those is a comparison layer |
| The assembled-context viewer | A per-run context snapshot exists in the trace store, or the viewer is explicitly scoped to live runs only. Today the store keeps 300-character slices and the retrieved facts are rebuilt per turn, so a viewer over a past run can only re-assemble today's context |
| Flow-rule DSLs and a scanning proxy | An open-source runtime enforcement half exists that does not require an account and does not ship skills and knowledge to a third-party API. The successor product to the surveyed one requires both |
| Runtime goal-drift auditing | A drift finding exists in the ledger. There are zero, against an honest cost of a 2.5-4% false-positive rate and documented significant added latency on an answer path already at 11-25 s |
| ML anomaly baselines | Enough traces for a distribution. The system has produced 35 agent serve turns in its entire life; a z-score over that is a coin flip |
| The console review lane | The two expressible queues are non-empty for three consecutive weeks. Until then it is an `#ops` digest (20.5) |
| Judge TPR/TNR calibration | 10 confirmed failures exist. The negative class currently has two members (20.1) |
| A `sources` table with bodies; the fact-revalidation sweep | A human-owned source tier exists with at least one fact in it. All seven live facts are agent-origin |
| Mobile console work of any kind | A measured failure of the existing console on a phone-sized viewport during the deliberate week of rung 7: a decision the operator could not complete, written into the findings ledger. Until then, the browser on the private network, as-is. (The earlier trigger for this row read "Never", which is a preference and not a specification statement, in a table whose stated contract is that each line names what would unpark it) |
| Third-party scanning of agent knowledge or skill packs | Never in that scope. A local grep for injection markers covers the same plausible threat at zero egress |
| Per-token cost interrupts; hosted task budgets; policy-engine runtimes; a standards-tracking work item | Each keeps its own trigger. Two are worth naming: hosted task budgets are unavailable on this runtime and on both of its models, and the taint-rule trigger has already fired for any release that ingests another person's content |

### 23.2 Parked or rejected by wave 04 (named here so no reader expects them in v0.5)

Wave 04 re-judged every parked item under the "any organization, remote agents" premise. These belong to v0.6 or to no version at all, and this document specifies none of them.

| Item | Verdict and trigger (W4 sect. 7) |
|---|---|
| Cross-hub federation and cross-hub rooms | Rooms: out of scope, rejected more strongly than before (a second sequence authority invalidates the cursor, the chain and the single-winner claim at once). Federated directory search stays reserved |
| Group end-to-end encryption | Rejected, not deferred: incompatible with the pre-delivery gate, origin stamping, the chain, held-message review and the console |
| Tool passthrough under a namespace | **MUST NOT.** It contradicts opaque remote execution and makes the hub a confused deputy; the hub obtains its own upstream credential and never forwards a peer's token |
| A normative REST binding | Stays parked. Trigger: a named guest asks, or a named guest's runtime cannot hold a long POST |
| Registry publication | Stays parked, now on measurement. For fewer than 20 peers, one pinned thumbprint per peer is the directory |
| Contract-net auction verbs | Stays parked. Trigger: three competent guests for one skill plus a measured mis-assignment cost |
| SQLite to Postgres | Stays parked; it is not a driver change. Trigger: a second machine must write the same tables |
| Delegation chains with a max depth | Parked. Trigger: the parked handoff verb ships with a real consumer, since this work creates no hops |
| Scopes, and a fourth role | Scopes are a reserved field with no enforcement point; a fourth role is rejected because `home` plus the three existing roles covers it. Trigger for scopes: a second peer provably needing a different grant than the first |
| Probation as a member state | Rejected, with the correction wire spec 12.1 supplies: `held` **is** the probation mechanism. Hold a new peer until you have seen it do one thing correctly. No trigger |
| A remote conformance profile | Not added. Trigger: a second independent hub implementation |
| Hub receipts and chain anchoring | Parked with a correction: the cheap correct version is returning the chain head on every send and listen result |
| DPoP, RFC 9396 authorization details, SPIFFE, full-envelope signing | Each parked with a named trigger; full-envelope signing is structurally impossible and is rejected outright |

---

## Appendix A: where the evidence is thin (this amendment)

Carried forward rather than laundered into confidence.

1. **The lost approval cards are operator report.** Not in the findings ledger. The only documented live approval succeeded in 18 seconds. The code defects in section 16 are directly readable and stand on their own; the incident that set the priority ordering is not measured evidence (16.5).
2. **Proxy behavior on the long-poll is unmeasured.** Whether the private-network proxy carries `room_listen` and the console stream without buffering is a precondition for part of rung v0.5.1 and has not been tested (17.6).
3. **Which `Host` value a proxy forwards is unmeasured**, which is exactly why 15.4 is a SHOULD with a logged refusal rather than a MUST.
4. **The mid-approval budget stop has never been observed** (18.3). It is the highest-risk unknown in the release and has already produced two live bugs in adjacent code.
5. **Corpus starvation, measured 2026-08-17**: 433 observability spans of which 35 are agent serve turns; lifetime spend $2.65; 33 feedback rows of which 1 is human; 4 judge rows all valued 1.0; 2 rows in the entire project history matching the primary review queue; 7 consolidated facts, all agent-origin; 5 eval cases at `trials: 1`. Every requirement in section 20 is constrained by these numbers, not by design taste.
6. **Judge calibration is not computable today** and section 20.1 says so instead of scheduling it.
7. **Slack demand was never measured**, and the premise that the operator cannot install a workspace app was assumed rather than verified. Both are why section 23 gates that work on an answer from someone who has not been asked.
8. **The 5% per-question flake figure** is a recorded observation from the parity gate, not a controlled measurement; measuring the eval gate's own false-positive rate by repeated no-change runs is itself a v0.5.4 requirement (20.3).

---

## Appendix B: reserved vocabulary and deferred material (this amendment)

**Wire vocabulary this amendment depends on** (normative in RFA-0.1.md 12.4 and its Appendix B; NOT defined here, and this document is not a second registry for it):

| Token | Where it is defined |
|---|---|
| `expired` | Approval **resolution** produced by a clock rather than by a human. Wire spec 12.4, registered in its Appendix B. Landed in protocol 0.1.8 |
| `deadline_expired` | Refusal **reason** the requesting member's client sends when its approval window closes. Wire spec 12.4, registered in its Appendix B and in `room_send`'s Appendix A enum. Landed in protocol 0.1.8 |

**Named here so nobody invents it, and deliberately NOT reserved:**

| Token | Status |
|---|---|
| `deferred` | The `delivery` disposition card parking would need (23.1). It is **not** reserved in the wire registry, and reserving it would be a wire-spec edit against RFA-0.1.md 9.1's closed set (`live, queued, held, refused`), not a platform one. Named here only so no implementer invents it while parking is parked |

**Operator configuration reserved by this document:**

| Token | Meaning |
|---|---|
| `--bind`, `--allow-origin` | Operator configuration for 15.1 and 15.3, as shipped. `--allow-origin` is comma-separated, read once |
| `--allow-host` | Reserved for the Host allowlist of 15.4 if it ships (repeatable, unlike `--allow-origin`) |
| `tools.allow_subagents` | Pack-definition field for 18.7 |
| `rubric_hash`, `corpus_version` | Record and artifact fields for 20.1 and 19.4 |

**Where this document departs from wave 03's own text**, because the code says otherwise and the code wins:

1. W3 sect. 7.2 states that `npm run ask` defaults `reply_by` to 600 s. It defaults to **180 s** (`scripts/ask.ts:26`, `src/client.ts:287`). The requirement (30 minutes) is unchanged; the baseline it moves from is different.
2. W3 sect. 7.1 proposes a `--host` flag and an `Origin` **and** `Host` allowlist. What shipped is `--bind` and an `Origin`-only allowlist; the Host half is 15.4 and is PENDING.
3. W3 cites the resident's approval ceiling at `src/resident.ts:391` and the approval sweep at `src/store.ts:1968`. The current lines are `src/resident.ts:394` and `src/store.ts:1970-1971`. Same code, shifted by later edits.
4. W3 sect. 6 cites the cost-guard throw at `src/resident.ts:419`; it is at `:418`, with `spend.usd += costUsd` at `:429` as stated.
5. W3 sect. 7.5 cites the FTS5 MATCH builder at `src/memoryfs.ts:286`; line 286 is `if (terms.length === 0) return [];` and the builder is at `:287`.
6. W3 sect. 6 and v0.4 sect. 7.4 describe `maxBudgetUsd` as passed into every `query()`; `src/resident.ts:406` is a **conditional spread** and passes it only when the pack declares `per_task_usd` (18.5).
7. W3 sect. 7.8 states that `room_join` performs no name validation; `src/store.ts:476` validates the name grammar and throws `bad_request`. What is missing is the reserved-prefix guard (21.2).
8. W3 sect. 7.1 attributes "repeatable" to the Origin allowlist flag; that belonged to the proposed `--allow-host`. What shipped is a comma-separated `--allow-origin` read once (15.3).

**Where this document strengthens the wire spec, named rather than applied silently:** 16.3 makes the hold TTL derivation a MUST where wire 12.4 says SHOULD, and raises wire 12.2's 300 s default to a 1800 s floor.

**Not carried into this document at all:** wave 04's wire delta (its section 8) is v0.6 work and appears here only as section 23.2, plus the merged ladder of section 22. The v0.4 section 12 protocol-delta list is **struck** rather than extended (16.2).
