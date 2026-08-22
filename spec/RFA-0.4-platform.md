# RFA v0.4: The Platform Layer

**Platform specification, version 0.4.0 (draft)**
Status: Draft for implementation · Date: 2026-08-16 · License: Apache-2.0 (see LICENSE)
Substrate: the RFA protocol, [spec/RFA-0.1.md](RFA-0.1.md) (wire 0.1.x), which stays authoritative for everything on the wire.
Evidence: every design decision below traces to [research/02-platform/REPORT.md](../research/02-platform/REPORT.md) (cited as R sect. N) and its per-dimension notes. This document is the normative extraction: contracts, schemas, invariants; the report holds the why.

The key words MUST, MUST NOT, SHOULD, and MAY are as in RFC 2119.

---

## 1. Scope and positioning

v0.1-0.3 built the protocol: rooms, presence, capability discovery, envelopes, tasks, moderation, human principals. v0.4 builds the **platform** that makes rooms worth having: capable resident agents (tools, skills, memory, per-agent settings), a runtime engine, sandboxes, observability, governance with budgets, evals, a workbench console, and deployment, for a single operator on one machine (R sect. 1).

Design stance (R TL;DR): the industry's durable value is its data shapes, not its platforms. v0.4 adopts schemas verbatim where evidence exists (LangGraph run enums, LangSmith run/feedback records, Letta memory blocks, Mem0 reconciliation contracts, srt sandbox policy, Cloudflare's schedule API, tau-bench rewards) and rejects every framework/server dependency. The runtime is the Claude Agent SDK, which the operator's subscription already funds. TypeScript, MCP-native, SQLite, local-first.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Pack** | A directory under `agents/<name>/` fully defining one agent: definition, prompt, skills, knowledge, memory, evals, state. |
| **Resident** | A pack running as a supervised process, joined to its bound rooms, serving via the Agent SDK. |
| **Supervisor** | The one long-lived process that reconciles the registry (`agents/*`), spawns/restarts residents, resolves secrets, enforces the account layer. |
| **Run** | One durable unit of agent work (a serve turn, a scheduled job, an eval trial), journaled in SQLite. |
| **Step** | A memoized side effect inside a run (`ctx.step(id, fn)`), replayed from the journal on resume. |
| **Block** | A Letta-style core-memory unit compiled into the system prompt. |
| **Gate** | The spec 12.2 pre-delivery policy gate, implemented in v0.4. |
| **Channel** | An adapter that turns an external event (CLI, Slack) into a room request and routes the answer back (R 3.10). |

## 3. Agent packs (the definition contract)

### 3.1 Layout

```
agents/<name>/
  agent.md          # frontmatter definition + markdown body = system prompt
  skills/           # SKILL.md folders, loaded via the local-plugin bridge
  knowledge/        # markdown packs, reached via Read/Grep or skills, never prompt-stuffed
  memory/           # the ONE memory root: blocks/ + notes/ + MEMORY.md index
  evals/            # per-agent eval cases (section 9)
  state/            # gitignored runtime state (member id, session ids, cursors, memory.db)
```

Rules:
- The definition is **inert data** validated by one zod schema (`src/agentdef.ts`) shared by runner and console. Definitions MUST NOT execute code on load (R sect. 4).
- Skills load through the SDK's plugin mechanism (`plugins: [{type: "local", path: "agents/<name>"}]`); residents keep `cwd` at the repo root with `settingSources: ["project"]` (R 3.1, the skills-loading bridge).
- Versioning is git. Full-snapshot edits, no partial merges. The runner stamps the definition content hash into the card; the capability card and digest are DERIVED from `{name, description, offers, definition hash}`, so ANY definition edit (frontmatter or prompt body) rotates the digest and is visible in every roster (R 3.1).

### 3.2 Frontmatter schema (normative fields)

