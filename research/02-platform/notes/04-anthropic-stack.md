# Anthropic stack: Claude Agent SDK (TypeScript) + Claude Code architecture

Research date: 2026-08-16. All schemas below were copied from the primary docs
(code.claude.com markdown pages) and GitHub READMEs fetched the same day.
Focus: how to upgrade RFA residents (today: `spawn("claude", ["-p", "--model", MODEL])`
in `dogfood/pm-agent.ts`) into Agent SDK-powered residents with per-agent
settings, tools, skills, memory, and sandboxes.

---

## What it is

The Anthropic agent stack has four distinct layers (their own framing, from the
Agent SDK overview and the claude-api skill docs):

| Layer | Package / surface | What it gives you | Who hosts |
|---|---|---|---|
| Client SDK | `@anthropic-ai/sdk` | Raw Messages API + beta Tool Runner (loop over tools YOU define, no built-ins) | You |
| **Claude Agent SDK** | `@anthropic-ai/claude-agent-sdk` | Claude Code as a library: full harness (agent loop, built-in tools Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch, context management, hooks, subagents, permissions, sessions, skills, MCP) | You |
| Claude Code CLI | `claude` binary | Same harness, interactive terminal; `-p` for headless | You |
| Managed Agents (CMA) | REST `/v1/agents`, `/v1/sessions` | Anthropic runs the loop AND a per-session sandbox; persisted versioned agent configs | Anthropic |

Key facts for RFA:

- The Agent SDK is literally the Claude Code harness: `query()` spawns the
  bundled Claude Code CLI as a subprocess and talks a control protocol over
  stdio. It reads the same `~/.claude` config, the same auth, the same
  `.claude/` project artifacts (settings, skills, agents, CLAUDE.md), which is
  exactly what the current `claude -p` shell-out uses, so migration is
  incremental, not a rewrite.
- SDK is TypeScript and Python only. RFA is TypeScript: perfect fit
  (`npm install @anthropic-ai/claude-agent-sdk`).
