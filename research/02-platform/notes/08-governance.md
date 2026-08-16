# 08 - Governance and guardrails for agent platforms

Dimension: governance. Date: 2026-08-16. Sources: primary docs fetched and read (URLs at bottom).
Scope: policy engines (OPA/Rego, AWS Cedar in Bedrock AgentCore), NeMo Guardrails, LlamaFirewall,
Invariant Guardrails, guardrails-ai, OpenAI Agents SDK guardrails, LangGraph interrupts and deep agents
HITL, Claude Code / Claude Agent SDK permission system, LiteLLM budgets, audit-trail requirements.
Deliverable: the concrete policy-gate + budget + approval design RFA v0.4 should adopt.

RFA baseline this note builds on (spec/RFA-0.1.md):

- Section 12.2 already specifies an UNIMPLEMENTED pre-delivery policy gate: "outcomes
  `allow | alert | hold | refuse`, with the outcome recorded", evaluated before delivery, not before append.
- Dispositions `held` (with default 5 min hold TTL, release/refusal/expiry via `system` events referencing
  the original `message_id`) and `refused` already exist on the wire (spec lines 329-332).
- Origin stamping (`Origin = "human" | "agent"` in src/model.ts), human-only `approve`, the approval ext
  `ext["io.github.pbeneteau/approval"] = {request_id, action, params}`, and `room_admin` verbs all exist.
- The durable log already survives restarts and drives deadline sweeps; approvals can reuse that property.

---

## What it is

Governance for agent platforms decomposes into four layers that every mature system implements separately:

1. **Policy decision** - a pure function from (principal, action, resource, context) to a decision.
   OPA/Rego and Cedar are the general engines; Claude Code's rule lists are a specialized one.
2. **Guardrail scanning** - content-level checks on inputs, outputs, and tool traffic (NeMo Guardrails,
   LlamaFirewall, Invariant, guardrails-ai, OpenAI Agents SDK tripwires).
3. **Human-in-the-loop approval** - pausing execution durably until a human decides
   (LangGraph `interrupt()`, deep agents `interrupt_on`, Claude Agent SDK `canUseTool`).
4. **Budgets and audit** - spend/rate ceilings per principal (LiteLLM is the reference implementation)
   and decision-complete, tamper-evident logs.

The strong convergent finding: every serious system separates the DECISION VOCABULARY (a tiny closed enum)
from the CHECK IMPLEMENTATION (pluggable: regex, classifier model, subprocess, LLM judge). RFA 12.2's
`allow | alert | hold | refuse` is already the right vocabulary; what v0.4 needs is the evaluation
algorithm, the check plug-in shape, and the recorded decision format.

---

## Architecture (how each system actually works)

### AWS Cedar in Bedrock AgentCore (policy engine attached to tool gateways)

AgentCore attaches Cedar policies to Gateway tools. Every tool invocation is an authorization request
with principal (OAuth user), action (the tool, name-mangled as `Gateway___tool`), resource (the gateway
ARN), and context carrying the TOOL INPUT PARAMETERS. Evaluation algorithm (copied from the docs):

1. If any `forbid` policy matches the request, the decision is DENY.
2. If no `forbid` matches and at least one `permit` matches, the decision is ALLOW.
3. If neither matches, the decision is DENY (default deny).

Policies are independent (no policy references another), forbid always overrides permit, and an `unless`
clause on a forbid only narrows that forbid, never grants. Session-aware rules use temporal policies
("Dogwood", Cedar-compatible, with a `temporal` block). The AWS security blog's stated reasons for
choosing Cedar for agents: analyzable (no Turing completeness), fast (sub-millisecond), default-deny,
and the decision is externalized from agent code.

Key transferable idea: THE TOOL ARGUMENTS ARE IN THE AUTHORIZATION CONTEXT (`context.input.amount < 500`),
so policy can gate on parameter values, not just tool names.

### OPA/Rego (general policy-as-code)

OPA runs as a sidecar/daemon or embedded Go library; apps query it with JSON input, policies in Rego
(Datalog-derived: deterministic, always terminates). AI gateways (for example TrueFoundry "OPA Guardrails")
embed it to authorize LLM requests and MCP tool invocations. Deployment guidance is to co-locate OPA with
the enforcing service. For a solo TypeScript local-first stack, OPA is an extra runtime and a policy
language to learn; the transferable idea is only the decoupling: enforcement point sends
{principal, action, resource, context} JSON, decision comes back, decision is logged.

