# RFA v0.6: Remote Peers (platform and operator mechanics)

**Platform specification, version 0.6.0 (draft)**
Status: Draft for implementation · Date: 2026-08-17 · License: Apache-2.0 (see LICENSE)
Depends on: **protocol 0.1.8** ([spec/RFA-0.1.md](RFA-0.1.md)), which is authoritative for everything on the wire: the `home` label and its grammar, task `attempt` / `max_attempts` / `requeue` / `lease_expires` / `released_at` / `claim_token`, the four task room policies and their defaults, `room_admin invite` and `redact`, the `admitted`, `task_released` and `redacted` system events, the `wrapped` field, the approval-ext shape, the `invite_invalid` / `lease_expired` / `bad_request` error codes, and the normative rules that carry no fields (transport-principal linkage, the `joined_after` clamp, quarantine keyed on the admission record, self-reports as decoration). This document defines none of those. It references them, and **the wire spec owns every default number**; where an earlier draft of this document restated one, it now cites it instead, because restating a default is how two documents come to disagree.
Depends on, and does not supersede: **[spec/RFA-0.5-platform.md](RFA-0.5-platform.md), which remains in force in full.** Two dependencies are explicit rather than incidental: the per-peer spend ceiling of sect. 7.1 reads the cost meter that v0.5 sect. 18 builds (v0.5 rung v0.5.2), and the exposure posture of sect. 4.5 amends v0.5 sect. 15 and 17. **The ordering of this document's rungs against v0.5's is fixed by the single merged ladder in RFA-0.5-platform.md section 22**, which supersedes the standalone table in sect. 11 below for sequencing purposes.
Amends and extends: [spec/RFA-0.4-platform.md](RFA-0.4-platform.md) (the platform layer, v0.4.0-v0.4.6). Section 1.3 lists the amendments.
**Section numbering.** This document restarts at 1 while RFA-0.5-platform.md continues v0.4's numbering at 15. A bare section number is therefore ambiguous across the three platform files, so this document always writes "v0.4 sect. N", "v0.5 sect. N", "spec N" (the wire) or a bare number for itself. Note also that "0.6" names both this document and the reference hub release cited throughout; hub releases are written "hub 0.6.0".
Evidence: every requirement traces to [research/04-remote-agents/REPORT.md](../research/04-remote-agents/REPORT.md) (cited **W4 sect. N**) or [research/03-reach-and-collaboration/REPORT.md](../research/03-reach-and-collaboration/REPORT.md) (**W3 sect. N**), after those reports' adversarial verification passes. Where a verifier refuted a recommendation, the refutation is what is specified here. Claims about current hub behavior were re-checked against the code at HEAD and are marked with file and line.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are as in RFC 2119.

---

## 1. Scope

### 1.1 What a remote peer is

A **local** agent is a pack the hub operator supervises (`agents/<name>/`, v0.4 sect. 3). A **remote** agent, called a **peer** here, is hosted elsewhere, possibly by another organization, on another framework, executing with tools the hub never sees. Both are ordinary members of one room on one hub. A peer is a **client of your hub**, not a peer hub: federation is out of scope (sect. 10).

Three things change when a member belongs to another organization (W4 sect. 1):

1. **The operator stops being the only party.** The hash chain (appended at `src/store.ts:2134-2137`; genesis is the SHA-256 of the public room handle, set at `src/store.ts:408`) is tamper evidence against a third party and worthless against the party running the process. Spec 13 states the scope qualifier in 0.1.8.
2. **The credential stops being shareable.** One room-wide `joinSecret` (`src/store.ts:384`, compared with `!==` at `:433`) grants any-name, any-card entry with no attribution, no per-holder revocation and no expiry.
3. **Read access stops being harmless.** Admitting one guest into a working room today is a bulk disclosure event before anyone moderates anything (sect. 7.3).

What does **not** change: the room is still the isolation unit, the policy gate is still the right place for per-counterparty content rules, and the platform's storage shape is untouched.

### 1.2 Division of labor with the wire spec

| Concern | Where |
|---|---|
| Field names, verbs, events, error codes, and rules that add no fields | protocol 0.1.8 |
| The admission record and its file | this document, sect. 3 |
| Transport authentication of `/mcp` | this document, sect. 4 |
| Lease durations, requeue policy, restart grace, idempotency mechanics | this document, sect. 5 |
| The peer-facing artifact and its acceptance test | this document, sect. 6 |
| Budgets, rate scoping, quarantine operations, visibility defaults, console | this document, sect. 7 |
| Topologies, storage, durability, backups, upgrades, `/healthz`, packaging | this document, sect. 8 |

Where this document restates a wire rule, it does so to state the **operator consequence**, and the wire spec governs any disagreement.

### 1.3 Amendments to v0.4

| v0.4 section | Amendment |
|---|---|
| 7.2 The gate | The gate's check-input contract becomes **versioned** and gains a task-shaped input alongside the envelope-shaped one, with a defined `hold`-to-`refuse` degradation (sect. 7.2). This reverses v0.4 7.2's assumption that the whole envelope is always the context. |
| 7.3 Approvals | The approval ext gains REQUIRED `{tool_name, input_preview}` and hub-stamped provenance (wire spec 12.5); the platform obligations are in sect. 7.4. Note separately that v0.4 7.3's "expiry resolves as reject via a log-derived sweep" is **superseded** by wire spec 12.4 and by v0.5 sect. 16.2, not by this document. |
| 7.4 Budgets (three layers) | Gains a per-peer layer: `usd_per_day` and `peer_rpm` keyed on the admission record (sect. 7.1). Layer 2's room-policy `member_rpm` is unchanged in meaning; the per-peer counter is a **second, differently named** budget, and the effective limit is the minimum of the two. |
| 9 Console | Gains the guest-rendering obligations of sect. 7.6. |
| 10 Deployment | Gains topologies, container packaging, `/healthz`, migration and durability requirements (sect. 8), and the exposure amendment of sect. 4.5. The launchd path stays. |
| 12 Protocol deltas | **Struck**, not retargeted. Three of its four deltas landed in 0.1.7 and the fourth (the handoff verb) is parked by wave 03 and wave 04 alike and appears nowhere in 0.1.8. The protocol deltas of record are the wire spec's own Appendix E changelog. (An earlier draft of this document said "retargeted to 0.1.8", which as written dragged a parked verb into a release it is not in.) |
| 13 Build path | Extended by this document's rungs, **sequenced in the merged ladder of v0.5 sect. 22**. |

---

## 2. Terminology delta

| Term | Meaning |
|---|---|
| **Peer** | An organization or deployment other than the hub's own, admitted to this hub as a remote member and identified by `peer_id`. This is the wire spec's definition verbatim, and the narrower reading matters: admitting a second team **inside your own company** as a peer gives it a `home !== "local"` and therefore the forced `joined_after` clamp, forced evidence at claim, and no verification authority. That may be exactly what you want, but it is a consequence to choose deliberately, not a side effect of picking a convenient identifier. |
| **Admission record** | The operator-provisioned entry in `deploy/peers.json` that is the root of a peer's identity on this hub (sect. 3). |
| **`home`** | The opaque org label the hub derives from the admission record and stamps on the wire. `"local"` is reserved for the hub's own organization. Defined by protocol 0.1.8. |
| **Guest** | Informal, operator-facing word for a member whose `home !== "local"`. Not a role and not a member state. |
| **Invite** | A hub-minted, single-use, expiring `invite_token` bound to one `peer_id`, produced by `room_admin invite`. |
| **Cold-start test** | The standing acceptance test of sect. 6.3: a container with no repository access joins and completes one task from the interop document alone. |
| **Supervisability** | Whether this hub's supervisor owns the member's process. A genuinely separate fact from `home`, and it does **not** go on the wire: the hub already knows it (W4 TL;DR). |

`home` and supervisability are orthogonal. A LangGraph process on your own VPS is accountable-local and unrestartable; a pack under your supervisor is both. Do not derive one from the other.

---

## 3. The admission record

### 3.1 The file

The hub reads `deploy/peers.json`, an operator-provisioned file holding one record per peer (W4 sect. 2). It is the root of remote identity on this hub: **everything about a peer that the hub enforces is keyed on `peer_id`**, and revoking the record is the kill switch (sect. 7.2).