- Auth: the SDK resolves credentials like the CLI (API key, `ANTHROPIC_AUTH_TOKEN`,
  or the local Claude Code login). Anthropic's restriction is about *third-party
  products* offering claude.ai login to their users ("Unless previously approved,
  Anthropic does not allow third party developers to offer claude.ai login or
  rate limits for their products"). Paul running his own personal residents on
  his own machine with his own login is the normal Claude Code use case, not a
  third-party product. Keep RFA personal / non-commercial and this stays fine.
- Claude Code has since v2.1.x grown the exact primitives RFA wants: agent .md
  files with model/effort/tools/memory frontmatter, SKILL.md skills with hooks
  and forked-context execution, a 30-event hook lifecycle, per-agent persistent
  memory directories, an OS-level bash sandbox (open-sourced as
  `@anthropic-ai/sandbox-runtime`), and experimental multi-session agent teams
  with a task list + mailbox architecture that is strikingly convergent with
  RFA's rooms + tasks board.

---

## Architecture (how it actually works)

### The SDK runtime model

- `query({ prompt, options })` returns a `Query` (an `AsyncGenerator<SDKMessage>`
  plus control methods). One `query()` = one Claude Code subprocess = one session.
- Two input modes: a `string` prompt (single-shot; the process exits after the
  result) or an `AsyncIterable<SDKUserMessage>` (streaming mode: the process
  stays alive, you push turns, and can call `interrupt()`, `setModel()`,
  `setPermissionMode()`, `applyFlagSettings()`, `setMcpServers()` mid-session).
  Streaming mode is what a long-lived RFA resident wants.
- `startup(options)` pre-warms the subprocess (spawn + initialize handshake)
  before any prompt exists; `warm.query(prompt)` then answers with no startup
  latency. Directly applicable to residents idling in a room.
- Sessions persist as JSONL transcripts under
  `~/.claude/projects/<encoded-cwd>/*.jsonl`. `resume: sessionId` restores full
  context; `forkSession: true` branches a copy with a new ID;
  `resumeSessionAt: <message-uuid>` resumes at a point; `persistSession: false`
  disables disk persistence. An alpha `sessionStore` adapter mirrors transcripts
  to external storage for cross-host resume.
- Permission evaluation order (SDK permissions doc, exact):
  1. Hooks (can deny outright; an allow does NOT skip deny/ask rules)
  2. Deny rules (`disallowedTools` + settings deny; win even in `bypassPermissions`)
  3. Ask rules (settings; fall through to `canUseTool` even in bypass mode)
  4. Permission mode (`bypassPermissions` approves everything reaching this step;
     `acceptEdits` approves file ops; `plan` routes writes to callback)
  5. Allow rules (`allowedTools` + settings allow)
  6. `canUseTool` callback (skipped and denied in `dontAsk` mode)
- The subprocess replaces its env when you pass `env`, so always spread:
  `env: { ...process.env, MY_VAR: "x" }`. Timeout knobs are env vars:
  `API_TIMEOUT_MS` (default 600000), `CLAUDE_CODE_MAX_RETRIES` (default 10),
  `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`, `CLAUDE_ENABLE_STREAM_WATCHDOG`.
- Cost/limit rails built in: `maxTurns`, `maxBudgetUsd` (stops the query when
  the client-side estimate hits the cap; result subtype `error_max_budget_usd`),
  `taskBudget: { total }` (alpha, model-aware token budget), `abortController`.

### Claude Code as a product (what the SDK inherits)

- **Settings**: three filesystem scopes merged with precedence
  local (`.claude/settings.local.json`) > project (`.claude/settings.json`) >
  user (`~/.claude/settings.json`); managed policy on top. SDK `settingSources`
  option picks which scopes load (`["user","project","local"]` default = all);
  programmatic `Options` override filesystem, managed policy overrides everything.
- **System prompt**: SDK default is a MINIMAL prompt, not Claude Code's. To get
  Claude Code behavior + CLAUDE.md loading you must pass
  `systemPrompt: { type: "preset", preset: "claude_code" }` (optionally
  `append: "..."`) AND `settingSources` including `"project"`. This is the #1
  migration gotcha.
- **Agents (subagents)**: Markdown files with YAML frontmatter in
  `.claude/agents/` (project) or `~/.claude/agents/` (user), hot-reloaded by a
  file watcher. Same definition runs as a delegated subagent, as the MAIN
  thread agent (`claude --agent <name>` or SDK `agent` option), or as an agent
  team teammate. Frontmatter carries model/effort/tools/memory/hooks/mcpServers
  per agent (full field table below).
- **Skills**: `SKILL.md` files in `.claude/skills/<name>/` (project),
  `~/.claude/skills/` (user), or plugins. Progressive disclosure: only
  name+description (capped at 1,536 chars combined with `when_to_use`) sits in
  context; full content loads on invocation. Skills can carry their own hooks,
  tool grants, model/effort overrides, and can run in a forked subagent
  (`context: fork`).
- **Hooks**: JSON config in settings files (and plugin `hooks/hooks.json`,
  skill frontmatter, agent frontmatter). Three nesting levels: event ->
  matcher group -> handlers. Five handler types: `command` (shell, JSON on
  stdin, exit code 2 = block), `http` (POST JSON), `mcp_tool`, `prompt`
  (single-turn LLM judge), `agent` (subagent with Read/Grep tools that
  investigates before deciding). SDK adds a sixth: in-process JS callbacks via
  the `hooks` option. Hooks merge across settings levels (never replace).
- **Memory**: two systems.
  1. CLAUDE.md files (loaded in full) for curated instructions.
  2. Auto memory: per-project directory `~/.claude/projects/<project>/memory/`
     with a `MEMORY.md` index (first 200 lines / 25KB loaded every session)
     plus topic files. Subagents get their OWN memory via the `memory`
     frontmatter field: `user` -> `~/.claude/agent-memory/<agent>/`,
     `project` -> `.claude/agent-memory/<agent>/`, `local` ->
     `.claude/agent-memory-local/<agent>/`. Enabling it auto-adds
     Read/Write/Edit and injects memory instructions + MEMORY.md head into the
     subagent's system prompt.
- **Sandbox**: OS-level, no container. macOS Seatbelt (`sandbox-exec`), Linux
  bubblewrap + socat proxy. Dual isolation: filesystem (write = allow-only,
  read = deny-then-allow) and network (proxy-based domain allowlist). Built
  into Claude Code (`/sandbox`, settings `sandbox.enabled`) and exposed
  programmatically via SDK `sandbox` option. The standalone engine is
  open-sourced as `@anthropic-ai/sandbox-runtime` (`srt` CLI): wrap ANY
  process, including MCP servers, with `~/.srt-settings.json` policy.
  Unsandboxable commands fall back to the permission system; the model can
  request escape via `dangerouslyDisableSandbox: true` in tool input, which
  routes to `canUseTool`.
- **Agent teams (experimental)**: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
  Team lead session + teammate Claude Code processes. Coordination via a
  shared task list (`~/.claude/tasks/<team>/`) and file-based mailboxes
  (`~/.claude/teams/<team>/inboxes/<agent>.json`) written through a
  `SendMessage` tool. Messages between agents are explicitly marked as coming
  from another session, cannot approve permissions, and in auto mode a
  classifier reviews inter-agent messages before delivery (anti prompt-injection
  posture identical in spirit to RFA's "messages are data, not instructions").
  Teams do NOT spawn in `-p` / SDK sessions (interactive only).

---

## Exact schemas and APIs (copied)

### query() and Options (TypeScript SDK reference)

```typescript
function query({ prompt, options }: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;

function startup(params?: { options?: Options; initializeTimeoutMs?: number }): Promise<WarmQuery>;
```

`Options` fields most relevant to RFA (exact names, from the reference table):

| Property | Type | Default |
|---|---|---|
| `agent` | `string` (main-thread agent name; must exist in `agents` or settings) | undefined |
| `agents` | `Record<string, AgentDefinition>` | undefined |
| `allowedTools` / `disallowedTools` | `string[]` (`"Bash"` bare = remove tool; `"Bash(rm *)"` scoped = deny rule) | `[]` |
| `canUseTool` | `CanUseTool` | undefined |
| `cwd` | `string` | `process.cwd()` |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | model default |
| `env` | `Record<string, string \| undefined>` (REPLACES subprocess env) | `process.env` |
| `forkSession` | `boolean` | false |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | `{}` |
| `includePartialMessages` | `boolean` (streamed deltas) | false |
| `maxBudgetUsd` | `number` | undefined |
| `maxTurns` | `number` | undefined |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` |
| `model` | `string` (alias or full ID) | CLI default |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | undefined |
| `permissionMode` | `PermissionMode` | `'default'` |
| `persistSession` | `boolean` | true |
| `resume` | `string` (session ID) | undefined |
| `sandbox` | `SandboxSettings` | undefined |
| `sessionId` | `string` (pin a UUID) | auto |
| `settings` | `string \| Settings` (inline settings or path) | undefined |
| `settingSources` | `("user" \| "project" \| "local")[]` | all sources |
| `skills` | `string[] \| 'all'` | undefined |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string; excludeDynamicSections?: boolean }` | undefined (minimal prompt) |
| `taskBudget` | `{ total: number }` (alpha) | undefined |
| `thinking` | `{ type: "adaptive"; display?: "summarized" \| "omitted" } \| { type: "enabled"; budgetTokens?: number } \| { type: "disabled" }` | `{ type: 'adaptive' }` |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | undefined |
| `strictMcpConfig` | `boolean` (only use passed `mcpServers`) | false |
| `spawnClaudeCodeProcess` | `(options: SpawnOptions) => SpawnedProcess` (run the CLI in a VM/container) | undefined |
| `plugins` | `SdkPluginConfig[]` = `{ type: "local", path, skipMcpDiscovery? }[]` | `[]` |
| `betas` | `SdkBeta[]` (`"context-1m-2025-08-07"`) | `[]` |
| `enableFileCheckpointing` | `boolean` (enables `rewindFiles()`) | false |
| `forwardSubagentText` | `boolean` (nested transcript rendering) | false |
| `agentProgressSummaries` | `boolean` (one-line subagent progress on task_progress events) | false |

### Query control surface (streaming mode)

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: { [K in keyof Settings]?: Settings[K] | null }): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<SDKControlReadFileResponse | null>;
  accountInfo(): Promise<AccountInfo>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}