### NeMo Guardrails (rail categories + YAML config)

Config directory with `config.yml` + Colang flows. Five rail categories (copied):
input rails (reject or ALTER user input), dialog rails (canonical-form messages), retrieval rails
(RAG chunks), EXECUTION RAILS (applied to input/output of custom actions, that is tools), output rails
(reject output before it reaches the user). Rails are named flows listed under `rails.input.flows` /
`rails.output.flows`; each flow is an LLM-checkable or programmatic action. The taxonomy (which traffic
crossing which boundary) is the useful part; the Colang dialog machinery is chatbot-shaped.

### LlamaFirewall (layered scanners, policy engine orchestrating them)

Operates as "a policy engine that orchestrates multiple security scanners", each plugged into a stage of
the agent workflow: PromptGuard 2 (fast BERT-style classifier for direct prompt injection, on inputs),
AlignmentCheck (chain-of-thought auditor comparing proposed actions against the user's original objective,
during the loop), Regex/custom scanners, CodeShield (static analysis of generated code before execution).
Configuration maps ROLES to SCANNER LISTS; the result is a tiny uniform record (decision, reason, score).
Transferable ideas: (a) scanners keyed by message role/direction, (b) uniform ScanResult regardless of
scanner sophistication, (c) cheap-classifier-first, LLM-judge-later layering.

### Invariant Guardrails (contextual rules on traces, enforced by a proxy)

A transparent MCP/LLM proxy ("Gateway") intercepts every LLM and MCP call and applies rules written in a
Python-like matching language over the trace: match `Message`, `ToolCall`, `ToolOutput`, sequence them
with `->` (flow), call built-in detectors (`prompt_injection()`, `pii`, `secrets`, `semgrep`), and
`raise` on violation. Rules express DATA-FLOW policies ("if untrusted tool output flowed into this
send_email call, block") and run in block or monitor mode. Transferable ideas: (a) monitor mode is
exactly RFA's `alert` outcome, (b) trust-boundary flow rules (tainted upstream content gates downstream
sends) are the correct long-term model for cross-room egress, (c) deployment as a proxy means no agent
code changes; RFA's hub is already that interception point.

### guardrails-ai (validators with on_fail policies)

Each validator carries an `on_fail` action, one of: `reask`, `fix`, `filter`, `refrain`, `noop`,
`exception`, `fix_reask`. That is a MUTATION-ORIENTED vocabulary (rewrite the output, re-prompt the LLM,
drop the field). Useful contrast: on an append-only message substrate you must never mutate a logged
envelope, so `fix`/`reask` do not transfer; `exception` maps to refuse, `noop`+log maps to alert.

### OpenAI Agents SDK guardrails (tripwires at four attachment points)

Guardrails attach at agent input, agent output, tool input, tool output. A guardrail is an async function
returning `GuardrailFunctionOutput(output_info, tripwire_triggered: bool)`; a triggered tripwire raises a
typed exception (`InputGuardrailTripwireTriggered` etc.) halting the run. Tool guardrails can instead
return `ToolGuardrailFunctionOutput.allow()` or `.reject_content(message)` (replace the tool result with
a message rather than kill the run). Input guardrails can run `run_in_parallel=True` with the agent
(optimistic execution, cancel on trip) or blocking. Transferable ideas: (a) the four attachment points,
(b) reject-with-substitute-content as a softer outcome than abort, (c) parallel evaluation is safe only
for alert-tier checks, never for refuse-tier on delivery.

### LangGraph interrupts + deep agents interrupt_on (durable HITL)

`interrupt(payload)` inside a node pauses the graph EXACTLY THERE; state persists via a required
checkpointer; the caller sees `result["__interrupt__"]`; resume with `Command(resume=value)` on the same
thread_id, and the resume value becomes interrupt()'s return value. Deep agents wrap this as middleware:
`interrupt_on={"tool_name": True | False | {"allowed_decisions": [...]}}` with the decision vocabulary
`approve | edit | reject | respond` (respond = human message becomes a synthetic tool result). Critical
operational rules from the docs: never wrap interrupt() in bare try/except, keep interrupt order
deterministic (index-matched on resume), operations before an interrupt re-execute on resume so they must
be idempotent. Transferable ideas: (a) the four-decision vocabulary, (b) approval state must live in the
durable store, not in process memory, (c) per-tool opt-in maps, (d) edit-before-approve.

