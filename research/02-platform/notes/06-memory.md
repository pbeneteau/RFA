# Memory systems for agents: evidence notes (dimension 06)

Researched 2026-08-16 for the RFA platform push (protocol demo -> daily work tool).
Primary sources fetched and read: Letta docs + the .af schema source file (tag 0.16.8),
Mem0 OSS source (prompts.py, memory/main.py on main), Graphiti source (nodes.py, edges.py on main),
LangMem docs, Anthropic memory tool docs, Zep and Mem0 papers (arxiv abstracts).
Local grounding: `src/client.ts` (MemoryGate, sanitizeForMemory), `dogfood/pm-agent.ts` (naive
per-conversation memory), `spec/RFA-0.1.md` section on untrusted content boundary.

---

## What it is

Five systems, one taxonomy, one pattern:

- **Letta (MemGPT lineage)**: the "OS metaphor" memory hierarchy. Core memory = pinned, agent-editable
  context blocks; archival memory = unbounded semantic store queried by tool; recall/conversation
  memory = searchable message history. Ships `.af`, an open JSON format serializing the whole
  stateful agent. Newer Letta adds sleep-time agents (background consolidation subagents) and MemFS,
  a git-backed memory filesystem.
- **Mem0**: a memory pipeline, not a runtime. Two LLM phases: extract candidate facts from a
  conversation, then reconcile each fact against similar existing memories with ADD / UPDATE /
  DELETE / NONE decisions. Storage = vector store payloads + a SQLite history log. Scoped by
  `user_id` / `agent_id` / `run_id`.
- **Zep / Graphiti**: a temporal knowledge graph engine. Episodes (raw inputs) -> entity nodes and
  relationship edges carrying a natural-language `fact`, with a bi-temporal model (event validity
  time AND ingestion time). Facts are invalidated, never deleted. Hybrid retrieval: embeddings +
  BM25 + graph traversal.
- **LangMem**: LangChain's memory SDK. Functional API (`create_memory_manager`,
  `create_memory_store_manager`, memory tools) over LangGraph's BaseStore, with an explicit
  taxonomy (semantic profile vs collection, episodic, procedural) and two formation modes
  (hot path vs background).
- **Claude memory tool**: Anthropic-provided tool type `memory_20250818`. The model edits files
  under a `/memories` prefix through six commands (view, create, str_replace, insert, delete,
  rename); the client executes them against storage it controls. The API injects a memory protocol
  into the system prompt automatically. Pairs with context editing and compaction.

Canonical taxonomy (CoALA paper, adopted by LangMem and most of the field):
**working** (context window), **episodic** (what happened), **semantic** (facts/knowledge),
**procedural** (how to behave: prompts, skills).

---

## Architecture (how it actually works)

### Letta

- Memory blocks are strings with metadata, compiled into the context window every turn as an
  XML-ish rendering (label, description, char usage metadata, value). Blocks are first-class DB
  objects that can be attached to several agents at once (`block_ids`), which gives shared memory
  between agents for free.
- The agent edits its own core memory via tools: `core_memory_append`, `core_memory_replace`.
  Long-tail knowledge goes to archival memory via `archival_memory_insert(content, tags)` and comes
  back via `archival_memory_search(query, tags, page)`. Message history is queried with
  `conversation_search`. Archival units are "passages" with embeddings; agent-immutable in the new
  docs (developers manage them via `client.agents.passages.*`).
- Rule of thumb in their docs: core memory for information needing constant visibility or frequent
  edits; archival for repositories, logs, references.
