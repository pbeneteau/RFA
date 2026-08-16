# LangGraph runtime and platform: durable execution, assistants, runs, server architecture

Dimension: langgraph-runtime. Researched 2026-08-16 from primary sources: langgraphjs source on GitHub (checkpoint + SDK packages), docs.langchain.com (LangGraph OSS JS + LangGraph Platform / LangSmith Deployment pages), and the langgraph CLI JSON schema. All TypeScript shapes below are copied verbatim from `langchain-ai/langgraphjs` main branch.

## What it is

LangGraph has two layers that matter here:

1. **OSS runtime (library)**: the graph engine plus a persistence contract. Durability comes from two pluggable primitives: a **checkpointer** (`BaseCheckpointSaver`) that snapshots graph state per super-step into a **thread**, and a **store** (`BaseStore`) for long-term memory outside graph state. Everything else (time travel, human-in-the-loop interrupts, forking, resume-after-crash) is derived from these two primitives.

2. **LangGraph Server / Platform** (now rebranded "LangSmith Deployment", the server is "Agent Server"): a closed-source API server that wraps any graph and gives it: Assistants (versioned named configs over one graph), Threads, a Runs queue (background runs, one concurrent run per thread), resumable SSE streams, crons, webhooks, a Store HTTP API, and, notably, an **auto-generated MCP endpoint at /mcp** that exposes each assistant as an MCP tool. Infrastructure: Postgres (all durable data + task queue) and Redis (ephemeral pub/sub only).

The key architectural insight for RFA: the server is a thin, generic "durable run engine" over the OSS persistence contract. The whole platform data model is 5 tables (assistants, threads, runs, checkpoints, store) plus a queue discipline. That is replicable in TypeScript on SQLite for a one-Mac deployment.

## Architecture (how it actually works)

### Components (LangGraph Server)

- **API servers**: handle HTTP (create runs, read thread state, stream results). They do not execute agent code.
- **Queue workers**: the execution engine. They pull queued runs, execute graph code, write checkpoints. `N_JOBS_PER_WORKER` (default 10) concurrent runs per worker.
- **PostgreSQL**: stores everything durable: assistants, threads, runs, cron jobs, checkpoints, store items. Also backs the task queue.
- **Redis**: only signaling, cancellation, and streaming pub/sub between API servers and workers. Per the docs: "stores only ephemeral data - no user or run data persists in Redis."

Deployment modes: single host (API server manages queue directly), split API and queue (dedicated workers), distributed runtime (separate orchestration and execution). For a solo operator only the first matters.

### The run lifecycle

1. Client POSTs a run (input or command, assistant id, thread id optional).
2. Server enqueues it. **The queue enforces at most 1 concurrent run per thread**; concurrent submissions on the same thread are resolved by the run's `multitask_strategy` (reject | interrupt | rollback | enqueue).
3. A worker picks it up, executes the graph step by step, writing a checkpoint after each super-step (durability mode configurable), and publishes stream events to Redis.
4. Stream consumers attach and detach freely: `create` returns immediately (background run), `joinStream(threadId, runId)` attaches later, and with `stream_resumable: true` the event buffer is persisted so a client can replay from any point with the `Last-Event-ID` header (pass `"-"` to replay from the beginning).
5. On completion the server optionally POSTs to a `webhook` URL given at run creation.

### Durability modes (exact enum)

```ts
export type Durability = "exit" | "async" | "sync";
// "async": save checkpoint asynchronously while the next step executes (default)
// "sync":  save checkpoint synchronously before the next step starts
// "exit":  save checkpoint only when the graph exits
```

### Threads, checkpoints, time travel

A thread is just a `thread_id` plus the chain of checkpoints written under it. Every checkpoint knows its parent, so you get:

- **Replay**: `graph.invoke(null, pastCheckpointConfig)` re-executes from that checkpoint. Docs are explicit: "Replay re-executes nodes - it doesn't just read from cache. LLM calls, API requests, and interrupts fire again and may return different results."
- **Fork**: `graph.updateState(pastConfig, newValues, { asNode })` writes a new checkpoint whose parent is the past one (metadata.source = "fork" / "update") and returns a new config; invoking with it branches history.
- **History**: `graph.getStateHistory(config)` yields `StateSnapshot`s newest-first.