### Claude Code / Claude Agent SDK (the closest production model to what RFA needs)

Six-step evaluation order for every tool call (copied from the permissions doc):

1. Hooks (PreToolUse) - can deny outright; a hook deny applies EVEN IN bypassPermissions mode; a hook
   allow does NOT skip later deny/ask rules.
2. Deny rules - `disallowed_tools` / settings.json; bare-name deny removes the tool from context.
3. Ask rules - route to the `canUseTool` callback even when an allow rule matches.
4. Permission mode - `default | dontAsk | acceptEdits | bypassPermissions | plan | auto`.
5. Allow rules - `allowed_tools` / settings.json; match approves.
6. `canUseTool` callback - runtime decision; returns `{behavior: 'allow', updatedInput}` or
   `{behavior: 'deny', message}`. In dontAsk mode this step is skipped and the tool is denied.

Hooks are configured declaratively (settings.json) with matchers per tool and typed executors
(`command`, `http`, `mcp_tool`, `prompt`, `agent`); a PreToolUse hook returns
`hookSpecificOutput.permissionDecision: "allow" | "deny" | "ask"` plus `permissionDecisionReason`;
exit code 2 is a blocking error. Subagents inherit the parent's permission mode unless overridden.
Transferable ideas: (a) strict deterministic ordering with deny-beats-everything, (b) hooks as the
universal escape hatch that even bypass mode cannot skip, (c) `ask` as a first-class outcome that routes
to a human, (d) the reason string is part of the decision, (e) the `prompt`-type hook is a built-in
LLM-judge check.

### LiteLLM budgets (reference implementation of per-principal cost ceilings)

Budgets attach to keys, users, teams, team members, tags, and models. Enforcement: on each request the
proxy checks accumulated spend against `max_budget`; exceeding returns an auth-level error
("ExceededBudget: ... Spend=X, Budget=Y"). Resets by `budget_duration` on a scheduler sweep (default
every 10 minutes, so enforcement is slightly lagged, which is acceptable). Precedence quirk worth
copying deliberately: when a key belongs to a team, team budget wins over the key owner's personal
budget (most-specific scope does not always win; the CONTAINING scope caps everything inside it).

### Audit requirements

Convergent list of what must be logged per agent action (Kiteworks/Collibra/IETF draft
draft-sharif-agent-audit-trail-00): the full prompt/input, model version + configuration hash, the
tool-call sequence with arguments, retrieval queries and document ids, the output with decision
rationale, human-override events, memory read/write operations, cost and latency. Tamper evidence =
append-only storage + hash chain (each entry carries SHA-256 of the previous entry; IETF draft uses
RFC 8785 canonical JSON before hashing, optional signatures for non-repudiation). RFA already has JCS
canonicalization (src/jcs.ts) and signing (src/signing.ts), so the hash chain is nearly free.

---

## Exact schemas and APIs (copied)

### Cedar policy for a parameterized tool gate (AgentCore docs, verbatim)

```cedar
permit(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"RefundTool___process_refund",
  resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:region:account:gateway/refund-gateway"
)
when {
  principal.hasTag("username") &&
  principal.getTag("username") == "John" &&
  context.input.amount < 500
};
```

Evaluation: any matching forbid => DENY; else any matching permit => ALLOW; else DENY.

### Claude Code PreToolUse hook decision (verbatim shape)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "Why denied or asked"
  }
}
```

Hook config in settings.json:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "if": "Bash(rm *)",
                     "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh" } ] }
    ]
  }
}
```

Hook input (tool events): `{session_id, transcript_path, cwd, permission_mode, hook_event_name,
tool_name, tool_input, tool_use_id}`. Exit code 2 = blocking error. Hook executor types:
`command | http | mcp_tool | prompt | agent` (the `prompt` type takes a `prompt` and `model`).

### Claude Agent SDK canUseTool (TypeScript)

```typescript
canUseTool: (toolName, input, {signal, suggestions}) =>
  Promise<{behavior: 'allow', updatedInput} | {behavior: 'deny', message}>
// Locked-down headless agent:
const options = { allowedTools: ["Read", "Glob", "Grep"], permissionMode: "dontAsk" };
```

Order: Hooks -> Deny rules -> Ask rules -> Permission mode -> Allow rules -> canUseTool.
Modes: `default | dontAsk | acceptEdits | bypassPermissions | plan | auto`.

