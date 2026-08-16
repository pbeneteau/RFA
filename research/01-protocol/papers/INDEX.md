# Papers Library Index

Downloaded and read during the deep-research pass of August 16, 2026.

## Agent Communications toward Agentic AI at Edge - A Case Study of the Agent2Agent Protocol (Duan & Lu, arXiv 2508.15819)
- File: `a2a-edge-case-study.pdf`
- Source: https://arxiv.org/pdf/2508.15819
- Read in full (7 pages). Independent academic assessment (Penn State + Fudan) choosing A2A as 'the most representative and broadly embraced' inter-agent protocol and 'the only protocol for inter-agent communications adopted in product-level development of agentic AI applications' - notable that even A2A's academic champions cite reviews, not named deployments, for production claims.
- Categorizes the protocol landscape into context-oriented (MCP), user-oriented (AG-UI), and inter-agent protocols (general-purpose: A2A, ANP, ACP; special-purpose: Agent Protocol, LMOS) - a useful taxonomy for positioning the room protocol as inter-agent with MCP-style ergonomics.
- Documents A2A's three discovery approaches (open discovery at https://agent-domain/.well-known/agent.json via DNS, registry-based with RESTful query, authenticated API-based) and assesses each: registry/API approaches are centralized bottlenecks; open discovery 'assumes each client knows the right domains where its target agents are located, which is unrealistic' in dynamic environments - the same discovery gap the user's room fills.
- Key structural criticism (their Table I assessment): 'current A2A mechanisms for information transportation follow a point-to-point model in which the client agent communicates directly with a remote agent, which does not scale gracefully to large-scale, complex MAS with many interacting agents'; their proposed future directions include 'multi-to-multi message delivery mechanisms, such as a message broker/router or service bus architecture' - i.e., room/bus semantics are an acknowledged HOLE in A2A, not a feature.
- Also notes the Agent Card 'lacks a standard schema for describing critical host-related information (OS platform, CPU, memory, bandwidth)', limiting resource-aware discovery; identity via W3C DID; auth via OAuth/mTLS declared in the card; transport JSON-RPC 2.0 over HTTPS with SSE streaming and webhook push notifications; stateful task tracking correlates interaction stages.

## Advancing Multi-Agent Systems Through Model Context Protocol (Naveen Krishnan; arXiv 2504.21030, Apr 2025)
- File: `advancing-mas-through-mcp.pdf`
- Source: https://arxiv.org/pdf/2504.21030
- Single-author conceptual paper proposing MCP as the fix for the 'context retention problem' in MAS (discontinuity across agent boundaries, temporal discontinuity, contextual prioritization, cross-modal integration); frames MCP as strengthening Wooldridge's 'social ability' property of agents.
- Describes MCP server implementation patterns useful as vocabulary: adapter, composite, proxy, embedded; and claims one-to-many and many-to-one client/server deployment topologies.
- CAUTION for synthesis: the paper's protocol details are unreliable/hallucinated - it lists method names 'prompt.list', 'tool.execute', 'root.describe', 'sample.generate' and a malformed JSON example, none of which exist in any real MCP revision (actual: prompts/list, tools/call, sampling/createMessage). Frequently cited in secondary literature; treat its architectural claims, not its protocol specifics, as the citable content.
- Value for the user: articulates why shared context (not just message passing) is the hard problem in multi-agent rooms - the 'disconnected models problem' quote from Microsoft's Sam Schillace.

## Discovering Agents for Discovery: The Case for DNS (arXiv 2606.02314, Verisign, June 2026)
- File: `agent-discovery-case-for-dns.pdf`
- Source: https://arxiv.org/pdf/2606.02314
- Closed-world platforms (Claude agents find Claude agents; ChatGPT agents find ChatGPT agents) do not interoperate; Internet-scale agent discovery needs Internet names - argues DNS already solves this
- Evaluation framework: navigational completeness (is all needed metadata - trust included - present), lookup complexity, transaction performance (latency/recency)
- Empirical study over 119,757 real-world service endpoints: the necessary+sufficient discovery metadata fits within a single unfragmented UDP DNS message = one RTT, millisecond latency, using DNSSEC + DANE-style certificate binding
- Cites IETF work in progress: DNS-AID (DNS for AI Discovery) and ANS as candidate proposals needing comparative evaluation

## A Survey of Agent Interoperability Protocols: MCP, ACP, A2A, and ANP (Ehtesham et al., arXiv 2505.02279)
- File: `agent-interop-protocols-survey.pdf`
- Source: https://arxiv.org/pdf/2505.02279
- Read pages 1-6 (note: this file duplicates a survey already in the research folder under other names from parallel researchers; downloaded here for citation completeness).
- Frames the four protocols as complementary tiers: MCP = JSON-RPC client-server for tool/context invocation; A2A = peer-to-peer task delegation via capability-based Agent Cards with SSE async; ACP = RESTful MIME-multipart messaging with session management (IBM, March 2025); ANP = decentralized P2P discovery over W3C DID + JSON-LD.
- Proposes a phased adoption roadmap (MCP first for tool access, then ACP, then A2A for collaborative task execution, then ANP for open-internet marketplaces) - written May 2025; the 2026 reality checked in this research shows the roadmap stalled at phase 1 for most of the market (MCP dominant, A2A niche, ACP largely absorbed/quiet).
- Its history section (KQML 1993, FIPA-ACL 2000, MASIF 1998 service registration) documents that standardized agent discovery/registries have failed to converge for 30 years - context for why A2A's registry discussion #741 remaining open for 14 months is the norm, not an anomaly.
- Identifies the pre-protocol pain point the room protocol also targets: function-calling ecosystems are static ('agents must be re-initialized whenever new APIs are added or schemas change, preventing truly dynamic discovery'), which is the exact property MCP listChanged/subscriptions and the user's presence room fix.

## Agent Name Service (ANS): A Universal Directory for Secure AI Agent Discovery and Interoperability (arXiv 2505.10609, OWASP GenAI)
- File: `agent-name-service-ans.pdf`
- Source: https://arxiv.org/pdf/2505.10609
- DNS-inspired protocol-agnostic registry with full PKI: Registration Authority validates identity + policies, Certificate Authority issues X.509, lifecycle = registration/renewal/revocation with CRL/OCSP
- ANSName scheme: protocol://AgentID.agentCapability.Provider.vVersion[.Extension] (example: mcp://sentimentAnalyzer.textAnalysis.ExampleCorp.v1.0) - name itself encodes protocol, capability, provider, semver
- protocolExtensions JSON container stores protocol-specific payloads: A2A Agent Cards, MCP tool descriptions (input/output schemas + mcpEndpoint), ACP profiles; protocol adapter layer maps them to a common internal representation
- All registry interactions validated against published JSON Schemas (AgentRegistrationRequest etc.); capability attestation optionally via zero-knowledge proofs; per-protocol validation table (A2A agent-card integrity, MCP tool schema verification, ACP role-based identity)

## AgentHub: A Registry for Discoverable, Verifiable, and Reproducible AI Agents (arXiv 2510.03495)
- File: `agenthub-registry.pdf`
- Source: https://arxiv.org/pdf/2510.03495
- Downloaded and verified (9 pages) but not deeply read in this pass; positions a package-manager-style registry for agents emphasizing verifiability and reproducibility, complementary to ANS/NANDA/ADS approaches

## AgentWebBench: Benchmarking Multi-Agent Coordination in Agentic Web (arXiv 2604.10938)
- File: `agentwebbench.pdf`
- Source: https://arxiv.org/pdf/2604.10938
- Downloaded and verified (19 pages) but not deeply read in this pass; relevant as a 2026 benchmark of multi-agent coordination in the agentic-web setting, complementary to ProtocolBench

## The AGNTCY Agent Directory Service: Architecture and Implementation (arXiv 2509.18787, Cisco)
- File: `agntcy-agent-directory-service.pdf`
- Source: https://arxiv.org/pdf/2509.18787
- Distributed capability directory built on OASF (Open Agentic Schema Framework): versioned, extensible agent records with additive extensions (MCP server descriptors, evaluation metrics, prompt bundles, feature flags); records immutable and content-addressed (CIDs); mutable data expressed as new versioned records, never in-place edits
- Two-level discovery mapping: skill/domain/feature taxonomies -> record CIDs, then CIDs -> storage peers, over a Kademlia DHT; queries must include at least one skill (domain/feature-only queries disallowed to bound complexity); sub-linear scaling goal for capability queries
- Reuses OCI registries + ORAS for artifact distribution and Sigstore for provenance signing; integrity verification requires no trusted intermediaries; federated operation without a single root of trust
- Explicitly positioned as complementary to NANDA-style name resolution: ADS does capability-centric content-addressed discovery, NANDA does DNS-inspired naming/resolution; reference implementation github.com/agntcy/dir

## A Scalable Communication Protocol for Networks of Large Language Models (Agora)
- File: `agora-scalable-communication-protocol.pdf`
- Source: https://arxiv.org/pdf/2410.11905
- Read pages 1-9. Defines the Agent Communication Trilemma (versatility, efficiency, portability) and sidesteps it with a meta-protocol: Protocol Documents (PDs) are plain-text, self-contained protocol descriptions identified by their hash, so no central naming authority is needed and IPFS-style storage works.
- Wire format is minimal: HTTPS carrying a JSON envelope with three keys: protocol hash, body formatted per the protocol, and a list of sources from which the receiver can download the PD; receivers verify the hash and cache the PD.
- Communication cascade: human-written routines for standardized protocols, LLM-written routines for frequent patterns, LLM-over-structured-data, and natural language only for rare/bootstrap cases; agents can expose an endpoint listing supported protocols to shortcut negotiation.
- Measured on a demo pair: protocol negotiation + routine writing cost $0.043 vs $0.020 per natural-language exchange, so it amortizes after two uses; in a 100-agent heterogeneous network (GPT-4o, Llama-3-405B, Gemini 1.5 Pro; SQL + MongoDB) costs fell about 5x and full-LLM processing dropped from >80% to about 30% of queries, with emergent multi-agent workflows (food delivery chain) arising without human design.
- Positions itself as a 'Layer Zero' under higher-order standards; fully backward compatible with existing protocols (OpenAPI, JSON-Schema) treated as PDs.