### Human-in-the-loop (dynamic interrupts)

`interrupt(payload)` inside a node throws a special exception; the checkpointer persists exact state; the payload surfaces to the caller under `__interrupt__`; the thread status becomes `interrupted`. Resume by invoking the graph with `new Command({ resume: value })` on the same thread; the value becomes the return value of the `interrupt()` call. Multiple parallel interrupts resume with a map `{ [interruptId]: value }`. Rules copied from docs: do not wrap in try/catch; matching is index-based across resumptions; only JSON-serializable payloads; code before `interrupt()` re-executes on resume so side effects must be idempotent.

Static interrupts also exist: `interruptBefore: ["node_a"]` / `interruptAfter: [...]` at compile or run time; resume with `invoke(null, config)`.

### Interrupts and errors are checkpoint writes

The persistence layer models special conditions as writes with negative indices, which is how a resumed run knows what happened:

```ts
export const WRITES_IDX_MAP: Record<string, number> = {
  [ERROR]: -1,
  [SCHEDULED]: -2,
  [INTERRUPT]: -3,
  [RESUME]: -4,
};
```

## Exact schemas and APIs (copied)

### Checkpoint (OSS JS, libs/checkpoint/src/base.ts)

```ts
export interface Checkpoint<N extends string = string, C extends string = string> {
  v: number;                                        // checkpoint format version, currently 4
  id: string;                                       // uuid6 (time-ordered)
  ts: string;                                       // new Date().toISOString()
  channel_values: Record<C, unknown>;               // the actual state
  channel_versions: Record<C, number | string>;     // monotonic per-channel versions
  versions_seen: Record<N, Record<C, number | string>>; // per-node view, drives "which nodes still need to run"
}

export interface CheckpointTuple {
  config: RunnableConfig;                 // carries configurable.thread_id / checkpoint_ns / checkpoint_id
  checkpoint: Checkpoint;
  metadata?: CheckpointMetadata;
  parentConfig?: RunnableConfig;          // parent checkpoint pointer -> history chain
  pendingWrites?: CheckpointPendingWrite[]; // writes done after this checkpoint, not yet folded in
}

export type CheckpointListOptions = {
  limit?: number;
  before?: RunnableConfig;
  filter?: Record<string, any>;
};
```

### CheckpointMetadata (libs/checkpoint/src/types.ts)

```ts
export type CheckpointMetadata<ExtraProperties extends object = object> = {
  source: "input" | "loop" | "update" | "fork";
  // -1 for the first "input" checkpoint, 0 for the first "loop" checkpoint, then n
  step: number;
  // checkpoint namespace -> checkpoint id (for subgraphs)
  parents: Record<string, string>;
} & ExtraProperties;

export type PendingWrite<Channel = string> = [Channel, unknown];
export type CheckpointPendingWrite<TaskId = string> = [TaskId, ...PendingWrite<string>];
```

### BaseCheckpointSaver contract (the whole durability interface, 5 methods)

```ts
export abstract class BaseCheckpointSaver<V extends string | number = number> {
  serde: SerializerProtocol = new JsonPlusSerializer();

  async get(config: RunnableConfig): Promise<Checkpoint | undefined>; // via getTuple

  abstract getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>;
  abstract list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple>;
  abstract put(config: RunnableConfig, checkpoint: Checkpoint,
               metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig>;
  abstract putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void>;
  abstract deleteThread(threadId: string): Promise<void>;

  // versions must be monotonically increasing; default integers +1
  getNextVersion(current: V | undefined): V;
}
```

Implementations shipped: `MemorySaver` (RAM), `SqliteSaver` (dev), `PostgresSaver` / `AsyncPostgresSaver` (prod). Constraint noted in docs: `thread_id` must be under 255 chars in the Postgres implementations.

Framework metadata keys excluded from user-facing metadata (useful when designing an events/metadata split):

```ts
EXCLUDED_METADATA_KEYS = new Set(["thread_id", "checkpoint_id", "checkpoint_ns", "checkpoint_map",
  "langgraph_step", "langgraph_node", "langgraph_triggers", "langgraph_path", "langgraph_checkpoint_ns"]);
```

### BaseStore contract (long-term memory, libs/checkpoint/src/store/base.ts)

