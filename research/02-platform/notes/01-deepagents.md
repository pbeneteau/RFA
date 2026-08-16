# LangChain Deep Agents (OSS harness + Managed Deep Agents on LangSmith)

Research date: 2026-08-16. All schemas below were copied from primary sources
(docs.langchain.com pages, the langchain-ai/deepagents repo source, langchain.com blog posts).
This is the anchor inspiration for the RFA "capable residents" phase: the goal of these notes
is to extract the agent STRUCTURE that makes deep agents "pro and scalable" and map it onto
RFA residents.

## What it is

- **deepagents** is LangChain's open source "batteries-included agent harness": an opinionated
  agent that runs out of the box, built as a layer on top of `langchain.create_agent`, which
  itself runs on the LangGraph runtime. LangChain's own positioning (Deep Agents v0.2 blog):
  - deepagents = "agent harness" for autonomous, long-running complex tasks
  - langchain = "agent framework" for core loop customization
  - langgraph = "agent runtime" for workflow-agent combinations
- The concept comes from the July 2025 "Deep Agents" blog post, which reverse-engineers
  Claude Code and names **four pillars** of a deep agent:
  1. **Detailed system prompt** (long tool instructions and behavior examples; "Prompting matters still!")
  2. **Planning tool** (Claude Code's todo list, "basically a no-op", pure context engineering to keep focus)
  3. **Sub-agents** (context isolation + prompt specialization; "split up tasks")
  4. **File system** (persistent shared workspace; agents "accumulate a lot of context that they need to manage")
- **Managed Deep Agents (MDA)** is the LangSmith-hosted productization: you write a project
  directory (agent.py + instructions.md + skills/ + tools/ + connectors/ + channels/ +
  schedules/ + evals/ ...), the LangSmith Agent Server runs it. "You focus on what your agent
  does. MDA runs it. There are no servers to run and no infrastructure to wire together."
  Public beta, US region only.
- There is a **TypeScript port with feature parity**: `deepagents` on npm
  (github.com/langchain-ai/deepagentsjs), `createDeepAgent(...)`, default model is Anthropic
  Claude (claude-sonnet family), same backends/subagents/skills/memory/summarization/interrupts.

## Architecture (how it actually works)

### Everything is middleware around a plain tool loop

`create_deep_agent` compiles to a LangGraph `CompiledStateGraph`. All deep-agent behavior is
implemented as middleware layers that inject tools, inject system prompt sections, and wrap
model/tool calls. Assembly order copied from `libs/deepagents/deepagents/graph.py`:

Base stack:
1. `SkillsMiddleware` (if `skills` provided)
2. `FilesystemMiddleware`
3. `SubAgentMiddleware` (if inline subagents exist)
4. `SummarizationMiddleware`
5. `PatchToolCallsMiddleware` (repairs dangling tool calls after interruptions)
6. `AsyncSubAgentMiddleware` (if async subagents provided)

User middleware inserted here.

Tail stack:
7. Harness profile `extra_middleware`
8. `_ToolExclusionMiddleware` (if profile has `excluded_tools`)
9. Anthropic/Bedrock/Fireworks prompt caching middleware
10. `MemoryMiddleware` (if `memory` provided)
11. `HumanInTheLoopMiddleware` (if `interrupt_on` provided)

Middleware source files in the repo (`libs/deepagents/deepagents/middleware/`):
`filesystem.py`, `subagents.py`, `async_subagents.py`, `skills.py`, `memory.py`,
`summarization.py`, `patch_tool_calls.py`, `permissions.py`, `rubric.py`,
`_fs_interrupt.py`, `_message_eviction.py`, `_overflow_clip.py`, `_prompt_caching.py`,
`_tool_exclusion.py`, `_video.py`. Package also has `backends/`, `profiles/`, `_api/`.

Hook points (from langchain middleware docs): `before_model`, `after_model`,
`wrap_model_call`, `wrap_tool_call`.

### The system prompt is assembled, not written

The final system prompt = base harness prompt + per-middleware sections (todo guidance,
filesystem tool guidance, skills metadata, memory file contents, task tool guidance) +
the caller's `system_prompt` + harness profile `system_prompt_suffix` (placed last).
This is the concrete implementation of pillar 1: the "detailed system prompt" is modular
and owned by the middleware that owns each tool.

### Planning: the todo tool (pillar 2)

`TodoListMiddleware` (lives in langchain, `langchain/agents/middleware/todo.py`) injects a
`write_todos` tool plus a system prompt section. It is deliberately a no-op state write.
Todo item shape:

```python
class Todo(TypedDict):
    content: str   # "The content/description of the todo item."
    status: Literal["pending", "in_progress", "completed"]
```

Key prompt rules (verbatim excerpts):
- "For simple objectives that only require a few steps, it is better to just complete the objective directly."
- "It is critical that you mark todos as completed as soon as you are done with a step."
- "The write_todos tool should never be called multiple times in parallel."
- Tool description: use for multi-step tasks (3+ steps); "ONLY mark a task as completed when you have FULLY accomplished it".
The middleware's `after_model()` validates that `write_todos` was not called in parallel.
In deepagents it is optional (add via `middleware=[todoListMiddleware]` in JS; TodoListMiddleware in Python).

### Filesystem: pluggable backends behind one tool surface (pillar 4)

`FilesystemMiddleware` exposes eight tools regardless of storage: `ls`, `read_file`,
`write_file`, `edit_file`, `delete`, `glob`, `grep`, and `execute` (only when the backend
implements `SandboxBackendProtocol`). Storage is a pluggable backend implementing
`BackendProtocol`:

- `ls(path) -> LsResult`
- `read(file_path, offset=0, limit=2000) -> ReadResult`
- `write(file_path, content) -> WriteResult`
- `edit(file_path, old_string, new_string, replace_all=False) -> EditResult`
- `glob(pattern, path=None) -> GlobResult`
- `grep(pattern, path=None, glob=None) -> GrepResult`
- `delete(file_path) -> DeleteResult` (optional)
- `SandboxBackendProtocol` adds `execute(command)` (returns output, exit code, truncation notice)

Built-in backends (exact constructors in the schemas section):
- `StateBackend()` - default; files live in LangGraph agent state, thread-scoped via
  checkpoints, ephemeral across threads. Use: scratch pad, eviction target.
- `FilesystemBackend(root_dir, virtual_mode=False)` - real disk under a root;
  `virtual_mode=True` blocks `..`, `~`, absolute paths outside root.
- `LocalShellBackend(root_dir, virtual_mode=True, env, timeout, max_output_bytes)` - adds
  `execute` via `subprocess.run(shell=True)`; timeout default 120s, max_output_bytes 100000.
  No isolation: "Commands run directly on your host system."
- `StoreBackend(namespace, store)` - LangGraph `BaseStore`, cross-thread durable;
  `namespace` is a factory `lambda rt: (...)` returning a tuple for isolation
  (per-user `(rt.server_info.user.identity,)`, per-assistant `(rt.server_info.assistant_id,)`,
  per-thread `(rt.execution_info.thread_id,)`).
- `ContextHubBackend(repo_identifier)` - LangSmith Context Hub repo as filesystem; hub commits
  track changes; linked skill repos mount under `/skills/`.
- `CompositeBackend(default, routes)` - path-prefix router; longest prefix wins; `ls`/`glob`/
  `grep` results aggregated across backends with prefixes preserved. Canonical pattern:
  default `StateBackend()` + route `"/memories/": StoreBackend(...)`.
- Sandbox backends (pass the sandbox instance as `backend=`): LangSmith, Daytona, E2B, Modal,
  Runloop, Vercel, AgentCore. All file ops run through `execute()` inside the sandbox
  (`BaseSandbox`). Lifecycle is explicit (create/teardown), thread-scoped or assistant-scoped.
  Security note verbatim: "Never put secrets inside a sandbox."

Path-level access control: `FilesystemPermission(operations=[...], paths=[...], mode="deny"|...)`
enforced by the middleware; subagent `permissions` replace parent permissions entirely.

### Context management (offloading + summarization)

Constants copied from `middleware/filesystem.py` and the context-engineering docs:
- `tool_token_limit_before_evict` default **20000** tokens: oversized tool RESULTS are written
  to the filesystem under `/large_tool_results/` and replaced in the transcript by a reference
  plus a preview of the first 10 lines; the model can `read_file` them back.
- `human_message_token_limit_before_evict` default **50000**: oversized human messages evict to
  storage keeping head/tail previews.
- Oversized tool INPUTS (>20k tokens) get truncated to filesystem pointers when context reaches
  **85% capacity**. Eviction prefix `/conversation_history/` for history offload.
- `TOOLS_EXCLUDED_FROM_EVICTION`: ls, glob, grep, read_file, edit_file, write_file, delete.
- `NUM_CHARS_PER_TOKEN = 4` approximation; `DEFAULT_READ_LIMIT = 100` lines; `GLOB_TIMEOUT = 10.0`s;
  `grep_max_count` default 1000; `max_execute_timeout` default 3600s.
- `SummarizationMiddleware`: triggers at **85% of the model's max_input_tokens**; keeps ~10% of
  tokens as recent context; fallback when model profile unknown: trigger at 170000 tokens keep
  6 messages; on `ContextOverflowError` it summarizes immediately and retries.
- On-demand compaction tool: `create_summarization_tool_middleware(model, StateBackend)` adds a
  `compact_conversation` tool.
- Summarization tokens are tagged in streams with `metadata["lc_source"] == "summarization"`.
- Prompt caching middleware for Anthropic/Bedrock is applied automatically in the tail stack.

### Subagents (pillar 3)

`SubAgentMiddleware` builds a `task` tool ("Launch an ephemeral subagent to handle a complex,
multi-step task in an isolated context window"), with input schema `TaskToolSchema`
(fields: `description`, `subagent_type`). The parent receives only the subagent's final
message (or JSON if `response_format` set), which is the fix for "context bloat".
Every deep agent ships a default `general-purpose` subagent (filesystem tools, inherits parent
skills); override by passing your own with `name="general-purpose"`, or disable via the harness
profile (`general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False)`).
Custom subagents inherit NOTHING implicitly except runtime context: no parent system prompt,
no parent middleware, no parent skills (must pass `skills=`), tools inherited only if omitted.
Runtime context propagates to all subagents; convention of namespaced keys like
`researcher:max_depth` for per-subagent config. `CompiledSubAgent(name, description, runnable)`
wraps any LangGraph graph (must expose a "messages" state key). With `CodeInterpreterMiddleware`
the agent can dispatch subagents programmatically (fan-out loops). Observability: every run is
tagged `lc_agent_name`; `stream_events()` exposes `stream.subagents`.

### Skills (progressive disclosure)

Implements the agentskills.io spec (same as Anthropic/Claude Code skills). `SkillsMiddleware`:
- Level 1 at startup: only frontmatter `name` + `description` go into the system prompt.
- Level 2 on activation: full `SKILL.md` body is read via `read_file`.
- Level 3 on demand: referenced resources (`scripts/`, `references/`, `assets/`) load as needed;
  scripts require a sandbox backend to execute.
Frontmatter: `name` (lowercase alnum + hyphens, 1-64 chars, matches parent dir), `description`
(max 1024 chars), optional `license`, `compatibility`, `metadata`, `allowed-tools`.
Recommended: SKILL.md under 5000 tokens; later skill sources override earlier ones on name clash.

### Memory

- `memory=["/project/AGENTS.md", "~/.deepagents/preferences.md"]` - files loaded into the
  system prompt at startup (hot memory). Skills are the on-demand counterpart (procedural memory).
- Long-term memory = CompositeBackend routing `/memories/` to a durable StoreBackend, plus a
  system prompt instruction telling the agent when to save (for example "When users tell you
  their preferences, save them to /memories/user_preferences.txt").
- The agent updates memory itself with `write_file`/`edit_file`; enforcement via permissions
  (read-only routes for shared policies) or backend policy hooks.
- MDA adds an explicit hot/cold split: `/memories/agent/AGENTS.md` is hot (always loaded),
  everything else under `/memories/agent/` is cold (read on demand). Writes outside that tree
  are not durable. Security guidance: never store personal data or credentials in shared memory.

### Human-in-the-loop

`interrupt_on` maps tool name -> `True` | `False` | `InterruptOnConfig`
(`allowed_decisions` list + optional `when` predicate on `ToolCallRequest`).
Four decisions: `approve` (run as-is), `edit` (modify args), `reject` (skip + feedback),
`respond` (human message becomes the synthetic tool result; for ask-user tools).
Checkpointer is mandatory; resume with `Command(resume={"decisions": [...]})` on the same
thread_id. Subagents can override parent `interrupt_on` and call `interrupt()` inside tools.

### Harness profiles (per-model/per-deployment tuning without code changes)

`HarnessProfile` fields: `base_system_prompt` (replace base prompt), `system_prompt_suffix`
(appended last), `tool_description_overrides: Mapping[str, str]`, `excluded_tools: frozenset[str]`,
`excluded_middleware: frozenset`, `extra_middleware`, `general_purpose_subagent`
(disable/rename/re-prompt). Declarable as YAML.

### Managed Deep Agents (what "managed" adds)

- **Runtime**: LangSmith Agent Server hosts the agent, maintains sessions/threads across
  restarts, provides auth, tracing, observability, hosted execution. Local loop: `mda dev .`;
  deploy: `mda deploy .` (packages the project). Studio UI for chatting with the agent and
  inspecting execution traces.
- **Project = directory convention** (full layout in schemas section). Only `agent.py` is
  required; it must export a named `agent` created with `define_deep_agent`. Everything else is
  a capability you enable by adding a file: `memory.py`, `identity.py`, `channels/<name>.py`,
  `schedules/<name>.py`, `sandbox/__init__.py`, `connectors/mcp.py`, `skills/<name>/SKILL.md`,
  `evals/tasks/...`.
- **Versioning without redeploy**: `instructions.md` and `skills/` sync to Context Hub; prompt
  and skill updates take effect without redeploying the build. `.env` never deploys; `evals/`
  excluded from the build.
- **Channels**: one file per channel; module-level `channel` export; filename = channel name;
  events arrive at `POST /channels/<name>/events`. Slack is the documented provider (mentions,
  DMs, thread replies). Flow: verify + normalize provider event -> resolve user identity and
  conversation thread -> run agent -> post response back. Channel runs expose `runtime.channel`
  (normalized event, conversation address, post/update methods) to tools and middleware.
- **Schedules**: `schedules/<name>.py`, recurring cron execution.
- **Identity**: `identity.py` enables multi-user thread/credential isolation.
- **Memory enabler**: `memory.py` with `memory = define_memory(scope="agent")`
  (scopes: "agent" or "none"); backed by Context Hub at `/memories/agent/`.
- **Evals**: Harbor-format tasks in `evals/tasks/<task>/` with `instruction.md`, `task.toml`,
  `environment/Dockerfile`, `tests/test.sh`; verifier writes a numeric reward to
  `/logs/verifier/reward.txt` or metrics to `/logs/verifier/reward.json`. Scaffold flow:
  `mda evals init <name>` (creates `instruction.md` + `tests/test_answer.py` under
  `evals/scaffold/`), `mda evals compile .` (emits canonical Harbor tasks + `harbor-job.json`),
  run via `harbor run --config evals/harbor-job.json`.

## Exact schemas and APIs (copied)

### create_deep_agent (Python, from graph.py)

```python
def create_deep_agent(
    model: str | BaseChatModel | None = None,
    tools: Sequence[BaseTool | Callable | dict[str, Any]] | None = None,
    *,
    system_prompt: str | SystemMessage | None = None,
    middleware: Sequence[AgentMiddleware[StateT_co, ContextT]] = (),
    subagents: Sequence[SubAgent | CompiledSubAgent | AsyncSubAgent] | None = None,
    skills: list[str] | None = None,
    memory: list[str] | None = None,
    permissions: list[FilesystemPermission] | None = None,
    backend: BackendProtocol | None = None,
    interrupt_on: dict[str, bool | InterruptOnConfig] | None = None,
    response_format: ResponseFormat[ResponseT] | type[ResponseT] | dict[str, Any] | None = None,
    state_schema: type[DeepAgentState] | None = None,
    context_schema: type[ContextT] | None = None,
    checkpointer: Checkpointer | None = None,
    store: BaseStore | None = None,
    debug: bool = False,
    name: str | None = None,
    cache: BaseCache | None = None,
) -> CompiledStateGraph[AgentState[ResponseT], ContextT, InputAgentState, OutputAgentState[ResponseT]]
```

### SubAgent definition shape

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | Unique id; used by the `task()` tool |
| `description` | string | yes | Action-oriented; guides delegation |
| `system_prompt` | string | yes | Does NOT inherit from parent |
| `tools` | list[Callable] | no | Overrides inherited tools when set |
| `model` | string or BaseChatModel | no | Defaults to main agent's model |
| `middleware` | list[Middleware] | no | No inheritance from parent |
| `interrupt_on` | dict | no | Per-tool HITL config |
| `skills` | list[string] | no | Isolated; no parent inheritance |
| `response_format` | ResponseFormat | no | JSON returned to parent |
| `permissions` | list[FilesystemPermission] | no | Replaces parent permissions entirely |

`CompiledSubAgent(name="...", description="...", runnable=compiled_graph)` (graph must have a
"messages" state key). `TaskToolSchema` fields: `description`, `subagent_type`.

### Backends

```python
StateBackend()
FilesystemBackend(root_dir="/path/to/project", virtual_mode=True)
LocalShellBackend(root_dir=".", virtual_mode=True, env={"PATH": "/usr/bin:/bin"})  # + timeout, max_output_bytes
StoreBackend(namespace=lambda rt: (rt.server_info.user.identity,))                 # + store
ContextHubBackend("my-agent")
CompositeBackend(
    default=StateBackend(),
    routes={"/memories/": StoreBackend(namespace=lambda rt: ("memories",))},
)
```

### FilesystemMiddleware options

```python
FilesystemMiddleware(
    backend=...,                                  # default StateBackend
    tool_token_limit_before_evict=20000,
    human_message_token_limit_before_evict=50000,
    max_execute_timeout=3600,
    grep_max_count=1000,
    tools="all",                                  # or allowlist
)
```

### Permissions

```python
FilesystemPermission(operations=["write"], paths=["/policies/**"], mode="deny")
```

### interrupt_on and resume

```python
interrupt_on={
    "remove_file": True,
    "fetch_file": False,
    "notify_email": {"allowed_decisions": ["approve", "reject"]},
    "write_file": {
        "allowed_decisions": ["approve", "edit", "reject"],
        "when": writes_outside_workspace,   # (req: ToolCallRequest) -> bool
    },
}
# resume:
result = agent.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config=config)
```

### Todo tool

```python
class Todo(TypedDict):
    content: str
    status: Literal["pending", "in_progress", "completed"]
```

### Skill frontmatter

```yaml
---
name: arxiv-search           # lowercase alnum + hyphens, 1-64 chars, = parent dir name
description: Search arXiv for research papers when users ask about academic literature  # <=1024 chars
---
```

### Memory + long-term memory pattern

```python
agent = create_deep_agent(
    model="anthropic:claude-sonnet-4-6",
    memory=["/project/AGENTS.md", "~/.deepagents/preferences.md"],
    store=store,
    backend=CompositeBackend(
        default=StateBackend(),
        routes={"/memories/": StoreBackend(namespace=lambda _rt: ("memories",))},
    ),
    system_prompt="""When users tell you their preferences, save them to
    /memories/user_preferences.txt so you remember them in future conversations.""",
)
```

### HarnessProfile (YAML form)

```yaml
base_system_prompt: You are helpful.
system_prompt_suffix: Respond briefly.
tool_description_overrides: {}
excluded_tools: [execute, grep]
excluded_middleware: [SummarizationMiddleware, my_pkg.middleware:TelemetryMiddleware]
general_purpose_subagent:
  enabled: false
```

### TypeScript port (deepagentsjs)

```ts
import { createDeepAgent } from "deepagents";   // npm i deepagents langchain @langchain/core
const agent = await createDeepAgent({
  tools: [getWeather],
  systemPrompt: "You are a helpful assistant",
  // model?: "anthropic:claude-sonnet-4-6" (default is Anthropic claude-sonnet),
  // middleware?, memory?, permissions?, interrupt_on?, subagents?
});
```
Planning requires `import { todoListMiddleware } from "langchain"` in `middleware`.
Types: `DeepAgent`, `CreateDeepAgentParams`, `MergedDeepAgentState`.

### Managed Deep Agents

```python
# agent.py (the only required file; must export a named `agent`)
from managed_deepagents import define_deep_agent
agent = define_deep_agent(
    name="research-assistant",     # sets agent + default deployment name
    model="openai:gpt-5.5",
    tools=[internet_search],       # or built-ins like [{"type": "web_search"}]
    middleware=[log_tool_calls],
    # subagents=[], permissions=[], interrupt_on=[], response_format=None
)
# system prompt, skills, memory, sandbox, identity, channels, schedules
# are configured through project FILES, not this call.
```

```python
# connectors/mcp.py
from managed_deepagents import connectors
connector = connectors.mcp(mcp_servers={
    "langchainDocs": {
        "transport": "http",
        "url": "https://docs.langchain.com/mcp",
        "include_tools": ["search_docs_by_lang_chain"],
    },
})
```

```python
# memory.py
from managed_deepagents import define_memory
memory = define_memory(scope="agent")    # "agent" | "none"
```

Project layout:

```
my-agent/
  agent.py            # required; exports `agent`
  instructions.md     # system prompt; synced to Context Hub (update w/o redeploy)
  skills/<name>/SKILL.md
  tools/              # custom tool modules
  middleware/         # custom middleware
  connectors/mcp.py   # module-level `connector`
  channels/<name>.py  # module-level `channel`; POST /channels/<name>/events
  schedules/<name>.py # cron runs
  sandbox/__init__.py
  identity.py         # multi-user thread/credential isolation
  memory.py           # define_memory(...)
  pyproject.toml
  .env                # local only, never deployed
  evals/
    tasks/<task>/{instruction.md, task.toml, environment/Dockerfile, tests/test.sh}
    scaffold/         # mda evals init <name>; compile with `mda evals compile .`
```

CLI: `uv tool install managed-deepagents`; `mda init <name>`; `mda dev .`; `mda deploy .`;
`mda evals init <name>`; `mda evals compile .`.
Eval scoring: verifier writes reward to `/logs/verifier/reward.txt` or `/logs/verifier/reward.json`.

## What to adopt for RFA

RFA residents run as `claude -p` / Agent SDK sessions, which means Claude Code ALREADY ships
three of the four pillars natively (todo tool, Task subagents, real filesystem, skills,
compaction). So the adoption is not "embed the deepagents harness"; it is "adopt its
STRUCTURE as the resident definition format and the runtime conventions". Concretely:

1. **Adopt the MDA project-directory convention as the RFA "resident pack" format.** One
   directory per resident: `resident.json` (or `agent.ts`) manifest + `instructions.md` +
   `skills/<name>/SKILL.md` + `memory/` + `schedules/` + `evals/`. Only the manifest is
   required; every other capability is enabled by adding a file. This is the single highest
   value idea: capabilities-as-files, declarative, git-versionable, zero infra.
2. **Adopt the SubAgent field shape as the resident manifest core**: `name`, `description`
   (action-oriented, drives delegation), `system_prompt` (instructions.md), `tools`
   (MCP servers + allowlist), `model`, `skills`, `permissions`, `interrupt_on`,
   `response_format`. This maps 1:1 onto per-agent settings Paul wants (model/effort per
   resident) and extends the existing RFA capability card: the card's capability list should
   be generated from the manifest, and the manifest's `description` is exactly what room
   discovery needs.
3. **Adopt CompositeBackend path routing as directory conventions on the real Mac fs.**
   Per resident: `/workspace/` (ephemeral, wiped per task or per lease), `/memories/`
   (durable, agent-editable), plus a read-only knowledge mount (the existing dogfood
   knowledge pack). Implement as plain directories + a permission map, not a virtual fs.
4. **Adopt the hot/cold memory split verbatim**: `memories/AGENTS.md` is hot (injected into
   every session via the pack loader), everything else in `memories/` is cold (read on
   demand). The agent edits its own memory with file tools; RFA's existing memory-gate
   (ingestion defenses, hub 0.6.0) becomes the write-path validator, exactly like deepagents'
   "backend policy hooks" and read-only permission routes.
5. **Adopt the context-hygiene numbers in the RoomMember SDK**: offload any room payload or
   tool result above ~20k tokens to a file and pass a reference + first-10-lines preview in
   the envelope; never inline large content into a resident's prompt. Add a
   `large_payloads/` convention in the resident workspace mirroring `/large_tool_results/`.
6. **Adopt interrupt_on-style HITL as a first-class manifest field**: per-tool
   `true | false | {allowed_decisions: [approve, edit, reject, respond], when: predicate}`.
   Wire the pause/resume through the room itself: an interrupt becomes a task-board entry
   addressed to the human principal (RFA already has human principals + moderation), and the
   decision message resumes the resident. The four decision types are worth copying exactly.
7. **Adopt the channels flow as the formal spec for room-driven runs**: verify + normalize
   event -> resolve principal + thread -> run agent -> post back to the same thread; expose a
   `runtime.channel`-equivalent (room id, envelope, reply handle) to resident tools. RFA rooms
   are the channel; this gives the resident engine a clean, testable seam.
8. **Adopt Harbor's eval convention, minus Docker**: per-resident `evals/tasks/<task>/` with
   `instruction.md` + a verifier script that writes a numeric reward to a well-known file
   (`reward.txt`/`reward.json`). Run tasks through the room against the live resident; the
   reward-file contract makes scoring runner-agnostic and trivially scriptable in TS.
9. **Adopt versioning-without-redeploy**: instructions and skills live in git (the pack dir);
   residents reload the pack at lease renewal, so a prompt edit propagates without killing
   the process. This is MDA's Context Hub sync, replaced by git + the existing lease cycle.
10. **Adopt harness profiles as per-resident runtime settings**: a `profile` block in the
    manifest with `system_prompt_suffix`, `excluded_tools`, `tool_description_overrides`,
    model/effort defaults. Cheap to implement (flags to `claude -p` / Agent SDK options) and
    it is exactly the "per-agent settings" requirement.

## What to adapt

- **Subagents: two-level split instead of one.** Inside a resident, use Claude Code's native
  Task subagents (already isolated-context, already ephemeral). Across residents, delegation
  goes through the RFA task board / ask-serve, addressed by capability. Copy deepagents'
  contract for the second level: the delegator gets ONE final report (optionally
  `response_format`-typed JSON), never the peer's intermediate transcript. That contract is
  the anti-context-bloat mechanism and it should be a spec-level rule for RFA task results.
- **StateBackend/checkpointers -> per-task scratch dirs + session resume.** RFA has no
  LangGraph state; the equivalent is a scratch dir per task plus `claude -p` session ids
  (or Agent SDK resume) for thread continuity. Keep the concept (thread-scoped ephemeral
  space, durable space separate); drop the implementation.
- **The managed runtime -> a small TS supervisor.** MDA's Agent Server maps onto the missing
  RFA "agent engine": a process that owns resident lifecycles (spawn `claude -p` / Agent SDK
  session, renew hub leases, restart on crash, route room events per the channels flow, run
  schedules via cron/launchd). Sessions-across-restarts = persist session ids + workspace.
- **Sandboxes -> tiered, local.** No cloud sandbox providers. Tier 0: Claude Code permission
  modes + `FilesystemPermission`-style path rules (deny writes outside workspace). Tier 1:
  macOS sandbox-exec or a container for residents that run arbitrary shell. Keep deepagents'
  rule that `execute` only exists when the backend/tier supports it, and the "never put
  secrets inside a sandbox" rule (secrets stay in the supervisor, injected per call).
- **Identity -> RFA principals.** MDA identity (multi-user credential isolation) collapses to
  the existing principal model for a solo operator; keep per-resident identity and per-room
  ACLs, skip per-user credential vaulting until a second human shows up.
- **Skills param semantics**: adopt agentskills.io SKILL.md (already Claude Code compatible),
  including the "last source wins" override rule (room-shared skills dir overridden by
  resident-local skills), but let Claude Code do the progressive disclosure instead of
  reimplementing SkillsMiddleware.
- **Summarization**: Claude Code auto-compacts, so do not rebuild SummarizationMiddleware; DO
  adopt the on-demand `compact_conversation` idea as a supervisor action (force-compact a
  long-lived resident between tasks) and the 85%-trigger mindset for monitoring resident
  context health via OTel spans.

## What to reject and why

- **Taking deepagents (Python or JS) as a dependency.** Even though deepagentsjs has feature
  parity and TS types, it drags in langchain + LangGraph as peer deps and re-implements what
  Claude Code already provides under `claude -p`: todos, Task subagents, skills, memory files,
  compaction, prompt caching. Running deepagents inside a Claude Code session would be a
  harness inside a harness. Steal the shapes, not the package.
- **LangSmith managed runtime, Context Hub, and Studio.** Cloud-hosted, US-region public beta,
  account-coupled; violates local-first. Git + the hub console + OTel already cover
  versioning, UI, and tracing needs at this scale.
- **The virtual filesystem (StateBackend) as default.** It exists because LangGraph deployments
  have no durable disk. RFA runs on a real Mac; real directories with permission rules are
  simpler, inspectable, and already what Claude Code expects.
- **Provider-agnostic model strings and model profiles.** RFA is Claude-only via the owner's
  existing auth; the abstraction buys nothing and complicates per-resident settings.
- **Docker-based Harbor eval environments.** One Mac, solo operator; containerized per-task
  environments are too heavy. Keep the task/verifier/reward-file convention; run verifiers as
  plain scripts against the resident's workspace.
- **CodeInterpreterMiddleware-style dynamic subagent fan-out (for now).** Programmatic fan-out
  of ephemeral agents from generated code is a cost and safety amplifier with no current RFA
  use case; room-level task delegation covers multi-agent workflows with better observability.

## Sources (URLs)

- https://docs.langchain.com/langsmith/python/managed-deep-agents-overview
- https://docs.langchain.com/langsmith/python/managed-deep-agents-quickstart
- https://docs.langchain.com/langsmith/python/managed-deep-agents-project-structure
- https://docs.langchain.com/langsmith/python/managed-deep-agents-agent-definition
- https://docs.langchain.com/langsmith/python/managed-deep-agents-channels
- https://docs.langchain.com/langsmith/python/managed-deep-agents-schedules (via project-structure/overview)
- https://docs.langchain.com/langsmith/python/managed-deep-agents-evals
- https://docs.langchain.com/langsmith/python/managed-deep-agents-memory
- https://docs.langchain.com/oss/python/deepagents/overview
- https://docs.langchain.com/oss/python/deepagents/subagents
- https://docs.langchain.com/oss/python/deepagents/backends
- https://docs.langchain.com/oss/python/deepagents/memory
- https://docs.langchain.com/oss/python/deepagents/skills
- https://docs.langchain.com/oss/python/deepagents/context-engineering
- https://docs.langchain.com/oss/python/deepagents/human-in-the-loop
- https://docs.langchain.com/oss/python/deepagents/sandboxes
- https://docs.langchain.com/oss/python/deepagents/profiles
- https://docs.langchain.com/oss/javascript/deepagents/overview
- https://github.com/langchain-ai/deepagents (README + source)
- https://raw.githubusercontent.com/langchain-ai/deepagents/main/libs/deepagents/deepagents/graph.py
- https://raw.githubusercontent.com/langchain-ai/deepagents/main/libs/deepagents/deepagents/middleware/subagents.py
- https://raw.githubusercontent.com/langchain-ai/deepagents/main/libs/deepagents/deepagents/middleware/filesystem.py
- https://raw.githubusercontent.com/langchain-ai/langchain/master/libs/langchain_v1/langchain/agents/middleware/todo.py
- https://www.langchain.com/blog/deep-agents
- https://www.langchain.com/blog/doubling-down-on-deepagents
- https://github.com/langchain-ai/deepagentsjs
- https://www.npmjs.com/package/deepagents
- https://reference.langchain.com/javascript/deepagents
- https://agentskills.io/specification (referenced by skills docs)
