# Wave 06: MuleSoft Agent Fabric versus RFA

**Date**: 2026-08-29 · **Question**: Salesforce/MuleSoft shipped an enterprise agent control plane a year ago. What does it share with RFA, where is it genuinely better, where is it not, and what does that mean for this project?

**Method, stated plainly so nobody over-trusts this.** One session, web sources only: vendor documentation (docs.mulesoft.com, architect.salesforce.com), vendor blogs, the Agent Fabric release notes, one analyst-quoting trade article, one pricing survey. No hands-on trial, no Anypoint tenant, no code read. This is **not** a wave 01-05 style sweep: no multi-agent fan-out, no adversarial verification pass, no downloaded papers. Every claim about Agent Fabric below is a *vendor claim or a trade report*, not a measurement, and is labelled where it matters. Sources with access dates in [notes/SOURCES.md](notes/SOURCES.md).

---

## 1. Verdict

**They are not the same product and they are not competing for the same buyer, but the overlap is real and it is exactly where RFA is thinnest.**

Agent Fabric is a **control plane over agents that already exist and run somewhere else**. It does not host an agent runtime. Its four pillars catalogue agents (Registry, built on Anypoint Exchange), route work to them with an LLM or a scripted graph (Broker, compiled into a Mule app on CloudHub 2.0), proxy every call they make (Governance, two Flex Gateways: ingress and egress), and draw a map of what called what (Visualizer).

RFA is a **substrate for agents to be somewhere and talk to each other**: a wire protocol for rooms, presence, capability cards and evidence-gated tasks, plus a platform that actually runs the agents (packs, residents, memory, knowledge, budgets, sandboxes, evals, a CLI).

So: **the thing Fabric governs, RFA runs. The thing RFA lacks, Fabric sells.** Fabric has no multi-party primitive at all, no presence, no shared conversation, no agent memory and no runtime containment, because it never owns the process. RFA has no org-wide agent inventory, no end-user identity propagation and no egress control, because it never owns the network path to agents it does not host.

Three concrete conclusions:

1. **RFA is not obsoleted.** Nothing in Agent Fabric does what a room does. Fabric's own architecture guide reaches for hierarchical broker trees precisely because it has only directed delegation to work with.
2. **RFA's weakest flank is now named by a shipping competitor.** Egress control and end-user identity propagation are Fabric's strongest, most concretely documented capabilities, and RFA has neither. `sandbox.network` and `allowed_domains` were found inert in the 2026-08-21 direction review and RFA still has no proxy story.
3. **There is a free interop move.** An RFA hub is an MCP server; Fabric's registry catalogues MCP servers and its brokers call them. Registering a hub in Agent Registry would give a Fabric broker the one thing it structurally cannot build: a persistent, multi-party, presence-aware, hash-chained conversation. This is consistent with RFA-0.6 sect. 12's rejection of an A2A *server facade* (which would collapse the roster into one agent); the MCP direction has no such defect.

---

## 2. What Agent Fabric actually is

Announced 2025-09-25. Governance available at announcement; Registry, Broker and Visualizer GA from October 2025 (first release-notes entry 2025-10-03).

### 2.1 The four pillars

| Pillar | What it is | Where it runs |
|---|---|---|
| **Agent Registry** (Discover) | Anypoint Exchange with three new asset types (Agent, MCP, LLM) plus an `agent-network` type. Immutable core metadata (unique name, version, ownership, publisher), lifecycle states (development / staging / production / deprecated), key-value tagging by type and domain, private and internal catalogues. | Anypoint SaaS control plane |
| **Agent Broker** (Orchestrate) | An LLM-powered router that decomposes a request into tasks and calls A2A agents and MCP tools. Defined in YAML, "transparently compiled into an application, without requiring any prior knowledge about Mule", deployed to CloudHub 2.0. Human-in-the-loop state held in MuleSoft Object Store. | CloudHub 2.0 |
| **Agent Governance** (Govern) | Anypoint Flex Gateway (Envoy-based). **Two gateways required in your private space, one ingress and one egress.** All A2A and MCP traffic is routed through it "even if the target system is unsecured". | Your private space |
| **Agent Visualizer** (Observe) | Node/edge map of the agent network, declared and runtime edges, environment layers, detail cards with metrics, links to logs and traces, governance indicators showing which edges are gateway-protected. | Anypoint SaaS |

Pillars are independently adoptable: registry+governance without the broker, or the broker over agents governed elsewhere.

### 2.2 The definition format