```ts
export interface Item {
  value: Record<string, any>;   // keys are filterable
  key: string;                  // unique within namespace
  namespace: string[];          // hierarchical path, e.g. ["documents", "user123"]
  createdAt: Date;
  updatedAt: Date;
}
export interface SearchItem extends Item { score?: number } // cosine similarity if ranked

export interface SearchOperation {
  namespacePrefix: string[];
  // operators: $eq, $ne, $gt, $gte, $lt, $lte; e.g. { score: { $gt: 4.99 }, color: "red" }
  filter?: Record<string, any>;
  limit?: number;   // default 10
  offset?: number;  // default 0
  query?: string;   // natural-language semantic search (vector similarity)
}

export interface PutOperation {
  namespace: string[];
  key: string;
  value: Record<string, any> | null;  // null deletes
  index?: false | string[];           // field paths to embed: "metadata.title", "chapters[*].content"
}

export abstract class BaseStore {
  abstract batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>>;
  async get(namespace: string[], key: string): Promise<Item | null>;
  async search(namespacePrefix: string[], options?: { filter?; limit?; offset?; query? }): Promise<SearchItem[]>;
  async put(namespace: string[], key: string, value: Record<string, any>, index?: false | string[]): Promise<void>;
  async delete(namespace: string[], key: string): Promise<void>;
  async listNamespaces(options?: { prefix?; suffix?; maxDepth?; limit?; offset? }): Promise<string[][]>;
}

export interface IndexConfig {
  dims: number;              // embedding dimensionality
  embeddings: Embeddings;    // LangChain Embeddings implementation
  fields?: string[];         // default ["$"] = embed the whole document
}
```

Namespace rules enforced: non-empty, labels are strings without "." and not "", root label cannot be "langgraph".

### Platform data model (SDK schema.ts, mirrors the server's REST resources)

```ts
export type RunStatus  = "pending" | "running" | "error" | "success" | "timeout" | "interrupted";
export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";
type MultitaskStrategy = "reject" | "interrupt" | "rollback" | "enqueue";

export type Config = {
  tags?: string[];
  recursion_limit?: number;   // default 25
  configurable?: {
    thread_id?: string | null;
    checkpoint_id?: string | null;
    [key: string]: unknown;   // <- assistant-configurable fields live here
  };
};

export interface AssistantBase {
  assistant_id: string;    // uuid
  graph_id: string;        // which graph in langgraph.json
  config: Config;          // runtime config (configurable fields)
  context: unknown;        // static context (newer, LangGraph >= 0.6 style)
  created_at: string;
  metadata: Metadata;
  version: number;         // every update creates a new version
  name: string;
  description?: string;
}
export interface Assistant extends AssistantBase { updated_at: string }

export interface Thread<ValuesType = DefaultValues> {
  thread_id: string;
  created_at: string;
  updated_at: string;
  state_updated_at: string;
  metadata: Metadata;
  status: ThreadStatus;
  values: ValuesType;                                   // current state
  interrupts: Record<string, Array<Interrupt>>;         // pending interrupts by task
  config?: Config;
  error?: string | Record<string, unknown> | null;
}

export interface Interrupt<TValue = unknown> {
  id?: string;
  value?: TValue;
  namespace?: string[];   // subgraph namespace tuple, [] at root
}

export interface ThreadState<ValuesType = DefaultValues> {
  values: ValuesType;
  next: string[];                        // next nodes; empty = done until new input
  checkpoint: Checkpoint;                // { thread_id, checkpoint_ns, checkpoint_id, checkpoint_map }
  metadata: Metadata;
  created_at: string | null;
  parent_checkpoint: Checkpoint | null;  // missing = root
  tasks: Array<ThreadTask>;              // per-task result / error / interrupts
}

export interface Run {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  created_at: string;
  updated_at: string;
  status: RunStatus;
  metadata: Metadata;
  multitask_strategy: MultitaskStrategy | null;
}

export interface Cron {
  cron_id: string;
  assistant_id: string;
  thread_id: string | null;              // null = stateless cron, fresh thread per run
  on_run_completed?: "delete" | "keep";  // stateless crons only
  end_time: string | null;
  schedule: string;                      // cron format
  timezone: string | null;               // IANA
  created_at: string;
  updated_at: string;
  payload: Record<string, unknown>;      // the run-creation payload to replay
  user_id: string | null;
  next_run_date: string | null;
  metadata: Record<string, unknown>;
  enabled: boolean;
}
```

