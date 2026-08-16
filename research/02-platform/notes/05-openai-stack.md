# OpenAI Agent Stack: Agents SDK, AgentKit, and What They Killed

Research date: 2026-08-16 (updated with post-June-2026 deprecation facts).
Dimension: openai-stack. For RFA v0.4 design input.

## What it is

The OpenAI agent stack, as of mid-2026, has consolidated into two surviving layers
and a graveyard of deprecated ones:

Surviving:
- **Agents SDK** (Python `openai-agents`, TypeScript `@openai/agents`): a lightweight,
  code-first orchestration library. Core primitives: Agent, Handoff, Guardrail, Session,
  Tool, Runner, Tracing. Provider-agnostic (any model behind a `Model` interface).
  This is the layer OpenAI now tells everyone to build on.
- **Responses API + Conversations API**: the model/serving substrate that replaced
  the Assistants API.
- **ChatKit**: embeddable chat frontend (hosted or self-hosted server SDK). Explicitly
  kept alive while the rest of AgentKit's hosted surface dies.
- **Temporal integration** (Python GA 2026-03-23, TypeScript public preview): durable
  execution wrapper around the Agents SDK for production reliability.

Deprecated or dying (exact dates from the official deprecations page):
- **Assistants API**: announced 2025-08-26, shuts down 2026-08-26. Replaced by
  Responses + Conversations.
- **Agent Builder** (the AgentKit visual canvas, launched Oct 2025): deprecation
  announced 2026-06-03, workflows stop functioning 2026-11-30. Recommended
  replacement: "Agents SDK or ChatGPT Workspace Agents". Launched-to-killed in
  about 13 months, deprecated after 8.
- **Evals Platform** (hosted dashboard/API): read-only 2026-10-31, shutdown
  2026-11-30. Migration guide points at Promptfoo (open source, local).
- **Reusable Prompts** (`v1/prompts`): announced 2026-06-03, shutdown 2026-11-30.
  Recommendation: "migrate reusable prompt content into your application code".

The macro-lesson is unambiguous and directly relevant to RFA: every hosted-config
product (server-side agent objects, visual workflow builder, hosted prompt store,
hosted evals) was killed within roughly a year; the code-first SDK, the raw model API,
the embeddable UI kit, and the durable-execution integration survived. Agent
definitions as code/files outlive agent definitions as platform state.

## Architecture (how it actually works)

### The Agents SDK runner loop

`Runner.run(agent, input, session=..., run_config=...)` executes this loop:
1. Call the LLM for the current agent with current input.
2. Process output:
   - Final output (matches `output_type`, or plain text with no tool calls): loop ends.
   - Handoff requested: switch current agent, optionally filter history, re-run loop.
   - Tool calls: execute tools, append results, re-run loop.
3. Raise `MaxTurnsExceeded` if `max_turns` is hit.

Three entry points: `Runner.run()` (async), `Runner.run_sync()`, `Runner.run_streamed()`
(returns `RunResultStreaming` with an event stream). TS equivalent: `run(agent, input)`
and `{ stream: true }`.

### Handoffs are tools

A handoff is exposed to the model as a plain tool call named
`transfer_to_<agent_name>`. When the model calls it, the runner swaps the active
agent and (by default) hands over the full conversation history. Two orthogonal knobs:
- `input_type` / `inputType`: a schema for structured metadata the LLM attaches to the
  handoff call (reason, priority, language). This payload goes to the `on_handoff`
  callback, not into the next agent's conversation.
- `input_filter` / `inputFilter`: a function that rewrites the history the receiving
  agent sees (`HandoffInputData` in, `HandoffInputData` out). Common filters ship in
  `agents.extensions.handoff_filters` (e.g. remove_all_tools).

Important documented constraint: server-managed conversations (`conversation_id`,
`previous_response_id`) do NOT support handoff input filters and auto-disable nested
handoff history. Owning the transcript client-side preserves composability; delegating
it to the vendor removes it. Strong argument for the RFA hub continuing to own
transcripts.