### OpenAI Agents SDK guardrails

```python
@input_guardrail   # also @output_guardrail, @tool_input_guardrail, @tool_output_guardrail
async def g(ctx: RunContextWrapper, agent: Agent, input) -> GuardrailFunctionOutput: ...
GuardrailFunctionOutput(output_info=..., tripwire_triggered=bool)
ToolGuardrailFunctionOutput.allow() / .reject_content(message)
# exceptions: InputGuardrailTripwireTriggered, OutputGuardrailTripwireTriggered,
#             ToolInputGuardrailTripwireTriggered, ToolOutputGuardrailTripwireTriggered
# input guardrails: run_in_parallel=True (default) or False (blocking)
```

### LlamaFirewall

```python
llamafirewall = LlamaFirewall(scanners={ Role.USER: [ScannerType.PROMPT_GUARD] })
# Role.USER | Role.ASSISTANT
# ScannerType.PROMPT_GUARD | ScannerType.AGENT_ALIGNMENT | ScannerType.CODE_SHIELD
result = llamafirewall.scan(UserMessage(content="..."))
# ScanResult(decision=ScanDecision.ALLOW|BLOCK, reason='default', score=0.0)
```

### Invariant rule language

```python
raise "External email after reading inbox" if:
    (call: ToolCall) -> (call2: ToolCall)
    call is tool:get_inbox
    call2 is tool:send_email({ to: ".*@[^ourcompany.com$].*" })

from invariant.detectors import prompt_injection
raise "Injected tool output" if:
    (output: ToolOutput) -> (call2: ToolCall)
    prompt_injection(output.content, threshold=0.7)
```

Evaluated via `LocalPolicy.from_string(...).analyze(messages)`; enforced in block or monitor mode.

### NeMo Guardrails config.yml

```yaml
models:
  - type: main
    engine: openai
    model: gpt-3.5-turbo-instruct
rails:
  input:
    flows: [check jailbreak, mask sensitive data on input]
  output:
    flows: [self check facts, self check hallucination]
  config:
    sensitive_data_detection:
      input: { entities: [PERSON, EMAIL_ADDRESS] }
```

Rail categories: input, dialog, retrieval, EXECUTION (tool i/o), output.

### Deep agents HITL

```python
agent = create_deep_agent(
    tools=[remove_file, fetch_file, notify_email],
    interrupt_on={
        "remove_file": True,
        "fetch_file": False,
        "notify_email": {"allowed_decisions": ["approve", "reject"]},
    },
    checkpointer=checkpointer)  # REQUIRED
# resume:
agent.invoke(Command(resume={"decisions": [
    {"type": "approve"},
    {"type": "edit", "edited_action": {"name": "notify_email", "args": {"to": "..."}}},
    {"type": "reject", "message": "User rejected. Do not retry."},
    {"type": "respond", "message": "Synthetic tool result"}]}), config=config)
```

LangGraph core: `interrupt(payload)` pauses; result exposes `result["__interrupt__"]`
(objects with `.value` and `.id`); resume `Command(resume=value)` or `{interrupt_id: value}` map.

### LiteLLM budget fields (/key/generate, /user/new, /team/new share these)

```json
{ "max_budget": 10, "budget_duration": "30d",
  "tpm_limit": 20, "rpm_limit": 4, "max_parallel_requests": 2,
  "model_max_budget": {"gpt-4": {"budget_limit": 0.0001, "time_period": "1d"}},
  "model_rpm_limit": {"gpt-4": 2}, "model_tpm_limit": {"gpt-4": 1000} }
```

Exceeded => auth error: `"ExceededBudget: ... Spend=0.00088, Budget=0.0001"`.
Resets on scheduler sweep (default check every 10 min). Team budget overrides member-key budget.

### Audit log entry (synthesis of IETF draft direction + compliance lists)

Per action: {actor id, origin (human/agent), model + config hash, input, tool name + arguments,
output, policy decision + rule id + reason, human override events, memory reads/writes, cost, latency,
prev_hash (SHA-256 over RFC 8785 canonical JSON of previous entry)}.

---

## What to adopt for RFA v0.4 (the concrete design)

### A. Pre-delivery policy gate (implements spec 12.2)

Keep the spec's outcome enum exactly: `allow | alert | hold | refuse`. Map onto the industry vocab:
allow=permit, alert=Invariant monitor mode / noop+log, hold=Claude Code "ask" routed to a human,
refuse=deny. Adopt these mechanics:

1. **Evaluation algorithm (Cedar-style severity ordering, adapted to default-allow).** Evaluate all
   matching checks; the effective outcome is the MOST SEVERE across matches
   (refuse > hold > alert > allow). No check referencing another check (Cedar policy independence).
   Unlike Cedar, the default when nothing matches is `allow`: RFA is a messaging substrate, not a
   tool gateway; messages flow unless policy says otherwise. Default-deny stays at the TOOL layer
   (Agent SDK allowedTools + dontAsk), not the message layer.
2. **Check plug-in shape (Claude Code hook executor types, cut to three).** A gate check is
   `{id, match, tier, outcome | outcome_map, timeout_ms}` where tier is one of:
   - `rules`: declarative, in-process, microseconds (kind/sender/recipient/role/origin/ext-key match
     plus content regex). Cedar's key insight applies: the check gets the WHOLE envelope as context,
     so it can gate on payload fields, not just kind.
   - `command`: subprocess, JSON envelope on stdin, JSON `{decision, reason, score}` on stdout
     (LlamaFirewall ScanResult shape), exit 2 = refuse (Claude Code exit-code convention).
   - `prompt`: model-based screening via `claude -p` with a cheap model (Claude Code `prompt` hook
     type; LlamaFirewall PromptGuard role). Only for alert/hold tiers, never refuse (latency, cost,
     nondeterminism).
3. **Decision recording (mandatory, from the audit convergence).** Every gated event gets a
   `policy` record appended alongside the disposition:
   `{gate: "allow|alert|hold|refuse", check_id, reason, score?, elapsed_ms}`. The reason string is
   part of the decision (Claude Code permissionDecisionReason). `alert` emits a `system` event
   supervisors see but does not block delivery.
4. **Fail-closed to hold, never silent-allow, never hard-refuse.** Check error or timeout => `hold`
   with the existing 5 min TTL and release path (spec 329). This reuses machinery RFA already has and
   matches the LangGraph durability rule: the pending decision lives in the durable log, so a hub
   restart cannot lose a held message.
5. **Hooks beat everything (Claude Code rule).** Gate checks run before delivery for every recipient
   including supervisors and the host; no mode or role bypasses a refuse-tier check.

Proposed room config shape (hub-side, per room, versioned like room policy):

```yaml
gate:
  default: allow
  fail_mode: hold            # check error/timeout -> hold (TTL 300s, existing release path)
  checks:
    - id: secret-egress
      tier: rules
      match: { kind: [chat, response], content_regex: "(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})" }
      outcome: refuse
    - id: injected-content-screen
      tier: command
      match: { ext_present: "io.github.pbeneteau/injected" }
      command: .rfa/gate/scan.sh
      timeout_ms: 2000
      outcome_map: { block: hold, warn: alert }
    - id: offtopic-screen
      tier: prompt
      match: { kind: [chat] }
      model: haiku
      outcome_map: { flag: alert }
```

### B. Approvals (extend what exists, adopt the deep-agents decision vocabulary)

RFA's human-only `approve` + approval ext is already stronger than most platforms (origin stamping makes
agent-claimed approval void by construction). v0.4 additions:

1. **Adopt `allowed_decisions: [approve, edit, reject, respond]`** on the approval ext:
   `ext["io.github.pbeneteau/approval"] = {request_id, action, params, allowed_decisions?, expires_at?}`.
   `edit` returns edited params with the approve intervention (`room_admin approve` gains an optional
   `params` override, recorded); `reject` carries a message the requesting agent sees; `respond` lets
   the human answer in place of the gated action.
2. **Bridge Agent SDK canUseTool to room approvals.** In the agent engine, each resident agent gets an
   `interrupt_on` map (deep agents shape) over its tools. A gated tool call makes `canUseTool` publish
   the approval request into the room and BLOCK awaiting the approve/reject intervention event
   (room_listen on the conversation), then return `{behavior: 'allow', updatedInput}` (edit flows
   through updatedInput, which the SDK natively supports) or `{behavior: 'deny', message}`.
3. **Durability from the log, not process memory (LangGraph checkpointer lesson, RFA already has the
   primitive).** Pending approvals are derived from the durable log exactly like `reply_by` deadlines
   (spec 0.1.1 rule): pending unless the log shows approve/reject/expiry; expiry sweeps fire after
   restart. Add `expires_at` with a timeout `system` event; an expired approval resolves as reject.