## aiAuthZ: Off-Host, Identity-Bound Authorization for AI Agents (Kodathala, arXiv 2607.05518, Jul 2026)
- File: `aiauthz-identity-bound-authz.pdf`
- Source: https://arxiv.org/pdf/2607.05518
- Core principle: a tool call authority must derive from the most-recently-verified HUMAN message, never from text the model reads; injected text confers no authority.
- Per-message HMAC-SHA256 signature over canonical JSON of user_id, session_id, SHA-256 of content, single-use nonce, Unix timestamp; nonce enforced atomically for replay protection; 300s timestamp window.
- Authorization must live in a SEPARATE trust domain from the agent host (agent holds no credentials/policy) so a prompt-injected/compromised agent cannot forge approval or rewrite its own rules.
- Off-host policy equals role gate plus argument constraints (path/URL/recipient allowlists, write-size caps) plus per-tool rate limits; every decision returns a structured reason and joins a SHA-256 hash-chained tamper-evident audit log; anchor head hash externally.
- Empirical: model-only refusal ranges 100% to 38% (uncorrelated with price; more expensive is not safer); with the gateway residual attack success equals 0% for all 15 models; blocks all 7 attacker-directed calls on AgentDojo.

## AIP: Agent Identity Protocol for Verifiable Delegation Across MCP and A2A (Prakash, Indian School of Business, arXiv 2603.24775, Mar 2026)
- File: `aip-agent-identity-protocol.pdf`
- Source: https://arxiv.org/pdf/2603.24775
- Reports the Knostic finding: a scan of about 2,000 MCP servers found EVERY one lacked authentication; A2A agent cards carry self-declared identities with no attestation binding.
- Seven-property gap framework (public-key verification, holder-side attenuation, expressive policy, cross-protocol flow, provenance binding, no heavy infra, lifecycle awareness); no surveyed approach satisfies more than 4.
- Detailed critique: DIDs are blockchain/circular-trust, OAuth has no attenuation/no chain/opaque tokens, Macaroons use HMAC (every-verifier-a-forger), UCAN has quadratic token bloat, SPIFFE needs heavy infra plus no cross-protocol flow plus issuance latency vs ephemeral agents, Biscuit has right crypto but no identity resolution.
- IBCT design: append-only chain Block0 Authority to BlockN Delegation (cryptographically-enforced scope attenuation, mandatory context, max_depth) to Block N plus 1 Completion (result_hash, verification_status, cost); compact JWT (single-hop) vs chained Biscuit plus Datalog (multi-hop).
- Two identity schemes: aip:web (HTTPS-resolved, long-lived org agents) and aip:key:ed25519 (self-certifying, zero-resolution, ephemeral sub-agents); identity doc signed Ed25519 over RFC 8785 JCS.

## AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation (arXiv 2308.08155)
- File: `autogen-multiagent-conversation.pdf`
- Source: https://arxiv.org/pdf/2308.08155
- Read pages 1-10. Defines 'conversable agents': every agent exposes a unified interface of send/receive plus generate_reply; on receiving a message an agent auto-invokes generate_reply and sends the result back until a termination condition, so control flow is decentralized and induced by registered reply functions with no separate control plane.
- 'Conversation programming' splits multi-agent design into computation (what an agent does to produce a reply) and control flow (who talks to whom next), programmable in both Python and natural language; dynamic patterns are achieved via custom generate_reply functions and via LLM function calls that message other agents.
- GroupChatManager runs dynamic group chat as a three-step loop: dynamically select a speaker (a role-play style selection prompt outperformed pure task-based prompts in their 12-task pilot), collect the response, broadcast it to all members - the direct ancestor of the room/speaker-selection pattern.
- Termination is prompt-signaled (e.g. reply 'TERMINATE') combined with programmatic conditions (max auto-replies, human input modes ALWAYS/NEVER), and humans participate through a UserProxyAgent as a first-class conversable member.
- Applications section shows the Commander/Writer/Safeguard multi-agent coding pattern and shows multi-agent design added +8-35% F1 in unsafe-code detection over single-agent, evidence for why agent specialization (and hence inter-agent protocols) matters.

## AWCP: A Workspace Delegation Protocol for Deep-Engagement Collaboration across Remote Agents (arXiv 2602.20493, Feb 2026)
- File: `awcp-workspace-delegation.pdf`
- Source: https://arxiv.org/pdf/2602.20493
- Identifies the 'context gap': message protocols (A2A/ANP) exchange detached artifact snapshots stripped of build system/version history/test infra; MCP returns discrete function outputs; neither lets an agent run ls/cat/git in a peer's environment
- Delegator-Executor model: Delegator projects its workspace (files-as-interface, Unix everything-is-a-file) to a remote Executor who works with unmodified local toolchains
- Architecture: lightweight control plane over HTTP + SSE for signaling; pluggable workspace transports (SSHFS, archive, object storage, Git); Delegator integration via MCP tool servers or skills; Executor invocation via A2A, ANP, or direct HTTP adapters
- Open-source reference implementation github.com/SII-Holos/awcp; demonstrates asymmetric collaboration (cross-modal dataset curation, compliance stamping)

## Beyond Message Passing: A Semantic View of Agent Communication Protocols (arXiv 2604.02369, March 2026)
- File: `beyond-message-passing-semantic-view.pdf`
- Source: https://arxiv.org/pdf/2604.02369
- Three-layer analytical framework (communication / syntactic / semantic) applied to 18 protocols; finding: strong maturity on transport, streaming, schema, lifecycle; almost no protocol-level clarification, context alignment, or verification - semantics displaced into prompts/wrappers/orchestration = hidden interoperability + maintenance debt
- Session management debt: protocol lifecycles assume short, synchronous, well-bounded phases; real systems have agents joining/leaving dynamically, minutes-to-hours dialogues with intermittent availability, speculative parallel negotiation, async handoffs; cites asynchronous multiparty session types with crash-stop semantics as the needed formal machinery
- Interleaving debt: real interactions interleave multiple logical sessions (delegation, nested sub-protocols) risking deadlock without composition and dynamic endpoint creation support
- Fragmentation debt: each additional protocol multiplies integration surface (transport JSON-RPC vs REST vs streaming, discovery, identity, schema, lifecycle) - 'interoperability debt'; error-management debt: HTTP status codes inadequate for agent-level failures
- Provides deployment-conditioned protocol-selection guidance and a research agenda toward protocol-level shared understanding

## Beyond Self-Talk: A Communication-Centric Survey of LLM-Based Multi-Agent Systems (arXiv 2502.14321)
- File: `beyond-self-talk-comm-survey.pdf`
- Source: https://arxiv.org/pdf/2502.14321
- Defines LLM-MAS as 'communication protocol-constrained automata'; framework splits system-level communication (architecture, goals, protocols) from internal communication (strategies, paradigms, objects, content)
- Communication architectures categorized centralized / decentralized / hierarchical; paradigms cooperation / competition / coordination; content spans natural language, structured messages, shared memory
- Open challenges list: communication efficiency (overhead grows with agents x rounds), security vulnerabilities of inter-agent channels, inadequate benchmarking, scalability

## CAMEL: Communicative Agents for "Mind" Exploration of Large Language Model Society (arXiv 2303.17760, NeurIPS 2023)
- File: `camel-communicative-agents.pdf`
- Source: https://arxiv.org/pdf/2303.17760
- Read pages 1-8. Role-playing framework: a task specifier agent turns a vague human idea into a specified task; then AI user (instruction giver) and AI assistant alternate strictly, formalized as M_{t+1} = M_t union {(I_{t+1}, S_{t+1})} - a pure turn-based message-set model the authors note extends to message-passing graphs of arbitrarily many agents.
- Inception prompting hard-codes the interaction protocol into both system prompts: 'Never flip roles! Never instruct me!', a fixed message format (Instruction:/Input: from user; 'Solution: ...' ending with 'Next request.' from assistant), and 'give me one instruction at a time' - i.e., turn-taking and message schema enforced by prompt because no protocol layer existed.
- Explicit end-of-task token <CAMEL_TASK_DONE> plus mechanical guards: terminate after 3 user turns without an instruction, on detected role reversal, on token limit, and at a 40-message cap (cost grows quadratically with conversation length).
- Empirically documented cooperation failure modes: role flipping, assistant repeating instructions, flake replies ('I will...' without doing), and infinite thank-you/goodbye loops - agents sometimes knew they were stuck but could not break out; these are the behaviors a communication protocol must prevent structurally.
- Critic-in-the-loop variant adds a third agent (or human) selecting among proposals, enabling tree-search-like decision making - an early pattern for adding a moderator role to a two-party session.