The SDK also ships `RECOMMENDED_PROMPT_PREFIX` (from
`agents.extensions.handoff_prompt`, TS `@openai/agents-core/extensions`): a standard
system-prompt preamble that explains the handoff system to the model, which measurably
improves handoff reliability.

### Agent-as-tool vs handoff (two composition modes)

`Agent.as_tool()` is explicitly documented as different from handoff in two ways:
1. Handoff: the new agent receives the conversation history. As-tool: the new agent
   receives generated input (the tool call arguments).
2. Handoff: the new agent takes over the conversation. As-tool: the caller keeps the
   conversation and treats the other agent as a subroutine.

RFA's ask/serve is the as-tool mode. RFA currently has no handoff mode (conversation
transfer with history). Both modes are worth having; they solve different problems.

### Guardrails

Guardrails are named check functions attached to agents (not to the runner), returning
`GuardrailFunctionOutput { output_info, tripwire_triggered }`. Semantics:
- Input guardrails run only for the FIRST agent in a chain; output guardrails only for
  the LAST agent producing final output. Tool guardrails wrap individual tools and run
  every invocation.
- Input guardrails have two modes: parallel (default, races the agent, lower latency,
  may burn tokens before cancel) and blocking (`run_in_parallel=False`, agent never
  starts if tripped, no side effects).
- Tripwire fires a typed exception: `InputGuardrailTripwireTriggered`,
  `OutputGuardrailTripwireTriggered`, `ToolInputGuardrailTripwireTriggered`,
  `ToolOutputGuardrailTripwireTriggered`. The exception carries `guardrail_result`
  naming which guardrail fired.

### Sessions (memory)

Memory is a 4-method protocol, not a framework: `get_items(limit)`, `add_items(items)`,
`pop_item()`, `clear_session()`. The runner auto-prepends history before each turn and
persists new items after. Implementations: `SQLiteSession` (default, file or memory),
`SQLAlchemySession`, `OpenAIConversationsSession` (server-side), `EncryptedSession`
(wrapper adding encryption + TTL over any backend). `pop_item` exists specifically for
correction flows (undo last user message and retry). History limiting via
`RunConfig.session_settings=SessionSettings(limit=50)`; merge policy via
`RunConfig.session_input_callback`.

### Tracing

Built-in, on by default, exportable. A Trace is one workflow run:
`{ workflow_name, trace_id, group_id, metadata, disabled }`. `group_id` links multiple
traces of one logical conversation (RFA equivalent: room/thread id). Spans have
`started_at, ended_at, trace_id, parent_id, span_data`. Default span taxonomy (exact
names): `task_span`, `turn_span`, `agent_span`, `generation_span`, `function_span`,
`guardrail_span`, `handoff_span`, `transcription_span`, `speech_span`.
Processor API: `add_trace_processor()` (append) vs `set_trace_processors()` (replace).
Sensitive-data control is a first-class flag: `RunConfig.trace_include_sensitive_data`
gates whether LLM/tool inputs and outputs are captured. 20+ third-party processors
(Langfuse, LangSmith, Logfire, Braintrust, MLflow, AgentOps, Datadog...).

### Temporal integration (durability)

Pattern: agent orchestration runs inside a Temporal workflow (deterministic, replayable);
every model invocation and side-effecting tool call runs as a Temporal activity
(retryable, timeout-managed, journaled). The `OpenAIAgentsPlugin` auto-routes model
calls through activities and handles Pydantic serialization plus trace propagation.
Tool placement rule:
- `activity_as_tool(fn, start_to_close_timeout=...)`: external I/O, durable, retried.
- `@function_tool` inside the workflow: pure deterministic computation only.
- Hosted tools: run provider-side.
Workflow code must be deterministic (no direct network/db/random/clock). TS variant:
`@temporalio/openai-agents` (worker/client) + `@temporalio/openai-agents/workflow`
(workflow code); streaming model activities publish events to a Workflow Stream topic
so an external client can watch a run live while it stays durable.