### Run creation payload (the full lever set, SDK types.ts)

```ts
export interface RunsInvokePayload {
  input?: Record<string, unknown> | null;  // null = resume from current thread state
  metadata?: Metadata;
  config?: Config;
  context?: unknown;                       // static context (added LangGraph.js 0.4)
  checkpointId?: string;                   // start from a specific checkpoint (time travel)
  checkpoint?: Omit<Checkpoint, "thread_id">;
  durability?: "exit" | "async" | "sync";  // default "async"
  interruptBefore?: "*" | string[];
  interruptAfter?: "*" | string[];
  multitaskStrategy?: "reject" | "interrupt" | "rollback" | "enqueue";
  signal?: AbortSignal;
  onCompletion?: "complete" | "continue";
  webhook?: string;                        // called when the run completes
  onDisconnect?: "cancel" | "continue";    // what happens if the stream consumer drops
  afterSeconds?: number;                   // schedule a future run
  ifNotExists?: "create" | "reject";
  command?: {                              // alternative to input:
    update?: Record<string, unknown> | [string, unknown][] | null;
    resume?: unknown;                      // value returned by interrupt()
    goto?: Send | Send[] | string | string[];
  };
}
// Streaming additions:
//   streamMode?: StreamMode | StreamMode[]   "values"|"messages"|"messages-tuple"|"updates"|"events"|"debug"|"custom"
//   streamSubgraphs?: boolean
//   streamResumable?: boolean                // persist the stream buffer; replay via Last-Event-ID
//   streamIdleReconnect?: "auto" | number    // client-side half-open socket guard (server heartbeats ~5s)
// CronsCreatePayload = RunsCreatePayload + { schedule: string; timezone?: string;
//   onRunCompleted?: "delete" | "keep"; enabled?: boolean; endTime?: string }
```

Multitask strategy semantics (copied from the source comments): reject = reject the new run; interrupt = interrupt the current run keeping steps completed so far, start the new one; rollback = cancel and delete the existing run, roll the thread back to the state before it started, then start the new run; enqueue = queue the new run behind the current one.

### REST surface (paths taken from the SDK client source)

```
Assistants:
  POST   /assistants                       { graph_id, config?, context?, metadata?, if_exists ("raise"|"do_nothing"), name?, description? }
  GET    /assistants/{id}
  PATCH  /assistants/{id}                  (full config payload required; creates a new version)
  DELETE /assistants/{id}?delete_threads=
  POST   /assistants/search                { graph_id?, name?, metadata?, limit, offset }
  GET    /assistants/{id}/versions
  POST   /assistants/{id}/latest           { version }   <- promote/rollback
  GET    /assistants/{id}/schemas          -> GraphSchema { graph_id, input_schema, output_schema, state_schema, config_schema, context_schema } (JSONSchema7)
  GET    /assistants/{id}/graph            -> nodes/edges (for visualization)

Threads:
  POST   /threads                          { thread_id?, metadata?, if_exists? }
  GET    /threads/{id}
  PATCH  /threads/{id}                     DELETE /threads/{id}
  POST   /threads/search                   POST /threads/count
  POST   /threads/{id}/copy
  GET    /threads/{id}/state               POST /threads/{id}/state (updateState: values + as_node -> fork)
  GET    /threads/{id}/state/{checkpoint_id}   POST /threads/{id}/state/checkpoint
  PATCH  /threads/{id}/state               (patchState)
  POST   /threads/{id}/history             (state history, newest first)
  GET    /threads/{id}/stream              (thread-level stream; modes: run_modes | lifecycle | state_update)

Runs:
  POST   /threads/{id}/runs                (background run; returns Run immediately)
  POST   /threads/{id}/runs/stream         (create + stream)
  POST   /threads/{id}/runs/wait           (create + block for final values)
  POST   /runs | /runs/stream | /runs/wait (stateless: no thread retained)
  POST   /runs/batch                       POST /runs/cancel (many)
  GET    /threads/{id}/runs                GET /threads/{id}/runs/{run_id}
  POST   /threads/{id}/runs/{run_id}/cancel        (?action=interrupt|rollback)
  GET    /threads/{id}/runs/{run_id}/join          (block until done, return values)
  GET    /threads/{id}/runs/{run_id}/stream        (joinStream; Last-Event-ID resume; "-" = from start)
  DELETE /threads/{id}/runs/{run_id}

Crons:
  POST   /threads/{id}/runs/crons          POST /runs/crons
  PATCH  /runs/crons/{cron_id}             DELETE /runs/crons/{cron_id}
  POST   /runs/crons/search                POST /runs/crons/count

Store:
  PUT    /store/items                      GET /store/items?namespace=..&key=..
  DELETE /store/items                      POST /store/items/search
  POST   /store/namespaces
```

