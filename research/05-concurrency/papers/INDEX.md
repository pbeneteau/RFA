# Papers Library Index

Downloaded and read during the wave 05 (concurrency) deep-research pass of August 25, 2026.

Cross-checked against the directory on 2026-08-25: all 40 PDFs of the deep-research pass are indexed below, and every paper the deep readers reported exists on disk; nothing is missing in either direction. Five more papers (atomix, continuum, dpbench, m1-parallel, resume-means-resume) were downloaded and read later on 2026-08-25 for the addendum to note 06; their entries are merged into the alphabetical order below, bringing the library to 45 PDFs. Three papers (position-mas-concurrency-control, coagent-concurrency-control-multi-agent, governed-shared-memory-multi-agent) were deep-read independently by two dimensions; their sections merge both readings. Sections are ordered alphabetically by filename.

## A-Mem: Agentic Memory for LLM Agents (arXiv 2502.12110)
- File: `a-mem-agentic-memory.pdf`
- Source: https://arxiv.org/pdf/2502.12110
- Zettelkasten-style memory where each new note triggers link generation and memory evolution: updates to the contextual representations of EXISTING memories (p. 2).
- An add is therefore not an append; its write set includes neighbors, so concurrent adds have overlapping write sets.
- Single-writer by construction, representative of the 2025 memory-system generation with no concurrency story.

## AgenticFlict: A Large-Scale Dataset of Merge Conflicts in AI Coding Agent Pull Requests on GitHub (arXiv 2604.03551)
- File: `agenticflict-merge-conflicts.pdf`
- Source: https://arxiv.org/pdf/2604.03551
- Deterministic merge simulation of 107,026 real AI-agent PRs from 59,412 repos: 27.67 percent conflict.
- Conflicting PRs average 4.36 files, 11.36 regions, 540 conflict lines: conflicts are substantial, not isolated.
- Per-agent rates: Copilot 15.24, Cursor 19.75, Devin 22.85, Claude Code 25.93 (n=779), OpenAI Codex 31.85 percent.
- Churn-dependent: ~9.9 percent at 2-line median churn, ~30 percent at 25 lines, saturating 32-33 percent; textual conflicts only, logical conflicts uncounted.

## Concurrency without Model Changes: Future-based Asynchronous Function Calling for LLMs (AsyncFC, arXiv 2605.15077)
- File: `asyncfc-futures-function-calling.pdf`
- Source: https://arxiv.org/pdf/2605.15077
- Decode/execution overlap via futures and dependency-aware scheduling; no model changes, standard function-calling protocol preserved.
- Declared per-tool read/write annotations over a path-labeled state tree; conservative serialization by default.
- Measured 1.26x (BFCL v4 web search) to 1.44x (SWE-bench Lite with SWE-agent, scaled latencies), accuracy statistically unchanged.
- Characterizes AsyncLM as requiring interrupt tokens plus fine-tuning; bounds within-turn concurrency gains well under 2x.

## ATM: CID-Brokered Pre-Write Admission for Multi-Agent Code Co-Synthesis (arXiv 2607.00041)
- File: `atm-prewrite-admission.pdf`
- Source: https://arxiv.org/pdf/2607.00041
- Pre-write admission: structured write intents with declared scopes, broker admits/composes/serializes/fail-closes before mutation; neutral steward is the sole applier.
- Direction epochs invalidate stale task direction; three governance invariants (scope containment, direction stability, evidence-backed closure).
- Evidence is weak: single author, self-hosted 12-scenario evaluation plus one three-week adopter, no comparative baselines; adopt the shape only.
- Prior art shape for RFA rung 6 riding the existing claim fence.

## Atomix: Timely, Transactional Tool Use for Reliable Agentic Workflows (arXiv 2602.14849)
- File: `atomix-durable-agent-execution.pdf`
- Source: https://arxiv.org/pdf/2602.14849
- Transactional settlement at the tool boundary: adapters record read scopes and effects, transactions seal their footprint, commit fires only when per-resource frontiers certify no earlier conflicting work can arrive.
- Effect taxonomy (reversible, reversible-with-cost, bufferable, irreversible-gated); irreversible effects held at the adapter gate until commit: 0/500 leaked sends vs Saga-Compensation 400/500 and Checkpoint-Replay 200/500.
- tau-bench retail fp=0.30: Tx-Full 57 percent clean vs 0-7 percent for non-checkpoint baselines; Checkpoint-Replay statistically TIED on recovery alone (honest null); contention: 0 violations at 0 ms wait vs Workflow-Lock 112 ms and OCC's ~3000 rejections per 100 runs.
- Adapter metadata is safety-critical and asymmetric: only over-broad scopes fail closed; too-narrow scopes 66/200 violations, wrong effect class leaks 17/200; single-process prototype, 7.7 us/step, 17 LOC/adapter.