```json
{
  "version": 1,
  "peers": [
    {
      "peer_id": "p_orgb_worker",
      "home": "orgb.example",
      "display_name": "Org B research desk",
      "name_hint": "orgb-analyst",
      "key_thumbprint": "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
      "expires_at": "2026-11-17T00:00:00Z",
      "admitted_by": "principal_paul",
      "bearer_sha256": "b1946ac92492d2347c6235b4d2611184e0e1c0a0a1c0f1e0d9c8b7a6f5e4d3c2",
      "bearer_issued_at": "2026-08-18T09:00:00Z",
      "bearer_expires_at": "2026-11-17T00:00:00Z",
      "max_memberships": 2,
      "peer_rpm": 10,
      "task_actions_per_min": 10,
      "usd_per_day": 1.00
    },
    {
      "peer_id": "p_partner_ops",
      "home": "partner.example",
      "display_name": "Partner ops bot",
      "name_hint": "partner-ops",
      "key_thumbprint": "hQ2Rk0tG7d0h6WlpXfM3s8bWnJZ3s0Yy9m1kQ2pT4cU",
      "expires_at": "2026-09-30T00:00:00Z",
      "admitted_by": "principal_paul",
      "bearer_sha256": "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b88ca046dea",
      "bearer_issued_at": "2026-08-18T09:00:00Z",
      "bearer_expires_at": "2026-09-30T00:00:00Z",
      "max_memberships": 1,
      "peer_rpm": 4,
      "task_actions_per_min": 4,
      "usd_per_day": 0.25
    }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `peer_id` | string | MUST | Stable opaque id. The key for quarantine, budgets, membership caps, rate windows and claim re-binding. Never reused. |
| `home` | string | MUST | The opaque org label stamped on the member record, presence, roster snapshots and `envelope.from` (0.1.8). MUST NOT be `"local"`. MUST be derived from this field and never from console free text. |
| `display_name` | string | MAY | Operator-facing alias for consoles and runbooks. Carries no wire meaning and MUST NOT be substituted for `home`. |
| `name_hint` | string | MAY | Requested room name. The hub still applies the 4.1 collision auto-suffix and returns the assigned name. |
| `key_thumbprint` | string | MUST | RFC 7638 JWK thumbprint of the peer's signing key. Card signatures resolve against it. |
| `expires_at` | ISO 8601 | MUST | Admission expiry. Memberships admitted under this record MUST expire with it. |
| `admitted_by` | string | MUST | The hub-local **principal identifier** of the human who admitted the peer. This is the audit anchor for the written agreement (sect. 7.7) and it is what the `admitted` event carries (spec 9.7). It is deliberately NOT a member id: the admitting human need not be a member of the room. |
| `bearer_sha256` | string | MUST | Hex SHA-256 of the transport bearer this hub minted for this peer (sect. 4.2). The plaintext bearer is **never** stored in this file; the operator delivers it once over the confirmed channel and the hub compares digests in constant time. |
| `bearer_issued_at` | ISO 8601 | MUST | When the current bearer was minted. Rotation is an edit of these three fields. |
| `bearer_expires_at` | ISO 8601 | MUST | Bearer expiry, independent of `expires_at`: a bearer may be rotated without re-admitting the peer, and a peer may be de-admitted without waiting for its bearer to lapse. |
| `max_memberships` | integer | MUST | Concurrent memberships this peer may hold across the hub. |
| `peer_rpm` | integer | MUST | Per-peer message budget (sect. 7.1). **Renamed from `member_rpm`** in this revision: the wire spec already owns `member_rpm` as a per-member room policy (spec 5.1), and two budgets with one name and different scopes is how an implementer ends up unable to say whether a peer holding two memberships gets 10 or 20. |
| `task_actions_per_min` | integer | MUST | Per-peer mutating-task-action budget (sect. 5.6), the per-peer counterpart of the room policy of the same name (spec 5.1). |
| `usd_per_day` | number | MUST | Daily model spend attributable to this peer (sect. 7.1). |
| `scopes` | array | reserved | **Reserved with no enforcement point.** See sect. 10. A hub MUST ignore it. |

The `version` wrapper, `display_name`, and the three bearer fields are conventions of this file, not wire fields. Records MUST be validated on load; a malformed file MUST fail the hub loudly at startup rather than admitting a peer with defaulted limits, and a `home` that is `"local"` or does not match the wire spec's 4.3 grammar MUST be a validation failure.

**Reload, because the kill switch depends on it.** The hub MUST watch `deploy/peers.json` and re-validate it on change, without a restart: sect. 7.2 requires that removing or expiring a record invalidate every membership under it **on the next call**, and a startup-only read makes that sentence false. A malformed edit at runtime MUST be rejected with a loud log line and the previously valid record set retained; a hub MUST NOT fall back to an empty set, because an empty set is an all-local hub that has quietly forgotten it has guests. Records are keyed by `peer_id`; `peer_id` is never reused.

**Key rotation.** Rotation of the signing anchor is an edit of `key_thumbprint`. The hub MUST keep a per-`(peer_id, kid)` invalidation timestamp so a routine rotation and a compromise are distinguishable, and verification of a stored signed object resolves the key valid at that object's `ts` (spec 6.4 states the rule normatively; the storage shape of the timestamp is implementation-defined and remains an open question in this draft, since the reference hub stores neither).

### 3.2 Issuance is local; anchoring is the peer's key

These are two orthogonal problems that wore one name and produced contradictory advice until they were separated (W4 TL;DR, sect. 2). Separate them permanently.

**Credential issuance is always local. The hub mints, the hub revokes.**

- `room_admin invite {peer_id, ttl_s}` (human-origin only, over the existing authority path) mints a single-use expiring `invite_token` bound to a `peer_id`. `room_join` accepts `invite_token` or the legacy `join_secret`.
- The legacy room-wide `join_secret` stays legal and SHOULD be restricted to rooms whose members are all local.
- A hub MUST NOT accept an access token issued by the **peer's own** identity provider. MCP 2026-07-28 states that servers must only accept tokens valid for their own resources and must not accept or transit any other token. This is the shape people assume for cross-org, and it is the one shape that is forbidden.
- Later, and only when a named peer's answers require it, the same issuance can move to a **guest client in the operator's own identity provider**. That is a change of issuer within the operator's own trust domain, not a change of principle.

**Identity anchoring is the peer's key.** The admission record pins the peer's RFC 7638 thumbprint; card signatures resolve against it. `src/signing.ts` already does JWS over JCS with EdDSA and ES256 and binds `kid` to the thumbprint when a key is embedded, so this is a per-peer lookup and configuration, not new cryptography.

**The two must be linked or neither means anything.** 0.1.8's rule ("the hub MUST reject a call whose membership was admitted under a different transport principal than the one presented") is what stops a second credential from becoming a second independent path into the same membership. The operator consequence: adding transport authentication (sect. 4) without the linkage rule makes the hub **less** safe, not more, because `membership_token` travels as an ordinary tool argument through every client's logs and transcripts (`src/store.ts:2001-2013`).

### 3.3 Admission handshake

1. The peer sends its **signed** capability card and its public key out of band. The operator confirms the RFC 7638 thumbprint through a second channel (a call, a signed email thread, an existing contract contact).
2. The operator pastes the card into the console, writes the admission record, and pins `key_thumbprint`. There is **no fetch path**: admit-by-URL against a well-known agent card is rejected (sect. 10).
3. The operator mints the peer's transport bearer, records its digest in `bearer_sha256`, and delivers the plaintext bearer over the confirmed channel. **A peer cannot make its first HTTP call without this**, so it is a step and not an implementation detail (sect. 4.2).
4. The operator calls `room_admin invite {peer_id, ttl_s}` and delivers the single-use `invite_token` over the same confirmed channel. `ttl_s`, entropy, durable single-use consumption and the `bad_request` bound on an over-long `ttl_s` are all fixed by spec 12.1.
5. The peer calls `room_join {invite_token, name, card}` **with its bearer on the transport**. The hub verifies the card signature against the pinned thumbprint, stamps `home`, records `peer_id` and the transport principal on the membership, and appends `system {event: "admitted"}`.
6. A replayed, expired or unknown invite fails `invite_invalid`. A card that is **unsigned**, signed by an unpinned key, or signed with an algorithm outside {EdDSA, ES256} (`src/signing.ts:105`) fails `join_denied`. That an unsigned card is refused is not an inference from this document: spec 4.3 and 6.1 make a signed card a MUST for any member admitted under an admission record, and spec 16 makes the `signing` profile REQUIRED for a hub that admits guests. Without that rule, admission would rest on the invite alone, which is exactly the single-credential shape sect. 3.2 argues against.
7. **Rotation mid-membership.** Editing `key_thumbprint` does not evict anyone: existing memberships continue, the old `kid` keeps verifying objects stored before the invalidation timestamp, and the next join must present a card signed by the new key. To treat a rotation as a compromise instead, the operator sets the invalidation timestamp and evicts.

`policies.join: "approve"` (specified since 0.1, never implemented) is **superseded**: an invite *is* a pre-approval, minted by a human-origin verb through the existing authority path. Keep the enum value for compatibility and stop citing it as the admission path (W4 sect. 7).

### 3.4 Rejected permanently, so it stops coming back

An **authorization server inside the hub is rejected permanently.** Not deferred, not parked: the hub validates credentials and never issues OAuth tokens (sect. 4.3). Also rejected outright, with the reason so nobody re-proposes them (W4 sect. 2): Dynamic Client Registration; a registry as a trust root; DIDs and verifiable credentials; macaroons (HMAC-chained, so every verifier can forge, fatal across orgs); biscuit (solves offline attenuation, which a hub-mediated room does not have); UCAN; GNAP; IBCTs from AIP (its own limitations section records no production deployment, localhost-only evaluation, unenforced revocation); a DNS TXT domain proof as a second anchor (zero users, and it adds unauthenticated DNS to the trust base); SPIFFE/SPIRE as anything but an optional mTLS adapter for an org already running SPIRE; and flat verb scopes (sect. 10).

---

## 4. Transport authentication for `/mcp`

### 4.1 What the reference hub does today

`src/main.ts:327` routes `/auth` and `/api/*` to the workbench, `:331` serves the console, and **everything else falls through to the MCP handler with no credential check** (`:341` onward). The only gate ahead of it is the Origin allowlist (`:157-167`), which by design passes any request with no `Origin` header, that is, every non-browser client. Consequences, all current:

- `POST /mcp` is unauthenticated.
- `room_create` takes no credential at all, so it is an **uncredentialed resource-creation primitive** on any hub reachable by a peer.
- `src/client.ts` `rawCall` (`:609-628`) sends no `Authorization` header, so the reference client cannot present one either.

### 4.2 The minimum

Before any non-local peer is admitted, a hub MUST:

1. Require a **bearer credential at the HTTP transport** on `/mcp`, rejecting an unauthenticated request before the MCP handler sees it.
2. Require that credential on `room_create` specifically, so resource creation is never anonymous. **A credential admitted under a peer admission record MUST NOT authorize `room_create`**: a guest that can mint rooms is a guest that is the host of them, with room-admin rights (spec 5.2) that no containment rule in sect. 7 anticipates. Room creation is an operator credential only.
3. Validate that the credential's **audience is this hub's own resource identifier** and reject a token minted for another resource (the RFC 8707 audience rule, enforced server-side).
4. Enforce the 0.1.8 linkage rule: reject a call whose membership was admitted under a different transport principal than the one presented.
5. Return `503` with `Retry-After` during drain, and never a bare connection reset (sect. 8.6). **This is a strengthening of spec 9.5's SHOULD, declared here rather than applied silently**: for a hub that admits guests it is a MUST, because a peer's client is written by someone the operator cannot ask to handle a reset gracefully, and spec 9.5's bounded-jitter retry rule is only useful against a response it can read.

These five are **preconditions for admitting a peer, not a rung**. The merged ladder of v0.5 sect. 22 sequences them accordingly: items 1 to 3 land in the locally-correct rung v0.6.0a because an unauthenticated `/mcp` is a defect in an all-local hub, and items 4 and 5, together with sect. 4.4's per-human requirements and sect. 8.9's release obligations, land before any peer is admitted rather than after. A deployment that admits a peer while any of the five is missing is non-conformant, and the ladder is written so that cannot happen by construction.

A **static, audience-bound, per-peer bearer** satisfies all five. RFC 9728 protected-resource metadata is deferred until a second peer exists (sect. 10). When it is built, note the path rule: metadata for resource `https://h/mcp` lives at `https://h/.well-known/oauth-protected-resource/mcp`, so either use a pathless canonical resource URI or get the path insertion right.

**The credential, specified rather than named.**

- **Form.** An opaque high-entropy string, at least 32 bytes from a CSPRNG, presented as `Authorization: Bearer <token>` on every request to `/mcp`. It is not a JWT and carries no claims. Only its hex SHA-256 is persisted, in the admission record's `bearer_sha256`; the hub compares digests with a constant-time comparison.
- **Issuance and delivery.** The operator mints it and hands it over once, on the same out-of-band channel that confirmed the key thumbprint (sect. 3.3 step 3). The hub is a resource server and never runs an issuance endpoint (sect. 4.3).
- **Audience binding for an opaque token.** RFC 8707's `aud` validation applies to a token with claims; an opaque bearer has none, so the audience rule takes its equivalent form and must be written as such rather than cited by RFC number: **this hub minted this token for this resource**, which the digest lookup establishes by construction, because a digest that is not in this hub's own record set is not this hub's token. A hub that later accepts a JWT instead MUST validate `aud` against its own resource identifier, MUST validate `iss` against the operator's own identity provider, and MUST reject a token minted by the peer's identity provider outright.
- **Recording the transport principal.** On a successful `room_join`, the hub records `peer_id` **and** the `bearer_sha256` that authenticated the call on the membership. Spec 4.3's linkage rule is then a digest comparison on every subsequent call: a different bearer on a membership is `unauthorized`. Without this the second credential is decoration, because `membership_token` travels as an ordinary tool argument (`src/store.ts:2001-2013`).
- **Rotation and revocation.** Rotation is an edit of `bearer_sha256` and `bearer_issued_at`, which invalidates every membership bound to the old digest at its next call, exactly like revocation. There is deliberately no overlap window in this revision: a peer that needs a zero-downtime rotation is a peer that has been named, and that is when to add a second accepted digest.
- **Expiry.** A call presenting a bearer past its `bearer_expires_at` fails `unauthorized`, the same as an expired admission record (spec 4.3).

**One unrun spike still gates the shape** (sect. 4.4): whether a real MCP host can carry a static `Authorization` header into a registered server. If it cannot, the credential moves into the tool arguments instead and this whole subsection changes shape.

### 4.3 The hub is a resource server, never an authorization server

The hub acts as an OAuth 2.1 **resource server**: it VALIDATES tokens and never ISSUES them. Building an authorization server inside the hub is rejected permanently (sect. 3.4). The corrected reading that unparks this at all (W4 sect. 7, correcting wave 03's T1 rejection): the client MUST that wave 03 read as unsatisfiable is the *client's* obligation to send `resource`; the *server's* obligation is to validate `aud`, which a mainstream IdP satisfies with an audience mapper.

### 4.4 Honest status

- **MCP authorization is verbatim OPTIONAL** in the 2026-07-28 specification. Nothing RFA does today is non-conformant: `membership_token` is a tool argument, not an OAuth bearer. Requiring transport authentication is **the operator's choice**, made because an unauthenticated `/mcp` on a hub other organizations dial into is indefensible, not because a specification compels it.
- **Not implemented.** No transport credential exists in the reference hub today, on either side.
- **One unrun spike gates the shape** (W4 sect. 11, spike 11): whether a real MCP host can carry a static `Authorization` header into a registered server. If it cannot, the credential has to move into the tool arguments instead, and this section's shape changes. Do not treat the header path as settled until that spike runs.
- Per-human credential handling is in scope for the same rung and is not remote-specific: `src/main.ts:215` compares human keys with a non-constant-time `includes`, and `consoleMembership()` matches `name.startsWith("console")`, so one shared membership decides every approval. A hash-chained log that cannot say which human approved undermines the pitch. `principal_id` records, `timingSafeEqual`, and per-principal console memberships with exact-name matching are REQUIRED before a peer's work reaches a human approval card (W4 sect. 7). The grant matrix stays parked.

---

### 4.5 Exposure: how a peer actually reaches the hub (amends v0.5 sect. 15 and 17)

v0.5 sect. 15.1 binds the hub to loopback by default and v0.5 sect. 17.1 obtains reach through a proxy on an operator-controlled private network. A peer at another organization cannot be on that network, so this document has to say what changes, and the honest answer is that it changes narrowly.

- The hub's listener MUST stay on loopback (v0.5 sect. 15.1 is unchanged). A peer reaches it through a **public reverse proxy the operator controls**, terminating TLS, forwarding only `POST /mcp` and `GET /healthz` to the loopback listener.
- **The proxy MUST NOT forward any workbench route** (v0.5 sect. 15.2's definition: everything other than `/auth`, the console document, `/healthz` and `/mcp`), and MUST NOT forward the console document or `POST /auth`. The workbench keeps its private-network posture from v0.5 sect. 17.1 unchanged. Two proxies, two audiences: the operator's own devices reach the console over the private network, peers reach `/mcp` over the public one.
- On the public path the transport bearer of sect. 4.2 is the **only** credential, so v0.5 sect. 15.2's prohibition ("an operator MUST NOT expose `/mcp` through a proxy") lifts exactly when sect. 4.2 ships and not before. Until then, exposing `/mcp` publishes `room_create`, `room_listen`, `room_roster` and `room_task list` to whoever reaches the proxy.
- The `Host` allowlist of v0.5 sect. 15.4 becomes a **MUST** on the public path, because on a public listener a wrong `Host` is a request from somebody who did not mean to reach you.
- v0.5 sect. 17.1's rule that the hub MUST NOT be relocated to a rented host is unchanged. A reverse proxy in front of a loopback listener is not a relocation: the keys, the packs, the memory databases and the chain stay where they were.
- **Unmeasured, and stated rather than assumed:** whether a given public proxy carries a 20-second `room_listen` POST without buffering or idle-timing it out. v0.5 Appendix A already records the same unknown for the private proxy. This is a precondition for the cold-start test of sect. 6.3 and it is the first thing to measure when rung v0.6.0a starts, not the thing to design around afterwards.

## 5. Remote task execution

The wire fields (`attempt`, `max_attempts`, `requeue`, `lease_expires`, `released_at`, `claim_token`), the `task_released` event and the four bounding room policies are defined in 0.1.8, **with their defaults**; this section does not restate a number the wire owns. It defines the operator mechanics around them. Two defects in shipped code make a remote worker unusable today and both are confirmed: a claimed task is **never** released by any code path (`claim` sets owner and state at `src/store.ts:1663-1674`; the sweep does not look at task ownership; `task_overdue` mutates nothing; `removeMembership` does not touch owned tasks), and a reconnecting worker cannot complete its own work (every join mints a fresh `m_` id at `:497` while `complete` requires `task.owner === member.id` at `:1704`).

### 5.1 The lease and its renewal

- A claim is a **lease**, fenced by the monotonic `attempt` integer on the public task event. The `claim_token` returned in the claim result is a secret and MUST NOT appear in any event, roster snapshot, log line or console rendering.
- **Presence renewal renews the claim.** This is free: presence renewal already happens on every `room_listen` (spec 9.3). A hub MUST NOT introduce a separate claim heartbeat. Spec 10.3 fixes the derivation: the task's `lease_expires` **is** the owner's presence `lease_expires`, restamped on each presence renewal.
- No `lease_ttl_s` policy, no 30..3600 clamp, and no `task_lease_grace_s` are specified: once presence renews the claim, the only case that ever expires is a member going fully offline (W4 sect. 4, correcting the original three-timer proposal). The reference hub's presence defaults are `defaultLeaseS` 180 with `minLeaseS` 30 and `maxLeaseS` 900 (`src/store.ts:103-105`), and a member's actual lease is per-call within that range.
- Lease renewal SHOULD also be expressible through the existing `update` action so a working peer that is not listening can hold its claim; no new `progress` verb is specified.

### 5.2 When a peer goes dark

- Release fires on the **existing** offline transition, on `leave`, on eviction, and on the explicit `release` verb. The sweep already detects offline members and emits `gone_quiet` (`src/store.ts:1902-1915`), so this is a branch in a loop that already runs.
- Release does what spec 10.3 states in full, and the operator-visible half of it is that a released task is claimable again: `owner` cleared, `state` back to `submitted` unless it was `input_required`, `lease_expires` nulled, `released_at` stamped, the outstanding `claim_token` invalidated, and `system {event: "task_released"}` emitted with `reason` one of `offline`, `leave`, `evicted`, `released`.
- **`max_attempts` defaults to 1** (via the room policy `max_attempts_default`, spec 5.1) and automatic requeue is the per-task `requeue` flag, default `false`. A remote task may already have filed a document or moved money in infrastructure the hub cannot see; the honest default for a cross-org side effect is one execution plus a released task that a human or another member picks up deliberately (W4 sect. 4, correcting a proposed default of 3). Spec 10.3 fixes what happens when attempts are spent: `claim` fails `task_conflict` and the task stays `submitted` and pickup-only for the creator, host or a human principal.
- A returning worker that presents a valid `claim_token` from a **new member id** re-binds ownership only when the presenting membership carries the same `peer_id` where an admission record exists, and the same authenticated principal otherwise (spec 10.3). The "otherwise" half is the one the operator meets daily: a **local** resident restarted by the supervisor has no `peer_id`, and without the fallback the reconnect lockout this section exists to fix stays open for exactly the case that occurs most. A membership admitted on a shared `join_secret` alone carries no principal and cannot re-bind; it re-claims. A stale token fails with `lease_expired` carrying `{current_attempt, current_owner, task_state}`, which is enough for a client to recover without a human.
- The concurrent-claim cap is the room policy `max_claims_per_member` (spec 5.1).

### 5.3 Restart grace

After boot, the hub MUST NOT expire a claim for **one full lease period**, meaning the hub's configured default presence lease (`defaultLeaseS`, 180 s at the reference default), not the released member's own last lease and not `maxLeaseS`. Absence of a heartbeat during hub downtime is the hub's fault, not the peer's.

`reply_by` is the opposite case and its existing behavior is unchanged: it is an absolute requester SLA and deadlines that expired during downtime fire on the first sweep after restart (spec 0.1.1 errata). Implementations MUST NOT conflate the two clocks.

*(Evidence note: the 60 s figure circulating for lock-delay defaults comes from a source that could not be read during verification, W4 sect. 10. The number above is chosen and written down, not cited.)*

### 5.4 Idempotency that survives a restart

Today `room_send` idempotency consults only the in-memory `room.dedupe` map, reset to a fresh `Map()` on load (`src/store.ts:2231`), while the per-member `sentIds` set **is** rebuilt from the log on load (`:2277`) and never consulted for idempotency. A peer that resends after a hub restart double-appends.

- The hub MUST consult the log-derived per-member sent set, so a replayed `message_id` after a restart does not append a second event.
- The replayed result is **degraded and MUST say so**: `SendResult.recipients` is computed at send time and never persisted, so a replay can return the original `seq` and `ts` but cannot return the original recipient dispositions. Spec 9.1 now states the shape (`{seq, ts, replayed: true, recipients: []}`); implementations MUST NOT fabricate dispositions to fill it.
- The windows are bounded by the caps in code: `sentIds` is capped at 500 per member (`:917`) and `dedupe` at 2000 (`:965`). A specification sentence promising "as long as the log retains the message" would be stronger than either implementation, so do not write one.

### 5.5 Everything a peer says about its own execution is decoration

This is the rule that makes any rich result object safe. It is normative as **wire spec section 14, item 12**, quoted here exactly:

> Everything a peer reports about its own execution - cost, tool traces, progress percentages, a self-declared verification status - is untrusted decoration. Implementations MUST render it as self-reported and MUST NOT make it an input to any automated decision.

Concretely, for this platform:

- A peer-reported cost MUST NOT be added to any spend ledger. Per-peer ceilings are computed from **this hub's own** cost records (sect. 7.1).
- A peer-reported completion percentage MUST NOT advance a task state, release a dependency, or resolve an approval.
- Only a local member, the task creator, or a human principal changes task state through `verify`.

### 5.6 Task-action budgets

Mutating `room_task` actions MUST be counted against a **separate task-action budget**, not against the message budget. The message budget's counter only advances in `send` (`src/store.ts:918`); sharing one window means a worker doing progress-plus-complete spends the budget it needs to answer a question.

- The **room-wide** budget is the wire policy `task_actions_per_min` (spec 5.1), which owns the default and the `rate_limited` error.
- The **per-peer** budget is `task_actions_per_min` in the admission record, and the effective limit is the minimum of the two, exactly as sect. 7.1 does for messages.
- **The counter key**, for both budgets and for every other rate window in this document: `peer_id` where an admission record exists, and the membership's **authenticated principal** otherwise, mirroring spec 12.1's quarantine wording. A local member keeps the existing per-member key. Keying on `peer_id` alone would silently drop rate limiting for the operator's own residents, which is a regression against the shipped per-member `rateWindow` (`src/store.ts:522-523`, `:918`).

### 5.7 Who may verify

`verify` today authorizes any member whose id differs from the owner (`src/store.ts:1722`), which means one principal holding two memberships accepts its own evidence, and any single member can reject every evidence-bearing completion forever (reject returns the task to `working`, with no cap and no terminal state).

- The verifier MUST be a **local member, the task creator, or a human principal**, and MUST NOT share the owner's `peer_id` or authenticated principal (spec 10.4). The second half is the one that actually closes "one org accepts its own evidence"; a different member id is not a different party.
- The hub records `verification.verifier_home` beside `verification.verifier` (spec 10.2), which is the field sect. 7.6 requires the console to display.
- `evidence_required` MUST be forced **at claim time** when the claimer's `home !== "local"`. Setting it at create time cannot work: the flag is fixed before any owner exists, so the default path leaves `complete` terminal with no verifier at all.
- Consecutive rejections are capped by the room policy `max_rejections` (spec 5.1, which owns the default and the terminal transition); the counter is per `(task_id, attempt)` and does not reset on an `input_required` bounce.
- Honest caveat, carried rather than laundered: "the verifier must be local" re-imports the single-operator assumption for a room with two remote orgs and no human present. That is why creator-or-human are alternatives, and why a room of only guests has no sound verifier today.

---

## 6. What a peer must be given

The stranger surface appears to work already: a remote agent joined the standing room, claimed a task, completed it with evidence and got verified, three separate ways (curl alone, `langchain-mcp-adapters`, and a 40-line pure-`httpx` member with no `mcp` dependency), because **MCP-over-HTTP is plain JSON POST** (W4 sect. 3). **That result is reported in W4 sect. 3 and is uncorroborated by any committed script** (Appendix B): the code paths make it near-certain, which is not the same as measured, and the qualification belongs here rather than eleven pages later because this section is the one that justifies specifying nothing new on the wire. What is missing is the artifact, and the drafted artifact ships wrong.

### 6.1 `INTEROP.md` (normative contents)

A hub operator admitting any peer MUST publish an interop document containing at least:

1. **The six-call minimum**: `room_join`, `room_listen`, `room_send`, `room_roster`, `room_presence`, `room_leave`, with one worked request and response each, plus `room_task` for a peer that will do task work.
2. **The admission handshake** of sect. 3.3, from the peer's side: how the key is confirmed, that the invite is single-use and expiring, what `invite_invalid` and `join_denied` mean, and that membership expires with the admission record.
3. **Cursor discipline**: `since` is the only resume mechanism; a quiet listen is normal and the returned cursor is what you call again with; `timeout_ms` SHOULD be at most 45 000 ms under interactive MCP hosts, which is spec 9.3's client guidance and has nothing to do with the coincidentally-45-second observation in item 6; for a guest, `since` is clamped to the join point, so `since: 0` legitimately returns nothing.
4. **Lease renewal**: listening renews presence, presence renewal renews the claim, a peer that stops listening loses its claim (sect. 5.1), and a returning worker completes with its `claim_token`.
5. **The boundary wrapper obligation**: spec 14.3 is a MUST on client SDKs. Peer messages reach a model wrapped as untrusted data with sender-name sanitization. The hub also returns `wrapped` alongside `body` (0.1.8), and a peer client SHOULD use it, but the obligation to wrap does not transfer to the hub.
6. **A per-framework timeout table.** The table MUST exist and every row MUST stamp the era and the client version it was measured against. **No numbers are stated normatively here**, because sect. 13 makes it a MUST that any number entering normative text has a committed spike script and none exists; two rows were reported in W4 sect. 3 as **operator report, uncommitted** (an OpenAI Agents SDK client-session timeout defaulting to a few seconds, so a 20-second `room_listen` dies with a timeout error that reads to a stranger as "RFA is broken"; and `langchain-mcp-adapters` surviving a long poll only because the hub answers a legacy-era client with SSE framing governed by a different timeout). The second observation carries its own warning wherever it is written down: it is **an accident of the dual-era handler and MUST NOT be published as a per-framework contract**, and its coincidental agreement with item 3's recommended ceiling has no shared cause.
7. **Error handling**: the RFA error object and its codes, that input-validation failures are wrapped in the RFA envelope as `bad_request` (the MCP v2 SDK returns them as plain text otherwise, which is the error class a learner hits most), bounded-jitter retry for idempotent reads, and honoring `retry_after_s` and `Retry-After`.
8. **The extension fallback rule**, as RFA's own MUST: a client that does not implement a declared extension either falls back to the documented behavior or rejects the request when the extension is mandatory. Do not attribute RFC-2119 wording for this to MCP; MCP's actual text is softer, and one fabricated verbatim quotation was found and must not propagate (W4 sect. 10).
9. **The outbound disclosure** of sect. 7.7: what the hub logs, who can read it, the retention window, that the operator can hold, edit and inject mid-flight, that the peer's text may be quoted into a human approval card, and how to export on leave.

### 6.2 The sample client

The interop document MUST include at least one complete, runnable sample client, and **every sample it ships MUST include the boundary wrapper of spec 14.3 and the sender-name allowlist of spec 9.6**. That is the load-bearing requirement, and it is a design requirement rather than a documentation nit: a flagship interop asset that returns raw peer envelopes to its caller is the wormable default spec 14.3 forbids, and it will be copied far more often than any SDK is installed. It is roughly eight lines to fix.

The language is not mandated. A hub operator whose peer writes Java or Go is not served by a Python requirement, and the earlier draft of this document turned one project's own artifact into an obligation on every operator. **The reference project ships `rfa_min.py`**, and its constraints are:

- It depends on `httpx` only. It MUST NOT depend on `mcp` (if an implementer wants that dependency, `mcp>=1.28,<2` is the pin).
- No PyPI package is published. Trigger for a package: more than three peers diverging from the sample (sect. 10).
- The hub MUST offer already-boundaried text (`wrapped`) because the one thing an operator cannot control across an organizational boundary is whether the peer's client does its homework. This is also the answer to the mirror question a reviewer at the peer's org will ask: "we hand you the wrapped form" beats "we documented that you should wrap it".

### 6.3 The cold-start test (normative acceptance criterion)

> A container with **no access to this repository and no shared filesystem**, holding its own domain and key, given only the interop document and one invite, MUST join a room, claim a task, complete it with evidence, and leave.

This is the acceptance criterion for the whole remote surface, not a demo. It is the only honest measure of whether the stranger surface works, because every other measurement in this wave was taken from inside the repository by people who know the assumptions (W4 sect. 11, spike 1).

- It MUST be kept green as a standing regression, and it is the guard against exactly the local-assumption drift that produced the reconnect lockout (sect. 5) and the history bypass (sect. 7.3).
- The harness is `npm run remote-conformance`, which walks join, claim, complete-with-evidence and leave against a live hub. **It does not exist yet** (sect. 12); it is a deliverable of the rung that first admits a stranger client, not a description of current tooling.
- A failure of this test is a defect in **the interop document or the hub**, never in the peer.
- It is also the standing test that the sixty-day clock of sect. 9 runs from.

---

## 7. Containment, limits, and the operator's loop

### 7.1 Per-peer budgets and rate limits

**Money.** A guest can address a local resident and burn the operator's model budget indefinitely. This is the cheapest real containment in the wave and it is built on data that already exists (`data/obs.db` records USD per run, v0.4.3).

- `usd_per_day` from the admission record MUST be checked **at the start of every run attributable to a non-local requester**, before any model call: a serve turn answering a guest's `request` envelope, a scheduled job a guest triggered, and a room-task pickup alike. Checking only at task pickup, as an earlier draft of this section said, leaves the threat it opens with wide open, because a guest that only sends `request` envelopes to a local resident never claims a task.
- The day window is the **UTC calendar day**, computed from the `data/obs.db` rows for that `peer_id`. A run already in flight when the ceiling is crossed is allowed to finish; the overshoot is bounded by the per-task ceiling of v0.5 sect. 18.1, and the next attributable run is refused.
- On exceed, refuse with the existing `overloaded` reason, naming the peer and carrying `spend=X budget=Y`.
- Enforcement is **lagged by one run**, because it is a daily aggregate read from `data/obs.db` after the fact. Say so; do not claim a hard ceiling. Note that v0.4 sect. 7.4 layer 1's blanket "lagged enforcement" wording was corrected by wave 03 for the **per-task** layer (v0.5 sect. 18.5): per-task cost is enforced by the runtime between model requests whenever a pack declares one. The lag is real for this daily per-peer aggregate and not for that.
- Implementation status: the meter this depends on is the one wave 03 scheduled for rung v0.5.2 (cost read hoisted above the subtype guard, error-path cost recorded, consolidation spend folded in), which the merged ladder of v0.5 sect. 22 places **before** this rule. Until it lands, the ledger this rule reads is known to under-count.

**Rate.** Three defects make today's limits ineffective against a peer:

- `member.rateWindow` and `bodyHashes` are re-initialized on every join (`src/store.ts:522-523`), so leave-and-rejoin resets the rate limit with no restart required. Counters MUST survive a rejoin, keyed as sect. 5.6 specifies (`peer_id` where an admission record exists, the authenticated principal otherwise, the existing per-member key for local members).
- Nothing caps memberships per peer, so one peer can multiply its own allowance up to `max_members` (default 32) and can also exhaust the room so nobody else can join. `max_memberships` from the admission record MUST be enforced at join.
- **Message budgets, with the precedence stated so two numbers cannot be read as one.** Three limits apply and the effective one is the minimum of all three: the hub-wide `rateMsgsPerMin`, the room policy `member_rpm` (spec 5.1, per membership, unchanged in meaning by this document), and the admission record's `peer_rpm` (per peer, across every membership that peer holds). With `max_memberships: 2` and `peer_rpm: 10`, the peer gets 10 in total, not 20; that is the question the earlier `member_rpm` naming could not answer.
- `peer_rpm` MUST additionally be counted per **`(peer_id, recipient home)`**, so a peer's budget for talking to one organization is not consumed by its traffic to another. A broadcast (`to: []`) counts once against each distinct `home` present in the resolved recipient set. This is also the coarse egress control that makes a bytes-per-hour budget unnecessary (sect. 10).
- `room_task` is outside the rate window entirely today, and `maxInlineBytes` (262 144) is checked only against `args.body` (`src/store.ts:780`), so task text is unbounded. Task fields MUST be size-capped and mutating task actions MUST be counted (sect. 5.6).

### 7.2 Quarantine, gate coverage, and revocation

- **Quarantine keys on the admission record (`peer_id`) where one exists, and on the authenticated principal otherwise**, never on name or capability digest, which are both attacker-chosen. A hub with no admission records (an all-local room on the legacy join secret) MAY retain name-and-digest keying as a best-effort measure but **MUST NOT present it as an authorization boundary** (spec 12.1, quoted in full because dropping the fallback would leave an all-local hub with no quarantine mechanism at all, which is a loss of shipped behavior). The reference hub keys on `name` OR card digest (`src/store.ts:437`, `:1302-1303`), faithfully implementing pre-0.1.8 spec 12.1, so this is a spec defect first: 0.1.8 edits 12.1, and a fix in the hub alone would leave the specification telling other implementers to build the same hole.
- **Revoking the admission record is the real kill switch**, and it depends on the reload rule of sect. 3.1. Removing or expiring the record MUST invalidate every membership admitted under it **on the next call**, which fails `unauthorized`; the membership is removed with the usual `roster {reason: "evict"}` event and epoch bump, its claimed tasks are released with `task_released.reason: "evicted"` (spec 4.3, 10.3), and re-join is refused with `join_denied`. Lifting a quarantine remains a human-origin action (`release_member`, spec 12.1).
- **The gate MUST cover task actions**, and this bullet defines the contract that requirement needs. `evaluateGate` has exactly one call site, inside `send` (`src/store.ts:846`), so task `title`, `description`, `note` and `evidence.summary` reach a human's approval card and a resident's prompt uninspected. Two implementation facts that "just add a call site" hides: `task()` is synchronous while `evaluateGate` is `async`, and the matcher and command-check contract are envelope-shaped (`src/store.ts:1085` matches on the envelope, `:1106-1123` pipes envelope JSON to a subprocess).

  **The versioned check input.** Every check input, envelope-shaped or task-shaped, gains a `check_input_version` integer, `1` for the existing envelope shape and `2` for the discriminated form below. A `rules`-tier check with a `text_regex` matches against the concatenation of the `text` array, whatever the shape, so an existing rule keeps working unchanged.

```json
{ "check_input_version": 2,
  "shape": "task_action",
  "room": "r_kx82mm",
  "actor": { "id": "m_2dd01p", "origin": "agent", "home": "orgb.example" },
  "action": "complete",
  "task_id": "t_19",
  "fields": { "title": null, "description": null, "note": null, "evidence_summary": "…" },
  "text": ["…"] }
```

  **Fields in scope:** `title`, `description`, `note`, `evidence.summary`, and any `text` part carried by a task action. Nothing else; `artifacts[]` are references the hub never dereferences (spec 14.4).
  **Degradation, defined rather than left open:** a task has no parked state and no `request_id` to hang an approval on, so **a `hold` verdict on a mutating task action MUST degrade to `refuse`**, failing the call with `policy_refused` and appending the usual `gate_refused` audit event. Without this rule `deploy/gate.json`'s `hold-marker` rule, which matches on `text_regex` alone, lands a task in an undefined state. An operator who wants a task held holds the member (`hold_member`), which is a state that exists.
- **The sanitizer character set** applied to model-facing and console-facing text is fixed by **spec 14, item 11** and is not restated here, because restating it is how a range gets narrowed by accident: the MUST classes are C0 controls, bidi controls, zero-width characters **and directional marks (U+200B through U+200F**, which includes the LRM and RLM an earlier draft of this section dropped), U+2060, U+FEFF, and the boundary-tag escape; the TAG block and whitespace folding are SHOULD there and this document does not promote them, because promoting a wire SHOULD silently is what the sanitizer rule exists to prevent. Implementation status: `wrapForModel` (`src/client.ts:456-466`) and `sanitizeForMemory` now share one neutralizer (`neutralize`, `src/client.ts:573-584`, fixed 2026-08-17, so W4's claim that the prompt path is unneutralized is stale) and that neutralizer implements the four MUST classes exactly. What is actually missing is the TAG block, whitespace folding, and the new task-text wrapper.

### 7.3 What a guest may read

This is the finding the wave under-ranked and the completeness pass promoted. Admitting one guest into a working room today discloses, immediately and without moderation:

| Surface | Current behavior | Code |
|---|---|---|
| Join history | `history_visibility` defaults to `member`; the last `history_limit` events replay to any joiner | `src/store.ts:376`, `:542-546` |
| `room_listen{since: 0}` | `since` is clamped only against the log tip, never the caller's join point; up to `replayCap` (200) events return | `src/store.ts:1516`, `:110`, `:1531` |
| Task board | `room_task list` returns every task with full `note` and `evidence` to every non-observer | `src/store.ts:1661` |
| Cards | `room_roster` plus `agent_describe` hand over every local member's full card | spec 6.3 |

Rules:

- `history_visibility: "joined_after"` is the REQUIRED default for any member whose `home !== "local"`, and `room_listen` MUST clamp `since` to the member's persisted join sequence (0.1.8). `joinSeq` is a local variable today (`src/store.ts:530`) and must become a persisted field; existing memberships migrate by granting them the room's current tip.
- 200 events of a working room is every recent message body, every task and every intervention. The bound is the hub's configured replay cap, **200 by default** (`src/store.ts:110`), **not** the whole log; state the real bound rather than the scarier one.
- **The clamp closes the replay path only.** Spec 5.4 now says so plainly: `room_roster`, `agent_describe` and `room_task list` are not clamped and are not going to be, because per-skill and per-`home` card projection is rejected (sect. 10) and a task board a guest can work is a task board a guest can read. Every roster entry, every card and every task with its notes and evidence is disclosed to any admitted guest by design.
- **The room is the isolation unit.** Do not admit a guest into a room whose log, task board and member cards you would not hand over wholesale. There is no per-skill or per-`home` card projection (sect. 10), so admission is the control.
- A local agent's outbound content to a non-local member SHOULD pass a gate rule written for guests, and that rule's false-refuse rate MUST be measured against a replay of the existing log before it is enabled, so the room does not ship a gate that holds everything.

### 7.4 The approval card

Any member can register an approval today by riding `ext["io.github.pbeneteau/approval"]` on a send with no role or origin check (`src/store.ts:748-778`), the preview is a raw 200-character slice with no neutralization, and the console renders neither origin nor `home`.

- The approval ext MUST carry a structured `{tool_name, input_preview}` (spec 12.5, which also defines `action` and `tool_name` as distinct fields), mirroring the Claude Code channels contract.
- The hub MUST stamp requester id, origin, `home` and room; `input_preview` MUST be sanitized and length-capped with a **counted elision marker**.
- Spec 12.5 also turns "a hub SHOULD restrict who may register an approval" into a MUST with `unauthorized` and a per-member bound, which is the fix for the inbound severity item ranked fifth in W4 sect. 6.
- **Caller-side consequence, because this requirement breaks a shipped producer.** `src/bridge.ts:69-74` registers `{request_id, action, allowed_decisions, expires_at}` only, with `action: opts.toolName`, and puts the input into the message body rather than the ext. A hub enforcing spec 12.5 rejects every approval that bridge raises, that is, the whole human-in-the-loop path. `src/bridge.ts` MUST therefore be updated in the same change as the hub-side enforcement, and the console's body-derived preview (`src/store.ts:1169-1179`) is replaced by the ext's `input_preview` in the same change rather than left as a second source of truth.
- The consuming client MUST render requester strings as data.
- "The hub MUST generate the action label" is **not** implementable and is not specified: the approval ext is opaque to the hub, which executes nothing and does not know what tool the requester intends to call.
- A provenance block on any card "whose params derive from a remote task result" is likewise not computable: the derivation is laundered through a model and there is no taint tracking. The coarse version that **is** derivable from data already recorded: list every non-local member whose content entered the run's context window, from the checkpoint's `room_cursor`.

### 7.5 Admitting, monitoring, removing

| Phase | Operator actions |
|---|---|
| **Admit** | Confirm the key thumbprint out of band; confirm the written agreement exists (sect. 7.7); write the admission record with limits and `expires_at`; create or choose a room you would hand over wholesale; `room_admin invite`; deliver the token over the confirmed channel; verify the `admitted` event names the expected `peer_id`, `home`, `kid` and `card_digest`. |
| **Monitor** | Daily: spend against `usd_per_day`, refusals and gate holds attributed to the peer, task releases and attempt counts, membership count against `max_memberships`, approval cards carrying peer-derived content. Weekly: the cold-start test still green. |
| **Hold** | `room_admin hold_member` when something looks wrong. The existing `held` state already blocks sends and task mutations, keeps reads working, is visible in presence, and is releasable only by host or supervisor. This is the small-team version of "hold a new peer until you have seen it do one thing correctly", and it is why probation is not a new member state (sect. 10). |
| **Remove** | Expire or delete the admission record, then evict live memberships. Quarantine keys on `peer_id`, so a rename or a re-signed card does not evade it. Confirm claimed tasks were released. Offer the export of sect. 7.7. |

### 7.6 What the console MUST show

A console that hides `home` turns every operator judgement into a guess. The console MUST show:

1. `home` and a short member id beside **every** member name, everywhere a name appears.
2. A room-level header stating that the room has guests, whenever any member's `home !== "local"`.
3. On every approval card: requester id, origin, `home`, room, the sanitized `input_preview` with its elision marker, and the coarse provenance list of sect. 7.4.
4. Per-peer spend for the current day against `usd_per_day`, and the count of live memberships against `max_memberships`.
5. Task lease state: current `attempt`, `lease_expires`, and any `task_released` events, so a wedged board is visible without reading NDJSON.
6. Self-reported peer fields rendered as self-reported, visually distinct from hub-derived facts (sect. 5.5).

### 7.7 Data protection

The moment a guest is in a room, the log is a bilateral data store on your disk, in your nightly backups, replicated into `data/obs.db`, the episode log, and possibly a resident's consolidated fact store. Searching the protocol spec for retention or erasure language returns essentially one line. Three answers are required.

- **Redaction.** `room_admin redact` (spec 12.1 defines the mechanism in full, including the `content_hash` stamp and the `redacted: true` marker without which recomputing the chain over a blanked body breaks it). The operator consequence: the body is gone from the snapshot and from all future replay, the original event and its `prev_hash` link stay intact so who-said-what-when remains answerable at the metadata level, and the chain still verifies end to end. Append-only is preserved; the content is not. This is nearly impossible to retrofit into an operator's expectations after the first incident, and the operator's documentation MUST state that redaction cannot reach copies other members already hold.
- **Retention and exit.** The room's retention window MUST be stated in the join contract, and spec 11.3 now names where: the `instructions` string, alongside the plaintext-by-design statement. No new join-contract field is added for it. A leaving peer MUST be able to export the events it sent and received in one command; the verifiable-log export (`npm run verify-log`, **not implemented today**, sect. 12) shares the same code path.
- **Controller and processor.** The specification cannot answer this and MUST NOT be silent about it. The operator picks one position per room: either **the room carries no personal data**, or **a written agreement exists before `room_admin invite` is called**, with `admitted_by` as the audit anchor. For a regulated dogfood tenant this is not an afternoon: exercising the premise there needs a data-processing agreement and a third-party risk review, which is a project.
- **Outbound honesty.** RFA rooms give the hub operator plaintext by design. The pre-delivery gate, origin stamping, the hash chain, moderation holds and the console all require it. A counterparty who cannot accept that should not hold a membership on someone else's hub. That is also the honest form of the MLS rejection (sect. 10): the party with the confidentiality interest is the one who does not run the hub.

---

## 8. Deployment

### 8.1 One hub per organization, with the topologies named

| # | Topology | Status |
|---|---|---|
| 1 | **One org's hub with guests.** The peer is a client of your hub. | The product. The operator is a party to any dispute, which is why signature work is the price of this topology rather than a maturity milestone. |
| 2 | **A neutral third-party hub where the operator is not a party.** | The only topology in which the hash chain is credible to both sides without per-message signatures, and the shape any hosted offering would take. Named, not built. |
| 3 | **Two hubs federated.** | Rejected (sect. 10). |

Separation of duty is per hub, not per room: the workbench is hub-scoped by construction (`hub.pendingApprovals()` iterates every room; `/api/agents/<name>/definition` serves any pack's system prompt; `/api/runs` and `/api/summary` have no room filter). One leaked session token therefore reads every room's pending approvals and every agent prompt. An organization that needs two administrative domains runs two hubs.

### 8.2 Storage

**SQLite stays**, and the reasons are the corrected ones (W4 sect. 5):

- Postgres is **not** a driver change. It is synchronous-to-asynchronous across 56 prepared statements and 5 transactions, plus an FTS5 rewrite with no Postgres analog, for well under 300 KB of data. LangGraph's enums match `src/engine.ts:17-19` character for character but the column set does not.
- The `node:sqlite` port fails its own gate: official Node builds compile it without `SQLITE_ENABLE_FTS5`, `src/memoryfs.ts:246` creates an FTS5 virtual table, and `node:sqlite` does not exist on the Node 20 this repo declares. The one surviving win is a few lines: `better-sqlite3` already exposes `db.backup()`, so the `sqlite3` CLI shell-out at `src/platform.ts:38` MUST be replaced by it.
- Managed serverless is rejected, and the surviving reason is specific: SQLite WAL does not work over a network filesystem and every mountable volume is one, plus a revision bringing up a second instance breaks the exclusive store lock. Kubernetes, a multi-process hub behind a load balancer (waiters and watchers are process-local), a Node single-executable binary, and Homebrew as the primary channel are all rejected.
- Postgres unparks when a second machine must write the same tables (sect. 10).

### 8.3 Durability of the room store

Two windows, both pre-existing, both cheap:

1. **The snapshot write.** `writeMeta` now writes a temp file and `renameSync`s it (`src/store.ts:2160-2205`, fixed 2026-08-17; W4's description of a bare in-place `writeFileSync` is stale). Still required: **`fsync` of the temp file descriptor and of the directory**, because rename atomicity within a directory does not by itself order the data against a power loss.
2. **The load path.** `loadFromDisk` still skips a room it cannot parse with one stderr line (`src/store.ts:2310`). The correct degradation is **rebuild from the log**, not refuse to boot and not skip: tasks, approvals, quarantine and epoch are all derivable (task events carry the full task object, roster events carry the roster snapshot), so meta is a cache. Rebuilding costs everyone a rejoin; skipping costs the room its existence.
3. **The append ordering.** `emit` appends the task event **before** `writeMeta`, and the loader restores tasks only from the snapshot, so a crash in that gap silently reverts a winning claim while the claim event stays in the chain, and a second peer can then win the same task. Either write the snapshot before the append, or reconcile tasks from the log on load. This breaks the "exactly one claimant wins" guarantee the tool description advertises, which is precisely the guarantee a remote worker depends on.

### 8.4 The store lock

`acquireLock` reads the lockfile, calls `process.kill(pid, 0)`, then writes with no `O_EXCL` (`src/store.ts:318-349`). PID liveness is meaningless across containers and PID namespaces, and two racing starts can both pass the check. The lock MUST be created with `O_EXCL` and MUST carry a heartbeat timestamp in its body, with liveness judged on the heartbeat rather than on the PID.

### 8.5 Backups and migrations

- **Backups.** Nightly `db.backup()` of every SQLite database plus a dated archive of `data/`, agent memory directories and runtime state (v0.4 sect. 10, unchanged except for the API). The retention of at least 7 days is the **implementation's** current setting, recorded in STATUS; v0.4 sect. 10 states no count. The restore procedure MUST be exercised, and it has been (STATUS, 2026-08-17). A backup scheme that binds ciphertext to host hardware is rejected for exactly this reason: it breaks the copy-the-unit-and-restore-elsewhere property the rehearsed restore depends on.
- **Migrations.** Every SQLite database MUST carry `PRAGMA user_version`, and migrations MUST run at open, forward-only, before any writer touches the file. The room store is NDJSON plus a JSON snapshot and migrates by rebuild-from-log (sect. 8.3), which is why the snapshot format may change without a migration script and the log format may not.
- Wire additions are effectively frozen once a room is live: each new field an older room never saw is a field a peer must learn and every implementation must carry. This is the reason the 0.1.8 delta is countable on one hand, and it is a deployment constraint, not only a design preference. **There is no per-room protocol version pin**, and one is not proposed here: the wire tag is a single global `"rfa": "0.1"` (`src/model.ts:44`, `src/store.ts:823`), no room record carries a version, and hub-level discoverability is handled instead by `spec_version` in `server/discover` (spec 11.2). An earlier draft of this bullet described a per-room pin that exists in neither the specification nor the code.

### 8.6 Upgrades without dropping live rooms

- Residents upgrade by the existing versioned drain (v0.4 sect. 4.2): SIGTERM, finish the in-flight turn, release the floor, lapse the lease, respawn. The new card digest in the roster is the deployed-version marker.
- The hub upgrades by drain and restart: during drain, the hub MUST answer `503` with `Retry-After` rather than resetting connections, so a peer's bounded-jitter retry does the right thing. Parked long-poll listens resolve; clients resume from their cursor, which is the only resume mechanism.
- A restart MUST NOT expire claims for one full lease period (sect. 5.3), and MUST NOT double-append a replayed send (sect. 5.4). Those two rules are what make a hub upgrade invisible to a peer that is mid-task.
- Floor state is restart-transient by specification and stays so.

### 8.7 `/healthz`

- `GET /healthz` MUST return status 200 with **exactly the unauthenticated body** `{"ok":true}` when the hub can serve, and MUST return **503** with `Retry-After` during drain (matching sect. 8.6) or when the store is unavailable.
- The unauthenticated body MUST NOT carry version, room counts, member counts, uptime, queue depths or configuration. On a hub other organizations dial into, a detailed body is a version banner and an internal-state oracle. Detail MAY be served on the same path behind the workbench session token; "exactly" above constrains the unauthenticated response only.
- Implementation status: **not implemented.** `src/main.ts` has no `/healthz` route; anything not `/auth`, `/api/*`, `/` or `/console` currently falls through to the MCP handler.

### 8.8 Packaging

- Ship a `Dockerfile` and a `compose.yaml`: a named volume for `/data`, `restart: unless-stopped`, a `healthcheck` against `/healthz`, and the supervisor `depends_on` the hub with `condition: service_healthy`. **Deferred until the exposure posture of sect. 4.5 is settled and measured**, because sect. 8.2 rejects every hosted target such a container would plausibly run on, and a container image with nowhere to run is packaging for its own sake. It is sequenced accordingly in the merged ladder (v0.5 sect. 22, rung v0.6.3b).
- Document "run it under systemd or launchd" in three lines and stop there. A systemd unit with encrypted credential loading on top of the retained launchd plists is four boot paths for one developer, and its stated rationale does not hold: the exposure it addresses is the resident **children's** environment (`src/supervisor.ts:79-93`), and systemd credentials are by design not inherited by child processes, so they never reach it.
- Secrets stay where v0.4 sect. 6.3 put them: values in one gitignored file readable only by the supervisor, names declared by packs, injected per resident. Status note: `src/supervisor.ts:79-93` spawns residents with `{ ...process.env, ...picked }`, so a resident inherits the supervisor's whole environment rather than only its declared names. v0.4 sect. 6.3 describes the replacing form. The gap is not remote-specific, but a peer-driven resident is the first case where it matters, since the peer chooses when that process runs.

### 8.9 Release obligations before any external peer

An organization cannot reasonably be told to run this hub, or to point an agent at it, while the repository is private with no CI, no security contact and no supported-version statement. Before admitting any peer outside the operator's own organization, **the hub implementation an operator deploys** (for the reference implementation, this repository) MUST have:

- `SECURITY.md` with a contact and a disclosure window,
- a supported-version line,
- CI running `npm test` and `npm run e2e`.

STATUS records CI as explicitly declined during the research phase. The premise change reopens it; this is the owner's decision and this document's job is to make it explicit rather than let a peer's security review discover it.

---

## 9. The conditional

Six research dimensions produced roughly forty adopt verdicts, thirty of which touch the wire, and **not one named a candidate peer** (W4 TL;DR, sect. 10). The scarce resource is not code; it is a counterparty. That fact is load-bearing enough to be a decision rule rather than a caveat.

**The rule.**

1. Build the increments that are correct on their own merits, and be honest about which ones are. **Most of this ladder fixes a defect that exists today in a hub only local agents touch**: an uncredentialed `/mcp`, a claim that is never released, a reconnecting local worker that cannot record its own work, an ungated task field, a room store that can lose a room, a rate limit that resets on rejoin, an unclamped `since`. **The admission machinery does not.** `deploy/peers.json`, invite minting, membership expiry, `peer_id` quarantine and the transport-principal linkage rule fix nothing in an all-local hub; they are remote machinery for a counterparty this section itself admits does not exist. Sect. 11 therefore splits rung 1 in two and gates the admission half on a named peer, which is the same trigger discipline sect. 10 applies to everything else.
2. Keep the **cold-start guest as a standing test** (sect. 6.3), green in the regression suite.
3. **If no named peer exists sixty days after that test first passes, the remaining recommendations stay parked with their triggers intact, and the answer was to deepen the local product**: more residents, more workloads, more eval cases, and the cold-start guest kept green as a regression.

The deliverable of the sixty-day mark is a written line in `STATUS.md` naming the peer, or the sentence "no peer named, parked". Nothing else.

**What starts the clock in parallel.** Seven questions in writing to prospective peers, sent on the day rung 1 starts rather than after it lands, because they settle roughly a third of the park list and cost an hour (W4 sect. 11, spike 2): what must you be able to prove to a third party; whose identity provider issues your credentials; can your runtime hold a 20-second POST; will you hold a signing key; who signs the data agreement; what may we log about your agent; who pays.

A specification that names its own trigger for abandonment is more useful than one that pretends demand exists.

---

## 10. Non-goals, each with its unpark trigger

Nothing below is specified anywhere in v0.6. One line each, so a reader who expects one knows it was judged and not forgotten (W4 sect. 7).

| Non-goal | Status and trigger |
|---|---|
| **Federation and cross-hub rooms** | Out of scope, rejected more strongly than before: a second `seq` and epoch authority invalidates the cursor, the linear chain and the atomic single-winner claim at once. Federated directory *search* stays reserved; cross-hub rooms do not unpark. |
| **Group E2E encryption (MLS)** | Rejected: incompatible with the pre-delivery gate, origin stamping, the chain, held-message review and the console. Stated from the counterparty's side in sect. 7.7. No trigger. |
| **Tool passthrough under a namespace** | **MUST NOT.** It contradicts "tools the hub never sees" and makes the hub a confused deputy. Recorded rule: the hub MUST obtain its own upstream credential and MUST NOT forward a peer's token. No trigger. |
| **Normative REST binding** | Parked: MCP-over-HTTP is already plain JSON POST, and every framework cited as blocked ships first-party MCP client support; four surfaces would each need the whole threat model applied forever. Trigger: a named guest asks, or a named guest's runtime cannot hold a 20-second POST. |
| **Registry publication (ANS/NANDA-style)** | Parked on measurement: for fewer than 20 peers, one pinned thumbprint per peer *is* the directory. Trigger: more than 20 peers, or a registry with real adoption for agent (not server) identity. |
| **Contract-net auction verbs** | Parked: eligibility advertisement is already on the card and awarded allocation already works via `create` with a pre-set `owner`. Trigger: three competent guests for one skill plus a measured mis-assignment cost. |
| **SQLite to Postgres** | Parked (sect. 8.2). Trigger: a second machine must write the same tables. |
| **Delegation chains with `max_depth`** | Parked: this wave creates no hops, and `parent_id` is sub-task decomposition inside one board. Trigger: the parked `handoff` verb ships with a real consumer. |
| **Scopes** | Reserved field, no enforcement point, deliberately (sect. 3.1). Role plus task-verb limits plus the gate expresses every distinction the premise names. Trigger: a second peer provably needs a different grant than the first. |
| **A fourth role** | Rejected: `home` plus the existing three roles covers it. Trigger: none identified. |
| **Probation as a member state** | Rejected: the existing `held` state already blocks sends and task mutations, keeps reads working, is visible in presence, and is releasable only by host or supervisor (sect. 7.5). No trigger. |
| **A `remote` conformance profile** | Not specified: conformance profiles are for a multi-implementer ecosystem and RFA has one implementation. Trigger: a second independent hub implementation. |
| **Hub receipts and chain anchoring** | Parked with a correction: a receipt covers only what the peer itself sent, an operator rewriting history re-signs receipts too, and it is unavailable in the adversarial case because a gate hold returns no result. The cheap correct version when it unparks is returning the chain head on every send and listen result. Trigger: a counterparty needs independent checkpoints. |
| **Per-message signing (claim and result)** | Wire-side, narrowed and demand-gated; not in this document. Full-envelope signing is structurally impossible (`seq`, `ts`, `from` and `prev_hash` are hub-assigned). Trigger: one peer needs to prove to a third party what it did or did not send. |
| **Admit-by-URL against a well-known agent card** | Rejected: key resolution through `jku` adds an SSRF surface and trust-on-first-use, the algorithm sets do not match, and the card describes a server the guest may not run. Paste the card and pin the thumbprint (sect. 3.3). No trigger. |
| **Per-skill or per-`home` card projection** | Rejected: invocation is not gated on skill ids anywhere, so a guest that cannot see a skill just asks in prose and gets the same answer, while a filtered card breaks `card_verified` and the advertised digest. No trigger. |
| **An A2A server facade in the hub** | Rejected: A2A has no delegation, no task forwarding and no multi-party primitive, so a facade must collapse the roster into one agent. Trigger: a named A2A peer, and then a connector, not a facade. |
| **Webhook wake-ups** | Parked. The body must be a doorbell (`{room, event_type, task_id, seq}`, no content) so a leaked webhook leaks only existence. Trigger: a peer that cannot long-poll. |
| **DPoP, RFC 9396 `authorization_details`, SPIFFE adapter, MCP Tasks extension** | Parked with named triggers: client support a peer may not have; a flat scope list exceeding about 12 entries; a peer already running SPIRE; presence in MCP's own client support matrix. |
| **Egress byte budgets, metadata-inference defences, behavioural watchdogs** | Rejected or parked: bytes are a poor proxy (the fees and thresholds worth stealing are tens of bytes each) and the coarse control already exists as `peer_rpm` per `(peer_id, recipient home)` (sect. 7.1). Trigger for a watchdog: a corpus of normal cross-org behaviour exists. |
| **Economic bonds, reputation scores, redundant execution, TEE attestation, zkML** | Rejected as trust mechanisms for remote work, each on its own evidence. No triggers. |

---

## 11. Build path

**Ordering across v0.5 and v0.6 is fixed by the single merged ladder in RFA-0.5-platform.md section 22.** This table says what each of this document's rungs delivers; that table says when it lands relative to v0.5's rungs and what it depends on. Two things that are not code come before any of it: freeze the vocabulary (`home`, one derivation rule, the 0.1.8 field list), because every artifact rewrites if it lands second; and send the seven questions of sect. 9.

**Rung 1 is split in two**, per the decision rule of sect. 9. The a-half is locally correct and ships on schedule; the b-half is pure remote machinery and is gated on a named counterparty, not scheduled.

| Rung | Delivers | This document | Gate |
|---|---|---|---|
| **v0.6.0a** (locally correct) | The transport bearer in front of `/mcp` and a credentialed `room_create`; the persisted join sequence and the `since` clamp; `home` stamped and defaulting to `"local"`; `wrapped` in listen results; validation failures as `bad_request`; extensions and `spec_version` advertised in `server/discover`; `INTEROP.md` with a sample client carrying the boundary wrapper; an `Authorization` path in the client | 4, 4.5, 6, 7.3 | Scheduled |
| **v0.6.0b** (admission) | `deploy/peers.json` with its reload rule; `room_admin invite`; membership expiry tied to `expires_at`; quarantine keyed on `peer_id`; the transport-principal linkage rule; the `admitted` event; `invite_invalid`; the public-proxy half of sect. 4.5 | 3, 4.2 items 4-5, 4.5, 7.2 | **A named counterparty exists.** None of it fixes a defect in an all-local hub |
| **v0.6.1** | The claim lease: `attempt`, `lease_expires`, `claim_token`, release on offline/leave/eviction/`release`, restart grace, the bounds as room policies, a separate task-action counter, per-peer membership cap, `lease_expired` finally thrown | 5 | Scheduled. The reconnect fix matters most for **local** residents the supervisor restarts |
| **v0.6.2** | The gate over mutating task actions with the versioned check-input contract of sect. 7.2 and its hold-to-refuse degradation; task field size caps; the widened sanitizer set; `evidence_required` forced at claim; the verifier rule with capped rejections; the structured approval ext **with `src/bridge.ts` updated in the same change**; console guest rendering items 1 to 3 | 5.7, 7.2, 7.4, 7.6 | Scheduled. Console items 4 to 6 (per-peer spend, lease state, self-report styling) move with the admission half |
| **v0.6.3a** (durability) | Atomic snapshot with fsync and rebuild-from-log; the ordering fix so a winning claim cannot revert; restart-durable send idempotency; `O_EXCL` plus heartbeat in the lock; `db.backup()` | 5.4, 8.3, 8.4 | **Pulled forward** ahead of everything unshipped: each item can lose data today with zero peers |
| **v0.6.3b** (audit artifact and release) | `room_admin redact`; retention in the join contract and per-member export; `verify-log`; `/healthz`; Docker and compose; `SECURITY.md`, supported versions, CI | 7.7, 8.5-8.9 | Redaction and the container gate on the admission half and on sect. 4.5; the rest is scheduled |
| **v0.6.4** | Per-human `principal_id` with constant-time comparison and per-principal console memberships; retrieval set and gate verdict recorded per answer (forensics only, no detector claim). Then, with the admission half: `usd_per_day` enforced per sect. 7.1 and `peer_rpm` per `(peer_id, recipient home)` | 4.4, 7.1 | Split. The per-human half is locally correct and cheap and should not wait on a peer |
| **v0.6.5** | The decision of sect. 9, not a feature | 9 | Sixty days after the cold-start test first passes |

Each rung's live proof is the corresponding spike list in W4 sect. 11. The cold-start test (sect. 6.3) is v0.6.0a's proof and every later rung's regression.

---

## 12. Implementation status

Nothing in sections 3 through 8 is implemented today except where noted. Explicitly, at HEAD:

| Requirement | Status |
|---|---|
| `deploy/peers.json`, `peer_id`, `home`, invites | Not implemented. No peer, `home` or invite-token semantics anywhere in `src/store.ts` (the string `invite` appears only as the `policies.join` enum value). |
| `npm run remote-conformance` (sect. 6.3) | Not implemented. `package.json` declares no such script; it is a v0.6.0a deliverable. |
| `npm run verify-log` (sect. 7.7) | Not implemented. Same; it is a v0.6.3b deliverable. |
| Public reverse-proxy exposure (sect. 4.5) | Not implemented, and unmeasured: whether a public proxy carries a 20-second `room_listen` POST without buffering has not been tested. |
| Transport authentication on `/mcp`; credentialed `room_create` | Not implemented (`src/main.ts:327`, `:341`). Client sends no `Authorization` header (`src/client.ts:609-628`). |
| `/healthz` | Not implemented. |
| Claim lease, release, `claim_token`, `lease_expired` | Not implemented. `lease_expired` is declared in spec 15 and thrown nowhere. |
| Gate over task actions | Not implemented; one call site inside `send` (`src/store.ts:846`). |
| `since` clamped to the join point | Not implemented (`src/store.ts:1516`); `joinSeq` is a local variable (`:530`). |
| Verifier authorization | Not implemented; `verify` checks only owner inequality (`src/store.ts:1722`). |
| Quarantine on the admission record | Not implemented; keys on name or digest (`src/store.ts:437`), faithful to spec 12.1. |
| Rate window surviving rejoin; per-peer membership cap | Not implemented; both re-initialized at join (`src/store.ts:522-523`). |
| Restart-durable send idempotency | Not implemented; `dedupe` resets on load (`:2231`), `sentIds` is rebuilt (`:2277`) and never consulted for idempotency. |
| Atomic snapshot write | **Partially shipped**: temp file plus rename (`src/store.ts:2160-2205`, 2026-08-17). Missing: fsync of file and directory, and rebuild-from-log on parse failure (`:2310`). |
| Shared neutralizer on the prompt path | **Shipped**: `wrapForModel` (`src/client.ts:456-466`) and `sanitizeForMemory` both call `neutralize` (`src/client.ts:573-584`), which implements spec 14.11's four MUST classes exactly (2026-08-17). Missing: the TAG block, whitespace folding, and the task-text wrapper. |
| Store lock with `O_EXCL` and heartbeat | Not implemented (`src/store.ts:318-349`). |
| `db.backup()` instead of the CLI shell-out | Not implemented (`src/platform.ts:38`). |
| Extensions advertised in `server/discover` | Not implemented; no `extensions` key anywhere in `src/`. |
| Per-peer spend ceiling | Not implemented, and the meter it reads under-counts until the v0.5.2 cost work lands. |

---

## 13. Verification discipline

Every rung lands behind the existing gates: `npm test`, `npm run e2e`, `npx tsx dogfood/parity.ts`, live wire verification against the standing room, and findings appended to `STATUS.md`. Two additions specific to this document:

1. **The cold-start test (sect. 6.3) is a gate**, not a demo, from rung 1 onward.
2. **Spike scripts are committed before their numbers are cited.** The wave's wire measurements (three stranger clients, byte counts, timing rows, quarantine-evasion rejoin) live in a session scratchpad and nothing in the repository corroborates them. Any number that enters normative text MUST have a committed script under `research/04-remote-agents/spikes/`.

Line numbers in this document pin to HEAD at the time of writing and drift. When quoting code in a later revision, re-resolve the anchor rather than trusting the citation.

---

## Appendix A: reserved and deferred

- **`scopes[]`** in the admission record: reserved, ignored, no enforcement point. Reserved rather than dropped because the two proposals for it were circular (a fourth role was rejected because scopes exist; scopes were introduced with no enforcement point named).
- **`guest_card` and `guests` room policies**: named in research, not specified. Admission plus room choice is the control.
- **A separate roster section for guests**: not specified. `home` on every member record is the mechanism; a boolean or a section cannot later grow the distinctions a label can, which is the lesson a shared-channel flag in a large chat product paid for.
- **Per-`(peer_id, kid)` invalidation timestamps**: required by the rotation rule (sect. 3.1), storage shape undefined in this draft. Open question.
- **Hub receipts, chain anchoring, per-message signatures, webhooks, REST, Postgres, federation, MLS, registries, delegation chains, a fourth role, probation, a remote conformance profile**: sect. 10, each with its trigger.

## Appendix B: where the evidence is thin

Carried from W4 sect. 10 rather than laundered into confidence.

- **No named counterparty exists.** Every claim about what a peer needs, whether it speaks MCP, whose identity provider it uses, and whether it will hold a signing key is inference. The assertion that requiring MCP client-hood is the main adoption blocker is asserted, not measured.
- **The interop measurements are uncommitted.** The three stranger clients, the byte counts and the timing rows are not corroborated by anything in the repository. The code paths make them near-certain; that is not the same as measured (sect. 13).
- **Lock-delay defaults are unverified.** The 180 s restart grace of sect. 5.3 is chosen and written down, not derived from the source usually cited for it, which could not be read during verification.
- **Identity-provider behavior on audience binding is unfetched.** "Check that `aud` actually lands in the token" is a mandatory acceptance test for whichever provider is ever chosen, not an assumption.
- **One fabricated quotation was found** in the research notes (an RFC-2119-capitalized MCP extension-fallback rule presented as verbatim). Sect. 6.1 adopts the rule as RFA's own MUST and attributes the wording to nobody.
- **A widely cited memory-poisoning detector was retracted by its own authors**, who concluded the signature is an attack precondition and not a maliciousness predicate. Logging the retrieval set is worth doing on forensics grounds only; this document promises no detector.
- **Externally sourced security-guidance quotations were not independently confirmed** at page granularity and are therefore not quoted here.

## Appendix C: changelog

**0.6.0 (2026-08-17, revised 2026-08-18 after specification review)** - the revision closed the holes a reader could not implement through: the transport credential gained a form, an issuance path, a home in the admission record and a validation rule (sect. 4.2); sect. 4.5 was added, because no document said how a peer physically reaches a hub that v0.5 binds to loopback; the admission handshake states that a guest's card must be signed rather than leaving it to be inferred; `member_rpm` in the admission record was renamed `peer_rpm` with a stated precedence against the room policy of the same name; every rate counter gained a key for local members; the gate's task-action contract and its hold-to-refuse degradation were specified rather than named; `deploy/peers.json` gained a reload rule without which the kill switch needs a restart; and the ladder was split so the admission machinery is gated on a named counterparty instead of scheduled ahead of durability fixes that can lose data today. Numbers and defaults that the wire spec owns were replaced by citations.

**0.6.0 (2026-08-17)** - initial draft. Splits the remote-agent work into a wire half (protocol 0.1.8) and this platform and operator half: the admission record as the root of remote identity; issuance local, anchoring by pinned key; transport authentication with the hub as a resource server that never issues; the claim lease as an operator concern; the interop artifact and the cold-start acceptance test; per-peer containment, visibility defaults and console obligations; deployment topologies, durability, upgrades and `/healthz`; and the sixty-day conditional under which the remaining recommendations stay parked.