Join-stream caveat from docs: "When you use .join_stream, output is not buffered, so any output produced before joining will not be received" unless the run was created with `stream_resumable: true`, in which case `Last-Event-ID` replays.

### langgraph.json (deployment manifest; from the CLI JSON schema, Node branch)

Top-level keys (Node): `node_version` ("20"+), `graphs`, `dependencies`, `env`, `checkpointer`, `store`, `http`, `auth`, `webhooks`, `encryption`, `ui`, `api_version`, `base_image` (default langchain/langgraphjs-api), `dockerfile_lines`, `image_distro`, `source`.

```jsonc
{
  "node_version": "20",
  "graphs": {
    // name -> "path/to/file.ts:exportName" or { "path": "...", "description": "..." }
    "agent": "./src/agent.ts:graph"
  },
  "env": { "KEY": "value" },            // or a path string to a .env file
  "checkpointer": {
    "path": "custom.saver:factory",     // optional custom BaseCheckpointSaver factory
    "serde": { },
    "ttl": {                             // ThreadTTLConfig
      "default_ttl": 43200,              // minutes
      "strategy": "delete",
      "sweep_interval_minutes": 60,
      "sweep_limit": 1000                // threads per sweep, default 1000
    }
  },
  "store": {
    "index": { "dims": 1536, "embed": "openai:text-embedding-3-small", "fields": ["$"] },
    "ttl": { "default_ttl": null, "refresh_on_read": true, "sweep_interval_minutes": 60 }
  },
  "http": {
    "app": "custom_app:app",             // mount a custom app
    "cors": { "allow_origins": [], "allow_methods": [], "allow_headers": [], "allow_credentials": false, "max_age": 600 },
    "configurable_headers": { },         // map request headers into run config
    "mount_prefix": "",
    "disable_assistants": false, "disable_threads": false, "disable_runs": false,
    "disable_store": false, "disable_mcp": false, "disable_a2a": false,
    "disable_ui": false, "disable_webhooks": false, "disable_meta": false,
    "enable_custom_route_auth": false
  },
  "auth": { "path": "auth.ts:auth", "disable_studio_auth": false, "openapi": { } },
  "webhooks": {
    "url": { },                          // URL validation policy for user-supplied webhook endpoints
    "headers": { },                      // static headers, values may template env vars
    "env_prefix": "WEBHOOK_"             // required prefix for env vars referenced in header templates
  }
}
```

Notable: the server ships MCP (`/mcp`) and A2A (`/a2a`) endpoints ON by default; you opt out with `disable_mcp` / `disable_a2a`.

### MCP endpoint (server-mcp docs)

- Route `/mcp` on the Agent Server, Streamable HTTP transport.
- Every assistant is auto-exposed as an MCP tool: name from the agent identifier, description from langgraph.json, input schema from the graph's typed state.
- Same auth as the rest of the API; custom auth middleware can scope tools per user.
- Stateless: "The current LangGraph MCP implementation does not support sessions. Each /mcp request is stateless and independent."
- Docs recommend explicitly typed input/output workflow state instead of raw MessagesState for clean tool schemas.

### Interrupt / resume (OSS JS, exact)

```ts
import { interrupt, Command } from "@langchain/langgraph";

async function approvalNode(state: State) {
  const approved = interrupt("Do you approve this action?"); // pauses; JSON-serializable payload
  return { approved };
}

const result = await graph.invoke({ input: "data" }, { configurable: { thread_id: "t1" } });
result.__interrupt__; // [{ value: "Do you approve this action?", id, ... }]
await graph.invoke(new Command({ resume: true }), { configurable: { thread_id: "t1" } });
// multiple parallel interrupts: new Command({ resume: { [interruptId]: value, ... } })
```