## Autellix: An Efficient Serving Engine for LLM Agents as General Programs (arXiv 2502.13965)
- File: `autellix-agent-serving.pdf`
- Source: https://arxiv.org/pdf/2502.13965
- FCFS at the LLM-call level causes head-of-line blocking for multi-call agent programs.
- Non-clairvoyant schedulers (PLAS/ATLAS) prioritize by attained service with discretized levels and anti-starvation promotion.
- 4-15x throughput at equal latency over vLLM-class FCFS; intra-program cache hits above 90 percent favor engine affinity.
- Transfers to RFA lease grant order: today a denied caller just retries with static lane reserves.

## LLM-based Multi-Agent Blackboard System for Information Discovery in Data Science (arXiv 2510.01285)
- File: `blackboard-multi-agent-data-science.pdf`
- Source: https://arxiv.org/pdf/2510.01285
- Main agent posts requests to a shared blackboard; subordinate agents self-select by capability; no controller-held capability model.
- Responses go to a separate response board to prevent cross-influence among helpers.
- 13-57 percent relative end-to-end improvement over best baselines on KramaBench and discovery-augmented DSBench/DA-Code; up to 9 percent relative F1 gain on discovery.
- The one genuinely new post-Linda coordination-medium result found; validates RFA's capability roster plus claimable task board.

## Blending Containers and Virtual Machines: A Study of Firecracker and gVisor (Anjali, Caraza-Harter, Swift, VEE 2020)
- File: `blending-containers-vee20.pdf`
- Source: https://dl.acm.org/doi/10.1145/3381052.3381315
- Code-coverage analysis: despite moving functionality out of the host kernel, both gVisor and Firecracker execute MORE host kernel code than native Linux; much of the extra code is conditional code within the same functions native Linux executes (p. 2).
- Neither gVisor nor Firecracker is best across workloads: Firecracker has high network latency, gVisor is slower for memory management and streaming (p. 2).
- Positions LXC/runc, gVisor, Firecracker, and KVM/QEMU on a spectrum of where OS functionality lives, host kernel vs guest (Figure 1, p. 2).
- Seccomp attack-surface numbers (Table 1, p. 4): allowed syscalls to the host kernel are LXC all except 44, Firecracker 36, gVisor 53 without host networking (68 with); the gVisor Sentry implements 237 syscalls itself and makes only 53 host syscalls (sect. 2.3, p. 3).

## Beyond Single-Use Tokens: Durable Authorization State for Replay-Resistant LLM Agent Actions (CapLease, arXiv 2608.01710)
- File: `caplease-durable-authorization.pdf`
- Source: https://arxiv.org/pdf/2608.01710
- Semantic replay measured: 39.8 percent of 10,152 uncertain-outcome trajectories produce semantically equivalent re-proposals (lost ack 58, timeout 46, ambiguous 31, delegation/restart 24 percent).
- Single-use tokens cannot help because retries legitimately obtain fresh tokens for the same authorization.
- Fix: canonical action identity, budget, atomic Issued-Prepared-Committed over a durable ledger, idempotency key honored by the sink; 0 counterexamples in 28,200 two-thread races; 0.92 ms average path.
- Direct hazard for RFA approval cards once runs go parallel; RFA lacks cross-card action identity and tool idempotency.

## The Chubby lock service for loosely-coupled distributed systems (Burrows, OSDI 2006)
- File: `chubby-lock-service-osdi06.pdf`
- Source: https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/
- Pre-downloaded by the scout; deep-read for the wave.
- Deliberately coarse-grained advisory locks; fine-grained locking is pushed into the client application via a lock server per lock group (sect. 2.1).
- Sequencers (sect. 2.4): opaque string of lock name, mode, lock generation number, passed by the holder to third-party servers which validate it; lock-delay (up to one minute) protects servers that cannot check sequencers.
- Sessions and KeepAlives: 12 s default lease extension, 45 s client grace period (jeopardy) across master fail-over; per-node monotonic instance/content/lock/ACL generation numbers.

## CoAgent: Concurrency Control for Multi-Agent Systems (Lyu et al., 2026, arXiv 2606.15376)
- File: `coagent-concurrency-control-multi-agent.pdf`
- Source: https://arxiv.org/pdf/2606.15376
- Deep-read independently by two dimensions; this section merges both readings.
- Head-to-head on ten contended workloads: uncoordinated passes 13 percent of trials; 2PL 0.81 deadlocks/trial at ~1.04x speed; OCC 0.95 aborts/trial at 0.93x speed (slower than serial) and 1.83x tokens; CoAgent within 5 percent of serial correctness at 1.4x speedup and 1.15x tokens (p. 2).
- Mechanism: declared per-tool read/write footprints, a pre-order on tool calls, conflict delivered as an in-context notification so the agent re-executes only stale-premised operations.
- Functionality gap: agents act on external logical state (kubectl apply) that OCC cannot buffer and 2PL cannot roll back; repair falls back to saga-style registered inverses (p. 2).
- Canary anomaly (fig. 1, pp. 3-4): disjoint write sets still yield a non-serializable outcome because the bug is in the reads; 'partitioning constrains writes; the bug is in the reads'.
- Critiques all three current strategies: sequential execution, static write partitioning (write sets unknowable in advance), and fork-and-merge (merges are hard, CRDTs narrow, live external state cannot be forked): a direct attack surface for ladder rung 5.
- Requires registered tools with three-phase call structure (prepare/execute/reverse) and a commit hook: real integration cost.
- Honest caveat: the LLM misjudged notification relevance in ~5 percent of trials.