Specification-first YAML. `MuleSoft: Create an Agent Network Project` in Anypoint Code Builder produces `agent-network.yaml` (registry section: assets, connections, policies; context section) plus `exchange.json`. Publishing transforms each asset in the YAML into an A2A, MCP or LLM specification and pushes it to Exchange; assets declared but not previously registered are auto-registered.

A broker has a `card` section (an A2A Agent Card, url auto-populated as `${ingressgw.url}/broker-name`) and a `spec` section (LLM provider reference, instructions, tools with allow-lists, and `links` for inter-agent orchestration).

**Agent Network 2.0** (2026-07-14) added **Agent Script**, a graph language in `.agent` files: nodes, edges and triggers, where each node is either probabilistic (LLM classification, reasoning) or deterministic (routing, control flow). MuleSoft calls the split **"guided determinism"**. Same release added A2A Protocol 1.0 support, CI/CD deploys via Anypoint CLI, and natural-language network configuration in MuleSoft Vibes.

### 2.3 Identity: Trusted Agent Identity

Enforced entirely by Flex Gateway policies (Flex Gateway 1.11.4+, CH2 runtime), so backends need no code changes. Two patterns, configured per connection in the YAML:

- **OAuth 2.0 Token Exchange / On-Behalf-Of** (`kind: oauth2-obo`): RFC 8693 (or Microsoft Entra OBO) at the gateway. Each hop exchanges the incoming token for one scoped to the next service: `sub` (the end user) is preserved, `azp` and `aud` change, `exp` shortens, `scope` narrows. Supported natively by Keycloak 18+, Entra ID, PingFederate 10.3+, ForgeRock AM 7.0+; via APIs on Okta and Auth0.
- **In-Task Authorization Code** (`kind: in-task-authorization-code`): A2A-specific step-up MFA. Gateway returns a `WWW-Authenticate` challenge, agent completes an authorization-code+PKCE flow with a *secondary* IdP, token is extracted from the A2A message body at `params.message.parts[].data.auth_credentials.accessToken`, injected as a Bearer header and stripped from the body. Documented use cases: high-value financial transactions (PSD2 SCA), cross-org B2B, risk-based step-up. The docs are honest that the policy does **not** validate `acr`/`amr`.

Separately, **GoDaddy Agent Name Service** integration (2026-02-19 blog, 2026-02-17 release note): DNS-published verified agent identities, per-version certificates, a tamper-proof transparency log, ingested into a private Exchange by a scheduled Agent Scanner using GoDaddy API credentials.

### 2.4 Policies available at the gateway

- **A2A**: Agent Card, PII Detector, Prompt Decorator, Schema Validation
- **MCP**: Attribute-Based Access Control, Schema Validation, MCP Support
- **LLM/AI**: AI Prompt Decorator, AI Prompt Guard, AI Prompt Template, AI Basic Token Rate Limiting
- **Telemetry**: A2A and MCP telemetry exported to OpenTelemetry

Policy bundles can be applied to a workflow before execution. Agent Fabric configures the policies named under a `spec` section onto Flex Gateway automatically.

### 2.5 Observability, today versus roadmap

**Today**: logs and traces from workflow executions viewable post-execution in Runtime Manager; two counters published from policy code through Envoy's native stats interface, `a2a_total_calls` and `mcp_total_calls`, labelled by path, status, method and tool; Anypoint Monitoring collection; the Visualizer map.

**Explicitly future** in the same document: OpenTelemetry distributed tracing, agent health monitoring, multi-agent coordination monitoring (including circular-invocation detection), per-agent cost tracking, **cognitive tracing as an immutable audit trail**, session playback, DAG visualisation.

That last group matters for the comparison: the parts of Fabric's observability story that would compete with RFA's evidence chain are roadmap, not shipped.

### 2.6 Their own stated architectural limits