```

`applyFlagSettings()` mid-session semantics: `effortLevel`, `permissions`,
`hooks`, `skillOverrides`, `fastMode`, `agent` apply on the NEXT turn; `model`
applies during the CURRENT turn; system prompt options never change mid-session.

### AgentDefinition (programmatic subagents / main-thread agents)

```typescript
type AgentDefinition = {
  description: string;              // required: when to use this agent
  tools?: string[];                 // allowlist; omitted = inherit all subagent tools
  disallowedTools?: string[];       // denylist; accepts mcp__server, mcp__server__*, mcp__*
  prompt: string;                   // required: the agent's system prompt
  model?: string;                   // 'fable' | 'opus' | 'sonnet' | 'haiku' | 'inherit' | full ID
  mcpServers?: AgentMcpServerSpec[];// name refs into parent config, or inline configs
  skills?: string[];                // skill names PRELOADED into context (full content)
  initialPrompt?: string;           // auto-submitted first user turn when main-thread agent
  maxTurns?: number;
  background?: boolean;             // run as non-blocking background task
  memory?: "user" | "project" | "local";
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | number;
  permissionMode?: PermissionMode;
  criticalSystemReminder_EXPERIMENTAL?: string;
};

type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;
```

### PermissionMode / CanUseTool / PermissionResult

```typescript
type PermissionMode =
  | "default"            // standard behavior
  | "acceptEdits"        // auto-accept file edits
  | "bypassPermissions"  // bypass checks; explicit ask rules still prompt
  | "plan"               // explore without editing
  | "dontAsk"            // never prompt; deny anything not pre-approved
  | "auto";              // model classifier approves/denies prompts

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
    requestId: string;
  }
) => Promise<PermissionResult | null>;

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string }
  | { behavior: "deny"; message: string; interrupt?: boolean; toolUseID?: string };