## CodeMonkeys: Scaling Test-Time Compute for Software Engineering (Stanford Scaling Intelligence Lab)
- File: `codemonkeys-swe-test-time.pdf`
- Source: https://scalingintelligence.stanford.edu/pubs/codemonkeys.pdf
- 10 parallel (edit, test) state machines per SWE-bench Verified issue; serial and parallel compute combined.
- 69.8 percent coverage, 57.4 percent after selection (11.6 points lost to selection), ~2291 USD total.
- Context retrieval amortizes across candidates at under 15 percent of cost.
- Barrel of Monkeys ensemble: 80.8 percent coverage selected down to 66.2 percent.

## Collaborative Memory: Multi-User Memory Sharing in LLM Agents with Dynamic Access Control (arXiv 2505.18279)
- File: `collaborative-memory-access-control.pdf`
- Source: https://arxiv.org/abs/2505.18279
- Two-tier private/shared memory where every fragment carries immutable provenance (contributing agents, accessed resources, timestamps) supporting retrospective permission checks (p. 1).
- Time-varying bipartite access graphs (user-to-agent, agent-to-resource) formalize dynamic grant and revoke (pp. 2-3).
- Read policies project filtered views per requester; write policies decide fragment retention and tier placement (p. 3).
- Provenance-at-write is the enabler of later merge, audit and revocation; RFA facts have it, /memories files do not.

## Continuum: Efficient and Robust Multi-Turn LLM Agent Scheduling with KV Cache Time-to-Live (arXiv 2511.02230)
- File: `continuum-llm-serving.pdf`
- Source: https://arxiv.org/pdf/2511.02230
- vLLM-based serving: TTL-pinned KV cache across tool calls plus program-level FCFS; TTL set by a cost-benefit model over empirical tool-duration CDFs.
- Measured 1.12x-3.66x delay reduction and 1.10x-3.22x throughput vs vLLM and reimplemented Autellix; the abstract's "over 8x" is the best case on Tensormesh's internal testbed only.
- Workload characterization: SWE-agent traces mean 10.9 turns, tool time mean 925 ms, durations heavily long-tailed (slowest 10 percent of one tool = 94.1 percent of its delay).
- Inference-engine layer; RFA has no KV-cache lever. Refines the shape of the parked lease-grant-order recommendation, changes no verdict.