## Coral Protocol: Open Infrastructure Connecting the Internet of Agents (whitepaper v1.1)
- File: `coral-protocol.pdf`
- Source: https://arxiv.org/pdf/2505.00749
- Read pages 1-10 and 25-33. Architecture: per-host Coral Server coordinates 'Coralised' agents; every agent gets a dedicated Coral MCP server plus a crypto wallet; communication over HTTP/WebSocket with SSE event streams; blockchain layer for payments, team contracts and reputation.
- The Coral MCP server exposes the room primitives as MCP tools: list_agents, create_thread, add_participant, remove_participant, send_message (thread-scoped, with @mention targeting), wait_for_mentions (blocking/subscription so agents are notified instead of polling), close_thread (with summary).
- Threads give contextual compartmentalization: messages stay within their thread; memory isolation layers are private (agent-only), thread (all participants), and session scoped.
- Coralisation: a generator wraps any external MCP server or legacy agent (CrewAI, ElizaOS) into a Coral agent via configuration (coraliser_settings.json), making MCP tools first-class room participants.
- Secure team formation is currently manual at the app layer but rests on per-agent DIDs, signed team contracts (optionally on-chain) and blockchain-stored reputation scores updated on task completion; wallets currently only receive payments.

## Secure Low-Latency Interactive Messaging (SLIM), draft-mpsb-agntcy-slim-02 (IETF Internet-Draft, 2026-07-07)
- File: `draft-mpsb-agntcy-slim-02.txt`
- Source: https://www.ietf.org/archive/id/draft-mpsb-agntcy-slim-02.txt
- Read in full (1008 lines). The draft is architectural, not a wire spec: group lifecycle details live in the agntcy/slim repo, which the draft references (github.com/agntcy/slim-spec is the draft source).
- Two-tier security: HTTP/2-HTTP/3 hop-by-hop TLS 1.3 plus MLS (RFC 9420/9750) content-layer envelope; routing nodes are zero-trust intermediaries forwarding opaque blobs; a group is an MLS group whose moderator (a decentralized MLS Delivery Service instance) adds/removes members.
- Naming: client locator did:key(org)/namespace(org)/service/did:key(client); channel name ends in did:key(moderator); RFC 6920 hash-based names; did:web/did:key/did:plc allowed; hierarchy exists for subscription-table aggregation.
- SRPC: gRPC-semantics RPC over SLIM; handler routing token {package}.{service}-{handler} spliced into the service name segment (c[0]/c[1]/c[2]-token/c[3]); apps auto-subscribe per handler; claimed to enable capability advertisement by method name without discovery round-trips.
- Security MUSTs: validate MLS KeyPackages, short-lived server-revocable OAuth bearer tokens for immediate agent ejection, correct MLS epoch transitions so removed members cannot decrypt post-removal.

## FIPA Agent Management Specification (SC00023K, standard, 2002/2004)
- File: `fipa-sc00023-agent-management.pdf`
- Source: http://www.fipa.org/specs/fipa00023/SC00023K.pdf
- Reference model: Agent Platform = agents + AMS (mandatory, white pages, supervisory control, issues AIDs name@platform with ordered transport addresses and resolvers) + DF (optional, yellow pages) + Message Transport Service; reserved names df@hap, ams@hap
- Agent lifecycle state machine: initiated/active/waiting/suspended/transit with transitions (create/invoke/destroy/quit/suspend/resume/wait/wake-up/move); MTS delivery behavior depends on state: a ready-made presence model
- df-agent-description {name, services, protocols, ontologies, languages, lease-time, scope}; service-description {name, type, protocols, ontologies, languages, ownership, properties}; leases renewable via modify, DF may shorten them; DF is a 'benign custodian' that cannot guarantee validity of registered claims and registration implies no commitment
- Federated DF search with search-constraints {max-depth TTL, max-results (default 1), globally unique search-id cached to prevent federation loops}; matching is recursive query-by-example template matching with partial descriptions
- DF subscribe = persistent search over the directory with informs pushed as the result set changes (live registry/presence deltas), terminated by cancel

## FIPA Request Interaction Protocol Specification (SC00026H, standard, Dec 2002)
- File: `fipa-sc00026-request-protocol.pdf`
- Source: http://www.fipa.org/specs/fipa00026/SC00026H.pdf
- Canonical request lifecycle: request -> refuse [end] | agree (optional when the action is quick and within reply-by) -> failure | inform-done | inform-result: maps 1:1 to modern task states (submitted/working/completed/failed)
- Same universal rules as contract-net: globally unique conversation-id, not-understood anywhere, cancel meta-protocol
- The agree-is-optional rule is a useful latency optimization pattern: skip the ack when the result will arrive fast

## FIPA Contract Net Interaction Protocol Specification (SC00029H, standard, Dec 2002)
- File: `fipa-sc00029-contract-net.pdf`
- Source: http://www.fipa.org/specs/fipa00029/SC00029H.pdf
- Flow: cfp to m participants (deadline in reply-by) -> refuse or propose; proposals after deadline auto-rejected with reason 'late'; accept-proposal makes the proposal a binding commitment; terminal: failure | inform-done | inform-result
- All messages tagged with globally unique initiator-assigned conversation-id; initiator decides for 1:N cases whether to reuse or mint conversation-ids
- not-understood possible at any point and may void all commitments in the interaction; universal cancel meta-protocol (cancel -> inform-done | failure) reuses the same conversation-id
- Spec explicitly lists what it does NOT address: effects of cancelling actions, asynchrony, abnormal termination, nested protocols: the to-do list a 2026 protocol must cover

## FIPA Communicative Act Library Specification (SC00037J, standard, Dec 2002)
- File: `fipa-sc00037-communicative-act-library.pdf`
- Source: http://www.fipa.org/specs/fipa00037/SC00037J.pdf
- Exactly 22 communicative acts: accept-proposal, agree, cancel, cfp, confirm, disconfirm, failure, inform, inform-if, inform-ref, not-understood, propagate, propose, proxy, query-if, query-ref, refuse, reject-proposal, request, request-when, request-whenever, subscribe
- Formal models per act in modal logic, e.g. inform FP: Bi(phi) and not Bi(Bifj(phi) or Uifj(phi)), RE: Bj(phi); request FP includes the sender believing the receiver has no persistent goal of Done(a); sincerity condition explicit for assertives
- Composite/macro acts built by disjunction (inform-ref as potentially infinite disjunction of informs; query-if derived via a 'double-mirror transformation'): illustrates the theoretical machinery practitioners ignored
- The formal annex demonstrates concretely why developers treated performatives as a plain enum: the semantics are elegant but non-computable and unverifiable in practice

## FIPA ACL Message Structure Specification (SC00061G, standard, Dec 2002)
- File: `fipa-sc00061-acl-message-structure.pdf`
- Source: http://www.fipa.org/specs/fipa00061/SC00061G.pdf
- 13 parameters, only performative mandatory: sender, receiver (set-valued = multicast with per-recipient act semantics), reply-to, content, language, encoding, ontology, protocol, conversation-id, reply-with, in-reply-to, reply-by
- conversation-id must be globally unique (suggested: sender GUID + counter); setting protocol obliges initiator to set conversation-id and all responses to carry it; reply-by is the deadline for the NEXT message in the protocol flow
- User-defined parameters must use the X- prefix; unknown parameters trigger not-understood; encodings (string/XML/bit-efficient) are separate specs so the abstract structure survives representation changes
- Contains the spec's own warning that using ACL semantics without an interaction protocol is 'an extremely ambitious undertaking': primary-source evidence for protocols-over-semantics

## Generative Communication in Linda (Gelernter, ACM TOPLAS 7(1), Jan 1985)
- File: `gelernter-linda-1985.pdf`
- Source: https://www.cs.unc.edu/~stotts/COMP590-059-f21/slides/lindaGenerative.pdf
- Three primitives over a shared tuple space: out (add, non-blocking), in (atomic destructive read, blocks until match; contention resolved so exactly one taker wins), read (non-destructive); tuples are inserted/withdrawn atomically
- Structured naming = content-addressable matching with actuals and typed formals (query-by-example); explicitly compared to relational select and Prolog unification
- Communication orthogonality: sender and receiver know nothing about each other; consequences: space uncoupling (distributed naming), time uncoupling (tuples outlive producers, time-disjoint processes can communicate), distributed sharing (atomic shared variables with no owning process)
- Positioned as a fourth model of concurrency beside monitors, message passing, and remote operations; the decoupling properties are exactly what async agent handoff needs

## From Glue-Code to Protocols: A Critical Analysis of A2A and MCP Integration for Scalable Agent Systems (arXiv 2505.03864)
- File: `glue-code-to-protocols-a2a-mcp.pdf`
- Source: https://arxiv.org/pdf/2505.03864
- Downloaded and verified but not deeply read in this pass; known contribution: analyzes the layered A2A-for-coordination + MCP-for-tools pattern and its integration friction points (state synchronization, capability mismatch) when composing both protocols in one system