### Time travel (OSS JS, exact)

```ts
for await (const state of graph.getStateHistory(config)) states.push(state);
const replay = await graph.invoke(null, pastState.config);              // replay (re-executes!)
const forkCfg = await graph.updateState(pastState.config, { topic: "chickens" }, { asNode: "generateTopic" });
const fork = await graph.invoke(null, forkCfg);                          // fork with modified state
```

### Self-hosting and local dev

- **Local dev server**: `npx @langchain/langgraph-cli dev` (Python: `langgraph dev`). No Docker, no Postgres, no license. In-memory state with local-directory persistence, hot reload, port 2024, OpenAPI docs at /docs, Studio UI attaches via `https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:2024`, `--debug-port` for DAP attachment.
- **Production standalone server**: `langgraph build` produces a Docker image; docker-compose of three services: `langgraph-redis` (Redis 6), `langgraph-postgres` (Postgres 16), `langgraph-api` (your image). Required env: `REDIS_URI`, `DATABASE_URI`, `LANGSMITH_API_KEY`, `LANGGRAPH_CLOUD_LICENSE_KEY` (checked once at startup), optional `LANGSMITH_ENDPOINT`, `N_JOBS_PER_WORKER` (default 10).
- Options ladder: Cloud SaaS (control plane + data plane managed), Hybrid/BYOC, fully self-hosted with control plane, or standalone server without the control-plane UI. Production guidance is the LangSmith Helm chart on Kubernetes; non-K8s setups "require manual implementation of queue autoscaling, graceful draining, and version management".
- The server itself is not open source and is license-keyed; only the library (graph engine + checkpointers + store) is MIT.

## What to adopt for RFA

Ordered by leverage for the "resident agents become a daily work tool" goal. RFA anchors: hub `src/hub.ts` + `src/store.ts` (NDJSON rooms, data/), `src/client.ts` RoomMember, residents like pm-agent as `claude -p` subprocesses.

1. **The 5-resource data model, verbatim: assistants / threads / runs / checkpoints / store.** This is the entire durable-runtime vocabulary and it is proven. Add a `residents` runtime module with SQLite tables mirroring the exact field names above (`run.status` in {pending, running, error, success, timeout, interrupted}; `thread.status` in {idle, busy, interrupted, error}). Keeping their names buys free mental compatibility with every LangGraph doc and future migration.

2. **Assistants = versioned config over one agent codebase.** An RFA resident today hardwires model, prompt, knowledge pack. Adopt: `assistant = { assistant_id, graph_id (agent implementation), config: { configurable: { model, effort, system_prompt, knowledge_pack, tools_allowlist } }, context, metadata, version, name, description }`. Copy the versioning semantics exactly: every update writes a new immutable version, updates require the full payload, `setLatest(version)` promotes or rolls back. This is the cleanest known answer to "per-agent settings like model/effort" and it maps 1:1 onto RFA capability cards (card digest can pin the assistant version).

3. **Runs API discipline: background-first, one run per thread, multitask strategies.** Adopt run creation that returns immediately, a per-thread mutex, and the four-way `multitask_strategy` enum for double-texting (a human pinging a busy resident in a room is exactly this problem). Also adopt `afterSeconds` (delayed runs), `webhook` (post-completion callback: in RFA, post an envelope to the room instead), and `ifNotExists`.

4. **Resumable streams via a persisted per-run event buffer + Last-Event-ID cursor.** RFA already has exactly this shape in `room_listen` (cursor-based long-poll over NDJSON). Generalize it: every resident run appends events to its own log; the console and any client can join late and replay. This makes the run engine consistent with the room substrate instead of adding a second streaming system. Skip Redis entirely: watchers are already process-local.

5. **interrupt()/Command({resume}) as the HIL primitive, wired to existing RFA moderation.** Persist an interrupt as a special record on the run (with `id`, `value`, thread status -> `interrupted`); resume = a new run with `command: { resume: value }`. RFA already has human principals, supervisor role, and console intervention buttons: an "approve/deny resident action" flow is one schema away. Adopt the negative-index special-writes idea (ERROR -1, INTERRUPT -3, RESUME -4) so crash forensics and resume logic read from one table.