### AgentKit (the parts that mattered)

- Agent Builder: drag-and-drop canvas of typed nodes wired into workflows, autosave,
  publish-as-major-version snapshots, preview runs with per-node execution view,
  inline evals ("Evaluate" runs trace graders on selected traces), and code export
  (TS or Python Agents SDK code). Now deprecated; the export path is the escape hatch.
- Node vocabulary (from the node reference, exact names): Start (exposes
  `input_as_text`), Agent, End, Note, File search, Guardrails (PII, jailbreak,
  hallucination, moderation; pass/fail on a previous node's output), MCP (connectors or
  custom servers), If/else (CEL expressions), While (CEL), Human approval, Transform
  (reshape outputs to a schema), Set state (workflow-global variables).
- ChatKit: embeddable chat UI. Hosted flow: server POSTs
  `https://api.openai.com/v1/chatkit/sessions` with `{ workflow: { id }, user }`,
  gets a `client_secret`, frontend script `chatkit.js` renders the chat. Self-hosted
  flow: ChatKit server SDK (Python) backing the same UI with your own agent runtime.
- Connector Registry: org-admin-managed registry of data/tool connectors (Drive,
  SharePoint, Slack, MCP servers) shared across products. The governance idea:
  connectors are approved centrally, agents reference them by name.