- LLMs "can only handle around 20-25 tools per context before starting to generate inaccuracies"; use allow-lists to trim.
- A flat network gives the broker "option paralysis", degrading both accuracy and determinism; hence mandatory hierarchy (Conway's-law trees or domain-driven grouping). A trade report of the same guidance puts it at roughly 8-10 actions per agent.
- Role management integration with HR systems and Active Directory is "an active area of discussion" and on the roadmap (2026 trade interview).

### 2.7 Cost shape

No public price. Structural requirements: an Anypoint Platform subscription, a private space, two Flex Gateways, CloudHub 2.0 capacity for every broker. Third-party surveys put whole-platform mid-market first-year TCO at $350k-600k+ including implementation and staffing; **that figure is for Anypoint overall, not for Agent Fabric as a line item**, and should not be quoted as an Agent Fabric price.

---

## 3. What is genuinely common

Both systems agree on more than a skim suggests:

1. **Heterogeneity is the premise.** Neither assumes one framework. Fabric registers Agentforce, Bedrock, Vertex, Copilot and custom agents; RFA's audience decision (2026-08-17) is any organization, with local packs and remote members "hosted elsewhere, possibly by another org, on another framework".
2. **MCP for tools, A2A vocabulary for capability description.** Fabric routes A2A and MCP traffic and its broker card *is* an A2A Agent Card. RFA's member card is A2A-card-compatible by deliberate choice (wire sect. 6), and its task states are a strict subset mapped onto A2A's `TaskState`.
3. **Identity must be stamped, never self-asserted.** Fabric refuses anonymous scripts and reaches for DNS-backed provenance. RFA derives `origin`, `from` and `home` from the authenticated principal and ignores any client-supplied value.
4. **A chokepoint is the governance design.** Fabric routes everything through Flex Gateway "even if the target system is unsecured". RFA makes every room action an MCP tool call against one hub that owns its store exclusively.
5. **Discovery is a first-class problem, not a config file.** Registry and scanners on one side; roster, capability cards and content-addressed digests on the other.
6. **Humans are in the loop as a designed state, not an exception.** Fabric persists HITL state in Object Store; RFA has human principals, supervisor role, approval cards with a clock, and floor control.
7. **Both call out prompt-level attack surface.** Fabric ships Prompt Guard and PII Detector policies; RFA's principle 6 makes attention mention-gated explicitly as a prompt-infection control and principle 7 makes every inbound message untrusted.
8. **Both refuse to standardise agent internals.** Fabric's YAML "is agnostic to MuleSoft and decouples the definition of the agent network from its execution"; RFA specifies observable behaviour only.

---

## 4. Where they differ structurally

### 4.1 The interaction primitive: a call tree versus a room

Fabric's unit is a **directed delegation**: broker to sub-broker to agent, request in, result out. There is no shared conversation, no roster an agent can read, no presence, no ambient context, no way for two agents to see the same message. A2A 1.0 has no multi-party primitive either, which is why the hierarchy is mandatory rather than stylistic: the only way to compose is to nest routers.

RFA's unit is a **room**: an append-only log with `seq`, a roster with `epoch`, presence leases, mention-gated attention, and durable-append-is-delivery. Every member sees the same history under the room's visibility policy.

This is the difference that generates most of the others. A call tree needs a router; a room needs addressing. A call tree's audit is a trace; a room's audit is the log itself.

### 4.2 Who decides who does the work

| | Agent Fabric | RFA |
|---|---|---|
| Mechanism | LLM broker picks the agent, or Agent Script routes deterministically | Capability-based addressing, plus a task board with atomic claims |
| Direction | Push (work is dispatched) | Both (direct address, or claim from the board) |
| Failure mode | Router misroutes; option paralysis at scale | Nobody claims; wrong capability match |
| Mitigation | Hierarchy, tool allow-lists, guided determinism | Card digests, `task_conflict` refusals, evidence-gated completion |

Fabric adds an LLM hop, and therefore an LLM failure mode, in front of every request. RFA's routing has no model in it, which is cheaper and more predictable but pushes the "which agent?" question onto the caller or the capability match.

### 4.3 Where the agent runtime lives, and what that makes possible

Fabric hosts **brokers** on CH2. It does not host agents. This is a defensible and deliberate choice, and it has one hard consequence: **Fabric can only govern what crosses a network boundary.** A registered agent that reads a file, holds a credential, spawns a process, or calls a model directly from inside its own runtime is invisible to Flex Gateway.

RFA hosts the agents. Which is why it has things Fabric has no place to put:

- a **write fence** with two doors (an in-process tool callback plus an OS sandbox established per `query()`, re-proven at every boot)
- a **tool declaration** that is enforced by three mechanisms (`allowedTools`+`canUseTool`, the SDK's `tools` option, `disableClaudeAiConnectors`)
- **memory** (gated, episodic, per-pack) and **knowledge** with provenance and a duplicate-page check
- per-run **scratch workspaces** and CoW-clone isolation

And, symmetrically, why RFA's containment story evaporates for a remote member: for a guest, RFA has budgets, quarantine, claims and history clamps, and nothing else. That is exactly the territory Fabric's gateway owns.

### 4.4 Identity: two different questions

Fabric answers **"on whose behalf is this call being made to this backend?"** with RFC 8693 token exchange per hop, preserving `sub` while narrowing `aud` and `scope`, plus step-up MFA against a secondary IdP.

RFA answers **"which principal class is speaking in this room, and which organization do they belong to?"** with hub-stamped `origin`, `from` and `home`, membership tokens, human keys, and admission records carrying pinned key thumbprints.

These are complementary. RFA has **no end-user identity propagation at all**, and explicitly deferred RFC 8693 ("token exchange is a T2 concern, not a T1 one", wire sect. 4.2). The moment an RFA-hosted agent calls a real enterprise API on a named user's behalf, that gap becomes an audit finding, and Fabric's answer is the standard one.

Conversely Fabric has nothing resembling `home`, no notion of a message origin class, and no protection against an agent named `human-oversight` sitting in a conversation, because it has no conversation.

### 4.5 Evidence

RFA: an append-only log, `prev_hash` over RFC 8785 canonical JSON, `content_hash` for redaction-changed events, verification authority, `rfa log verify`, evidence-gated task completion. Tamper-evidence is a property of the wire.

Fabric: two Envoy counters and post-hoc logs and traces in Runtime Manager today; the immutable cognitive audit trail is on the roadmap. Breadth of operational telemetry is far ahead of RFA's; **tamper-evidence is not there yet.**

### 4.6 Concurrency

RFA-0.8 exists because RFA hosts stateful runtimes that share an identity, a workspace, a memory store, SDK sessions and a task board: keyed turn lock, dispatcher with per-conversation FIFO, reservation-then-settle budget admission, account leases lent across blocked waits, approval-card consumption as an idempotency key, per-run scratch, resource-keyed claims with refuse-never-wait semantics.

Fabric mostly does not have this problem, because its agents are HTTP services someone else scales, and it says so implicitly: state that must survive is put in Object Store, brokers scale on CH2, memory is shared across broker replicas so sticky sessions are not needed. It also offers **nothing** for it: if two brokers hit the same stateful agent at once, that is the agent owner's problem. There is no reservation ledger, no per-run workspace, no claim fence.

Reading that honestly: RFA is far ahead here **partly because it took on a problem Fabric declined**.

### 4.7 Cost control

Fabric: AI Basic Token Rate Limiting as a gateway policy, plus LLM Governance (GA around April 2026) for centralised token, cost and data-flow visibility across third-party models. Rate limiting and reporting.

RFA: dollar-denominated budgets in a ledger (`agent_spend` plus reservations on `account_leases`), per-day caps, admission that reserves before a run starts and settles the real cost on every error path, refusal when the ledger says no.

RFA enforces at admission in money; Fabric throttles at the wire in tokens and reports in money. RFA's is the stronger control; Fabric's covers models RFA never sees.

### 4.8 Reliability and evaluation

RFA: `npm run evals` as a pass^4 reliability gate that prints its measured flake rate, a parity gate run twice (second under load for concurrency-touching diffs), a judged review queue, and `rfa agent reflect` distilling the judged record into proposed lessons.

Fabric: **I found no first-party customer-facing evaluation or regression gate for registered agents.** MuleSoft has published a reproducible evaluation framework, but it is for **MuleSoft Vibes**, their own coding agent, not a product surface customers point at their own agents. A consultancy page claims Agent Fabric "includes regression testing for agents"; that is a third-party claim I could not corroborate in the documentation. **Marked uncertain.** The Visualizer does surface confidence scores and transaction times.

### 4.9 Deployment and entry cost

Fabric: Anypoint subscription, private space, two Flex Gateways, CH2, Anypoint Code Builder, Exchange. A platform decision with a procurement cycle.

RFA: a directory containing `rfa.json`, an npm package, `rfa init`, `rfa up`. Minutes, no control plane, no gateway, no vendor.

### 4.10 Discovery: catalogue versus roster

Fabric answers **"what agents exist anywhere in my org?"** with a catalogue, scanners that crawl Bedrock/AgentCore, Vertex AI and Azure Copilot, curated public MCP servers, and DNS-verified external identities. Design-time, org-wide, cross-cloud.

RFA answers **"who is in this room right now, awake, and what can they do?"** with a roster, presence leases and capability digests. Runtime, room-scoped.

**RFA has no answer to the inventory question at all.** For a self-hosting organization with agents in three clouds, that is a real gap, and it is the pillar of Fabric that has no RFA counterpart whatsoever.

---

## 5. Where MuleSoft is better

1. **Org-wide inventory across clouds.** Scanners plus a catalogue. RFA has nothing here.
2. **End-user identity propagation.** RFC 8693 / Entra OBO per hop, with a documented IdP support matrix, and step-up MFA for high-risk operations. RFA deferred this.
3. **Egress control.** Every outbound agent call traverses a gateway that can apply PII detection, schema validation, ABAC and rate limits. RFA's equivalent fields were found inert.
4. **Governing agents it does not host.** Because the control point is the network, Fabric's governance works on anyone's agent on anyone's framework. RFA's strongest controls only apply to packs it runs.
5. **Verified external agent provenance.** DNS-published, per-version certificates, transparency log. RFA's equivalent is an operator pasting a card and pinning a thumbprint once.
6. **A deterministic orchestration language.** Agent Script's node/edge/trigger graph with an explicit probabilistic-versus-deterministic split is a real answer to multi-step business processes. RFA has tasks, claims and candidate fan-out, but no workflow graph.
7. **Enterprise readiness in the boring sense.** Regional clouds (Canada, Japan since April 2026), support contracts, HA, monitoring, RBAC, a release cadence, and someone to call.
8. **Breadth of operational telemetry.** Even pre-OTel, Runtime Manager and Anypoint Monitoring exceed what a single-hub RFA instance offers.

## 6. Where RFA is better

1. **Multi-party rooms with presence.** No equivalent exists in Fabric, in A2A, or (per wave 01) in any surveyed protocol. This remains the differentiator.
2. **Runtime containment.** A gateway cannot see inside a process. RFA's two-door write fence, tool-declaration enforcement and per-run OS sandbox constrain what an agent does *before* anything reaches the network.
3. **Tamper-evident history.** Hash chain over canonical JSON, verification authority, a verify command. Fabric's counterpart is roadmap.
4. **Atomic, evidence-gated work.** Claim leases, `task_conflict` refusals rather than queueing, resource-keyed claims with segment-wise prefix matching, completion gated on evidence.
5. **Concurrency correctness for stateful agents.** An entire specification with a live gate behind it.
6. **Money-denominated admission control.** Reserve before the run, settle the real cost on every path, refuse when the ledger says no.
7. **A reliability gate that measures answers.** pass^4 with a printed flake rate, a parity gate, a judged queue, reflection. Fabric ships nothing customer-facing here that I could verify.
8. **Agent memory and provenance-tracked knowledge.** Fabric's brokers keep conversation memory shared across replicas (so no sticky sessions), but there is no per-agent memory store with gating, episodes and consolidation, and no knowledge layer with provenance and duplicate detection. A registered agent brings its own or does without.
9. **Entry cost and reversibility.** An npm install against a directory, versus a platform subscription and two gateways.
10. **Openness.** Apache-2.0 specification, an interop artifact, and a minimal client that any MCP-speaking agent can write in an afternoon with no SDK. Fabric's YAML is portable in principle; the registry, gateways and CH2 deployment are not.
11. **The human as a room principal.** `origin: human`, supervisor role, floor control, injection, approval cards with a clock. Fabric's HITL is a workflow pause, not a participant.

## 7. Where each is weaker than it looks

**Agent Fabric**
- "Govern any agent" means *govern any agent's network traffic*. Anything the agent does inside its own runtime is out of scope.
- The broker is an LLM, so routing inherits LLM failure modes. Their own guidance (hierarchy, 20-25 tools, option paralysis) is an admission.
- The most compelling observability items are future work.
- Lock-in is structural: registry + YAML + compiled brokers + CH2 + two gateways. An analyst's warning is explicit that switching costs rise materially with each registered agent, and CIOs should ask about the exit path.
- OBO requires an IdP with RFC 8693 configured, plus token-exchange permissions per audience. Many organizations do not have that today.
- A production report of adapters that passed testing and failed on undocumented rate limits is worth taking at face value as an integration-effort signal.

**RFA**
- One hub process; watchers and waiters are process-local, so it is single-hub HA only, and the per-room event log lives in memory as well as on disk.
- No inventory, no egress, no identity propagation. Three real enterprise checkboxes, all absent.
- Admission hardening is parked, so cross-org trust is manual thumbprint pinning that has never been exercised against a real uncontrolled counterparty. The rung 7 guest scenarios prove the code paths, not interop.
- Native push is blocked upstream by the MCP v2 SDK's closed subscription-filter set.
- The write fence is version-fragile by design and must be re-proven after every SDK bump.
- The reliability gate costs real money per run (~32 live trials, about two dollars), which caps how often it can run.
- One person, private repository, no support contract, no regions, no RBAC beyond roles and human keys.

---

## 8. Positioning: does this change RFA's story?

The 2026-08-21 direction review picked thesis B: the wire is a differentiated substrate and the remaining work is platform. Nothing here disturbs that, but it sharpens the framing:

- **If RFA's pitch is "govern your enterprise's agents", it loses.** Fabric has the catalogue, the gateway, the identity story, the regions and the salesforce. Competing there is competing on distribution.
- **If RFA's pitch is "your agents need somewhere to be, and something to talk in", Fabric has no product.** A room with presence, capability cards, evidence-gated tasks, per-run containment and a hash-chained history is not on anyone's roadmap that this survey found.
- **The most defensible sentence is the runtime one**: RFA controls what an agent does *before* it reaches the network, and it does so on a substrate an operator owns end to end. Everything Fabric enforces, it enforces at the edge of a black box.

## 9. What to steal, concretely

1. **Egress, as a first-class posture.** The single most valuable idea in Fabric's design. RFA already knows `sandbox.network` and `allowed_domains` were inert; Fabric shows what the shipped version looks like (a mandatory outbound path with policies on it). Even a minimal version, one documented outbound proxy the operator can point residents at, would close the loudest gap.
2. **Lifecycle state on capability assets.** Exchange tracks development / staging / production / deprecated. An RFA card has no lifecycle state, so a deprecated capability simply vanishes from a roster with no deprecation window.
3. **The 20-25 tools per context number.** It is an operational measurement worth citing in pack guidance. Nothing in `rfa agent new` warns an operator building a thirty-tool pack.
4. **A named decision on end-user identity.** RFA should not build OBO speculatively, but it should *record* that it does not propagate end-user identity to backends and say what an operator must do instead. Silence here reads as an oversight rather than a scope boundary.
5. **The "guided determinism" framing.** RFA's task machinery is already deterministic; the vocabulary for explaining probabilistic-versus-deterministic control flow to an enterprise reader is good and free.
6. **A modest inventory verb.** Not scanners across three clouds, but "what packs exist, what do they declare, and what can each reach" as one report. Most of the data already sits in `rfa doctor` and `rfa status`.

## 10. What not to copy

- **The LLM broker as the routing mechanism.** RFA's rooms already do capability-based addressing without an extra model hop and its failure modes.
- **Hierarchy as the only scaling answer.** It is Fabric's workaround for having no multi-party primitive. RFA has one.
- **A SaaS control plane.** It contradicts the self-hosting audience decision, and it is the exact component the lock-in critique targets.

## 11. The interop move, if it is ever wanted

An RFA hub is an MCP server, and Agent Fabric's registry catalogues MCP servers that brokers may call, with tool allow-lists. Registering a hub would let a Fabric broker `room_send`, read a roster, or create a task, giving it multi-party conversation, presence and a verifiable log that it cannot get from A2A.

The reverse direction (an A2A server facade inside the hub) stays rejected on the grounds already recorded in RFA-0.6 sect. 12: A2A has no delegation, no task forwarding and no multi-party primitive, so a facade must collapse the roster into one agent.

**This is a note, not a proposal.** It costs nothing to record and should not be built without a named counterparty, consistent with every other integration decision in this project.

---

## 12. Confidence and what would change this

| Claim | Confidence | What would change it |
|---|---|---|
| Fabric hosts no agent runtime, only brokers | High | A documented agent-hosting surface |
| No multi-party / presence primitive anywhere in Fabric | High | Any roster or shared-conversation API |
| Immutable audit trail is roadmap, not shipped | Medium-high | A shipped cognitive-tracing surface; the deep dive is explicit but dated |
| No customer-facing eval gate for registered agents | Medium | First-party docs for agent evaluation outside MuleSoft Vibes |
| Lock-in is material | Medium (analyst opinion, not measured) | A documented export path for registry + broker definitions |
| The 20-25 tool ceiling | Medium (vendor observation, not published measurement) | An independent benchmark |
| Pricing shape | Low as an Agent Fabric figure | Any published Agent Fabric line-item price |

All Agent Fabric statements come from vendor material or trade press. No hands-on verification was possible.