## Diversity Empowers Intelligence: Integrating Expertise of Software Engineering Agents (DEI, arXiv 2408.07060)
- File: `dei-diversity-swe-agents.pdf`
- Source: https://arxiv.org/pdf/2408.07060
- Committee over agents averaging 26.6 percent resolve: 54.3 percent oracle union, 34.3 percent committee-selected (25 percent relative over best member's 27.3).
- Documents intra-agent diversity: ten identical-parameter runs of one agent resolve materially different issue sets.
- Supports candidate parallelism with identical RFA packs, not just heterogeneous frameworks; committee recovers only about half the union.

## Decomposing Docker Container Startup Performance: A Three-Tier Measurement Study (arXiv 2602.15214, Feb 2026 preprint)
- File: `docker-startup-three-tier.pdf`
- Source: https://arxiv.org/html/2602.15214
- Warm-start latency: 554-568 ms on Azure Premium SSD across images 5-155 MB (2.5% variation: runtime overhead dominates, image size irrelevant); 1157-1334 ms on HDD; 1528-1859 ms on macOS Docker Desktop.
- Docker Desktop virtualization tax: 2.69x startup and 9.5x higher CPU-throttling variance vs native Linux.
- Namespace creation is ~8 ms (<1.5% of startup): the kernel isolation primitives are essentially free, the container runtime machinery is the cost.
- OverlayFS paradox: sequential writes collapse to 0.006-0.010x of volume-mount speed due to copy-up, but metadata ops are 1.3-4.8x FASTER than volume mounts.
- Caveat: single-author preprint, not peer-reviewed; note also the scout's 'runc 350ms vs gVisor 656ms' claim is NOT in this paper.

## DPBench: Structural Determinants of Multi-Agent LLM Coordination Under Simultaneous Resource Contention (arXiv 2602.13255)
- File: `dpbench-data-parallel-agents.pdf`
- Source: https://arxiv.org/pdf/2602.13255
- Dining Philosophers as a Dec-POMDP over five frontier LLMs plus a random baseline; N=5 simultaneous default prompt: deadlock 25 percent (GPT-5.2, CI overlaps random) to 90 percent (Gemini 2.5 Flash).
- Three structural interventions each drive 90 percent to ~0: three rounds of pre-commitment communication (a single round does NOT help, 86.7 vs 90), a one-paragraph resource-ordering or symmetry-breaking prompt, or N=10.
- Claim "the protocol determines the outcome, not the model" holds within the toy; no tools, no real effects, n=20-30 per cell.
- Empirical floor under rung 6: zero-shot negotiation fails at near-random rates; encode the ordering rule in the protocol (the board refusing intersecting claims IS resource ordering).

## Firecracker: Lightweight Virtualization for Serverless Applications (Agache et al., NSDI 2020)
- File: `firecracker-nsdi20.pdf`
- Source: https://www.usenix.org/system/files/nsdi20-paper-agache.pdf
- Firecracker keeps KVM but replaces QEMU with a minimal Rust VMM specialized for serverless; requires KVM, hence Linux hosts only.
- Measured: <5 MB memory overhead per microVM, boots to application code in <125 ms, up to 150 microVMs created per second per host (p. 420).
- Deliberately omits BIOS, PCI, VM migration; process-per-VM model, powering AWS Lambda and Fargate in production since 2018.
- Design goal framing: rejects the container-vs-VM tradeoff by making hypervisor isolation as cheap as containers.

## Governed Shared Memory for Multi-Agent LLM Systems (MemClaw, arXiv 2606.24535)
- File: `governed-shared-memory-multi-agent.pdf`
- Source: https://arxiv.org/pdf/2606.24535
- Deep-read independently by two dimensions; this section merges both readings.
- Formalizes fleet memory with four failure modes: unauthorized leakage, stale propagation, contradiction persistence, provenance collapse (pp. 1, 4-5).
- Temporal supersession as a first-class write operation; measured against the live multi-tenant MemClaw/ArgusFleet service.
- Live eval of the production memclaw.net service caught a sub-tenant scope gap on GET-by-id that design review missed, disclosed and remediated during the study (pp. 8-9).
- Pipeline-ordering finding: synchronous near-duplicate dedup rejected 206/400 contradictory writes before the asynchronous contradiction detector saw them, capping detection at 0.490; supersession correct 90/90 when both writes admitted (p. 11 sect 8.4).
- Provenance chains of depth 4 reconstructed with completeness, writer-identity accuracy and depth-fidelity all 1.00 at sub-second per-hop latency (pp. 9-10).
- Strong write mode makes enrichment synchronous: write-to-visible p50 0.83 s, i.e. one search round-trip (pp. 10-11).
- Attacks RFA ladder rung 1: a write lock serializes but prevents none of the four failure modes.

## Granularity of Locks and Degrees of Consistency in a Shared Data Base (Gray, Lorie, Putzolu, Traiger, 1976)
- File: `granularity-of-locks-gray-1976.pdf`
- Source: https://web.stanford.edu/class/cs245/readings/granularity-of-locks.pdf
- RE-DOWNLOADED 2026-08-25: the scout's file at this path was a third-party student slide deck, not the paper; replaced with the real text.
- Lockable-unit size trades concurrency against overhead; hierarchy with intention modes (IS/IX/SIX, compatibility table p. 368) lets coarse and fine locks coexist, conflicts detected at ancestors.
- Protocol: locks requested root to leaf, released leaf to root (p. 369).
- DAG generalization (p. 370): to lock a node one must lock ALL its parents; the rule RFA's shared knowledge clones trip over unless resource keys are canonical (one real resource, one key).

## The True Cost of Containing: A gVisor Case Study (Young et al., HotCloud 2019)
- File: `gvisor-true-cost-hotcloud19.pdf`
- Source: https://www.usenix.org/system/files/hotcloud19-paper-young.pdf
- Syscalls at least 2.2x slower than runc: gettimeofday native 0.22 us, runc 0.29 us, Sentry-on-KVM 0.63 us, via Gofer 45.5 us; ptrace mode 42-232x slower (Fig 3).
- Opening/closing a file on external tmpfs is 216x slower (518 us vs 2.04 us native, Fig 6); small-file reads 11x slower; large downloads 2.8x slower.
- Container create/destroy: runc 1.014 s vs gVisor+KVM 1.117 s; memory allocations 2.5x slower; Python imports 2-4x slower.
- Conclusion: syscall-heavy and small-I/O workloads (the agent-run profile) are gVisor's worst case.

## How to Not Copy Files (Zhan et al., USENIX ;login: Fall 2020)
- File: `how-to-not-copy-files-login20.pdf`
- Source: https://www.usenix.org/system/files/login/articles/login_fall20_03_zhan.pdf
- All production CoW clone implementations sit on a copy-granularity trade-off between write cost, space, and read locality; none achieves all four 'nimble' properties.
- Repeated clone-then-small-write cycles shred locality: XFS grep time nearly doubles after six clone rounds; btrfs read performance degrades ~20% (50% after 17 rounds).
- Container-clone cost table (Table 2, p. 15): Ubuntu LXC clone via rsync-on-ext4 19.514 s vs btrfs subvolume clone 0.396 s vs ZFS clone 0.478 s vs BetrFS 0.118 s.
- Space per clone round: btrfs 176 KiB, XFS 32.6 KiB, ZFS 250 KiB, BetrFS 16.3 KiB.

## Large Language Monkeys: Scaling Inference Compute with Repeated Sampling (arXiv 2407.21787)
- File: `large-language-monkeys.pdf`
- Source: https://arxiv.org/pdf/2407.21787
- Coverage scales close to log-linearly with samples across four orders of magnitude; SWE-bench Lite 15.9 percent at 1 sample to 56 percent at 250.
- Holds across model families and sizes (Llama, Gemma, Pythia, 70M-70B).
- Without automatic verifiers, majority voting and reward models plateau around 100 samples, forfeiting most coverage: selection is the bottleneck.

## Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache Consistency (Gray and Cheriton, SOSP 1989)
- File: `leases-gray-cheriton-sosp89.pdf`
- Source: https://web.eecs.umich.edu/~mosharaf/Readings/Leases.pdf
- Pre-downloaded by the scout; deep-read for the wave.
- Lease term trades extension overhead against false sharing and post-failure delay; analytic model with lease benefit factor alpha = 2R/SW (pp. 204-205).
- Most of the benefit arrives with a term of a few seconds: a 10 s term cut consistency traffic to 10% of a zero term (p. 205).
- A server recovering from a crash must honor leases granted before it crashed, most easily by waiting out the maximum term (p. 203): the exact rule behind RFA 10.3's pending restart grace.
- Footnote 1 (p. 203): new leases are refused while a write waits, the built-in write-starvation guard.

## Optimizing Sequential Multi-Step Tasks with Parallel LLM Agents (M1-Parallel, ICML 2025, arXiv 2507.08944)
- File: `m1-parallel-multi-agent.pdf`
- Source: https://arxiv.org/pdf/2507.08944
- N whole Magentic-One teams run the SAME task concurrently on GAIA (GPT-4o): early-stop gives 1.6-1.8x speedup at 3 teams, 1.8-2.2x at 5, completion maintained, cost 1.7-2.6x.
- Aggregation mode improves completion (+3/+5/+1 tasks at levels 1/2/3 of 53/86/26) at higher latency; LLM aggregation beats majority voting, both below best-of-k oracle: the selection gap persists off SWE.
- Diverse-planning prompts show NO gain over repeated high-temperature sampling (measured null); identical replicas suffice.
- Run-level candidate parallelism (note 06 recommendation 2) with a selector-free early-stop variant; level-3 counts are single-digit, latency results are the robust part.

## Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory (arXiv 2504.19413)
- File: `mem0-scalable-long-term-memory.pdf`
- Source: https://arxiv.org/abs/2504.19413
- Two-phase pipeline: extraction from the message pair plus conversation summary, then an update phase where an LLM tool call picks ADD/UPDATE/DELETE/NOOP per candidate fact (pp. 3-4).
- The update phase retrieves top-s similar memories BEFORE the LLM round-trip, so the reconciliation candidate set is a stale snapshot by verdict time, the paper-level version of the TOCTOU in issue #6531 (p. 4).
- Source of the reconciliation-event shape RFA's FactStore.apply implements verbatim.
- Single-writer assumption throughout; consistency is maintained only by the sequential pipeline.

## MemGPT: Towards LLMs as Operating Systems (arXiv 2310.08560)
- File: `memgpt-llms-as-operating-systems.pdf`
- Source: https://arxiv.org/abs/2310.08560
- The base memory-hierarchy model (main context: system instructions, working context, FIFO queue; external context: recall and archival storage) that Letta, Mem0 and RFA descend from (pp. 2-3).
- Single event loop by construction: the queue manager appends incoming messages and triggers LLM inference; each inference cycle takes main context concatenated into a single string (pp. 2-3).
- Events trigger inference one at a time; without a heartbeat request the processor yields until the next external event (p. 4 sect 2.4).
- Memory edits are entirely self-directed function calls (working_context.append/replace), i.e. the model is the memory writer, with no concurrency story anywhere in the design.

## Memory Poisoning Attack and Defense on Memory Based LLM-Agents (arXiv 2601.05504)
- File: `memory-poisoning-attack-defense.pdf`
- Source: https://arxiv.org/pdf/2601.05504
- Caveat: a COMPSCI 690F course research project report, not peer-reviewed; cite for direction only.
- Realistic conditions with pre-existing legitimate memories dramatically reduce MINJA-style attack effectiveness (dilution is a real defense) (p. 1).
- Sanitization needs careful trust-threshold calibration between overly conservative rejection and insufficient filtering, the exact dial MemoryGate exposes (p. 1).
- Surveys contagious jailbreaks spreading through shared memory structures across multi-agent systems (p. 2).

## MINJA: Memory Injection Attacks on LLM Agents via Query-Only Interaction (NeurIPS 2025)
- File: `minja-memory-injection-attack.pdf`
- Source: https://arxiv.org/abs/2503.03704
- 98.2% average injection success rate and 76.8% attack success rate across three agents and four victim-target pair types, via queries and output observations alone (p. 2).
- Mechanism: bridging steps link victim queries to malicious reasoning, an indication prompt induces the agent to generate them, progressive shortening removes the prompt so records look benign (pp. 1-2).
- Each stored record is individually plausible, which is precisely the blind spot of similarity-based gates like RFA's MemoryGate.
- Threat model needs no privileged memory access: any user of the agent is a potential memory writer.

## MIRIX: Multi-Agent Memory System for LLM-Based Agents (arXiv 2507.07957)
- File: `mirix-multi-agent-memory.pdf`
- Source: https://arxiv.org/pdf/2507.07957
- Six memory types (Core, Episodic, Semantic, Procedural, Resource, Knowledge Vault) each managed by a dedicated Memory Manager agent, with a Meta Memory Manager routing tasks (p. 2).
- Existence proof of multi-writer memory management made safe by ownership per memory type, not locking.
- 85.38% on LOCOMO, 35% over RAG baselines on their ScreenshotVQA benchmark with 99.9% storage reduction (p. 3).
- Shipped as a React-Electron personal assistant doing screenshot-batch memory updates roughly every 60 seconds (p. 3).

## On Optimistic Methods for Concurrency Control (Kung and Robinson, ACM TODS 1981)
- File: `occ-kung-robinson-1981.pdf`
- Source: https://www.eecs.harvard.edu/~htk/publication/1981-tods-kung-robinson.pdf
- Downloaded 2026-08-25 during the deep-read pass (was missing from the scout's set).
- Validation = three conditions over write-set/read-set intersection between transactions ordered by transaction numbers assigned at END of read phase (pp. 217-219).
- A transaction with an arbitrarily long read phase fails validation when old write sets are unavailable and is backed up to the beginning (p. 220): the structural case against OCC for minutes-long model turns.
- Starvation remedy: detect repeated validation failure, rerun holding the critical-section semaphore, equivalent to write-locking the entire database (p. 220); becomes the note's escalation policy for repeatedly refused claims.

## Omega: flexible, scalable schedulers for large compute clusters (Schwarzkopf et al., EuroSys 2013)
- File: `omega-flexible-scalable-schedulers-eurosys13.pdf`
- Source: https://research.google.com/pubs/archive/41684.pdf
- Pre-downloaded by the scout; deep-read for the wave.
- Shared-state scheduling: each scheduler works on a private copy of cell state and commits atomically; the sync-to-commit interval is the transaction; conflict fraction = average conflicts per successful transaction (pp. 355-357).
- Trace-driven result: at ~10 s per-job decision time the conflict fraction exceeds 1.0 (every job averages a retry) and busyness runs ~40% above the no-conflict case (p. 360); scales to 32 parallel batch schedulers (p. 358).
- Sect. 5.2: coarse-grained conflict detection raises conflict rate and busyness 2-3x; gang (all-or-nothing) commits roughly double conflicts; incremental transactions with fine-grained detection should be the default.
- Mesos comparison: pessimistic offers lock down nearly all resources during long decisions, starving other schedulers (sect. 4.2).

## The OpenHands Software Agent SDK: A Composable and Extensible Foundation for Production Agents (MLSys 2026)
- File: `openhands-agent-sdk.pdf`
- Source: https://arxiv.org/pdf/2511.03690
- V0's mandatory per-conversation Docker sandbox split each conversation across two processes with divergent states; V1's principle is 'sandboxing should be opt-in, not universal' (sect. 3.1, p. 4).
- Workspace abstraction: one factory resolving to LocalWorkspace (in-process no-op wrapper), DockerWorkspace, or APIRemoteWorkspace with agent code unchanged; isolation as configuration, not an architecture fork (sect. 4.10, pp. 10-12).
- ConversationState is the only mutable component, guarded by a FIFO lock; event-sourced log gives sub-ms persist and crash recovery under 20 ms at 358 events (sect. 4.2 p. 7, Table 3 p. 13).
- 15-day production A/B: V1 cut system-attributable failures 61%; eliminated V0 classes were inter-pod 401s at 43.0/1k and runtime pod readiness races at 18.8/1k (Table 2, p. 12).
- Sub-agent delegation is blocking parallel execution implemented as an ordinary tool; the parent loop stays serial (sect. 4.5, p. 9).

## OpenHands: An Open Platform for AI Software Developers as Generalist Agents (ICLR 2025)
- File: `openhands-platform.pdf`
- Source: https://arxiv.org/pdf/2407.16741
- Per task session, one securely isolated Docker sandbox executes all actions from the event stream, driven over a REST action/observation API served inside the container (sect. 2.2, p. 4).
- The agent is a serial step(state)->action loop over one chronological event stream of actions and observations (sect. 2.1, p. 3).
- Multi-agent interaction is sequential delegation via AgentDelegateAction, not parallel turns (sect. 2.4, p. 5).

## Orleans: Distributed Virtual Actors for Programmability and Scalability (Bernstein, Bykov, Geller, Kliot, Thelin, MSR-TR-2014-41)
- File: `orleans-virtual-actors.pdf`
- Source: https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/Orleans-MSR-TR-2014-41.pdf
- Defines turn-based concurrency (p. 4 sect 2.5): activations are single-threaded, execute one turn at a time; [Reentrant] permits interleaving of turns from different requests at await points but never parallelism.
- Single activation per identity is enforced by a one-hop DHT directory that rejects a second registration and returns the existing address (p. 5 sect 3.2); local caches hit over 90% in production.
- Eventual single activation (p. 7 sect 3.9): duplicate activations are tolerated during membership flux and reconciled later, a deliberate availability-over-consistency tradeoff; stronger consistency is delegated to external persistent storage.
- Stateless worker mode (p. 3 sect 2.1) allows multiple activations only where there is no state reconciliation between them, i.e. immutable or no state such as read-only caches - the prior-art rule for replicas-as-distinct-members.
- Production numbers (pp. 10-11): Halo 4 Presence sustained about 130,000 heartbeats/s on 25 servers scaling near-linearly to 125 servers at 95-97% CPU, median latency 6.5 ms at 19% CPU.

## Position: Multi-Agent Systems Should Prioritize Concurrency Control (ICML 2026, arXiv 2608.18092)
- File: `position-mas-concurrency-control.pdf`
- Source: https://arxiv.org/pdf/2608.18092
- Deep-read independently by two dimensions; this section merges both readings.
- Temporal asymmetry: LLM inference spans seconds to minutes while tool calls complete in milliseconds, dramatically widening the window for interleaving anomalies; minutes-long agent transactions mean pessimistic locks kill parallelism and optimistic aborts waste paid reasoning (pp. 2, 5).
- Concurrency-attributable failure rates: 67.1% of Silo-Bench failures; premature submission 37.2%; inter-agent misalignment 36.9% on MAST (Table 2).
- Maps MAS failures to classical anomalies (stale read, lost update, stale correction, action-message desync) and gives a three-layer design-space table (isolation level, control strategy, granularity, versioning; Table 3).
- Cites worktree isolation at 63.3 percent vs 55.5 percent unisolated multi-agent SWE resolve, with unisolated multi-agent below the 57.2 percent single agent.
- Argues neither pessimistic nor optimistic control dominates for MAS; the choice hinges on contention and the cost of blocking versus retry (sect. 3.2.1).
- Constructive claim: feed conflict signals back to the agent semantically instead of resolving below it.

## Resume Means Resume: A Machine-Checked Conformance Contract for Checkpoint, Interrupt, and Resume Semantics (arXiv 2608.03836)
- File: `resume-means-resume-agent-interruption.pdf`
- Source: https://arxiv.org/pdf/2608.03836
- Six-property resume contract (PC/EO/FD/CV/CO/RD plus fork intent), TLA+ model TLC-exhausted at 7.4x10^6 states, 196 TLAPS obligations; deterministic LLM-free harness over five frameworks at pinned releases.
- No two frameworks share a conformance profile; LangGraph 1.2.9 records a second resume value and never consults it (#6663), is exactly-once across interrupts but at-least-once across SIGKILL; CrewAI re-executes completed effect-bearing work against its written claim; pydantic-graph cannot resume after a mid-node crash.
- Cross-process consume-once: two processes resuming one parked interrupt fire the gated effect twice 10/10 (also live PostgreSQL and cross-host WAN); every racer within the window consumes, no ceiling below k=16; the window tracks the gated node's own execution duration (a model turn).
- Repair binds at the durable-state READ path: consumption claimed by one INSERT under a uniqueness constraint in the shared store before any node executes; a write-path gate was built and falsified (still 10/10 duplicates).
- Direct hazard for RFA approval cards under parallelism and supervisor restarts; single-author preprint, artifact private, probed planes are Python frameworks not the Claude Agent SDK, so the transfer is by shape.

## SagaLLM: Context Management, Validation, and Transaction Guarantees for Multi-Agent LLM Planning (VLDB 2025)
- File: `sagallm-transaction-guarantees.pdf`
- Source: https://arxiv.org/pdf/2503.11951
- Adapts the Saga pattern: relax atomicity and isolation, make consequential steps compensable, validate with agents independent of the planner.
- State tracked along application, operation, and dependency dimensions.
- Evaluation is narrow: four REALM benchmark planning problems under injected disruptions across four LLMs; adopt as a shape, not scale evidence.

## Sagas (Garcia-Molina and Salem, SIGMOD 1987)
- File: `sagas-garcia-molina-salem-1987.pdf`
- Source: https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf
- Pre-downloaded by the scout; deep-read for the wave.
- Long-lived transactions must not hold locks for their duration; a saga is a sequence of sub-transactions each with a compensation, guaranteeing T1..Tn or T1..Tj,Cj..C1 (p. 250).
- Compensations undo semantically, not by restoring prior state; other transactions may observe partial results (isolation is deliberately surrendered).
- Cites Gray 1981: deadlock frequency grows with the fourth power of transaction size (p. 249), the quantitative case against locking across long work.

## S-Bus: Automatic Read-Set Reconstruction for Multi-Agent LLM State Coordination (arXiv 2605.17076)
- File: `sbus-read-set-reconstruction.pdf`
- Source: https://arxiv.org/pdf/2605.17076
- Server-side DeliveryLog reconstructs each agent's read set from HTTP GET traffic and runs OCC at commit with zero in-agent code; formalized as Observable-Read Isolation.
- Own honest coverage numbers: only 26.1 percent of single-step references HTTP-observable (p_hidden 0.739); self-reports over-claim 32-49 percent; genuine causal coverage <= ~70 percent.
- 0 Type-I corruptions across 427,308 commits under contention on the dedicated-shard topology; but single-shard collaborative writing 100 percent contradicted under ORI-ON.
- HTTP/2 multiplexing breaks its core FIFO assumption; serious formal backing (TLC 20.7M states, TLAPS, Dafny).

## Serializable Snapshot Isolation in PostgreSQL (Ports and Grittner, VLDB 2012)
- File: `ssi-postgresql-ports-grittner.pdf`
- Source: https://www.eecs.umich.edu/courses/cse584/archive/fall2023/static_files/papers/snapshot-psql.pdf
- Downloaded 2026-08-25 during the deep-read pass.
- Write skew: two transactions reading overlapping state, writing disjoint targets, each correct alone, jointly violating an invariant (sect. 2.1.1); the anomaly a write-only resource claim cannot prevent.
- SSI detects rw-antidependency 'dangerous structures' at runtime with non-blocking SIREAD locks; detection-only, so no new blocking and no new deadlocks, at the cost of false positives (sect. 3.3).
- Includes the three-transaction read-only anomaly (sect. 2.1.2) showing even read-only participants can be necessary to a violation.

## StateFuse: Deterministic Conflict-Preserving Memory for Multi-Agent Systems (arXiv 2607.05844)
- File: `statefuse-conflict-preserving-memory.pdf`
- Source: https://arxiv.org/pdf/2607.05844
- Replica merge is plain OpSet set union over immutable operations; the novelty is the agent-facing contract, not a new join algebra (p. 6).
- Materialization emits explicit ConflictSet objects for functional predicates with multiple distinct active values; resolvers act only at projection time and cannot rewrite replicated state (pp. 2, 6).
- Dual correction handles: exact claim_id for local edits, deterministic semantic claim_ref that also suppresses later-arriving instances of a retracted claim (pp. 5-6).
- Measured claim is deliberately narrow: conflict preservation ties collapsed surfaces on accuracy; what it buys is contradiction surfacing, safer abstention, auditable correction (pp. 1-2).

## SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering (NeurIPS 2024)
- File: `swe-agent-aci.pdf`
- Source: https://arxiv.org/pdf/2405.15793
- One LM agent generates one thought plus one command per step (ReAct) in a single trajectory per SWE-bench task instance; no intra-task concurrency anywhere in the design (sect. 3, p. 3).
- Evaluation is per-instance with a $4 per-instance budget; parallelism exists only across benchmark instances (sect. 4, p. 5).
- Negative finding for the wave: the baseline the whole coding-agent lineage descends from assumed a single thread per task over one workspace.

## Verified Detection and Prevention of Concurrency Anomalies in Multi-Agent LLM Systems (arXiv 2606.17182)
- File: `verified-concurrency-anomalies-tla.pdf`
- Source: https://arxiv.org/pdf/2606.17182
- Formalizes four agent-specific anomalies in TLA+: stale-generation, phantom-tool, causal-cascade, tool-effect reordering.
- Checked against LangGraph reducer and AutoGen ETag internals; connects stale-generation to a silent lost update reported in ByteDance deer-flow.
- Bounds mitigation cost: SSI-style commit validation ~8 percent tokens, pessimistic locking 1.6-2.3x latency.
- Anomaly frequency is workload-shaped: stale-generation observed in 1, 35, and 100 percent of runs across three pilot workloads.

## Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arXiv 2501.13956)
- File: `zep-temporal-knowledge-graph.pdf`
- Source: https://arxiv.org/pdf/2501.13956
- Bi-temporal model: t'created/t'expired track transaction time, t_valid/t_invalid track event time, stored on edges (pp. 2-3).
- Contradiction handling closes rather than deletes: an invalidating edge sets the old edge's t_invalid to its own t_valid, prioritizing new information along the transactional timeline (p. 3 sect 2.2.3).
- Close-not-delete is what makes contradiction handling order-tolerant, the property a future two-replica facts merge needs; RFA's fact columns copy this schema exactly.
- Three-tier graph (episodes, semantic entities, communities) with episodes as the non-lossy source layer (p. 2).