- Evals: datasets (build from scratch, extend with automated graders + human
  annotations), trace grading (run graders over end-to-end traces, not just IO pairs),
  automated prompt optimization (graders' feedback rewrites prompts), third-party model
  support. The hosted platform dies 2026-11-30; the grader config shapes (below) remain
  the transferable artifact, and OpenAI's own migration guide points to Promptfoo.

## Exact schemas and APIs (copied)

### Agent dataclass (Python, copied from src/agents/agent.py)

AgentBase fields:

```python
name: str
handoff_description: str | None = None
tools: list[Tool] = field(default_factory=list)
mcp_servers: list[MCPServer] = field(default_factory=list)
mcp_config: MCPConfig = field(default_factory=lambda: MCPConfig())
```

Agent(AgentBase) fields:

```python
instructions: (
    str
    | Callable[
        [RunContextWrapper[TContext], Agent[TContext]],
        MaybeAwaitable[str],
    ]
    | None
) = None
prompt: Prompt | DynamicPromptFunction | None = None
handoffs: list[Agent[Any] | Handoff[TContext, Any]] = field(default_factory=list)
model: str | Model | None = None
model_settings: ModelSettings = field(default_factory=get_default_model_settings)
input_guardrails: list[InputGuardrail[TContext]] = field(default_factory=list)
output_guardrails: list[OutputGuardrail[TContext]] = field(default_factory=list)
output_type: type[Any] | AgentOutputSchemaBase | None = None
hooks: AgentHooks[TContext] | None = None
tool_use_behavior: (
    Literal["run_llm_again", "stop_on_first_tool"] | StopAtTools | ToolsToFinalOutputFunction
) = "run_llm_again"
reset_tool_choice: bool = True
```

Supporting types:

```python
class StopAtTools(TypedDict):
    stop_at_tool_names: list[str]

class MCPConfig(TypedDict):
    convert_schemas_to_strict: NotRequired[bool]        # default False
    failure_error_function: NotRequired[ToolErrorFunction | None]
    include_server_in_tool_names: NotRequired[bool]     # server-prefixed public names

@dataclass
class ToolsToFinalOutputResult:
    is_final_output: bool
    final_output: Any | None
```

TypeScript equivalents (camelCase, from the agents guide): `name` (required),
`instructions` (required, string or function of RunContext), `model`, `modelSettings`,
`tools`, `outputType` (Zod schema, Standard Schema, or JSON Schema), `handoffs`,
`handoffDescription`, `inputGuardrails`, `outputGuardrails`, `toolUseBehavior`
(`'run_llm_again' | 'stop_on_first_tool' | custom`), `resetToolChoice`. Agents are
generic on `Agent<TContext, TOutput>`. `agent.clone({...})` copies with overrides.

### ModelSettings fields (Python, copied from src/agents/model_settings.py)

```python
temperature: float | None = None
top_p: float | None = None
frequency_penalty: float | None = None
presence_penalty: float | None = None
tool_choice: ToolChoice | None = None
parallel_tool_calls: bool | None = None
truncation: Literal["auto", "disabled"] | None = None
max_tokens: int | None = None
reasoning: Reasoning | None = None
verbosity: Literal["low", "medium", "high"] | None = None
metadata: dict[str, str] | None = None
store: bool | None = None
prompt_cache_retention: Literal["in_memory", "24h"] | None = None
include_usage: bool | None = None
response_include: list[ResponseIncludable | str] | None = None
top_logprobs: int | None = None
extra_query: Query | None = None
extra_body: Body | None = None
extra_headers: Headers | None = None
extra_args: dict[str, Any] | None = None
retry: ModelRetrySettings | None = None
context_management: list[ContextManagement] | None = None
prompt_cache_options: PromptCacheOptions | None = None
preserve_raw_usage: bool | None = None
timeout: Annotated[FiniteFloat, Field(gt=0)] | None = None
```

Note `reasoning` + `verbosity` + `retry` + `context_management` + `timeout`: this is
the exact "per-agent settings" surface Paul wants (model/effort per agent).

### Handoff dataclass (Python, copied verbatim from src/agents/handoffs)

```python
@dataclass(frozen=True)
class HandoffInputData:
    input_history: str | tuple[TResponseInputItem, ...]
    pre_handoff_items: tuple[RunItem, ...]
    new_items: tuple[RunItem, ...]
    run_context: RunContextWrapper[Any] | None = None
    input_items: tuple[RunItem, ...] | None = None   # filtered model input; new_items kept for session history

HandoffInputFilter: TypeAlias = Callable[[HandoffInputData], MaybeAwaitable[HandoffInputData]]

@dataclass
class Handoff(Generic[TContext, TAgent]):
    tool_name: str
    tool_description: str
    input_json_schema: dict[str, Any]      # exposed to the model as the handoff tool's parameters
    on_invoke_handoff: Callable[[RunContextWrapper[Any], str], Awaitable[TAgent]]
    agent_name: str
    input_filter: HandoffInputFilter | None = None
    nest_handoff_history: bool | None = None
    strict_json_schema: bool = True
    is_enabled: bool | Callable[[RunContextWrapper[Any], AgentBase[Any]], MaybeAwaitable[bool]] = True

    @classmethod
    def default_tool_name(cls, agent) -> str:
        return transform_string_function_style(f"transfer_to_{agent.name}")

    @classmethod
    def default_tool_description(cls, agent) -> str:
        return (
            f"Handoff to the {agent.name} agent to handle the request. "
            f"{agent.handoff_description or ''}"
        )
```

`handoff()` helper signature (union of overloads):

```python
def handoff(
    agent: Agent[TContext],
    *,
    tool_name_override: str | None = None,
    tool_description_override: str | None = None,
    on_handoff: OnHandoffWithInput[THandoffInput] | OnHandoffWithoutInput | None = None,
    input_type: type[THandoffInput] | None = None,
    input_filter: Callable[[HandoffInputData], HandoffInputData] | None = None,
    nest_handoff_history: bool | None = None,
    is_enabled: bool | Callable[..., MaybeAwaitable[bool]] = True,
) -> Handoff
```

TS mirror: `handoff(agent, { toolNameOverride, toolDescriptionOverride, onHandoff,
inputType, inputFilter, isEnabled })`.

### Guardrails (Python, copied from src/agents/guardrail.py)

```python
@dataclass
class GuardrailFunctionOutput:
    output_info: Any            # arbitrary evidence about the check
    tripwire_triggered: bool    # if True, execution halts with a typed exception

@dataclass
class InputGuardrail(Generic[TContext]):
    guardrail_function: Callable[
        [RunContextWrapper[TContext], Agent[Any], str | list[TResponseInputItem]],
        MaybeAwaitable[GuardrailFunctionOutput],
    ]
    name: str | None = None
    run_in_parallel: bool = True     # False = blocking mode, agent never starts if tripped

@dataclass
class OutputGuardrail(Generic[TContext]):
    guardrail_function: Callable[
        [RunContextWrapper[TContext], Agent[Any], Any],
        MaybeAwaitable[GuardrailFunctionOutput],
    ]
    name: str | None = None
```

Decorators: `@input_guardrail(func, name, run_in_parallel)`, `@output_guardrail(func,
name)`. TS shape: `{ name: string, execute: async (args) => ({ outputInfo,
tripwireTriggered }) }` for both `InputGuardrail` and `OutputGuardrail`; helper
constructors `defineOutputGuardrail()`, `defineToolInputGuardrail()`. Exceptions:
`GuardrailExecutionError` wraps failures of the guardrail itself.

Tool-level guardrails attach at tool definition:

```python
@tool(
    tool_input_guardrails=[block_secrets],
    tool_output_guardrails=[redact_output],
)
def classify_text(text: str) -> str: ...
```

### Session protocol (Python)

```python
get_items(limit: int | None = None) -> list[TResponseInputItem]
add_items(items: list[TResponseInputItem]) -> None
pop_item() -> TResponseInputItem | None
clear_session() -> None
```

```python
SQLiteSession("user_123")                          # in-memory
SQLiteSession("user_123", "conversations.db")      # file-backed
SQLAlchemySession.from_url("user_123", url="postgresql+asyncpg://...", create_tables=True)
OpenAIConversationsSession(conversation_id="conv_123")
EncryptedSession(session_id="user_123", underlying_session=s, encryption_key="k", ttl=600)
result = await Runner.run(agent, "...", session=session)
```

Context-aware custom sessions add `wrapper: RunContextWrapper[Any] | None = None` to
all four methods (tenant routing, authorization).

### RunConfig fields (Python running-agents docs)

```
model, model_provider, model_settings, session_settings, session_input_callback,
input_guardrails, output_guardrails, handoff_input_filter (global),
nest_handoff_history, call_model_input_filter,
tracing_disabled, trace_include_sensitive_data,
workflow_name, trace_id, group_id, trace_metadata,
tool_execution, tool_not_found_behavior, tool_error_formatter
```

Exceptions: `MaxTurnsExceeded`, `ModelBehaviorError`, `ToolTimeoutError`,
`ModelRefusalError`, `UserError`, plus the four guardrail tripwire exceptions.

### Agent.as_tool() (Python, copied from src/agents/agent.py)

```python
def as_tool(
    self,
    tool_name: str | None,
    tool_description: str | None,
    custom_output_extractor: Callable[[RunResult | RunResultStreaming], Awaitable[str]] | None = None,
    is_enabled: bool | Callable[..., MaybeAwaitable[bool]] = True,
    on_stream: Callable[[AgentToolStreamEvent], MaybeAwaitable[None]] | None = None,
    run_config: RunConfig | dict[str, Any] | None = None,
    max_turns: int | None = None,
    hooks: RunHooks[TContext] | None = None,
    previous_response_id: str | None = None,
    conversation_id: str | None = None,
    session: Session | None = None,
    failure_error_function: ToolErrorFunction | None = default_tool_error_function,
    needs_approval: bool | Callable[[RunContextWrapper[Any], dict[str, Any], str], Awaitable[bool]] = False,
    parameters: type[Any] | None = None,
    input_builder: StructuredToolInputBuilder | None = None,
    include_input_schema: bool = False,
) -> FunctionTool
```

Note `needs_approval`: human-in-the-loop gating is built into the agent-as-tool
surface, per call, as a static bool or a predicate over (context, args, call_id).

### Grader config schemas (OpenAI evals; shapes survive the platform)

```json
{ "type": "string_check", "name": "...", "operation": "eq | ne | like | ilike",
  "input": "{{item.field}}", "reference": "..." }

{ "type": "text_similarity", "name": "...", "input": "...", "reference": "...",
  "pass_threshold": 0.8,
  "evaluation_metric": "fuzzy_match | bleu | gleu | meteor | cosine | rouge_1 | rouge_2 | rouge_3 | rouge_4 | rouge_5 | rouge_l" }

{ "type": "score_model", "name": "...", "input": "Message[]", "model": "...",
  "pass_threshold": 0.7, "range": [0, 1],
  "sampling_params": { "seed": 1, "top_p": 1, "temperature": 0,
    "max_completions_tokens": 1024, "reasoning_effort": "minimal | low | medium | high" } }

{ "type": "python", "source": "def grade(sample, item): ...", "image_tag": "..." }

{ "type": "multi", "graders": { "accuracy": {}, "style": {} },
  "calculate_output": "0.7 * accuracy + 0.3 * style" }
```

### Temporal integration (Python, from temporalio/sdk-python contrib README)

```python
# Plugin on the Temporal client
OpenAIAgentsPlugin(
    model_params=ModelActivityParameters(
        start_to_close_timeout=timedelta(seconds=30)
    )
)

# Agent code runs unchanged inside a workflow
@workflow.defn
class HelloWorldAgent:
    @workflow.run
    async def run(self, prompt: str) -> str:
        agent = Agent(name="Assistant", instructions="...")
        result = await Runner.run(agent, input=prompt)
        return result.final_output

# Durable tool = activity
@activity.defn
async def get_weather(city: str) -> Weather: ...

agent = Agent(tools=[
    openai_agents.workflow.activity_as_tool(
        get_weather, start_to_close_timeout=timedelta(seconds=10))
])
```

Placement matrix: activity_as_tool = external I/O (durable, retried);
@function_tool inside workflow = deterministic logic only; hosted tools = provider.
TS: `@temporalio/openai-agents` (worker/client) + `@temporalio/openai-agents/workflow`.

### ChatKit hosted session

```
POST https://api.openai.com/v1/chatkit/sessions
{ "workflow": { "id": "wf_..." }, "user": "unique_user_id" }
-> { "client_secret": "..." }

<script src="https://cdn.platform.openai.com/deployments/chatkit/chatkit.js" async></script>
```

### Assistants -> Responses concept mapping (migration guide)

| Legacy | Replacement | Stated rationale |
|---|---|---|
| Assistants | Prompts (now also dying: put config in code) | easier to version and update |
| Threads | Conversations | items beyond messages |
| Runs | Responses | send input items, get output items |
| Run steps | Items | generalized message/tool-call/output objects |

## What to adopt for RFA

1. **Handoff-as-tool as a first-class RFA verb.** Add a handoff envelope kind to
   RFA v0.4 alongside ask/serve. Copy the exact shape: reserved tool name
   `transfer_to_<member>`, a `tool_description` derived from the target's capability
   card (RFA's `handoff_description` equivalent already exists as card summary), an
   optional `input_json_schema` for structured routing payload (reason, priority),
   `is_enabled` predicate, and an `input_filter` hook that decides what room history
   the receiving agent sees. RFA already owns transcripts hub-side, so it can support
   history filtering where OpenAI's own server-managed conversations cannot. That is
   a real competitive property of the hub: keep it.

2. **The two composition modes, named.** RFA ask/serve = agent-as-tool
   (subroutine, caller keeps the thread). Handoff = conversation transfer (history
   moves, new agent owns the thread). Document both in the spec with OpenAI's exact
   distinction; adopt `needs_approval: bool | predicate` from `as_tool()` on the
   serve side for human-gated capabilities (fits the existing human-principals work).

3. **GuardrailFunctionOutput shape for the memory-gate and moderation.** Standardize
   every RFA check (memory ingestion gate, moderation, future tool gates) on
   `{ name, output_info, tripwire_triggered }` records, emitted into the envelope
   stream and OTel spans. Adopt the placement grammar: input guardrails (first agent
   only), output guardrails (final output only), tool guardrails (every invocation),
   and the parallel-vs-blocking flag (`run_in_parallel`). Typed tripwire errors, not
   generic failures.

4. **The 4-method Session protocol as RFA's agent-memory interface.**
   `get_items(limit) / add_items / pop_item / clear_session` is the whole contract;
   SQLite file-backed default fits local-first exactly. Wrap with an
   EncryptedSession-style decorator later if secrets land in memory. Add
   `session_input_callback` and `SessionSettings(limit=N)` equivalents to the
   RoomMember SDK for history-merge policy.

5. **Trace taxonomy and trace envelope fields.** RFA already emits OTel spans; align
   span names to the SDK taxonomy (`agent_span`, `generation_span`, `function_span`,
   `guardrail_span`, `handoff_span`, add `task_span`/`turn_span`) and adopt the trace
   header `{ workflow_name, trace_id, group_id, metadata }` with `group_id` = room or
   thread id. Copy `trace_include_sensitive_data` as a per-run flag: capture structure
   always, payloads only when enabled.

6. **Per-agent settings surface.** For RFA agent config files, copy the useful subset
   of ModelSettings: `model, temperature, top_p, tool_choice, parallel_tool_calls,
   max_tokens, reasoning (effort), verbosity, timeout, retry, context_management,
   metadata`. Map `reasoning.effort` to Claude effort, `verbosity` to output length.
   Keep the `extra_args` escape hatch.

7. **Grader config schemas as RFA eval data format.** Adopt `string_check`,
   `text_similarity`, `score_model`, `python`, and `multi` (weighted expression over
   named graders) as the JSON shapes for RFA evals, run locally (the hosted platform
   is dead; the shapes are good). Trace grading is the key idea to copy: graders run
   over full run traces (which RFA already records), not just input/output pairs.

8. **RECOMMENDED_PROMPT_PREFIX pattern.** Ship a standard prompt preamble in the
   RoomMember SDK explaining rooms, handoffs, and envelope discipline to member
   agents, versioned with the spec.

## What to adapt

1. **Temporal's workflow/activity split, without Temporal.** Adopt the pattern:
   deterministic orchestration state journaled by the hub (already an event log),
   model calls and side-effecting tool calls as retryable "activities" with explicit
   `start_to_close_timeout` and retry policy per tool. Concretely: add
   `{ timeout_ms, retry: { max_attempts, backoff } }` to RFA tool/capability
   declarations and have the RoomMember runtime enforce them. If RFA later outgrows
   one Mac, the Temporal TS integration is the proven upgrade path; design the runner
   so `Runner.run`-equivalent code would drop into a workflow unchanged.

2. **ChatKit's session-token pattern for the console.** Reject hosted ChatKit; adapt
   the shape: console asks the hub for a short-lived client secret bound to
   `{ room, user }`, hub authenticates, browser never holds long-lived credentials.
   Useful the day the console leaves localhost.

3. **Connector-registry idea at solo scale.** A single registry file of approved MCP
   servers/tools (name, transport, scopes, owner) that agent definitions reference by
   name instead of embedding connection details. Adopt `MCPConfig`'s exact knobs:
   `convert_schemas_to_strict`, `failure_error_function`,
   `include_server_in_tool_names` (server-prefixed tool names to avoid collisions,
   which RFA will hit as soon as two members expose same-named tools).

4. **tool_use_behavior vocabulary.** `run_llm_again | stop_on_first_tool |
   StopAtTools{stop_at_tool_names} | custom fn -> ToolsToFinalOutputResult` is a
   clean way to express "this serve handler's tool result IS the answer". Adapt into
   RoomMember serve handlers rather than the protocol.

5. **Agent Builder's node vocabulary as a checklist, not a canvas.** The node set
   (Guardrails, If/else + While over CEL, Human approval, Set state, Transform) is a
   decent inventory of orchestration primitives for RFA task-board workflows. Adopt
   the primitives in code (TS functions), never the visual canvas.

## What to reject and why

1. **A visual workflow builder.** OpenAI, with unlimited resources, killed Agent
   Builder 8 months after launch and told users to export to SDK code. For a solo
   TypeScript operator the calculus is even more lopsided. Code-first agent
   definitions in the repo, full stop.

2. **Hosted/server-side agent config objects** (Assistants-style agents, Reusable
   Prompts API). Both deprecated with "move config into your application code" as the
   official guidance. RFA agent definitions stay as files (versioned, diffable,
   greppable). Capability cards remain the runtime projection of those files, not the
   source of truth.

3. **Temporal as a dependency today.** Server + workers + determinism constraints is
   too much operational surface for one Mac and one operator. Adopt the pattern (see
   adapt #1), keep the door open.

4. **Server-managed conversation state** (`conversation_id` /
   `previous_response_id` equivalents that would push RFA transcripts into a vendor
   store). OpenAI's own docs show the cost: handoff input filters and nested history
   silently stop working. The hub-owned transcript is what makes RFA handoffs
   filterable and auditable; do not trade it away.

5. **Hosted evals dashboards.** Deprecated even by OpenAI (their guide points to
   Promptfoo). Keep RFA evals as local JSON grader configs + trace files + a report
   generator into `reports/`.

6. **Parallel-by-default input guardrails for side-effecting agents.** OpenAI defaults
   to racing the guardrail against the agent for latency. For RFA members with real
   tool access, default to blocking mode; latency matters less than an un-executed
   side effect. Keep parallel as opt-in for read-only agents.

## Sources (URLs)

Primary docs and source:
- https://openai.github.io/openai-agents-python/agents/
- https://openai.github.io/openai-agents-python/handoffs/
- https://openai.github.io/openai-agents-python/guardrails/
- https://openai.github.io/openai-agents-python/sessions/
- https://openai.github.io/openai-agents-python/tracing/
- https://openai.github.io/openai-agents-python/running_agents/
- https://github.com/openai/openai-agents-python (src/agents/agent.py, src/agents/handoffs/__init__.py, src/agents/guardrail.py, src/agents/model_settings.py, read at main, 2026-08-16)
- https://github.com/openai/openai-agents-js (docs/src/content/docs/guides/agents.mdx, handoffs.mdx)
- https://openai.github.io/openai-agents-js/guides/guardrails/

Temporal:
- https://github.com/temporalio/sdk-python/blob/main/temporalio/contrib/openai_agents/README.md
- https://docs.temporal.io/develop/typescript/integrations/openai-agents
- https://temporal.io/blog/announcing-openai-agents-sdk-integration

AgentKit and platform:
- https://developers.openai.com/api/docs/guides/agent-builder
- https://developers.openai.com/api/docs/guides/node-reference
- https://developers.openai.com/api/docs/guides/chatkit
- https://developers.openai.com/api/docs/guides/graders
- https://developers.openai.com/cookbook/examples/agentkit/agentkit_walkthrough

Deprecations and migration:
- https://developers.openai.com/api/docs/deprecations
- https://developers.openai.com/api/docs/assistants/migration
- https://community.openai.com/t/deprecation-notice-agent-builder/1382650