4. **Approval routing is capability-based**: target supervisors (already the spec's pattern); the
   console renders pending approvals as first-class cards (approve/edit/reject buttons) since Paul is
   the only human.

### C. Budgets (LiteLLM field shapes, enforced at two layers)

The hub never sees token spend; the engine never sees room traffic volume. Split accordingly:

1. **Engine layer (cost):** per-agent config in the agent registry:
   `budgets: {per_task_usd, per_day_usd, max_turns, max_parallel_tasks}` using LiteLLM's naming style
   (`max_budget` + `budget_duration` generalized to fixed windows: task, day). Spend comes from the
   Agent SDK result usage (total cost per run). On exceed: the agent refuses further task pickup with
   the existing `refuse` kind, `refusal: {reason: "overloaded", detail: "budget_exceeded: spend=X budget=Y", retry_after_s}`,
   sets presence `busy`, and emits a `status`. LiteLLM's error string format (spend vs budget in the
   message) is worth copying verbatim into `detail`.
2. **Hub layer (rate):** per-member `rpm` (messages per minute) and `max_pending_requests` in room
   policy; exceeding refuses the send with a new error `rate_limited` and `data: {retry_after_s}`.
   This is the anti-runaway-loop control (Invariant's "prevent destructive looping" concern) and needs
   no cost data.
3. **Scope precedence (LiteLLM lesson, made deliberate):** room-level ceilings cap member-level ones
   (the containing scope wins), same as team-over-key in LiteLLM. Document it; their users file
   confused issues about exactly this.
4. **Lagged enforcement is fine:** LiteLLM sweeps every 10 minutes; RFA can check budgets at task
   pickup and per-run completion, not per token.

### D. Audit (cheap wins on existing machinery)

1. **Hash-chain the event log:** each appended event gets `prev_hash` = SHA-256 over the JCS
   canonicalization (src/jcs.ts already exists) of the previous event. Matches IETF
   draft-sharif-agent-audit-trail direction (RFC 8785 + SHA-256).
2. **Decision-complete logging:** the gate decision record (A.3), approval decisions with the human
   principal id, budget refusals, and per-run cost land in the log. RFA already logs tool traffic,
   room_admin interventions, and has OTel spans; the additions are policy outcome + cost fields.
3. **Config hash in the record:** capability digests already pin agent identity; add the gate config
   version/hash to each decision record so "which policy was in force" is answerable.

---

## What to adapt (good ideas, changed shape)

- **Cedar's evaluation model**: adopt the algorithm (severity ordering, independent policies,
  forbid-narrowing-only `unless`) but invert the default to allow for message delivery, and implement
  as a ~200-line TypeScript evaluator over JSON rules, not the Cedar engine. `@cedar-policy/cedar-wasm`
  exists but drags in WASM + Cedar schema modeling for a three-field match language.
- **LlamaFirewall's layering**: adopt scanner-by-role/direction and the uniform
  `{decision, reason, score}` result; implement scanners as gate `command`/`prompt` checks instead of
  importing the Python framework. AlignmentCheck (goal-drift auditing of chains of thought) is the
  right v0.5+ idea for long-running tasks; too expensive and Python-bound for v0.4.
- **Invariant's flow rules**: adopt the CONCEPT of taint (RFA's `injected` ext and origin stamps are
  taint markers already); a full trace-matching language with `->` sequencing is v0.5+ if cross-room
  egress appears. For v0.4 a single rule "content carrying the injected ext cannot leave the room /
  trigger sends to external tools without hold" captures 80% of it.
- **OpenAI's four attachment points**: RFA's gate covers message delivery; the ENGINE should mirror
  tool-input/tool-output guardrails via Agent SDK PreToolUse hooks per agent (settings passed to
  claude -p), so both layers use the same check plug-in shape.
- **deep agents `interrupt_on`**: adopt the config shape and decision vocabulary, but resume via the
  room's durable approval flow rather than a checkpointer; RFA's log IS the checkpointer for approvals.
- **NeMo's rail taxonomy**: use it as the coverage checklist (input, retrieval/memory-ingestion,
  execution, output) when writing default gate configs; RFA's memory-ingestion defenses (hub 0.6.0)
  already cover the retrieval rail.

## What to reject and why