6. **Cron runs with the exact Cron shape** (`schedule` cron format, `timezone` IANA, `payload` = a stored run-creation payload, `on_run_completed: delete|keep` for stateless crons, `enabled`, `end_time`). This is the morning-brief / daily-digest mechanism for residents.

7. **A declarative manifest, rfa.json, modeled on langgraph.json.** One file per deployment declaring residents (name -> module path + description), env, checkpointer TTL, store index config, and http toggles. The `graphs: { name: "./src/agents/pm.ts:agent" }` convention plus TTL sweeper configs (`default_ttl` minutes, `sweep_interval_minutes`, `sweep_limit`) are directly reusable.

8. **Expose residents as MCP tools, auto-generated from assistants.** LangGraph validates the exact pattern RFA wants: assistant name + description + typed input schema -> MCP tool on the existing hub endpoint. RFA is already MCP-native; add a tool per resident (or keep capability-based ask) generated from the assistant record.

9. **The dev/prod split**: an in-memory `dev` mode (fast boot, no persistence guarantees) vs the durable mode, same API. RFA's e2e harness effectively wants this already.

## What to adapt

- **Postgres + Redis -> SQLite (WAL) + in-process queue.** Keep the schema and queue discipline (status transitions, per-thread lock, N_JOBS worker cap), drop the infra. Local-first, one Mac: better-sqlite3 with WAL handles this easily; Redis's only job (ephemeral pub/sub) is already served by the hub's in-process watchers. If a small server appears later, the same schema moves to Postgres unchanged.

- **Checkpoint payload for subprocess residents.** LangGraph checkpoints channel_values per super-step of a graph. RFA residents are `claude -p` conversational loops, not Pregel graphs. Adapt the contract, not the content: a resident checkpoint = `{ v, id: uuid7, ts, payload: { claude_session_id, cwd, pending_room_cursor, custom_state }, metadata: { source, step, parents } }` with a parent chain. `claude -p --resume <session_id>` is the actual resume mechanism; the checkpoint row makes it durable, listable, and forkable. Keep `getTuple/list/put/putWrites/deleteThread` as the saver interface so a future graph-based engine (or the Agent SDK) plugs into the same table.

- **Store: adopt the namespace/key/value API and filter operators now, defer vectors.** The `BaseStore` surface (hierarchical `string[]` namespaces, `$eq/$ne/$gt/$gte/$lt/$lte` filters, batch op, TTL with refresh_on_read) is ideal for resident memory scoped as `[resident, "memories"]` or `["goodvest", "facts"]`, and it composes with the existing MemoryGate (sanitize before put). Implement exact-match + filters on SQLite JSON1 first; add `IndexConfig { dims, embed, fields }` semantics later with sqlite-vec and a local embedding model. Important: route all store writes through MemoryGate, which LangGraph does not have.

- **Durability modes**: implement `"sync"` only (checkpoint before next step). The async/exit modes are throughput optimizations for hosted multi-tenant load; on local NVMe the sync write is microseconds and crash-consistency is the whole point.

- **config vs context**: LangGraph is mid-migration from `config.configurable` (config_schema) to `context` (context_schema, 0.6+). Adopt the destination, not the journey: put static per-assistant settings in `context`, keep `configurable` for per-run runtime values (thread_id, checkpoint_id, requesting room/member).

- **Time travel**: keep the parent-chain and `updateState`-fork mechanics, but document LangGraph's own caveat (replay re-executes, results may differ) and surface forks in the room console rather than a Studio clone.

- **Webhook -> room envelope.** Instead of HTTP webhooks with URL policy and header templating, a completed run posts a result envelope into the originating room (task board update). Keep an optional HTTP webhook for external integrations only.

## What to reject and why

- **Redis as a required component.** Its role (ephemeral stream pub/sub, cancellation signaling) is process-local state in a single-node deployment. RFA's watcher/waiter model already covers it. Adding Redis would violate local-first for zero gain.

