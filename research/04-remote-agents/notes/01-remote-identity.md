# 01 - Remote identity: proving who a peer is when the peer is another org

Dimension 01 of research wave 04 (remote agents as first-class room members). Depth: DEEP.
Research date: **2026-08-17**. Researcher: subagent under the wave-04 orchestrator.
Grounding read first: [`STATUS.md`](../../../STATUS.md), [`spec/RFA-0.1.md`](../../../spec/RFA-0.1.md) (0.1.7), [`spec/RFA-0.4-platform.md`](../../../spec/RFA-0.4-platform.md), [`research/03-reach-and-collaboration/REPORT.md`](../../03-reach-and-collaboration/REPORT.md) + [`notes/01-remote-reach.md`](../../03-reach-and-collaboration/notes/01-remote-reach.md), [`research/02-platform/REPORT.md`](../../02-platform/REPORT.md), and the hub source (`src/store.ts`, `src/signing.ts`, `src/jcs.ts`, `src/main.ts`, `src/client.ts`).
Method: primary sources only for normative claims (RFCs, IETF drafts, spec pages, source code, the arXiv PDF in this repo). Vendor documentation is used only for "does product X implement RFC Y", which is exactly what vendor docs are authoritative for, and is labelled. Everything unconfirmed is prefixed `UNVERIFIED:`.
Dates matter here: MCP's authorization text changed on **2026-07-28**, the Web Bot Auth WG was chartered **2025-10-23** and its drafts moved as recently as **2026-08-05**. Anything written about this area before 2026 is stale.

---

## Verdict

### Headline

**Three sentences.**

1. **T1 as written in [`spec/RFA-0.1.md:92`](../../../spec/RFA-0.1.md) is wrong twice over and must be rewritten**: MCP authorization is **OPTIONAL** for servers, the client-credentials grant is a *draft optional extension* and not part of the core spec, and RFC 8693 token exchange is an **authorization-server** feature that an RFA hub will never implement. The correct T1 is one sentence: *the hub is an OAuth 2.1 resource server that validates an audience-bound token and never issues one.* An org can satisfy that with an IdP it already runs, in an afternoon, with zero AS code.

2. **The identity unit for cross-org RFA is the ORG's domain, not the agent, and the mechanism already has two battle-tested precedents plus working code in this repo.** Matrix federates by having each homeserver sign for its own users and publish `verify_keys` + `old_verify_keys` at a well-known endpoint; Web Bot Auth (Cloudflare/Google/OpenAI/Akamai/Amazon, IETF WG `webbotauth`) has agents sign requests with Ed25519 keys published in a JWKS directory at `/.well-known/http-message-signatures-directory`, `keyid` = RFC 7638 thumbprint. RFA already verifies JWS-over-JCS card signatures with thumbprint-bound kids ([`src/signing.ts:107-157`](../../../src/signing.ts)). The missing piece is 60 lines: resolve the card's signing key **from the peer org's domain** instead of from a hand-provisioned map, and record which domain vouched.

3. **The one genuinely new requirement cross-org creates is non-repudiation, and the current hash chain does not provide it.** `prev_hash` is computed by the hub itself, genesis is `sha256hex(room.handle)` ([`src/store.ts:408`](../../../src/store.ts), [`src/store.ts:2136-2137`](../../../src/store.ts)), so the operator who owns the hub can rewrite the entire chain consistently. Against a peer org, the chain proves nothing: org A can fabricate a `task complete` attributed to org B's agent, and org B cannot prove it did not send it. That is what unparks the T2 message half - **narrowly**: a sender signature over a defined *signed core* (never the whole envelope, which the hub rewrites), plus a hub-signed **receipt** returned from `room_send`. Two artifacts, ~150 lines, and a dispute becomes decidable without either side trusting the other's log.

**Everything else in the capability-token literature is ceremony for this architecture.** AIP's IBCTs, macaroons, biscuit, UCAN, GNAP and SPIFFE all exist to make authorization verifiable *offline, without contacting the issuer*. RFA has a hub on the path by construction (spec 3: one authoritative log, one roster, one policy object). Offline attenuation buys nothing you do not already have, and costs a Datalog engine, a second key hierarchy, and a new verifier attack surface that the AIP paper itself flags. Steal three shapes from AIP (`max_depth`, mandatory non-empty delegation `context`, budget-as-ceiling-not-balance) and put them in the **task object**, where RFA already has a state machine to enforce them. Reject the tokens.

### The minimal design, end to end

Five artifacts. Nothing else is required for a remote member to join, claim a task, complete it with tools the hub never sees, and be kicked.

**A. The org record (operator config, out of band, once per peer org).**

```jsonc
// deploy/orgs.json, 0600, loaded with --orgs deploy/orgs.json
{
  "b.example": {
    "keys_url": "https://b.example/.well-known/http-message-signatures-directory",
    "client_ids": ["rfa-peer-b-prod"],          // transport principals allowed to claim this org
    "admitted_by": "paul@a.example",             // the human who added it
    "admitted_at": "2026-08-20T09:00:00Z",
    "note": "pilot: langgraph research agent, contract SOW-114"
  }
}
```

