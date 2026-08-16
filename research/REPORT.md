# Deep Research: A Communication Protocol for AI Agents

**Rooms, presence, capability discovery, and real-time agent-to-agent messaging**
Research date: August 16, 2026. Method: 13-agent parallel research sweep (industry specs, MCP internals, academic literature, classic MAS, real-time messaging protocols, frameworks, community, security, plus 4 targeted gap-fills), 70 papers/specs downloaded to `research/papers/` (see [INDEX.md](papers/INDEX.md)) and read from primary sources.

---

## TL;DR

**The thing you want to build does not exist yet, and every piece of it does.** As of August 2026, no protocol or shipping system combines the three things you described: (a) room membership, (b) presence states like ready/busy/offline, and (c) MCP-style typed capability discovery. This was verified across all major protocols (MCP, A2A, ANP, AGNTCY/SLIM, AITP, LMOS, Coral), all major frameworks (AutoGen, LangGraph, CrewAI, OpenAI Agents SDK, Claude Agent SDK...), and four hands-on-inspected room implementations. The academic literature explicitly calls for it (the 2504.16736 survey's "Agent Mesh Protocol" future-work section is nearly a spec of your idea) and nobody has standardized it.

**Your instinct to build on MCP is correct, and the evidence is overwhelming.** MCP won the protocol war: 342M monthly PyPI downloads vs 15M for A2A (a 22x gap, stable-to-widening). The community default for agent-to-agent communication is "an agent behind an MCP server". The sanctioned way to add rooms/presence to MCP is its formal extensions framework (reverse-DNS extension IDs, shipped July 2026), and a July 2026 peer-reviewed study confirmed MCP carries inter-agent coordination at roughly half the complexity of A2A.

**The recommended architecture** (each element traced to evidence below): a **Room Hub as an MCP server**. Agents join by calling MCP tools (`join_room`, `send`, `listen`), discover each other through a roster where every member carries an A2A-Agent-Card-compatible capability descriptor, receive presence pushes over MCP's `subscriptions/listen` stream via a custom extension, and run the room's membership semantics on SLIM's proven group state machine (join/welcome/roster-update/heartbeat/rejoin, with a monotonic membership epoch). Presence itself should copy XMPP: a tiny closed enum (`ready | busy | away | offline`) plus free text, with a content-addressed **capability digest** piggybacked on every presence update so capabilities are fetched at most once per unique version.

**The two hardest problems are not transport.** They are (1) trust: a message from another agent is untrusted input, capability claims are attack surface, and authority must never derive from message text; and (2) token economics: rooms full of chatty agents burn tokens and degrade results, so isolation must be the default and communication deliberate.

---

## 1. What you are really building

Your description ("agents join a virtual room, discover each other with name, state, capabilities, and talk in real time") is structurally a **chat-presence problem plus a typed-RPC problem**. This matters because both halves were solved separately, decades apart:

- The chat-presence half was solved end-to-end by **XMPP** (2004): presence stanzas with ready/busy states, Multi-User Chat rooms with a strict join contract, service discovery, and capability advertisement piggybacked on presence.
- The typed-RPC half was solved by **MCP** (2024): typed tool discovery, schema negotiation, streaming.

Nobody has glued them together as a standard. The gap analysis across every protocol researched:

| Protocol | Rooms / groups | Presence (ready/busy/offline) | Capability discovery | Status Aug 2026 |
|---|---|---|---|---|
| **MCP** (2026-07-28) | No (strict 1:1 client-server) | No (ping even removed) | Yes: `tools/list`, schemas | Won. 342M dl/mo, AAIF-governed |
| **A2A** v1.0.1 | No (point-to-point tasks) | No | Yes: Agent Card skills | Enterprise niche, 15M dl/mo |
| **ACP** (IBM) | No | No | Manifest at `/.well-known` | Dead: merged into A2A Aug 2025 |
| **ANP** | No (P2P DMs) | No | JSON-LD descriptions | Spec-first, thin adoption |
| **AGNTCY / SLIM** | **Yes** (moderated group channels, MLS-encrypted) | Binary online/offline + heartbeat | Only routable method names | Cisco/LF, IETF draft |
| **AITP** (NEAR) | **Yes** (multi-party threads) | Planned only (AITP-07) | Per-thread capability schemas | NEAR hub only |
| **LMOS** (Eclipse) | No | **Yes** (TTL + keep-alive directory) | WoT actions with JSON Schema | Production at Deutsche Telekom |
| **Coral** | **Yes** (threads as MCP tools) | Inferred only (connected/waiting) | One free-text description | Closest match to your UX |
| **Matrix/AgentTeams** | **Yes** (Matrix rooms) | Deliberately avoids m.presence | None (role strings) | Shipping since Mar 2026 |
| **agent-room** | **Yes** (MCP rooms) | **Yes** (3 wake-up models, leases) | None (role strings) | Grassroots, 2026 |
| **Claude Code teams** | Team mailboxes + roster | tempo: active/idle/blocked | None (kind/agent strings) | Proprietary, experimental |

Read the last column of the middle three columns together: **rooms exist, presence exists, capability discovery exists, and no row has all three.** The hands-on inspection of the four closest shipping systems (Claude Code cross-session messaging, agent-room, MCP Agent Mail, AgentTeams-on-Matrix) confirmed: "none of the four does real capability discovery; all stop at kind/role/model strings." That is your protocol's novel contribution.

---

## 2. The landscape in detail (August 2026)

### 2.1 MCP: the substrate that won, and its exact limits

**Governance and adoption.** MCP moved from Anthropic to the Agentic AI Foundation (Linux Foundation, Dec 9 2025, co-founded by Anthropic, OpenAI, Block). 10,000+ public servers, ~97M monthly SDK downloads at donation time, 342M by Aug 2026. Every major host (Claude, ChatGPT, Copilot, Cursor, Gemini) speaks it.

**The 2026-07-28 spec revision is the largest ever and it matters enormously for your design.** The protocol went **stateless**: the initialize handshake and `Mcp-Session-Id` are removed, every request self-describes via `_meta` (protocolVersion, clientInfo, clientCapabilities), and servers must implement `server/discover`. All server-initiated requests (sampling, elicitation, roots/list) were replaced by client-driven Multi Round-Trip Requests (MRTR): the server returns `resultType: "input_required"` with an `inputRequests` map and a signed opaque `requestState` blob; the client answers and retries. **Sampling, Roots, and Logging are deprecated outright** (12+ month window, earliest removal ~July 2027). The only surviving server-to-client push channel is `subscriptions/listen`: one long-lived opt-in stream per client, with typed notification filters and acknowledged subscriptions.

Deployment reality (measured directly, Aug 16 2026): only Claude-family hosts speak 2026-07-28 in production. VS Code 1.133 still hardcodes `LATEST_PROTOCOL_VERSION = "2025-11-25"` in source; Cursor shows no 2026-07-28 signal; even the new TypeScript SDK v2 puts "no 2026-07-28 byte on the wire by default". **Consequence: build on 2026-07-28 semantics (extensions, subscriptions/listen, MRTR, server-minted handles) but serve dual-era through the v2 SDKs so legacy hosts can join with degraded poll-based presence. Never build on sampling, elicitation/create, roots, or Mcp-Session-Id.**

**What MCP gives your protocol:**
- The capability grammar: `tools/list` with JSON Schemas, `listChanged` notifications, cacheable list results (`ttlMs`/`cacheScope`).
- `server/discover`: a standardized "who are you, what can you do" probe, with TTL-based caching. Your `agent/discover` should mirror it.
- The extensions framework (SEP-2133, Final): a room protocol ships legally as `com.yourorg/rooms`, negotiated via `capabilities.extensions`, reserving method prefixes (`room/`), adding notification types (`notifications/room/roster`), and adding filter fields to `subscriptions/listen`. The `io.modelcontextprotocol/tasks` extension is the exact precedent: it added `taskIds` filters and `notifications/tasks` this way.
- The tasks extension: an 8-state-compatible async task lifecycle (`working / input_required / completed / failed / cancelled`) with `tasks/get` polling and `tasks/update` for answering outstanding input requests.
- OAuth-based auth, including a client-credentials extension for headless machine-to-machine agents.
- W3C trace context propagation, now spec-official (SEP-414): `traceparent`/`tracestate`/`baggage` unprefixed in `_meta`.

**What MCP structurally cannot give you** (each verified against spec text):
1. **Topology**: strict 1:1 client-server links, star per host. No peer concept, no room, no roster.
2. **Presence**: no member-state primitive, no heartbeat (ping removed), registry is a static install-time catalog.
3. **Fanout**: notifications are per-connection. Room broadcast means the hub duplicates events across N per-member `subscriptions/listen` streams (the old "MUST NOT broadcast" rule was scoped to one client's streams and is gone in 2026-07-28, so this is legal, just architectural work).
4. **Conversation state**: no conversation IDs, no message addressing, no sender identity. The York study (arXiv 2607.23884) empirically graded MCP "not met" on multi-turn conversations.
5. **Peer initiation**: a server cannot spontaneously contact an idle client. An agent-as-MCP-server can only answer when called, or piggyback questions on an in-flight request (MRTR). Peer-initiated interrupts need your room layer.
6. **Reconnect replay**: SSE resumability was removed in 2026-07-28. Your extension must define its own sequence numbers and a `room/sync` method.

The MCP maintainers have consistently steered agent-graph/presence proposals out of core scope for 18+ months (discussions #111, #330), and the 2026 roadmap channels "agent communication" into Tasks only. **Do not wait for MCP core to add rooms. It will not.**

### 2.2 A2A: reuse the vocabulary, do not speak the protocol

A2A v1.0 shipped March 2026 under the Linux Foundation (v1.0.1 May 2026); IBM's ACP was folded into it in Aug 2025. It is genuinely GA inside Azure AI Foundry, Copilot Studio, Bedrock AgentCore, Gemini Enterprise, AgentForce, watsonx Orchestrate.

But the deep-dive verdict is unambiguous:
- **No multi-party primitives exist, and none are coming**: the official extension registry contains no group-session extension, not even a draft, and the agent-registry discussion (#741) has been open and unconverged for 14 months.
- **Adoption is vendor-shaped**: the Linux Foundation's own first-anniversary press release names zero end-user enterprises. Named practitioner reports are anonymous and mixed; a megacorp insider: "not a single use case I witnessed used A2A in the final product." Downloads are 4-5% of MCP's and the gap is not closing.
- Full compliance means carrying three transport bindings (JSON-RPC+SSE, gRPC, REST).

**What to take from A2A anyway** (cheap, high-value):
- The **Agent Card schema** as your capability-descriptor format: `{name, description, version, capabilities, securitySchemes, skills[{id, name, description, tags, examples, inputModes, outputModes}], signatures}`. It is the industry's canonical capability shape, emitted and consumed by every enterprise platform. A room member whose descriptor is card-compatible can later be projected as an A2A endpoint mechanically.
- The **task state machine**: `submitted / working / input-required / auth-required / completed / failed / canceled / rejected`. Map your room task states onto it (agent-room already does exactly this).
- **JWS-signed cards** over JCS canonicalization (RFC 8785 + RFC 7515), but make signing mandatory where A2A left it optional.
- The extensions idiom (URI-declared, `required` flag) and `input-required` as the mid-task question state.

### 2.3 The room-shaped systems: what to steal from each

**Coral Protocol** (whitepaper arXiv 2505.00749, Coral v1 Sept 2025) is the closest existing match to your UX: every agent connects as an MCP client to a Coral Server exposing room primitives as MCP tools. Current tool surface (read from source, Aug 2026): `coral_create_thread`, `coral_add_participant`, `coral_send_message` (with @mentions), `coral_wait_for_message` / `coral_wait_for_mention` / `coral_wait_for_agent` (long-polled blocking waits, 60s cap, replay-cursor to close the poll-gap race), `coral_close_thread`. The roster moved to an MCP **resource** (`coral://state`) with per-agent `{agentName, agentDescription, agentConnected, agentWaiting, agentSleeping}`. Weaknesses that define your improvement targets: presence is inferred from transport rather than declared, roster changes are not pushed to agents, identity is a capability URL (UUID secret in the path), waiters are process-local, and it is pinned to pre-2026 stateful MCP.

**AGNTCY SLIM** (Cisco, Linux Foundation, IETF draft-mpsb-agntcy-slim) is the only industry-grade protocol with real group semantics, and its wire vocabulary is the state machine your room needs, verbatim: `DISCOVERY_REQUEST/REPLY, JOIN_REQUEST/REPLY, LEAVE_REQUEST/REPLY, GROUP_UPDATE, GROUP_WELCOME, GROUP_CLOSE, GROUP_ACK/NACK, HEARTBEAT, UPDATE_PARTICIPANT_STATE, REJOIN_REQUEST/REPLY` plus `MSG/MSG_ACK/RTX_REQUEST/RTX_REPLY` for reliable delivery. Key mechanisms:
- Every `GROUP_UPDATE` broadcasts the **full roster** (not a diff) with per-member `ONLINE/OFFLINE` state, acked by all members: membership is strongly consistent.
- The **MLS epoch doubles as a membership version number**: every add/remove bumps it, heartbeats carry it, and stale-epoch members are NACKed into a rejoin re-key. Even without MLS encryption, copy the pattern: a monotonic room epoch stamped on presence messages.
- Crash detection is a decentralized one-way `HEARTBEAT` with per-peer missed-interval counting.
- Groups are moderated: only the moderator (or a Channel Manager service) changes membership.

**agent-room** (grassroots MCP room server, 2026) contributes the battle-tested wake-up menu and tuning constants: (1) long-poll `room_listen` stamping a `listenUntil` presence lease that "expires naturally"; (2) IDE-client hooks at turn boundaries holding the agent's turn open in 30s blocks up to 30 min (raised from 6 min because agents "disappeared 6 minutes in"); (3) HMAC-signed webhook wake-ups for resident agents. Plus server-enforced turn modes (open/sequential/moderator) with tiered deadlines (150s first response, raised from 60s based on real agent latency; 300s renewals; 600s hard cap), and an evidence-gated task board (verifier must differ from producer; three-part evidence required) to kill "phantom delivery".

**Claude Code cross-session messaging + Agent Teams** (inspected live at the wire level) is Anthropic shipping a primitive version of your idea as a closed feature, which validates the need for an open protocol. Directly copyable decisions: a self-describing presence record per agent (name, kind, `tempo: active|idle|blocked`, `waitingFor`, `needs`, freetext detail, plus an explicit `peerProtocol: 1` version field); friendly-name-first addressing with an opaque short ref as tiebreaker and error-driven disambiguation; liveness via OS probe plus process-birth-time fencing (anti PID-reuse); a three-outcome delivery model (**delivered / held / refused**) with sender-visible disposition notices and expiry; anti-loop protections (per-sender rate limits, duplicate suppression, inbox caps); ~15 typed control messages (plan approval, shutdown handshake, permission escalation) multiplexed with chat over one mailbox; and the hard provenance rule that **inter-agent messages are marked as agent-origin and can never carry human consent**.

**AgentTeams on Matrix** shows what reusing a chat protocol buys (idempotent room identity via alias, membership, power levels, federation, optional E2EE) and what it costs: they deliberately do NOT use `m.presence` (Matrix's global presence collapses at scale and is disabled on matrix.org), splitting the concept into attention (mentions-gated, with non-mentioned messages buffered and replayed as context on mention), activity (typing renewal + read receipts), and lifecycle (Kubernetes CRDs outside Matrix). Matrix also lacks native streaming (MindRoom fakes token streaming by rapidly editing messages).

**MCP Agent Mail** is the pure-async pole: email semantics (to/cc, ack_required, importance, threads) over Git+SQLite, adjective+noun agent names, advisory TTL file leases for edit-collision prevention, no live presence at all. Proof of how far async-only gets you, and the reference design for resource reservation.

### 2.4 Identity layers (ANP, LMOS, and the discovery-infrastructure subfield)

- **ANP** contributes the best decentralized identity story: `did:wba` (web-based DIDs, key thumbprint embedded in the identifier) with per-request RFC 9421 HTTP Message Signatures. No rooms, no presence.
- **LMOS** contributes the only production presence mechanism among the majors: agents register WoT Thing Descriptions in directories with **TTL + periodic keep-alive refresh; expired agents drop out**. "Offline = registration expired" is the simplest robust presence design.
- Agent discovery is now its own research subfield with four architectures: **ANS** (OWASP: DNS-inspired registry + full PKI, protocol-agnostic capability records that embed MCP tool schemas or A2A cards), **NANDA Index** (MIT: lean <=120-byte index records pointing to signed JSON-LD "AgentFacts", TTL-based resolution, <5-min verifiable credentials for fast revocation, "quilt of registries" federation), **AGNTCY ADS** (content-addressed OASF records over a Kademlia DHT, Sigstore provenance), and **Verisign's DNS position** (agent metadata fits one UDP DNS response). For real-time semantic matching, **GRAIL** shows sub-400ms capability search by precomputing tags with a small model rather than LLM-parsing queries.

---

## 3. History: this was all built before, and why it died

### 3.1 FIPA/KQML had your entire feature list in 2002

The 1990s multi-agent wave built, in standardized detail, almost exactly your system:

| Your requirement | FIPA/KQML equivalent (1994-2002) |
|---|---|
| Agent registry + identity | AMS "white pages": register/deregister, agent IDs |
| Presence states | AMS lifecycle: `initiated/active/waiting/suspended/transit`, with **per-state message handling rules** (buffer while suspended, redirect in transit) |
| Capability discovery | Directory Facilitator "yellow pages": `df-agent-description` with services, protocols, **lease-time**; query-by-example template search |
| Live roster updates | **DF `subscribe`: a persistent search pushing registry changes** (join/leave/modify) until cancelled |
| Room-scoped mediation | KQML facilitators (one per local agent group) with five mediation verbs: advertise, recommend (return a name, then talk direct), broker (relay), recruit (forward, reply direct), subscribe |
| Message envelope | FIPA-ACL 13 parameters: `conversation-id` (thread), `reply-with`/`in-reply-to` (correlation), `reply-by` (in-band deadline), `reply-to` (redirect), multicast receiver sets, `X-` extension prefix |
| Q&A conversation | fipa-request protocol: request -> refuse \| agree -> failure \| inform-done \| inform-result, with a universal `cancel` meta-protocol and `not-understood` at any point |
| Task allocation | Contract Net (Smith 1980): call-for-proposals with deadlines, and **presence-aware refusals: BUSY vs INELIGIBLE vs LOW RANKING**, plus `node-available` messages so idle agents can pull work |
| Streaming | KQML `stream-all` + `eos` end marker; Smith's interim vs final reports |

**Why it failed** (from the insiders' own post-mortems, all read from primary sources):
1. **Untestable semantics.** FIPA defined message meaning over agent mental states (beliefs, intentions, sincerity). Singh's 1998 critique: you cannot verify what an agent believes, so compliance was undecidable; the sincerity axioms made the language formally unusable for negotiation. **Lesson: specify observable message sequences and state machines, never internal states.**
2. **Standardized semantics, not services.** KQML's own authors (1999): "there is no service where one can register an agent by just sending a registration message." Naming, registration, transport, and APIs were left per-implementation, and the language fragmented into non-interoperating dialects. **Lesson: the boring parts (join, naming, registry API, presence events, auth, errors, transport binding) ARE the standard.**
3. **Wrong substrate.** Lisp-ish syntax and IIOP transport while the world adopted HTTP/XML. **Lesson: stay on HTTP/JSON-RPC/SSE. MCP got this right.**
4. **Entry cost.** You needed ACL + content language + ontology + protocol library before two agents could say anything. **Lesson: a minimal client must do one useful thing in an afternoon.**
5. **No reference implementation until JADE**, whose adoption came largely from its protocol behaviour library and its Sniffer (live conversation sequence diagrams). **Lesson: ship a reference server and conversation-level debugging tooling with the spec.**

Also worth carrying forward: Singh's 1998 prescription that agents join groups **in roles that confer commitments** ("pm agents answer spec queries") is a ready-made model for room roles. And Linda tuple spaces (1985) supply the async-handoff semantics (atomic claim, blocking match, leases, scoped spaces) that modern agent task queues keep reinventing badly.

### 3.2 XMPP solved the presence half completely

- **Presence enum** (RFC 6121): available/unavailable plus `show: chat|away|dnd|xa`. Map directly: ready = chat, busy = dnd, offline = unavailable. Keep the enum tiny and closed; the server owns fanout and disconnect detection.
- **MUC join contract** (XEP-0045): on join, the service sends, in mandated order: (1) presence of all existing occupants, (2) your own reflected presence with status code 110 as the "roster complete" marker, (3) history, (4) live traffic. This ordering contract is the answer to "an agent joins and discovers who is there before talking". Roles are session-scoped, affiliations persist: the session-state vs persistent-permission split.
- **Entity Capabilities** (XEP-0115), the single best idea to steal: every presence broadcast carries a **content-addressed hash of the full capability set**. Receivers cache hash -> capabilities and fetch the manifest at most once per unique hash. N agents learn each other's capabilities nearly for free. Combine with MCP: hash the `tools/list` result.
- **SPADE 3** (IEEE Access 2020) ran multi-agent systems on XMPP presence for years, including using presence statuses as distributed synchronization barriers. Its niche-ness is also a warning: XML tooling friction. Keep the wire JSON.

Other real-time systems contribute the operational checklist: **MQTT** retained-messages + Last-Will (broker-held crash obituaries, late joiners get last known state instantly, will-delay debounces reconnect flapping); **Discord Gateway** (heartbeat with explicit ACK to catch zombie connections, monotonic event sequence + resume token, intents as server-side event filtering, rate budgets); **NATS micro** (scatter-gather `$SRV.PING/INFO/STATS` discovery with zero registry infrastructure, queue groups for free agent-replica load balancing); **Matrix** (membership-as-durable-state: roster says who belongs, presence says who is awake; and its negative lesson: scope presence to the room, never to a global subscription graph); **Redis pub/sub** as the anti-pattern (fire-and-forget with no retained state cannot back a room alone).

Transport consensus for 2026 (from MCP's own transport rationale, the ACP transport RFD, Discord, and Slack): default to **Streamable-HTTP-style POST-to-send plus one or two long-lived SSE streams over HTTP/2, with WebSocket as an optional upgrade on the same endpoint**; regardless of framing: heartbeat with ack, monotonic event IDs, resume tokens, server-side event filtering.

---

## 4. What the academic literature says

Seventy papers were downloaded and read. The convergent findings:

**The endgame is a layered federated stack, not a winner protocol.** The June 2026 TUM taxonomy (arXiv 2606.19135, 9 protocols, 5 dimensions), the SJTU survey (2504.16736), and the interop survey (2505.02279) all predict the same stack: identity/transport at the bottom, discovery manifests/registries, structured execution (MCP), interaction/tasks/streaming (A2A-like), schema negotiation on top. **Your room protocol slots into the interaction layer with hooks down to discovery, exactly where the literature says the gap is.** The SJTU survey's future-work section explicitly calls for an "Agent Mesh Protocol" inspired by human group chats: shared history, group semantics, message ordering, dynamic membership. That is your product.

**Empirical protocol benchmarks (ProtocolBench, ICML 2026):** protocol choice is workload-conditioned. A2A's nearly-stateless HTTP + idempotent retries preserved 98.85% of answer discovery under cyclic node kills (vs 81-92% for others); ACP-style REST had the lowest latency; DID/E2E stacks (ANP, Agora) cost 17-36% latency. Per-message adapter overhead is negligible against multi-second LLM inference. **Lessons: stateless-recoverable endpoints and idempotent retries beat heavy sessions; optimize token efficiency and reconnection semantics, not wire-format microseconds; make the crypto-identity tier optional.**

**The direct precedent for your design** is the Internet of Agents framework (arXiv 2407.07061): an "instant-messaging-app-like" platform with an agent registry storing capabilities and current status, semantic agent search, group chats, WebSocket routing, an FSM of conversation states, and LLM-chosen next-speaker. Its measured failure modes are your requirements list: ~50% of inter-agent tokens were redundant rephrasing, and LLMs failed to switch conversation states unprompted. Protocol-enforced structure (explicit states, typed messages) is the mitigation.

**The minimal-wire argument** (Web of Agents position, ICML 2026): plain HTTP + capability advertisement at RFC 8615 well-known paths + session IDs + URL/DNS identity is sufficient; their retrofit of three protocols took ~200 LOC each and added 10-96ms against 3.3s of LLM inference. Counterweight to overengineering.

**Semantics research** (Cisco L8/L9, arXiv 2511.19699): standardize an envelope + a small performative registry (REQUEST/AGREE/REFUSE/INFORM, PROPOSE/ACCEPT/REJECT/COUNTER_PROPOSE, QUERY/SUBSCRIBE/PUBLISH) + interaction patterns (request-reply, pub-sub, N:N collaboration groups). Its new attack taxonomy (semantic injection, context poisoning, semantic DoS that exhausts LLM budget rather than bandwidth, downgrade attacks) belongs in your threat model.

**Session management debt** (arXiv 2604.02369) names your gap precisely: current protocol lifecycles assume short, synchronous, well-bounded interactions and "poorly model agents that join/leave dynamically and act asynchronously with intermittent availability". Presence at the protocol level is the cure.

---

## 5. What frameworks need from you

Across AutoGen, Microsoft Agent Framework, LangGraph, CrewAI, OpenAI Agents SDK, CAMEL, smolagents, Claude Agent SDK, and LlamaIndex, agent-to-agent communication reduces to three in-process patterns, and your protocol must carry all three:

1. **Agent-as-tool** (request/response with awaited result): the universal floor is `{name, description, call(task) -> result}`; smolagents literally calls sub-agents as functions. Every framework lets the model choose peers by reading name + description, exactly like MCP tool listings. **Your capability descriptor must be projectable into an LLM tool definition.**
2. **Handoff** (transfer of control with context payload): OpenAI `Handoff` + `input_filter`, LangGraph `Command{goto, update, graph}`, AutoGen `HandoffMessage{source, target, content}`. Hard-won lesson encoded in two frameworks' docs: **context transfer must be explicit and minimal by default** (pass the tool-call pair, not full history).
3. **Broadcast/room with subscription**: autogen-core's actor runtime (TopicId + TypeSubscription, `publish_message` vs `send_message`) is a fully worked-out room model; it was abandoned when Microsoft pivoted to in-process graphs + A2A at the boundary, which tells you frameworks want internal control flow kept private and a standard layer only at the boundary.

Additional required semantics extracted from framework failure modes: exact-match addressing (CrewAI's fuzzy role-matching is a chronic bug source); typed streaming events (token delta, tool-call start/end, agent switch, lifecycle); an `input-required` paused state for human-in-the-loop; protocol-owned termination and turn-taking (CAMEL's documented infinite thank-you loops); and `can_handoff_to`-style directional permissions on membership.

Integration surface: ship adapters shaped like the ones frameworks already have (a config object attached to an Agent + an auto-generated card endpoint; LangGraph auto-exposes every assistant as an A2A endpoint with an auto-generated card, which is the UX benchmark: **"join the room by pointing at a card URL"**).

---

## 6. What practitioners say (community reality check)

- **MCP won; A2A is an enterprise niche.** 24x download gap measured three independent ways. "Agent-behind-MCP" is the default pattern, with Microsoft and AWS both publishing recipes for it.
- **The competition is not another protocol; it is tmux send-keys and markdown files.** Practitioners coordinate agents through git-backed task queues (Yegge's Gas Town "beads"), file mailboxes, and terminal multiplexers. **Adoption bar: your protocol must be nearly as simple to start as those hacks.** Every feature must beat "a markdown file describing my HTTP API" on token cost, latency, and simplicity.
- **Role-cosplay agent teams mostly burn tokens.** "Success rate drops the moment agents share context. The failure mode is almost always a retry loop nobody budgeted for." Cursor's swarm post shows that at high scale, coordination migrates into the artifact store (a custom VCS at 1,000 commits/sec), not the chat layer. **Your room should stay in the low-rate coordination regime (questions, handoffs, presence) and delegate artifact conflicts to VCS/leases. Isolation default, communication deliberate.**
- **Identity and authority are the unsolved problems, not transport.** "Agent identity is just OAuth in a fake mustache. The real boundary is context + permissions + audit trail." An agent directory without agent evals is "close to useless".
- **Moltbook** (32k agents socializing via polled heartbeat markdown, Jan 2026, acquired by Meta in March) proved both the demand for agent social spaces and every failure mode at once: 1.5M agent API tokens exposed via missing RLS, credentials leaking in agent DMs, self-propagating config rewrites, an 88:1 agent-to-human ratio, and a single heartbeat URL as the compromise point.
- The one genuinely new thing this cycle (vs WSDL/FIPA): **LLMs can exploit dynamic runtime discovery**: they read a newly discovered interface and use it. Under-specified, prose-documented, LLM-legible protocols are more survivable than formally exhaustive ones.

---

## 7. Security requirements (the part naive designs get wrong)

The ground truth is grim: a scan of ~2,000 MCP servers found every one lacked authentication; 88% of surveyed orgs reported an agent security incident in the prior year; a state-sponsored group ran 80-90% of an espionage operation through hijacked coding agents. Design mandates, each anchored to evidence:

1. **A message from another agent is untrusted input, always.** Claude Code scans inbound cross-session messages for injection patterns and hard-codes that agent messages can never carry human consent. Your envelope needs a server-stamped, non-forgeable `origin: human | agent | system` field.
2. **Authority must never derive from message text.** aiAuthZ (arXiv 2607.05518) drove residual attack success to 0% across 15 models with one principle: a tool call's authority derives from the most recently verified human message via signatures checked in a separate trust domain, never from text the model read. Policy evaluation belongs outside the agent process.
3. **Scope message visibility; do not broadcast full history.** Prompt Infection (arXiv 2410.07283) showed LLM-to-LLM injections spread logistically, and **global messaging (shared full history) spreads infection dramatically faster than local messaging**. Origin tagging alone cuts attack success only ~5%; combined with message marking it approaches 0-3%. Room-scoped, mention-gated delivery is a security control, not just a token optimization.
4. **Shared retrievable room memory is a worm substrate.** Morris-II (arXiv 2403.02817) self-replicating prompts survived 11+ hops through RAG-backed ecosystems at >90% replication. No auto-ingest of peer messages into retrievable memory without sanitization; similarity-based replication detection works (TPR 1.0, FPR 0.015).
5. **Capability descriptions are attack surface.** MCPTox (arXiv 2508.14925): tool-poisoning attacks succeed at up to 72.8% on live servers, **more capable models are MORE susceptible** (better instruction-following), refusal rates under 3%. Trustwave demonstrated Agent Card poisoning (inflated capability claims to intercept tasks). Anbiaee et al. measured wrong-provider execution at violation rates 0.52-1.0 when resolution is name-based. **Mandates: globally unique signed capability identifiers, never resolve by name alone, bind selected capability to its provider cryptographically, treat descriptions as adversarial.**
6. **Registry hygiene.** The DSN 2026 study of 67,057 MCP servers found 212 maintainer-hijacking cases (deleted GitHub accounts re-registrable), 304 redirection hijackings, and endemic affix-squatting. Namespace ownership must never be freed on account deletion; registrations must be signed; publisher identity verified.
7. **OWASP ASI07 (Insecure Inter-Agent Communication), published Dec 2025**: mutual auth before any pathway, sign every message, never trust an agent identity based on network location. ASI10 (Rogue Agents): the room needs behavioral monitoring and an auditable kill switch (eviction).
8. **Identity menu, priced in tiers** (no single scheme covers all seven required properties per the AIP survey): capability URLs (trivial, fine for a trusted cluster) -> OAuth client-credentials + RFC 8693 token exchange with actor+principal claims (enterprise) -> did:wba-style key-derived identities with per-message signatures (cross-org). For delegation chains, AIP's append-only capability tokens (scopes can only narrow, max_depth, budget ceilings, completion receipts) are the reference design; SLIM's MUST of short-lived revocable tokens for cryptographic ejection is worth copying even without MLS.

---

## 8. Observability and human oversight

The York study graded both MCP and A2A only "partially met" on observability, with the precise diagnosis that neither has protocol-level tracing or **super-task IDs** relating agent traces to a collaboration tree. Humans intervene constantly in practice (a late-2025 study: 68% of deployed agents were interrupted within 10 steps), so oversight is the common path, not the exception.

**Adopt verbatim:** W3C trace context keys (`traceparent`/`tracestate`/`baggage`) unprefixed in `_meta` (MCP SEP-414, Final); OTel GenAI attributes (`gen_ai.agent.id/name/version`, `gen_ai.conversation.id` = your room_id); AG-UI event shapes for the human-facing observer feed; A2A task states for task objects.

**Define new (nothing exists anywhere):**
- **Roles: participant / observer / supervisor.** No surveyed protocol defines read-only membership or a supervisor role. Intervention verbs, each an auditable room event, all traceable to shipped systems: pause/resume agent, interrupt turn, stop agent, eject/quarantine, inject message, cancel task, approve/reject with request correlation, pre-delivery policy gates (Claude Code's exit-2 hooks; GAAT's sub-200ms OPA evaluation with graduated ALLOW/ALERT/FLAG/REDIRECT/QUARANTINE outcomes).
- **Envelope fields**: `message_id`, `room_id`, `seq` (server-assigned total order per room, making the log replayable), `task_id` + `parent_task_id` (the missing super-task tree), `in_reply_to`, `reply_by`, sender `{agent_id, name, version}`, server-stamped `origin`, optional `prev_hash` + `signature` (InterSAGE-style hash-chained audit records signed by a key the application logic cannot touch) and `delegation_chain` for cost attribution.
- **Omission detection**: an agent going silent is itself a signal (GAAT detects suppressed telemetry at 92%); heartbeat expectations belong in the spec.

---

## 9. Recommended design (synthesis)

### Positioning

Build **"Rooms for agents" as a layer, not a rival protocol**: a Room Hub service, speaking MCP at its edges, defined as an MCP extension (`com.yourorg/rooms`) plus a normative hub behavior spec. The academically predicted layered stack, the community's agent-behind-MCP default, and the York study's complexity numbers all point here. Reuse A2A Agent Card schema for capability descriptors and publish a task-state mapping for future A2A bridging.

### The core loop (your dev-agent asks PM-agent scenario)

1. **Join**: agent calls `room/join` (an MCP tool on the hub) presenting its signed agent card. The hub replies with the XMPP-MUC-ordered contract: full roster snapshot (each member: name, presence state, capability digest, role), then a self-echo marker confirming "you are now in and the roster is complete", then recent history from a cursor.
2. **Discover**: the roster IS the discovery surface. Each entry carries an Agent-Card-compatible descriptor projectable straight into an LLM tool definition. Capability payloads are fetched once per unique digest (XEP-0115 pattern: hash of the member's `tools/list`).
3. **Presence**: members declare `ready | busy | away` (plus freetext detail, `waitingFor`, current task ref); `offline` is never declared, it is inferred by lease expiry (LMOS TTL pattern) or missed heartbeats (SLIM pattern), with server-held "last will" state (MQTT pattern) so presence never lies when an agent crashes mid-task. Presence changes are pushed as full roster snapshots stamped with a monotonic room epoch.
4. **Ask**: dev agent sends a `request` addressed to the PM agent (exact name + stable id, mention-gated). The message is an envelope: type/performative, conversation_id, in_reply_to, reply_by deadline, seq, origin, traceparent, task_id/parent_task_id. Delivery is a durable append: the send succeeds when the room log write succeeds, decoupled from the PM being awake. Outcomes are explicit: delivered / held / refused, reported to the sender.
5. **Answer, live**: if the PM agent is listening (long-poll lease or push stream), it wakes, answers within the conversation, optionally streaming interim results (typed events with an explicit end-of-stream). If busy, it may refuse with a machine-readable reason (BUSY vs INELIGIBLE, Smith 1980) so the dev agent can retry vs re-route. Long asks become tasks with the A2A-compatible state machine, and `input-required` handles the PM asking a clarifying question back.

### The eight decisions the shipping systems diverge on (with recommendations)

1. **Transport**: Streamable-HTTP shape: POST to send, one long-lived stream per member for pushes (`subscriptions/listen` on MCP-native clients; plain SSE otherwise), WebSocket upgrade optional. HTTP/2. Heartbeat+ack, monotonic seq, `room/sync` for reconnect replay (MCP removed resumability, so you own it).
2. **Wake-up**: support the graded menu (long-poll lease as baseline since it works everywhere, push stream where available, HMAC-signed webhook for resident agents). agent-room's constants are a starting point (30s poll blocks, 150s first-response grace).
3. **Presence vocabulary**: small closed enum + freetext detail (Claude Code's `tempo` + detail is the most copyable). Declared busy-state must exist (nobody has it); inferred connection state is the fallback signal.
4. **Capability discovery**: the greenfield. Card-compatible descriptors in the roster + capability digest in presence + optional deep-link so a member's capabilities can be invoked as namespaced MCP tools through the hub.
5. **Broadcast vs DM**: room-broadcast exists but mention-gated attention is the default (AgentTeams pattern: non-mentioned messages are buffered context, not turns). This is simultaneously the token-economics fix and the infection-containment fix.
6. **Floor control**: optional room modes (open / sequential / moderator) with tiered deadlines; enforced server-side (only agent-room does this and multi-agent rooms need it).
7. **History**: cursor-based replay for late joiners; unread-inbox semantics per member for token economy.
8. **Identity/auth tiers**: capability URL (dev) -> OAuth client-credentials + token exchange (enterprise) -> key-derived IDs with per-message signatures (federation). Signed cards mandatory. Server-stamped origin. Short-lived revocable tokens so eviction is real.

### What NOT to do (each traceable to a documented failure)

- Do not define message semantics over agent internals (FIPA's death).
- Do not standardize verbs while leaving join/naming/auth/errors per-implementation (KQML's death by dialects).
- Do not use unlimited registry leases (stale FIPA registries); do not free names on account deletion (MCP registry hijacking).
- Do not build on MCP sampling/elicitation/roots/sessions (all deprecated or removed).
- Do not make global presence subscriptions (Matrix's collapse); scope presence to the room.
- Do not broadcast full shared history to all members (prompt-infection accelerant, token furnace).
- Do not resolve capabilities by name alone (wrong-provider execution, violation rate up to 1.0).
- Do not require the crypto-identity tier for a first hello (ProtocolBench: 17-36% latency tax; adoption physics).
- Do not ship a spec without a reference server and a conversation-level debugger (JADE's lesson).

### Suggested MVP path

1. **Week-one MVP**: a single hub process exposing ~8 MCP tools (`room_create/join/send/listen/leave` + `list_agents` semantics via roster resource, task board optional), NDJSON/SQLite log, capability-URL auth, presence = listen-lease + declared state. Any MCP-speaking agent (Claude Code, Cursor...) can join with zero SDK. Coral and agent-room prove this surface works; your addition is the card-based capability roster and declared presence.
2. **v0.2**: presence push via the `subscriptions/listen` extension for 2026-07-28 hosts (poll fallback for legacy), signed cards, seq + `room/sync`, delivered/held/refused semantics, origin stamping, trace context.
3. **v0.3**: roles (participant/observer/supervisor) with intervention verbs, pre-delivery policy hook, task lifecycle mapping to A2A states, webhook wake-ups, federation fields reserved (search-id, max-depth, scope; FIPA solved loop-safe federated search and you may want it later).

---

## 10. Sources

**Downloaded papers**: 70 files in [`research/papers/`](papers/) indexed in [INDEX.md](papers/INDEX.md). Highlights: the four protocol surveys (2504.16736, 2505.02279, 2606.19135, 2604.02369), ProtocolBench (2510.17149), the York MCP-vs-A2A study (2607.23884), Internet of Agents (2407.07061), Web of Agents (2505.21550), Cisco L8/L9 (2511.19699), Coral whitepaper (2505.00749), Agora (2410.11905), SLIM IETF draft, discovery systems (ANS 2505.10609, NANDA 2507.14263, AGNTCY ADS 2509.18787, GRAIL 2605.02489, Verisign 2606.02314), security (Morris-II 2403.02817, Prompt Infection 2410.07283, MCPTox 2508.14925, MCP registry study 2510.16558, threat modeling 2602.11327, aiAuthZ 2607.05518, AIP 2603.24775, InterSAGE 2608.13030, GAAT 2604.05119), the FIPA standards (SC00023/26/29/37/61), KQML papers, Smith's Contract Net (1980), Linda (1985), blackboards (Nii 1986), Singh 1998, Labrou/Finin/Peng 1999, JADE 1999, SPADE 3, Matrix event-graph CRDT (2011.06488), gossipsub (2007.02754), MCP 2026-07-28 spec extracts, and the MCP tasks/extensions SEPs.

**Key live specs and repos**: MCP spec + changelogs (modelcontextprotocol.io), A2A spec v1.0.1 (a2a-protocol.org), SLIM docs + draft-mpsb-agntcy-slim, Coral coral-server source, agent-room source, MCP Agent Mail, AgentTeams source, Claude Code docs + binary inspection, ANP spec suite, AITP (aitp.dev), Eclipse LMOS docs, OWASP Agentic Top 10 (Dec 2025), OTel GenAI/MCP semantic conventions, AG-UI, framework docs with versions verified on PyPI as of Aug 16, 2026.