```yaml
rfa_agent: 1                    # format version
name: linear-scribe
description: ...                # feeds the capability card
model: sonnet                   # Claude Code semantics
effort: medium                  # low | medium | high | xhigh | max
tools: { allow: [...], deny: [...] }   # incl. mcp__* patterns
mcp_servers: { ... }
skills: [...]                   # Agent SDK skill packs (procedural)
offers:                         # room-facing card skills (v0.4.0 delta: explicit,
  - id: answer-product-question #   never derived from SKILL.md packs; the two
    description: ...            #   are different things)
knowledge: ["knowledge/**/*.md"]
memory:
  scope: pack                   # the single root of section 5
  blocks: [persona, workload]
  gate: memory-gate             # REQUIRED; enforced in the handler (5.2)
sandbox:
  isolation: none | worktree | container
  permission_mode: default      # dontAsk legal ONLY with no interrupt_on entries (7.2)
  network: none | allowlist | open   # open requires room_admin override
  cwd: ...
secrets: [LINEAR_API_KEY]       # NAMES only; values resolved by the supervisor (6.3)
budgets:
  max_turns: 30
  max_execution_s: 600
  max_rpm: 10
  max_retries: 3
  per_task_usd: 0.50
  per_day_usd: 5.00
interrupt_on:                   # deepagents shape
  mcp__linear__save_document: { allowed_decisions: [approve, edit, reject, respond] }
rooms:                          # the RFA moat: nothing surveyed has room bindings
  - room: r_9a25e48c0e
    role: participant
    serve: true
    presence_ttl_s: 120
    auto_resume: true
schedules:
  - cron: "0 8 * * 1-5"
    timezone: Europe/Paris
    prompt: "morning digest of open questions and stale tasks"
```

Two fields are deliberate RFA differentiators with no industry precedent: `budgets` in the definition and `rooms[]` bindings (R 2.11).


### 3.12 Agent modes (amendment, 2026-08-22)

A pack MAY carry `mode: ask | plan | auto | bypass` at the top level of `agent.md`. It sets how the pack's **acting tools**, the ones `interrupt_on` names, are treated; a pack with no acting tool has nothing a mode changes and reports `read-only`. The mapping is the pure function `agentPosture()` in `src/posture.ts`; the resident passes its result to the Agent SDK as `allowedTools` and `permissionMode` and consults `canUseTool` for whatever is not pre-allowed.

