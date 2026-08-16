# 11. Agent definition formats and workbench UX

Dimension: agent-config-workbench. Researched 2026-08-16 from primary sources (docs pages, GitHub READMEs, SDK references). Goal: what the RFA agent-definition schema v0.4 should standardize (model, effort, tools, skills, memory, sandbox, budgets, room bindings) and how the room console grows into a personal agent-ops workbench.

Grounding in the current repo: today the only "agent definition" in RFA is `dogfood/pm-agent.ts` (a hand-written TS process: env vars `RFA_PM_MODEL`, `RFA_PM_NAME`, `RFA_PM_KNOWLEDGE`, a hardcoded capability card with one skill, a knowledge-pack loader, and a `claude -p --model <m>` brain). Everything below is about replacing that one-off with a declarative, repeatable format plus a console that manages many such agents.

## What it is

Seven agent-definition formats and five workbench UIs were examined:

| Platform | Definition artifact | Nature |
|---|---|---|
| LangGraph / LangSmith assistants | server-side record: `graph_id` + `config` + `context` + `name` + `metadata`, versioned | runtime config layered on deployed code |
| LangChain deepagents (OSS) | Python call: `create_deep_agent(...)` + `SubAgent` dicts | code-first, harness assembles middleware |
| LangChain Managed Deep Agents (MDA) | a DIRECTORY: `agent.py` + `instructions.md` + `skills/` + `tools/` + `middleware/` + `connectors/` + `schedules/` + `sandbox/`, deployed by the `mda` CLI | filesystem-as-schema; file location determines role |
| CrewAI | `Agent(...)` kwargs / `agents.yaml` / JSONC | prose-heavy persona schema (role, goal, backstory) |
| AutoGen / AutoGen Studio | component JSON: `provider` + `component_type` + `version` + `config`, recursively nested | class-path-coupled declarative serialization |
| Dify DSL | one YAML file: `app:` + `workflow:` (ReactFlow graph of nodes/edges) + `dependencies` | visual-editor export format |
| Letta `.af` agent file | one JSON file: model config + system + memory blocks + tools (with source) + tool rules + full message history | serialized STATE, not just definition |
| Claude Code subagents + skills | `.md` file with YAML frontmatter + markdown system prompt; skills as `SKILL.md` dirs | text-first, git-friendly, richest per-agent settings |
| OpenAI AgentKit Agent Builder | visual canvas workflow, exported to Agents SDK code | DEPRECATED, shuts down 2026-11-30 |

Workbench UIs: LangSmith Playground, AutoGen Studio (Team Builder / Playground / Gallery / Deploy), Dify Studio, Letta ADE (three-panel agent IDE), LangChain agent-inbox (HITL interrupt queue).

## Architecture (how it actually works)

### LangGraph assistants: config-over-code with versioning

An assistant is "an instance of a graph with a specific configuration". The graph (code) is deployed once; many assistants point at the same `graph_id` with different `context` (typed static config, the newer replacement for `config.configurable`). Every update creates a new immutable version; any version can be promoted back to active; updates take the ENTIRE payload (no partial merge). Assistants are a LangSmith Deployment feature, not OSS. The pattern worth stealing is the separation: code defines the possibility space (a context schema), the assistant record picks a point in it, and versions are full snapshots.

### Managed Deep Agents: the directory is the schema

MDA's core idea: "an agent is a directory. A file's location determines its role." The `mda` CLI compiles the directory into a managed LangGraph app:

- `agent.py` (required): model + tools + middleware selection via `define_deep_agent(name=..., model="provider:model", tools=[...], middleware=[...])`
- `instructions.md`: the system prompt lives OUTSIDE code as markdown
- `skills/`: task playbooks (SKILL.md folders, progressive disclosure: names+descriptions load at startup, bodies load on demand)
- `tools/`: custom functions; `middleware/`: wrappers; `connectors/mcp.py`: MCP servers; `schedules/`: managed cron; `sandbox/`: sandbox config
- `mda dev` runs locally, `mda deploy` ships it

The deepagents harness underneath supplies planning (`write_todos`), a virtual filesystem (State/Store/Filesystem/Composite backends), subagent delegation (`task` tool), summarization, and HITL interrupts as middleware.

### Claude Code subagents: frontmatter as the per-agent settings surface