## GossipSub: Attack-Resilient Message Propagation in the Filecoin and ETH2.0 Networks (Vyzovitis et al., Protocol Labs, arXiv 2007.02754, July 2020)
- File: `gossipsub-attack-resilient.pdf`
- Source: https://arxiv.org/pdf/2007.02754
- Read pages 1-4. Core design: an eager-push global mesh (each node keeps a bounded local mesh view, direct message exchange) combined with a lazy-pull gossip layer (IHAVE metadata to non-mesh peers, IWANT fetch), explicitly balancing flooding's speed/robustness against its bandwidth cost - the paper cites Bitcoin flooding at up to 350GB/month per public node with ~44% of network traffic redundant and ~90% of transaction-propagation bandwidth carrying redundant data.
- Every node continuously scores every connected peer locally (scores are never shared - routing decisions come from each node's own observations), and mitigation strategies build on this: score-driven mesh maintenance, scoped flooding for a peer's own publications, and score-based isolation of misbehaving nodes; badly-behaved nodes are progressively pushed from mesh to gossip-only to fully excluded.
- Threat model enumerated for permissionless networks: Sybil attacks (cheap identity creation, sybils graft into meshes), eclipse attacks (silencing a victim), censorship attacks (sybils behave well but hairpin-drop one target's messages - noted as hard to detect via scoring since sybils accrue good score otherwise), and cold-boot attacks (sybils present at network bootstrap).
- Empirical validation: ~16k LOC production code tested on 5000+ VM containers on AWS (1.2 vCPU / 2GB each), sybil:honest connection ratios up to 40:1 (mostly reported 20:1); conclusion that ~$40,000/month of coordinated attack expenditure does not constitute a successful attack under Filecoin/ETH2-derived metrics; adopted as the messaging layer of Filecoin and Ethereum 2.0.
- Design context useful for agent protocols: two topics with different delivery priorities (blocks vs transactions) show per-topic tuning; ETH2 expected 70 to a few hundred topics over 5k-10k nodes - i.e. gossipsub's operating envelope for 'many rooms, many peers, no server'.

## Governance-Aware Agent Telemetry for Closed-Loop Enforcement in Multi-Agent AI Systems (Pathak, Jain; Apple)
- File: `governance-aware-agent-telemetry.pdf`
- Source: https://arxiv.org/pdf/2604.05119
- Read all 6 pages. arXiv 6 Apr 2026. Thesis: OTel/Langfuse-style observability is post-hoc ('observe-but-do-not-act gap'); telemetry should be the real-time enforcement signal. Dashboard-only baseline prevented 27.1% of violations vs GAAT 98.3% (5,000 synthetic flows) / 99.7% (12,000 production-realistic traces).
- Governance Telemetry Event: e = (timestamp, source_agent, receiving_agent, operation, ctx, gov) with gov = (classification, jurisdiction, sensitivity, lineage, verified): an OTel extension schema (GTS) that names source AND receiving agent per event, i.e. edge-level (message-level) telemetry, not node-level.
- Trusted Telemetry Plane: every span ECDSA P-256 signed, agent keys in TPMs, Bloom-filter replay prevention (99.1% detection), HMM omission detection (92.3%: detects agents that STOP emitting telemetry, trained per agent-type on phase-structured emission patterns), Merkle-tree tamper-evident audit log, fail-closed/fail-open per risk tier.
- Graduated enforcement: L0 ALLOW, L1 ALERT, L2 FLAG, L3 REDIRECT, L4 QUARANTINE (revoke Kafka consumer membership, invalidate tool tokens, K8s NetworkPolicy deny); escalation(v,H) = min(4, base(v) + floor(|H|/k)); per-agent circuit breaker forces quarantine at 3k violations in a sliding window; formal theorems for escalation termination, deterministic conflict resolution (max-action policy composition), bounded false quarantine P(FQ) <= (1+rho)(eps + (1-eps)delta).
- Cross-agent lineage tracking is the differentiator: a data-residency violation spanning OrderAgent -> ShippingAgent -> AnalyticsAgent passes every per-agent boundary check (NeMo Guardrails style, 78.8% VPR) and is only caught by the maintained provenance chain across hops; sub-200 ms end-to-end enforcement latency (P50 127 ms) at 50 agents, linear scaling.

## GRAIL: Deep-Granularity Hybrid Resonance Framework for Real-Time Agent Discovery via SLM-Enhanced Indexing (arXiv 2605.02489, CAICT, May 2026)
- File: `grail-realtime-agent-discovery.pdf`
- Source: https://arxiv.org/pdf/2605.02489
- Diagnoses the discovery dichotomy: LLM intent-parsing ('think-then-lookup') is accurate but >30s/query; monolithic single-vector retrieval is fast but suffers semantic drift (loses constraints like API version or pricing)
- Three mechanisms: fine-tuned Small Language Model predicts capability tags in milliseconds; pseudo-document expansion augments agent descriptions with synthetic queries for denser embeddings; MaxSim late-interaction matching between query and discrete per-agent usage examples
- Sub-400ms end-to-end discovery latency, 79x faster than LLM-parsing baselines, better Recall@10 than plain vector search; validated on new AgentTaxo-9K corpus of 9,240 agents
- Framed explicitly as infrastructure for real-time Internet of Agents and high-frequency agent-to-agent negotiation

## HyLaT: Efficient Multi-Agent Communication via Hybrid Latent-Text Protocol (arXiv 2605.25421, Fudan/CUHK/KCL, May 2026)
- File: `hylat-hybrid-latent-text.pdf`
- Source: https://arxiv.org/pdf/2605.25421
- Single-channel communication trilemma: text = interpretable but verbose; latent vectors = efficient but opaque and unidirectional-workflow-only
- Dual-channel protocol: elaborate cognitive signals (explanations, deductions, examples) in a latent channel; concise critical signals (decisions, conclusions) in natural language - keeps humans/monitors in the loop on what matters
- Two-stage training: single-agent hybrid generation learning, then multi-agent interactive co-training so agents both emit and interpret hybrid messages across rounds; significant token-overhead reduction at competitive task performance, robust across settings; code github.com/xymou/hylat

## Internet of Agents: Weaving a Web of Heterogeneous Agents for Collaborative Intelligence (arXiv 2407.07061, Tsinghua/PKU/Tencent)
- File: `internet-of-agents-collaboration-framework.pdf`
- Source: https://arxiv.org/pdf/2407.07061
- Instant-messaging-app-like server/client architecture: server = Agent Query Block (search agents by characteristics), Group Setup Block (create/manage group chats), Message Routing Block, Agent Registry (capabilities + current status), Session Management (WebSocket connections); client = protocol wrapper around any third-party agent
- Discovery: search_client maps desired-characteristic lists to matching registered agents via semantic retrieval; then launch_group_chat forms a room; nested team formation spawns sub-group chats per subtask to cut fully-connected channel count
- Conversation-flow finite state machine: {discussion, synchronous task assignment, asynchronous task assignment, pause-and-trigger, conclusion}; LLM decides transitions AND next_speaker; sequential speaking (one agent at a time); states aligned with speech-act theory
- Message protocol: header {sender, group_id}, payload {message_type, next_speaker, ...}; standardized task execution interface run: String -> TaskID
- Results: GAIA 40.0 overall vs AutoGen 39.39; team formation Top@10 recall 64.9% (regular) / 81.8% (nested)

## Internet of Agents: Fundamentals, Applications, and Challenges (arXiv 2505.07176, IEEE TCCN Oct 2025)
- File: `internet-of-agents-fundamentals.pdf`
- Source: https://arxiv.org/pdf/2505.07176
- IoA = agent-centric infrastructure: machine-oriented data objects (model params, encrypted tokens, latent representations) replace human-oriented data; GUI interaction replaced by semantic-aware goal-driven communication with auto-negotiation
- Scalability blueprint: hierarchical sharding (clusters by geography/function/task-affinity; domain gateways host proxy agents registering local agents and broadcasting capabilities; relay gateways for cross-domain state sync); adaptive task-oriented overlay networks (transient micro-swarms that self-assemble per mission and dissolve); distributed peer-health monitoring with automatic rerouting
- Semantic-aware communication traits: computing-oriented (sync knowledge base first, then transmit only task-relevant inferences), persistent (shared context over long collaborations), memory-based (transmit deltas vs previously shared knowledge)
- Agent-task matching: decentralized registry with semantic metadata, matched on workload, proximity, reliability, QoS; team formation via negotiation of roles/priorities/execution flows

## InterSAGE: The Secure and Verifiable Interoperability Protocol for An Internet of Agents (Zou, Guo, Zhan, Zhao, Li, Liu; DeepKernel Lab)
- File: `intersage-audit.pdf`
- Source: https://arxiv.org/pdf/2608.13030
- Read pages 1-12 and 19-28. Four trust layers (L0 identity via Agent Identity Cards with 4-dimensional binding developer/code/operator/context, L1 discovery via DID-bound Verifiable Credential manifests, L2 trust negotiation via monotonic capability attenuation, L3 accountability); dated Aug 14 2026, explicitly a positioning paper with specs deferred to companion publications.
- L3 Trace Entry format (Section 7.3): {trace_id, agent_id (DID), action_type: tool_call|delegation|message|payment, action_params, action_result, session_id, timestamp, prev_hash, signature = Sign_Kpriv(payload || prev_hash)}; prev_hash chains entries into a tamper-evident log; signature binds each entry to the agent's cryptographic identity for non-repudiation without any ledger.
- Kernel-mediated signing: agent's Ed25519 Kpriv held only by a kernel (tiers: 0o600 file / OS keychain / TEE); application logic and a prompt-injection-compromised LLM cannot forge or rewrite history; verifier needs only the Global Agent Registry root key; chain heads optionally anchored to public timestamping or a ledger for stronger immutability.
- Token-Usage Record: {agent_id, session_id, provider, model, input_tokens, output_tokens, timestamp, delegation_chain (ordered AIC IDs root to leaf), signature}, enabling per-user/per-agent cost attribution up the delegation tree in multi-tenant settings.
- Design principle P1/P2: trust primitives EMBED into existing protocol messages (an MCP invocation carries an AIC capability boundary; an A2A interaction carries a session token; AG-UI event streams attach signed execution traces) without changing host protocol wire formats; audit guarantee survives even if the discovery or negotiation layers are compromised (composition safety via downward-only dependencies).

## JADE: A FIPA-compliant Agent Framework (Bellifemine, Poggi, Rimassa, PAAM 1999)
- File: `jade-fipa-framework-1999.pdf`
- Source: https://jmvidal.cse.sc.edu/library/jade.pdf
- Platform auto-starts AMS + DF + ACC; agents auto-register with AMS and receive a GUID at startup; multiple runtime DFs support logical multi-domain applications
- Distributed containers (one JVM/host, agent = one thread) with a front-end Agent Global Descriptor Table kept consistent by creation/termination notifications from containers; container references cached with re-lookup on stale-cache RMI exceptions
- Transport optimization inside the trust boundary: same-container messages passed as Java objects with zero marshalling, cross-platform messages converted to FIPA string encoding over IIOP: canonical wire format outside, fast path inside
- Ships a ready-to-use FIPA interaction protocol library plus operational tooling (RMA GUI to suspend/resume/kill/ping agents, DF GUI showing df-state=active); management GUI itself is an agent speaking ACL
- FIPA design assumptions restated: standards must be timely and specify only external behavior, leaving internals proprietary

## KQML as an Agent Communication Language (Finin, Fritzson, McKay, McEntire, CIKM 1994 / Bradshaw chapter version)
- File: `kqml-acl-finin-1994.pdf`
- Source: https://www.csee.umbc.edu/csee/research/kqml/papers/kqmlacl.pdf
- Defines the three-layer message model (content/message/communication) so intermediaries can route messages whose content is opaque; message = performative + keyword parameters, e.g. (ask-one :content (PRICE IBM ?price) :receiver stock-server :language LPROLOG :ontology NYSE-TICKS)
- Facilitators: agents register on startup and unregister on exit so 'applications can find each other without there having to be a hand maintained list of local services'; one facilitator per local agent group; capability advertisement is a message template: (advertise :content (monitor :content (PRICE ?x ?y)))
- Five mediation patterns distinguished by reply routing: recommend (returns agent NAME, then point-to-point), broker (relays answer), recruit (answer goes directly to asker), subscribe, monitor (= subscribe(stream-all))
- Streaming and cursor control: stream-all with eos end marker; generator performatives standby/ready/next/rest/discard = server-side cursors/pagination
- Transport-agnostic: implemented over TCP/IP, email, Linda, HTTP, CORBA; per-agent router + embedded KRIL API (send-kqml-message, declare-message-handler)

## A Proposal for a New KQML Specification (KQML-97, Labrou & Finin, TR CS-97-03, Feb 1997)
- File: `kqml97-spec-labrou-finin.pdf`
- Source: https://www.csee.umbc.edu/csee/research/kqml/papers/kqml97.pdf
- Transport abstraction stated as explicit assumptions: unidirectional discrete-message links, non-zero delay, per-destination ordering, reliable delivery, with the caveat that transport reliability is useless without agent reliability (a policy issue)
- Keyword-indexed order-independent parameters; reserved parameter table: :sender :receiver :from :to :in-reply-to :reply-with :language :ontology :content; :from/:to carry virtual origin/destination when forward is used (proxy addressing)
- Reserved parameter keywords exist so programs can partially understand performatives with unknown names but known parameters (graceful degradation for extensibility)
- Reorganizes performatives into three categories: discourse; intervention/mechanics of conversation; networking and facilitation (broker-one, recommend-one, recruit-one, forward), with worked request/response figures for each facilitation verb

## A Semantics Approach for KQML (Labrou & Finin, CIKM 1994)
- File: `labrou-finin-kqml-semantics-1994.pdf`
- Source: https://www.csee.umbc.edu/~finin/papers/cikm94.pdf
- Gives performatives pre/post/completion-condition semantics using Bel/Know/Want/Intend operators; core table: tell, deny, ask-if, ask-all, stream-all, eos, error, sorry
- Conversation policies implemented as Augmented Transition Networks: explicit state machines over allowed message sequences, an early 'interaction protocol' formulation
- Agent architecture: application + handler functions + conversation module + content-independent router
- Defines facilitators as 'specialized agents... primarily holding information regarding the query answering capabilities of the agents in their network domain' and lists three query-routing modes (know capabilities a priori, ask facilitator to deliver, ask facilitator to recommend)

## Agent Communication Languages: The Current Landscape (Labrou, Finin, Peng, IEEE Intelligent Systems 14(2), Mar/Apr 1999)
- File: `labrou-finin-peng-acl-landscape-1999.pdf`
- Source: https://www.csee.umbc.edu/~finin/papers/ieee99.pdf
- Insider post-mortem by KQML's authors: KQML dialects could not interoperate; no sanctioned spec; FIPA ACL syntax intentionally near-identical to KQML but with incompatible BDI-based semantics (SL feasibility preconditions + rational effect)
- The infrastructure indictment: 'there is no service where one can register an agent by just sending a registration message'; standardization focused on semantics while naming, registration, facilitation and APIs were left per-implementation, producing 'a multitude of APIs'; FIPA even dropped KQML's broker/recommend/recruit primitives and users demanded them back
- Semantic verifiability critique: grounding BDI theory in code 'will result in a system that differs substantially and unpredictably from the theory'; programmers follow intuitive readings of performatives anyway; recommends shifting to observable conversations and conversation policies
- Web blindness diagnosed in 1999: no major industry player or Internet standards body had ACLs on its agenda; authors recommend adopting web substrates (XML/RDF) and note that as of spring 1998 no published deployed system used FIPA ACL

## A Layered Protocol Architecture for the Internet of Agents (arXiv 2511.19699 v3, Cisco Research, Jan 2026)
- File: `layered-protocol-architecture-ioa.pdf`
- Source: https://arxiv.org/pdf/2511.19699
- L8 Agent Communication Layer = envelope (sender, receivers, message ID, performative) + speech-act performatives (REQUEST/AGREE/REFUSE/INFORM; PROPOSE/ACCEPT/REJECT/COUNTER_PROPOSE; QUERY/SUBSCRIBE/PUBLISH) + interaction patterns (request-reply, publish-subscribe, aggregation N:1, collaboration groups N:N)
- SLIM (IETF draft draft-mpsb-agntcy-slim) recommended for group patterns: pub-sub, streaming RPC, MLS end-to-end group encryption, hierarchical naming; HTTP/2/3 recognized as the de facto Application Transport Layer (L7)
- L9 Agent Semantic Layer: versioned Shared Contexts (URN e.g. urn:contexts:travel:v2.1, JSON Schema/RDF-OWL/Protobuf) locked via SL-HELLO/SL-SELECT/SL-LOCK handshake creating cacheable semantic sessions; grounding, validation, disambiguation, consensus primitives (Ripple Effect Protocol arXiv 2510.16572); latent/embedding-space contexts allowed between agents sharing embedding models
- New attack taxonomy: semantic injection, context poisoning/spoofing, semantic DoS (exhausts LLM inference budget not bandwidth), semantic downgrade; defenses: signed contexts with minimum-version negotiation, semantic firewalls (concept-level authz + rate limiting), federated Schema Authorities; SL-HELLO capability disclosure itself is sensitive and must ride the encrypted channel
- Historical diagnosis: FIPA-ACL failed via heavyweight KIF/SL ontologies and an :ontology field that was only a label with no negotiation; current protocols (A2A/MCP) standardize syntax but not semantic agreement, forcing expensive clarification loops

## Analysis of the Matrix Event Graph Replicated Data Type (Jacob, Beer, Henze, Hartenstein, KIT, arXiv 2011.06488, Nov 2020)
- File: `matrix-event-graph-crdt.pdf`
- Source: https://arxiv.org/pdf/2011.06488
- Read pages 1-6. Matrix is characterized as decentralized topic-based publish-subscribe middleware that replaces pure message passing with a replicated per-topic data structure: the Matrix Event Graph (MEG), a rooted DAG where vertices are events (communication events or state-update events) and edges point to the 'forward extremities' (childless vertices) known to the appending replica, encoding Lamport happened-before causality.
- Formal result: the MEG is an operation-based CRDT (generator/effector with a delivery precondition that all referenced parents exist locally, i.e. Causal Order Reliable Broadcast) and therefore provides Strong Eventual Consistency; concurrent updates are handled by ACCEPTING forks (two causally independent chains) and merging them when the next event selects both extremities as parents - no rollbacks, no linearization, availability under network partition.
- Byzantine tolerance: because the MEG never seeks consensus, it operates with n > f (any number of byzantine faults among participants) in the fail-silent-arbitrary model - equivocating replicas simply create forks that get merged; contrast with consensus systems needing n > 3f. A Reference Monitor at each replica gates unauthorized operations (Matrix's access control builds on top).
- Practical engineering detail: the number of parent events per new event must be capped at a finite d (Matrix implementations restrict parent count) because algorithms scale poorly with many parents; replicas select a subset of forward extremities when more than d exist, and clients must inform the replica of actual causal dependencies.
- Scalability of concurrency: Markov-chain analysis of DAG width (count of forward extremities) under k replicas independently appending shows the width converges to near-optimal in a small number of iterations and does not degenerate - i.e. a busy multi-writer room heals its own forks quickly. Authors note prior work found scalability problems in Matrix's broadcast layer (federation traffic), not in the data structure itself.

## MCP 2026-07-28 changelog and server/discover (context documents)
- File: `mcp-2026-07-28-changelog.mdx`
- Source: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx
- Read in full (also downloaded discover.mdx to /Users/paulbeneteau/Dev/agent-com/research/papers/mcp-2026-07-28-discover.mdx). Stateless core: initialize removed, per-request _meta (protocolVersion, clientInfo, clientCapabilities); server/discover mandatory, returns supportedVersions/capabilities/instructions/ttlMs/cacheScope.
- Cross-call state = explicit server-minted handles passed as ordinary tool arguments (SEP-2567) - the sanctioned pattern for a room handle.
- Tasks moved from core experimental to official extension (SEP-2663): blocking tasks/result replaced by polling tasks/get plus tasks/update; error codes repartitioned (-32020..-32099 spec-reserved; MissingRequiredClientCapability -32021); Roots/Sampling/Logging deprecated; CacheableResult(ttlMs, cacheScope) required on list/read results.

## MCP 2026-07-28 core spec: Multi Round-Trip Requests (MRTR, SEP-2322)
- File: `mcp-2026-07-28-mrtr.mdx`
- Source: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/patterns/mrtr.mdx
- Read in full. Server-initiated requests are removed; servers MUST use MRTR: return InputRequiredResult{resultType input_required, inputRequests? (map to ElicitRequest|CreateMessageRequest|ListRootsRequest), requestState? opaque}; client retries the ORIGINAL request (new id) with inputResponses and echoed requestState.
- requestState is attacker-controlled: MUST be integrity-protected (HMAC/AEAD) when it affects authz/logic, SHOULD bind principal + TTL + request digest; single-use must be enforced server-side.
- Only prompts/get, resources/read, tools/call may return InputRequiredResult; enables fully stateless servers (no shared storage, no sticky LB) for pending-input flows.

## MCP 2026-07-28 core spec: Streamable HTTP transport
- File: `mcp-2026-07-28-streamable-http.mdx`
- Source: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx
- Read in full. Single POST endpoint; each client message its own POST; response = JSON or request-scoped SSE stream; notifications on a request stream MUST relate to that request; server MUST NOT send independent JSON-RPC requests on any stream (breaking change vs 2025-03-26..2025-11-25).
- The 2025-11-25 rule 'MUST NOT broadcast the same message across multiple streams' (transports.mdx line 160 of that revision) does not appear in 2026-07-28; per-request scoping replaces it; nothing constrains cross-client fanout of equivalent notifications on separate listen streams.
- No protocol sessions, no Mcp-Session-Id; required headers Mcp-Method and Mcp-Name; Origin validation MUST (DNS rebinding); X-Accel-Buffering: no recommended; SSE comment-line keep-alives; Last-Event-ID resumability removed - broken stream = re-issue request.

## MCP 2026-07-28 core spec: Subscriptions (subscriptions/listen)
- File: `mcp-2026-07-28-subscriptions.mdx`
- Source: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/patterns/subscriptions.mdx
- Read in full. Long-lived request replacing resources/subscribe and the HTTP GET endpoint; closed core filter set: toolsListChanged, promptsListChanged, resourcesListChanged, resourceSubscriptions[URIs]; server MUST NOT send unrequested types.
- Handshake: first message MUST be notifications/subscriptions/acknowledged echoing the honored subset; subscriptionId (= listen request JSON-RPC id) tagged in _meta on every notification; multiple concurrent subscriptions demuxed by it.
- Teardown: client closes SSE stream (HTTP) or notifications/cancelled (stdio); server graceful close = empty result (resultType complete) to the listen request; on stdio reconnect client MUST re-subscribe, server holds no subscription state; no resumability.

## A First Look at the Security Issues in the Model Context Protocol Ecosystem (Li and Gao, University of Delaware, accepted DSN 2026, arXiv 2510.16558)
- File: `mcp-ecosystem-first-look.pdf`
- Source: https://arxiv.org/pdf/2510.16558
- Cross-entity study of 67,057 MCP servers across 6 registries (mcp.so, MCP Market, MCP Store, Pulse MCP, Smithery, npm); two-stage attack surface (registry-level plus post-integration).
- Registry attacks: Maintainer Hijacking (deleted GitHub accounts re-registrable after 90 days) equals 212 hijackable cases; Redirection Hijacking equals 304 cases; Affix-squatting equals 80.6% of 408 same-name/different-affix package groups are different developers (mcp-, -mcp, mcp-package-server patterns).
- Credential leakage: gitleaks found 9 GitHub tokens embedded in mcp.so server configs, 5 still valid at disclosure; 1,379 invalid/dangling server links across registries.
- Post-integration: Tool Confusion (Cursor always invokes the FIRST-listed tool regardless of which the LLM selected), Tool Poisoning (malicious IMPORTANT-tag instructions, ASR up to 100% on Claude Sonnet 4 / Gemini 2.5 Pro incl via crafted error messages), Tool Shadowing (a malicious tool description alters a benign tool without being invoked), Context-dangling Tool (host invokes a stale tool from context history).
- Root cause: none of the four hosts verify that the LLM-selected tool identity matches the invoked tool, and all blindly trust unsigned tool metadata; auto-update plus npx-latest amplify.

## MCP Tasks extension specification (io.modelcontextprotocol/tasks, draft, ext-tasks repo)
- File: `mcp-ext-tasks-spec.md`
- Source: https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/draft/tasks.md
- Read in full (910 lines). Methods tasks/get, tasks/update, tasks/cancel; state machine working -> input_required <-> working -> {completed, failed, cancelled}; no tasks/list by design (prevents cross-caller task enumeration); task IDs are bearer tokens requiring entropy.
- tasks/update = {taskId, inputResponses} answering only currently-outstanding server-issued inputRequests (keys unique over task lifetime, partial subsets allowed, unknown keys ignored, eventually consistent ack). It is NOT a free-form client push channel.
- notifications/tasks carries the complete DetailedTask; subscribed by adding taskIds: string[] to subscriptions/listen params.notifications; ack via notifications/subscriptions/acknowledged; notifications/progress and notifications/message MUST NOT ride the listen stream for a task.
- Server-directed creation: CreateTaskResult (resultType task) returned at server discretion only to clients declaring the extension per-request; -32003 Missing Required Client Capability otherwise (GA core renumbered to -32021); MUST be durably created before returning (no speculative polling).
- Streamable HTTP sticky routing: Mcp-Name header MUST equal params.taskId on all task methods.

## Model Context Protocol (MCP): Landscape, Security Threats, and Future Research Directions (Hou, Zhao, Wang, Wang; HUST; arXiv 2503.23278 v3, 7 Oct 2025)
- File: `mcp-landscape-security.pdf`
- Source: https://arxiv.org/pdf/2503.23278
- First systematic academic analysis of the MCP ecosystem: architecture (host/client/server with strict 1:1 client-server links), server lifecycle in 4 phases (creation, deployment, operation, maintenance) across 16 activities, and a threat taxonomy (4 attacker archetypes, 16 threat scenarios incl. tool poisoning and installer spoofing).
- Positions MCP's innovations vs function calling: protocol-based standard, dynamic discovery and schema negotiation at runtime, bi-directional communication channels (tool-initiated events/notifications back to host), access control and capability negotiation as first-class primitives - 'from tool bindings hardcoded per application toward an interoperable ecosystem of composable, discoverable network services'.
- Operation-phase activities relevant to rooms: intent analysis, external resource access, tool invocation, session management ('maintains the logical continuity between user interactions and server processes').
- Ecosystem table (Sept 2025) documents adoption across Anthropic, OpenAI, Gemini, Copilot Studio, Cursor, Cline, JetBrains, Zed, Cloudflare, Stripe, Block, Alipay; notes security, tool discoverability, and remote deployment as the ecosystem's open gaps.
- Notes the official registry effort as Anthropic's response to fragmented third-party MCP marketplaces (verified listings, unified distribution).

## SEP-2133: Extensions (MCP extensions framework, Status Final)
- File: `mcp-sep-2133-extensions.md`
- Source: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2133-extensions.md
- Read in full (263 lines). Extension id {vendor-prefix}/{name} with mandatory reversed-domain prefix; breaking changes require a NEW identifier; settings objects negotiated in extensions maps in client/server capabilities.
- Official extensions live in ext-* repos in the MCP org with delegated maintainers and iterate WITHOUT core review; experimental-ext-* incubation path; unofficial third-party extensions are legitimate and ungoverned; SDK implementations MUST default-off.
- Graceful degradation MUST revert to core behavior or reject; explicitly NOT specified: schema advertisement, extension dependencies, profiles - so a rooms extension defines its own schema conventions.

## MCPTox: A Benchmark for Tool Poisoning Attack on Real-World MCP Servers (Wang et al., USTC plus Beihang, arXiv 2508.14925, Aug 2025)
- File: `mcptox-tool-poisoning.pdf`
- Source: https://arxiv.org/pdf/2508.14925
- First large-scale tool-poisoning benchmark on 45 LIVE real-world MCP servers, 353 authentic tools, 1,312 malicious test cases across 11 risk categories.
- 20 LLM agents evaluated: o1-mini 72.8% attack success rate; GPT-4o-mini, DeepSeek-R1, Phi-4 all exceed 60%; more-capable models are MORE susceptible because superior instruction-following makes them obey poisoned descriptions.
- Existing safety alignment is ineffective: maximum refusal rate across all agents is under 3% (Claude-3.7-Sonnet highest).
- Three attack paradigms: Explicit-Trigger Function Hijacking (224), Implicit-Trigger Function Hijacking (548), Implicit-Trigger Parameter Tampering (725, the largest class, e.g. silently rewrite email recipient).
- Effective poisoned tool description equals Trigger Condition plus Malicious Action plus Plausible Justification; repurposing plain IPI payloads into descriptions yields about 0% ASR without the trigger structure.

## Here Comes The AI Worm: Zero-click Worms Targeting GenAI-Powered Applications / Morris-II (Cohen, Bitton, Nassi, Technion plus Intuit, arXiv 2403.02817, v2 Jan 2025)
- File: `morris-ii-ai-worm.pdf`
- Source: https://arxiv.org/pdf/2403.02817
- Defines the adversarial self-replicating prompt equals jailbreak plus replication-instruction plus malicious-payload; survives multiple inferences and copies itself into each application output.
- Propagates zero-click through RAG-backed ecosystems (email assistants Copilot/Gemini-for-Workspace) via active database updating: received content auto-indexed into RAG then retrieved when generating new messages, replicating the worm.
- Two propagation modes (contaminating a new email vs a reply); propagates roughly 1 in every 5 emails.
- Replication plus payload success stays over 90% through about 11 hops; degrades to 40-80% by hop 20 due to model nondeterminism; Claude 3.5 Sonnet held about 100% replication vs Gemini 1.5 Pro 64%.
- Retrieval success depends heavily on embedding model and prefix similarity - targeting a specific org by adding its names raises retrieval/replication.

## Beyond DNS: Unlocking the Internet of AI Agents via the NANDA Index and Verified AgentFacts (arXiv 2507.14263, MIT et al., v0.3 RFC draft)
- File: `nanda-index-beyond-dns.pdf`
- Source: https://arxiv.org/pdf/2507.14263
- DNS unfit for agents: minute-to-hour update cycles vs millisecond orchestration needs; ownership-only trust (TLS proves domain ownership, nothing about agent code/behavior); fixed A/AAAA records cannot track agents that move endpoints every few seconds
- Lean index: ~<=120-byte records holding only agent ID, credential pointers, AgentFacts URL - minimizes index writes; <1s global propagation target
- AgentFacts: signed JSON-LD self-descriptions (capabilities, endpoints, auth info) with @context for forward-compatible schema evolution, updatable without index writes; TTL-based endpoint resolution enables caching, DDoS shielding, moving endpoints
- Trust: cryptographic verification from whitelisted issuers; short-lived (<5 min) verifiable credentials give sub-second revocation; dual-path privacy resolution hides who is asking for what (split-horizon supported)
- Federation model: 'quilt of registries' - index either directly certifies agents or merely redirects to enterprise/platform registries retaining control; index converts N-squared pairwise discovery into 2N handshake, then drops out of the path until session TTL expires

## Blackboard Systems: The Blackboard Model of Problem Solving and the Evolution of Blackboard Architectures (H.P. Nii, AI Magazine 7(2), 1986)
- File: `nii-blackboard-systems-1986.pdf`
- Source: https://ojs.aaai.org/aimagazine/index.php/aimagazine/article/view/537
- Three components: independent knowledge sources (never call each other; each knows its own activation preconditions), the blackboard (global hierarchical store of partial solutions; ALL interaction happens solely through blackboard changes, which are logged as control data), and control (monitors changes, selects a focus of attention: next KS, next object, or both)
- Model abstracted from Hearsay-II speech understanding (1971-76) and HASP sonar interpretation; opportunistic, incremental (one step at a time), any reasoning direction at each step
- Jigsaw-with-monitor analogy: serialized blackboard access with hand-raising and an executive scheduler choosing among volunteers: the prototype of modern group-chat speaker selection
- Explicitly a conceptual framework, not a computational spec; control policy is the hard, application-specific part and termination criteria must be designed in

## Prompt Infection: LLM-to-LLM Prompt Injection within Multi-Agent Systems (Lee and Tiwari, UCL plus Stanford, arXiv 2410.07283, Oct 2024)
- File: `prompt-infection-multi-agent.pdf`
- Source: https://arxiv.org/pdf/2410.07283
- Introduces self-replicating LLM-to-LLM injection with four components: Prompt Hijacking, Payload (role/tool-specific), Data (accumulating shared note), Self-Replication; behaves like a computer virus.
- ARCHITECTURE FINDING: global messaging (agents share full history) spreads infection more (over 2 agents easily, about 20% higher ASR) than local messaging (partial/predecessor-only); self-replication is the ONLY scalable way to compromise more than 2 agents under local messaging - argues for scoped message visibility.
- Infection follows logistic growth; larger agent populations infect faster per-agent and saturate sooner.
- Can poison memory retrieval by inflating LLM-assigned importance scores (GPT-4o 1.94 to 10.0 via a rate-this-10 instruction), creating a persistence feedback loop.
- Defense LLM Tagging (prepend agent-name origin marker) alone reduces ASR only about 5%; combined Marking plus LLM-Tagging prevents ALL attacks, Instruction-Defense plus LLM-Tagging to 3% - tagging necessary but insufficient alone.

## ProtocolBench: Which LLM MultiAgent Protocol to Choose? (arXiv 2510.17149 v3, UIUC/SJTU/ORNL/Yale, ICML 2026)
- File: `protocolbench.pdf`
- Source: https://arxiv.org/pdf/2510.17149
- First protocol-agnostic benchmark with native adapters for A2A, ACP, ANP, Agora; four axes: task success/quality, end-to-end latency, message/byte overhead, robustness under failures; non-protocol factors pinned
- GAIA: A2A best (quality 2.51, success 9.29, +27.6% over next); Streaming Queue: ACP fastest (9.663s mean, std 1.08) with A2A statistically indistinguishable; ANP +17.6% latency, Agora +35.9% with heavy tails; completion time varies up to 36.5% by protocol
- Fail-Storm (cyclic node kills): A2A retains 98.85% of pre-fault answer discovery thanks to nearly-stateless HTTP endpoints + idempotent retries; ACP 92.41%, ANP 86.96%, Agora 81.29%
- Safety Tech: ANP and Agora cover all five security dimensions (TLS, session hijack, E2E encryption, tunnel sniffing, metadata leakage); A2A/ACP lack TLS-misconfig and tunnel-sniffing protection
- Adapter overhead scaling 4->32 agents: ACP ~N^0.16 (0.13->0.18ms), A2A ~N^1.06 (1.2->10.5ms), Agora linear (4->33.6ms) - all negligible vs multi-second LLM inference; stateless cross-protocol bridges add ~0.8ms/event

## Agent Communication Languages: Rethinking the Principles (M.P. Singh, IEEE Computer 31(12), Dec 1998)
- File: `singh-acl-rethinking-1998.pdf`
- Source: https://www.csc2.ncsu.edu/faculty/mpsingh/papers/mas/computer-acl-98.pdf
- Core argument: FIPA/KQML semantics ground meaning in sender mental states, so compliance cannot be tested ('there is no way to determine whether Avi believes it is raining'); a standard whose conformance is undecidable from public behavior cannot function as a standard
- Sincerity assumptions inherited from Arcol make the semantics inapplicable to negotiation/e-commerce among self-interested agents; KQML's lack of any enforced semantics bred mutually unintelligible dialects and idiolects
- Prescriptions: social semantics via public commitments; protocols matter more than individual acts; agents join groups/societies in ROLES that confer commitments (a 1998 blueprint for room membership with role-based obligations); compliance testing from observable behavior
- Coverage analysis: KQML and Arcol handle only assertives and directives out of seven speech-act categories (missing commissives, permissives, prohibitives, declaratives): relevant when designing verbs for promises/permissions in agent teams

## The Contract Net Protocol: High-Level Communication and Control in a Distributed Problem Solver (R.G. Smith, IEEE Trans. Computers C-29(12), Dec 1980)
- File: `smith-contract-net-1980.pdf`
- Source: https://www.reidgsmith.com/The_Contract_Net_Protocol_Dec-1980.pdf
- Task announcement slots: task abstraction (rankable summary), eligibility specification (prunes bidders, cuts traffic), bid specification (defines exactly what a bid must contain so bids stay short), expiration time; addressing modes: broadcast, limited broadcast, point-to-point
- Immediate response bids: nodes reply BUSY / INELIGIBLE / LOW RANKING instead of staying silent, so the manager can distinguish overload from incapability and choose reissue vs loosen-eligibility vs do-it-itself: presence-aware refusal semantics
- Node-available messages invert the protocol under load: idle node broadcasts capabilities + eligibility criteria + expiration; managers match against waiting tasks; nodes choose announcement-driven vs availability-driven mode based on observed load
- Directed contracts (skip bidding when the target is known) and plain request/information messages 'without further embellishment': an explicit escalation ladder from RPC to negotiation
- Interim vs final reports (streaming partial results, manager can suspend/continue contractor); termination message cascades cancellation to all subcontracts; contract states READY/EXECUTING/ANNOUNCED/SUSPENDED/TERMINATED

## SPADE 3: Supporting the New Generation of Multi-Agent Systems (Palanca, Terrasa, Julian, Carrascosa, IEEE Access vol. 8, Sept/Oct 2020, DOI 10.1109/ACCESS.2020.3027357)
- File: `spade3-xmpp-multiagent.pdf`
- Source: https://ieeexplore.ieee.org/ielx7/6287639/8948470/09207929.pdf
- Read pages 1-6. Argues (pre-LLM, 2020) that the next generation of MAS needs: a standard well-known communication protocol instead of proprietary platform middleware, elastic communication resources, full human-agent integration ('Human-Agent Societies' where humans, agents and third parties enter/exit transparently), and device/location independence - and that instant messaging protocols are the natural fit since they already support 'almost any type of interaction between humans or between humans and computers.'
- SPADE 3 architecture: agents register on any XMPP server with a JID (username@server) and password; agent logic = behaviors of five types (Cyclic, One-Shot, Periodic, Time-Out, Finite State Machine); a per-agent message dispatcher acts as a mailman routing incoming messages to the behavior(s) expecting them; agent identity is the JID, so agents migrate between machines with no re-addressing (explicit contrast with platforms that bake IP addresses into agent identifiers).
- Presence as a coordination primitive (Figure 2, read on page 6): a manager agent implements a synchronization barrier purely with XMPP presence - workers set presence status 'ready!', the manager (subscribed to them as contacts) waits until all show ready, sets its own status to 'start!', workers flip to 'working' and the manager watches completion in real time. Presence also broadcasts internal FSM state changes to contacts. Contact lists are managed by XMPP subscription requests, with an optional auto-accept mode.
- Deployment flexibility from XMPP federation: three configurations - deploy your own public XMPP server, use existing public servers with zero infrastructure, or run a private non-federated server - giving centralized benefits (server-side presence notification, persistent storage, strong auth) on a distributed architecture that scales by adding servers at runtime.
- Historical positioning: reviews JADE/FIPA lineage (Agent Management Service, Directory Facilitator) as closed proprietary stacks whose discovery services this IM-based approach replaces; SPADE was the FIPA-era idea rebuilt on an open IM standard, which is precisely the lineage the user's MCP-era room protocol continues.

## A Survey of AI Agent Protocols (Yang et al.; Shanghai Jiao Tong Univ. + ANP Community; arXiv 2504.16736 v3, 21 Jun 2025)
- File: `survey-ai-agent-protocols.pdf`
- Source: https://arxiv.org/pdf/2504.16736
- Two-dimensional taxonomy: context-oriented (MCP) vs inter-agent protocols (A2A, ANP, Agora), general-purpose vs domain-specific; proposes 7 evaluation dimensions (efficiency, scalability, security, reliability, extensibility, operability, interoperability) with concrete metrics like Capability Negotiation Score = (successful negotiations/attempts)/avg negotiation time.
- Use-case analysis (same trip-planning task on 4 protocols): MCP = 'single agent invokes all tools', strict star pattern, central client aggregates everything; verdict: 'excels in simplicity and control but lacks flexibility. The central agent must be aware of all services... all communication must pass through the central agent, potentially creating a performance bottleneck.'
- A2A contrast: intelligence distributed across specialized agents in departments, direct agent-to-agent dependencies without central mediation; ANP adds cross-domain DID-based negotiation; Agora generates protocols from natural language.
- Recommends contextual fit: MCP for tool/data integration, A2A for enterprise inter-agent collaboration, ANP for cross-domain internet-scale agent markets.
- Scalability section emphasizes agent protocols must handle dynamic node discovery and coordination, unlike static internet protocols - a gap the survey implies MCP does not fill (no dynamic agent discovery).

## A Technical Taxonomy of LLM Agent Communication Protocols (TUM)
- File: `taxonomy-llm-agent-protocols.pdf`
- Source: https://arxiv.org/pdf/2606.19135
- Read pages 1-8 plus the classification and findings sections via text extraction (June 17, 2026; 52 pages). Nine actively maintained protocols sampled: MCP, A2A, LangChain Agent Protocol (LAP: /runs, /threads, /store endpoints), agents.json, Agora, ANP, LMOS, ACP, agntcy; AITP was excluded as insufficiently maintained/adopted.
- Five accepted dimensions: counterparty (agent vs context), payload (structured / conversation-focused / hybrid), interaction state, discovery mechanism (static / centralized / partially centralized / decentralized / hybrid), schema flexibility (single / multiple / evolving).
- Findings: all 7 agent-to-agent protocols pair hybrid payloads with session state; 7/9 support multiple schemas and 2 (Agora, ANP) evolve schemas at runtime; discovery is mostly centralized registries (4/9) or static config (4/9); LMOS is the only genuinely decentralized discovery (mDNS/DNS-SD + federated directories); rejected dimensions include persistent state (noting A2A Agent Card and ACP Agent Detail as metadata persistence, LAP /store as context persistence).
- Predicts no winner-takes-all: proposes a federated layered stack: agents.json-style static discovery, MCP for structured tool execution, A2A/LAP/ACP for tasks and streaming, Agora/ANP for schema-evolving deliberation, with ANP/LMOS/agntcy also providing identity/transport substrate; notes A2A and agntcy present themselves as MCP extensions but Anthropic has endorsed neither.
- Maps everything onto Marro's trilemma: MCP maximizes efficiency/portability with rigid schemas; Agora/ANP maximize versatility at negotiation cost; A2A/LMOS/ACP occupy the pragmatic center; identifies privacy safeguards and policy enforcement as the field-wide gap.

## Security Threat Modeling for Emerging AI-Agent Protocols: A Comparative Analysis of MCP, A2A, Agora, and ANP (Anbiaee et al., Canadian Institute for Cybersecurity plus Mastercard, arXiv 2602.11327, Apr 2026)
- File: `threat-modeling-agent-protocols.pdf`
- Source: https://arxiv.org/pdf/2602.11327
- First systematic NIST-SP-800-30 lifecycle threat model of the 4 major protocols; 12 vulnerabilities across create/operate/update phases with likelihood-times-impact risk matrix.
- Creation/configuration (registration plus discovery) is the highest-risk phase because weak identity/integrity there becomes systemic and hard to fix.
- Per-protocol identity verdicts: MCP high-risk (no strict identity validation, self-declared capabilities, no token expiry); A2A medium (OAuth2/JWT but no global uniqueness, no mandatory issuer-bound provenance); Agora high (optional/self-declared identity); ANP lowest (W3C DID plus E2E encryption, DIDs guarantee uniqueness).
- Falsifiable MCP case study: same-tool-name across two servers with no identity binding yields wrong-provider execution at Violation Rate 0.52-1.0 depending on resolver policy; proves missing mandatory identity binding is exploitable.
- Explicit design mandate: any interoperability layer MUST define a minimal canonical mapping of identity plus capability plus provenance and bind it to protocol context to stop relay/downgrade attacks.

## Toward a Safe Internet of Agents (arXiv 2512.00520)
- File: `toward-safe-internet-of-agents.pdf`
- Source: https://arxiv.org/pdf/2512.00520
- Downloaded and verified as a valid PDF but only lightly examined in this pass (security dimension covered by other papers): analyzes safety across three tiers - single agents, multi-agent systems, and interoperable multi-agent systems (IMAS)

## Position: Collaborative Agentic AI Needs Interoperability Across Ecosystems / Web of Agents (arXiv 2505.21550 v2, EPFL+MIT, ICML 2026)
- File: `web-of-agents-position.pdf`
- Source: https://arxiv.org/pdf/2505.21550
- Four minimal building blocks: HTTP-based agent-to-agent messaging; interaction interoperability via interaction documents (structured or natural language, LLMs can interpret and ask clarifying questions); state management via web sessions + databases; discovery via URL/DNS unique endpoints + capability advertisement at RFC 8615 well-known paths + crawler-based agent search engines
- Explicitly argues against mandating JSON-RPC or WebSockets ('overkill, hinder progress'); TLS + OAuth 2.0 inherited from web; privacy of inter-agent data flows flagged as open problem
- Table 1 innovation matrix: A2A (AgentCard, async, static discovery, no state mgmt), ANP (identity+discovery), AITP (chat threads + state), LMOS (most complete but maximalist OS-like design); none interoperate with each other
- Proof of concept: retrofitted A2A, ACP, Agora codebases with all four blocks, ~200 LOC each; measured added latency 10.4ms (A2A) / 96.0ms (ACP) vs 3.3s mean LLM generation - protocol overhead negligible
- Messaging-platform fragmentation (iMessage/WhatsApp/Signal/Telegram) used as the cautionary tale for agent ecosystems; federation stance: minimal standards early, decentralized ecosystems

## A Comparative Study of MCP and A2A for Inter-Agent Coordination in LLM-Based Systems (Predoaia, Vu, Barmpis, Kolovos, Garcia-Dominguez; University of York)
- File: `york-mcp-study.pdf`
- Source: https://arxiv.org/pdf/2607.23884
- Read pages 1-6 plus extracted the R5 requirement and results text from pages 11-15 via pdftotext. arXiv 26 Jul 2026; implementation-grounded comparison of the SAME 4-agent domain-model-generation task built twice, once on MCP, once on A2A, evaluated against 7 requirements from literature and industry partners.
- R5 Agent observability definition: integrate with on-prem LLM observability platforms (Arize Phoenix, Langfuse) whose instrumentations emit OTel traces; 'to unify these traces across a collaboration involving a tree of tasks and sub-tasks... the protocol would need to support super-task IDs that relate agent traces to higher-level tasks.'
- R5 verdict (Table 2): PARTIALLY met for both MCP and A2A: 'Neither protocol provides native protocol-level tracing or explicit super-task IDs for observing an entire multi-agent collaboration'; both implementations had to bolt on observability via callbacks/third-party libraries (Langfuse configured externally in both).
- A2A implementation detail: task ID + context ID serve as persistent identifiers through the whole workflow; agents emit TaskStatusUpdateEvent (state + human-readable Message) and TaskArtifactUpdateEvent (multi-part artifacts with metadata): the closest existing thing to room-level progress events.
- Overall: MCP supports inter-agent coordination with lower complexity but conversational state and task lifecycle must be application-level; A2A natively supports multi-turn (input-required state) at substantially higher implementation complexity; MCP fails R3 multi-turn natively.