- Sleep-time agents: background subagents that "review recent conversations, consolidate useful
  lessons, and update memory without interrupting your active work"; trigger after a set number of
  completed agent steps or on context compaction; optional second-pass review ("Agent reviews
  before applying") before memory updates land.
- `.af` export packages: model config, full message history with `in_context` flags, system prompt,
  memory blocks, tool rules, env vars, full tool definitions (source + JSON schema). Explicitly NOT
  included today: archival passages (roadmap), secrets (nulled on export).

### Mem0

- `add(messages, user_id=..., infer=True)` pipeline when `infer=True`:
  1. **Extraction**: `FACT_RETRIEVAL_PROMPT` (or `USER_MEMORY_EXTRACTION_PROMPT`) returns
     `{"facts": ["...", "..."]}`. Few-shot driven; empty list for chit-chat; language of the user
     preserved; facts from user+assistant messages only, never system messages.
  2. **Reconciliation**: for each fact, search similar existing memories, then
     `DEFAULT_UPDATE_MEMORY_PROMPT` returns per-memory events: ADD (new id), UPDATE (same id,
     keeps `old_memory`), DELETE (contradiction), NONE. IDs must come from the input list.
- `infer=False` stores raw messages directly (no LLM). `memory_type="procedural_memory"` runs a
  separate summarization prompt over the conversation and stores the result as one memory.
- Storage: vector store insert with payload `{data, hash (md5), created_at, updated_at,
  text_lemmatized (for BM25), user_id/agent_id/run_id, actor_id, role, ...metadata}` plus a
  SQLite history table (`add_history(memory_id, old_value, new_value, event, ...)`) giving a full
  audit trail of every ADD/UPDATE/DELETE.
- `expiration_date` (YYYY-MM-DD): expired memories are hidden from `search`/`get_all` unless
  `show_expired=True`. That is their decay story: explicit TTL, no score decay.
- Paper numbers (LOCOMO): +26% relative accuracy vs OpenAI memory (LLM-as-judge), 91% lower p95
  latency and >90% token savings vs full-context; graph variant Mem0-g adds only ~2%.

### Zep / Graphiti

- Ingestion unit is the **episode** (`EpisodeType.message | json | text | fact_triple`; message
  content formatted as "actor: content"). From episodes an LLM extracts entity nodes and entity
  edges; every derived fact keeps `episodes: [uuid]` provenance back to raw input.
- **Bi-temporal model** on edges: `valid_at` / `invalid_at` = when the fact was true in the world;
  `created_at` / `expired_at` = when the system learned it / superseded it. Contradicted facts get
  invalidated (timestamps set), never deleted, so "what was true on date X" stays answerable.
- Graph tiers: episodic subgraph (raw), entity subgraph (semantic), community subgraph (clusters
  with summaries). `group_id` partitions everything (their multi-tenancy).
- Retrieval is hybrid and cheap at query time: cosine similarity + BM25 + one-hop graph traversal,
  reranked; no LLM in the read path. Zep paper: DMR 94.8% vs MemGPT 93.4%; LongMemEval up to
  +18.5% accuracy with about 90% lower latency than full-context baselines.
- Needs a graph database (Neo4j/FalkorDB/etc.) and an embedder + LLM for ingestion.

### LangMem

- Everything is built over a namespaced key-value store with vector index (LangGraph BaseStore).
  Namespaces are tuples with template variables, e.g. `("memories", "{langgraph_user_id}")`.
- Two formation modes, explicitly documented: **hot path** (agent calls
  `create_manage_memory_tool` / `create_search_memory_tool` itself, immediate but adds latency) and
  **background** (`create_memory_store_manager` runs extraction after the conversation,
  "subconscious", delayed but free of response latency).
- Semantic memory in two shapes: **profile** (single document, updates replace: current state) and
  **collection** (many records, insert/update/delete: accumulating knowledge). Episodic memories
  are structured as observation / thoughts / action / result. Procedural memory = the prompt
  itself, refined via feedback (prompt optimization).

### Claude memory tool

- Client-side: the model issues `tool_use` blocks with a `command`; your handler executes against
  real storage and returns strings. `/memories` is a prefix your handler maps anywhere (per-agent
  dir, SQLite, whatever). The tool is generally available (no beta header); the TS SDK ships
  `betaMemoryTool(backend)` plus a ready-made `BetaLocalFilesystemMemoryTool` (Node).
- The API auto-injects the memory protocol system prompt: check memory before doing anything else,
  record progress as you work, "ASSUME INTERRUPTION: your context window might be reset at any
  moment".
- Documented multisession pattern: an initializer session creates the memory files first (progress
  log, feature checklist, startup script reference); later sessions open by reading them and close
  by updating them; mark work complete only after end-to-end verification.
- Security guidance in the docs: path traversal validation is mandatory (reject anything resolving
  outside the memory root), cap file sizes, page long files via `view_range`, periodically delete
  stale files.

### Consolidation and decay (cross-cutting)

- Generative Agents (Park et al. 2023) retrieval scoring is still the reference formula:
  score = recency * importance * relevance, with recency an exponential decay (0.995 per game
  hour), importance an LLM 1-10 rating at write time, relevance cosine similarity; reflection
  triggers when the sum of recent importance exceeds a threshold, writing higher-level synthesized
  memories that cite their sources.
- Decay in practice across systems: Mem0 = explicit `expiration_date` filter; Zep = invalidation
  timestamps (never delete); Letta = sleep-time consolidation rewrites blocks; Claude docs =
  "periodically delete memory files that haven't been accessed in a long time". Nobody ships
  automatic score decay as a default; consolidation-by-rewrite is the working pattern.

---

## Exact schemas and APIs (copied)

### Letta memory block (docs, TypeScript)

```typescript
const block = await client.blocks.create({
  label: "organization",
  description: "A block to store information about the organization",
  value: "Organization: Letta",
  limit: 4000,
});
// fields: label, description, value, limit, read_only (optional, default false)
```

Context rendering (verbatim shape from docs):

```xml
<memory_blocks>
<persona>
  <description>The persona block: Stores details about your current persona...</description>
  <metadata>- chars_current=128- chars_limit=5000</metadata>
  <value>I am a helpful assistant named Sam...</value>
</persona>
</memory_blocks>
```

Shared blocks: `client.agents.create({ block_ids: [block.id], memory_blocks: [{label, value}], ... })`.

Agent-facing tools: `core_memory_append`, `core_memory_replace`,
`archival_memory_insert(content, tags=[...])`, `archival_memory_search(query, tags=[...], page=0)`,
`conversation_search`.

### Letta .af format (letta/serialize_schemas/pydantic_agent_schema.py, tag 0.16.8, verbatim fields)

```python
class CoreMemoryBlockSchema(BaseModel):
    created_at: str
    description: Optional[str]
    is_template: bool
    label: str
    limit: int
    metadata_: Optional[Dict] = None
    template_name: Optional[str]
    updated_at: str
    value: str

class MessageSchema(BaseModel):
    created_at: str
    group_id: Optional[str]
    model: Optional[str]
    name: Optional[str]
    role: str
    content: List[LettaMessageContentUnion]
    tool_call_id: Optional[str]
    tool_calls: List[Any]
    tool_returns: List[Any]
    updated_at: str

class ToolSchema(BaseModel):
    args_json_schema: Optional[Any]
    created_at: str
    description: str
    json_schema: ToolJSONSchema
    name: str
    return_char_limit: int
    source_code: Optional[str]
    source_type: str
    tags: List[str]
    tool_type: str
    updated_at: str
    metadata_: Optional[Dict] = None

class AgentSchema(BaseModel):
    agent_type: str
    core_memory: List[CoreMemoryBlockSchema]
    created_at: str
    description: Optional[str]
    embedding_config: EmbeddingConfig
    llm_config: LLMConfig
    message_buffer_autoclear: bool
    in_context_message_indices: List[int]
    messages: List[MessageSchema]
    metadata_: Optional[Dict] = None
    multi_agent_group: Optional[Any]
    name: str
    system: str
    tags: List[TagSchema]
    tool_exec_environment_variables: List[ToolEnvVarSchema]
    tool_rules: List[ToolRuleSchema]
    tools: List[ToolSchema]
    updated_at: str
    version: str
```

Tool rules variants: `BaseToolRuleSchema{tool_name, type}`, `ChildToolRuleSchema{children}`,
`MaxCountPerStepToolRuleSchema{max_count_limit}`, `ConditionalToolRuleSchema{default_child,
child_output_mapping, require_output_mapping}`. Import/export: `client.agents.importFile(file)` /
`client.agents.exportFile(agentId)`; REST `POST /v1/agents/import`, `GET /v1/agents/{id}/export`.
Secrets nulled on export; archival passages not serialized (roadmap).

### Mem0 add() (mem0/memory/main.py on main, verbatim signature)

```python
def add(
    self,
    messages,
    *,
    user_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    run_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    timestamp: Optional[Any] = None,          # platform-only
    expiration_date: Optional[Any] = None,    # YYYY-MM-DD, hidden from search when past
    infer: bool = True,
    memory_type: Optional[str] = None,        # "procedural_memory" is the special value
    prompt: Optional[str] = None,
):
# Returns: {"results": [{"id": "...", "memory": "...", "event": "ADD"}]}
# search()/get_all() take filters={"user_id": ...} instead of top-level ids.
```

Extraction phase output contract (FACT_RETRIEVAL_PROMPT): `{"facts": ["Name is John", ...]}`,
empty for small talk, "detect the language of the user input and record the facts in the same
language", facts from user and assistant messages only.

Reconciliation phase output contract (DEFAULT_UPDATE_MEMORY_PROMPT), verbatim shape:

```json
{ "memory": [
  { "id": "0", "text": "User is a software engineer", "event": "NONE" },
  { "id": "1", "text": "Name is John",                "event": "ADD" },
  { "id": "2", "text": "Loves cheese and chicken pizza", "event": "UPDATE",
    "old_memory": "I really like cheese pizza" },
  { "id": "3", "text": "Loves cheese pizza",          "event": "DELETE" }
] }
```

Rules embedded in the prompt: UPDATE keeps the same id and keeps the most informative phrasing;
DELETE on contradiction; ids must come from the input, never invented.

Stored payload per memory (_create_memory, verbatim keys): `data`, `hash` (md5 of data),
`created_at`, `updated_at`, `text_lemmatized` (BM25 support), plus scope ids and caller metadata;
side write to SQLite history: `add_history(memory_id, None, data, "ADD", created_at, updated_at,
actor_id, role)`.

### Graphiti data model (graphiti_core/nodes.py + edges.py on main, verbatim fields)

```python
class Node(BaseModel, ABC):
    uuid: str
    name: str                       # 'name of the node'
    group_id: str                   # 'partition of the graph'
    labels: list[str]
    created_at: datetime

class EpisodicNode(Node):
    source: EpisodeType             # message | json | text | fact_triple
    source_description: str
    content: str                    # 'raw episode data'
    valid_at: datetime              # when the original document/message occurred
    entity_edges: list[str]         # edges derived from this episode
    episode_metadata: dict[str, Any] | None

class EntityNode(Node):
    name_embedding: list[float] | None
    summary: str                    # 'regional summary of surrounding edges'
    attributes: dict[str, Any]

class CommunityNode(Node):
    name_embedding: list[float] | None
    summary: str                    # 'region summary of member nodes'

class EntityEdge(Edge):             # Edge: uuid, group_id, source_node_uuid, target_node_uuid, created_at
    fact: str                       # 'fact representing the edge and nodes that it connects'
    fact_embedding: list[float] | None
    episodes: list[str]             # provenance: episode uuids
    expired_at: datetime | None     # when the system superseded it (transaction time)
    valid_at: datetime | None       # 'datetime of when the fact became true'
    invalid_at: datetime | None     # 'datetime of when the fact stopped being true'
    attributes: dict[str, Any]
```

`EpisodeType.message` content convention: `"actor: content"`, e.g. `"user: Hello, how are you?"`.

### LangMem (docs reference, verbatim signatures)

```python
create_memory_manager(
    model: str | BaseChatModel, /, *,
    schemas: Sequence[S] = (Memory,),
    instructions: str = _MEMORY_INSTRUCTIONS,
    enable_inserts: bool = True,
    enable_updates: bool = True,
    enable_deletes: bool = False,
) -> Runnable[MemoryState, list[ExtractedMemory]]

create_memory_store_manager(
    model, /, *,
    schemas: list[S] | None = None,
    instructions: str = _MEMORY_INSTRUCTIONS,
    default: str | dict | S | None = None,
    default_factory: Callable[[RunnableConfig], str | dict | S] | None = None,
    enable_inserts: bool = True,
    enable_deletes: bool = False,
    query_model: str | BaseChatModel | None = None,
    query_limit: int = 5,
    namespace: tuple[str, ...] = ("memories", "{langgraph_user_id}"),
    store: BaseStore | None = None,
    phases: list[MemoryPhase] | None = None,
) -> MemoryStoreManager
```

Hot-path tools: `create_manage_memory_tool(namespace=("memories",))`,
`create_search_memory_tool(namespace=("memories",))`.

### Claude memory tool (platform.claude.com docs, verbatim)

Enable: `tools: [{ "type": "memory_20250818", "name": "memory" }]` (that is the whole config; GA,
no beta header). TS helper: `betaMemoryTool(backend)` + `BetaLocalFilesystemMemoryTool.init("./memory")`.

Commands and exact input shapes:

```json
{ "command": "view",        "path": "/memories/notes.txt", "view_range": [1, 10] }
{ "command": "create",      "path": "/memories/notes.txt", "file_text": "..." }
{ "command": "str_replace", "path": "/memories/preferences.txt",
  "old_str": "Favorite color: blue", "new_str": "Favorite color: green" }
{ "command": "insert",      "path": "/memories/todo.txt", "insert_line": 2, "insert_text": "...\n" }
{ "command": "delete",      "path": "/memories/old_file.txt" }
{ "command": "rename",      "old_path": "/memories/draft.txt", "new_path": "/memories/final.txt" }
```

Return-string conventions the handler should emit: directory listing "up to 2 levels deep ...
{size}\t{path}" lines; file views with 6-char right-aligned 1-indexed line numbers; create ->
"File created successfully at: {path}"; str_replace errors for not-found and multiple occurrences;
errors returned as `tool_result` with `is_error: true`. Auto-injected system prompt (verbatim):

```text
IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE.
MEMORY PROTOCOL:
1. Use the `view` command of your `memory` tool to check for earlier progress.
2. ... (work on the task) ...
   - As you make progress, record status / progress / thoughts etc in your memory.
ASSUME INTERRUPTION: Your context window might be reset at any moment, so you risk losing any
progress that is not recorded in your memory directory.
```

Mandatory safeguard: validate every path resolves inside the memory root (reject `../`,
URL-encoded traversal, etc.).

---

## RFA today (local grounding)

- `src/client.ts`: `RoomMember.sanitizeForMemory(env)` produces `MemoryRecord {text, from{id,name,
  origin}, room, seq, ts, kind, wrapped}` (neutralized text + prompt-ready boundary form).
  `MemoryGate.inspect(env)` flags cross-sender near-duplicates (Jaccard over 5-char shingles,
  threshold 0.9, window 64, minLength 40) as the Morris-II worm defense. Flagged content still
  enters the comparison window. This is a write-path admission filter and it is good; keep it as
  the single door into any persistent store.
- `dogfood/pm-agent.ts`: `conversations: Map<string, string[]>` keeps the last 8 turns as 300-char
  strings per `conversationId`, in process memory only; the whole knowledge pack is re-read and
  re-injected on every question; nothing survives a restart. This is the gap to close.

## Design: memory architecture for a resident RFA expert agent (local-first)

One directory per agent, files + one SQLite DB, four layers mapped to the CoALA taxonomy:

```text
dogfood/state/memory/<agent-id>/
  blocks/                 # L1 core memory: Letta-style blocks as Markdown files with front matter
    persona.md            #   label, description, limit, read_only in YAML front matter; body = value
    operating-context.md
    scratchpad.md
  memories/               # agent-editable free-form notes: the Claude memory tool root (/memories)
  memory.db               # L2 episodic + L3 semantic (SQLite, WAL mode)
```

- **L0 working**: the claude -p / Agent SDK context window. Nothing to build.
- **L1 core blocks**: compiled into the system prompt each session, rendered in Letta's XML shape
  with chars_current/chars_limit metadata. Editable by the agent through the memory tool (they are
  just files under the root), enforce `limit` on write.
- **L2 episodic**: append-only `episodes` table. Every gated room message (the MemoryGate verdict
  and provenance included) and every own answer is an episode. This is the ground-truth stream in
  the Graphiti sense; facts point back to it.
- **L3 semantic**: `facts` table maintained by a Mem0-style two-phase consolidation pass with
  Graphiti-style bi-temporal columns. Reconciliation events are ADD / UPDATE / DELETE / NONE, but
  DELETE is implemented as invalidation (set `invalid_at` + `expired_at`), never row deletion, and
  UPDATE writes a new row with `supersedes` linkage. History is thereby free.
- **L4 procedural**: the agent's system prompt, skills, and knowledge pack stay git-tracked files;
  the consolidation pass may PROPOSE edits (a diff written to a review file) but a human applies
  them. Procedural memory is the highest-privilege layer; auto-writing it from room content would
  reopen the injection hole the MemoryGate exists to close.

Exact record shapes (TypeScript) worth adopting:

```typescript
// L1: block front matter (Letta CoreMemoryBlockSchema, trimmed to what we need)
interface MemoryBlock {
  label: string;            // filename stem
  description: string;      // tells the model what belongs here
  value: string;            // file body
  limit: number;            // char cap, enforced on write
  read_only?: boolean;      // e.g. persona is human-owned
  updated_at: string;       // ISO 8601
}

// L2: episode row (RFA MemoryRecord + MemoryGate verdict; Graphiti EpisodicNode influence)
interface EpisodeRow {
  id: string;               // uuid
  agent_id: string;
  room: string;             // RFA room handle
  seq: number;              // hub sequence: exact provenance
  ts: string;               // envelope ts (valid_at in Graphiti terms)
  kind: string;             // envelope kind
  from_id: string; from_name: string; from_origin: string;  // "human" | "agent" | ...
  text: string;             // neutralized (sanitizeForMemory)
  wrapped: string;          // prompt-ready boundary form, used verbatim at retrieval
  gate_ok: number;          // 1 admitted, 0 suppressed (stored anyway, flagged)
  gate_similarity: real | null;
  conversation_id: string | null;
}

// L3: fact row (Mem0 payload keys + Graphiti bi-temporal + provenance)
interface FactRow {
  id: string;               // uuid
  agent_id: string;
  subject: string | null;   // optional light structure; no graph DB
  text: string;             // the fact, one sentence, source language preserved
  hash: string;             // md5/sha of text (Mem0: dedupe)
  episode_ids: string;      // JSON array: provenance back to L2 (Graphiti: episodes)
  source_origin: string;    // min trust tier of sources: "human" | "agent"
  created_at: string;       // transaction time: learned
  expired_at: string | null;// transaction time: superseded
  valid_at: string | null;  // event time: became true
  invalid_at: string | null;// event time: stopped being true
  supersedes: string | null;// FactRow.id this row replaced (UPDATE lineage)
  importance: integer;      // 1-10, rated at consolidation time (Generative Agents)
  last_accessed_at: string | null;  // for decay/pruning reports
}
```

SQLite DDL sketch: both tables plus `CREATE VIRTUAL TABLE facts_fts USING fts5(text, content=facts)`
and the same for episodes. Retrieval = FTS5 BM25 filtered to `expired_at IS NULL`, reranked by
`bm25 * importance * recency` (recency = exponential decay on last_accessed_at/created_at,
Generative Agents shape). Embeddings are an optional later column (sqlite-vec), not a dependency.

Consolidation loop (sleep-time pattern, not hot path):

1. Trigger after N gated exchanges or on a timer (fits the existing hub cron/loop tooling), as a
   separate cheap claude -p call with NO tools and a strict JSON contract.
2. Input: new episodes since last run (wrapped forms, so content stays marked untrusted) + the
   top-K similar existing facts (Mem0: id-keyed list).
3. Output: Mem0's exact event shape `{memory: [{id, text, event, old_memory?}]}`; apply with
   invalidation semantics above; log every event (Mem0 history table pattern) to the OTel span so
   the console can show memory writes.
4. Same pass may rewrite `blocks/scratchpad.md` (rolling summary) and propose L4 diffs.

Session start protocol (Claude memory tool pattern): compile blocks + top facts into the prompt;
the agent additionally has the `memory_20250818` tool rooted at `memories/` for free-form notes,
using the SDK's `BetaLocalFilesystemMemoryTool` semantics with path-traversal validation.

---

## What to adopt for RFA

1. **Claude memory tool as the agent-facing write interface** (`memory_20250818`, six commands,
   filesystem handler rooted per agent). It costs near zero to implement in TypeScript, the model
   is trained for it, the protocol prompt is auto-injected, and it matches local-first exactly.
   Adopt the documented return-string conventions and path-traversal validation as-is.
2. **Letta memory blocks** as the core-memory shape: label / description / value / limit /
   read_only, stored as Markdown files with front matter, compiled into the system prompt in the
   XML rendering with chars_current/chars_limit. Adopt shared blocks (one file attached to several
   agents) for room-level shared context later.
3. **Mem0's two-phase consolidation contract** verbatim: extraction returns `{"facts": [...]}`;
   reconciliation returns `{memory: [{id, text, event: ADD|UPDATE|DELETE|NONE, old_memory?}]}`
   against an id-keyed candidate list. Also adopt: `hash` for dedupe, `infer=False` raw mode,
   `expiration_date` filtering, the history/audit log of every event.
4. **Graphiti's bi-temporal columns and invalidation-not-deletion**: `created_at`, `expired_at`,
   `valid_at`, `invalid_at`, `supersedes`, `episode_ids` provenance. This is cheap in SQLite and
   buys time-travel answers and safe contradiction handling.
5. **Sleep-time consolidation** (Letta) / **background formation** (LangMem): memory extraction
   runs after the exchange, never in the answer path. pm-agent latency stays flat.
6. **The multisession pattern from the Anthropic docs** for working agents: initializer session
   writes progress log + checklist; every session starts by reading memory and ends by updating it.
   This is directly the STATUS.md habit, formalized per agent.
7. **Keep and extend the MemoryGate**: it remains the single admission door; every episode row
   stores the gate verdict, and consolidation only reads gated content in `wrapped` form.

## What to adapt

- **.af format**: do not implement Letta's schema wholesale; adapt the idea into an "RFA agent
  file": name, system, blocks, tool/skill list, model config (model, effort), memory DB reference.
  Reuse their field discipline (in_context flags, nulled secrets, version field) so export/import
  and git-versioned agent checkpoints work. Archival content stays out of the file, as in .af.
- **Mem0 scoping** (`user_id`/`agent_id`/`run_id`): adapt to RFA identities: `agent_id` +
  `room` + `conversation_id`, plus `source_origin` trust tier that Mem0 lacks (RFA has real
  provenance from envelopes; use it: facts derived only from agent-origin content must be marked
  and can be excluded from high-trust prompts).
- **Graphiti retrieval**: adopt hybrid retrieval but downscale: FTS5 BM25 + recency * importance
  reranking now; sqlite-vec embeddings later if recall proves insufficient. No graph database.
- **LangMem's profile vs collection distinction**: blocks are the profiles (replace-on-update),
  the facts table is the collection (accumulate + reconcile). Use its episodic record shape
  (observation / thoughts / action / result) for task post-mortems written by working agents.
- **Generative Agents scoring**: adopt the formula shape (recency * importance * relevance) but
  compute importance once at consolidation time (1-10) instead of per-write LLM calls.

## What to reject and why

- **A graph database (Neo4j/FalkorDB) and full Graphiti**: heavy Python/Java infra for one Mac and
  one operator; the Mem0 paper shows the graph variant adds only about 2% on LOCOMO. The bi-temporal
  columns capture the valuable part without the engine.
- **Hosted platforms (Letta Cloud, Mem0 Platform, Zep)**: violates local-first, adds accounts and
  data egress for personal Goodvest work content.
- **A vector database service (and embeddings as a hard dependency)**: FTS5 BM25 plus reranking is
  enough at this corpus size; Zep itself keeps LLMs out of the read path for latency. Revisit with
  sqlite-vec if retrieval quality demands it.
- **Hot-path extraction as default** (Mem0 `infer=True` on every message, LangMem conscious
  formation): adds an LLM call per exchange to the answer path; RFA rooms are chatty and the
  operator pays per token twice. Background-only.
- **LangGraph/LangMem as a dependency**: Python-first, drags in the LangChain store abstractions;
  everything worth keeping (taxonomy, signatures, reconciliation behavior) is a design, not a
  library, and is reimplementable in ~200 lines of TypeScript over SQLite.
- **Auto-updating procedural memory from room content**: self-modifying prompts fed by peer
  messages is the exact worm amplification channel spec 14.3 warns about. Human-reviewed diffs only.
- **Deleting memories on contradiction** (Mem0's literal DELETE): destroys audit trail; RFA is
  a moderated multi-agent space where "who said what when" matters. Invalidate instead.

## Sources (URLs)

- https://docs.letta.com/guides/agents/memory (memory tiers, tools)
- https://docs.letta.com/guides/agents/memory-blocks (block fields, XML rendering, shared blocks)
- https://docs.letta.com/guides/agents/archival-memory (passages, insert/search signatures)
- https://docs.letta.com/guides/agents/sleep-time-agents (background consolidation, MemFS)
- https://github.com/letta-ai/agent-file (README, .af components, import/export, FAQ)
- https://github.com/letta-ai/letta/blob/0.16.8/letta/serialize_schemas/pydantic_agent_schema.py (exact .af schema; gone from main, fetched at tag 0.16.8)
- https://docs.mem0.ai/core-concepts/memory-operations (add pipeline, parameters)
- https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py (FACT_RETRIEVAL_PROMPT, DEFAULT_UPDATE_MEMORY_PROMPT, verbatim)
- https://github.com/mem0ai/mem0/blob/main/mem0/memory/main.py (add() signature, _create_memory payload, history log, procedural memory)
- https://arxiv.org/abs/2504.19413 (Mem0 paper: LOCOMO +26%, 91% lower p95 latency, Mem0-g +2%)
- https://github.com/getzep/graphiti (architecture, hybrid retrieval, bi-temporal model)
- https://github.com/getzep/graphiti/blob/main/graphiti_core/nodes.py and .../edges.py (exact node/edge fields, EpisodeType)
- https://arxiv.org/abs/2501.13956 (Zep paper: DMR 94.8% vs MemGPT 93.4%, LongMemEval +18.5%, ~90% latency reduction)
- https://langchain-ai.github.io/langmem/ and /reference/memory/ (create_memory_manager, create_memory_store_manager signatures)
- https://langchain-ai.github.io/langmem/concepts/conceptual_guide/ (taxonomy: profile vs collection, hot path vs background)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool (memory_20250818, six commands, return strings, auto-injected protocol prompt, multisession pattern, security)
- https://arxiv.org/abs/2309.02427 (CoALA: working/episodic/semantic/procedural taxonomy)
- https://arxiv.org/abs/2304.03442 (Generative Agents: recency * importance * relevance, reflection)
- Local: /Users/paulbeneteau/Dev/agent-com/src/client.ts (MemoryGate, sanitizeForMemory), /Users/paulbeneteau/Dev/agent-com/dogfood/pm-agent.ts (current naive memory), /Users/paulbeneteau/Dev/agent-com/spec/RFA-0.1.md (untrusted content boundary)