This file is the trust root. It is an **allowlist of domains**, not a registry, not a web of trust, not a directory lookup. Justification in Evidence section 6: as of 2026 no agent registry is a trust root you could rely on (MCP Registry still labels itself preview; AGNTCY's directory is rated "emerging"; ANS/NANDA are papers in `research/01-protocol/papers/`).

**B. The transport credential (T1). Hub = resource server, always.**

The hub serves `GET /.well-known/oauth-protected-resource` (RFC 9728):

```json
{
  "resource": "https://rfa.a.example/mcp",
  "authorization_servers": ["https://idp.a.example/realms/agents"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["rfa:room.read", "rfa:room.send", "rfa:presence", "rfa:task.claim", "rfa:task.complete"],
  "resource_name": "RFA hub (a.example)"
}
```

On a tokenless or bad-token `/mcp` call the hub returns

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://rfa.a.example/.well-known/oauth-protected-resource",
                         scope="rfa:room.read rfa:room.send"
```

and validates every presented JWT for: signature against the issuer's cached JWKS, `iss` == the configured issuer (exact string), **`aud` contains the hub's canonical URI**, `exp`/`nbf`, an `alg` allowlist (never `none`), and `client_id`/`azp` present in some org record's `client_ids`. That is the whole server side. No `/authorize`, no `/token`, no PKCE (client_credentials has no authorization endpoint), no DCR, no CIMD - those are all AS-side or user-flow features.

**C. The card, anchored to the domain.**

Card gains one field and one rule:

```jsonc
{
  "name": "research-analyst",
  "description": "...",
  "provider": { "organization": "Org B", "origin": "b.example" },   // origin is NEW and is verified
  "skills": [ /* ... */ ],
  "signatures": [ { "protected": "...", "signature": "..." } ]      // JWS over JCS, unchanged
}
```

At join, for a peer whose transport principal maps to org `b.example`, the hub MUST: (1) require at least one verifying signature; (2) resolve the key **only** from `orgs["b.example"].keys_url`, never from an embedded `jwk` and never from the card's own key hint; (3) require `provider.origin === "b.example"`; (4) require the signature `kid` to equal the RFC 7638 thumbprint of the resolved key (already enforced, [`src/signing.ts:140`](../../../src/signing.ts)). Resolution method is surfaced as `method: "directory"` alongside the existing `trusted|embedded|unresolved` ([`src/signing.ts:95`](../../../src/signing.ts)).

**D. Verb scopes, and the challenge MCP already blesses.**

| Tool / action | Required scope |
|---|---|
| `room_join`, `room_roster`, `room_listen`, `agent_describe`, `room_task get\|list` | `rfa:room.read` |
| `room_send` (kind `chat\|request\|response\|refuse\|status`) | `rfa:room.send` |
| `room_presence` | `rfa:presence` |
| `room_task create` | `rfa:task.create` |
| `room_task claim`, `update` | `rfa:task.claim` |
| `room_task complete` | `rfa:task.complete` |
| `room_task verify` | `rfa:task.verify` |
| `room_admin` (any verb), `room_end`, `room_create` | `rfa:admin` |

On a miss the hub returns the MCP-specified shape, which explicitly permits deriving the scope from the arguments:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", scope="rfa:task.complete",
                         resource_metadata="https://rfa.a.example/.well-known/oauth-protected-resource"
```

Scope and role compose as **most restrictive wins**: a token with `rfa:admin` held by a `participant` still cannot call `room_admin`, and a `supervisor` whose token lacks `rfa:admin` cannot either. Human-origin remains orthogonal and unreachable by any agent token (spec 4.2, [`src/store.ts:462-468`](../../../src/store.ts)).

**E. Non-repudiation: signed core + receipt (the T2 unpark, narrowed).**

Sender side, carried in `ext` so it is v0.1-compatible (spec 8: receivers ignore unknown `ext` keys):

```jsonc
"ext": {
  "io.github.pbeneteau/sig": {
    "protected": "<base64url {alg:'EdDSA', typ:'JOSE', kid:'<thumbprint>'}>",
    "signature": "<base64url>"
  }
}
```

The **signed core** for `room_send` is exactly, and only, the fields the sender controls:

```
{ "rfa", "room", "message_id", "kind", "to", "mentions", "conversation_id",
  "in_reply_to", "reply_by", "body", "chunk", "refusal", "signed_at", "ext" }
```

with `ext["io.github.pbeneteau/sig"]` removed before canonicalization, RFC 8785 canonical form, detached-JWS input `BASE64URL(protected) || "." || BASE64URL(core)` - byte-for-byte the construction already in [`src/signing.ts:79-90`](../../../src/signing.ts). **`seq`, `ts`, `from`, `prev_hash` and `task` are excluded because the hub assigns them** ([`src/store.ts:822-826`](../../../src/store.ts), [`src/store.ts:2136`](../../../src/store.ts)). Signing additionally **requires id-only addressing**: `to`/`mentions` must be `m_*` refs, because the hub normalizes name refs to ids and defaults `mentions` from `to` ([`src/store.ts:807-809`](../../../src/store.ts)), and a signature over the pre-normalization value would never verify against the stored envelope. The hub MUST reject a signed send whose resolved refs differ from the submitted ones (`signature_mismatch`).

`room_task` gets the same treatment over a smaller core: `{ "room", "action", "task_id", "note", "evidence", "signed_at" }`. This is where the signature actually earns its keep - a remote agent's `complete` with an `evidence` payload is precisely the record that gets disputed.

Hub side, the cheaper and more valuable half. `room_send` currently returns `{seq, ts, recipients[]}` (spec 9.1). Add:

```jsonc
{
  "seq": 4182, "ts": "...", "recipients": [ /* ... */ ],
  "receipt": {
    "protected": "<base64url {alg:'EdDSA', typ:'JOSE', kid:'<hub thumbprint>'}>",
    "signature": "<base64url over JCS of {room, seq, ts, message_id, from, prev_hash, chain_head}>"
  }
}
```

Plus a periodic `system {event: "chain_checkpoint", refs: {seq, chain_head, signature}}` event. Now org B holds a hub-signed statement of what the hub accepted and when, org A holds B's signature over what B said, and a stored checkpoint lets either side detect a rewritten prefix. That is a decidable dispute. Effort: the signing primitives all exist; this is a key file, one new event type, one new result field.

### Recommendations table

| # | Recommendation | Verdict | Rationale (evidence section) | Effort | Spec impact |
|---|---|---|---|---|---|
| 1 | Rewrite spec 4.2's tier table: **T1 = the hub is an OAuth 2.1 resource server validating an audience-bound token**; delete "RFC 8693 token exchange for on-behalf-of" from T1 | **adopt** | Authorization is verbatim **OPTIONAL** for MCP implementations (§1); client_credentials is a *draft* optional extension, not core (§1); RFC 8693 is an AS feature and no resource server implements it (§2) | spike (spec edit, 2 h) | New 4.2 table rows + new 4.3 "Transport credentials (T1)" |
| 2 | Hub serves RFC 9728 metadata at `/.well-known/oauth-protected-resource` and a `WWW-Authenticate: Bearer resource_metadata=...` 401. **Never operate an authorization server** | **adopt** | MCP servers **MUST** implement RFC 9728 when they support authorization; the AS "may be hosted with the resource server or a separate entity" and is out of scope (§1) | day | New 4.3 + Appendix A metadata document shape |
| 3 | Validate `iss` (exact string), `aud` == canonical URI, `exp`, `alg` allowlist, cached JWKS; reject anything else | **adopt** | "MCP servers **MUST** only accept tokens specifically intended for themselves and **MUST** reject tokens that do not include them in the audience claim"; "**MUST NOT** accept or transit any other tokens" (§1) | day | 4.3 normative list + new errors |
| 4 | Default cross-org credential shape: **a guest client in the hub operator's own IdP**, one `client_id` per peer agent, TTL <= 15 min, `client_id` pinned in the org record | **adopt** | Satisfies every server-side MUST with any IdP; sidesteps the RFC 8707 gap entirely (§3); revocation = disable the client, bounded by TTL (§8) | day | 4.3 + a deployment note |
| 5 | Accept that **RFC 8707 `resource` is a client MUST that many IdPs cannot honor**; the hub validates audience however the AS derived it | **adapt** | Keycloak's own MCP page: "Keycloak cannot recognize `resource` parameter"; Zitadel: "does not yet support Resource Indicators. Supplying this parameter will always result in an `invalid_target` error"; Auth0 maps it to `audience` and prefers `audience` when both are sent (§3) | free | 4.3 note; do NOT make sending `resource` an RFA requirement |
| 6 | **Read the `act` claim** if the token carries one, and put `act.sub` in the audit record | **adopt** | RFC 8693 §4.1 `act` is the standard delegation shape; the MCP Enterprise-Managed Authorization extension (**Stable**) produces exactly this via ID-JAG. Reading it is ~5 lines; issuing it is someone else's job (§2) | spike (2 h) | Envelope `from` gains optional `on_behalf_of`; audit section 13 |
| 7 | **Do not implement RFC 8693 token exchange in the hub.** If a peer needs on-behalf-of, the peer's IdP and the hub operator's IdP do it | **reject** | It is a token-endpoint grant. A resource server has no token endpoint. Zitadel and Keycloak already implement it if an org wants it (§2) | - | Delete the RFC 8693 mention from 4.2 |
| 8 | Add **RFC 9421 HTTP Message Signatures as the second T1 option** (no AS at all): `Signature-Input`/`Signature`/`Signature-Agent`, `keyid` = RFC 7638 thumbprint, keys from the org's JWKS directory | **adopt** | Real 2026 deployment (Cloudflare, Google "experimental" 2026-05-04, OpenAI, Akamai, Amazon), IETF WG `webbotauth` chartered 2025-10-23 with April/August 2026 IESG milestones, current draft 2026-08-05. Same key material as card verification, so an org publishes ONE directory (§4) | week | New 4.3.2 "Signed-request credential", with RFA's own `tag` value |
| 9 | Card gains verified `provider.origin`; signing keys resolve from the org's JWKS directory; `method: "directory"` added to the tri-state | **adopt** | Matrix (`/_matrix/key/v2/server`, `verify_keys` + `old_verify_keys` + `valid_until_ts`) and Web Bot Auth (`/.well-known/http-message-signatures-directory`, JWKS with `nbf`/`exp`, `Cache-Control: max-age=86400`) both do exactly this (§4, §5) | week | 6.1 key-resolution paragraph; card schema `provider.origin` |
| 10 | Adopt the **Web Bot Auth directory shape verbatim** rather than defining `/.well-known/rfa-keys`; the operator config's explicit `keys_url` is authoritative and the well-known path is only a fallback | **adopt** | JWKS with `kty/crv/kid/x/use/nbf/exp`, media type `application/http-message-signatures-directory+json`, kid per RFC 7638 / RFC 8037 A.3 for Ed25519 (§4). Inventing a path means an IANA registration and a second thing for orgs to publish | spike | 6.1; no new well-known path registered by RFA |
| 11 | `policies.admit = {orgs: [...], require_signed_cards: true, allow_embedded_jwk: false}`; **implement `join: "approve"`** as the human-review path for an unknown org | **adopt** | Admission is a human decision made once per org. `join: "approve"` is already in spec 5.1 and listed as unimplemented in STATUS; the approval machinery (0.1.7 + v0.4.6 console Inbox) already exists and needs no new authority path (§6, §10) | week | 5.1 policies; 12.1 approval flow gains a `join` action type |
| 12 | **Verb scopes** (`rfa:room.read`, `.send`, `presence`, `task.claim`, `task.complete`, `task.create`, `task.verify`, `admin`) + `403 insufficient_scope` challenge; scope AND role, most restrictive wins | **adopt** | The 2026-07-28 spec specifies this exact challenge, and verbatim allows that "required scopes may be determined dynamically based on the specific request arguments and context" (§1). Capability-scoping is MCP-native; no macaroon needed (§7) | week | New 4.4 "Scopes"; 15 gains `insufficient_scope`; 16 new `remote` profile |
| 13 | **Sender-signed core** for `room_send` and `room_task` (JWS over JCS of the sender-controlled subset only), id-only addressing required when signing, `ext["io.github.pbeneteau/sig"]` | **adopt** (unparks T2's message half, narrowed) | The hub-computed chain cannot settle a two-org dispute because the hub is a party (§9). Reuses `src/signing.ts` unchanged | week | New 8.x "Signed core"; `policies.require_signed_messages: off\|remote\|all`; errors `signature_invalid`, `signature_mismatch` |
| 14 | **Hub receipts** on `room_send`/`room_task` results + periodic signed `chain_checkpoint` system event | **adopt** | Cheapest non-repudiation win in the whole dimension: the sender gets a portable artifact proving what the hub accepted; a stored checkpoint detects a rewritten prefix (§9) | spike (1 day) | 9.1 result shape; 13 audit; new system event `chain_checkpoint` |
| 15 | Signing the **full canonicalized envelope**, or extending the hash chain to cover sender signatures | **reject** | Structurally impossible: `seq`, `ts`, `from`, `prev_hash` are hub-assigned and `to`/`mentions` are hub-normalized (§9, file refs). Any spec text that says "sign the envelope" is unimplementable | - | Ensure Appendix D's "per-message signature profile" wording is replaced by the signed-core wording |
| 16 | **AIP / IBCT** as RFA's authorization mechanism | **reject** | Single-author arXiv preprint (2603.24775, 2026-03-25), self-admitted: no production deployment, localhost-only evaluation, no revocation infrastructure ("no reference implementation enforces CRL checks"), Ed25519-only, completion blocks self-reported. Its value proposition is offline multi-hop verification, which a hub-mediated room does not need (§7) | - | none |
| 17 | Steal three AIP **shapes** into the task object: `max_depth` on delegation, mandatory non-empty `context` on each hop, budget as a **per-hop ceiling** not a running balance | **adapt** | These are the paper's genuinely good ideas and they are policy, not cryptography. RFA already has `parent_id` (spec 10.2) to hang depth on, and an audit log to hang `context` on | spike | 10.2 task object: `depth`, `max_depth`, `context`, `budget_ceiling` |
| 18 | **Macaroons** | **reject** | HMAC-chained: every verifier holds the root secret, so every verifier can forge. Fatal the moment a verifier is in another org (§7) | - | none |
| 19 | **Biscuit** | **reject** (right answer to a question RFA does not have) | Real code, Eclipse Foundation, Ed25519 block chaining, offline attenuation, revocation ids. But it exists so a verifier can decide without the issuer; RFA's verifier IS the issuer's peer on the same connection. Cost: a Datalog evaluator as attack surface, which AIP's own limitations section flags (§7) | - | none |
| 20 | **UCAN** | **reject** | Delegation 1.0.0 is finalized and the field names are clean, but it is DID-addressed and RFA has no DID resolution layer and should not acquire one (§7) | - | none |
| 21 | **GNAP (RFC 9635)** | **reject** | Published Oct 2024; adoption limited, reference clients unmaintained. Zero MCP integration path (§7) | - | none |
| 22 | **SPIFFE/SPIRE mTLS** | **defer** (adapter, never a requirement) | CNCF-graduated Sept 2022 and genuinely real, but it is infrastructure (server + per-node agent + attestation) for workloads *you* operate. An org already running SPIRE can terminate mTLS in front of the hub and hand the hub an SVID; that is an adapter, not spec text. Contradicts "no Kubernetes" if mandated (§7) | - | Optional note in 4.3 |
| 23 | **DPoP (RFC 9449)** sender-constrained tokens | **defer** | The right fix for bearer-token theft (`cnf.jkt`, `htm`/`htu`/`ath`, `use_dpop_nonce`), and RFC 9728 even has `dpop_bound_access_tokens_required`. Defer because a 15-minute audience-bound token over TLS is adequate for a pilot and DPoP needs client-side support the remote org may not have | - | 4.3 forward-reference only |
| 24 | Publishing hub/agent cards to a **registry or directory** (ANS/NANDA/AGNTCY/MCP Registry) as a trust root | **reject / stays parked** | MCP Registry self-labels **preview** with possible data resets; AGNTCY's directory is rated "emerging"; ANS and NANDA are papers. None is a trust root in 2026. The *interesting* part of the MCP Registry is its DNS proof, and we can adopt that mechanism without joining a registry (§6) | - | none |
| 25 | Adopt the **MCP Registry's DNS proof shape** as an optional second anchor: apex TXT `v=RFAv1; k=ed25519; p=<base64>` | **adapt** | Exact working precedent: `${DOMAIN}. IN TXT "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"`, apex placement (SPF-style, not DKIM-style), documented rotation footgun (remove the stale record). Useful when a peer cannot serve HTTPS at its apex; strictly optional, since HTTPS + a JWKS is the primary (§6) | spike | Optional paragraph in 6.1 |
| 26 | Quarantine keyed on **org origin and signing kid**, and org removal from `admit.orgs` as the real kill switch | **adopt** | Today quarantine is keyed on name and capability digest ([`src/store.ts:436`](../../../src/store.ts)); a remote org changes either in one line of config. Quarantining an identity a stranger controls is theatre (§8) | spike | 12.1 quarantine semantics |
| 27 | **Key-validity-at-event-time** rule: verifying a *stored* event uses the key valid at that event's `ts`, not "now" | **adopt** | Matrix separates `verify_keys` from `old_verify_keys` ("valid only for event verification") precisely for this. Without this rule, every key rotation retroactively invalidates history and rotation becomes unperformable (§5, §8) | spike | 6.1 + 13 audit |
| 28 | **Admission audit event**: `system {event: "admitted", refs: {org, keys_url, kid, method, admitted_by, scopes}}` at join | **adopt** | Today the join record does not say *why* the peer was trusted. That is the single most important missing field in a two-org dispute (§10) | spike (2 h) | 13 audit; 9.4 system event list |
| 29 | Remote-owned tasks: `evidence_required` forced on, and the verifier MUST be a local member or human | **adopt** | The evidence gate already exists (spec 10.2, verifier's member id must differ from owner). Remote execution with unauditable tools is exactly the case it was designed for, and it is currently opt-in per task (§10) | spike | 5.1 `policies.remote_task_evidence`; 10.2 note |
| 30 | Long-lived static per-peer bearer tokens instead of any of the above | **adapt** (once, time-boxed, scoped) | Acceptable for exactly one pilot with a written expiry date, and only if the token already carries the scope set so that switching to JWTs later changes the credential, not the authorization model. Six concrete failure modes enumerated in §3 | free | Non-normative deployment note only |
| 31 | Normative **REST binding** | **adopt / unparks** (identity-side evidence) | Both viable T1 mechanisms attach to HTTP, not to MCP: RFC 9728/OAuth is scoped to "HTTP-based transports" and RFC 9421 signs HTTP messages. A REST binding therefore inherits identity for free, and a LangGraph process should not have to embed an MCP client to join a room. Another dimension owns the binding's shape; this is the identity argument for it | week+ | Promote 11.4 from informative to normative in v0.2 |
| 32 | **Multi-operator credential isolation** | **adopt / unparks** | Directly implied: `orgs.json`, per-org `client_ids`, per-org key directories, per-org quarantine sets. Wave 02/03 parked this on "one operator", which is retired | week | 4.3/4.4 as above |
| 33 | **Cross-hub federation** | **stays parked** (but the prerequisite is being built) | A remote *member* is not a remote *hub*. Nothing in this dimension needs `search_id`/`max_depth`/`scope`. Note that the org-anchored key directory is exactly what federation would later need, so rec. 9 is not wasted if federation ever lands | - | none |
| 34 | **Group E2E encryption (MLS)** | **reject on principle, not effort** | The pre-delivery policy gate (spec 12.2, implemented) must read message content to run rules, model screening and egress checks. End-to-end encryption and a content policy gate are mutually exclusive by construction. Choose the gate | - | Record the rejection reason in Appendix D so it is not re-litigated |
| 35 | **Tool passthrough** under a namespace | **stays parked**, with one identity rule attached now | If it ever ships, MCP's rule applies verbatim: "The MCP server **MUST NOT** pass through the token it received from the MCP client." The hub gets its own upstream token or it is a confused deputy | - | Add the MUST NOT to Appendix D's passthrough line |

### What to refuse to build

1. **An authorization server.** Not Keycloak-as-part-of-RFA, not a `/token` endpoint, not a "lite AS". Publish RFC 9728 metadata, point at whatever the org runs, validate JWTs. If the org has no IdP, static scoped tokens (rec. 30) are a better answer than a hub that mints its own.
2. **Dynamic Client Registration or Client ID Metadata Documents in the hub.** DCR is **deprecated** as of 2026-07-28; CIMD is an AS-side feature about redirect URIs. A resource server has no business with either.
3. **RFC 8693 token exchange.** Delete it from spec 4.2.
4. **A registry, a directory service, or a web of trust.** No candidate in 2026 is a trust root. The allowlist is not a placeholder for a registry; it is the answer.
5. **Datalog, macaroons, biscuit, UCAN, DIDs, verifiable credentials.** There is a hub on the path.
6. **Signing the full envelope.** It cannot work; `seq`/`ts`/`from`/`prev_hash` belong to the hub.
7. **Trusting `provider.organization`.** It is free text today ([`spec/RFA-0.1.md:157`](../../../spec/RFA-0.1.md)) and models will believe it. Either verify a domain (`provider.origin`) or stop showing it as identity.
8. **Accepting an embedded card JWK as identity for a remote org.** Spec 6.1 already says an embedded key proves integrity and key binding only. Make `allow_embedded_jwk: false` the default for admitted orgs and never the default for strangers.
9. **mTLS as the mandatory transport.** Fine as an adapter for an org that already has PKI; a hard requirement kills the "small team self-hosts" property.
10. **Per-room, per-agent hand-minted credentials.** One credential per (org, agent), scoped, expiring. Hand-minting per room is where multi-peer deployments rot.
11. **A revocation list / CRL / OCSP of your own design.** Short TTL plus config removal covers it. AIP shipped a CRL field that no implementation enforces; do not repeat that.
12. **Post-quantum anything, algorithm negotiation, `alg` agility beyond EdDSA + ES256.** The existing two-algorithm allowlist ([`src/signing.ts:105`](../../../src/signing.ts)) is correct and should stay closed.

---

## Evidence

### 1. MCP authorization, exactly as it stands on 2026-07-28

Source: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> (fetched 2026-08-17).

**Is authorization required?** No. Verbatim, under "Protocol Requirements":

> Authorization is **OPTIONAL** for MCP implementations. When supported:
> * Implementations using an HTTP-based transport **SHOULD** conform to this specification.
> * Implementations using an STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment.
> * Implementations using alternative transports **MUST** follow established security best practices for their protocol.

**Roles.** Verbatim:

> A protected *MCP server* acts as an [OAuth 2.1 resource server] ... The *authorization server* is responsible for interacting with the user (if necessary) and issuing access tokens for use at the MCP server. **The implementation details of the authorization server are beyond the scope of this specification. It may be hosted with the resource server or a separate entity.**

That sentence is the whole answer to "can a self-hosting org satisfy T1 without operating an AS": the spec explicitly puts the AS out of scope and permits it to be a separate entity.

**The five numbered Overview requirements**, verbatim:

> 1. Authorization servers **MUST** implement OAuth 2.1 with appropriate security measures for both confidential and public clients.
> 2. Authorization servers and MCP clients **SHOULD** support OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00).
> 3. Authorization servers and MCP clients **MAY** support the OAuth 2.0 Dynamic Client Registration Protocol (RFC7591). Note that Dynamic Client Registration is deprecated and retained for backwards compatibility with authorization servers that do not support Client ID Metadata Documents.
> 4. MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC9728). MCP clients **MUST** use OAuth 2.0 Protected Resource Metadata for authorization server discovery.
> 5. MCP authorization servers **MUST** provide at least one of the following discovery mechanisms: OAuth 2.0 Authorization Server Metadata (RFC8414) [or] OpenID Connect Discovery 1.0 ... MCP clients **MUST** support both discovery mechanisms.

Note the distribution of duties: **the only MUST landing on the server is RFC 9728**. Everything about registration, PKCE, discovery, and `iss` validation is on the client or the AS.

**RFC 8707 resource parameter**, verbatim:

> MCP clients **MUST** implement Resource Indicators for OAuth 2.0 as defined in RFC 8707 ... The `resource` parameter:
> 1. **MUST** be included in both authorization requests and token requests.
> 2. **MUST** identify the MCP server that the client intends to use the token with.
> 3. **MUST** use the canonical URI of the MCP server as defined in RFC 8707 Section 2.
> ...
> MCP clients **MUST** send this parameter regardless of whether authorization servers support it.

Valid canonical URIs given: `https://mcp.example.com/mcp`, `https://mcp.example.com`, `https://mcp.example.com:8443`, `https://mcp.example.com/server/mcp`. Invalid: `mcp.example.com` (no scheme), `https://mcp.example.com#fragment` (fragment).

**Token handling**, verbatim:

> MCP servers, acting in their role as an OAuth 2.1 resource server, **MUST** validate access tokens as described in OAuth 2.1 Section 5.2. MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience, according to RFC 8707 Section 2. ... Invalid or expired tokens **MUST** receive a HTTP 401 response.
> MCP clients **MUST NOT** send tokens to the MCP server other than ones issued by the MCP server's authorization server.
> MCP servers **MUST** only accept tokens that are valid for use with their own resources.
> MCP servers **MUST NOT** accept or transit any other tokens.

**Error codes**, verbatim table: `401` "Authorization required or token invalid"; `403` "Invalid scopes or insufficient permissions"; `400` "Malformed authorization request".

**The scope challenge that makes capability-scoping MCP-native**, verbatim:

> When a client makes a request with an access token with insufficient scope during runtime operations, the server **SHOULD** respond with:
> * `HTTP 403 Forbidden` status code (per RFC 6750 Section 3.1)
> * `WWW-Authenticate` header with the `Bearer` scheme and additional parameters:
>   * `error="insufficient_scope"` ...
>   * `scope="required_scope1 required_scope2"` - specifying the minimum scopes needed for the operation
>   * `resource_metadata` - the URI of the Protected Resource Metadata document
>   * `error_description` (optional)

and, decisively for per-verb scoping:

> The required scopes may be determined dynamically based on the specific request arguments and context, but once determined, they should be emitted together.

Also verbatim, and relevant because RFA remote peers are machine clients:

> Clients acting on their own behalf (`client_credentials` clients) **MAY** attempt the step-up authorization flow or abort the request immediately.

and:

> Servers **MUST** account for scope hierarchies, where a broader scope implies narrower ones, when deciding whether a token is sufficient for an operation.

**Example 401 with scope guidance**, verbatim:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource",
                         scope="files:read"
```

**Security considerations** (<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations>), verbatim and important because it softens the RFC 8707 MUST at exactly the point the IdP market fails:

> RFC 8707 Resource Indicators provide critical security benefits by binding tokens to their intended audiences **when the Authorization Server supports the capability**. To enable current and future adoption:
> * MCP clients **MUST** include the `resource` parameter in authorization and token requests ...
> * MCP servers **MUST** validate that tokens presented to them were specifically issued for their use

and:

> MCP servers **MUST** only accept tokens specifically intended for themselves and **MUST** reject tokens that do not include them in the audience claim or otherwise verify that they are the intended recipient of the token.
> If the MCP server makes requests to upstream APIs, it may act as an OAuth client to them. The access token used at the upstream API is a separate token, issued by the upstream authorization server. **The MCP server MUST NOT pass through the token it received from the MCP client.**

"or otherwise verify that they are the intended recipient" is the escape hatch that makes a Keycloak audience-mapper deployment conformant on the server side.

**Client registration** (<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>), verbatim priority order:

> 1. Use pre-registered client information for the server if the client has it available
> 2. Use Client ID Metadata Documents if the Authorization Server indicates that it supports them (via `client_id_metadata_document_supported` in OAuth Authorization Server Metadata)
> 3. Use Dynamic Client Registration as a fallback if the Authorization Server supports it (via `registration_endpoint` ...)
> 4. Prompt the user to enter the client information if no other option is available

and the deprecation warning verbatim: "Dynamic Client Registration is deprecated. New implementations should use Client ID Metadata Documents instead."

**Changelog** (<https://modelcontextprotocol.io/specification/2026-07-28/changelog>), the authorization-relevant entries verbatim:

> 7. Authorization servers **SHOULD** include the `iss` parameter in authorization responses per RFC 9207, and MCP clients **MUST** validate a present `iss` against the recorded issuer before redeeming the authorization code (SEP-2468).
> 9. Clarify that client credentials are bound to the authorization server that issued them: clients **MUST** key persisted credentials by the issuer identifier, **MUST NOT** reuse them with a different authorization server, and **MUST** re-register when the authorization server changes (SEP-2352).
> [Deprecated] 4. Deprecate the OAuth 2.0 Dynamic Client Registration Protocol (RFC7591) as a client registration mechanism in favor of Client ID Metadata Documents (PR #2858). It remains available for backwards compatibility ...

The 2026-07-28 revision supersedes **2025-11-25**. The deprecation policy is a "minimum twelve-month deprecation window".

**Client credentials is an extension, not core.** The extension registry is `github.com/modelcontextprotocol/ext-auth`. Its full tree (via `gh api repos/modelcontextprotocol/ext-auth/git/trees/main?recursive=1`, 2026-08-17) is exactly two spec files:

```
specification/draft/oauth-client-credentials.mdx
specification/stable/enterprise-managed-authorization.mdx
```

From `specification/draft/oauth-client-credentials.mdx` (raw.githubusercontent.com, 2026-08-17), verbatim:

> **Protocol Revision**: draft
> This extension defines OAuth 2.1 Client Credentials flow support for the Model Context Protocol, enabling machine-to-machine authentication without user interaction.
> This extension is **OPTIONAL** for MCP implementations. When adopted:
> - Implementations **MUST** conform to all requirements specified in this extension
> - Implementations **MUST** also conform to the baseline authorization requirements
> - This extension is specifically designed for HTTP-based transports
>
> The Client Credentials flow enables machine-to-machine authentication without user interaction. This flow requires pre-registered client credentials, which are typically established out-of-band through administrative channels. **Dynamic Client Registration is not used in this flow.**
>
> Clients **MUST** authenticate using one of these methods:
> - JWT Authentication (RECOMMENDED) - Clients use JWT Authentication as defined in RFC 7523 Section 2.2.
> - Client Secret - Clients use a Client Secret transmitted in the request content as defined in OAuth 2.1 Section 2.4.1
>
> When supporting the client credentials flow, Authorization Server metadata **MUST** include the following fields:
> - `token_endpoint_auth_methods_supported`: **MUST** include at least one of: `"private_key_jwt"`, `"client_secret_basic"`
> - `token_endpoint_auth_signing_alg_values_supported`: Required when supporting JWT authentication

Verbatim wire examples from that file:

```
POST /token HTTP/1.1
Host: auth.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer
&client_assertion=eyJhbGciOiJSUzI1NiIsImtpZCI6IjIyIn0. ...
&resource=https%3A%2F%2Fmcp.example.com
&scope=mcp%3Aread
```

```
POST /token HTTP/1.1
Host: auth.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=s6BhdRkqt3
&client_secret=7Fjfp0ZBr1KtDRbnfVdmIw
&resource=https%3A%2F%2Fmcp.example.com
&scope=mcp%3Aread
```

Note the `client_id` omission rule verbatim: "The `client_id` parameter is omitted from the request body as RFC 7523 Section 3 specifies that client identification is conveyed through the `sub` claim within the JWT assertion."

**Consequence for RFA's spec 4.2.** The current line reads "T1 | OAuth 2.1 client credentials at the MCP transport layer; RFC 8693 token exchange for on-behalf-of | SHOULD implement". Two errors: client credentials is a draft optional extension whose entire content is *client-side and AS-side*, and RFC 8693 is a token-endpoint grant type. Nothing in either is implementable by a resource server. The hub's actual obligations are RFC 9728 + token validation, both of which are small.

### 2. RFC 8693, and the on-behalf-of question answered

Source: <https://www.rfc-editor.org/rfc/rfc8693.html>. **RFC 8693, "OAuth 2.0 Token Exchange", January 2020, Standards Track.**

Request parameters at the **token endpoint**:

- `grant_type` = `urn:ietf:params:oauth:grant-type:token-exchange` (REQUIRED)
- `subject_token` (REQUIRED), `subject_token_type` (REQUIRED)
- `actor_token` (OPTIONAL), `actor_token_type` (REQUIRED when `actor_token` present)
- `resource`, `audience`, `scope`, `requested_token_type` (all OPTIONAL)

Token type identifiers: `urn:ietf:params:oauth:token-type:access_token`, `:refresh_token`, `:id_token`, `:saml1`, `:saml2`.

Response: `access_token` (REQUIRED), `issued_token_type` (REQUIRED), `token_type` (REQUIRED), `expires_in` (RECOMMENDED), `scope`, `refresh_token`.

Delegation claims, verbatim shapes:

```json
{ "sub": "user@example.com", "act": { "sub": "admin@example.com" } }
```

```json
{ "sub": "user@example.com", "may_act": { "sub": "admin@example.com" } }
```

The RFC's own distinction: impersonation means "A is B within the context of the rights authorized by the token"; delegation means A keeps a separate identity while representing B.

**Where token exchange actually lives in the MCP world.** The `stable` MCP auth extension is *Enterprise-Managed Authorization* (`specification/stable/enterprise-managed-authorization.mdx`), which is a profile of `draft-ietf-oauth-identity-assertion-authz-grant` (itself a profile of `draft-ietf-oauth-identity-chaining`). Verbatim from that file, the three steps:

> 1. Single Sign-On to the MCP Client via OpenID Connect or SAML
> 2. Token Exchange (RFC8693)
> 3. JWT Authorization Grant (RFC7523)

Verbatim token-exchange request:

```
POST /oauth2/token HTTP/1.1
Host: acme.idp.example
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&requested_token_type=urn:ietf:params:oauth:token-type:id-jag
&audience=https://auth.chat.example/
&resource=https://mcp.chat.example/
&scope=chat.read+chat.history
&subject_token=eyJraWQiOiJzMTZ0cVNtODhwREo4VGZCXzdrSEtQ...
&subject_token_type=urn:ietf:params:oauth:token-type:id_token
&client_id=2ec954a1d60620116d36d9ceb7
&client_secret=a26d84873504215a34a86d52ef5cd64f4b76
```

Verbatim ID-JAG shape:

```
{ "typ": "oauth-id-jag+jwt" }
.
{ "jti": "9e43f81b64a33f20116179", "iss": "https://acme.idp.example",
  "sub": "U019488227", "email": "user@example.com",
  "aud": "https://auth.chat.example/", "resource": "https://mcp.chat.example/",
  "client_id": "f53f191f9311af35", "exp": 1311281970, "iat": 1311280970,
  "scope": "chat.read chat.history" }
.
signature
```

Verbatim profile rules: `audience` "**MUST** be the issuer identifier of the Resource Authorization Server"; `resource` is "**OPTIONAL** and if set, **MUST** be the Resource Identifier of the MCP Server as defined in RFC9728"; the final access token "**MUST** be audience-restricted to the MCP Server identified by the `resource` claim in the ID-JAG"; discovery is `urn:ietf:params:oauth:grant-profile:id-jag` in `authorization_grant_profiles_supported`.

And the scope limit, verbatim, which is exactly the honest bound on what any of this buys:

> The visibility the IdP has between the MCP Client and MCP Server is limited to the process of issuing the access token, but does not extend to the actual MCP traffic between the MCP Client and Server.

**Verdict on "is RFC 8693 needed for org B's agent acting in org A's room?"** No, and the framing in spec 4.2 is a category error. Three cases:

- *Org B's agent acts as itself.* This is the actual premise ("remote agents ... executing with THEIR OWN tools"). There is no user to be on behalf of. `client_credentials` with an `aud` and a scope set is complete. Token exchange adds nothing.
- *Org B's agent acts for a named human at org B.* The delegation happens entirely inside org B's IdP; what reaches the hub is one access token whose `act` claim names the agent and whose `sub` names the human. **The hub's entire job is to read `act.sub` and record it.** Five lines. Do that (rec. 6).
- *Org B's agent acts for a named human at org A.* This is the enterprise SSO case the Enterprise-Managed Authorization extension addresses, it requires org A's IdP to be in the loop, and it is over-engineering for a pilot. Defer, and note that if it ever arrives, the flow is entirely between the two IdPs and the hub still only validates one audience-bound token.

Zitadel's own docs are useful here as an existence proof that an off-the-shelf IdP will do the exchange for you (<https://zitadel.com/docs/guides/integrate/token-exchange>): it supports `urn:ietf:params:oauth:grant-type:token-exchange` with subject token types `access_token`, `id_token`, `jwt`, and a custom `urn:zitadel:params:oauth:token-type:user_id`; `actor_token` is supported ("Currently only a valid access token or ID token are allowed as actor token"); the `act` claim it issues is `{"iss": "...", "sub": "..."}`. It also says verbatim: "At ZITADEL we don't make any distinction between the two concepts, so we call both cases impersonation from this point" - a warning that the impersonation/delegation distinction the RFC draws is not preserved by real products.

### 3. Can an org satisfy T1 without operating an AS? Yes. And here is exactly where it hurts.

**Yes, structurally**, per §1: the AS is out of scope and may be a separate entity, and the only server-side MUSTs are RFC 9728 metadata plus audience validation.

RFC 9728 itself (<https://www.rfc-editor.org/rfc/rfc9728.html>, **April 2025, Standards Track**): the only REQUIRED field is `resource`. `authorization_servers`, `jwks_uri`, `scopes_supported` (RECOMMENDED), `bearer_methods_supported`, `resource_signing_alg_values_supported`, `resource_name`, `resource_documentation`, `resource_policy_uri`, `resource_tos_uri`, `tls_client_certificate_bound_access_tokens`, `authorization_details_types_supported`, `dpop_signing_alg_values_supported`, `dpop_bound_access_tokens_required`, `signed_metadata` are all optional. Default path `/.well-known/oauth-protected-resource`, and for a resource with a path the well-known segment is inserted between host and path (`https://resource.example.com/resource1` -> `https://resource.example.com/.well-known/oauth-protected-resource/resource1`). Section 5.1 gives the `WWW-Authenticate` parameter `resource_metadata`. A conformant metadata document is 6 lines of JSON.

**Where it hurts: the RFC 8707 `resource` parameter is a client MUST that the IdP market largely does not implement.** Primary/official sources:

- **Keycloak** (<https://www.keycloak.org/securing-apps/mcp-authz-server>, version shown Nightly 26.7.1): targets MCP **2025-03-26** as fully supported; rates 2025-06-18 and 2025-11-25 as "Partially Supported **without Resource Indicators for OAuth 2.0**"; states verbatim "**Keycloak cannot recognize `resource` parameter**" and directs implementers to use the `scope` parameter with **Audience mappers** to bind `aud` to the MCP server URL. RFC 7591 DCR is Supported. CIMD exists behind `--features=cimd` and is labelled experimental with possible breaking changes.
- **Zitadel** (<https://zitadel.com/docs/guides/integrate/token-exchange>): verbatim "ZITADEL does not yet support Resource Indicators. Supplying this parameter will always result in an `invalid_target` error." A strictly MCP-conformant client, which MUST send `resource` "regardless of whether authorization servers support it", therefore cannot get a token from Zitadel at all.
- **Auth0** (<https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile>): ships a "Resource Parameter Compatibility Profile" mapping `resource` onto its `audience` concept, across `/authorize`, PAR, JAR, CIBA and refresh-token grants. Stated limitation, verbatim in effect: if both `resource` and `audience` are supplied, "the `audience` will still be used"; with the profile on, Auth0 will not forward `resource` upstream to federated IdPs; resource identifiers must be absolute URIs.
- **Ory Hydra**: supports `--audience` on `hydra perform client-credentials`; there is an open issue reporting that no audience is returned in the client_credentials access token even when requested (<https://github.com/ory/hydra/issues/3441>). UNVERIFIED whether that is still true on current Hydra; treat "check `aud` actually lands in the token" as a mandatory acceptance test for any IdP choice.
- Secondary and flagged as such: multiple 2026 write-ups claim only Amazon Cognito and Ping Identity natively support the standard `resource` parameter, with Auth0/Okta/Microsoft/Google using proprietary audience parameters. UNVERIFIED against those vendors' own docs; do not rely on it, but it matches the three primary sources above.

**Why this does not block the design.** The MUST to *send* `resource` binds the **client**. The MUST to validate audience binds the **server**, and the security-considerations page permits "or otherwise verify that they are the intended recipient of the token". So: hub validates `aud`; how the AS decided to put the hub's URI in `aud` (RFC 8707, a Keycloak audience mapper, an Auth0 API identifier) is the operator's problem and every IdP can do it one way or another. The RFA spec must therefore **not** require the `resource` parameter. It must require the audience claim.

**What breaks if the org just issues long-lived per-peer tokens instead.** Six concrete failures, each of which is a real incident shape rather than a purity argument:

1. **Revocation becomes unbounded.** With a 15-minute audience-bound JWT, revocation is "disable the client in the IdP", effective within one TTL, and the hub needs no revocation state. With a long-lived static token the hub must own a denylist forever, and a leaked token is valid until someone remembers it exists. RFA's own eviction guarantee ("Membership-token revocation MUST take effect on the next call", spec 14.8) covers the *membership*, not the transport credential, so an evicted peer with a live static token can simply re-join.
2. **No audience = replayable everywhere.** A static bearer that org B's agent also presents to org B's own services, or to a second hub, is a confused-deputy primitive. MCP's text is explicit that a server MUST reject tokens not intended for it - you cannot obey that rule with a token that has no audience.
3. **The hub becomes a credential store for other organizations.** Static shared secrets must be stored on the hub side to be checked. `data/secrets.json` (0600) and the nightly backups (`~/Backups/rfa-agent-com/<date>/`, per STATUS) then contain other orgs' credentials, and a backup leak is a multi-org incident. JWT validation stores only public keys.
4. **No independent principal in the audit record.** A static token yields "some caller who knew the string". A JWT yields `iss` + `sub`/`client_id` + `act` + `exp`, which is what a dispute needs (§10). This matters more than it sounds: the whole point of the org-anchored design is that the audit record can name the *org*, not just the membership.
5. **No scope, so every peer that can speak can also administer.** RFA's role model is per-membership, and a peer can request `role: participant` freely. Without scopes there is literally no way to grant "may claim and complete tasks" without also granting "may create tasks and send anything anywhere". Note the one thing the role model *does* still protect: `role: supervisor` requires a human key ([`src/store.ts:443-446`](../../../src/store.ts)), so a static-token peer cannot self-promote to supervisor. That is the floor, not a ceiling.
6. **Rotation requires coordinated downtime.** A shared secret must be swapped on both sides at the same instant. A JWKS rotates by publish-new / keep-old-until-expiry / drop-old with zero coordination (§5). For a live standing room this is the difference between a config edit and a scheduled outage negotiated with another company.

**So the honest concession**: static scoped tokens are acceptable for exactly one pilot, with a written expiry date, **and the token must already carry the scope set** so that moving to JWTs later swaps the credential without touching the authorization model. That is rec. 30.

### 4. RFC 9421 and Web Bot Auth: the alternative that actually has 2026 momentum

**RFC 9421, "HTTP Message Signatures", February 2024, Standards Track** (<https://www.rfc-editor.org/rfc/rfc9421.html>). Two header fields: `Signature-Input` (covered components + parameters) and `Signature` (the values). Derived components `@method`, `@target-uri`, `@authority`, `@path`, `@query`, `@status`. Signature parameters `created`, `expires`, `nonce`, `alg`, `keyid`, `tag`. Registered algorithms: `rsa-pss-sha512`, `rsa-pkcs1v15-sha256`, `hmac-sha256`, `ecdsa-p256-sha256`, `ecdsa-p384-sha384`, `ed25519`. Body coverage is indirect, through an RFC 9530 `Content-Digest` field that is itself a covered component.

Verbatim signature base and headers from the RFC's worked example:

```
"@method": POST
"@authority": example.com
"@path": /foo
"content-type": application/json
"content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:
"@signature-params": ("@method" "@authority" "@path" "content-type" "content-digest");created=1618884475;keyid="test-key-rsa-pss";alg="rsa-pss-sha512"
```

```
Signature-Input: sig1=("@method" "@authority" "@path" "content-type" "content-digest");created=1618884475;keyid="test-key-rsa-pss";alg="rsa-pss-sha512"
Signature: sig1=:e8UJ5wMiRaonlth5ERtE8GIiEH7Akcr493nQ07VPNo6y3qvjdKt0fo8VHO8xXDjmtYoatGYBGJVlMfIp06eVMEyNW2I4vN7XDAz7m5v1108vGzaDljrd0H8+SJ28g7bzn6h2xeL/8q+qUwahWA/JmC8aOC9iVnwbOKCc0WSrLgWQwTY6VLp42Qt7jjhYT5W7/wCvfK9A1VmHH1lJXsV873Z6hpxesd50PSmO+xaNeYvDLvVdZlhtw5PCtUYzKjHqwmaQ6DEuM8udRjYsoNqp2xZKcuCO1nKc0V3RjpqMZLuuyVbHDAbCzr0pg2d2VM/OC33JAU7meEjjaNz+d7LWPg==:
```

**Web Bot Auth is the profile with traction.** IETF WG `webbotauth`: charter approved **2025-10-23**, chairs Rifaat Shekh-Yusef and David Schinazi, AD Mike Bishop, milestones April 2026 (authentication technique to IESG; bot-information technique to IESG) and August 2026 (BCP operational spec) (<https://datatracker.ietf.org/wg/webbotauth/about/>, <http://www.mail-archive.com/ietf-announce@ietf.org/msg26115.html>). WG document list (<https://datatracker.ietf.org/wg/webbotauth/documents/>, fetched 2026-08-17), current and dated:

| Draft | Rev | Date |
|---|---|---|
| `draft-meunier-webbotauth-httpsig-protocol` | 01 | 2026-08-05 |
| `draft-meunier-webbotauth-httpsig-directory` | 00 | 2026-06-26 |
| `draft-meunier-webbotauth-registry` | 03 | 2026-06-26 |
| `draft-nottingham-webbotauth-use-cases` | 02 | 2026-04-01 |
| `draft-rescorla-anonymous-webbotauth` | 01 | 2026-07-19 |
| `draft-singh-webbotauth-hosted-directories` | 00 | 2026-07-19 |
| `draft-illyes-webbotauth-cbcp` / `-jafar` | 00 | 2026-04-21 |

The older `draft-meunier-web-bot-auth-architecture-05` (2026-03-02) is marked **Replaced** by the httpsig-protocol draft; do not cite the architecture draft as current.

From `draft-meunier-webbotauth-httpsig-protocol-01` (dated August 6, 2026, expires February 7, 2027), the normative core:

- Agents **MUST** cover at least one of `@authority` or `@target-uri`.
- `@signature-params` **MUST** include `created`, `expires` (recommended max 24 h), `keyid` = base64url JWK SHA-256 thumbprint per RFC 7638, and `tag` = the exact string `"web-bot-auth"`.
- `Signature-Agent` is a Dictionary Structured Header (RFC 9651 §3.2) whose values are HTTPS URIs, with an optional `type` parameter defaulting to `directory`; other types `jwks_uri` and `cimd`. When sent, at least one member **MUST** be a covered component.
- Verifiers **MUST** discard signatures whose `tag` is not `"web-bot-auth"`, and **MUST** key lookups on `(URL, keyid)` pairs, not `keyid` alone.
- HMAC shared secrets are prohibited; asymmetric only. TLS required for requests and directory fetches. Verifiers should bound directory fetches against SSRF (size, key count, timeout, redirects, network ranges).
- Replay: `nonce` as base64url random bytes, >= 64 bytes recommended, unique within the created/expires window.
- **No revocation mechanism is defined; removal from the directory is the only remedy.**

Verbatim minimal example:

```
GET / HTTP/1.1
Host: example.com
Signature-Agent: sig1="https://signature-agent.test"
Signature-Input: sig1=("@authority" "signature-agent";key="sig1")
 ;created=1735689600
 ;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U"
 ;expires=4889289600
 ;nonce="zIW8+cdmA3vdYagbxojpONwa/l0EKJ/O3/wD486VvsQ..."
 ;tag="web-bot-auth"
Signature: sig1=:QKN4fTdIYfh82fvoZCQiQA1weuozfCS/Led2zTMbewM...=:
```

From `draft-meunier-webbotauth-httpsig-directory-00` (2026-06-26, Meunier/Cloudflare + Major/Google): well-known path **`/.well-known/http-message-signatures-directory`**; media type **`application/http-message-signatures-directory+json`**; JWKS per RFC 7517 §5; `kid` is the base64url JWK SHA-256 thumbprint (RFC 7638 §3.2 for RSA/EC, RFC 8037 Appendix A.3 for Ed25519); recommended `Cache-Control: max-age=86400`; rotation is add-new-before-use, keep-old-until-`exp`, then remove. Verbatim example:

```json
{
  "keys": [{
    "kty": "OKP",
    "crv": "Ed25519",
    "kid": "NFcWBst6DXG-N35nHdzMrioWntdzNZghQSkjHNMMSjw",
    "x": "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
    "use": "sig",
    "nbf": 1712793600,
    "exp": 1715385600
  }]
}
```

Deployment reality, from Google's own crawler documentation (<https://developers.google.com/crawling/docs/crawlers-fetchers/web-bot-auth>, last updated **2026-05-04**): "Google's implementation of Web Bot Auth is currently *experimental*"; the directory is `https://agent.bot.goog/.well-known/http-message-signatures-directory`; the header is `Signature-Agent: g="https://agent.bot.goog"`; verifiers should "Cache keys per the `Cache-Control` header" and "Delete expired or revoked keys"; and a caution worth repeating: "We don't sign every request of a particular agent."

**And a directly relevant sibling: `draft-meunier-webbotauth-registry-03` defines a "Signature Agent Card"**, described verbatim as "a JSON metadata document that a signature agent using [DIRECTORY] publishes to describe itself: its identity, purpose, rate expectations, and cryptographic keys." It reuses OAuth Dynamic Client Registration metadata parameters plus a `web_bot_auth` extension object. Verbatim example:

```json
{
  "client_id": "https://example.com/bot",
  "client_name": "Example Bot",
  "client_uri": "https://example.com/bot/about.html",
  "logo_uri": "https://example.com/logo.png",
  "contacts": ["mailto:bot-support@example.com"],
  "jwks_uri": "https://example.com/.well-known/http-message-signatures-directory",
  "web_bot_auth": {
    "expected-user-agent": "Mozilla/5.0 ExampleBot",
    "rfc9309-product-token": "ExampleBot",
    "rfc9309-compliance": ["User-Agent", "Allow", "Disallow", "Content-Usage"],
    "trigger": "fetcher",
    "purpose": "tdm",
    "targeted-content": "Cat pictures",
    "rate-control": "429",
    "rate-expectation": "avg=10rps;max=100rps",
    "known-urls": ["/", "/robots.txt", "*.png"],
    "ips_uri": "https://example.com/ips.json"
  }
}
```

with the trust rule: "the resource at `jwks_uri` **SHOULD** be signed using [HTTP-MESSAGE-SIGNATURES]" and clients "**SHOULD** validate the signature and ignore keys that do not carry a corresponding valid signature".

**Which fits RFA, RFC 9421 or JWS-over-JCS?** Both, at different layers, and the answer is not a choice:

- **RFC 9421 signs the hop.** It is the right tool for "is this HTTP request really from org B", it needs no authorization server, it anchors keys at a domain, and it reuses the same JWKS directory that card verification would use. It is therefore a strictly better *transport* credential than a long-lived shared secret, and a genuine alternative to OAuth for orgs that have no IdP. Cost: RFA would need its own `tag` value (`"web-bot-auth"` is scoped to bot traffic and verifiers MUST discard other tags), plus nonce replay state, plus per-request signing in every client SDK.
- **RFC 9421 cannot settle a dispute.** The signature covers HTTP components that are discarded once the envelope is appended to the room log. Nothing in the durable record retains it. A month later there is no artifact.
- **JWS over JCS survives storage.** That is what the log needs, and RFA already implements it for cards.

Recommendation: **RFC 9421 for the hop, JWS-over-JCS for the record, one JWKS directory for both.** An org publishes one thing and gets transport authentication, card verification and message non-repudiation off the same keys.

### 5. Matrix: the only cross-org room protocol with a decade of production

Source: <https://spec.matrix.org/latest/server-server-api/>. Matrix is the closest prior art to "rooms whose members belong to different organizations", and its answers are directly transferable.

- **The server signs, not the user.** Events carry `signatures` as `{server_name: {key_id: signature}}`, e.g. `"signatures": {"example.org": {"ed25519:abc123": "ABCDEF..."}}`. Key ids are `algorithm:version`.
- **`signatures` and `hashes` are removed before signing**, and the redaction algorithm (which fields survive) is versioned per room version. Two hashes: a content hash over mutable fields and a reference hash over the essential fields, both base64 SHA-256. This is the same shape as RFA's "sign the card with `signatures` excluded" and the same shape the signed core needs.
- **Key publication endpoint** `GET /_matrix/key/v2/server` returns `server_name`, `verify_keys` (valid for signing federation requests and events), **`old_verify_keys` (valid only for event verification)**, `valid_until_ts` (ms since epoch), and signatures over the response itself. Verifiers must use "the lesser of `valid_until_ts` and 7 days into the future".
- **Request authentication is per-request signing, not a session.** Verbatim header shape:

```
X-Matrix origin="origin.hs.example.com",destination="destination.hs.example.com",key="ed25519:key1",sig="ABCDEF..."
```

over a signed JSON object containing `method`, `uri`, `origin`, `destination`, and `content`.

- **Notary servers** (`POST /_matrix/key/v2/query`, `GET /_matrix/key/v2/query/{serverName}`) return responses signed by both the queried server and the notary, so a server that cannot reach a peer can still get its keys.

Two lessons RFA should take verbatim:

1. **The `old_verify_keys` split is not optional.** A signature made last week must still verify after this week's rotation. If verification always uses "current keys", every rotation retroactively invalidates history and nobody will ever rotate. Hence rec. 27: verification of a stored event resolves the key valid at that event's `ts`.
2. **Signing per request rather than per session is what makes cross-org attribution work.** Matrix does not have "a session token proves the org"; every request carries a signature. That is the same conclusion RFC 9421/Web Bot Auth reaches independently, and it is the argument for why a signed *transport session* is weaker than per-message/per-request signing when the counterparty is another company: with a session credential, everything after the handshake is attributable only by the hub's word.

### 6. Admitting a card from an unknown org: allowlist, directory, web of trust, domain proof, or human review

**A2A 1.0 is the closest card standard and it stops one step short of identity.** Source: `docs/specification.md` at <https://github.com/a2aproject/A2A> (latest released version 1.0.0). Discovery is `https://{server_domain}/.well-known/agent-card.json` (the IANA registration template in §12 of that document confirms the exact path and states "The resource at this URI MUST return an AgentCard object"). Signing, verbatim from §8.4:

> Agent Cards **MAY** be digitally signed using JSON Web Signature (JWS) as defined in RFC 7515 ... Before signing, the Agent Card content **MUST** be canonicalized using the JSON Canonicalization Scheme (JCS) as defined in RFC 8785 ... **Signature Field Exclusion**: The `signatures` field itself **MUST** be excluded from the content being signed to avoid circular dependencies.

`AgentCardSignature` fields, verbatim: `protected` (required, base64url JWS Protected Header), `signature` (required, base64url), `header` (optional, unprotected header as a JSON object, not base64url). Protected header **MUST** include `alg`, `typ` (**SHOULD** be `"JOSE"`), `kid`; **MAY** include `jku` (JWKS URL). Verification steps, verbatim: extract from the `signatures` array; "Retrieve the public key using the `kid` and `jku` (or from a trusted key store)"; remove default-valued properties; exclude `signatures`; canonicalize per RFC 8785; verify. Security notes, verbatim: clients "**SHOULD** verify at least one signature before trusting an Agent Card"; "Clients **MAY** maintain a trusted key store for known agent providers"; "Expired or revoked keys **MUST NOT** be used for verification"; "Multiple signatures **MAY** be present to support key rotation".

Verbatim signature example (note `jku` in the protected header):

```json
{
  "protected": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpPU0UiLCJraWQiOiJrZXktMSIsImprdSI6Imh0dHBzOi8vZXhhbXBsZS5jb20vYWdlbnQvandrcy5qc29uIn0",
  "signature": "QFdkNLNszlGj3z3u0YQGt_T9LixY3qtdQpZmsTdDHDe3fXV9y9-B3m2-XgCpzuhiLt8E0tV6HXoZKHv4GtHgKQ"
}
```

decoding to `{"alg":"ES256","typ":"JOSE","kid":"key-1","jku":"https://example.com/agent/jwks.json"}`.

**RFA is already ahead of A2A on one point and behind on another.** Ahead: RFA forbids the `jku`-style self-pointing key hint being treated as identity and requires `kid` to equal the RFC 7638 thumbprint when a key is embedded ([`spec/RFA-0.1.md:181`](../../../spec/RFA-0.1.md), enforced at [`src/signing.ts:140`](../../../src/signing.ts)), which closes the "attacker pairs a familiar kid with a substituted key" hole. A2A's `jku` path, taken literally, lets the card nominate its own key server, which proves nothing about identity. Behind: RFA has no *resolution by domain* at all, so the only real trust path today is a hand-provisioned `kid -> JWK` map, which does not survive more than a handshake or two.

**Registries: none of them is a trust root in 2026.**

- **Official MCP Registry**: verbatim from its own publishing documentation (<https://github.com/modelcontextprotocol/registry>, `docs/modelcontextprotocol-io/authentication.mdx`, fetched 2026-08-17): "The MCP Registry is currently in preview. Breaking changes or data resets may occur before general availability." Secondary reports put it at ~9,652 latest server records as of 2026-05-24 with GA still pending.
- **AGNTCY** (Cisco-initiated, now Linux Foundation, 75+ backers): its Agent Directory and OASF are rated "emerging" maturity by third-party trackers as of 2026-06-15. Vendor/press sources only; treat as not-a-trust-root.
- **ANS / NANDA / AgentHub / GRAIL**: papers in `research/01-protocol/papers/` (`agent-name-service-ans.pdf`, `nanda-index-beyond-dns.pdf`, `agenthub-registry.pdf`, `grail-realtime-agent-discovery.pdf`). No deployment.

**But the MCP Registry's *proof mechanism* is worth stealing outright**, because it is the only widely-documented, working domain proof in this ecosystem. Verbatim from the same file:

> If you choose domain-based authentication, your server's name in `server.json` **MUST** be of the form `com.example.*/*`, where `com.example` is the reverse-DNS form of your domain name.

DNS method, verbatim TXT record generation:

```bash
MY_DOMAIN="example.com"
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "${MY_DOMAIN}. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

with an operational warning verbatim:

> The TXT record must be placed on the **apex** of your domain (e.g. `example.com`), **not** under a selector like `_mcp-auth.example.com` ... MCP DNS auth follows SPF-style placement (apex), not DKIM-style (selector). ... If you rotate keys, also remember to remove the previous TXT record from the apex - a stale record left behind will be tried first and cause verification to fail.

HTTP method, verbatim: a `/.well-known/mcp-registry-auth` file containing `v=MCPv1; k=ed25519; p=${PUBLIC_KEY}`. ECDSA P-384 (`k=ecdsap384`) is the alternative, and the docs note macOS LibreSSL cannot do Ed25519 in `genpkey` so OpenSSL 3 is required. KMS variants exist (Google KMS, Azure Key Vault) which matters because it means the signing key can live in an HSM.

So the admission ladder, decided:

| Mechanism | Verdict | Why |
|---|---|---|
| **Operator allowlist of domains** (`orgs.json`) | **the default, and the only trust root** | One human decision per org, auditable, revocable in one line, no third party |
| **Domain proof over HTTPS** (JWKS at the org's own origin) | **the key resolution mechanism inside the allowlist** | Proves the card was signed by whoever controls the domain you allowlisted |
| **Domain proof over DNS TXT** (`v=RFAv1; k=ed25519; p=...` at the apex) | **optional second anchor** | For a peer that cannot serve HTTPS at its apex; adds DNS to the trust base, which is why it is secondary |
| **Human review at join time** (`join: "approve"`) | **adopt, as the unknown-org path** | Reuses the existing approval flow and console Inbox verbatim; the human sees the card, the org, the kid and the requested scopes, and approves once |
| **Registry / directory lookup** | **reject** | No candidate is a trust root in 2026 |
| **Web of trust** | **reject** | Nobody has shipped one for agents; the failure mode (transitive trust you did not grant) is the exact thing an allowlist exists to prevent |

### 7. The capability-token field, judged

**AIP (the paper in this repo).** `research/01-protocol/papers/aip-agent-identity-protocol.pdf`, "AIP: Agent Identity Protocol for Verifiable Delegation Across MCP and A2A", Sunil Prakash, Indian School of Business, **arXiv:2603.24775v1, 25 March 2026**. Single author.

What it proposes, verbatim where it matters. Identity scheme: `aip:web:<domain>/<path>` resolving over HTTPS to a well-known endpoint, and `aip:key:ed25519:<multibase>` self-certifying. Identity documents "**MUST** include a `document_signature` field: an Ed25519 signature over the RFC 8785 canonical form (excluding the signature field itself)". Verbatim identity document:

```json
{ "aip": "1.0",
  "id": "aip:web:jamjet.dev/agents/research",
  "public_keys": [{"id": "key-1", "type": "Ed25519",
    "public_key_multibase": "z6Mkf5rG...",
    "valid_from": "2026-03-01T00:00:00Z", "valid_until": "2026-06-01T00:00:00Z"}],
  "delegation": {"max_depth": 3, "allow_ephemeral_grants": true},
  "protocols": {"mcp": {"header": "X-AIP-Token"}, "a2a": {"agent_card_field": "aip_identity"}},
  "document_signature": "<Ed25519 over RFC 8785>",
  "expires": "2026-06-22T00:00:00Z" }
```

IBCT structure: Block 0 (Authority: root identity, initial scopes, budget ceiling, `max_depth`, expiry), Block N (Delegation: delegator, delegatee, narrowed scope, mandatory non-empty `context`), Block N+1 (Completion: result hash, verification status, resource consumption, cost). Two wire formats: compact = JWT `typ: aip+jwt, alg: EdDSA` with claims `iss, sub, scope, budget_usd, max_depth, exp`; chained = Biscuit with Datalog. Claim mapping table, verbatim: `iss -> identity($iss)`, `sub -> delegate($sub)`, `scope[i] -> right($scope_item)`, `budget_usd -> budget($budget_usd)`, `max_depth -> max_depth($max_depth)`, `exp -> expires($exp)`. The Simple policy profile's four normative Datalog templates, verbatim:

```
check if tool($t), ["search","browse"].contains($t);
check if budget($b), $b <= 50;
check if depth($d), $d <= 3;
check if time($t), $t <= 2026-03-22T12:00:00Z;
```

Delegation rules, verbatim highlights: "Each delegation block **MUST** be a subset of its parent's capabilities"; "Block 0 declares a `max_depth` value (default: 3)"; "Every delegation block **MUST** include a non-empty `context` field describing why the delegation is occurring. Verifiers **MUST** reject tokens with missing or empty context fields." Budget semantics, verbatim: "Budget fields represent per-token authorization ceilings, not running balances. ... At invocation time, the verifier checks that the declared budget is non-negative; it does not track cumulative spend. ... Aggregate spend enforcement is the runtime's responsibility, not the token's." MCP binding: `X-AIP-Token` header, nine error codes split 401 (missing, malformed, expired, signature invalid, identity unresolvable, key revoked) / 403 (scope insufficient, budget exceeded, depth exceeded). Claimed numbers: compact verify 0.049 ms (Rust) / 0.189 ms (Python); 340-380 bytes per delegation block; 0.22 ms over no-auth in a real MCP-over-HTTP deployment; 600 adversarial attempts, 100% rejection.

**Judgement.** The shapes are good and the protocol is not deployable:

- Its own Limitations section: "We have not deployed AIP in a production multi-agent system with real user traffic, cross-datacenter networking, or sustained load", evaluation "on a single machine with localhost networking".
- "**No revocation infrastructure.** AIP v1 relies on short-lived tokens (under one hour) ... identity documents may declare a CRL endpoint, but **no reference implementation enforces CRL checks**."
- "**Completion blocks are self-reported** ... A dishonest agent can misrepresent its result hash or cost without detection by the cryptographic layer alone." The paper cites its own prior work to say self-claimed quality "systematically selects the worst delegates". For RFA that is decisive: the *evidence gate with a distinct verifier* (spec 10.2) already solves the problem the completion block does not.
- "**Datalog verifier complexity** ... A maliciously crafted token with deeply nested or recursive policy rules could consume excessive CPU during verification." A new attack surface, admitted.
- Ed25519 only, no algorithm agility; DNS trust anchor inherits DNS hijacking; the comparison table scores AIP ✓ on all seven of its own criteria, which is a self-designed benchmark.
- Its own positioning paragraph is the honest one, verbatim: "**AIP and MCP OAuth are complementary: OAuth authenticates the transport connection; AIP authenticates the delegation chain.**" RFA does not have a delegation chain to authenticate. It has a hub, a room log, and a task board.

**Take three shapes, leave the tokens:** `max_depth` (RFA already has `parent_id` sub-task trees to hang it on), mandatory non-empty `context` per hop (an audit-quality requirement, free to enforce), budget as a per-hop ceiling rather than a running balance (matches how `maxBudgetUsd` already works in the resident, per wave 03).

**The rest of the field, in one table.**

| Candidate | Real or paper, 2026 | Deployable for RFA | Killer detail |
|---|---|---|---|
| **Macaroons** (NDSS 2014, <https://research.google.com/pubs/archive/41892.pdf>) | Real, old, libraries exist | **No** | HMAC-chained: every verifier holds the root secret and can forge. A cross-org verifier that can forge your credentials is not a credential system |
| **Biscuit** (<https://github.com/eclipse-biscuit/biscuit/blob/main/SPECIFICATIONS.md>) | **Real.** Eclipse Foundation project; datalog v3.3 (encoded as 6); Ed25519 chained blocks; verbatim: "The holder of a biscuit token can at any time create a new token by adding a block with more checks ... but they cannot remove existing blocks without invalidating the signature"; third-party blocks; sealing (`sig_n+1 = sign(sk_n+1, data_n + alg_n+1 + pk_n+1 + sig_n)`); revocation ids ("The revocation identifier for a block is its signature serialized to a byte array") | **Unneeded** | Solves offline attenuation. RFA's authorization point and its log are the same process. Cost: a Datalog evaluator in the trust path |
| **UCAN** (<https://github.com/ucan-wg/delegation>) | Real spec: Delegation **1.0.0**, finalized. Payload fields `iss, aud, sub, cmd, pol, nonce, meta, nbf, exp`; "Proofs in a chain MAY have different validity periods, but MUST all be valid at execution-time"; revocation deferred to a sibling spec | **No** | DID-addressed. RFA would have to acquire a DID resolution layer, which is a whole trust system with its own bootstrapping problem |
| **GNAP** (RFC 9635, October 2024, <https://datatracker.ietf.org/doc/html/rfc9635>) | Real RFC, thin adoption; two of the named example implementations unmaintained for 4+ years | **No** | Zero MCP integration path; MCP standardized on OAuth 2.1 and moved twice since |
| **SPIFFE / SPIRE** | **Real.** CNCF **graduated September 2022**; `spiffe://trust-domain/path` IDs delivered as X509-SVID or JWT-SVID; automatic rotation; trust-domain federation | **As an adapter only** | Requires a SPIRE server plus per-node agents plus attestation. That is exactly the "no Kubernetes" line. Fine if the peer org already runs it: terminate mTLS in front of the hub and read the SVID |
| **draft-niyikiza-oauth-attenuating-agent-tokens-00** (2026-03-16, expires 2026-09-17, **individual** submission, no IETF standing) | Draft only | **No** | Impressively specific: claims `aat_type` (`delegation`/`execution`), `del_depth`, `del_max_depth`, `par_hash` (SHA-256 of the parent's JWS signing input), `cnf`, `authorization_details` per RFC 9396; six invariants I1-I6 (delegation authority, depth monotonicity, TTL monotonicity, capability monotonicity, cryptographic linkage, proof of possession); constraint types `exact/pattern/range/one_of/not_one_of/contains/subset/regex/cel/wildcard` with `all/any/not`; limits MAX_TOKEN_SIZE 64 KiB, MAX_STACK_SIZE 256 KiB, MAX_TOKEN_LIFETIME 90 days, MAX_IAT_SKEW 30 s, MAX_CONSTRAINT_DEPTH 32. Worth reading for the invariant list; do not implement a personal draft |
| **draft-oauth-ai-agents-on-behalf-of-user-02** (WSO2 authors, published 2025-08-26, **expired 2026-02-27**, individual submission) | **Expired draft** | **No** | Defines `requested_actor` at `/authorize` and `actor_token` at `/token`, access token with `sub` + `azp` + `act.sub`. The `act` claim is the reusable part and it is already RFC 8693. Do not cite an expired individual draft as a standard |
| **RFC 9396 Rich Authorization Requests** (May 2023, Standards Track) | Real RFC | **Defer, and it is the right escape hatch** | `authorization_details` with required `type` plus `locations`/`actions`/`datatypes`/`identifier`/`privileges`, advertised via `authorization_details_types_supported`. If flat scopes ever prove too coarse (e.g. "may claim tasks tagged `research` in room X only"), this is the standard way to get structure without inventing a token format |
| **RFC 9449 DPoP** (September 2023, Standards Track) | Real RFC, real IdP support | **Defer** | `cnf.jkt` in the token, proof JWT `typ: dpop+jwt` with `jti/htm/htu/iat/ath/nonce`, `WWW-Authenticate: DPoP error="invalid_dpop_proof", algs="ES256"`, `use_dpop_nonce`. The correct answer to stolen bearer tokens; needs client support the peer may not have |

### 8. Revocation, rotation, and the boring operational half

**Kicking a remote agent: mostly already built, with one real gap.** Spec 12.1 + [`src/store.ts`](../../../src/store.ts): `evict` removes membership with token revocation effective on the next call, frees the name under the rebind guard, bumps the epoch with a `roster {reason: "evict"}` event, resolves parked listens, drops watchers, and emits `gone_quiet` to anyone owed a reply. `quarantine` = evict plus refuse re-join. `release_member` on a quarantined identity requires a **human-origin** principal. That is a complete, tested kill path for a local agent.

**The gap:** quarantine is keyed on name and capability digest (`room.quarantinedNames` / `room.quarantinedDigests`, checked at [`src/store.ts:437-439`](../../../src/store.ts)). A remote org changes its agent's name or edits one character of a skill description and both keys change. Quarantining an identity that a stranger controls is theatre. Cross-org needs two more keys - the verified `provider.origin` and the card's signing `kid` - and, above both, removal of the org from `admit.orgs`, which is the only kill switch the peer cannot route around.

**Transport revocation.** With a real IdP: disable the client, and existing tokens die at `exp`. That makes access-token TTL the revocation SLA, so the spec should say a number: **remote-peer access tokens SHOULD live <= 15 minutes**. RFC 7009 token revocation exists (<https://www.rfc-editor.org/rfc/rfc7009.html>) but revoking a *client_credentials* access token is not the useful operation; disabling the client is. With static tokens the hub must own a denylist forever, which is failure mode 1 in §3. Web Bot Auth's directory model states the same tradeoff verbatim: "No revocation mechanism defined; removal from the directory is the only remedy."

**Key rotation without breaking live rooms.** Copy the two documented procedures, which agree:

- Web Bot Auth directory draft: add new keys to the directory before intended use; keep old keys until their `exp` passes; then remove. Cache against `Cache-Control` (`max-age=86400` recommended).
- Matrix: `verify_keys` for current, **`old_verify_keys` for verification only**, `valid_until_ts` per key, and never trust a `valid_until_ts` more than 7 days out.
- MCP Registry DNS: the operational footgun to avoid, verbatim: "a stale record left behind will be tried first and cause verification to fail."

And the non-obvious rule that must be normative or rotation is unperformable: **verifying a stored event uses the key that was valid at that event's `ts`, not the currently-published set.** Live rooms then rotate with zero coordination: the peer publishes the new key, the hub's cached directory expires within a day, new joins and new signatures use the new key, and everything already in the log keeps verifying against the old one.

Cache and safety requirements for the hub's directory fetcher, from the httpsig-protocol draft: bound response size, key count, timeout, redirects, and network ranges against SSRF; HTTPS only; and key lookups keyed on `(URL, keyid)` pairs rather than `keyid` alone - which matters because two orgs can publish the same `kid` string only if they publish the same key, but a naive global `kid -> key` map is a cross-org confusion bug waiting to happen. RFA's current `trustedKeys: Record<string, Jwk>` ([`src/store.ts:58`](../../../src/store.ts)) is exactly that naive global map, and it must become per-org.

### 9. Why the hash chain is not enough, and what per-message signing actually buys

**The chain, as built.** [`src/store.ts:408`](../../../src/store.ts): `room.chainHead = sha256hex(room.handle); // chain genesis = hash of the room handle`. [`src/store.ts:2135-2138`](../../../src/store.ts):

```js
private appendEvent(room: Room, partial: EventInput): RfaEvent {
  room.seq += 1;
  const event = { ...partial, seq: room.seq, ts: iso(this.cfg.now()), prev_hash: room.chainHead } as RfaEvent;
  room.chainHead = sha256hex(canonicalize(event as unknown as Record<string, unknown>));
```

Spec 13 claims "Tamper evidence for the whole log, verifiable offline."

**That claim holds against one adversary and fails against the one cross-org introduces.** It holds against anyone who edits `data/rooms/<room>.ndjson` without recomputing forward - a corrupted disk, a careless script, an intruder with file access but not process access. It fails completely against the hub operator, who knows the genesis (a public room handle), owns every event, and can recompute a consistent chain over a rewritten history in a loop. In a two-org room the hub operator **is a party to any dispute**. So today:

- Org A can fabricate a `room_send` or a `room_task complete` attributed to org B's agent, and the log will be internally consistent.
- Org B can deny anything it did send, and org A has only its own log to point at.
- Neither can prove the other wrong.

That is a new and real problem, because the premise says remote agents "must be able to CLAIM and COMPLETE tasks ... executing with THEIR OWN tools that the hub never sees and cannot audit directly". A completion with an evidence payload from an unauditable executor is exactly the artifact that gets disputed, and the current record cannot support the dispute.

**Per-message signing versus a signed transport session.** A signed session (TLS + OAuth, or a single RFC 9421-signed handshake) proves *at connection time* that the peer held a credential. Everything after that is attributable only by the hub's assertion that it received message X on connection Y. For an internal room that is fine - one operator, one log, no adversarial counterparty. For a cross-org room it is the whole problem: the hub's assertion is one party's word. Per-message (or per-request) signing is what converts "the hub says B said this" into "B said this". This is precisely why Matrix signs every event and every federation request rather than establishing a session, and why Web Bot Auth signs requests rather than issuing session tokens.

**Why you cannot sign the envelope, and what to sign instead.** From [`src/store.ts:822-841`](../../../src/store.ts) the envelope is assembled with `seq: 0, ts: ""` and filled in by `appendEvent`; `from` is stamped from the authenticated member; `prev_hash` is added at append; `task` is set to `null` by the hub. From [`src/store.ts:807-809`](../../../src/store.ts):

```js
const to = (args.to ?? []).map((ref) => this.resolveRef(room, member, ref).id);
let mentions = (args.mentions ?? []).map((ref) => this.resolveRef(room, member, ref).id);
if (mentions.length === 0 && to.length > 0) mentions = [...to]; // attention follows addressing
```

So `to`/`mentions` are rewritten (names to ids, and `mentions` defaulted). A sender signature over the final envelope is unverifiable, and a signature over the pre-normalization arguments does not match what is stored. The only workable construction is the **signed core** defined in the Verdict, with **id-only addressing required when signing** so normalization is the identity function, plus a hub check that the resolved refs equal the submitted ones.

**And the receipt, which is cheaper and buys more.** A sender signature proves what B said. It does not prove that A received it, accepted it at seq N, or did not silently drop it. A hub-signed receipt over `{room, seq, ts, message_id, from, prev_hash, chain_head}` returned from `room_send` gives B a portable artifact stating exactly that. Combine with periodic signed `chain_checkpoint` events that every member can store, and a rewritten prefix becomes detectable by any member who kept one checkpoint. This is the cheap, single-party-hostile version of Matrix's property that every participating server holds the events. Implementation cost is small precisely because [`src/signing.ts`](../../../src/signing.ts) already does JWS-over-JCS with EdDSA/ES256 and thumbprint kids; the hub needs a key file and one new result field.

**Order of work, if only one ships:** the receipt. It is smaller, it needs no client-side crypto at all (the peer just stores an opaque blob), and it fixes the asymmetry where only the hub operator holds evidence.

### 10. The audit record a two-org dispute actually needs

Enumerated, because "the log is the audit trail" (spec 13) is not specific enough once the reader is another company's lawyer.

**Per message/task event, the record must carry:**

| Field | State today | Needed |
|---|---|---|
| `seq`, `ts`, `prev_hash` | present | keep |
| `from.{id, name, origin}` | present, hub-stamped | keep |
| `from.org` (verified domain) | **missing** | add; this is what names the counterparty |
| `from.kid` (key that verified the card) | **missing** | add; ties the message to a specific key, so a rotation or compromise window is bounded |
| `from.client_id` / `sub` (transport principal) | **missing** | add; independent of membership, survives eviction |
| `on_behalf_of` (from the token's `act.sub`) | **missing** | add when present |
| sender signature over the signed core | **missing** (reserved v0.2) | add (rec. 13) |
| hub receipt handed to the sender | **missing** | add (rec. 14) |
| `task` linkage (`task_id`, `parent_id`, `depth`, `context`) | `parent_id` present; `depth`/`context` missing | add (rec. 17) |
| evidence + verifier verdict for remote completions | present but per-task opt-in | force on for remote owners (rec. 29) |
| intervention `{verb, actor, target, reason, refs}` | present | keep |

**Per admission, a record that does not exist at all today.** The join event says a member joined; it does not say why the hub believed them. Add:

```jsonc
{ "type": "system", "event": "admitted", "seq": 41, "ts": "...", "prev_hash": "...",
  "refs": { "member": "m_7f3ka9", "org": "b.example",
            "keys_url": "https://b.example/.well-known/http-message-signatures-directory",
            "kid": "NFcWBst6DXG-N35nHdzMrioWntdzNZghQSkjHNMMSjw",
            "method": "directory",
            "card_digest": "sha256:xB4k...",
            "transport": { "iss": "https://idp.a.example/realms/agents", "client_id": "rfa-peer-b-prod", "scopes": ["rfa:room.read","rfa:task.claim","rfa:task.complete"] },
            "admitted_by": "human:paul@a.example", "approval_request_id": "join:m_7f3ka9" } }
```

This single event is what turns "we let them in" into "we let them in on this basis, on this date, on this human's authority, with these scopes". It is a two-hour change and it is the highest-value item in this whole section.

### 11. Draft spec text

Suggested edits, written to be pasted and then argued with.

**Replace the 4.2 tier table:**

| Tier | Mechanism | Normative status | Intended span |
|---|---|---|---|
| T0 | Join secret (capability token in `room_join`) + membership token thereafter | MUST implement | Same team / trusted cluster |
| T1 | Transport credential bound to this hub, validated by the hub as an OAuth 2.1 **resource server** (RFC 9728 metadata + audience validation), OR an RFC 9421 signed request whose key resolves from the peer org's key directory. Verb scopes per 4.4 | SHOULD implement for any room with a member from another organization | Cross-team, cross-org |
| T2 | Org-anchored card signatures (JWS over JCS, key resolved from the peer org's directory) + signed core on `room_send` / `room_task` + hub receipts | Card signing MUST for remote members; message signing SHOULD | Cross-organization with disputes on the table |

**New 4.3 Transport credentials (T1).**

> A hub MUST NOT act as an OAuth authorization server. A hub that supports T1 MUST publish OAuth 2.0 Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource`, listing its canonical URI in `resource`, the issuer identifiers it accepts in `authorization_servers`, and its verb scopes in `scopes_supported`. A request without a usable credential MUST receive `401` with `WWW-Authenticate: Bearer resource_metadata="..."` and SHOULD carry a `scope` parameter naming the scopes required for the attempted operation.
>
> For every presented access token the hub MUST verify: the signature against the issuer's published key set; `iss` equal by exact string comparison to a configured issuer; that the audience includes the hub's canonical URI; `exp` and, if present, `nbf`; that `alg` is in a closed allowlist that never includes `none`; and that the token's `client_id` (or `azp`, or `sub` for a client credential) is registered to an admitted organization (4.5). The hub MUST NOT require the RFC 8707 `resource` parameter to have been used, since authorization servers that reject it exist; the audience claim is the normative requirement. The hub MUST NOT forward a peer's token to any upstream service.
>
> Access tokens for members of another organization SHOULD have a lifetime of 15 minutes or less; the token lifetime is the revocation latency.
>
> If the token carries an `act` claim (RFC 8693 section 4.1), the hub MUST record `act.sub` in the member's audit record and MAY surface it as `from.on_behalf_of`. A hub MUST NOT implement RFC 8693 token exchange; issuing delegated tokens is the authorization server's role.
>
> **4.3.2 Signed-request credential.** A hub MAY accept, in place of a bearer token, an RFC 9421 HTTP Message Signature covering at least `@authority` (or `@target-uri`) and the `Signature-Agent` header, with signature parameters `created`, `expires` (24 hours maximum), `nonce` (>= 64 random bytes, unique within the validity window), `keyid` equal to the base64url RFC 7638 thumbprint of the signing key, `alg` from the HTTP Signature Algorithms registry excluding all MAC algorithms, and `tag="rfa"`. The hub MUST resolve keys by `(directory URL, keyid)` pair from the admitted organization's key directory, never by `keyid` alone.

**New 4.4 Scopes.** (the table from the Verdict, plus:)

> Scope and role compose as most restrictive wins. A scope never grants authority a role withholds, and a role never grants authority a scope withholds. `origin: "human"` remains orthogonal and unreachable through any agent credential.
>
> On a scope miss the hub MUST return `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<required>", resource_metadata="<url>"`, and MUST return all scopes required for the attempted operation in a single challenge. Hubs MUST account for scope hierarchies where a broader scope implies narrower ones. Error code: `insufficient_scope`.

**New 4.5 Organizations and admission.**

> A hub is provisioned out of band with a set of admitted organizations, each keyed by a DNS domain and carrying: a key directory URL, the set of transport principals (`client_id` values, or `keyid` values for 4.3.2) permitted to act as that organization, and the identity of the human who admitted it. This set is the hub's trust root. Hubs MUST NOT derive trust in an organization from a registry, a directory service, a transitive endorsement, or the content of a card.
>
> Room policies gain `admit`: `{orgs: [domain...], require_signed_cards: bool, allow_embedded_jwk: bool}`. `allow_embedded_jwk` MUST default to `false` for members of another organization: an embedded key proves integrity and key binding only, never external identity (6.1).
>
> A join by a principal that maps to an admitted organization MUST additionally satisfy: the card carries at least one signature that verifies against a key from that organization's directory; the signature's `kid` equals the RFC 7638 thumbprint of that key; and `card.provider.origin` equals the organization's domain. Failure is `join_denied` with a machine-readable reason, never a silent downgrade to unverified membership.
>
> A join by a principal that maps to no admitted organization MUST be refused, unless `policies.join` is `"approve"`, in which case the hub MUST register it as an approval request whose decision requires a human-origin principal, and MUST present the requested name, the card digest, the claimed `provider.origin`, the signing `kid` with its resolution method, and the requested scopes to the decider.
>
> On success the hub MUST append `system {event: "admitted", refs: {...}}` recording the organization, directory URL, `kid`, resolution method, card digest, transport issuer, transport principal, granted scopes, and the admitting human.
>
> Revocation of an organization (removal from the admitted set) MUST take effect on the next call for every member mapped to it, MUST evict those memberships, and MUST be audited as an intervention. Quarantine for a remote member MUST be keyed on the organization domain and the card signing `kid` in addition to name and capability digest.

**New 8.x Signed core.** (the field list and the id-only rule from the Verdict, plus:)

> A signed send whose signature is present but does not verify MUST be refused with `signature_invalid`; the message MUST NOT be appended. A signed send whose resolved `to`/`mentions` differ from the submitted values MUST be refused with `signature_mismatch`. A verified signature is surfaced as `signed: true` on the stored event; `false` means present-and-invalid was refused and is never stored; absent means unsigned. `policies.require_signed_messages` takes `off` (default), `remote` (members of another organization must sign), or `all`.
>
> Verification of a stored event MUST resolve the signing key valid at that event's `ts`, not the currently published key set. Hubs MUST retain superseded keys for the room's retention window.

**New 9.1 result field and 13 audit addition.** (receipt + `chain_checkpoint`, per the Verdict.)

**Errors to add to section 15:** `insufficient_scope`, `invalid_token`, `org_not_admitted`, `signature_invalid`, `signature_mismatch`, `key_unresolved`.

**New conformance profile in section 16:**

| Profile | Requires |
|---|---|
| **remote** | core + 4.3 transport credential validation (bearer or signed request) + 4.4 scopes with the `insufficient_scope` challenge + 4.5 organizations, admission and the `admitted` audit event + 6.1 directory key resolution + org/kid-keyed quarantine + hub receipts (9.1) |

**Appendix D edits:** replace "per-message signature profile and hash-chain audit fields" with "sender-signed core (a defined sender-controlled subset, never the full envelope) and hub receipts"; add to the passthrough line "the hub MUST obtain its own upstream credential and MUST NOT forward a peer's token"; record against the MLS line that group encryption is incompatible with the pre-delivery policy gate (12.2) and is therefore rejected rather than deferred.

---

## What RFA already solves (do not redesign)

1. **JWS-over-JCS signing and verification, correctly.** [`src/signing.ts`](../../../src/signing.ts) does detached-style JWS over the RFC 8785 canonical form with `signatures` excluded ([`src/signing.ts:72-76`](../../../src/signing.ts)), a closed `alg` allowlist of `EdDSA` and `ES256` with no `none` ([`src/signing.ts:105`](../../../src/signing.ts)), and the kid-must-equal-thumbprint rule that closes the substituted-key hole ([`src/signing.ts:138-146`](../../../src/signing.ts)). [`src/jcs.ts`](../../../src/jcs.ts) is a correct JCS subset with an explicit note on why `JSON.stringify` plus key sorting is canonical for this JSON subset. **The signed core and the hub receipt both reuse this file unchanged.** This is the single biggest reason the T2 unpark is cheap.
2. **The tri-state `card_verified` and per-signature detail.** [`spec/RFA-0.1.md:181`](../../../spec/RFA-0.1.md) and [`src/signing.ts:92-103`](../../../src/signing.ts): `null` unsigned, `true` at least one verifies, `false` present-but-none-verifies. `agent_describe` exposes `{kid, alg, method, ok}` per signature. Adding `method: "directory"` is a one-line extension of an already correct design. A2A 1.0 has no equivalent surfaced verification state.
3. **`require_signed_cards` enforcement at join AND at card rotation.** [`src/store.ts:483`](../../../src/store.ts) and [`src/store.ts:648`](../../../src/store.ts), wired to `--require-signed` at [`src/main.ts:45`](../../../src/main.ts), with a provisioned key path at `--trusted-keys` ([`src/main.ts:39-44`](../../../src/main.ts)) and a regression test ([`test/hub.test.ts:556`](../../../test/hub.test.ts)) that exercises strict mode with `allowEmbeddedJwk: false`. Covering rotation as well as join is a detail most designs miss.
4. **Origin stamping is unforgeable by construction.** [`src/store.ts:464-470`](../../../src/store.ts): `resolveOrigin` returns `agent` for no key, throws `join_denied` for a wrong key, and `human` only for a provisioned one. `role: supervisor` at join requires human origin ([`src/store.ts:443-446`](../../../src/store.ts)). Approval satisfaction requires human origin (spec 12.1). Nothing in the cross-org design touches this and nothing should.
5. **Capability binding by `(member_id, digest)` and never by name.** Spec 14.4 plus the `digest_changed` / `name_rebound` errors. This is exactly right for remote peers whose cards will change without warning, and it needs no change.
6. **Eviction that actually revokes.** Spec 12.1 / 14.8 and the tested behaviour: token revocation on the next call, epoch bump, parked listens resolved, watchers dropped, `gone_quiet` to anyone owed a reply. The cross-org gap is *what you key the ban on*, not the mechanism.
7. **The evidence gate is already the right answer to unauditable remote execution.** Spec 10.2: `evidence_required` makes `complete` carry `{summary, artifacts[]}` and set `verification.pending`, and a verifier whose member id differs from the owner must `accept`. AIP's completion blocks are a cryptographic version of the same idea with a worse trust model (self-reported, as its own paper admits). Do not build completion blocks; make the existing gate mandatory for remote owners.
8. **The pre-delivery policy gate is the composition point for org-specific rules.** Spec 12.2, implemented: rules and command tiers, most-severe-wins, fail-closed-to-hold, human-only release of holds. Everything an operator wants to do about a hostile peer's *content* composes here without protocol change. It is also the reason MLS is rejected rather than deferred.
9. **Rate budgets and blast-radius caps are already normative and implemented.** Spec 9.1 plus `member_rpm` / `max_pending_requests` (0.1.7). A hostile-or-incompetent remote peer is exactly what these were for.
10. **`instructions` + the untrusted-content boundary.** Spec 14.3 and the client SDK's data-boundary wrapping. Card text from an unknown org is exactly the injection vector this addresses, and the `description <= 1024` cap (spec 6.1) already bounds it.

**Where RFA is genuinely wrong for cross-org use, bluntly:**

- [`spec/RFA-0.1.md:92`](../../../spec/RFA-0.1.md), the T1 row: names a draft optional MCP extension and an authorization-server grant type as things a hub should implement. Neither is implementable by a resource server. Rewrite.
- [`src/main.ts:300-345`](../../../src/main.ts): `/mcp` has **no transport authentication at all**. `originAllowed` is a DNS-rebinding defence and `authed()` guards only `/auth` and `/api/*`. The only credential protecting a room is the join secret. For a single operator on loopback that was defensible; with a peer org it means the transport principal does not exist, so `from.org` cannot be derived and every claim in this document about audit records is unsatisfiable until a token check exists in front of the MCP handler. **This is the first thing to build.**
- [`src/store.ts:58`](../../../src/store.ts): `trustedKeys: Record<string, Jwk>` is a global `kid -> key` map with no notion of which organization a key belongs to. It must become per-org, and lookups must be keyed on `(org or directory URL, kid)`.
- [`src/store.ts:437-439`](../../../src/store.ts): quarantine keyed on name and digest, both freely changeable by the peer.
- [`spec/RFA-0.1.md:157`](../../../spec/RFA-0.1.md): `provider.organization` is unverified free text in the card, shown to models. Either verify a domain or stop treating it as identity.
- Spec 13's hash-chain claim ("Tamper evidence for the whole log") is true against a third party and false against the hub operator, which is the adversary cross-org introduces. The sentence needs a scope qualifier and a pointer to receipts and checkpoints.
- Spec 5.1's `policies.join: "approve"` is specified and unimplemented (STATUS "Known limitations"). It is the natural human-review admission path and it now has a consumer.

---

## Open questions and spikes

Each spike is chosen to be decisive and small, and each recommendation carries what would change my mind.

**S1. Transport auth in front of `/mcp` (2-3 h). The blocking prerequisite.**
Add a check before the MCP handler in [`src/main.ts`](../../../src/main.ts): accept either a static scoped token from `data/secrets.json` (pilot mode) or a JWT validated against a configured issuer's JWKS. Serve `/.well-known/oauth-protected-resource`. Return the spec-shaped 401 with `resource_metadata`. Acceptance: an unauthenticated `POST /mcp` gets 401 with a `WWW-Authenticate` header naming the metadata URL; a token with the wrong `aud` gets 401; a valid token reaches `room_join`. **Until this exists, nothing else in this dimension can be built.**

**S2. The IdP acceptance test (half a day). Settles the RFC 8707 question empirically for whatever IdP the org has.**
Stand up one candidate (Keycloak is the likeliest self-hosted choice). Create a client for a fake peer. Request a `client_credentials` token with `scope=rfa:room.read rfa:task.claim` and, separately, with `resource=<hub canonical URI>`. Decode both. Record: does `aud` contain the hub URI; does the `resource` parameter error or get ignored; do scopes survive into the token; what is the minimum TTL. **What would change my mind about rec. 4:** if no IdP the org has can put the hub's URI in `aud` for a client-credentials token, then rec. 8 (RFC 9421 signed requests) is promoted from second option to first, because it needs no IdP at all.

**S3. Domain-anchored card verification (1 day). The core of the design.**
Generate an Ed25519 key, publish a JWKS at a test origin in the Web Bot Auth directory shape (with `nbf`/`exp`), sign a card with `kid` = thumbprint and `provider.origin` = that origin, and add a `directory` resolution path to `verifyCard`. Acceptance: verification succeeds via the directory; succeeds after adding a second key and re-signing with it; **still verifies a card signed with the first key while the first key remains in the directory with an unexpired `exp`**; fails when `provider.origin` does not match the directory host; fails when the directory is served over plain HTTP. The third case is the rotation property and is the one most likely to be got wrong.

**S4. The receipt (half a day). Highest value per line in the whole dimension.**
Give the hub a signing key. Return `receipt` from `room_send` and `room_task`. Write a 30-line verifier script that takes a receipt plus the room ndjson and reports agree/disagree. Acceptance: the verifier accepts a real receipt, and rejects one after a single byte is edited in the corresponding log line. **What would change my mind:** nothing plausible. This is strictly additive, needs no peer cooperation, and no other mechanism gives the peer a portable artifact.

**S5. Signed core round-trip (1 day).**
Sign a `room_send` core client-side in [`src/client.ts`](../../../src/client.ts), verify hub-side, store `signed: true`. Acceptance: a signature over id-addressed `to`/`mentions` verifies against the stored envelope byte-for-byte; a signature over name-addressed refs is refused with `signature_mismatch`; a tampered `body` is refused with `signature_invalid` and **nothing is appended**. **What would change my mind about rec. 13:** if the round-trip cannot be made to verify against the stored envelope without freezing more hub behaviour than the id-only rule, then drop sender signing entirely and keep only receipts plus checkpoints - the receipt already covers the direction that matters most (proving what the hub did), and a half-working signature scheme is worse than none.

**S6. Scope enforcement mapping (half a day).**
Table-drive tool name plus action to required scope; return the 403 challenge. Acceptance: a token with `rfa:room.read` alone can `room_join`, `room_roster`, `room_listen` and `room_task list`, and is refused on `room_send`, `room_task claim` and `room_admin`, each with the correct single-challenge `scope` value.

**S7. `join: "approve"` for an unknown org (1 day).**
Route a join from a non-admitted org into the existing approval machinery, rendering the card, org claim, kid and resolution method in the console Inbox. Acceptance: an unknown org's join blocks; a human approve admits it and writes the `admitted` event; a reject writes `join_denied` and the attempt is audited.

**Open questions, honestly unresolved:**

1. **Does the remote peer speak MCP at all?** A LangGraph process joining a room over MCP is a real integration tax, and both viable identity mechanisms attach to HTTP rather than to MCP. If the answer is "remote peers use REST", the REST binding stops being a nice-to-have and becomes the primary remote surface, and T1 must be specified against HTTP rather than against "the MCP transport". Another dimension owns the binding; this dimension's evidence says the binding is what identity should attach to.
2. **Who runs the IdP in the two-org pilot?** Rec. 4 assumes the hub operator does, because that is the shape every IdP supports. If the peer org refuses to hold a credential issued by the hub operator (a plausible procurement objection), the fallback is rec. 8, and that changes the build order. Ask before building.
3. **What is the hub's canonical URI once a proxy is in front of it?** RFC 8707/9728 audience validation compares against a URI, and wave 03's answer to reach is `tailscale serve` (or Cloudflare Tunnel later), which may rewrite `Host`. The canonical URI must be configuration, not derived from `req.headers.host`, or audience validation breaks the first time the topology changes. Small, but it will bite.
4. **How many scopes before the flat list stops working?** RFC 9396 `authorization_details` is the escape hatch for "may claim tasks tagged `research` in room X only". Do not pre-build it; revisit if the scope list passes ~12 entries or if anyone asks for per-room scoping beyond a `room` claim.
5. **Does the peer's card key equal the peer's transport key?** Cleaner if yes (one directory, one key, one rotation), but an org whose transport is OAuth (key in the IdP) and whose cards are signed by an agent process (key on that host) will have two. The design must permit two keys per org and must audit which one verified what. UNVERIFIED which shape peers will actually present; assume two.
6. **Clock skew between orgs.** `expires`, `nbf`, `signed_at` and the key-valid-at-`ts` rule all depend on clocks that two organizations do not synchronize. The attenuating-tokens draft recommends 30 s of `iat` skew tolerance; RFA should pick a number and write it down rather than discover it in a rotation.

---

## Source list

Primary specifications and RFCs: MCP 2026-07-28 authorization <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> · client registration <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration> · security considerations <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations> · changelog <https://modelcontextprotocol.io/specification/2026-07-28/changelog> · ext-auth repo <https://github.com/modelcontextprotocol/ext-auth> with `specification/draft/oauth-client-credentials.mdx` and `specification/stable/enterprise-managed-authorization.mdx` · RFC 8693 <https://www.rfc-editor.org/rfc/rfc8693.html> · RFC 9728 <https://www.rfc-editor.org/rfc/rfc9728.html> · RFC 9421 <https://www.rfc-editor.org/rfc/rfc9421.html> · RFC 9449 <https://www.rfc-editor.org/rfc/rfc9449.html> · RFC 9396 <https://www.rfc-editor.org/rfc/rfc9396.html> · RFC 9635 <https://datatracker.ietf.org/doc/html/rfc9635> · RFC 7009 <https://www.rfc-editor.org/rfc/rfc7009.html> · A2A 1.0 <https://github.com/a2aproject/A2A/blob/main/docs/specification.md> and <https://a2a-protocol.org/v1.0.0/specification/> · Matrix server-server API <https://spec.matrix.org/latest/server-server-api/>.

IETF drafts and WG: webbotauth WG <https://datatracker.ietf.org/wg/webbotauth/about/>, documents <https://datatracker.ietf.org/wg/webbotauth/documents/>, formation announcement <http://www.mail-archive.com/ietf-announce@ietf.org/msg26115.html> · `draft-meunier-webbotauth-httpsig-protocol-01` <https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-httpsig-protocol-01> · `draft-meunier-webbotauth-httpsig-directory-00` <https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-httpsig-directory-00> · `draft-meunier-webbotauth-registry-03` <https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-registry-03> · `draft-meunier-web-bot-auth-architecture-05` (Replaced) <https://datatracker.ietf.org/doc/html/draft-meunier-web-bot-auth-architecture-05> · `draft-niyikiza-oauth-attenuating-agent-tokens-00` <https://datatracker.ietf.org/doc/html/draft-niyikiza-oauth-attenuating-agent-tokens-00> · `draft-oauth-ai-agents-on-behalf-of-user-02` (expired) <https://datatracker.ietf.org/doc/html/draft-oauth-ai-agents-on-behalf-of-user-02> · `draft-klrc-aiagent-auth` <https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/> · `draft-ni-wimse-ai-agent-identity-02` <https://datatracker.ietf.org/doc/html/draft-ni-wimse-ai-agent-identity-02>.

Capability tokens: AIP paper `research/01-protocol/papers/aip-agent-identity-protocol.pdf` (arXiv:2603.24775v1, 2026-03-25) · Biscuit <https://github.com/eclipse-biscuit/biscuit/blob/main/SPECIFICATIONS.md> · UCAN Delegation 1.0.0 <https://github.com/ucan-wg/delegation> · Macaroons NDSS 2014 <https://research.google.com/pubs/archive/41892.pdf> · SPIFFE/SPIRE CNCF graduation <https://www.cncf.io/announcements/2022/09/20/spiffe-and-spire-projects-graduate-from-cloud-native-computing-foundation-incubator/>.

Product documentation (authoritative for "does X implement Y"): Keycloak MCP authorization server <https://www.keycloak.org/securing-apps/mcp-authz-server> · Zitadel token exchange <https://zitadel.com/docs/guides/integrate/token-exchange> · Auth0 resource parameter compatibility profile <https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile> · Ory Hydra audience issue <https://github.com/ory/hydra/issues/3441> · Google Web Bot Auth <https://developers.google.com/crawling/docs/crawlers-fetchers/web-bot-auth> · MCP Registry publishing authentication <https://github.com/modelcontextprotocol/registry> (`docs/modelcontextprotocol-io/authentication.mdx`).

Repo: [`spec/RFA-0.1.md`](../../../spec/RFA-0.1.md) · [`spec/RFA-0.4-platform.md`](../../../spec/RFA-0.4-platform.md) · [`src/store.ts`](../../../src/store.ts) · [`src/signing.ts`](../../../src/signing.ts) · [`src/jcs.ts`](../../../src/jcs.ts) · [`src/main.ts`](../../../src/main.ts) · [`src/client.ts`](../../../src/client.ts) · [`test/hub.test.ts`](../../../test/hub.test.ts) · [`STATUS.md`](../../../STATUS.md) · [`research/03-reach-and-collaboration/notes/01-remote-reach.md`](../../03-reach-and-collaboration/notes/01-remote-reach.md).
