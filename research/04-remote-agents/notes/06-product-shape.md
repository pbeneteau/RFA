# Wave 04 / Dimension 06: Local vs remote as a first-class distinction, and what the tool becomes

Research date: 2026-08-17. Repo state at time of writing: protocol spec 0.1.7, platform spec 0.4.0, hub v0.6.0, 85 tests.
Premise honored: RFA is a tool ANY organization can self-host; rooms must carry LOCAL agents (agent.md packs, locally supervised) and REMOTE agents (another framework, another product, another org's cloud) that can claim and complete real task-board work with tools the hub never sees.

---

## Verdict

**The distinction is real, and it is not "local vs remote". It is two independent facts that every comparable system eventually had to name separately, and that collapsing into one boolean has already burned Slack once.**

1. **Accountability**: which organization answers for this member. (Matrix puts it in the identifier; Slack needed `is_ext_shared` AND `is_org_shared`; Teams shows External-Familiar vs External-Unfamiliar vs Guest vs Unverified.)
2. **Supervisability**: whether the hub operator can restart, inspect, or drain the process. (GitHub: self-hosted vs GitHub-hosted; JFrog: local vs remote; A2A calls the far side "opaque".)

A remote LangChain agent belonging to your own org is accountable-local and unsupervisable. A resident pack you run for a partner is accountable-other and supervisable. One boolean cannot express either case honestly, and the roster is exactly where an operator and a model both read it. So: **add ONE field with two derivable labels, not a second class of member.**

**The smallest protocol-visible difference set (six items, all additive, no fork of the model):**

| # | Change | Where |
|---|---|---|
| 1 | `home` on the member/presence record: an opaque operator-assigned org label, `"local"` for the hub's own org. Hub-derived at admission, never client-supplied (same rule as `origin`). | spec 7.1 presence record, `src/model.ts:69-85` |
| 2 | `from.home` on the envelope (so it is auditable, gate-matchable, and visible in the client's untrusted-content boundary). | spec 8, `src/model.ts:49`, `src/client.ts:454` |
| 3 | Per-peer **admission records** replacing the one-per-room join secret: `{home, name, pinned JWK thumbprint, scopes[], expires_at, admitted_by}` minted by a human-origin `room_admin invite`, single-use, individually revocable. | spec 4.2 (a T0.5 rung), `src/store.ts:384`, `src/store.ts:433-434` |
| 4 | Quarantine keys on the **pinned thumbprint**, not name+digest (a remote peer controls both of those). | `src/store.ts:212-213`, `src/store.ts:437-439` |
| 5 | Evidence-gate rule: when a task's owner is not `home: "local"` and `evidence_required` is set, the verifier MUST be a `home: "local"` member or human-origin principal. | spec 10.2 |
| 6 | Four room-policy fields, all default-off: `guests: "none" \| "invited"`, `guest_card: "signed" \| "any"`, `guest_lease_max_s`, `guest_task_verbs: ["claim","update","complete"]`. | spec 5.1 |

Everything else the premise seems to demand (a fourth role, a separate roster section, a different presence contract, per-message signatures, cross-hub federation, a registry) is either already solved or is ceremony. Detail and evidence below.

**What the product is.** Not "agent rooms with capability discovery, presence and moderation" - that is a mechanism list, and every mechanism in it now has a bigger owner (A2A owns cards, MCP owns auth and transport, Anthropic owns local agent-to-agent messaging). The product is: **the auditable shared room where agents from more than one organization do work, on your hub, on your log, with a human able to stop it.** That sentence is the only part of the space nobody credible is building as of 2026-08-17.

### Recommendations

| # | Recommendation | Verdict | Rationale (evidence) | Effort | Spec impact |
|---|---|---|---|---|---|
| R1 | Add `home` to the member record + presence record + envelope `from`; hub-derived, never client-set. Two derived labels for humans: `local` / `guest`. | adopt | Matrix bakes the origin into the user id (`@localpart:domain`, "the domain of a user ID is the server name of the homeserver which allocated the account"); Slack shipped a boolean `is_shared` and had to add `is_ext_shared` + `is_org_shared` because internal-federation and external-federation are different facts; Teams badges appear "wherever people's names appear". | S (1 field, 3 shapes, one client-boundary attribute) | spec 4.1, 7.1, 8; `src/model.ts`; `src/client.ts:454` |
| R2 | Do NOT add a fourth role. A guest is a `participant` or `observer`; differences ride on the admission record's `scopes[]` + the policy gate. | reject (new role) | RFA's authority matrix is already role x origin x host-flag x held-flag; a fourth role multiplies it. Teams/Slack model the external fact as a *label plus policy*, never as a new permission role. | zero | none |
| R3 | Do NOT add a separate roster section. Keep the full-snapshot roster; group by `home` in the console only. | reject | `roster` events are deliberately full snapshots ("ordering-bug-proof", spec 9.4); two sections means two client code paths for the same list. JFrog's virtual repository is the precedent: one resolution namespace aggregating local + remote, the distinction carried per-item. | zero | none (console only) |
| R4 | Replace the single per-room `join_secret` with per-peer admission records (invite codes) bound to a pinned key thumbprint, revocable one at a time. | adopt | `src/store.ts:384` mints ONE secret per room; `src/store.ts:433` compares it by equality. One leak = full room access for anyone, no attribution, and revocation means rotating for every member. GitHub's self-hosted-runner guidance is the same lesson in another domain: the fix for an untrusted-code boundary is a per-repo allowlist plus ephemerality, not a shared token. | M (~1 day: store + 2 tools + tests) | spec 4.2 (new T0.5 rung), 5.1, `room_admin invite` verb |
| R5 | Keep card verification as the guest identity primitive; make `require_signed_cards` per-class (`guest_card: "signed"`), and let the admission record carry the trusted JWK/thumbprint. | adapt | The T2 card half is SHIPPED (`src/signing.ts:107`, `src/store.ts:2096`, spec 6.1: trusted key sets `kid -> public JWK`, embedded `jwk` MUST equal its RFC 7638 thumbprint). A2A's `AgentCardSignature` is `protected` / `signature` / `header` over RFC 8785 JCS per RFC 7515 - byte-compatible with RFA's `signatures[]`. Nothing to invent. | S | spec 5.1, 6.1 |
| R6 | Key quarantine on the pinned thumbprint, not name + digest. | adopt | `src/store.ts:437-439` refuses re-join on `quarantinedNames.has(name) \|\| quarantinedDigests.has(digest)`. A remote peer chooses its own name and its own card, so it evades both by editing either. This is a cross-org correctness bug, not a hardening nicety. | S (one Set, one check) | spec 12.1 (`quarantine`) |
| R7 | Evidence gate: a non-local owner's `complete` on an `evidence_required` task MUST be verified by a local or human principal. | adopt | This is the only mechanism that makes "remote agents do real work with tools we cannot audit" tractable: you cannot audit their tools, so you audit their output. The machinery exists (`src/store.ts:1701-1712`, verifier != owner already enforced); only the eligibility predicate is new. | S | spec 10.2 |
| R8 | Make `from.home` a first-class gate match key; ship two default guest rules in `deploy/gate.json` (hold guest `file` parts; alert on guest messages containing local file paths). | adopt | The gate already receives the whole envelope as context (spec 12.2), so adding `home` to the envelope makes it matchable for free. Claude Code independently landed the same shape: `crossSessionInbound` = `accept` \| `hold` \| `refuse` per inbound peer, plus an auto-mode classifier that "reviews each message before Claude Code delivers it". | S | spec 12.2 (context field), gate config |
| R9 | Normative REST binding in 0.2. | **unpark -> adopt** | Parked when the only clients were MCP-speaking residents. A LangGraph/LangChain agent in another org is a Python process; requiring it to be an MCP client to join a room is the single biggest adoption barrier under the new premise. Cost just fell: MCP 2026-07-28 removed sessions and the initialize handshake and routes by `Mcp-Method`/`Mcp-Name` headers, so the MCP surface is now near-REST anyway. | M (spec text + thin router over existing handlers) | spec 11.4 promoted from informative to normative |
| R10 | Python client: sample only, not an SDK. | adapt | With R9, a joining guest needs ~100 lines of `requests` plus the join contract's `instructions` string. An SDK is a maintenance surface for a population you do not control. | S | none |
| R11 | Per-message signatures. | defer (spec the field, do not implement) | The genuine new argument: with a remote org in the room, the hub operator is a *party*, so the hash chain (0.1.7) proves nobody tampered *after* append but not that the operator did not forge an append. Real, and still not worth code until a peer asks. Reserve `ext[".../sig"]` = detached JWS over the JCS envelope minus `sig`, verified with the same `verifyCard` path. Trigger: a peer whose contract requires non-repudiation against the hub. | S to spec, M to build | spec 8 (reserved `ext` key), 14.1 note |
| R12 | Cross-hub federation. | reject (keep reserved) | The premise needs remote MEMBERS, not remote HUBS: a guest joins your hub as a client, exactly as an external Slack Connect member appears in your channel. Federation costs two seq/epoch authorities plus ACL sync, and Matrix's shipped version has documented structural failures (a server ACLed out of a room cannot leave it; ACLs ignore DNS hierarchy; single-event size limits). KEP-1645's clusterset explicitly assumes "a high degree of mutual trust and shared ownership" - the inverse of this premise. Keep `search_id`/`max_depth`/`scope` reserved. | zero | Appendix D unchanged |
| R13 | Tool passthrough under a namespace. | reject (harder than before) | The premise says the guest executes "with THEIR OWN tools that the hub never sees". Passthrough would make the hub a confused deputy on another org's tool surface and an egress path through your own process. A2A's design principle 1.2 is explicitly "opaque execution": agents collaborate "without needing to share their internal thoughts, plans, or tool implementations". The client-side projection rule (spec 6.3.3) already covers the useful 90%. | zero | Appendix D: mark rejected, not deferred |
| R14 | Group encryption (MLS). | reject | Incompatible with every shipped safety control: the gate must read bodies, the hub must stamp origin and hash-chain, moderation must hold and inject. And the operator is a party to the room, so encrypting from the operator is incoherent. | zero | Appendix D: mark rejected |
| R15 | Registry / directory publication (ANS, NANDA, AGNTCY dir). | defer (now evidence-backed, not assumed) | Traction measured 2026-08-17 via the GitHub API: `kenhuangus/ANS` 4 stars, last push 2025-06-21; NANDA index has only 0-star third-party prototypes; `agntcy/dir` 175 stars; `agntcy/identity` 99 stars, last push 2026-02-24. The registry with real traction, `modelcontextprotocol/registry` (7,160 stars), publishes SERVERS, not agents. For N < 20 peers, one pinned HTTPS card URL per peer *is* the directory. | zero | Appendix D unchanged |
| R16 | Publishable agent manifest: adopt A2A's `https://{server_domain}/.well-known/agent-card.json` as the guest manifest; define an RFA *binding*, not a format. | adopt | A2A spec 1.0.0 section 8.2 gives the exact path; 8.4.2 gives the JWS shape (`protected`/`signature`/`header`, RFC 7515, canonicalized with RFC 8785 JCS). RFA cards are already declared A2A-subset-compatible (spec 6.1). Inventing a second manifest buys nothing and costs the compatibility claim. | S (spec text + a fetch-and-pin path at admission) | spec 6.1 (new subsection: card-URL admission), 11.3 |
| R17 | T1 OAuth: when it happens, implement the **official MCP Client Credentials extension**, do not design it. And accept only hub-issued tokens. | adapt | MCP 2026-07-28 authorization is normative and blunt: "MCP clients **MUST NOT** send tokens to the MCP server other than ones issued by the MCP server's authorization server", "MCP servers **MUST** only accept tokens that are valid for use with their own resources", "MCP servers **MUST NOT** accept or transit any other tokens." So "the guest authenticates with its own org's IdP token" is *forbidden* by the transport spec: the hub must be (or delegate to) its own AS. There is now an official extension for machine-to-machine (`ext-auth/specification/draft/oauth-client-credentials.mdx`, JWT client assertion RECOMMENDED per RFC 7523). | M when triggered | spec 4.2 T1 row: point at the MCP extension |
| R18 | Guest identity = a fetchable HTTPS URL, pinned. Credential = hub-issued. | adopt (this is the whole cross-org model) | This is exactly MCP's own direction: Dynamic Client Registration is **deprecated** in favor of Client ID Metadata Documents, where `client_id` is an HTTPS URL with a path, the server fetches it, "MUST validate that the fetched document's `client_id` matches the URL exactly", caches per HTTP headers, and the resulting identity is "portable across authorization servers, since they are self-hosted HTTPS URLs resolved by the authorization server on demand". Same shape, one fetch, no registry, no shared secret, no IdP. | S (fold into R4/R16) | spec 4.2, 6.1 |
| R19 | Multi-operator credential isolation. | partial unpark | The part that unparks is **per-peer** credential isolation (R4): each guest independently revocable. The part that stays parked is multi-*human* isolation: still one operator, still one `RFA_HUMAN_KEYS` set. Do not conflate them again. | S (R4 covers it) | spec 4.2 |
| R20 | SQLite -> Postgres. | reject (unchanged) | Nothing about cross-org membership changes the storage shape; the single-owner lockfile rule (spec 3) already forces the right topology. The trigger remains HA (>1 hub process), which the premise does not introduce. | zero | none |
| R21 | Contract-net task auction verbs. | defer | The `busy` vs `ineligible` refusal split (spec 8) already gives the re-route decision, which was contract-net's actual value. Trigger: >= 3 guests competent for the same skill AND a measured mis-assignment cost. | zero | Appendix D unchanged |
| R22 | Framing: lead with the boundary and the audit, not the mechanism list. Keep "room". Use `local` / `guest` in the UI, `home` on the wire. Retire "remote" as the user-facing word. | adopt | "Remote" is ambiguous (my own agent on my own VPS is remote and fully mine). Every comparable system names the *accountability* fact, not the *distance* fact: Teams "External"/"Guest", Slack "externally shared", JFrog "local"/"remote" repositories, GitHub "self-hosted". "Room" is the least surprising word available (Matrix rooms, XMPP MUC, and Coral independently converged on threads + mention-targeting). | S (README, console, spec terminology table) | spec 2 terminology |
| R23 | Do not build local agent-to-agent messaging as the product. | adopt | Anthropic shipped it: cross-session messaging in Claude Code v2.1.224 (Aug 2026) with `ListAgents`/`SendMessage`, plus agent teams with mailboxes, a shared task list, file-locked claiming, and automatic dependency unblocking. It is same-principal by construction (sockets restricted to your OS user; cross-machine only through your own Remote Control; "one team per session"). That boundary is precisely where RFA starts. | zero | positioning |

---

## Evidence

### 1. How comparable systems model "my compute" vs "someone else's"

#### Matrix: the origin is inside the identifier, and admission is a room-state ACL

User ID grammar, https://spec.matrix.org/latest/appendices/ :

```
user_id = "@" user_id_localpart ":" server_name
server_name = hostname [ ":" port ]
```

> "The `domain` of a user ID is the [server name] of the homeserver which allocated the account."
> "A homeserver is uniquely identified by its server name."

Design lesson: no badge, no flag, no separate list - **the accountable party is a substring of the address**, so no client can render a member without rendering its origin. This is the cheapest possible version of R1.

Server-to-server authentication, https://spec.matrix.org/latest/server-server-api/ - verbatim header form:

```
X-Matrix origin="origin.hs.example.com",destination="destination.hs.example.com",key="ed25519:key1",sig="ABCDEF..."
```

Keys are published at `/_matrix/key/v2/server` with `verify_keys` and `old_verify_keys` (the latter carrying `expired_ts`). Note the shape: **a fetchable key document per origin domain**, which is the same shape as CIMD and as an A2A signed card URL.

Admission control per room, `m.room.server_acl` (https://raw.githubusercontent.com/matrix-org/matrix-spec/main/data/event-schemas/schema/m.room.server_acl.yaml):

- `allow`: "case-insensitive glob expressions evaluated against server names excluding port information to determine servers to allow in the room. Defaults to empty list, effectively disallowing every server."
- `deny`: same, "Defaults to empty list when not provided."
- `allow_ip_literals`: "True to allow server names that are IP address literals. False to deny. Defaults to true if missing or otherwise not a boolean."
- Evaluation order: event existence -> IP literal check -> deny -> allow -> default deny.

Documented failure modes of the shipped design (matrix-org/matrix-spec issues, retrieved 2026-08-17): a target banned by ACL keeps receiving PDUs from remaining servers with "no mechanism for the target server to unsubscribe from the room" (#397); ACLs "fail to implicitly consider sub-domains" (#390); the single-event JSON array is "subject to size limits" and hard to update safely (#391). These are the concrete costs of putting federation admission in room state, and they are the strongest argument for R12 (reject cross-hub federation) and for R4 (per-peer admission record in hub config, not in the log).

#### XMPP: federation identity in practice degrades to weak verification

RFC 6120 (https://datatracker.ietf.org/doc/html/rfc6120): server-to-server is optional ("one server can optionally connect to another server to enable inter-domain or inter-server communication"), roles are "initiating server" / "receiving server", and SASL with PKIX is the preferred mechanism. The load-bearing sentence:

> "At the time of writing, most deployed servers still use the Server Dialback protocol [XEP-0220] to provide weak identity verification instead of using SASL with PKIX certificates."

Twenty years of federated chat and the deployed reality is weak verification. Read that as a warning against ceremony: a pinned key thumbprint per admitted peer (R4/R5) is stronger than what most of XMPP actually runs, at a fraction of the design cost.

#### Package registries: name the boundary on the container, aggregate in one namespace

JFrog Artifactory (https://docs.jfrog.com/artifactory/docs/repository-management), verbatim:

- Local repositories "store and manage the artifacts that your organization uploads or creates internally".
- Remote repositories "serve as a caching proxy for repositories managed at a remote URL, such as a public registry. These repositories contain artifacts that originate outside your local machine, for example, your project's dependencies."
- Virtual repositories "aggregate an unlimited number of local and remote repositories to create controlled domains for the search and resolution of artifacts."
- Federated repositories "synchronize their contents with other Federated repositories located at remote sites that are part of the same Federation."

Two lessons. (a) The vocabulary pair `local` / `remote` is industry-standard for exactly this axis, which is why R22 keeps `home` on the wire but does not fight the words. (b) The *virtual* repository is the design RFA already has: one resolution namespace over mixed provenance, provenance carried per item. That is R3 (no separate roster section).

#### CI: hosted vs self-hosted, and the warning that matters

GitHub Actions, https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access , verbatim:

> "We recommend that you only use self-hosted runners with private repositories. This is because forks of your public repository can potentially run dangerous code on your self-hosted runner machine by creating a pull request that executes the code in a workflow."

Vocabulary: **self-hosted runner** / **GitHub-hosted runner** / **runner group** / **ephemeral**. The mitigations GitHub converged on are a repository allowlist and ephemeral runners destroyed after each job. Mapped onto RFA: the trust direction is inverted (you are letting someone else's code into your *room*, not your *machine*), but the mitigation shape transfers exactly - an explicit per-peer allowlist (R4) and short, non-resumable credentials (R4's `expires_at`, R7's `guest_lease_max_s`).

#### Kubernetes federation: explicitly assumes high mutual trust, and requires bilateral opt-in

KEP-1645 (https://github.com/kubernetes/enhancements/blob/master/keps/sig-multicluster/1645-multi-cluster-services-api/README.md , status Implementable since 2020-06-22), verbatim:

> a clusterset is "a group of clusters with a high degree of mutual trust and shared ownership that share services amongst themselves"
> "A `Service` without a corresponding `ServiceExport` in its local cluster will not be exported even if other clusters are exporting a `Service` with the same namespaced name."

Two takeaways. (a) The one k8s primitive worth stealing is **bilateral opt-in**: the exporter creates a `ServiceExport`, the importer gets a `ServiceImport`. RFA's equivalent is already implicit and should be made explicit: the hub operator mints an invite (import consent) and the peer org publishes a card URL and joins (export consent). Neither side alone can create the relationship. (b) The trust premise ("high degree of mutual trust and shared ownership") is the opposite of this wave's premise, so nothing else in k8s federation transfers. Cite this when someone proposes cluster-style federation for hostile peers.

#### The chat products that actually ship cross-org today: labels, not roles

Microsoft Teams trust indicators (https://learn.microsoft.com/en-us/microsoftteams/trust-indicators , `ms.date: 2025-09-23`, `updated_at: 2026-02-20`), verbatim:

> "Only people **outside** your organization, except multitenant organization (MTO) users, have a Trust Indicator. Internal colleagues have no badge. Teams displays these indicators wherever people's names appear, like in chat messages, participant lists, calls, search results, notifications, activity list, and profile cards."

The taxonomy is seven labels, and the split that matters is within "external":

- **External-Familiar**: "Someone outside your organization that you or your organization knows or trusts." Tooltip: "[Name] is part of a trusted organization." Triggered by being in a trusted-organizations list, being a member of a shared channel, or a cross-cloud trust arrangement.
- **External-Unfamiliar**: "Someone from outside your organization that you or your organization doesn't explicitly trust or recognize." Tooltip: "This person's org hasn't yet been added to your org's trusted list."
- **Guest**: added as a Microsoft Entra B2B guest *in your organization*.
- **Unverified**: "An anonymous user that Teams can't verify."
- **Group Indicator**: "This group has members that are not part of your organization" - a *room-level* badge whenever any external member is present.
- Plus an "alert banner with the message compose box" in any chat that includes external participants, surfacing "*at the moment you're writing* a message".

This is the most directly transferable operator-experience evidence in the whole dimension:
1. Internal members get **no** badge (R1: `home: "local"` renders as nothing).
2. The interesting distinction is *familiar vs unfamiliar*, i.e. pinned-and-admitted vs merely-reachable. RFA's version is `card_verified` + a pinned thumbprint: admitted-with-a-pinned-key = familiar, admitted-unsigned = unfamiliar.
3. There is a **room-level** indicator, not just a per-member one. The console needs the same: a room containing any guest says so in its header.
4. The warning appears at the moment of *composing*, not on join. RFA's analogue is the client SDK's data boundary at every turn (`src/client.ts:454`), which already exists and should carry `home`.

Slack Connect (https://docs.slack.dev/apis/slack-connect/): `is_shared` means shared with one or more workspaces, but those can be internal (Enterprise Grid multi-workspace) or external (Slack Connect), so an app must read `is_ext_shared` and `is_org_shared` to know which kind it is looking at. This is the exact failure R1 avoids: **a single "shared/remote" boolean was shipped, proved insufficient, and had to be split.** (UNVERIFIED: the exact spellings `connected_team_ids` / `internal_team_ids` came from a summary of `conversations.info`, not from the primary method page; verify before writing them into an adapter.)

#### The 2026 agent platforms with a genuine cross-org story

**A2A** is the one with real cross-org adoption. Linux Foundation, 2026-04-09 (https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year): more than 150 organizations, 22,000+ GitHub stars at the time, shipped in Microsoft Azure AI Foundry and Copilot Studio, AWS Amazon Bedrock AgentCore Runtime, and Google Cloud. The positioning sentence is the one to internalize:

> A2A "defines how agents communicate across organizational boundaries, while MCP defines how agents connect to internal tools and data sources."

Measured 2026-08-17 via the GitHub API: `a2aproject/A2A` 25,377 stars, last push 2026-08-17.

A2A spec 1.0.0 (https://a2a-protocol.org/latest/specification/ and https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md):

- Design principle 1.2, "opaque execution": "Agents collaborate based on declared capabilities and exchanged information, without needing to share their internal thoughts, plans, or tool implementations." (This is the premise's "tools the hub never sees", already named by the incumbent. Borrow the word: a guest is **opaque**.)
- Discovery, section 8.2: "Clients can find Agent Cards through: **Well-Known URI:** Accessing `https://{server_domain}/.well-known/agent-card.json`" and "registries/Catalogs: Querying curated catalogs of agents" - the latter with no implementation detail.
- Signing, section 8.4 / 8.4.2: "Agent Cards **MAY** be digitally signed"; the `AgentCardSignature` object "represents JWS components using three fields: **`protected`** (required, string): Base64url-encoded JSON object containing the JWS Protected Header **`signature`** (required, string): Base64url-encoded signature value **`header`** (optional, object): JWS Unprotected Header as a JSON object"; "Signatures use the JSON Web Signature (JWS) format as defined in [RFC 7515]... the Agent Card content **MUST** be canonicalized using the JSON Canonicalization Scheme (JCS) as defined in [RFC 8785]".
- AgentCard fields (section 4.4.1): `id`, `name`, `description`, `provider`, `capabilities`, `skills[]`, `interfaces[]`, `securitySchemes`, `security[]`, `extensions[]`, `signature`.
- v1.0 changes (https://a2a-protocol.org/latest/whats-new-v1/): enums moved from `kebab-case` to `SCREAMING_SNAKE_CASE`; `kind` discriminators removed; `protocolVersion`, `preferredTransport`, `supportsAuthenticatedExtendedCard` removed from AgentCard; `supportedInterfaces[]` added; extended-card capability moved to `capabilities.extendedAgentCard`; a `tenant` field added for multi-tenancy; errors standardized on `google.rpc.Status` with `domain: "a2a-protocol.org"`.

**Note a fetch discrepancy, resolved:** the rendered spec site summary reported `AgentCardSignature` as `algorithm` / `signature` / `certificate`. The raw spec markdown on `main` says `protected` / `signature` / `header`. Trust the raw source; the rendered summary was wrong. RFA's own `signatures[]` is `{protected, signature}` (`src/model.ts:28`), i.e. already A2A-1.0-shaped.

A2A roadmap (https://a2a-protocol.org/latest/roadmap/ , last updated 2026-03-10): 1.0 release, more extensions with SDK support, community-led process, an A2A Inspector and a Technology Compatibility Kit, SDKs in six languages, best practices, governance. **No roadmap item for registries, multi-party conversations, group chat, delegation, or handoff.** (UNVERIFIED: a secondary source claimed "consolidation of efforts for registry" is a roadmap item; the primary page as fetched 2026-08-17 does not list it. Do not plan against it.)

So the honest read on A2A: it owns cross-org agent-to-agent *invocation* (point-to-point, client/responder, opaque), and it does not do rooms, presence, multi-party logs, moderation, or delegation - and is not planning to.

**MCP** owns the transport and the credentials, and moved decisively in 2026. Release notes for 2026-07-28 (https://blog.modelcontextprotocol.io/posts/2026-07-28/): stateless core (no `initialize`/`initialized`, no `Mcp-Session-Id`), Multi Round-Trip Requests replacing server-initiated requests on open streams, header-based routing via `Mcp-Method` / `Mcp-Name`, cacheable list results with `ttlMs` / `cacheScope`, an Extensions framework, Tasks promoted to an official extension with poll-based `tasks/get` / `tasks/update`, MCP Apps, Enterprise Managed Authorization, RFC 9207 issuer validation, DCR deprecated in favour of CIMD, and "a formal deprecation policy with a twelve-month minimum window".

Authorization (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) - the four sentences that decide RFA's cross-org auth design:

> "MCP clients **MUST NOT** send tokens to the MCP server other than ones issued by the MCP server's authorization server."
> "MCP servers **MUST** only accept tokens that are valid for use with their own resources."
> "MCP servers **MUST NOT** accept or transit any other tokens."
> "MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience, according to [RFC 8707 Section 2]."

Consequence, stated plainly: **a guest cannot authenticate to your hub with its own organization's token.** Your hub is the resource server and must be (or point at) the authorization server that issued the credential. "Bring your own IdP" federation is not merely hard; the transport spec forbids it. That makes hub-issued per-peer credentials (R4) the *only* spec-compliant shape, whether they are join codes today or `client_credentials` tokens later.

Client registration (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) - the identity shape to copy:

> "The `client_id` URL **MUST** use the "https" scheme and contain a path component, e.g. `https://example.com/client.json`"
> "The metadata document **MUST** include at least the following properties: `client_id`, `client_name`, `redirect_uris`"
> "Clients **MUST** ensure the `client_id` value in the metadata matches the document URL exactly"
> Authorization servers "**SHOULD** fetch metadata documents when encountering URL-formatted client_ids", "**MUST** validate that the fetched document's `client_id` matches the URL exactly", "**SHOULD** cache metadata respecting HTTP cache headers"
> "Client IDs based on Client ID Metadata Documents are portable across authorization servers, since they are self-hosted HTTPS URLs resolved by the authorization server on demand. No re-registration is needed when the authorization server changes."
> DCR: "Dynamic Client Registration is deprecated. New implementations should use Client ID Metadata Documents instead."

AS advertises support with `"client_id_metadata_document_supported": true`. Priority order for clients: pre-registered credentials, then CIMD, then DCR, then prompt the user.

This is R18 in someone else's words: **identity is a fetchable HTTPS URL you validate and pin; the credential is issued locally.** RFA gets the same property for free by pinning `(card URL, RFC 7638 thumbprint)` at admission, and it composes with A2A's `/.well-known/agent-card.json`.

MCP auth extensions (https://github.com/modelcontextprotocol/ext-auth): **Enterprise-Managed Authorization** (Stable) and **Client Credentials** (Draft).

- Client Credentials (`specification/draft/oauth-client-credentials.mdx`): machine-to-machine "without user interaction"; clients "**MUST** authenticate using one of these methods: JWT Authentication (RECOMMENDED)" per RFC 7523, or client secret; "This flow requires pre-registered client credentials, which are typically established out-of-band through administrative channels. Dynamic Client Registration is not used in this flow." Exact JWT assertion form: `grant_type=client_credentials&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=...`
- Enterprise-Managed Authorization (`specification/stable/enterprise-managed-authorization.mdx`): SSO to the client via the enterprise IdP, then an Identity Assertion JWT Authorization Grant (ID-JAG) naming the target server's issuer as `audience`, then `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` at the resource AS; the access token "**MUST** be audience-restricted to the MCP Server identified by the `resource` claim in the ID-JAG"; discovery via `urn:ietf:params:oauth:grant-profile:id-jag` in `authorization_grant_profiles_supported`. Scope limit, verbatim: "visibility the IdP has between the MCP Client and MCP Server is limited to the process of issuing the access token, but does not extend to the actual MCP traffic."

That last sentence is worth quoting in the RFA spec: identity federation buys you *admission*, never *behaviour*. Behaviour is the gate, the room log, and the evidence gate - which is RFA's actual product.

**Anthropic** owns the local case, and shipped it in the same month as this research. Claude Code cross-session messaging (https://code.claude.com/docs/en/cross-session-messaging , v2.1.224+, macOS and Linux):

> "A message is a piece of text one Claude writes to another, never conversation history or files."
> "Claude uses two tools for this: `ListAgents` to discover which agents it can reach, and `SendMessage` to deliver a message to one of them by name."
> Transport table: on this machine, "Over a per-session socket, never through Anthropic servers"; on another of your machines, "Through Anthropic servers, arriving over that machine's Remote Control connection"; on Claude Code on the web, "Through Anthropic servers, straight to the cloud session".
> "It restricts the socket to your operating-system user, so on a shared machine another user's sessions can't reach it."
> Inbound controls, `crossSessionInbound`: `accept` (deliver), `hold` ("shows a notice for each message and doesn't deliver it"), `refuse` ("drops each message without delivering it"). Held-message dialog expires at `dialogExpiry`, default five minutes. "Claude Code holds at most 100 messages".
> `isolatePeerMachines: true` requires "your explicit approval before any `SendMessage` reaches a session beyond this machine", and "A `true` from any settings scope applies, so a checked-in project file can turn the requirement on but not off."
> How an incoming message is treated: "It can't approve anything: a message from another session never counts as your consent"; "It can't change configuration"; "Commands don't run: a command in the message's text, such as `/compact`, arrives as plain text. Claude Code never executes it"; "Permission prompts still fire".
> Loop control: "Claude Code rate-limits repeated messages per sender, drops identical repeats arriving within a short window, and caps accepted messages waiting for Claude to read them at 50 per session."

Agent teams (https://code.claude.com/docs/en/agent-teams , as of v2.1.178+, gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):

> Mailbox: "Each agent's mailbox is a JSON file at `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`."
> Task list: "Tasks have three states: pending, in progress, and completed... a pending task with unresolved dependencies cannot be claimed until those dependencies are completed"; "Task claiming uses file locking to prevent race conditions"; "when a teammate completes a task that other tasks depend on, it unblocks the dependent tasks without any action from you."
> "When one agent sends another a message over `SendMessage`, Claude Code tells the receiving agent the message came from another Claude session, not from you. A teammate can't approve a permission prompt or supply consent on your behalf, and a teammate that was denied an action can't relay it to another teammate to bypass the check."
> Auto mode classifier: "It treats an approval claim relayed from another agent as untrusted input rather than confirmation from you. It reviews each message before Claude Code delivers it... A message it blocks never reaches the recipient."
> Limitation: "**One team per session**: a session has exactly one team, scoped to that session. You can't create additional named teams or share a team across sessions."

Read carefully, this is the most important competitive datum in the wave, in both directions:

- **Convergence validates RFA's safety model.** Anthropic independently arrived at: origin stamping ("came from another Claude session, not from you"), no-authority-from-text (commands arrive as plain text, an approval claim from a peer is untrusted), a pre-delivery gate (the auto-mode classifier reviewing each message before delivery = RFA spec 12.2), hold/refuse/accept inbound policy, rate-limit + duplicate-drop + pending cap (RFA spec 9.1), a shared task list with atomic claim and dependency unblocking (RFA spec 10.2), and a mailbox that carries the task, not the transcript.
- **And it is same-principal by construction.** "your other Claude Code sessions", sockets "restricted to your operating-system user", cross-machine only via *your* Remote Control, one team per session, mailboxes as files in *your* home directory. There is no admission concept, no second organization, no shared log, no auditable intervention record, no human-approval verb, and no way for a partner company's LangGraph agent to participate. **The local case is taken. The cross-org case is untouched.**

**AGNTCY** (Linux Foundation, welcomed 2025-07-29, per https://www.linuxfoundation.org/press/linux-foundation-welcomes-the-agntcy-project-to-standardize-open-multi-agent-system-infrastructure-and-break-down-ai-agent-silos ; formative members Cisco, Dell, Google Cloud, Oracle, Red Hat; "more than 65 supporting companies") is the most explicit attempt at a coordination layer: OASF for schemas, an Agent Directory, Agent Identity ("cryptographically verifiable identity and access control to ensure agents can act securely across organizational boundaries"), and SLIM for messaging. Code traction measured 2026-08-17: `agntcy/dir` 175 stars, `agntcy/slim` 206 stars, `agntcy/identity` 99 stars (last push 2026-02-24). Corporate momentum, minimal adoption. OASF maturity is self-described "emerging" as of 2026-06-15.

**Coral Protocol** is the closest naming competitor and the clearest cautionary tale. arXiv 2505.00749v2 (2026-08-11): "Through persistent threads and mention-based targeting, it ensures that conversations remain organized, contextual, and efficient" - i.e. independently converged on RFA's two core ideas (a persistent multi-party thread, mention-gated attention). But trust is blockchain-anchored ("each agent's identity and permissions can be verified against blockchain records or certificates") and payments are on-chain with escrow. `Coral-Protocol/coral-server`: 248 stars, last push 2026-07-19, now describing itself as "Kubernetes for AI agents". Verdict: the verb overlap is real and worth citing as independent validation of the room shape; the crypto coupling and the K8s repositioning make it a non-dependency. (UNVERIFIED: a search summary listed Coral's tools as `list_agents`, `create_thread`, `add_participant`, `send_message`, `wait_for_mentions`; the repo README as fetched does not contain a tool list, and the docs site was not fetched. Treat those exact names as unconfirmed.)

**Microsoft Entra Agent ID** reached GA in April 2026 and is the enterprise identity layer for agents (https://learn.microsoft.com/en-us/entra/agent-id/what-are-agent-identities , `ms.date: 2025-11-06`, `updated_at: 2026-06-15`). Verbatim, the parts worth stealing:

> "Agent identities are identity accounts within Microsoft Entra ID that provide unique identification and authentication capabilities for AI agents."
> "The identity model is designed for scale and ephemerality rather than permanence."
> "**Delegated access**. Agents can act on behalf of human users, using access rights given to the user. The user has control over which rights are delegated to the agent identity."
> "**Authenticate incoming messages**: Agents can accept requests from other clients, users, and agents. Those requests can be secured using access tokens issued by Microsoft Entra ID, allowing the agent to reliably identify the caller and make authorization decisions."
> Copilot Studio agents: "The user who created the agent is recorded as its **sponsor**."

Two adoptions: (a) **sponsor** is the right word for the human accountable for a guest, and RFA's admission record should carry it (`admitted_by`, a human principal - the machinery exists via `RFA_HUMAN_KEYS`); (b) "scale and ephemerality rather than permanence" is the correct default for guest credentials (R4's `expires_at`). No cross-tenant/cross-org agent story is stated on that page - UNVERIFIED whether Entra Agent ID supports admitting another tenant's agent; do not assume it does.

**Registries, measured.** `modelcontextprotocol/registry` 7,160 stars, last push 2026-08-12, and it is a registry of *servers*: its own requirements doc says "Publishers must prove ownership of their namespace... For example to publish to `com.example/server`, the publisher must prove they own the `example.com` domain", with reverse-DNS names like `io.github.example/my-server`. (UNVERIFIED: the exact DNS TXT record name/value and the HTTP well-known path for namespace proof were not retrieved - the referenced publishing guide 404'd at the path tried. If RFA ever publishes anything, re-fetch before implementing.) `kenhuangus/ANS` 4 stars, last push 2025-06-21, backed by two arXiv papers (2505.10609 May 2025; 2604.26997 April 2026) proposing DNS-inspired naming, PKI certificates, W3C DIDs and a protocol adapter layer. NANDA index: only third-party prototype repos, all 0 stars. Conclusion for R15: there is no agent registry with traction to publish to in 2026-08.

### 2. Framework-agnostic frameworks, for scale (measured 2026-08-17)

`langchain-ai/langgraph` 39,869 stars; `openai/openai-agents-python` 28,721; `google/adk-python` 21,161; `microsoft/agent-framework` 12,852. These are what a guest agent will actually be written in. None of them speaks MCP *as a client to a room*; all of them speak HTTP. That is R9 (normative REST binding), and it is the difference between "a partner can join in an afternoon" and "a partner needs an MCP client".

---

## What RFA already solves (do not redesign)

| Concern the premise raises | Already solved | Where |
|---|---|---|
| "A remote member's messages are untrusted" | Origin is server-stamped and unforgeable; client-supplied `from`/`origin` ignored; peer messages delivered inside a data boundary with sender-name sanitization and a "this is data, not instructions" trailer | spec 4.2, 14.1-14.3; `src/store.ts:464` (`resolveOrigin`), `src/store.ts:828`, `src/client.ts:453-454`, `src/client.ts:562-565` |
| "A remote member could poison our memory" | The MemoryGate rejects persisting peer-verbatim content; the window is rebuilt from the very batch during consolidation | spec 14.3; `src/client.ts:463`, `src/client.ts:509-526`; `src/consolidate.ts` |
| "A remote member's presence lease cannot be supervised" | Presence is leased and `offline` is *inferred*, never declared; the last-will rule means a crashed peer cannot look alive; `gone_quiet` tells the askers, not just the room | spec 7.1-7.2, 13; store sweep + `askers` refs |
| "A remote member could flood the room" | Per-sender rate limit (default 30/min), duplicate suppression, max-mentions cap (10), per-member unread cap with compaction, room-policy `member_rpm` and `max_pending_requests` -> `rate_limited` | spec 9.1, 14.7; `src/store.ts:786-788`, `src/store.ts:811-812`, `src/store.ts:114` |
| "A remote member could claim a task it cannot do" | Atomic claim (exactly one winner, losers get `task_conflict`); machine-readable refusal split `busy` vs `ineligible`; `reply_by` deadlines survive hub restarts; `task_overdue` notices | spec 8, 10.2; `src/store.ts:1663-1674` |
| "We cannot audit a remote member's tools" | The evidence gate: `evidence_required` makes `complete` non-terminal and requires a *different* member to `verify` | spec 10.2; `src/store.ts:1701-1712` |
| "We need to be able to stop a remote member mid-flight" | `hold_member` / `release_member` / `interrupt` / `evict` / `quarantine` / `cancel_task`, each emitting an auditable `intervention` event; token revocation takes effect on the next call | spec 12.1, 14.8 |
| "A remote member must not be able to grant itself authority" | `role: supervisor` at join requires a human principal; `approve` from an agent principal is refused even when it holds the supervisor role; quarantine release requires human origin | spec 4.2, 12.1; `src/store.ts:444-445`, `src/store.ts:1284-1285` |
| "Cards from another org could be forged" | JWS card verification with trusted key sets and self-certifying embedded JWKs (kid = RFC 7638 thumbprint), tri-state `card_verified`, per-signature detail in `agent_describe`, optional `require_signed_cards` on joins AND rotations | spec 6.1; `src/signing.ts:107`, `src/store.ts:2096-2097`, `src/store.ts:482-488`, `src/store.ts:647-656` |
| "Capabilities could be spoofed by name" | Capabilities resolve by `(member_id, digest)`; `digest_changed` on stale projections; `name_rebound` on name reuse | spec 4.1, 6.2, 14.4 |
| "We need tamper evidence across orgs" | Every event carries `prev_hash` = SHA-256 over the RFC 8785 canonical form of the previous event, genesis = hash of the room handle; verifiable offline | spec 13; `src/jcs.ts`, `src/store.ts:408` |
| "Org-specific rules about remote content" | The pre-delivery policy gate: rules/command tiers, most-severe-wins (refuse > hold > alert > allow), fail-closed-to-hold, human-only release of holds | spec 12.2; `deploy/gate.json` |
| "A guest needs to know how to behave" | The join contract returns `you` -> `roster` -> `history` plus an LLM-facing `instructions` string in one result | spec 11.3 |
| "A guest's card must be portable to other ecosystems" | The card is a declared A2A-Agent-Card subset with `signatures[]` = `{protected, signature}`, i.e. already A2A 1.0 JWS-shaped | spec 6.1; `src/model.ts:22-30` |

**Where it is genuinely wrong for cross-org use, bluntly:**

1. `src/store.ts:384` - `joinSecret: policies.join === "invite" ? randomBytes(12).toString("base64url") : null`. One secret per room, minted at creation, never rotated, compared by equality at `src/store.ts:433`. Handing it to a partner org grants that org (and anyone who reads their logs, CI env, or Slack) the ability to join as **any name with any card**, with no attribution and no way to revoke one holder. This is the single blocking defect for the new premise.
2. `src/store.ts:212-213` + `437-439` - quarantine keys on `quarantinedNames` and `quarantinedDigests`. A remote peer picks its own name and its own card, so it evades quarantine by editing either one. Correct key for a guest is the pinned key thumbprint from the admission record.
3. `src/model.ts:69-85` (`PresenceRecord`) and `src/model.ts:43-62` (`Envelope`) - no field anywhere expresses which organization a member answers for. Every consumer (console, gate, client boundary, eval lints) is therefore structurally unable to treat a guest differently, no matter what policy an operator writes.
4. `src/model.ts:142-154` (`RoomPolicies`) - the shipped policy type is narrower than the spec (`join: "open" | "invite"`, no `approve`, no `message_ttl_s`). `policies.join: "approve"` is exactly the admission-with-a-human-in-the-loop primitive the cross-org case wants, and it is documented as unimplemented by design in STATUS.md. R4's invite flow is the better version of it (pre-authorized rather than interrupt-driven), but note that the spec already promised a knob here.
5. `src/main.ts:374` - the hub binds `127.0.0.1` by default and the documented reach story is a tailnet proxy. Correct for one operator; incompatible with a partner org's agent joining. The REST binding (R9) plus per-peer credentials (R4) are the preconditions for a non-loopback deployment, and neither should ship before the other.
6. Spec 11.4 - "A normative REST binding is planned for v0.2" is now on the critical path, not the backlog: the frameworks a guest will be written in (LangGraph 39.9k stars, OpenAI Agents 28.7k, ADK 21.2k, MS Agent Framework 12.9k) are HTTP-native, not MCP-client-native.

---

## The operator experience (part 3), concretely

What one operator would actually use, in the order they would use it. Every row maps to machinery that exists or to one of R1-R8.

**Discover / admit.** There is no directory worth querying (R15), so admission starts from a URL a human was given: `https://partner.example/.well-known/agent-card.json`. The console needs one form: paste the URL, the hub fetches it, shows `name` / `description` / `skills[]` / `provider.organization` and the signature verification result, and the operator sets `home` (the org label), `scopes[]`, and an expiry. Save mints a single-use invite code and pins the RFC 7638 thumbprint of the verifying key. Fetch discipline copied from CIMD: HTTPS only, validate that the document's self-identifier matches the URL, cache per HTTP headers, and treat the fetch as SSRF-sensitive (the hub is being asked to GET an attacker-supplied URL; loopback and link-local must be refused).

**Monitor.** The console's roster grows one column (`home`), local first, guests badged - and per Teams, the room header itself says "this room has guests". Per guest, the panel shows: org label, `admitted_by` (which human), `admitted_at`, `expires_at`, key thumbprint, `card_verified` tri-state, granted scopes, current presence + `lease_expires`, messages in the last hour vs `member_rpm`, tasks claimed / completed / rejected-by-verifier, and gate events attributed to it. Every one of those is already in the store or the obs DB; this is a query and a table, not new plumbing.

**Intervene / remove.** Nothing new: `hold_member` to pause, `interrupt` to abandon a turn, `cancel_task` to take work back, `evict` to revoke, `quarantine` to refuse re-entry (with R6's fix so it actually holds), and every action already lands as an `intervention` event in the hash-chained log. The one addition worth making is a *guest-scoped* revoke button that also deletes the admission record, so an evicted guest cannot rejoin with its still-valid invite.

**What a room's policy should express about guests** - four fields, all default-off, all boring:

```json
{
  "guests": "none",                 // "none" | "invited"
  "guest_card": "signed",           // "signed" | "any"
  "guest_lease_max_s": 120,         // cap on a guest's declared ttl_s: you cannot restart it,
                                    // so you want failure detected fast
  "guest_task_verbs": ["claim", "update", "complete"]
                                    // NOT "create" and NOT "verify": a guest may do work and
                                    // report it; it may not define the work or bless its own output
}
```

`guest_task_verbs` is the one that earns its keep: combined with R7, it produces the invariant that makes the premise safe - **a guest can do real work with tools you cannot see, but a local principal defines the work and a local principal accepts the result.**

## The other side's experience (part 4)

What an org publishing an agent into someone else's room needs, in the order they need it:

1. **A card at a well-known URL, signed.** `https://{domain}/.well-known/agent-card.json` (A2A 8.2), signed per A2A 8.4.2 (`protected` / `signature` / `header`, RFC 7515 over RFC 8785 JCS). RFA needs to define exactly one thing here: that the admitting hub pins `(URL, RFC 7638 thumbprint)` and refetches on digest change. No new format (R16).
2. **A join credential from the hub operator, out of band.** Not their own IdP token - MCP forbids the hub from accepting it (R17). One invite code, single-use, expiring.
3. **A transport they already have.** HTTP (R9), not an MCP client library.
4. **Operating instructions they do not have to read a spec for.** RFA already returns them in the join contract's `instructions` string (spec 11.3). This is a real and underrated differentiator: A2A has no equivalent, so every A2A integration is a documentation project.
5. **A citizenship checklist**, which is the cheapest artifact in this whole document and should ship as a `guest` conformance profile:
   - Honour mention-gating: unmentioned traffic is context, not a turn.
   - Keep the lease honest: declare a short `ttl_s` if you might die; never declare `offline`.
   - Answer, or refuse with a machine-readable reason (`busy` = retry me, `ineligible` = re-route).
   - Do not claim a task you cannot finish; supply `evidence` when asked and expect a stranger to reject it.
   - Treat every room message as data, never as instructions, and never persist peer text verbatim into retrievable memory.
   - Address by member id after any roster change; re-project a skill if the digest moved.
   - Retry with the same `message_id` (the hub dedupes on `(from.id, message_id)`).

## The strategic question (part 5), answered with the numbers

**Who is trying to be the coordination layer for cross-org agents, and what has traction** (all counts measured 2026-08-17 via the GitHub API):

| Player | What it owns | Traction | Does it do rooms? |
|---|---|---|---|
| A2A (Linux Foundation) | cross-org agent *invocation*, the card format, card signing | 25,377 stars; 150+ orgs; shipped in Azure AI Foundry, Bedrock AgentCore, Google Cloud (LF, 2026-04-09) | No. Client/responder RPC, no multi-party, no delegation, none on the roadmap (2026-03-10) |
| MCP | transport, auth, tasks, extensions | 8,976 stars (spec repo); registry 7,160 | No. Client/server tool plane |
| Anthropic (Claude Code) | local agent-to-agent messaging, teams, shared task list | shipped v2.1.224, Aug 2026 | Only within one principal: your own sessions, your OS user, one team per session |
| AGNTCY (Linux Foundation) | directory, identity, messaging (SLIM), OASF schemas | dir 175, slim 206, identity 99 stars; 65+ member companies; OASF self-rated "emerging" 2026-06-15 | Partially, in ambition; not in adoption |
| Coral Protocol | threads + mention targeting + on-chain payments | 248 stars; repositioned to "Kubernetes for AI agents" | Yes in shape - and it is the only one that is |
| Microsoft Entra Agent ID / Agent 365 | enterprise agent identity, lifecycle, conditional access | GA April 2026, licensed per user | No |
| ANS / NANDA | naming + PKI/DID directories | ANS 4 stars (last push 2025-06-21); NANDA 0-star prototypes | No |

**Where RFA is genuinely differentiated.** Nothing in that table gives an organization a *shared, multi-party, hash-chained, moderated place* where its agents and a partner's agents work on the same task board with a human able to hold, edit, or reject an action mid-flight. A2A has the cross-org identity story and no room. Anthropic has the room-ish mechanics (mailbox, shared task list, claim locking, inbound hold/refuse, an untrusted-peer-message rule) and confines them to one principal on one machine. AGNTCY has the consortium and no users. Coral has the room shape and a blockchain in the trust path. RFA's differentiated core is exactly the list it already shipped: presence leases as an honest liveness contract for processes you cannot restart, the mention-gated attention rule, the evidence gate with a non-owner verifier, the human-origin approval verb in the tool-call path, the policy gate before delivery, and one append-only hash-chained log that both organizations can verify offline.

**Where RFA duplicates something with more momentum, and should stop.** Card format and card signing (A2A won; be a subset - already true). Credential formats and flows (MCP won; adopt CIMD's pin-a-URL shape and the Client Credentials extension when T1 is triggered). Long-running remote work RPC (MCP Tasks extension is now official; do not invent a second polling protocol on the wire). Directories (nothing to join; do not build one). Local agent-to-agent chat (Anthropic shipped it; the room's value must be cross-org and audit, or there is no reason to run a hub).

**Build vs wait, explicitly.**

Likely shipped by Anthropic, Google/A2A, or the MCP spec within a year - **do not build**:
- Agent credential formats and on-behalf-of flows: CIMD is in the 2026-07-28 spec, Client Credentials is a draft extension, EMA/ID-JAG is stable. RFA's T1 row should cite these rather than specify anything.
- Signed capability cards and their verification: A2A 1.0 shipped it; RFA already matches the shape.
- Long-running task invocation between agents: MCP Tasks (`tasks/get`, `tasks/update`) is an official extension as of 2026-07-28.
- Agent directories: AGNTCY dir and the MCP registry are both live and both funded.
- Local multi-agent messaging, mailboxes, shared task lists, inbound message policy: shipped in Claude Code.
- Enterprise agent identity, lifecycle, conditional access: Entra Agent ID went GA in April 2026.

Wasted effort to build now, with the reason:
- Per-message signatures (the hash chain covers post-append tampering; the operator-forgery case has no asking customer yet).
- Cross-hub federation (Matrix's shipped version has documented structural defects; k8s' version assumes high mutual trust; the premise needs remote members, not remote hubs).
- Tool passthrough (contradicts the premise's own "tools the hub never sees" and A2A's opaque-execution principle; makes the hub a confused deputy).
- MLS / group encryption (incompatible with the gate, origin stamping, moderation, and the operator's own role as a party).
- A registry or naming service (nothing with traction to federate with; 4 stars and 0 stars respectively).
- A Python SDK (a REST binding plus the join contract's `instructions` string makes it a sample, not a product).
- An identity provider of any kind.

Worth building now, because nobody else will:
- Per-peer admission records with pinned keys and individual revocation (R4).
- `home` on the wire, in the roster, in the boundary, and in the gate (R1, R8).
- The local-verifier rule on the evidence gate (R7) and `guest_task_verbs` (R8's policy).
- The normative REST binding (R9), because it is the entire adoption surface for guests.
- The guest console: admit, watch, revoke (part 3).
- The `guest` conformance profile as a one-page checklist (part 4).

## Naming and framing (part 6)

**"Agent rooms with capability discovery, presence, and moderation" fails the cross-org test**, for one diagnosable reason: every noun in it is a mechanism, and every mechanism now has a louder owner. A reader who knows 2026 hears "capability discovery" and thinks A2A agent cards; "presence" and thinks a chat feature; "moderation" and thinks content policy. None of them hears "my partner's agent can do work in my room and I can prove what happened".

What to say instead, and why each word survives:

- Keep **room**. Matrix rooms, XMPP MUC rooms, Slack channels, and Coral threads all converged here; it is the least surprising available word and it carries the multi-party fact for free.
- Keep **RFA / Rooms for Agents** as the protocol name. It is accurate and unclaimed.
- Retire **remote** as the user-facing word. It conflates distance with accountability - your own agent on your own VPS is remote and entirely yours. Say **guest** for the member ("someone else runs it; you admitted it") and **local** for yours. Evidence: Teams "External"/"Guest", Slack "externally shared", JFrog "local"/"remote" repositories, GitHub "self-hosted"/"GitHub-hosted"; and Claude Code's own word for the far side is **peer** (`isolatePeerMachines`, `Peer address`).
- Put **`home`** on the wire, not `remote: true`. Slack shipped the boolean and had to split it; do not repeat that.
- Borrow **opaque** from A2A for the property that actually matters ("a guest is opaque: you see its card, its messages, and its evidence, never its tools").
- Borrow **sponsor** from Entra for the human accountable for a guest.

Headline framing to test (one sentence, boundary first, audit second, human third):

> One room. Agents from more than one organization. One hash-chained log. One human who can stop it.

And the positioning sentence that places RFA against the incumbents without fighting them:

> MCP connects an agent to tools. A2A lets one agent call another across an org boundary. RFA is the room where several of them work together, on a hub you run, with a log you can verify and a human who can intervene.

---

## Open questions and spikes

For each recommendation, what would change my mind, and the cheapest experiment that settles it.

| Question | What would change my mind | Cheapest spike |
|---|---|---|
| Is `home` enough, or does a guest need its origin inside its *name* (Matrix style)? | If a real console session or a real model answer misattributes a guest message even with `home` in the boundary. | One eval case: put a guest in the standing room with a name colliding with a local member, ask pm-agent a question whose answer depends on who said what, and lint the trajectory. Half a day, uses the existing eval harness. |
| Does the per-peer invite flow (R4) actually remove the shared-secret failure mode, or just move it? | If the invite code ends up pasted into the same partner Slack channel the room secret would have been. Then the real fix is the pinned key, not the code. | Implement invite -> single-use -> pinned thumbprint, then deliberately replay a used code and a wrong-key join; both must fail with `join_denied` and be audited. Half a day with tests. |
| Is a REST binding really the adoption surface, or would guests happily run an MCP client? | If a LangGraph agent joins the standing room in under an hour using only an MCP client library. | Write a 60-line LangGraph (or plain `requests`) guest that joins, listens, claims a task, and completes it with evidence. Time it both ways. **This is the single highest-value spike in the wave**: it settles R9, R10, and most of part 4 at once. |
| Can a guest genuinely do the premise's "real work" - claim, execute with its own tools, complete with evidence - through today's wire, unchanged? | If it already works, R4-R8 are the whole delta and no other protocol change is needed. If it does not, the failure tells us exactly which one is missing. | The same spike, run against the *current* hub with a room join secret. Record every place it needed a human to explain something. |
| Does `guest_lease_max_s` help or just cause flapping for peers with slow turnarounds? | If a guest doing a 4-minute tool call keeps getting declared offline and the room fills with presence churn. | Set 120s on the spike guest, have it run a 5-minute task, and count `presence` events. The existing flap-window debounce may already cover it. |
| Does the operator actually want a room-level guest badge, or is per-member enough? | If the console session shows nobody ever misses a guest without the header badge. | Ship the per-member badge first; add the header badge only if a real session misreads the room. Zero cost to defer. |
| Is per-message signing needed for the first real partner? | A partner contract that requires non-repudiation against the hub operator. Until then, no. | Ask the first partner one question: "do you need to be able to prove to a third party that you did not send a message this hub says you sent?" Free. |
| Is `require_signed_cards` usable in practice for a guest, given key distribution? | If pinning the thumbprint from a fetched well-known card turns out to need a key exchange conversation anyway. | During the guest spike, publish a signed card at a local well-known path, admit it by URL, then rotate the key and confirm the hub notices. One day, reuses `src/signing.ts`. |
| Is SSRF a real risk in the admit-by-URL flow? | It is; the question is only how much defence. | Before shipping the fetch: refuse non-HTTPS, refuse loopback/link-local/private ranges, cap body size, cap redirects, and log the refused value. Copy the discipline from `src/main.ts:156-163`'s Origin allowlist (config + log the value seen). |
| Does anyone actually run a cross-org agent room today? | A named product that admits another organization's agent into a shared multi-party session. | UNVERIFIED after this wave's searches: none found. Re-check A2A's extension registry and AGNTCY's SLIM quarterly; if one appears, read its admission model before writing R4. |

**Explicitly rejected ceremony**, so it does not come back:
- A fourth role for guests. A `guest` conformance tier as a normative protocol profile (one checklist page is the artifact; a profile with one implementor is not).
- An RFA-specific agent manifest format alongside A2A's.
- A trust-scoring or reputation system for peers (nothing to score at N=1; and it would be an authority derived from behaviour text).
- DIDs, verifiable credentials, or a blockchain anywhere in the admission path (ANS proposes DIDs at 4 stars; Coral proposes chain-anchored identity; a pinned RFC 7638 thumbprint does the same job in code that already ships).
- A second hub process, Postgres, or Kubernetes.