```

### In-process custom tools (SDK MCP server)

```typescript
function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,                      // Zod 3 or Zod 4 raw shape
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean }
): SdkMcpToolDefinition<Schema>;

function createSdkMcpServer(options: {
  name: string;
  version?: string;
  instructions?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
  alwaysLoad?: boolean;
}): McpSdkServerConfigWithInstance;

type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sdk"; name: string; instance: McpServer };   // in-process
```

Tool naming for permission rules: `mcp__<server>__<tool>`.

### Hook events (SDK, in-process callbacks)

```typescript
type HookEvent =
  | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PostToolBatch"
  | "Notification" | "UserPromptSubmit" | "UserPromptExpansion"
  | "SessionStart" | "SessionEnd" | "Stop" | "StopFailure"
  | "SubagentStart" | "SubagentStop" | "PreCompact" | "PostCompact"
  | "PermissionRequest" | "PermissionDenied" | "Setup" | "TeammateIdle"
  | "TaskCreated" | "TaskCompleted" | "Elicitation" | "ElicitationResult"
  | "ConfigChange" | "DirectoryAdded" | "WorktreeCreate" | "WorktreeRemove"
  | "InstructionsLoaded" | "CwdChanged" | "FileChanged" | "MessageDisplay";

type HookCallback = (
  input: HookInput,                      // union of per-event input types
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;

interface HookCallbackMatcher { matcher?: string; hooks: HookCallback[]; timeout?: number; }

type BaseHookInput = {
  session_id: string; transcript_path: string; cwd: string;
  prompt_id?: string; permission_mode?: string;
  effort?: { level: string }; agent_id?: string; agent_type?: string;
};
```

Settings-file hook config shape (Claude Code hooks reference):

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [ { "type": "command", "command": "/path/to/lint-check.sh" } ] }
    ]
  }
}
```

Handler `type` values: `"command"`, `"http"`, `"mcp_tool"`, `"prompt"`,
`"agent"`. Command hooks: JSON input on stdin; exit 0 = ok (stdout shown in
transcript for some events), exit 2 = block with stderr fed back to Claude;
JSON stdout can return `{ "decision": ... }` structures. Matchers: exact string,
`|`/`,` lists, or unanchored JS regex; per-handler `if` field uses permission
rule syntax (`"Bash(git *)"`). Hook locations: user/project/local settings,
managed policy, plugin `hooks/hooks.json`, skill frontmatter (rest of session),
subagent frontmatter (while running). HTTP hooks gated by `allowedHttpHookUrls`.

### Result message (per-answer accounting)

```typescript
type SDKResultMessage = {
  type: "result"; subtype: "success";
  uuid: UUID; session_id: string;
  duration_ms: number; duration_api_ms: number;
  is_error: boolean; num_turns: number;
  result: string;                              // final text
  stop_reason: string | null;
  total_cost_usd: number;                      // estimate, cumulative per query()
  usage: NonNullableUsage;                     // main loop only
  modelUsage: { [modelName: string]: ModelUsage }; // incl. subagents + compaction
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;                 // when outputFormat set
  ...
} | {
  type: "result";
  subtype: "error_max_turns" | "error_during_execution"
         | "error_max_budget_usd" | "error_max_structured_output_retries";
  errors: string[]; ...
};
```

### Sandbox settings (SDK) and sandbox-runtime

```typescript
type SandboxSettings = {
  enabled?: boolean;                 // default false
  failIfUnavailable?: boolean;       // default true
  autoAllowBashIfSandboxed?: boolean;// default true
  excludedCommands?: string[];       // always bypass (e.g. ['docker'])
  allowUnsandboxedCommands?: boolean;// default true: model may set dangerouslyDisableSandbox
  network?: {
    allowedDomains?: string[]; deniedDomains?: string[];
    strictAllowlist?: boolean; allowManagedDomainsOnly?: boolean;
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[]; allowAllUnixSockets?: boolean;
    httpProxyPort?: number; socksProxyPort?: number;
  };
  filesystem?: { allowWrite?: string[]; denyWrite?: string[]; denyRead?: string[] };
  ignoreViolations?: Record<string, string[]>;
  enableWeakerNestedSandbox?: boolean;
  ripgrep?: { command: string; args?: string[] };
};
```

Standalone engine: `npm install -g @anthropic-ai/sandbox-runtime`, then
`srt "cmd"`. Sandbox any MCP server by prefixing its command:

```json
{ "mcpServers": { "filesystem": { "command": "srt", "args": ["npx", "-y", "@modelcontextprotocol/server-filesystem"] } } }
```

Policy in `~/.srt-settings.json`:

```json
{
  "filesystem": { "denyRead": [], "allowWrite": ["."], "denyWrite": ["~/sensitive-folder"] },
  "network": { "allowedDomains": [], "deniedDomains": [] }
}
```

Primitives: macOS `sandbox-exec` Seatbelt profiles; Linux bubblewrap + network
namespace + socat proxy; Windows dedicated local user + WFP egress fence.
Write access = allow-only (deny by default); read = deny-then-allow. Known
limitation: the network proxy matches on requested hostname and does not
terminate TLS, so domain fronting can bypass it.

### Claude Code agent .md frontmatter (product side)

Only `name` and `description` are required. Full field set:

```
name            # unique id, lowercase+hyphens; hooks receive it as agent_type
description     # when Claude should delegate to this subagent
tools           # allowlist (inherits all subagent tools if omitted); Agent(worker, researcher) restricts spawnable types
disallowedTools # denylist, applied before tools; mcp__server / mcp__* patterns
model           # sonnet | opus | haiku | fable | full ID (claude-opus-5) | inherit (default)
permissionMode  # default | acceptEdits | auto | dontAsk | bypassPermissions | plan | manual
maxTurns        # max agentic turns
skills          # skills PRELOADED into context at startup (full content injected)
mcpServers      # name refs or inline server configs, scoped to this agent
hooks           # lifecycle hooks scoped to this subagent
memory          # user | project | local -> persistent agent-memory dir + MEMORY.md
background      # true = always run in background
effort          # low | medium | high | xhigh | max
isolation       # worktree = run in a temp git worktree
color           # UI color
initialPrompt   # auto first user turn when run as main-thread agent (--agent)
```

Model resolution order for a subagent: `CLAUDE_CODE_SUBAGENT_MODEL` env >
per-invocation `model` param > frontmatter `model` > main conversation model.
Files live in `.claude/agents/` (project) and `~/.claude/agents/` (user),
hot-reloaded. Body = the subagent's ENTIRE system prompt (subagents do not get
the full Claude Code system prompt).