A subagent is one markdown file: YAML frontmatter (identity + runtime settings) plus a markdown body (the system prompt). It has the richest per-agent knob set of any format surveyed, and it is the only one that treats `effort` as a first-class field. Skills are the same pattern one level down (SKILL.md with frontmatter; the agentskills.io open standard fixes six portable fields: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`). Priority layering (managed settings > CLI > project > user > plugin) resolves collisions.

### Letta .af and the ADE: state serialization plus a live agent IDE

`.af` serializes the WHOLE agent: model config, system prompt, memory blocks, tools with source code and JSON schema, tool rules, environment variables (secrets nulled on export), and the complete message history with `in_context` flags. Import/export via REST (`POST /v1/agents/import`, `GET /v1/agents/{id}/export`) and SDKs (`client.agents.importFile()`). Archival passages are excluded (roadmap). The ADE workbench is three panels: center Agent Simulator (chat + simulated system events), left Agent Configuration (live edit of model, system instructions, tools, data sources, context window size), right State Visualization (Context Window Viewer showing exactly what is in context, editable Core Memory Blocks, Archival Memory search). The killer UX idea: you edit a RUNNING agent and watch its context window change.

### AutoGen Studio: canonical JSON round-tripping through a visual builder

Everything (team, agent, model client, tool, termination condition) is a Component serialized by `dump_component()` to `{provider, component_type, version, component_version, description, label, config}` where `config` recursively nests more components. The Studio's Team Builder edits that JSON visually OR as raw JSON (both views, one artifact); Playground runs teams with live message streaming and control-transition graphs; Gallery shares components; Deploy exports Python code or a Docker endpoint. Explicitly a research prototype, and the docs warn "ONLY LOAD COMPONENTS FROM TRUSTED SOURCES" because deserialization instantiates classes by `provider` path.

### Dify DSL: visual-editor export, graph coordinates and all

One YAML per app (`version`, `kind: app`, `app.mode: workflow|advanced-chat|agent`, `workflow.graph.nodes/edges` in ReactFlow shape, `environment_variables`, `conversation_variables`, `features`, `dependencies`). Portable across Dify instances, and the studio has good primitives (four variable scopes, `/` variable picker, publish to API/web/MCP-server), but the DSL encodes canvas layout and node wiring, not a reusable agent identity.

### agent-inbox: the HITL pattern extracted to a schema

A standalone inbox UI over LangGraph interrupts. The whole contract is four tiny types (below): an agent pauses on a tool call, emits a `HumanInterrupt` (the proposed action + which responses are allowed), the inbox lists interrupted threads, the human picks accept/edit/respond/ignore, the graph resumes. Config is just deployment URL + graph/assistant id. deepagents' `interrupt_on` generates these interrupts per tool with `allowed_decisions: approve|edit|reject|respond`.

### OpenAI AgentKit Agent Builder: cautionary tale

Visual canvas, typed node inputs/outputs, publish-as-version, export to Agents SDK code or ChatKit embed. Deprecated after roughly one year; shutdown 2026-11-30; OpenAI now points workflow builders to code (Agents SDK). Lesson: for a solo operator, a visual builder is the most perishable layer of the stack; the durable artifact is the exported code/config.

## Exact schemas and APIs (copied)

### Claude Code subagent frontmatter (full field table, from code.claude.com/docs/en/sub-agents)

```markdown
---
name: subagent-name
description: When Claude should delegate to this subagent
tools: Tool1, Tool2, Tool3
model: sonnet
---
System prompt text in Markdown format.
```

Fields: `name` (required), `description` (required), `tools` (allowlist; inherits all if omitted), `disallowedTools` (denylist), `model` (`sonnet|opus|haiku|fable`, full id, or `inherit`; default `inherit`), `permissionMode` (`default|acceptEdits|auto|dontAsk|bypassPermissions|plan|manual`), `maxTurns` (number), `skills` (names preloaded at startup), `mcpServers` (inline defs or string refs), `hooks` (PreToolUse/PostToolUse/Stop), `memory` (`user|project|local`, persistent cross-session), `background` (bool), `effort` (`low|medium|high|xhigh|max`), `isolation` (`worktree`), `color`, `initialPrompt`. Tool syntax extras: `Agent(worker, researcher)` restricts spawnable subagents; `mcp__github` and `mcp__*` patterns in denylists. Model resolution order: env `CLAUDE_CODE_SUBAGENT_MODEL` > per-invocation param > frontmatter > main conversation model. CLI equivalent: `claude --agents '{"code-reviewer": {"description": ..., "prompt": ..., "tools": [...], "model": "sonnet"}}'`.

### Claude Code skill frontmatter (from code.claude.com/docs/en/skills)

`name`, `description`, `argument-hint`, `arguments` (named positional for `$name` substitution), `disable-model-invocation`, `user-invocable`, `allowed-tools` (pre-approved for the invoking turn), `disallowed-tools`, `model`, `effort`, `context: fork` (+ `agent`: which subagent type runs it, `background`), `hooks`, `paths` (glob-gated auto-load), `shell`, `metadata` (free-form map), `license`, `compatibility`. Substitutions: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`. Portable subset (agentskills.io + Skills API): `name, description, license, compatibility, metadata, allowed-tools`; anything else fails upload with "Unexpected key(s) in SKILL.md frontmatter".

### deepagents create_deep_agent and SubAgent (from docs.langchain.com/oss/python/deepagents)

```python
create_deep_agent(
    model: str,                 # "provider:model", e.g. "anthropic:claude-sonnet-4-6"
    tools: list = None,
    system_prompt: str = None,
    middleware: list = None,
    subagents: list = None,
    backend: BackendProtocol = None,   # StateBackend | StoreBackend | FilesystemBackend | composite | sandbox (SandboxBackendProtocolV2)
    skills: list = None,        # e.g. ["./my-project/skills/"]; later sources override same-name skills
    interrupt_on: dict = None,
    checkpointer: BaseCheckpointSaver = None,
    store: BaseStore = None,
)
```

SubAgent dict fields: `name` (str, becomes AIMessage/streaming metadata), `description` (str, guides delegation), `system_prompt` (str, required, no inheritance), `tools` (list, replaces inherited entirely), `model` (str or BaseChatModel override), `middleware` (list, no inheritance), `interrupt_on` (`dict[str, bool | InterruptOnConfig]`), `skills` (`list[str]`, independent), `response_format`, `permissions` (`list[FilesystemPermission]`, replaces parent). `CompiledSubAgent`: `{name, description, runnable}` for arbitrary compiled graphs. A `general-purpose` subagent is auto-included (inherits parent tools, model, and uniquely, skills). Delegation: `task(name="research-agent", task="Research quantum computing")`.

HITL: `interrupt_on = {"remove_file": True, "fetch_file": False, "notify_email": {"allowed_decisions": ["approve", "reject"]}}`; decisions are `approve | edit | reject | respond`; resume with `agent.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config=config)`. Configuring `interrupt_on` auto-adds `HumanInTheLoopMiddleware`; `PatchToolCallsMiddleware` repairs history on cancel.

Managed Deep Agents `agent.py`:

```python
from managed_deepagents import define_deep_agent
agent = define_deep_agent(
    name="research-assistant",
    model="openai:gpt-5.5",
    tools=[internet_search],
    middleware=[log_tool_calls],
)
```

Directory roles: `agent.py` (required), `instructions.md`, `skills/`, `tools/`, `middleware/`, `connectors/mcp.py`, `schedules/`, `sandbox/`.

### LangGraph assistants SDK (from docs.langchain.com/langsmith/configuration-cloud)

```python
openai_assistant = await client.assistants.create(
    "agent",                             # graph_id
    context={"model_name": "openai"},
    name="Open AI Assistant",
)
openai_assistant_v2 = await client.assistants.update(
    openai_assistant["assistant_id"],
    context={"model_name": "openai", "system_prompt": "You are a mindful assistant!"},
)   # creates version 2; update takes the ENTIRE payload, no merging
await client.assistants.set_latest(openai_assistant["assistant_id"], 1)  # promote/rollback
```

Assistant record fields: `assistant_id` (UUID), `graph_id`, `context`, `config`, `name`, `metadata`, timestamps, `version`.

### agent-inbox interrupt contract (verbatim TypeScript)

```typescript
export interface HumanInterruptConfig {
  allow_ignore: boolean;
  allow_respond: boolean;
  allow_edit: boolean;
  allow_accept: boolean;
}
export interface ActionRequest {
  action: string;
  args: Record<string, any>;
}
export interface HumanInterrupt {
  action_request: ActionRequest;
  config: HumanInterruptConfig;
  description?: string;
}
export type HumanResponse = {
  type: "accept" | "ignore" | "response" | "edit";
  args: null | string | ActionRequest;
};
```

Inbox connection config: assistant/graph ID + deployment URL. That is the entire integration surface.

### CrewAI agent schema (from docs.crewai.com/en/concepts/agents)

Required: `role: str`, `goal: str`, `backstory: str`. Notable optionals with defaults: `llm` (default env `OPENAI_MODEL_NAME` or "gpt-4"), `tools: List[BaseTool] = []`, `max_iter: int = 20`, `max_rpm: Optional[int]`, `max_execution_time: Optional[int]`, `max_retry_limit: int = 2`, `respect_context_window: bool = True`, `allow_delegation: bool = False`, `cache: bool = True`, `verbose: bool = False`, `system_template/prompt_template/response_template`, `multimodal: bool = False`, `inject_date: bool = False` + `date_format: "%Y-%m-%d"`, `reasoning: bool = False`, `max_reasoning_attempts`, `knowledge_sources`, `embedder`, `use_system_prompt: bool = True`, `allow_code_execution` + `code_execution_mode: "safe"|"unsafe"` (both deprecated). JSONC config example:

```jsonc
{
  "role": "{topic} Senior Data Researcher",
  "goal": "Uncover cutting-edge developments in {topic}",
  "backstory": "You find the most relevant information and present it clearly.",
  "llm": "openai/gpt-4o",
  "tools": ["SerperDevTool"],
  "settings": { "verbose": true, "allow_delegation": false, "max_iter": 20 }
}
```

The `{topic}` interpolation from task inputs is a nice touch: definitions are templates, instantiated per run.

### AutoGen component JSON (from microsoft.github.io/autogen serialize-components)

```json
{
  "provider": "autogen_agentchat.agents.AssistantAgent",
  "component_type": "agent",
  "version": 1,
  "component_version": 1,
  "description": "An agent that provides assistance with ability to use tools.",
  "config": {
    "name": "assistant",
    "model_client": {
      "provider": "autogen_ext.models.openai.OpenAIChatCompletionClient",
      "component_type": "model",
      "version": 1,
      "component_version": 1,
      "config": {"model": "gpt-4o"}
    },
    "system_message": "Use tools to solve tasks.",
    "reflect_on_tool_use": false
  }
}
```

Load with `AssistantAgent.load_component(agent_config)`. Docs warning verbatim: "ONLY LOAD COMPONENTS FROM TRUSTED SOURCES".

### Dify DSL top level (from the DSL skill reference + docs)

```yaml
version: "0.7.0"        # quoted string; "0.6.0" also common
kind: app
app:
  name: ...
  mode: workflow        # workflow | advanced-chat | agent
  icon: ...
  description: ...
dependencies: [...]     # marketplace/plugin refs
workflow:
  environment_variables: [...]
  conversation_variables: [...]   # advanced-chat only
  features: {...}
  graph:
    nodes: [...]        # node: {type: custom, data: {type: llm|code|agent|tool..., model, prompt_template, context, ...}}
    edges: [...]
```

Selectors: `["node_id", "field"]` or `{{#node_id.field#}}`. LLM nodes require `context` even disabled: `{enabled: false, variable_selector: []}`.

### Letta .af content (from letta-ai/agent-file README + docs.letta.com)

One JSON file containing: model configuration (context window limit, model name, embedding model name), complete message history with per-message `in_context` flag, system prompt, memory blocks, tool rules (sequencing constraints), `tool_exec_environment_variables` (secrets set to null on export), and tools with source code + JSON schema. Schema also includes `groups`, `files`, `sources` (folders), `mcp_servers`. Excluded: archival memory passages. Full schema lives in the Letta repo (`letta/schemas/agent_file.py`); import via `POST /v1/agents/import`, export via `GET /v1/agents/{AGENT_ID}/export`.

### Workbench UX inventory

- LangSmith Playground: prompt + model config in one settings view (gear per model), default model config pinning, Manage Tools modal, structured-output schema editing, side-by-side comparison of prompts/models, and "run an evaluation of the prompt against a larger dataset" from the same UI.
- AutoGen Studio: Team Builder (drag-drop AND raw JSON of the same component config), Playground (live message stream, control-transition graph, pause/stop, UserProxyAgent interaction), Gallery (import community components), Deploy (export Python, spin up API endpoint, Dockerize).
- Dify Studio: node canvas, four variable scopes (input, node output, environment, conversation), `/` variable picker, publish targets (web app, API, MCP server), DSL import/export buttons.
- Letta ADE: center Agent Simulator (chat + simulated system events), left live config (model, instructions, tools, sources, context window size), right state (Context Window Viewer, editable memory blocks, archival search). Edit-while-running is the differentiator.
- agent-inbox: a queue of interrupted threads across deployments; per-item the proposed `action_request` renders with accept/edit/respond/ignore buttons gated by `HumanInterruptConfig`.

## What to adopt for RFA

### 1. Adopt: markdown-frontmatter agent files in a directory-as-agent layout (v0.4 core)

Combine Claude Code's frontmatter (best per-agent knob set, git-native, human-editable) with MDA's directory convention (file location = role). Since RFA agents run on `claude -p` / the Agent SDK, most frontmatter fields map 1:1 onto flags the runtime already understands. Proposed layout:

```
agents/<agent-name>/
  agent.md          # frontmatter (definition) + markdown body (system prompt)
  skills/           # SKILL.md folders, agentskills.io-compatible frontmatter
  knowledge/        # markdown packs (replaces RFA_PM_KNOWLEDGE env hack)
  memory/           # named memory-block .md files (Letta-style, gated)
  state/            # runtime state, gitignored (member id, room resume info)
```

### 2. Adopt: the v0.4 agent-definition schema (frontmatter of agent.md)

```yaml
---
rfa_agent: "0.4"                  # format version (Dify-style quoted string)
name: pm-agent                    # lowercase-hyphen id, doubles as room display name
description: >                    # delegation/discovery text, feeds the capability card
  Goodvest product knowledge. Answers product questions with citations.

# model
model: haiku                      # alias | full id | inherit  (Claude Code semantics)
effort: medium                    # low|medium|high|xhigh|max  (Claude Code semantics)

# capabilities surface
tools:                            # allow/deny, Claude Code semantics incl. mcp__* patterns
  allow: [Read, Grep, Glob]
  deny: [Write, "mcp__*"]
mcp_servers: []                   # inline defs or string refs (Claude Code shape)
skills: [answer-product-question] # preloaded names; bodies in ./skills/ (progressive disclosure)
knowledge: ["knowledge/**/*.md", "../../spec/RFA-0.1.md"]

# memory
memory:
  scope: agent                    # agent|project|room  (Claude Code user/project/local, renamed)
  blocks: [persona, product-facts]  # named files under memory/, size-capped
  gate: memory-gate               # REQUIRED: pipe writes through sanitizeForMemory (spec 14.3)

# sandbox / permissions
sandbox:
  isolation: none                 # none|worktree|container (start with worktree, Claude Code semantics)
  permission_mode: dontAsk        # default|acceptEdits|dontAsk|plan|bypassPermissions
  cwd: .                          # jail for filesystem tools

# budgets (union of CrewAI + Claude Code fields, plus cost)
budgets:
  max_turns: 30                   # Claude Code maxTurns
  max_execution_s: 120            # CrewAI max_execution_time, per request served
  max_rpm: 10                     # CrewAI max_rpm, rate limit on the brain
  max_retries: 2                  # CrewAI max_retry_limit
  max_usd_day: 5                  # new: daily spend ceiling, enforced by the runner

# human-in-the-loop (deepagents interrupt_on, delivered over RFA envelopes)
interrupt_on:
  room_send_broadcast: { allowed_decisions: [approve, reject] }
  "mcp__*": true                  # every MCP tool call pauses for approval

# room bindings (RFA-specific; nothing external has this, it is our moat)
rooms:
  - room: r_9a25e48c0e            # or handle
    role: member                  # member|room_admin (moderation profile roles)
    serve: [answer-product-question]   # skills exposed via the capability card here
    presence_ttl_s: 300
    auto_resume: true             # resume membership from state/ on restart

schedules: []                     # cron entries (MDA schedules/), runner-executed
---
You are pm-agent, the product-manager agent, answering inside an RFA agent room.
...system prompt body (markdown), replacing the string-concatenation in pm-agent.ts...
```

Validation: one zod schema in `src/agentdef.ts`; the runner and the console share it. The capability card and its digest are DERIVED from `{name, description, skills, rooms[].serve}`, so editing the definition rotates the digest exactly as `pm-agent.ts` does today when knowledge changes.

### 3. Adopt: assistant-style versioning, but git-backed

Full-payload snapshots per change (LangGraph rule: no partial merges keeps versions unambiguous). Implementation: the runner records the content hash of `agent.md` at start and stamps it into presence/card metadata; promote/rollback is `git checkout`. No version database.

### 4. Adopt: the agent-inbox interrupt contract verbatim

Map `HumanInterrupt`/`HumanResponse` onto RFA envelopes: an agent hitting `interrupt_on` posts an envelope `kind: "approval_request"` with `action_request` + `config`; the console renders accept/edit/respond/ignore; the human (origin: human principal, already in spec 0.1.5) replies with a `HumanResponse`-shaped payload; the runner resumes the paused `claude -p` turn. This reuses the existing moderation/approve machinery and gives the console its inbox tab almost for free. Four booleans and two small objects; do not invent a richer schema.

### 5. Adopt: skills as agentskills.io-compatible SKILL.md folders

Already half-true in this repo (the consult-room and ask-pm skills). Keep per-agent skills inside `agents/<name>/skills/` with the portable six-field frontmatter so they load in Claude Code unchanged; adopt deepagents' precedence rule (later source wins on same name) for layering shared skills over per-agent ones.

### 6. Adopt: console upgrade path (watch-rooms console -> agent-ops workbench)

Staged, each stage shippable alone, all served by the existing hub HTTP server next to GET /console:

1. Registry tab: list `agents/*/agent.md` (parsed by the shared zod schema), show card digest, bound rooms, presence state (live from leases), definition hash, and running/stopped from the supervisor. This is AutoGen Studio's Gallery + Deploy list collapsed into one table.
2. Editor: form view AND raw-YAML view of the same file (AutoGen Team Builder's dual-view rule; the JSON/YAML is canonical, the form is a lens). Save writes `agent.md`, validates, shows the derived capability card + digest diff before saving.
3. Playground tab (LangSmith pattern, minimal): pick an agent definition, type one question, run it through the same code path as `serve` (spawn `claude -p` with the assembled prompt) WITHOUT joining a room; show answer, latency, token/cost. Add side-by-side compare of two definitions (e.g. haiku/medium vs sonnet/low) later.
4. Inbox tab: interrupted actions across all rooms (adopt item 4), badge count in the header.
5. Runs tab: per-serve trace from the OTel spans the hub already emits (span list per conversation id, duration, tool calls). Letta ADE's Context Window Viewer is the stretch goal: show the exact assembled prompt for a given run (the runner logs it to `state/`).
6. Lifecycle controls: start/stop/restart resident agents from the Registry (supervisor = small process manager in the runner, launchd-friendly), with health derived from presence leases (already ~1ms via room_watch).

## What to adapt

- Letta memory blocks: adopt the concept (named, editable, always-in-context blocks) but store them as plain `.md` files under `agents/<name>/memory/` with a size cap per block, not database rows. Console edits them in the Editor tab. All writes go through the existing MemoryGate (Morris-II defense), which Letta does not have.
- MDA `connectors/` and `schedules/`: adapt as frontmatter lists (`mcp_servers`, `schedules`) rather than code files; TypeScript-first RFA does not need a Python module per connector. The runner turns `schedules` into node-cron entries.
- deepagents `general-purpose` subagent: adapt as a default "utility" room member the runner can spawn for one-off tasks; inherits tools and skills like deepagents does; not part of v0.4 schema, just runner behavior.
- CrewAI `{placeholder}` interpolation: adapt narrowly as `$name` substitutions in skill bodies (Claude Code already defines the substitution table); do not add templating to agent.md itself.
- LangSmith Playground dataset runs: adapt later as "replay this room's past questions against a new definition" (the NDJSON room log is already a dataset). This is the cheapest eval harness available to this repo; park it for the evals dimension.
- AutoGen Studio's control-transition graph: the console's animated agent graph already covers this; adapt by adding a per-conversation filter rather than building a new view.

## What to reject and why

- Visual node-graph builders (Dify canvas, AgentKit Agent Builder, AutoGen drag-drop) as the authoring surface. AgentKit's Agent Builder is deprecated with a 2026-11-30 shutdown after about a year; Dify's DSL stores ReactFlow coordinates in config; a solo operator versioning text in git gets none of the benefit and all of the maintenance. The console edits files; files stay canonical.
- AutoGen's `provider` class-path component JSON. It couples config to implementation module paths and instantiates classes on load ("only load components from trusted sources" is a self-indictment). RFA definitions must be inert data validated by one schema, never a class locator.
- Letta-style full message-history-in-the-definition-file. Mixing state and definition makes diffs meaningless and files unshareable. RFA already persists conversation state in room NDJSON and `state/`; definitions stay state-free. (Keep .af only as a possible IMPORT source someday, not as our format.)
- CrewAI's role/goal/backstory trichotomy. It fragments the system prompt into three prose fields with no runtime meaning; one markdown body is strictly better for a Claude-based brain. Also reject its `code_execution_mode: "safe"|"unsafe"` naming (already deprecated upstream); sandboxing belongs under explicit `sandbox.isolation`.
- Server-side assistant records (LangSmith assistants) as the storage model. They require a managed control plane and API auth for what git + files do locally. Keep only the versioning DISCIPLINE (full-payload snapshots), not the service.
- A separate workbench app. Every surveyed standalone studio (AutoGen Studio "research prototype, not production", Agent Builder dead) argues for growing the existing hub-served console instead of a second frontend stack.

## Sources (URLs)

- https://docs.langchain.com/langsmith/python/managed-deep-agents-overview (MDA directory format, define_deep_agent)
- https://www.langchain.com/blog/managed-deep-agents-is-now-in-public-beta (mda CLI, folder roles)
- https://docs.langchain.com/oss/python/deepagents/overview (create_deep_agent params, middleware, backends)
- https://docs.langchain.com/oss/python/deepagents/subagents (SubAgent / CompiledSubAgent schema, task tool)
- https://docs.langchain.com/oss/python/deepagents/human-in-the-loop (interrupt_on, allowed_decisions, Command(resume=...))
- https://docs.langchain.com/oss/python/deepagents/skills and https://deepwiki.com/langchain-ai/deepagents/2.4-skills-system (skills loading, precedence)
- https://docs.langchain.com/langsmith/assistants (assistant concept, versioning)
- https://docs.langchain.com/langsmith/configuration-cloud (assistants.create/update/set_latest, full-payload rule)
- https://reference.langchain.com/python/langgraph-sdk/client (SDK assistant fields)
- https://github.com/langchain-ai/agent-inbox (HumanInterrupt/HumanResponse types, inbox UX)
- https://code.claude.com/docs/en/sub-agents (subagent frontmatter: tools, model, effort, memory, isolation, permissionMode, maxTurns)
- https://code.claude.com/docs/en/skills (skill frontmatter, substitutions, agentskills.io portable subset)
- https://docs.crewai.com/en/concepts/agents (agent attributes table, JSONC config)
- https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/serialize-components.html (component JSON, dump/load, trust warning)
- https://microsoft.github.io/autogen/dev//user-guide/autogenstudio-user-guide/index.html (Team Builder, Playground, Gallery, Deploy)
- https://github.com/yzmw123/dify-workflow-dsl-skill/blob/main/SKILL.md (Dify DSL top-level keys, node data fields)
- https://docs.dify.ai/en/learn/key-concepts (app modes, variables, publishing)
- https://github.com/letta-ai/agent-file and https://docs.letta.com/guides/core-concepts/agent-file (.af contents, import/export APIs, exclusions)
- https://docs.letta.com/guides/ade/overview (ADE three-panel workbench, Context Window Viewer)
- https://developers.openai.com/api/docs/guides/agent-builder and https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder (export to Agents SDK, deprecation, 2026-11-30 shutdown)
- https://changelog.langchain.com/announcements/new-langsmith-playground-features-to-streamline-workflow and https://docs.langchain.com/langsmith/prompt-engineering-quickstart (Playground UX: settings view, tools modal, dataset runs, comparison)