- **The closed-source, license-keyed server itself.** `LANGGRAPH_CLOUD_LICENSE_KEY` checked at startup, control plane coupling, LangSmith API key requirements: structurally wrong for a personal tool on the owner's Mac. Take the shapes, not the binary. (Also rules out "just run their server with claude -p inside": the value is in the schema, which is fully documented above.)

- **Docker-mandatory deployment (langgraph build/up) for daily operation.** Plain node processes under the existing runbook (npm run start, npm run pm-agent), optionally launchd, are the right weight. Keep Docker knowledge for the eventual small-server move.

- **The full Pregel engine (channels, channel_versions, versions_seen, supersteps).** That machinery exists to make arbitrary graphs deterministic and resumable mid-superstep. RFA residents are session-resumable subprocesses; adopting Pregel would mean rewriting agents as graphs for no current benefit. Revisit only if residents become multi-node workflows; the saver interface adopted above keeps that door open.

- **JSONSchema auto-generation of config/state schemas (GET /assistants/{id}/schemas).** Nice-to-have introspection; for a solo operator, hand-written zod schemas per resident are simpler and stricter. Expose them through the existing capability card instead.

- **A2A endpoint.** RFA rooms are the agent-to-agent layer; duplicating Google's A2A surface adds a second protocol with no consumer.

- **Stateless /mcp per-request model as-is.** LangGraph's MCP endpoint is stateless by admission; RFA's whole value is standing presence and rooms. Expose residents as MCP tools, but keep session/room semantics underneath.

## Sources

- https://docs.langchain.com/langgraph-platform/langgraph-server (Agent Server architecture: API servers, queue workers, Postgres, Redis, durability modes, 1-run-per-thread, N_JOBS_PER_WORKER)
- https://github.com/langchain-ai/langgraphjs - libs/checkpoint/src/base.ts (Checkpoint v4, CheckpointTuple, BaseCheckpointSaver, WRITES_IDX_MAP, EXCLUDED_METADATA_KEYS)
- https://github.com/langchain-ai/langgraphjs - libs/checkpoint/src/types.ts (CheckpointMetadata source/step/parents, PendingWrite)
- https://github.com/langchain-ai/langgraphjs - libs/checkpoint/src/store/base.ts (BaseStore, Item, Search/Put operations, IndexConfig, namespace rules)
- https://github.com/langchain-ai/langgraphjs - libs/sdk/src/schema.ts (Assistant, Thread, ThreadState, Run, Cron, Interrupt, statuses)
- https://github.com/langchain-ai/langgraphjs - libs/sdk/src/types.ts (RunsInvokePayload, Durability, MultitaskStrategy, stream payload options)
- https://github.com/langchain-ai/langgraphjs - libs/sdk/src/client/{runs,assistants,threads,crons,store}/index.ts (exact REST endpoints and payload field mapping)
- https://github.com/langchain-ai/langgraph - libs/cli/schemas/schema.json (langgraph.json full JSON schema: Config, GraphDef, StoreConfig, IndexConfig, TTLConfig, CheckpointerConfig, ThreadTTLConfig, HttpConfig, AuthConfig, WebhooksConfig, CorsConfig)
- https://docs.langchain.com/langgraph-platform/assistants (assistant versioning semantics, full-payload updates)
- https://docs.langchain.com/langgraph-platform/streaming (stream modes, join_stream, Last-Event-ID resumability, thread stream modes)
- https://docs.langchain.com/oss/javascript/langgraph/persistence (checkpointer/store split, MemorySaver/SqliteSaver/PostgresSaver)
- https://docs.langchain.com/oss/javascript/langgraph/interrupts (interrupt(), Command({resume}), __interrupt__, rules)
- https://docs.langchain.com/oss/javascript/langgraph/use-time-travel (getStateHistory, updateState/asNode, replay caveat)
- https://docs.langchain.com/langgraph-platform/server-mcp (/mcp endpoint, assistants as MCP tools, statelessness, disable_mcp)
- https://docs.langchain.com/langgraph-platform/local-server (langgraph dev / npx @langchain/langgraph-cli dev, port 2024, in-memory)
- https://docs.langchain.com/langsmith/deploy-standalone-server (REDIS_URI, DATABASE_URI, LANGGRAPH_CLOUD_LICENSE_KEY, docker-compose trio, Helm guidance)