- **OPA/Rego as a component**: a second runtime, a policy language with a real learning curve, and
  general-purpose power RFA does not need. The decoupling idea survives in the gate's JSON-in/
  decision-out contract; the engine does not.
- **Full Cedar dependency**: schema + entity modeling overhead for a solo operator; the evaluation
  algorithm is adoptable in plain TypeScript (above).
- **NeMo Guardrails/Colang as a dependency**: Python-first, dialog-flow-centric (canonical intents,
  bot responses), heavy LLM-side machinery; RFA needs delivery gating, not conversation shaping.
- **guardrails-ai mutation actions (`fix`, `reask`, `fix_reask`)**: rewriting content or re-prompting
  inside the delivery path violates append-only envelope semantics and hides policy effects from the
  audit trail. Outcomes must be dispositions on the original message, never silent rewrites.
- **LlamaFirewall as a runtime dependency**: Python, HuggingFace model downloads, Meta-model-centric;
  keep only the shapes.
- **Invariant Gateway as deployment shape**: a separate proxy server between agents and LLM/MCP is
  redundant when the hub already sits on the message path and the Agent SDK already hooks the tool path.
- **Parallel guardrail execution for refuse-tier checks** (OpenAI's run_in_parallel default): on a
  pre-DELIVERY gate, optimistic delivery cannot be recalled. Parallel is fine for alert-tier only.
- **Per-token real-time budget enforcement**: LiteLLM-grade accounting infrastructure for one operator
  is overkill; per-run/per-task checkpoints give the same protection at near-zero complexity.
- **`bypassPermissions`-style mode for room agents**: Claude Code's own docs hedge it with warnings and
  carve-outs; resident agents should run `dontAsk` + explicit allowlists (fixed tool surface, deny
  instead of prompt), with `interrupt_on` for the exceptions that genuinely need a human.

## Sources (URLs)

- https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-understanding-cedar.html (fetched; Cedar policy example, evaluation algorithm)
- https://aws.amazon.com/blogs/security/why-policy-in-amazon-bedrock-agentcore-chose-cedar-for-securing-agentic-workflows/
- https://docs.cedarpolicy.com/policies/syntax-policy.html
- https://www.openpolicyagent.org/docs/integration (OPA embedding/sidecar guidance)
- https://www.truefoundry.com/docs/ai-gateway/opa-guardrails (OPA embedded in an AI gateway)
- https://github.com/NVIDIA-NeMo/Guardrails (fetched; config.yml, five rail types)
- https://meta-llama.github.io/PurpleLlama/LlamaFirewall/docs/documentation/llamafirewall-architecture/architecture (fetched)
- https://github.com/meta-llama/PurpleLlama/tree/main/LlamaFirewall (fetched; Role/ScannerType/ScanResult API)
- https://arxiv.org/pdf/2505.03574 (LlamaFirewall paper)
- https://github.com/invariantlabs-ai/invariant (fetched; rule language, detectors)
- https://invariantlabs.ai/blog/guardrails (Gateway architecture, block vs monitor)
- https://github.com/guardrails-ai/guardrails/blob/main/docs/hub/concepts/on_fail_policies.md (on_fail enum)
- https://openai.github.io/openai-agents-python/guardrails/ (fetched; tripwire API, four attachment points)
- https://docs.langchain.com/oss/python/langgraph/interrupts (fetched; interrupt/Command API, critical rules)
- https://docs.langchain.com/oss/python/deepagents/human-in-the-loop (fetched; interrupt_on, allowed_decisions, decision shapes)
- https://code.claude.com/docs/en/hooks (fetched; hook events, permissionDecision schema, exit codes, executor types)
- https://code.claude.com/docs/en/agent-sdk/permissions (fetched; six-step evaluation order, modes, canUseTool)
- https://docs.litellm.ai/docs/proxy/users (fetched; budget/rate fields, exceeded errors, reset semantics)
- https://docs.litellm.ai/docs/proxy/team_budgets
- https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/ (standard logging format, hash chain per RFC 8785)
- https://www.kiteworks.com/regulatory-compliance/ai-agent-audit-trail-siem-integration/ (eight-point logging list, tamper evidence)
- /Users/paulbeneteau/Dev/agent-com/spec/RFA-0.1.md (sections 12.1, 12.2, dispositions, approval ext)
- /Users/paulbeneteau/Dev/agent-com/src/model.ts, src/hub.ts, src/jcs.ts (existing origin/disposition/canonicalization machinery)