### SKILL.md frontmatter (product side)

Location: `.claude/skills/<name>/SKILL.md` + supporting files. Fields:

```
name                      # display name (defaults to dir name)
description               # what + when; combined with when_to_use, truncated at 1,536 chars in listing
when_to_use               # extra trigger context
argument-hint, arguments  # $ARGUMENTS / $name substitution
disable-model-invocation  # true = manual /name only (also blocks preload + scheduled runs)
user-invocable            # false = model-only, hidden from / menu
allowed-tools             # tools pre-approved during the invoking turn
disallowed-tools          # tools removed while skill is active
model                     # model override for the rest of the turn
effort                    # low|medium|high|xhigh|max override
context                   # fork = run in a forked subagent
agent                     # subagent type to use with context: fork
background                # with context: fork, false = wait for result
hooks                     # hooks registered at invocation, kept for the session
paths                     # glob patterns gating auto-activation
shell, metadata, license, compatibility
```

String substitutions available in the body: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`,
`$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`,
`${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.
Dynamic context injection via `` !`command` `` blocks.

SDK-side loading: skills are filesystem-only (no programmatic registration).
Discovery is governed by `settingSources`; the `skills` option filters
(`"all"`, exact-name list, or `[]`), and auto-adds the `Skill` tool to
`allowedTools`. The `skills` option is a context filter, not a sandbox: files
remain readable via Read/Bash.

### Memory (product side)

- Auto memory dir: `~/.claude/projects/<project>/memory/` with `MEMORY.md`
  index (first 200 lines or 25KB loaded each session) + topic files. Override
  location with `autoMemoryDirectory` setting; disable with
  `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- Per-agent memory (frontmatter `memory:` or SDK `AgentDefinition.memory`):
  `user` -> `~/.claude/agent-memory/<name>/`, `project` ->
  `.claude/agent-memory/<name>/` (recommended, versionable), `local` ->
  `.claude/agent-memory-local/<name>/`. Injects memory instructions +
  MEMORY.md head into the agent prompt and enables Read/Write/Edit.

### Agent teams (experimental, for comparison with RFA)

- Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env or settings `env`).
- Components: team lead (main session), teammates (separate Claude Code
  processes), shared task list, mailboxes.
- Mailbox: `~/.claude/teams/{team}/inboxes/{agent}.json`, validated on read.
- Team config: `~/.claude/teams/{team}/config.json` (`members` array with name,
  agent id, agent type; lead = `team-lead`). Task list `~/.claude/tasks/{team}/`.
- Teammates load project context fresh (CLAUDE.md, MCP, skills), NOT the
  lead's history; a subagent definition used as teammate keeps `tools` + `model`
  but its `skills`/`mcpServers` frontmatter is ignored.
- Inter-agent messages are flagged as coming from another session; cannot
  carry permission approvals; auto-mode classifier screens each message.
- Not available in `-p`/SDK (interactive sessions only). Token cost scales
  linearly with teammates.

---

## What to adopt for RFA

1. **Replace `spawn("claude", ["-p"])` with the Agent SDK in `RoomMember`
   residents.** Minimal first step in `dogfood/pm-agent.ts`:

   ```typescript
   import { query } from "@anthropic-ai/claude-agent-sdk";

   async function answer(ctx: ServeContext): Promise<string> {
     let text = "";
     for await (const msg of query({
       prompt: ctx.wrapped,
       options: {
         model: "haiku",
         resume: sessionIdFor(ctx.conversationId),  // replaces the Map<convId, string[]>
         maxTurns: 4,
         maxBudgetUsd: 0.50,
         permissionMode: "dontAsk",
         allowedTools: ["Read", "Grep", "Glob"],
         cwd: ROOT,
         settingSources: ["project"],
         systemPrompt: PM_PROMPT,
       },
     })) {
       if (msg.type === "result" && msg.subtype === "success") text = msg.result;
     }
     return text;
   }
   ```

   Wins over `-p`: session resume (real conversation memory + prompt-cache
   reuse instead of resending a 120KB knowledge pack every question), typed
   result with `total_cost_usd`/`modelUsage`/`permission_denials`, `maxTurns`/
   `maxBudgetUsd` rails instead of a 180s SIGKILL, `interrupt()`, and
   in-process hooks.

2. **Per-agent settings via agent .md files.** Define each resident in
   `dogfood/agents/<name>.md` (or `.claude/agents/`) with frontmatter
   `model`, `effort`, `tools`, `disallowedTools`, `memory`, `skills`,
   `mcpServers`, `permissionMode`, `maxTurns`. Load with SDK
   `agents: { name: AgentDefinition }` (programmatic, versionable in RFA's own
   config) or `agent: "<name>"` + settingSources. This IS the per-agent
   model/effort/tools/memory config Paul wants; no need to invent a format.
   Recommendation: keep RFA resident definitions as agent .md files parsed by
   RFA itself into `AgentDefinition` records so one file drives both Claude
   Code and RFA metadata (capability card generation from `description`).

3. **Knowledge pack -> skills + Read tool.** Move `dogfood/knowledge/*.md`
   under a skill (`.claude/skills/goodvest-product/`) with a tight
   `description`, or keep as files and give the resident Read/Grep in `cwd`.
   Progressive disclosure replaces the 120KB-per-call prompt stuffing; the
   1,536-char description cap is the discovery budget. Skill frontmatter
   `allowed-tools`, `context: fork`, and `paths` cover the advanced cases.

4. **Per-agent persistent memory: `memory: "project"`.** Gives each resident
   `.claude/agent-memory/<name>/` with the MEMORY.md index protocol
   (200-line/25KB head) for free. Pipe RFA's `MemoryGate` in front of writes:
   a PostToolUse hook matching `Write|Edit` on the agent-memory path can run
   the gate and block replicated peer content (exit 2 / deny), which turns the
   spec 14.3 defense into an enforced boundary instead of client code.

5. **In-process SDK MCP server exposing RFA tools to residents.** Use
   `createSdkMcpServer` + `tool()` (Zod) to hand the resident brain
   `room_send`, `room_task`, `roster_lookup` etc. implemented directly on the
   RoomMember instance (no extra process, no double hub connection). This is
   the cleanest path to CAPABLE residents that can act in the room, not just
   answer. Permission-scope them as `mcp__rfa__<tool>` in allow/deny rules.

6. **Hooks as the governance + observability spine.** In-process
   `hooks: { PreToolUse: [...], PostToolUse: [...], SubagentStart: [...] }`
   callbacks mapped onto RFA's existing OTel spans: every hook input carries
   `session_id`, `agent_id`, `agent_type`, `prompt_id` (matches the
   `prompt.id` OTel attribute Claude Code itself emits), so resident traces
   join Claude Code telemetry cleanly. Use `PreToolUse` deny for room policy
   (e.g. block `room_send` with kind=announce unless holder of the floor).

7. **Sandboxing.** Two adoption levels:
   - SDK `sandbox: { enabled: true, network: { allowedDomains: [...] }, filesystem: {...} }`
     for residents that get Bash.
   - `srt` from `@anthropic-ai/sandbox-runtime` to wrap third-party MCP
     servers in `.mcp.json` (command: `srt`), with `~/.srt-settings.json`
     policy. Local-first, no containers, works on the Mac today.

8. **`startup()` pre-warm + streaming input mode** for standing residents:
   keep a warm subprocess per resident; on room question, `warm.query()` or
   push into the streaming input iterator. Eliminates per-question spawn cost
   (the current architecture pays full CLI startup on every answer).

9. **Structured outputs for serve():** `outputFormat: { type: "json_schema", schema }`
   and read `structured_output` from the result message; maps directly onto
   RFA's `{ type: "json", value }` answer parts, with
   `error_max_structured_output_retries` as the failure signal.

10. **Cost/limits per answer:** record `total_cost_usd`, `modelUsage`,
    `num_turns`, `duration_api_ms`, `permission_denials` from
    `SDKResultMessage` into the envelope/task metadata; enforce
    `maxBudgetUsd` per question and aggregate per room per day for a
    poor-man's budget system (matches CMA session budgets conceptually).

## What to adapt

- **Agent teams' design, not its implementation.** Task list + mailbox +
  "messages from agents are untrusted, cannot approve permissions" +
  classifier screening is convergent validation of RFA's rooms/tasks/
  memory-gate design. Adapt two ideas: (a) idle notifications (teammate
  reports done to lead automatically) as an RFA presence sub-state or
  auto-message on serve completion; (b) the validated-mailbox rule: validate
  every entry on read, drop invalid, keep valid (RFA hub already NDJSON,
  add the drop-invalid-entries semantics). Do NOT build on the team files
  themselves: experimental, interactive-only, session-scoped names, config
  is explicitly not user-editable.
- **`settingSources` discipline.** Residents should run with
  `settingSources: ["project"]` (or `[]` plus explicit options) so Paul's
  personal `~/.claude` skills/hooks do not leak into resident behavior; keep
  the hub's repo `.claude/` as the resident-facing config surface. Note the
  gotcha: CLAUDE.md only loads with the `claude_code` preset system prompt.
- **Model/effort policy per skill invocation.** SKILL.md `model`/`effort`
  overrides are per-turn; RFA can mirror that idea in capability cards
  (advertised skill -> model+effort used) so cost is a function of the skill
  invoked, not the resident.
- **`canUseTool` as the human-principal bridge.** For moderated rooms, wire
  `canUseTool` to an RFA room question to the human principal (room_admin
  approval flow) instead of a local prompt; `PermissionResult.updatedInput`
  even allows rewriting tool args on approval. `dontAsk` for fully
  unattended residents.
- **Session transcripts as room artifacts.** Sessions land in
  `~/.claude/projects/<encoded-cwd>/*.jsonl`; RFA observability could link
  envelope -> session_id -> transcript path (hook inputs carry
  `transcript_path`). Adapt, do not copy: keep RFA's own NDJSON as the
  source of truth, treat the transcript as a debug artifact.

## What to reject and why

- **Managed Agents (CMA) as the resident runtime.** Violates local-first:
  Anthropic-hosted loop + sandbox, dollar-metered sessions, REST control
  plane, and the RFA hub would have to bridge events out of Anthropic's SSE.
  Revisit only if Paul later wants scheduled cloud deployments (CMA
  deployments + cron would then replace a self-hosted scheduler). The Agent
  SDK covers everything RFA needs on the Mac.
- **Client SDK Tool Runner for residents.** It is a harness-only loop over
  tools you define, with NO built-in tools, no sessions, no skills, no
  hooks, and it bills per-token API (no Claude Code subscription auth). The
  Agent SDK strictly dominates for RFA's use.
- **Agent teams as the multi-agent substrate.** Experimental, interactive
  sessions only (explicitly does not spawn teammates under `-p`/SDK), local
  file mailboxes with session-derived names, no cross-machine story. RFA
  rooms already do discovery, presence, capability cards, and moderation;
  teams have none of those.
- **`bypassPermissions` for unattended residents.** The documented dangerous
  combination is `bypassPermissions` + `allowUnsandboxedCommands`: the model
  can silently escape the sandbox. Use `dontAsk` + explicit allowlists +
  sandbox instead; deny rules still hold in every mode.
- **Wildcards in the `skills` option and guessing tool names.** SDK throws on
  wildcard skill names; unresolved `tools` entries make a subagent fail to
  launch. Generate both lists from parsed agent files, validate at boot.
- **Python SDK.** TypeScript-first project; the TS SDK is also ahead
  (`applyFlagSettings()` is TS-only).

## Migration sketch for pm-agent.ts (concrete order)

1. Swap `answer()` to `query()` single-shot (keep everything else). Options:
   `model`, `maxTurns: 1`, `permissionMode: "dontAsk"`, `tools: []`,
   `settingSources: []`, systemPrompt = current prompt. Behavior-identical,
   plus cost fields.
2. Introduce per-conversation `resume` + drop the knowledge pack from the
   prompt; give `Read/Grep/Glob` over `dogfood/knowledge/` via `cwd` +
   `additionalDirectories`.
3. Move resident definition into an agent .md (model/effort/tools/memory) and
   pass via `agents` + `agent`; add `memory: "project"`.
4. Add the in-process `createSdkMcpServer` with RFA room tools; add
   PreToolUse/PostToolUse hooks feeding OTel.
5. Add `sandbox` for Bash-capable residents and `srt` for third-party MCP
   servers; wire `canUseTool` to the room's human-approval flow.

## Sources (URLs)

- https://code.claude.com/docs/en/agent-sdk/overview.md
- https://code.claude.com/docs/en/agent-sdk/typescript.md (full TS reference: query, startup, Options, Query, AgentDefinition, PermissionMode, CanUseTool, McpServerConfig, HookEvent, SDKResultMessage, SandboxSettings)
- https://code.claude.com/docs/en/agent-sdk/permissions.md (evaluation order)
- https://code.claude.com/docs/en/agent-sdk/sessions.md (session_id capture, resume, fork, transcript locations)
- https://code.claude.com/docs/en/agent-sdk/skills.md (SDK skill loading, skills option semantics)
- https://code.claude.com/docs/en/agent-sdk/subagents.md
- https://code.claude.com/docs/en/agent-sdk/mcp.md
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts.md
- https://code.claude.com/docs/en/sub-agents.md (agent .md frontmatter incl. model/effort/memory/isolation, tool filters, model resolution)
- https://code.claude.com/docs/en/skills.md (SKILL.md frontmatter reference, substitutions, visibility controls)
- https://code.claude.com/docs/en/hooks.md (hook config, matchers, 5 handler types, exit-code contract)
- https://code.claude.com/docs/en/memory.md (CLAUDE.md vs auto memory, MEMORY.md limits, agent memory dirs)
- https://code.claude.com/docs/en/sandboxing.md (sandboxed Bash tool, Seatbelt/bubblewrap, modes)
- https://code.claude.com/docs/en/agent-teams.md (architecture: lead/teammates/task list/mailboxes, security model)
- https://github.com/anthropics/claude-agent-sdk-typescript (README)
- https://github.com/anthropic-experimental/sandbox-runtime (srt README: usage, .srt-settings.json, isolation model)
- Local: /Users/paulbeneteau/Dev/agent-com/dogfood/pm-agent.ts (current claude -p shell-out)