| mode | acting tools at the SDK | `canUseTool` on an acting tool | SDK `permissionMode` |
|---|---|---|---|
| `ask` (default) | not pre-allowed | the approval card of 7.3: approve, edit, reject | `default` |
| `plan` | not pre-allowed | refused with "the answer is the plan"; the system prompt says so | `default` (deliberately not the SDK's `plan`: it demands a plan file and `ExitPlanMode`, which a room has no use for, and the model spent its answer on them) |
| `auto` | not pre-allowed | the card, if the SDK ever asks; in every live run so far the SDK approved the call itself | `auto` |
| `bypass` | pre-allowed | not consulted | `bypassPermissions` |

What a mode does NOT change: `tools.allow` and `tools.deny`, the room's policy gate (12.2), the pack's budgets (18.1), and the human's `hold`, `quarantine` and `evict`. A mode is one line in the definition, so changing it rotates the definition hash: a running supervisor drains and respawns the resident, and the room sees the card digest rotate. `rfa agent mode <name> [mode]` reads and sets it (`bypass` is confirmed on a terminal and needs `--yes` on a pipe); `rfa agent new --kind tool --mode <mode>` scaffolds it; the dashboard cycles it with `m`; `rfa doctor` warns for every pack in `bypass` and notes `auto`.

## 4. Runtime engine

### 4.1 Residents run on the Agent SDK

Residents MUST use the Agent SDK `query()` (not a `claude -p` shell-out): `resume: sessionId` per conversation, `startup()` pre-warm, `permissionMode: "default"` with explicit allow/deny/ask rules, `maxTurns`/`maxBudgetUsd` rails, `settingSources: ["project"]`, and in-process room verbs via `createSdkMcpServer` (`mcp__rfa__room_send`, `room_task`, roster). `total_cost_usd`, `modelUsage`, `num_turns`, and `permission_denials` MUST be recorded into envelope/task metadata (R 3.2). Migration gotcha (normative): the SDK default system prompt is minimal; behavior parity requires the explicit prompt or the `claude_code` preset (R sect. 5, v0.4.0 item 1).

### 4.2 Supervisor

One supervisor (~300 lines, `src/supervisor.ts`): watches `agents/*/agent.md`, reconciles continuously, spawns residents with pm2's policy vocabulary (`autorestart`, `max_restarts`, `min_uptime`, exponential backoff, `kill_timeout` = SIGTERM-drain-SIGKILL, `wait_ready` on room join). launchd keeps ONLY the hub and the supervisor alive. **Health is the presence lease**: a live process with a stale lease is wedged and MUST be restarted (R 3.2). Upgrade = versioned drain: SIGTERM, finish the in-flight turn, release floor, lapse lease, respawn; the new card digest in the roster is the deployed-version marker.

### 4.3 Durable runs, steps, schedules (SQLite)

`data/runs.db`, field names and enums ADOPTED from LangGraph so a later Postgres swap is a driver change (R 2.2, 3.2):
- `runs`: RunStatus `pending|running|error|success|timeout|interrupted`; ThreadStatus `idle|busy|interrupted|error`; per-thread mutex of one concurrent run; `multitask_strategy: reject|interrupt|rollback|enqueue`; max 3 attempts.
- Checkpoint payload for subprocess residents: `{claude_session_id, cwd, room_cursor, custom_state}` with a parent chain behind the 5-method saver interface; `claude -p --resume` is the resume mechanism.
- `steps(run_id, step_id, seq, result_json)`: the memoized step (`ctx.step(id, fn)`, Inngest replay semantics), plus `ctx.sleepUntil` and `ctx.waitForMessage` (mapped to `room_listen`). Durable runs only wait and spawn; every side effect lives in a journaled step.
- `schedules`: Cloudflare's API verbatim (`schedule(when, callback, payload)` discriminated on `scheduled|delayed|cron|interval`, `listSchedules`, `cancelSchedule`), fired by the supervisor.

Wake-up is the hub's own push (`room_watch`/tasks); the room is the stream. No Redis, no queue infrastructure (R sect. 4).

### 4.4 Composition: ask/serve, subagents, handoff

- Within a resident: native Task subagents (isolated context).
- Across residents: delegation through the task board with the final-report-only rule: the delegator receives ONE final, optionally schema-typed report, never the peer transcript (R 3.1).
- **Handoff** (targeted at protocol spec 0.1.7, section 12 here defines the platform behavior): reserved tool name `transfer_to_<member>`, description derived from the capability card, optional `input_json_schema`, `is_enabled` predicate, and an `input_filter` over hub-owned history. As-tool = ask/serve (caller keeps the thread); handoff = history transfer (receiver owns the conversation) (R 2.5).
- Per-tool `{timeout_ms, retry: {max_attempts, backoff}}` on capability declarations, enforced by the RoomMember runtime.

### 4.5 Context hygiene (RoomMember SDK)

Payloads/tool results above ~20k tokens offload to files with a 10-line preview; references travel in envelopes. Monitor context health against the 85% threshold via `getContextUsage()`; the supervisor MAY force-compact between tasks (R 3.2).

## 5. Memory

### 5.1 Layers (one directory + one SQLite DB per agent)

- **L0 working**: the SDK context window.
- **L1 core blocks**: `memory/blocks/*.md`, front matter `{label, description, limit, read_only}`, compiled into the prompt in Letta's XML rendering; `limit` enforced on write.
- **L2 episodic**: append-only `episodes` table in `state/memory.db`; every gated room message (verdict + `wrapped` form stored) and every own answer.
- **L3 semantic**: `facts` table under Mem0's two-phase contract (extraction `{"facts": [...]}`; reconciliation `{memory: [{id, text, event: ADD|UPDATE|DELETE|NONE, old_memory?}]}`) with Graphiti's bi-temporal columns (`created_at/expired_at/valid_at/invalid_at`), `supersedes` lineage, `episode_ids` provenance, hash dedupe, and `source_origin` trust tiers. DELETE is invalidation, never row deletion. Retrieval: FTS5 BM25 reranked by recency x importance; embeddings only if recall proves insufficient.
- **L4 procedural**: prompts/skills/knowledge stay git-tracked; consolidation MAY propose diffs, a human applies them. Auto-writing procedural memory from room content is forbidden (the spec 14.3 worm channel).

### 5.2 The single gated door

The agent-facing interface is the memory-tool verb set (view/create/str_replace/insert/delete/rename, the `memory_20250818` surface), served as in-process MCP tools (`mcp__memory__*`, v0.4.1 delta: same verbs, MCP transport instead of the beta tool type) whose `/memories` root maps to `agents/<name>/memory/` and nowhere else. The handler MUST enforce: MemoryGate on every write payload, block `limit` and `read_only`, and path-traversal validation. SDK `memory: "project"` MUST NOT be enabled for residents (it opens a second, ungated root). Defense in depth: a PostToolUse hook denies file-tool writes to any memory path, so the gate holds even for residents carrying general file tools (R 3.3).

### 5.3 Consolidation

Background only, never in the answer path: after N gated exchanges or on a timer, a separate tool-less cheap model call runs extraction + reconciliation over recent episodes. Standard working protocol (Anthropic pattern): start by reading memory, end by updating it. Conversation memory implements the 4-method session protocol (`get_items/add_items/pop_item/clear_session`).

## 6. Sandboxes

### 6.1 Tiers

| Tier | Mechanism | Use |
|---|---|---|
| 0 | No exec; MCP tools only | pm-agent today; default for scribes |
| 1 | srt (`@anthropic-ai/sandbox-runtime`): Seatbelt/bubblewrap + egress proxy | Default for exec-capable residents |
| 1.5 | Deno `--no-prompt` with scoped `--allow-net/--allow-read` (never `--allow-run`/`--allow-ffi`) | Untrusted TS snippets |
| 2 | `docker run --rm --network none --cpus 2 --memory 2g --pids-limit 256` per task | Hostile code; the only real CPU/RAM boundary |
| 3 | Cloud (E2B/Modal) behind the same interface | Deferred |

The manifest's sandbox block uses the srt settings vocabulary verbatim (`network.allowedDomains` allow-only; `filesystem.denyRead/allowRead/allowWrite/denyWrite`), surfaced on the capability card. srt is a blast-radius reducer, NOT a hostile-code boundary (its README documents bypass classes); hostile code goes to Tier 2 (R 2.7, 3.4).

### 6.2 Invariants

- The exec tool implements `execute(command) -> {output, exitCode, truncated}` (deepagents backend interface); backends `SrtLocalBackend`, `DockerBackend` now, cloud later.
- Always-blocked writes (srt's list extended): shell configs, `.git/hooks`, `.claude/commands`, `dogfood/knowledge/`, agent manifests, `data/`.
- Never `bypassPermissions`; never `bypassPermissions` + `allowUnsandboxedCommands` (R sect. 4).
- Resource budgets at the `execute()` boundary: wall-clock timeout, output truncation, max concurrent execs, recorded in spans. Hard caps only at Tier 2.
- Spike before Tier 1 rollout: hub reachability through srt's proxy on `localhost:8790`; fallback is tool-in-sandbox (wrap only `execute()` subprocesses) (R 3.4).

### 6.3 Secrets

Secret VALUES live in exactly one place (gitignored `data/secrets.json` or the macOS Keychain behind the same interface), readable only by the supervisor and `denyRead`-covered in every srt policy. Packs declare NAMES. At spawn the supervisor injects only the named values via the SDK `env` option (which REPLACES the environment: the resident receives nothing else). Tier 2 containers receive no secrets; credentialed calls happen host-side through `mcp__rfa__*` tools (R 3.4).

## 7. Observability, governance, budgets

### 7.1 Runs and feedback (two tables)

- `runs`: the LangSmith run shape with `dotted_order` (lexicographic sort = trace-tree traversal), plus cost/token fields and `needs_review`; hub OTel spans bridge in via the already-propagated traceparent. Span naming: OpenAI's taxonomy (`agent_span/generation_span/function_span/guardrail_span/handoff_span`), `group_id` = room, GenAI semconv attributes; traces stay local by default (R 3.5).
- `feedback`: one universal record `{run_id, key, score, value, comment, correction, source_type: api|app|evaluator|model|human}` shared by console thumbs, judges, and code checks.
- Console panels are fixed (traces/errors/latency, LLM calls, cost + tokens, top tools, top feedback keys); exactly three alerts (error pct, avg latency, avg feedback score) delivered as messages into an `#ops` room.
- The event log gains a hash chain: `prev_hash` = SHA-256 over the JCS canonical form of the previous event (targeted at protocol spec 0.1.7).

### 7.2 The gate (spec 12.2, implemented)

Outcomes stay `allow | alert | hold | refuse`. Algorithm: evaluate all matching checks; effective outcome = most severe; default allow at the message layer (default-deny stays at the tool layer). Check plug-in `{id, match, tier, outcome|outcome_map, timeout_ms}` with tiers `rules` (in-process, whole envelope as context), `command` (subprocess, `{decision, reason, score}` on stdout, exit 2 = refuse), `prompt` (cheap-model screening, alert/hold only). Every gated event appends a decision record `{gate, check_id, reason, score?, elapsed_ms}` + gate-config hash. Fail closed to `hold` (5-minute TTL). Refuse-tier checks always block; parallel evaluation only for alert-tier (R 3.6).

### 7.3 Approvals

The approval ext gains `allowed_decisions: [approve, edit, reject, respond]` and `expires_at`; `room_admin approve` gains a params override (edit-before-approve), recorded; expiry resolves as reject via a log-derived sweep. Engine bridge (normative because it is easy to get wrong): residents with any `interrupt_on` entry MUST run `permissionMode: "default"`; `interrupt_on` compiles to ask rules routing to `canUseTool`, which publishes a `HumanInterrupt`-shaped request into the room, blocks on the intervention event, and returns `{behavior: 'allow', updatedInput}` or a deny. `dontAsk` skips `canUseTool` entirely and is legal only for packs with zero `interrupt_on` entries (R 3.6).

### 7.4 Budgets (three layers)

1. **Engine (cost)**: per-agent `{per_task_usd, per_day_usd, max_turns, max_parallel_tasks}`, checked at task pickup and run completion (lagged enforcement); on exceed, refuse with reason `overloaded` and `spend=X budget=Y` detail.
2. **Hub (rate)**: per-member `rpm` and `max_pending_requests` in room policy; error `rate_limited` with `retry_after_s`. Containing scope (room) caps member scope.
3. **Account**: one subscription feeds everything. A supervisor-global concurrency cap with priority (approvals and human-facing serves first, scheduled jobs next, consolidation/evals/judges last, preferably off-hours); on a provider rate-limit the run parks as `interrupted` and the supervisor pauses pickup account-wide. `total_cost_usd` is a relative weight, never the real meter (R 3.6).

## 8. Evals

- `rfaLogToTrajectory()`: a pure function from a room NDJSON slice to OpenAI-style messages (tasks/admin verbs as synthetic tool_calls), so agentevals/openevals run unmodified over room logs. Scorers standardize on `{key, score, comment}`.
- Primary score is computed, not judged: `r = r_state x r_output x r_protocol` (task-board end state + verify verdict + evidence; must_mention substrings; protocol lints as pure functions). Dual sets: goals + invariants. Reliability runs report pass^1 and pass^4 with the tau-bench estimator.
- Cases are directories: `evals/cases/<id>/{case.yaml, seed fixtures, reference.ndjson}`; `kind: live|replay`; subjects addressed by capability.
- `npm run evals` writes `reports/evals/<ts>` and exits nonzero on regression vs `evals/baseline.json` (baseline-diff gate, no CI).
- The flywheel: `scripts/promote-case.ts <room> <task-id>` slices a human-verified evidence-gate outcome into a labeled case; the dataset grows from real work.
- Judge transport: `claudeJudge()` over `claude -p --output-format json` (subscription auth), agentevals prompts + RFA rubric bullets, `choices: [0, 0.25, 0.5, 0.75, 1]`, call count capped per day. Cadence: tier 1 replay scorers in `npm test`; tier 2 live scripted cases pre-commit; tier 3 judged + pass^k weekly or after prompt/model/knowledge changes (R 3.7).

## 9. Console/workbench

Six stages on the existing hub-served console, each shippable alone: 1 Registry (packs + live presence + digests), 2 Editor (form and raw-YAML lenses over the canonical file), 3 Playground (one question through the serve path; later side-by-side definitions), 4 Inbox (pending approvals, accept/edit/respond/ignore), 5 Runs (trace trees by `dotted_order`, fixed panels; stretch: the assembled-prompt viewer), 6 Lifecycle (start/stop/restart, lease health).

Write surfaces (stages 2/4/6) ship WITH auth, not after: the operator presents the provisioned `human_key` once, the hub mints a short-lived session token bound to `{principal, scope}`, every write carries it, and resulting events are stamped `origin: "human"` (which is what makes browser approvals sound under spec 4.2). Read-only tabs stay tokenless; the hub keeps binding to localhost (R 3.8).

## 10. Deployment, retention, backup

- Two launchd plists (hub, supervisor): `RunAtLoad`, `KeepAlive{Crashed:true, SuccessfulExit:false}`, `ThrottleInterval 10`.
- `rfa.json` deployment manifest (residents map, env, checkpointer/store TTL sweeper, http toggles), modeled on `langgraph.json`.
- Retention sweeper: prune runs older than N days unless they carry feedback or are `in_dataset`; facts invalidate, never delete; room NDJSON rotates + compresses after M days once journaled; Claude transcripts delete when no live checkpoint references their session id.
- Backup: nightly `.backup` of every SQLite DB + dated archive of `data/`, `agents/*/memory/`, `dogfood/state/` to a Time Machine-covered path. The restore procedure is a STATUS.md runbook entry and MUST be exercised once (R 3.9).

## 11. First workload (validates everything above)

- **`linear-scribe`**: drafts the operator's own Linear documents (whatever templates the pack carries) from pasted transcripts, reusing whatever `linear-*` skill packs the operator already has. Tools: `mcp__linear__*` + Read/Grep; Tier 0; the Linear token is a supervisor-injected secret; every `mcp__linear__save_*` call pauses on an approve/edit/reject card, so nothing lands in Linear unreviewed.
- **Channels**: (a) `rfa ask <room> <question>` CLI joining with the operator's human_key (human-origin requests); (b) a Slack adapter on the channels flow (verify + normalize -> resolve principal + thread -> room -> answer back to the SAME Slack thread); (c) schedules, starting with a weekday morning digest.
- **Flywheel**: every verified linear-scribe run is promote-case material; its computed reward (right team, required sections, citations to source) is the first real `r_state x r_output x r_protocol` instance; pass^k over it measures the consistency a daily tool needs (R 3.10).

## 12. Protocol deltas targeted at spec 0.1.7+

The platform needs four wire-level additions to the protocol spec, to be specified there when implemented: the `handoff` verb (4.4), approval ext `allowed_decisions`/`expires_at` (7.3), room-policy rate budgets + the `rate_limited` error (7.4), and envelope/log `prev_hash` hash chaining (7.1).

## 13. Build path

| Milestone | Content | Report ref |
|---|---|---|
| **v0.4.0** (week one) | Agent SDK swap with parity check; session resume + knowledge behind Read/Grep; `agents/pm-agent/agent.md` + `src/agentdef.ts` + derived card (one announced digest rotation in the live room); supervisor v0 + two plists + versioned drain; the srt spike | R sect. 5 |
| v0.4.1 | runs/steps/schedules tables; multitask_strategy; in-process `mcp__rfa__*` tools; memory v1 (blocks + gated handler + episodes + the PostToolUse deny hook) | R sect. 5 |
| v0.4.2 | the 12.2 gate (rules, command, prompt tiers) + decision records; approvals with allowed_decisions + the canUseTool bridge; three budget layers; secrets injection; hash-chained log; srt Tier 1 + `execute()` interface | R sect. 5 |
| v0.4.3 | runs + feedback tables, traceparent bridge, semconv, console panels, three alerts into #ops, review lane, retention sweeper + nightly backup | R sect. 5 |
| v0.4.4 | trajectory mapping, computed reward + lints, case dirs, baseline gate, promote-case, claudeJudge + pass^k | R sect. 5 |
| v0.4.5 | console stages 2-6 with session-token auth; background consolidation; the handoff verb | R sect. 5 |
| v0.4.6 | linear-scribe pack, `rfa ask` CLI, Slack channel, first promoted eval cases | R sect. 5 |

Deferred beyond v0.4: embeddings (unless FTS5 recall fails), Tier 3 cloud sandboxes, Restate migration, flow rules / goal-drift auditing, second-human credential isolation.

## 14. Verification discipline

Every milestone lands behind the existing gates: `npm test` and `npm run e2e` stay green, live wire verification against the standing room, findings logged in STATUS.md. The eval tiers become part of the gate as they land (tier 1 in `npm test` from v0.4.4). The v0.4.0 SDK swap specifically MUST pass an answer-parity check against recorded pm-agent answers before the shell-out is deleted.
