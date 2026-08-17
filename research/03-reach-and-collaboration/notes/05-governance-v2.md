# 05 — Autonomy governance v2: flow rules, drift auditing, behavioral monitoring, real-time budgets

Dimension: 05-governance-v2 (wave 03, the v0.5 agenda). Depth: SURVEY. Research date: **2026-08-17**.
Scope: the four mechanisms wave 02 explicitly deferred ("Deferred beyond v0.4: ... Invariant-style flow rules and AlignmentCheck-style goal-drift auditing (v0.5+ material)", [research/02-platform/REPORT.md](../../02-platform/REPORT.md) sect. 5), plus behavioral monitoring (the half of OWASP ASI10 RFA lacks) and real-time budget metering, plus a dated standards sweep.
Baseline read before searching: [STATUS.md](../../../STATUS.md) findings ledger, [spec/RFA-0.4-platform.md](../../../spec/RFA-0.4-platform.md) §7.2–7.4, [research/02-platform/notes/08-governance.md](../../02-platform/notes/08-governance.md).
Judged against: ONE operator, ONE laptop, personal work tool, ~a handful of runs/day, no framework dependencies, no CI, no SaaS contracts.

---

## Verdict

**Three of the four deferred mechanisms are ceremony for RFA; the fourth is already half-built and one config line from done.**

The single most important finding is a code fact, not a research fact: **RFA already enforces a mid-run dollar ceiling.** `src/resident.ts:406` passes `maxBudgetUsd: budgets.per_task_usd` into every `query()`, and the Claude Agent SDK enforces it between model requests, refusing further subagent spawns and ending the run with `error_max_budget_usd`. The v0.4 spec's "checked at task pickup and run completion (lagged enforcement)" (§7.4) is **stale for the per-task layer**. What is still lagged is the *per-day* ceiling (`src/resident.ts:347` checks it only before the run, so one run can overshoot the day by up to `per_task_usd`), and reading the code turned up a real accounting bug: `costUsd = msg.total_cost_usd ?? 0` is assigned only on the `subtype === "success"` branch (`src/resident.ts:418-422`), so **a budget-capped or turn-capped run is journaled at $0** even though it spent money — precisely the case Anthropic's docs warn about. Dimension 4 therefore collapses from "build real-time metering" to a ~20-line fix.

The other three are rejected, each for a different reason with a named trigger that would reverse it:

- **Flow/taint rules**: the flagship tooling did not commoditize, it got acquired and the runtime half went behind a SaaS. Invariant Labs → Snyk (24 June 2025); the `invariantlabs-ai/invariant` DSL repo's last commit is **12 January 2026**; `explorer.invariantlabs.ai/docs/guardrails/` now **301s to the GitHub repo**; and `mcp-scan` on PyPI is a **redirect stub** ("This package has been renamed to snyk-agent-scan"). The successor `snyk-agent-scan` 0.5.17 (2026-08-11, Apache-2.0) is a **static supply-chain scanner only** — grep its README for `proxy`, `guardrail`, or `runtime`: zero hits, and it is "closed to contributions". The runtime guardrailing proxy that carried the flow-rule DSL is gone from open source. More decisively: **no finding in RFA's ledger is a dataflow violation.** Every external write RFA can make (`mcp__linear__save_document`) already pauses unconditionally on a human approval card, so a taint rule guarding it adds a second lock to a door that is already bolted.
- **AlignmentCheck-style runtime drift auditing**: the honest number is not the detection rate, it is the **utility cost**. On AgentDojo, AlignmentCheck alone cut attack success from 17.63% → 2.89% but dropped task utility from **47.73% → 43.09%** — a 4.64-point, ~9.7% *relative* loss of successful legitimate tasks, plus "significantly higher latency due to its semantic reasoning overhead", plus a capable large model called after every agent action. At RFA's volume that is roughly one killed legitimate run in ten, on a tool whose current answer latency is already 11–25s. RFA has zero goal-drift findings; the pm-agent *correctly refused* an out-of-scope injected chat message live. REJECT as a gate tier; ADAPT the input shape (User Goal / Trace / Selected Action) into the existing tier-3 judged eval, where it is free and off the answer path.
- **Behavioral monitoring**: ASI10's controls are right and RFA genuinely lacks two of them — but the industry's answer (ML behavioral baselines, z-score/IQR, Isolation Forest, Random Cut Forest) needs volume RFA does not have. An n of 5–20 runs per window makes a distributional anomaly score noise. What *does* work at low volume is **deterministic invariant tripwires on quantities that should be zero or constant**, and unlike the rest of this dimension those name real ledger failures: the zombie-membership incident (five orphaned `-hitl` observers accumulated in one day, six dead memberships evicted by hand earlier), and the identity-theft bug (linear-scribe **resumed pm-agent's membership and served as it**). Both would have fired a one-line invariant check on day one. ADOPT ~6 watchdog invariants on the supervisor's existing 5-minute tick; REJECT anomaly detection.

Standards: nothing creates an implementation task. The IETF audit-trail draft is an **individual submission with no working group**, revision `-00` dated **2026-03-29**, **expiring 2026-09-29** — RFA's hash chain already matches its algorithm (RFC 8785 JCS + SHA-256, null genesis), so adopt its `action_type`/`trust_level` vocabulary as an *export view* if ever asked, never as the wire format. The EU AI Act's heavy high-risk obligations were **deferred by the Digital Omnibus (in force 27 July 2026) to 2 December 2027 / 2 August 2028**; Article 50 transparency did start 2 August 2026 but targets public-facing chatbots and synthetic media, not an internal drafting tool. NIST's COSAiS SP 800-53 agent control overlays are still unpublished (expected late 2026–2027). ISO/IEC 42001 does not address agentic AI. **Track with dates; build nothing.**

### Recommendations

| # | Recommendation | Verdict | Rationale (and the ledger failure it catches) | Effort |
|---|---|---|---|---|
| 1 | `maxBudgetUsd = min(per_task_usd, per_day_usd − spend.usd)`; branch on `error_max_budget_usd` / `error_max_turns` and map to the spec'd `overloaded` refusal with `spend=X budget=Y`; read `total_cost_usd` on **every** result subtype | **adopt** | Turns the day ceiling from lagged to hard, and fixes a live accounting bug (capped runs journaled at $0). Enforcement point matches what Anthropic's own hosted platform does. | spike (hours) |
| 2 | Set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=3` in the resident's SDK `env` (spread `process.env` — the TS SDK **replaces** the environment) | **adopt** | Defaults are 3 and **20**; 20 concurrent subagents on one laptop is a self-DoS. Opus 5 documented as delegating more readily than 4.8. Installed SDK 0.3.233 ≥ the 0.3.219 that enforces these. | spike (minutes) |
| 3 | Six deterministic **watchdog invariants** on the supervisor's existing 5-min tick → `#ops`, reusing the 30-min cooldown | **adopt** | Zombie memberships (5/day) and identity theft (scribe served as pm-agent) — both in the ledger, both a one-line check. ASI10's "per-agent telemetry and behavior baselines". | day |
| 4 | A `retire-agent` deprovisioning runbook entry (leave rooms, evict sidekick, revoke secret names, archive memory.db, prune runs) | **adopt** | ASI10's "defined deprovisioning process" — the one ASI10 control RFA has literally nothing for, and the zombie incident is what happens without it. | hours |
| 5 | Goal-adherence lint in tier-3 judged evals, using AlignmentCheck's input triple (user goal / trace / selected action) over `rfaLogToTrajectory` output | **adapt** | Captures the mechanism at zero latency cost and zero utility cost, inside machinery that already exists (`claudeJudge`, choices-constrained, 50/day cap). | day |
| 6 | `taskBudget: { total }` (SDK alpha) on scheduled jobs only (morning digest, consolidation) | **adapt** | Advisory countdown so a long unattended job wraps up gracefully instead of being cut off. Min 20,000 tokens; alpha, so guard it. | spike |
| 7 | One manual `uvx snyk-agent-scan` pass over `agents/`, `.claude/skills`, and the MCP config | **adapt** | Apache-2.0, one-shot, no account needed for scan mode; covers ASI04. **Never automate it: scanning an MCP config executes the commands in it**, and RFA's config launches the hub. | spike (1 hour) |
| 8 | IETF AAT export view (`action_type`, `outcome`, `trust_level` L0–L4 mapped from existing events) | **defer** | Expiring individual I-D, no WG. Build it the day a human asks for an auditor-shaped export, not before. | day, deferred |
| 9 | AlignmentCheck (or any LLM drift auditor) as a runtime gate tier | **reject** | ~9.7% relative utility loss on the published benchmark; per-action large-model call; needs `TOGETHER_API_KEY` in the reference implementation. Zero drift findings in the ledger. | — |
| 10 | Invariant/Snyk guardrails DSL, the Gateway/proxy deployment shape, MCP-scan runtime proxy | **reject** | Runtime half no longer exists in open source (see Evidence §1). RFA's hub + `canUseTool` already sit on both interception points. No dataflow finding in the ledger. | — |
| 11 | Cedar (`v4.12.0`, 2026-07-28) or OPA (`v1.19.1`, 2026-08-17) as an engine | **reject** | Reconfirms wave 02. Both healthily maintained, both a second runtime and a policy language for a three-field match problem already solved in `deploy/gate.json`. | — |
| 12 | Statistical/ML behavioral baselines and anomaly detection (z-score, IQR, Isolation Forest, Prophet) | **reject** | Needs fleet volume. At a handful of runs/day the score is noise and every alert is a false positive, which is the alert-fatigue failure mode for a single operator. | — |
| 13 | Nautilus Compass-style embedding persona-drift detector | **reject** | ROC AUC 0.83 is unactionable at n≈10/day, and it adds a BGE-m3 embedding dependency RFA deliberately avoided (FTS5-only memory retrieval). | — |
| 14 | Per-token / streaming real-time cost interrupts (`includePartialMessages` + `message_delta.usage`) | **reject** | Anthropic's own hosted platform enforces **between model requests** and documents the resulting one-request overshoot as acceptable. If the vendor doesn't need per-token metering, neither does one laptop. | — |
| 15 | EU AI Act / NIST / ISO compliance work items | **reject (track only)** | High-risk deferred to Dec 2027+; Art. 50 doesn't reach an internal drafting tool; NIST overlays unpublished. The live obligation (Art. 4 AI literacy, since 2 Feb 2025) is a Goodvest-policy question for a human, not code. | — |

### Ceremony audit — what each mechanism would have caught in RFA's own ledger

| Mechanism | Ledger failure it would have caught | Kept? |
|---|---|---|
| Flow/taint rules across a run | **none** | no (deferred with a trigger) |
| Runtime goal-drift auditing | **none** | no |
| ML behavioral baselines | **none** (needs volume it will never have) | no |
| Deterministic watchdog invariants | zombie `-hitl` observers (5 in one day); 6 dead memberships evicted by hand; identity theft via legacy-state fallback; heartbeat starvation SIGTERM 38s after a human approval | **yes** |
| Deprovisioning runbook | the zombie incident is the absence of one | **yes** |
| Hard per-run cost ceiling | none yet — but ~zero cost to add, and it fixes a live $0-journaling bug | **yes** |
| Subagent depth/concurrency caps | none yet — pre-failure, but the default is 20 concurrent on one laptop | **yes** |
| IETF AAT field names | none | no (deferred) |
| Static agent/skill/MCP scan | none | one manual pass |

---

## Evidence

### 1. Invariant/flow-style rules, policy engines, and the 2026 state of MCP guardrail tooling

#### 1.1 What a flow rule looks like, and what it expresses that a per-message rule cannot

Copied verbatim from the Invariant Guardrails README, https://raw.githubusercontent.com/invariantlabs-ai/invariant/main/README.md (repo https://github.com/invariantlabs-ai/invariant, Apache-2.0, 445 stars):

```
raise "error message" if:
    (variable: Type)
    condition expressions
```

```python
raise "External email to unknown address" if:
    (call: ToolCall) -> (call2: ToolCall)
    call is tool:get_inbox
    call2 is tool:send_email({
      to: ".*@[^ourcompany.com$].*"
    })
```

```python
from invariant.detectors import prompt_injection
raise "Injected tool output" if:
    (output: ToolOutput) -> (call2: ToolCall)
    prompt_injection(output.content, threshold=0.7)
```

Language features (verbatim): **flow operator** `->` "detects sequences between tool calls or messages"; **match types** `Message` (LLM messages, user/assistant), `ToolCall` (function invocations), `ToolOutput` (tool results); detector usage `prompt_injection(output.content, threshold=0.7)`. Programmatic API:

```python
from invariant.analyzer import LocalPolicy
policy = LocalPolicy.from_string("""rule code here""")
policy.analyze(messages)
# Returns: AnalysisResult(errors=[ErrorInformation(...)])
```

Package name `invariant-ai`. Trace format: "Standard OpenAI-compatible message format with `tool_calls` and `tool_call_id` fields" — the same shape `rfaLogToTrajectory()` already emits for evals (v0.4.4).

**The expressiveness delta, stated precisely.** A per-message rule (RFA's `rules` tier, whole envelope as context) can answer "does *this* payload match?". A flow rule answers "did A happen *before* B in the same trace?" — the two-hop taint question ("data read from source X must never reach tool Y"). That is genuinely something RFA's gate cannot express today. It is also something RFA has never needed: see §1.4.

#### 1.2 The 2026 state: acquired, and the runtime half is gone from open source

- **Snyk acquired Invariant Labs on 24 June 2025** — https://snyk.io/news/snyk-acquires-invariant-labs-to-accelerate-agentic-ai-security-innovation/ (fetched 2026-08-17). The press release "does not address what will happen to Invariant Labs' open-source projects (Guardrails, Gateway, Explorer, or MCP-Scan)" and contains no continued-open-source commitment.
- **`invariantlabs-ai/invariant`**: not archived, Apache-2.0, 445 stars, 10 open issues, **`pushed_at` = 2026-01-12** (GitHub API, fetched 2026-08-17). Seven months stale. STALE SOURCE FLAG: the DSL is a copyable shape, not a live dependency.
- **`invariantlabs-ai/explorer`**: not archived, Apache-2.0, 58 stars, **`pushed_at` = 2026-01-12**.
- **The hosted docs are gone**: `https://explorer.invariantlabs.ai/docs/guardrails/` returns **HTTP 301 → `https://github.com/invariantlabs-ai/explorer`** (verified 2026-08-17). The guardrails reference documentation that wave 02 cited no longer resolves to documentation.
- **`mcp-scan` on PyPI is a stub.** Version `0.4.3`, uploaded **2026-03-02**, summary verbatim: *"This package has been renamed to snyk-agent-scan. This is a redirect package that installs snyk-agent-scan and forwards the mcp-scan CLI to it."* (https://pypi.org/pypi/mcp-scan/json). `github.com/invariantlabs-ai/mcp-scan` returns 404 from the GitHub API.
- **The successor is a static scanner, not a guardrail.** `snyk-agent-scan` **0.5.17**, uploaded **2026-08-11**, license **Apache-2.0** (https://pypi.org/pypi/snyk-agent-scan/json). Verbatim from its README: *"Agent Scan is a security scanning tool to both scan and inspect the supply chain of agent components on your machine. It scans for common security vulnerabilities like prompt injections, tool poisoning, toxic flows, or vulnerabilities in agent skills. Agent Scan operates in two main modes which can be used jointly or separately: 1. **Scan Mode**: The CLI command `snyk-agent-scan` scans the current machine for agents and agent components such as skills and MCP servers... 2. **Background Mode** (MDM). Agent Scan scans the machine in regular intervals in the background, and reports the results to a [Snyk Evo] instance."* And: *"Agent Scan does not accept external contributions at this time."*
  Keyword counts over the full 18,931-character README (measured 2026-08-17): `proxy` **0**, `guardrail` **0**, `runtime` **0**, `pin` **0**. The runtime guardrailing proxy, tool pinning, and the DSL enforcement path that wave 02 recorded are **not present in the current open-source tool**. Runtime posture is now the Snyk Evo SaaS.
  Security warning worth copying verbatim because it is a footgun for RFA specifically: *"⚠️ IMPORTANT: Scanning MCP configurations will execute the commands defined in them. When Agent Scan scans an MCP configuration file, it starts the stdio MCP servers by executing the commands and arguments specified in the config."* RFA's project-local MCP registration points at the hub over HTTP, but any stdio entry would be launched.

**Read for RFA:** the "adopt the shapes, reject the platforms" verdict holds, and 2026 sharpened it — the platform in this dimension didn't just stay closed, the open half was hollowed out. Copy the DSL's *idea* (two-hop taint) if a trigger fires; take no dependency.

#### 1.3 Policy engines for comparison (both healthy, both still a reject)

- **Cedar**: latest release **v4.12.0**, published **2026-07-28** (GitHub releases API). Actively maintained. Wave 02's reasons stand: schema + entity modelling overhead, WASM binding, for a three-field match language.
- **OPA**: latest release **v1.19.1**, published **2026-08-17** (i.e., today). Actively maintained. Second runtime + Rego learning curve.

Neither has acquired an agent-specific feature that changes the calculus. The Cedar *evaluation algorithm* (any forbid ⇒ DENY; else any permit ⇒ ALLOW; else DENY) is already implemented in RFA's gate as most-severe-wins with default-allow at the message layer and default-deny at the tool layer (spec §7.2, shipped v0.4.2).

#### 1.4 Why RFA does not need this yet — and the exact trigger that would change it

RFA's egress surface today is one tool: `mcp__linear__save_document` (plus `search_project`). It is in `interrupt_on`, so **every** call falls through `allowedTools` to `canUseTool`, publishes an approval request, and blocks on a human-origin decision (`src/bridge.ts`; verified live four times, STATUS.md). A taint rule "content carrying the `injected` ext must not reach `mcp__linear__save_document`" is strictly weaker than "no call to `mcp__linear__save_document` proceeds without a human". Adding it is a second lock on a bolted door.

**Trigger to reverse (write this down):** the day any resident gets an external side-effecting tool that is *auto-approved* — a Slack post, an email send, an HTTP POST from inside `execute()`, a Linear write without `interrupt_on` — a two-hop taint check earns its place. The cheap implementation is not a DSL: RFA's engine already journals steps per run (`steps(run_id, step_id, seq, result_json)`, v0.4.1). Record a `taint` set on the run row from a `PostToolUse` hook (which sources this run has read), check it in the `PreToolUse` hook for egress tools, and reuse the gate's existing `{gate, check_id, reason, score?, elapsed_ms}` decision record. ~50 lines, no new vocabulary.

### 2. Goal-drift / alignment auditing: what it measures, and the honest cost

#### 2.1 AlignmentCheck — what it actually is

Anthropic-external primary source: **LlamaFirewall**, arXiv:2505.03574 (submitted 6 May 2025; PDF read in full at https://arxiv.org/pdf/2505.03574). Repo `meta-llama/PurpleLlama` is **actively maintained** — `pushed_at` = **2026-08-14**, 4,355 stars (GitHub API, 2026-08-17). The scanner ships as `LlamaFirewall/src/llamafirewall/scanners/experimental/alignmentcheck_scanner.py` — note the `experimental/` path.

Verbatim, §4.2: *"AlignmentCheck adds an experimental semantic-layer defense to LlamaFirewall by continuously comparing an agent's action sequence with the user's stated objective. Instead of inspecting individual messages, it reasons over the entire execution trace, flagging deviations that suggest covert prompt injection, misleading tool output, or other forms of goal hijacking."*

The implementable part — Appendix C.1.1, **AlignmentCheck Input Structure**, verbatim:

> - **User Goal:** The original objective provided by the user, serving as the reference for assessing agent behavior.
> - **Trace:** A sequence of prior agent reasoning steps, including tool invocations, intermediate thoughts, and user interactions, truncated to a fixed context window for efficiency.
> - **Selected Action:** The most recent action or decision by the agent, to be evaluated for alignment with the original user goal.
>
> Using these inputs, the guardrail LLM determines whether the selected action is consistent with the user's goal, leveraging the trace for context.

C.1.2: *"AlignmentCheck operates via a static prompt template constructed from the above inputs."* C.1.3 names why it works: *"Chain-of-Thought Monitoring: Evaluating the agent's reasoning, rather than just the final output, enhances detection accuracy. Agent LLMs often verbalize their intent (e.g., "I'm transferring money because the website instructed me to")."*

Config shape (docs, https://meta-llama.github.io/PurpleLlama/LlamaFirewall/docs/documentation/getting-started/how-to-use-llamafirewall) — scanners keyed by `Role`, uniform result record:

```python
from llamafirewall import LlamaFirewall, Role, ScannerType
llamafirewall = LlamaFirewall(scanners={
    Role.USER: [ScannerType.PROMPT_GUARD],
    Role.ASSISTANT: [ScannerType.AGENT_ALIGNMENT],
})
result = llamafirewall.scan(user_message)   # ScanResult(decision, reason, score)
result = firewall.scan_replay(conversation_trace)
```
`ScanResult.decision` ∈ `ScanDecision.ALLOW | ScanDecision.BLOCK`. Env requirement: `export TOGETHER_API_KEY=<your_api_key>` — the reference implementation calls a **third-party SaaS** for the guardrail model.

#### 2.2 The published numbers, both directions

Meta's in-house indirect-goal-hijacking benchmark (§4.2, C.2), verbatim: *"Without fine-tuning, these models achieved over 80% recall with a false positive rate below 4%"* and *"Llama 4 Maverick provides a favorable balance, detecting over 83% of goal hijacking attempts while maintaining a very low FPR of 2.5%."* Also: *"smaller models such as Llama 3.2 1B and 3.2 3B suffer from higher FPRs, resulting in reduced practical usability despite modest detection performance."*

AgentDojo (97 realistic tasks, offline replay of leaderboard traces across ten models under the `important_instructions` attack), verbatim table (§4.3.2):

| | No Guardrail (Baseline) | PromptGuard V2 86M | AlignmentCheck Llama 4 Maverick | Combined |
|---|---|---|---|---|
| ASR (lower is better) | .1763 | .0753 | **.0289** | .0175 |
| Utility (higher is better) | .4773 | .4701 | **.4309** | .4268 |

Verbatim: *"AlignmentCheck using Llama4 Maverick achieved a more aggressive reduction in ASR to 2.89% - an 84% drop relative to baseline, but at the cost of lower utility (43.1%) and **significantly higher latency due to its semantic reasoning overhead**."*

**Do the arithmetic the vendor framing skips.** Utility 0.4773 → 0.4309 is a 4.64-percentage-point drop, i.e. **9.7% of the runs that previously succeeded now fail**. That is the false-positive cost paid on legitimate work. For a fleet trading ASR 17.6%→2.9% that is a good trade. For one operator running ~10 real tasks a day with a human approval gate already in front of every external write, it means roughly **one killed legitimate run per day** to defend against an attack class the ledger has never recorded.

Stated limitations, verbatim (C.4):
> - **Vulnerability to Guardrail Injection:** AlignmentCheck itself can be targeted by prompt injections designed to manipulate both the agent and guardrail LLM. This risk is mitigated by: – Restricting inputs to only the agent's chain-of-thought and actions, excluding direct tool outputs. – Pre-scanning inputs to AlignmentCheck using PromptGuard for known injection patterns.
> - **Computational Cost:** Effective alignment checks require large, capable models. Smaller models lack the general reasoning ability needed for accurate semantic evaluation, leading to limited effectiveness in resource-constrained environments.

Recommended use, verbatim (C.3): *"Full alignment checks are recommended for high-security applications, such as autonomous agents that handle sensitive data or critical actions where strict controllability is essential."* RFA is not that. Meta's own efficiency roadmap is "Risk-triggered checks in high-stakes scenarios" and "Model distillation" — i.e., they agree per-action checking is too expensive.

For calibration, the cheap sibling: PromptGuard 2 86M gets **AUC .98 English, Recall @ 1% FPR 97.5%, 92.4ms per classification (A100 GPU, 512 tokens)**; the 22M variant AUC .995 / recall 88.7%. Both need a local HuggingFace model download and a GPU to hit those latencies. RFA's `prompt` gate tier (cheap-model screening, alert/hold only) is the same idea without the download.

#### 2.3 Published methods for detecting mid-run deviation, and whether they transfer

- **"Evaluating Goal Drift in Language Model Agents"**, arXiv:2505.02709 (submitted 5 May 2025; also AIES). Method verbatim from the abstract: *"agents are first explicitly given a goal through their system prompt, then exposed to competing objectives through environmental pressures."* Headline: *"the best-performing agent (a scaffolded version of Claude 3.5 Sonnet) maintains nearly perfect goal adherence for more than 100,000 tokens in our most difficult evaluation setting, [but] all evaluated models exhibit some degree of goal drift. We also find that goal drift correlates with models' increasing susceptibility to pattern-matching behaviors as the context length grows."*
  **Transfer to RFA:** drift is a *long-context* phenomenon. RFA residents serve short turns with per-conversation session resume, `maxTurns` default 10, and automatic compaction; the exposure is small. The genuinely exposed surfaces are the **scheduled jobs** (weekday morning digest) and **consolidation** — long, unattended, no human in the loop. That is where a goal-adherence check would matter, and it is exactly where an *eval* (§2.4) is the right instrument rather than a gate.
- **"Asymmetric Goal Drift in Coding Agents Under Value Conflict"**, ICLR 2026 Workshop; harness at https://github.com/jhammant/agent-drift. Reported finding: agents violate system prompts more when constraints oppose strongly-held values, and *"shallow compliance checks give false confidence, [while] multi-turn adversarial pressure reveals real vulnerabilities."* UNVERIFIED: I did not read the paper PDF; taken from the repo description and search summary. Relevance to RFA: this is a *red-teaming* method, not a runtime monitor — it belongs in the eval flywheel, not the gate.
- **Nautilus Compass**, arXiv:2605.09863 (submitted 11 May 2026). Black-box persona-drift detection: BGE-m3 embeddings, cosine similarity between user prompts and "behavioral anchor texts", weighted top-k mean; **no LLM calls at index time**. Numbers: **ROC AUC 0.83** on a held-out test set built from real Claude Code session traces labelled by an independent LLM judge; LongMemEval-S v0.8 56.6%; EverMemBench-Dynamic 44.4% (n=500). *"End-to-end reproduction cost is $3.50 (~14x cheaper than GPT-4o-judged stacks)."* MIT-licensed. **No false-positive rate reported** — which for a detector is the number that matters.
  **Transfer:** attractive (no LLM in the loop, cheap) but AUC 0.83 means the operating point is a threshold choice with a meaningful FPR nobody published, and at ~10 runs/day one alert a week that is wrong twice is worse than no alert. Also adds an embedding-model dependency RFA explicitly avoided (spec §5.1: "embeddings only if recall proves insufficient").
- **The folk method** worth recording because it is free: ask the agent to restate its original goal every N steps; if the restatement shifts, drift is active. UNVERIFIED as a measured technique (search summary, no paper). It is, however, effectively a zero-cost lint over RFA's existing episode log for scheduled jobs.

#### 2.4 The adapt: AlignmentCheck's shape inside the eval harness

RFA already has every part: `rfaLogToTrajectory()` maps a room NDJSON slice to OpenAI-style messages (v0.4.4); `claudeJudge()` runs `claude -p` haiku with `choices: [0, 0.25, 0.5, 0.75, 1]` and a 50/day cap; feedback lands as `source_type: model` in `obs.db`. The only new thing is a prompt built from AlignmentCheck's triple:

- **User Goal** = the asker's envelope body (or the schedule's `prompt` for scheduled runs).
- **Trace** = the trajectory's tool_calls up to the action under test.
- **Selected Action** = the next tool_call or the final answer.

Score it as a tier-3 lint alongside the existing protocol lints. Cost: it rides the existing 50/day judge budget. Latency in the answer path: **zero** — it runs weekly / after prompt-model-knowledge changes, per the v0.4.4 cadence. This is the honest version of "adopt goal-drift auditing": measure it, don't gate on it.

### 3. Behavioral monitoring — ASI10's second half

#### 3.1 What ASI10 asks for

**OWASP Top 10 for Agentic Applications 2026**, published **9 December 2025** by the OWASP GenAI Security Project (resource page: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ — the PDF is behind a download form; `?ddownload=52117` returns HTML, so the list and controls below come from a secondary mapping guide and are marked as such).

SECONDARY SOURCE (https://docs.modulos.ai/frameworks/owasp-top-10-agentic, fetched 2026-08-17) — the ten titles: **ASI01** Agent Goal Hijack · **ASI02** Tool Misuse · **ASI03** Identity & Privilege Abuse · **ASI04** Agentic Supply Chain Vulnerabilities · **ASI05** Unexpected Code Execution · **ASI06** Memory & Context Poisoning · **ASI07** Insecure Inter-Agent Communication · **ASI08** Cascading Failures · **ASI09** Human-Agent Trust Exploitation · **ASI10** Rogue Agents.

ASI10 definition and controls, verbatim from that guide:
> **Definition:** An agent operates outside policy through design failure, drift, or compromise, behaving as an internal threat within the system.
> **Recommended Controls:** Implement per-agent telemetry and behavior baselines · Deploy anomaly detection and alerts · Design kill switches any operator can activate · Establish a defined deprovisioning process · Focus on detection and containment within minutes rather than days

Adjacent controls worth recording (same source): ASI06 — *"provenance metadata on every memory write, tenancy separation, deliberate forgetting windows, and periodic evaluation against ground truth"*; ASI08 — *"rate limits at every agent boundary, circuit breakers on tool calls, blast-radius caps per agent, and observability surfacing fan-out patterns."*

#### 3.2 RFA's coverage against ASI10, honestly

| ASI10 control | RFA today | Gap |
|---|---|---|
| Per-agent telemetry | `data/obs.db` LangSmith-shaped runs with `dotted_order`, cost, tokens, latency, `needs_review`, universal feedback record; hub OTel spans bridged via traceparent (v0.4.3) | telemetry: **covered**. baselines: **absent** |
| Behavior baselines | none | see §3.3 |
| Anomaly detection + alerts | three threshold alerts on a 5-min supervisor tick with 30-min cooldowns into `#ops` (`r_fb3993fc90`): error pct >20 over ≥5 runs, avg latency >30s, avg feedback <0.5 over ≥3 | correct *shape*, but all three are output-quality alerts; **none watches the agent's behavior** |
| Kill switch any operator can activate | `room_admin` evict/quarantine (human-origin only), supervisor stop/restart from the console Lifecycle tab, `data/supervisor-commands.ndjson` | **covered** |
| Defined deprovisioning process | none | **absent** — and the zombie-membership incident is what its absence looks like |
| Detect+contain in minutes | presence lease + heartbeat supervision (verified across laptop sleep); 1ms `room_watch` push | **covered** for liveness, not for policy |

ASI06 is largely covered by MemoryGate + bi-temporal facts + `source_origin` trust tiers + episode provenance (memory v2). ASI08's rate limits exist (`member_rpm`, `max_pending_requests`); circuit breakers on tool calls and fan-out observability do not — recommendation #2 (subagent concurrency cap) is the cheap slice of that.

#### 3.3 Why baselines fail here, and what replaces them

The industry answer is distributional. SECONDARY (vendor/practitioner sources, low evidential weight, listed for completeness): the three algorithm families are statistical baselines (z-score, IQR), time-series ML (Prophet, ARIMA), and tree-based models (Isolation Forest, Random Cut Forest), with the signals being *"tool call frequencies, retrieval volumes, token consumption, and evaluation score distributions"* — e.g. https://openobserve.ai/blog/ai-anomaly-detection-guide/, https://www.microsoft.com/en-us/security/blog/2026/03/18/observability-ai-systems-strengthening-visibility-proactive-risk-detection/. Every one of these needs a population. RFA's population is ~10 runs/day from two agents. A z-score over n=5 is a coin flip; an Isolation Forest over 300 points a month will "find" the two days Paul asked unusual questions.

**The low-volume substitute: invariant tripwires.** Watch quantities whose correct value is *zero* or *constant*, not quantities whose correct value is a distribution. These fire deterministically, never on a slow day, and they are the checks that would have caught real ledger failures. Proposed set (evaluate on the supervisor's existing 5-min tick, emit as `#ops` messages through the existing alert path with its 30-min cooldown):

| Invariant | Correct value | Ledger failure it catches |
|---|---|---|
| `count(members where present AND lease_expired AND role=observer)` | 0 | **Zombie memberships**: "every scribe restart orphaned its `-hitl` observer sidekick; five corpses accumulated in a day" — and six dead memberships evicted by hand the evening before. A day-one tripwire. |
| `count(distinct pack_digest served under one member_id)` in a window, and `member.name != pack.name` for any resident-owned membership | 1 / never | **Identity theft via legacy state fallback**: "the legacy-state fallback let the scribe RESUME PM-AGENT'S MEMBERSHIP and serve as it". The single worst bug in the ledger, and a name-vs-membership assertion catches it. |
| `count(supervisor restarts of agent A within 120s of a human approval decision on A)` | 0 | **Heartbeat starvation**: "the supervisor SIGTERMed the scribe 38s after the human approved" — and the earlier lease starvation that produced `gone_quiet` mid-approval. |
| `count(gate decisions with outcome=refuse OR hold)` per day | small and *known* | Not a past failure, but the gate's own firing rate is the one number where a change of state (0 → 3 refusals today) is meaningful at n=10. Report the count, don't threshold a distribution. |
| `count(approval cards expiring unanswered)` per day | 0 while Paul is at the keyboard | Cards outliving their audience (the `reply_by`-minus-30s fix); a nonzero count means the fix regressed or the operator is drowning. |
| `count(runs where subtype != success)` broken out **by subtype** | `error_max_budget_usd` and `error_max_turns` should be rare and named | Today these are conflated into a generic `brain error` (see §4.4) and vanish into the error-percentage alert. Splitting them out is how a budget cap becomes visible instead of looking like a crash. |

#### 3.4 Alert fatigue for exactly one operator

RFA's existing design already has the two mechanisms that matter — minimum sample counts before firing, and per-alert cooldowns — so the remaining discipline is editorial, not technical. Three rules, recorded so a future session doesn't re-derive them:

1. **Every alert names its subject and its remedy.** An `#ops` message must carry the `run_id` / `member_id` / agent name *and* the exact command to act on it (`room_admin evict m_…`, `npx tsx dogfood/parity.ts`). An alert that requires investigation to interpret will be ignored by the third occurrence.
2. **An alert that fires twice without the operator acting is deleted or re-thresholded.** Make this a line item in the weekly eval pass (the v0.4.4 tier-3 cadence already exists as the natural checkpoint). A single operator has no on-call rotation to absorb noise; the only sustainable steady state is that every `#ops` message is worth reading.
3. **Never add a second alert for a condition an existing alert already implies.** Correlate, don't stack — the three-alert triad plus six invariants is the ceiling for a two-agent deployment. If a seventh invariant is proposed, one of the existing ones has to go or be shown to be independent.

#### 3.5 The deprovisioning gap (ASI10's cheapest missing control)

Nothing in RFA retires an agent. Proposed runbook entry for STATUS.md, derived from the failures the absence produced:

```
retire-agent <name>:
  1. supervisor: stop <name>            # data/supervisor-commands.ndjson
  2. resident shutdown leaves its rooms AND its <name>-hitl sidekick (2s cap)
  3. room_admin evict any remaining membership for <name> (human-origin) — audited
  4. remove <name> from data/secrets.json declarations (names only; values stay put)
  5. archive agents/<name>/state/memory.db to ~/Backups/rfa-agent-com/retired/<name>/<date>/
  6. leave the runs/feedback rows in obs.db (retention sweeper keeps feedback-bearing rows)
  7. git rm agents/<name>/agent.md  -> supervisor reconciles, digest disappears from every roster
```
Steps 2 and 3 are already implemented; the value is writing down that steps 4–7 exist, because the zombie incident was five agents that got step 1 and nothing else.

### 4. Real-time budget metering — RFA is already there and doesn't know it

#### 4.1 The Claude Agent SDK exposes a hard mid-run dollar ceiling

Verbatim from the TypeScript reference, https://code.claude.com/docs/en/agent-sdk/typescript:

```typescript
maxBudgetUsd?: number
```
> Stop the query when the client-side cost estimate reaches this USD value. Compared against the same estimate as `total_cost_usd`.

```typescript
maxTurns?: number      // Maximum agentic turns (tool-use round trips)
taskBudget?: { total: number }   // *Alpha.* API-side task budget in tokens. When set, the model is
                                 // told its remaining token budget so it can pace tool use and wrap
                                 // up before the limit.
interrupt(): Promise<SDKControlInterruptResponse | undefined>   // streaming input mode only
setModel(model?: string): Promise<void>
getContextUsage(): Promise<SDKControlGetContextUsageResponse>
```

Enforcement, verbatim from https://code.claude.com/docs/en/agent-sdk/subagents (§"Cap subagent depth, concurrency, and spend"):

| Limit | Set it with | Default | What Claude Code does at the limit |
|---|---|---|---|
| Depth | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | `3` layers of subagents below your main agent. `1` stops your subagents from spawning any of their own | Leaves a subagent at the bottom layer unable to spawn, so it does its delegated work itself |
| Concurrency | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | `20` subagents running at once | Refuses to spawn another subagent, returning `Concurrent subagent limit reached`, until the running count drops below the limit |
| Spend | `maxBudgetUsd` in TypeScript, `max_budget_usd` in Python | No limit. Compared against `total_cost_usd`, so subagent requests count | *"Enforces the cap in three ways: refuses to spawn more subagents, returning `Budget limit reached`, stops background subagents that are still running, and ends the query with the `error_max_budget_usd` result subtype."* |

Version floors, verbatim: *"This section describes TypeScript SDK v0.3.219 and Python SDK v0.2.127 and later, the releases that bundle Claude Code v2.1.219 or later."* and *"The cap-enforcement behaviors require Claude Code v2.1.217 or later."* — **RFA has `@anthropic-ai/claude-agent-sdk` 0.3.233 installed** (`node_modules/@anthropic-ai/claude-agent-sdk/package.json`), above both floors.

Env-option trap, verbatim: *"the TypeScript SDK replaces the subprocess environment with it, so spread `process.env` into it to keep variables like `PATH`, while the Python SDK merges it into the inherited environment."*

Result subtypes, verbatim from https://code.claude.com/docs/en/agent-sdk/agent-loop: `success` · `error_max_turns` · `error_max_budget_usd` · `error_during_execution` · `error_max_structured_output_retries`. And: *"All result subtypes carry `total_cost_usd`, `usage`, `num_turns`, and `session_id` so you can track cost and resume even after errors."*

#### 4.2 Accuracy caveats that must be recorded

Verbatim warning from https://code.claude.com/docs/en/agent-sdk/cost-tracking:
> The `total_cost_usd` and `costUSD` fields are **client-side estimates, not authoritative billing data**. The SDK computes them locally from a price table bundled at build time, so they can drift from what you are actually billed when: pricing changes · the installed SDK version does not recognize a model · billing rules apply that the client cannot model. Use these fields for development insight and approximate budgeting. For authoritative billing, use the Usage and Cost API or the Usage page in the Claude Console. **Do not bill end users or trigger financial decisions from these fields.**

Also verbatim, and directly relevant to RFA's obs.db accounting:
- Subagent scoping: *"`usage` — Excluded. Counts only the top-level agent loop, so tokens consumed inside subagents are not added"* · *"`total_cost_usd` — Included"* · *"`modelUsage` / `model_usage` — Included ... broken down by model"*. Guidance: *"Where you have the choice, account from `total_cost_usd` or `modelUsage` rather than `usage`."*
- The budget-cap edge: *"**`error_max_budget_usd`**: `usage` leaves out the response that crossed the budget, while `total_cost_usd` and `modelUsage` include it."*
- Per-step output tokens are a lie: *"Claude Code builds each assistant message from the usage the API reported when the response began, so the message's `output_tokens` is only the count the API had reported at `message_start`... Read output tokens from the result's `usage`."*
- Session-crash zeroing: *"When the Claude Code process crashes, it emits a final `error_during_execution` result and exits... That result may carry zeroed `usage`, `total_cost_usd`, and `modelUsage`."*
- The `/clear` reset: *"`maxBudgetUsd`, or `max_budget_usd` in Python, is compared against the same running total, so a `/clear` also starts the budget over."* Not a risk for RFA today (residents never send `/clear`), but it is the failure mode if the console playground ever forwards slash commands into a resident's session.
- Live token growth if ever needed: *"To watch a response's output count grow while it streams, set `includePartialMessages` ... and read `usage` from each `message_delta` stream event."*

#### 4.3 How other runtimes meter mid-run — and the authoritative answer on per-token enforcement

**Anthropic's own hosted platform (Managed Agents) is the strongest evidence, because it is the same vendor solving the same problem with unlimited engineering budget — and it does *not* do per-token enforcement.** Verbatim from https://platform.claude.com/docs/en/managed-agents/sessions ("Set a session budget"):

> To cap what a session can spend, pass the optional `budget` object when you create it. A budget is a hard ceiling on the session's list cost: the platform prices everything the session consumes at public list rates, and the session stops issuing new model requests once that running total reaches `max_list_cost`. Set `type` to `limit` and give `max_list_cost` an `amount` and a `currency`. `amount` is a whole number of US cents written as a string, such as `"2500"` for $25.00; the API takes a string rather than a number so no floating-point rounding is ever applied. `USD` is the only currency currently supported. When the session reaches the cap, it pauses and goes idle with the stop reason `budget_reached`. **The cap is enforced between model requests, so the request that crosses it finishes first and the session's final list cost can land a fraction past the cap.** A budget can only be attached at creation: you can change or remove it later, but you can't add one to a session created without it.

```json
{
  "agent": "$AGENT_ID",
  "environment_id": "$ENVIRONMENT_ID",
  "budget": {
    "type": "limit",
    "max_list_cost": {"amount": "2500", "currency": "USD"}
  }
}
```

Supporting detail (from the Managed Agents core/events docs): list cost = model tokens at each served model's list price + web searches at $10 per 1,000 + session running time at $0.08/hour; *"the request that crosses the cap completes, so the final figure can exceed the cap by at most one model request per running thread. Treat the budget as a bound on new work, not an exact stop."*; at the cap the session accepts only **settle events** (`user.tool_confirmation`, `user.tool_result`, `user.custom_tool_result`, `user.interrupt`) and a `user.message` is a 400; a `session.usage` event carrying the final `list_cost` immediately precedes the `session.status_idle` with `stop_reason: budget_reached`; and explicitly — *"To enforce a spend limit, set a budget rather than polling usage and interrupting the session yourself — the platform's gate runs before each model request."*

Two design shapes worth stealing verbatim into RFA:
1. **Pre-request gate with bounded overshoot** is the industry-correct enforcement point. RFA's `maxBudgetUsd` already inherits it. Per-token interrupts are a solution to a problem the vendor does not have.
2. **The "settle events only" pause semantics.** A budget-exhausted RFA run should not be an error — it should be able to *finish resolving a pending human approval* and then stop. RFA's approval bridge blocks inside `canUseTool`; a budget stop mid-approval is exactly the lease-starvation shape that already bit once. Worth a spike (§S3).

The **task budget** is the advisory counterpart, distinct from the hard cap. From the Claude API surface (`output_config.task_budget`, beta `task-budgets-2026-03-13`, minimum `total` 20,000 tokens): *"a token ceiling for an agentic loop so Claude paces itself and finishes gracefully instead of being cut off — distinct from `max_tokens`, which is an enforced per-response ceiling the model is not aware of... The server injects a countdown marker Claude sees during generation."* The Agent SDK surfaces it as `taskBudget?: { total: number }`, marked **Alpha**.

LiteLLM (wave 02's reference implementation) remains the counter-example that per-principal accounting can be fully lagged: budgets reset on a scheduler sweep every ~10 minutes and an exceeded budget surfaces as an auth-level error `"ExceededBudget: ... Spend=X, Budget=Y"`. RFA already copied its error-string shape into the spec's `overloaded` refusal detail.

#### 4.4 The concrete gap in RFA's code (read 2026-08-17)

`src/resident.ts:405-406`:
```typescript
      maxTurns: budgets.max_turns ?? 10,
      ...(budgets.per_task_usd ? { maxBudgetUsd: budgets.per_task_usd } : {}),
```
→ the **per-task** ceiling is already a hard mid-run stop. Spec §7.4's "lagged enforcement" is stale here; correct the spec.

`src/resident.ts:347-348`:
```typescript
  if (budgets.per_day_usd && spend.usd >= budgets.per_day_usd) {
    throw new Error(`daily budget exhausted (spend=${spend.usd.toFixed(2)} budget=${budgets.per_day_usd})`);
```
→ the **per-day** ceiling is checked once, before the run. A run starting at $4.90 of a $5.00 day with `per_task_usd: 0.50` can end the day at $5.40. Fix: `maxBudgetUsd: Math.min(per_task_usd ?? Infinity, (per_day_usd ?? Infinity) - spend.usd)` (guard the non-positive case by refusing at pickup, which is what line 347 already does).

`src/resident.ts:418-422`:
```typescript
      if (msg.subtype !== "success" || msg.is_error) {
        throw new Error(`brain error: ${msg.subtype}${…}`);
      }
      text = msg.result.trim();
      costUsd = msg.total_cost_usd ?? 0;
```
→ two bugs in five lines. (a) `error_max_budget_usd` and `error_max_turns` are **normal governance outcomes**, not brain errors; they should become the spec'd `refusal: {reason: "overloaded", detail: "budget_exceeded: spend=X budget=Y", retry_after_s}` (spec §7.4) so the console and the eval harness can tell a cost stop from a crash. (b) `costUsd` is assigned only after the success guard, so **a capped run is journaled at $0** — the day's spend ledger under-counts exactly the runs that hit the ceiling, which is the worst possible direction for the error. Anthropic's docs say this explicitly: *"All result subtypes carry `total_cost_usd`."* Read cost and `modelUsage` **before** the subtype branch.

No `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` / `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` anywhere in the tree → defaults 3 and 20 are live. Twenty concurrent Claude subprocesses on one MacBook is a self-inflicted outage, and the Anthropic docs specifically warn that *"Claude Opus 5 delegates to subagents more readily than earlier models, so the depth, concurrency, and spend limits matter most on queries that run Opus 5."*

### 5. Standards and compliance drift — dated, and mostly not RFA's problem

#### 5.1 IETF agent audit trail

**`draft-sharif-agent-audit-trail-00`** — https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/. Revision **00**, dated **29 March 2026**, **expires 29 September 2026**, status **Active Internet-Draft, individual submission — not part of any IETF working group**. No newer revisions. Abstract verbatim:

> This specification defines a standardized JSON-based logging format for autonomous AI agent systems. The Agent Audit Trail establishes mandatory fields for agent identification, action classification, outcome tracking, and trust level documentation. Records employ SHA-256 hash chaining for tamper-evidence and optional ECDSA signatures for non-repudiation. The format addresses EU AI Act (Regulation 2024/1689) requirements effective August 2026, alongside compliance with SOC 2, ISO/IEC 42001, and PCI DSS v4.0.1 standards. The design supports multiple export formats including JSONL, Syslog (RFC 5424), and CSV while maintaining chain integrity and incorporates privacy mechanisms including input/output hashing and GDPR Article 17-compatible deletion via tombstone records.

Mandatory fields (from https://www.ietf.org/archive/id/draft-sharif-agent-audit-trail-00.txt):

| Field | Type | Notes |
|---|---|---|
| `record_id` | String (UUIDv4) | uniquely identifies each record |
| `timestamp` | String (RFC 3339) | UTC, millisecond precision recommended |
| `agent_id` | String (URI) | persistent agent identifier |
| `agent_version` | String (semver) | software version for correlation |
| `session_id` | String (UUIDv4) | shared across all records in a session |
| `action_type` | String (enum) | `tool_call` · `tool_response` · `decision` · `delegation` · `escalation` · `error` · `lifecycle` |
| `action_detail` | Object | structure varies by `action_type` |
| `outcome` | String (enum) | result classification |
| `trust_level` | String `L0`–`L4` | L0 no verification · L1 self-signed identity · L2 authority-signed identity · L3 mutual authentication · L4 full mutual authentication with revocation checking |
| `parent_record_id` | String or null | links to previous record; null for genesis |
| `prev_hash` | String (hex) or null | SHA-256 of prior record; null for genesis |

Hash-chaining algorithm, verbatim in substance: take the complete prior record JSON object → serialize using **JCS per RFC 8785** → SHA-256 of the canonical bytes → lowercase hex (64 chars) → store in the current record's `prev_hash`. Genesis: `parent_record_id: null` and `prev_hash: null`.

EU AI Act mapping claimed by the draft: Article 12 requires *"automatic recording of events ('logs') over the lifetime of the system"* effective *"2 August 2026"*; AAT addresses Art. 12(1) via the mandatory record format, session structure documenting the "period of each use", and hash chaining; Art. 13 transparency maps to the `action_type` taxonomy and decision records; retention *"12 months for high-risk systems"*.

**RFA delta.** RFA already hash-chains every event with `prev_hash` = SHA-256 over the JCS canonical form of the previous event, genesis = room handle, and ships `src/jcs.ts` (protocol 0.1.7). The **algorithm matches**. What differs is naming and two vocabularies (`action_type`, `trust_level`). RFA's events already carry richer provenance than the draft asks for (origin stamping, signed capability cards + digests, human-principal identity, gate decision records with a config hash). **Verdict: do not restructure the wire format for an expiring individual draft with no working group.** If an export is ever needed, write a ~100-line projection: `room_send` → `tool_call`/`decision`, `room_task` claim → `delegation`, `room_admin` approve → `escalation`, evictions/joins → `lifecycle`; `trust_level` = L0 for anonymous, L1 for a signed capability card, L2 for a provisioned `human_key` principal. Re-check the draft **after 29 September 2026** — if it expires without a revision or a WG adoption, drop it from the tracking list.

#### 5.2 EU AI Act — dates as of 2026-08-17, and what actually applies

- **2 February 2025**: prohibitions and the **Article 4 AI-literacy obligation for providers *and deployers*** became applicable.
- **2 August 2025**: GPAI model-provider obligations.
- **2 August 2026**: **transparency obligations (Article 50) for providers and deployers became enforceable**; the full penalty regime and GPAI enforcement powers began; deadline for member states to designate market-surveillance authorities (*"noted as 'not on track'"*).
- **Digital Omnibus on AI**: proposed 19 November 2025; *"published in the EU's statute book"* **24 July 2026**, in force **27 July 2026**; **defers standalone high-risk (Annex III) to 2 December 2027 and product-embedded high-risk (Annex I) to 2 August 2028**.
Sources: https://www.dataprotectionreport.com/2026/07/the-eu-ai-act-when-does-it-become-enforceable-now/ (law-firm analysis — semi-primary) and https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2026/The-Digital-AI-Omnibus-Proposed-deferral-of-high-risk-AI-obligations-under-the-AI-Act.

Scope carve-outs, verbatim from the Article 2 text (https://artificialintelligenceact.eu/article/2/):
- **Art. 2(8)**: *"This Regulation does not apply to any research, testing or development activity regarding AI systems or AI models prior to their being placed on the market or put into service."* — with the crucial rider *"Testing in real world conditions shall not be covered by that exclusion."*
- **Art. 2(10)**: *"This Regulation does not apply to obligations of deployers who are natural persons using AI systems in the course of a purely personal non-professional activity."*
- **Art. 2(6)**: excludes systems *"specifically developed and put into service for the sole purpose of scientific research and development."*

**Plain reading for RFA (not legal advice; the compliance owner is the human to ask).**
- Art. 2(10) does **not** cover RFA: it is used for Goodvest work, i.e. professional activity.
- Art. 2(8) covers it only while it is pre-market development — and RFA is explicitly dogfooded on real work, which reads as "testing in real world conditions". So don't lean on 2(8).
- RFA is nonetheless **not high-risk**: answering internal product questions and drafting Linear specs is not an Annex III use case, and even if it were, the obligations now start 2 December 2027.
- **Article 50** targets AI interacting with natural persons (chatbot disclosure), emotion recognition/biometric categorisation, and synthetic audio/image/video/text that must be *"marked in a machine-readable format and detectable as AI-generated"*. A scribe-drafted Linear document circulated internally is a Goodvest-norms question (should a colleague know a draft was AI-written?), not an Art. 50 marking obligation.
- The one live, unambiguous obligation that touches an internal tool is **Art. 4 AI literacy** (applicable since 2 Feb 2025): the deployer must ensure a sufficient level of AI literacy among staff operating the system. For a one-operator tool that is satisfied by the operator being the author.
- What RFA already has would exceed anything on this list if it were in scope: a hash-chained event log, per-answer citations, human-only approvals with recorded decisions, per-agent budgets, and a nightly backup with an exercised restore.

**Do not build for this. Do write one line in STATUS.md** naming the compliance owner at Goodvest to ask before the tool is ever used by a second person or on client-facing output — that is the event that changes the analysis (a second human means a "deployer" with staff, and client-facing output means Art. 50 gets closer).

#### 5.3 OWASP Agentic Security Initiative

**OWASP Top 10 for Agentic Applications 2026**, published **9 December 2025** (https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/). ASI01–ASI10 as listed in §3.1. This is the right coverage checklist — use it exactly as wave 02 used NeMo's rail taxonomy: as a checklist for writing default gate configs and for the watchdog invariant set, not as a backlog. RFA's coverage map is in §3.2 plus the ASI06/ASI08 notes.
UNVERIFIED: the per-risk control lists were read from a secondary mapping guide because the OWASP PDF is behind a download form (`genai.owasp.org/?ddownload=52117` returns HTML, not a PDF). A future session with browser access should pull the PDF and confirm the ASI10 control wording before quoting it in a spec.

#### 5.4 NIST and ISO — nothing landed

- **NIST CAISI AI Agent Standards Initiative** launched **17 February 2026** — the first US government program dedicated to interoperability and security standards for agentic AI. The technically specific piece, **COSAiS SP 800-53 control overlays for single-agent and multi-agent AI systems, remained in development as of March 2026, with full publication expected late 2026 to 2027.** Threat taxonomy includes "Agent Authorization and Control Hijacking" among 12 categories mapping onto **NIST AI 100-2 E2025**.
  SECONDARY (Cloud Security Alliance research notes, March 2026): https://labs.cloudsecurityalliance.org/research/csa-research-note-nist-ai-agent-standards-federal-framework/ and https://labs.cloudsecurityalliance.org/research/csa-research-note-nist-ai-agent-red-teaming-standards-202603/. UNVERIFIED against a NIST-hosted document; I did not locate a primary NIST publication for the overlays (consistent with them being unpublished).
- **ISO/IEC 42001** (AI management system): *"does not specifically address agentic AI systems, and the standard's controls were designed for AI systems in which human-AI interaction patterns are relatively well-defined"* (same secondary source). It is a management-system standard requiring an audited AIMS — categorically inapplicable to a one-person tool.

**Verdict: track two dates.** (1) COSAiS overlays, late 2026–2027 — when published, they are the first document in this dimension that will contain concrete, implementable, vendor-neutral agent controls, and worth a re-read. (2) `draft-sharif-agent-audit-trail` expiry, 29 September 2026.

---

## Open questions and spikes

### Open questions

1. **Does a hard `maxBudgetUsd` stop ever fire mid-approval, and what happens to the pending card?** The approval bridge blocks inside `canUseTool` while renewing presence. If the SDK ends the query with `error_max_budget_usd` while a human card is outstanding, does the card get swept to reject, does the asker get `gone_quiet`, or does the sidekick orphan again? This is the same shape as the lease-starvation bug that already bit once (STATUS.md finding: "the blocked serve loop starved the main member's lease during approval waits"). **Unknown and worth knowing before recommendation #1 lands.**
2. **How far past the day ceiling can a single run actually go once `maxBudgetUsd` is set from remaining daily spend?** Anthropic bounds overshoot at "one model request per running thread"; with subagents that is one request *per thread*, so depth/concurrency caps and the budget cap interact. Unmeasured for RFA's workloads.
3. **Is `total_cost_usd`'s client-side estimate accurate enough for a $5/day ceiling?** The docs disclaim it and point at the Usage and Cost API. On a subscription (not API key) auth path, what does the estimate even mean? If the estimate drifts 20% low, a $5 ceiling is really $6.
4. **Would the six watchdog invariants have false-fired during the last two weeks of real logs?** Every one of them is claimed to be deterministic; that claim is testable by replay against `data/rooms/*.ndjson` and `data/obs.db` without writing any production code.
5. **Does a goal-adherence judge lint add signal over the existing `r_state × r_output × r_protocol` reward, or is it redundant?** If the computed reward already fails every run a drift judge would flag, the judge is ceremony too. Currently unknown because the eval baseline is 5/5 clean.
6. **What does `snyk-agent-scan` say about `agents/pm-agent/knowledge/**` (Goodvest handbook exports) and the goodvest-linear-* skill packs?** The knowledge pack is externally-authored content that gets `Read` into a resident's context every answer — the single most plausible ASI06/ASI04 surface in the repo, and never scanned.
7. **Is `taskBudget` (SDK alpha) stable enough to put on the scheduled digest, and does the countdown marker interact badly with the resident's structured-answer contract?** Alpha means it can change or vanish.
8. **UNVERIFIED: the OWASP ASI10 control wording.** The PDF is form-gated; the controls in §3.1 come from a third-party mapping. If the spec is going to cite ASI10, confirm against the PDF.

### Spikes, cheapest first

- **S1 — `maxBudgetUsd` from remaining daily spend (30 min).** Change `src/resident.ts:406` to `Math.min(per_task_usd, per_day_usd - spend.usd)`; hoist `costUsd = msg.total_cost_usd ?? 0` and `modelUsage` **above** the subtype guard at line 418; add a `subtype === "error_max_budget_usd" | "error_max_turns"` branch that returns the spec'd `overloaded` refusal instead of throwing. Verify by setting `per_task_usd: 0.01` on a scratch pack and asking one question: expect a refusal with `spend=… budget=…`, a nonzero cost row in `obs.db`, and no generic "brain error". **Settles Q3 partially and closes the $0-journaling bug.**
- **S2 — Subagent caps (10 min).** Add `env: { ...process.env, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3" }` to the resident's query options. Verify a prompt that invites fan-out returns `Concurrent subagent limit reached` as a `tool_result` rather than spawning 20 processes. **Note the TS `env`-replaces-environment trap: without the spread, `PATH` disappears and every Bash tool call fails.**
- **S3 — Budget stop during a pending approval (1 hour).** Reproduce Q1 deliberately: `per_task_usd` set just above the cost of reaching the `save_document` call, then sit on the approval card. Observe whether the card is swept, whether the asker gets `gone_quiet`, and whether the `-hitl` sidekick leaves. **This is the highest-risk unknown in the whole dimension** because it is the exact interaction that produced two live bugs already.
- **S4 — Replay the watchdog invariants against history (2 hours).** A scratch `.mts` script computing all six invariants over the last two weeks of `data/rooms/*.ndjson` + `data/obs.db`. Success criterion: the zombie-observer invariant fires on the known 2026-08-17 window and on the 2026-08-16 evening window, and **nothing else fires**. If any invariant false-fires, it does not ship. Settles Q4 and is the whole justification for recommendation #3.
- **S5 — Goal-adherence judge lint (half day).** Add one tier-3 lint using AlignmentCheck's triple over `rfaLogToTrajectory` output, run it over the existing 5 baseline cases plus 3 deliberately drifted synthetic cases (asker asks about fees, trace wanders into SCPI minimums). Success criterion: 3/3 on the drifted cases, 0/5 false positives on the clean baseline. **If it false-positives on the clean baseline, drop the whole idea — that is the utility-loss failure mode from §2.2 reproduced at RFA scale.** Settles Q5.
- **S6 — One manual supply-chain scan (1 hour).** `uvx snyk-agent-scan --no-skills` first (to avoid the skills pass), then with skills, over the repo. **Do not point it at the MCP config** unless the consent prompt is honoured, because scanning an MCP config executes the commands in it. Record findings in STATUS.md; do not add it to any automated path. Settles Q6.
- **S7 — `taskBudget` on the scheduled digest (1 hour, do last).** Set `taskBudget: { total: 40000 }` on the morning-digest run only; confirm the answer still parses and the run ends with `success` rather than a truncation. Settles Q7. If the alpha API errors, drop it.

### What would change my mind

| Reject | Reversal trigger |
|---|---|
| Flow/taint rules | Any resident gains an **auto-approved** external side-effecting tool (Slack post, email, HTTP POST inside `execute()`), or a second human's content enters a room. Then implement the ~50-line run-scoped taint set (§1.4), not a DSL. |
| Runtime goal-drift auditing | A ledger entry where a resident measurably pursued a different objective than asked and a human caught it late — **or** S5 shows the judge lint scoring 3/3 on drift with 0/5 false positives *and* a long unattended job (digest, consolidation) starts producing wrong-goal output. Even then: gate only the scheduled path, never the interactive one. |
| ML behavioral baselines | Volume crosses roughly 200 runs/day, or the deployment grows past two agents and one operator. Neither is on the roadmap. |
| Cedar / OPA | The gate config outgrows `{id, match, tier, outcome, timeout_ms}` — e.g. needs entity hierarchies or cross-room principal inheritance. |
| Per-token cost interrupts | Anthropic's own Managed Agents moves off "enforced between model requests". Watch that sentence in the budgets docs. |
| IETF AAT wire format | The draft gets adopted by an IETF working group, or a Goodvest auditor asks for a named export format. Re-check after 2026-09-29. |
| EU AI Act work items | A second human uses the tool, or scribe output goes to clients rather than internal Linear. Then ask Goodvest compliance, don't guess. |
| NIST overlays | COSAiS SP 800-53 agent overlays publish (expected late 2026–2027). That is the one forthcoming document worth a full read. |
