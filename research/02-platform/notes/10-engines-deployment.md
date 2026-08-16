# 10 - Engines and deployment: durable execution, queue/worker architectures, and local-first supervision for RFA v0.4

Research date: 2026-08-16. Dimension: engines-deployment. All claims below are from fetched primary sources (docs pages, GitHub READMEs) listed in Sources. Where a doc page did not show a schema, that is said explicitly rather than invented.

Baseline being improved: RFA residents today are plain `tsx` processes started by hand (`npm run pm-agent`, nohup or a terminal tab), state in `dogfood/state/pm-agent.json`, hub started by hand with `npm run start -- --http 8790`. No supervisor, no restart policy, no durable run state beyond the hub's per-room ndjson event log and the resident's own JSON state file.

## What it is

Seven systems were examined for the primitives an agent engine needs, plus the native macOS supervision layer:

1. **Temporal**: the reference durable-execution engine. Workflows-as-code replayed from an event history; activities are the retry-able side-effect units; workers poll task queues. Ships a first-party OpenAI Agents SDK integration for TypeScript where the agent loop runs as workflow code and every model call runs as an activity.
2. **Inngest (+ AgentKit)**: event-driven durable functions over HTTP. The durability primitive is the memoized step (`step.run(id, fn)` result saved in run state, never re-executed). AgentKit layers Agent/Network/Router/State on top. Self-hostable as a single binary with SQLite + in-memory Redis by default.
3. **Restate**: single-binary durable-execution server (RocksDB storage). Journals every handler; `ctx.run` wraps non-determinism; virtual objects give keyed persistent state; installable via brew/npm and runnable locally with zero external dependencies.
4. **Hatchet**: Postgres-backed durable task queue. Tasks, workers, durable tasks with checkpoint-log replay; durable tasks are deliberately restricted to two operations (waiting, spawning child tasks).
5. **LangGraph Platform / LangSmith data plane**: the queue/worker architecture behind LangChain's managed deep agents (the anchor inspiration). Server + background worker pool + Postgres (all durable data) + Redis (wake-up sentinel, cancellation, streaming pubsub only).
6. **kagent**: Kubernetes operator for agents. Declarative Agent/ModelConfig/RemoteMCPServer CRDs reconciled by a Go controller into running engines (Python ADK or Go ADK).
7. **Cloudflare Agents SDK**: agent-as-actor. Each Agent instance is a Durable Object: embedded SQLite, synchronized state, WebSockets, and a first-class `schedule()` API. Cloud-only, but the cleanest per-agent runtime interface surveyed.
8. **Local supervision**: launchd (macOS-native LaunchAgents: `KeepAlive`, `ThrottleInterval`, log paths) and pm2 (ecosystem.config.js: `autorestart`, `max_restarts`, `min_uptime`, backoff, `kill_timeout`, `wait_ready`).

## Architecture (how it actually works)

### Temporal: replay-based durability

- A Workflow is deterministic code. Workers poll the Temporal Service for tasks, execute workflow code, and emit Commands which the service persists as Events. On crash, "the Worker uses the Event History to replay the code and recreate the state of the Workflow Execution to what it was immediately before the crash" (docs). Activities are where all I/O lives; they auto-retry per policy.
- The OpenAI Agents TS integration draws the line precisely: agent loop, tool selection, handoffs, and conversation state run inside the Workflow; every LLM call runs as an Activity via `TemporalOpenAIRunner`, "so it gets durable retry and is not re-executed during Workflow replay". Inline tools "run in the Workflow sandbox and must not perform non-deterministic activities like I/O or reading wall-clock time"; I/O tools are wrapped with `activityAsTool`.
- Local story: `temporal server start-dev` is one process, gRPC on 7233, web UI on 8233, SQLite persistence only if `--db-filename` is passed (in-memory by default, "Workflow Executions are lost when the server process dies"). Not intended for production but fine for one Mac.
- Cost of the model: every side effect must be classified workflow-vs-activity, and workflow code lives under determinism rules. For an agent brain that is a `claude -p` subprocess, essentially the whole turn is one big activity, which collapses the value of the workflow layer to retry + resume of coarse steps.

### Inngest: memoized steps over HTTP

- Functions are served by your own HTTP endpoint; the Inngest server calls into it. Steps are "checkpointed, retriable units of work": "When `step.run()` finishes successfully, the response is saved in the function run state and the step will not re-run." Step IDs are counters, so loops work without unique IDs.
- Waiting is durable and free: `step.sleep`, `step.sleepUntil`, `step.waitForEvent` (with `timeout` and an `if` CEL-ish expression matching event fields), `step.waitForSignal`. Fan-out via `step.sendEvent`; composition via `step.invoke`.
- Self-host: `inngest start --event-key abcd --signing-key 1234`; default backing stores are in-memory Redis for queue/state and SQLite at `./.inngest/main.db`; production points at external Redis/Postgres via `--redis-uri` / `--postgres-uri`. Ports 8288 (server) and 8289 (connect gateway). `--queue-workers` defaults to 100.
- AgentKit on top: `createAgent({name, system, tools, model})`, `createNetwork({agents, defaultModel})`, a Router picks the next agent each iteration, and "their system's memory is recorded as Network State which can be used by the Router, Agents or Tools."
- Cost of the model: control inversion. Your agent code becomes an HTTP handler that the engine calls, which fights RFA's shape (residents are long-lived room members holding a serve() loop and presence lease).

### Restate: journal-per-invocation, single binary

- Every handler invocation is journaled; on retry the journal replays and completed `ctx.run("name", fn)` results are returned from the journal instead of re-executed. `ctx.sleep({minutes: 5})` is a durable timer. Awakeables/signals (`ctx.signal<boolean>("approval")`) cover human-in-the-loop. Virtual objects give per-key state via `ctx.get/set/clear` with single-writer semantics per key.
- Deployment: `brew install restatedev/tap/restate-server restatedev/tap/restate` then `restate-server`; UI on 9070, ingress on 8080. State in RocksDB (tuning guidance: "rocksdb-total-memory-size should be 75% of pod requests"). Services are plain HTTP endpoints you register: `restate deployments register http://localhost:9080`. Versioning is first-class: registered deployments are immutable versions and old versions are kept until drained (the operator "manages automatic service versioning and scaling of old versions").
- This is the lightest true durable-execution engine surveyed: one brew-installable binary, no Postgres, clean TS SDK.

### Hatchet: Postgres task queue with a durable log

- "Durable tasks provide something closer to exactly-once semantics than you'd get from traditional task queues": every completed piece appends a checkpoint to a durable event log, "from which we can replay without needing to re-execute the actual application logic."
- The discipline is notable: durable tasks are restricted to two operations, waiting (sleep, event receipt) and spawning child tasks, composable with or-groups ("wait for either a sleep to complete or an event to be pushed, whichever comes first"). Everything else belongs in regular (retryable, non-durable) tasks.
- TS surface: `hatchet.task({ name, retries, fn: async (input) => ... })`; workers are "long-running processes in your infrastructure that pick up and execute tasks". Self-host needs Postgres.

### LangGraph Platform data plane: the queue/worker reference

This is the architecture under the managed deep agents that anchor this whole initiative, and it is refreshingly boring:

- **Agent Server** hosts the API; **queue workers** (a pool inside each deployment) execute runs.
- **Postgres stores everything durable**: "server resources (threads, runs, assistants, crons)" plus long-term memory store and checkpoints. **Redis stores nothing durable**: "no user or run data is stored in Redis"; it exists for worker wake-up and streaming.
- Wake-up mechanism: "A Redis list is used as a mechanism to wake up a worker as soon as a new run is created. Only a sentinel value is stored in this list, no actual run information. The run information is then retrieved from PostgreSQL by the worker." Cancellation is a Redis string + PubSub channel; streaming output goes worker -> PubSub -> server -> `/stream` clients. Retry attempt counts live in Redis, max 3 attempts per run.
- Autoscaling targets: 75% CPU/memory for API servers, 10 pending runs per queue-worker container, 30-minute scale-down cooldown.
- Managed deep agents runtime promises (feature checklist for any engine): "persistent sessions across restarts, sandboxes, durable memory, threads, cron schedules, and identity/credential management." Agent definition is a project folder: `agent.py` with `define_deep_agent(name, model, tools, middleware)`, plus optional `instructions.md`, `tools/`, `skills/`, `middleware/`, `connectors/` (MCP servers).

### kagent: declarative registry reconciled by a controller

- Four components: Go controller watching CRDs, App/Engine runtime (Python ADK default or Go ADK; Go starts in ~2s vs ~15s), CLI, dashboard. "A Kubernetes controller that watches the kagent custom resources and creates the necessary resources to run the agents."
- The valuable idea is the shape of the record, not Kubernetes: an Agent is fully described by a declarative spec referencing a ModelConfig and MCP tool servers by name (YAML copied below). Change the spec, the controller reconciles the running world to match.

### Cloudflare Agents SDK: agent-as-actor interface

- `class MyAgent extends Agent<Env, State>`: each instance is a Durable Object, "a separate micro-server that runs independently", addressed by name. Lifecycle: `onStart`, `onRequest`, `onConnect`/`onMessage`/`onClose` (WebSockets), `onStateChanged`.
- Per-agent persistence is built in: `this.state`/`setState()` (synchronized to connected clients) and `this.sql` tagged-template over embedded SQLite. Scheduling is first-class and typed (full API below): delayed seconds, absolute Date, cron, and fixed interval, with list/get/cancel.
- Cloud-only (Durable Objects), so not adoptable as infrastructure, but the interface is the best answer surveyed to "what should a resident agent's runtime API look like".

### Local supervision: launchd and pm2

- launchd LaunchAgents live in `~/Library/LaunchAgents`, one plist per job. Key semantics: `Label` (required, unique), `ProgramArguments` (argv array), `RunAtLoad` (start at login), `KeepAlive` either boolean or a condition dict (`SuccessfulExit`, `Crashed`, `PathState`, `NetworkState`), `ThrottleInterval` (min seconds between respawns; default 10), `StandardOutPath`/`StandardErrorPath`, `WorkingDirectory`, `EnvironmentVariables`, plus triggers `StartInterval`, `StartCalendarInterval`, `WatchPaths`. Modern control: `launchctl bootstrap gui/$(id -u) <plist>`, `launchctl kickstart gui/$(id -u)/<label>`, `launchctl print gui/$(id -u)`.
- pm2 gives the process-manager semantics launchd lacks: `autorestart` (default true), `max_restarts` (consecutive-crash limit), `min_uptime` (below it, an exit counts as a crash-loop), `restart_delay` / `exp_backoff_restart_delay`, `max_memory_restart` ("150M"), `kill_timeout` (SIGTERM-to-SIGKILL grace), `wait_ready` + `listen_timeout` (readiness protocol: child calls `process.send('ready')`), `cron_restart`, per-app `env`, `out_file`/`error_file`. `pm2 startup` generates the launchd hook; `pm2 save` persists the process list.

## Exact schemas and APIs (copied)

### Temporal TS + OpenAI Agents plugin (docs.temporal.io/develop/typescript/integrations/openai-agents)

```typescript
// workflow: the agent loop is workflow code, model calls become activities
import { Agent } from '@openai/agents-core';
import { TemporalOpenAIRunner } from '@temporalio/openai-agents/workflow';

export async function haikuAgentWorkflow(prompt: string): Promise<string> {
  const agent = new Agent({ name: 'Assistant', instructions: 'You only respond in haikus.', model: 'gpt-4o-mini' });
  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, prompt);
  return result.finalOutput ?? '';
}

// worker: plugin auto-registers the model activity + workflow interceptors
import { OpenAIAgentsPlugin } from '@temporalio/openai-agents';
import { NativeConnection, Worker } from '@temporalio/worker';
const plugin = new OpenAIAgentsPlugin({
  modelProvider: new OpenAIProvider(),
  modelParams: { startToCloseTimeout: '30s' },   // ModelActivityOptions; also useLocalActivity
});
const worker = await Worker.create({ connection, taskQueue: 'my-task-queue',
  workflowsPath: require.resolve('./workflows'), plugins: [plugin] });

// I/O tool = activity
import { activityAsTool } from '@temporalio/openai-agents/workflow';
const weatherTool = activityAsTool<typeof activities.getWeather>(
  { name: 'getWeather', description: 'Get the weather for a city', parameters: { /* schema */ } },
  { startToCloseTimeout: '10s', retryPolicy: { maximumAttempts: 3 } },
);
```

Local dev server: `temporal server start-dev` with flags `--db-filename/-f` (string, default in-memory SQLite), `--port/-p` (7233), `--ui-port` (port+1000 = 8233), `--headless`, `--http-port`, `--metrics-port`, `--namespace/-n` (default "default").

### Inngest steps (inngest.com/docs/learn/inngest-steps) and self-host

```typescript
const result = await step.run("step-id", async () => await someAsyncWork()); // memoized on success
await step.sleep("wait-id", "2d");
await step.sleepUntil("wait-id", new Date(event.data.remind_at));
const evt = await step.waitForEvent("wait-id", {
  event: "app/onboarding.completed", timeout: "3d",
  if: "event.data.userId == async.data.userId",
});
const signal = await step.waitForSignal("wait-id", { signal: "task/unique-id", timeout: "3d" });
const out = await step.invoke("invoke-id", { function: targetFunction, data: { /* input */ } });
await step.sendEvent("send-id", { name: "app/user.activated", data: { userId: event.data.userId } });
```

Self-host: `inngest start --event-key abcd --signing-key 1234`; defaults: in-memory Redis (queue/state) + SQLite at `./.inngest/main.db`; ports 8288/8289; `--queue-workers` default 100; env form `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_PORT`, `INNGEST_QUEUE_WORKERS`; production `--redis-uri`, `--postgres-uri`; SDK side `INNGEST_DEV=0`, `INNGEST_BASE_URL=http://localhost:8288`.

AgentKit shapes: `createAgent({ name, system, tools?, model? })`, `createNetwork({ agents, defaultModel })`, `network.run(input, routingFn)`.

### Restate TS (docs.restate.dev quickstart + concepts)

```typescript
const greeter = restate.service({
  name: "Greeter",
  handlers: {
    greet: restate.createServiceHandler(
      { input: restate.serde.schema(Greeting), output: restate.serde.schema(GreetingResponse) },
      async (ctx: restate.Context, { name }) => {
        const greetingId = ctx.rand.uuidv4();                       // deterministic-safe RNG
        await ctx.run("Notification", () => sendNotification(greetingId, name)); // journaled side effect
        await ctx.sleep({ seconds: 1 });                            // durable timer
        await ctx.run("Reminder", () => sendReminder(greetingId, name));
        return { result: `You said hi to ${name}!` };
      },
    ),
  },
});
restate.serve({ services: [greeter], port: 9080 });
```

Ops: `brew install restatedev/tap/restate-server restatedev/tap/restate`; `restate-server` (UI :9070, ingress :8080); register with `restate deployments register http://localhost:9080` or `curl localhost:9070/deployments --json '{"uri": "http://localhost:9080"}'`. State in RocksDB. Other durable primitives: `ctx.signal<boolean>("approval")`, awakeables (one-shot IDs), virtual objects (`ctx.get/set/clear` per key).

### Hatchet TS (docs.hatchet.run)

```typescript
export const simple = hatchet.task({
  name: 'simple',
  retries: 3,
  fn: async (input: SimpleInput) => ({ TransformedMessage: input.Message.toLowerCase() }),
});
```

Durable-task doctrine (copied): checkpoints are "an entry in a durable event log, from which we can replay without needing to re-execute the actual application logic"; durable tasks limited to waiting + spawning child tasks; or-groups combine "either a sleep... or an event... whichever comes first". Self-host requires Postgres.

### LangGraph data plane mechanics (docs.langchain.com/langgraph-platform/data-plane)

- Postgres: threads, runs, assistants, crons, long-term memory, checkpoints. Redis: worker wake-up sentinel list, cancellation string+PubSub, streaming PubSub, transient retry counters (max 3 attempts/run). "No user or run data is stored in Redis."
- Worker loop: sentinel pops -> worker reads full run from Postgres -> executes -> streams via PubSub -> server forwards to `/stream`.
- Scaling targets: 75% CPU/mem (API), 10 pending runs per worker container, 30-min scale-down cooldown.

### Managed deep agents definition (docs.langchain.com/langsmith/managed-deep-agents-overview)

```python
agent = define_deep_agent(
    name="research-assistant",
    model="openai:gpt-5.5",
    tools=[internet_search],
    middleware=[log_tool_calls],
)
```

Project folder: `agent.py` (required), `instructions.md`, `tools/`, `skills/` (markdown playbooks with metadata), `middleware/`, `connectors/` (MCP). Runtime: "persistent sessions across restarts, sandboxes, durable memory, threads, cron schedules, and identity/credential management". Deployed by the `mda` CLI onto LangSmith infra.

### kagent Agent CRD (kagent.dev docs/examples)

```yaml
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: my-k8s-agent
  namespace: kagent
spec:
  description: "A helpful Kubernetes assistant"
  type: Declarative
  declarative:
    modelConfig: default-model-config      # reference to a ModelConfig resource
    stream: true
    systemMessage: |
      You are an expert Kubernetes administrator...
    tools:
    - type: McpServer
      mcpServer:
        name: kagent-tool-server
        kind: RemoteMCPServer
        apiGroup: kagent.dev
      toolNames:
      - k8s_get_resources
      - k8s_get_pod_logs
```

CRD set: Agent, ModelConfig (OpenAI, Azure, Anthropic, Vertex, Ollama, custom), ToolServer/RemoteMCPServer. Controller "watches the kagent custom resources and creates the necessary resources to run the agents." Engine runtimes: Python ADK (default) or Go ADK (~2s vs ~15s startup).

### Cloudflare Agents SDK (developers.cloudflare.com/agents)

```typescript
import { Agent, routeAgentRequest } from "agents";
export class MyAgent extends Agent<Env, State> {
  // lifecycle: onStart(props?), onRequest(request), onConnect(connection, ctx),
  // onMessage(connection, message), onError(connection, error),
  // onClose(connection, code, reason, wasClean), onStateChanged(state, source)
}
// per-agent persistence
this.setState({...});                       // synchronized state
this.sql`SELECT * FROM users WHERE id = ${id}`;  // embedded SQLite

// scheduling
async schedule<T>(when: Date | string | number, callback: keyof this, payload?: T,
  options?: { retry?: RetryOptions; idempotent?: boolean }): Promise<Schedule<T>>;
async scheduleEvery<T>(intervalSeconds: number, callback: keyof this, payload?: T): Promise<Schedule<T>>;
type Schedule<T> = { id: string; callback: string; payload: T; time: number } & (
  | { type: "scheduled" } | { type: "delayed"; delayInSeconds: number }
  | { type: "cron"; cron: string } | { type: "interval"; intervalSeconds: number });
async getScheduleById(id: string): Promise<Schedule<unknown> | undefined>;
async listSchedules(criteria?): Promise<Schedule<unknown>[]>;
async cancelSchedule(id: string): Promise<boolean>;
```

### pm2 ecosystem.config.js fields (pm2.keymetrics.io)

```javascript
module.exports = { apps: [{
  name: "app1", script: "./app.js", cwd: ".", args: "", interpreter: "", interpreter_args: "",
  instances: 1, exec_mode: "fork",            // or "cluster"
  autorestart: true,                          // default true
  max_restarts: 10,                           // consecutive-crash cap
  min_uptime: 5000,                           // below this, exit counts toward crash loop
  restart_delay: 0, /* or */ exp_backoff_restart_delay: 100,
  max_memory_restart: "150M",
  kill_timeout: 1600,                         // SIGTERM -> SIGKILL grace, ms
  wait_ready: true, listen_timeout: 8000,     // child must process.send('ready')
  cron_restart: "0 4 * * *",
  watch: false, ignore_watch: [],
  env: { NODE_ENV: "production" }, env_dev: {},
  out_file: "./logs/out.log", error_file: "./logs/err.log",
}]};
```

### launchd LaunchAgent plist (launchd.info)

```xml
<!-- ~/Library/LaunchAgents/local.rfa.supervisor.plist -->
<key>Label</key><string>local.rfa.supervisor</string>          <!-- required, unique -->
<key>ProgramArguments</key><array>...</array>                  <!-- argv, [0] = executable -->
<key>RunAtLoad</key><true/>                                    <!-- start at login -->
<key>KeepAlive</key><dict>
  <key>Crashed</key><true/>            <!-- restart after crash -->
  <key>SuccessfulExit</key><false/>    <!-- do not restart after clean exit -->
  <!-- also: PathState, NetworkState -->
</dict>
<key>ThrottleInterval</key><integer>10</integer>               <!-- min seconds between respawns -->
<key>WorkingDirectory</key><string>/Users/.../agent-com</string>
<key>EnvironmentVariables</key><dict>...</dict>
<key>StandardOutPath</key><string>.../supervisor.log</string>
<key>StandardErrorPath</key><string>.../supervisor.err</string>
<!-- triggers if needed: StartInterval (secs), StartCalendarInterval, WatchPaths -->
```

Control: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.rfa.supervisor.plist`, `launchctl kickstart [-k] gui/$(id -u)/local.rfa.supervisor`, `launchctl print gui/$(id -u)`.

## What to adopt for RFA

The v0.4 engine should be: **agent registry (declarative files) -> one supervisor process (launchd-kept-alive) -> N worker processes (residents) -> durable run/step state in SQLite -> wake-up via the hub's own room_watch/tasks board.** Concretely:

1. **Declarative agent registry, kagent-shaped, as local files.** One file per resident, e.g. `agents/pm-agent.agent.json`:
   ```jsonc
   {
     "name": "pm-agent",
     "entry": "dogfood/pm-agent.ts",
     "model": "haiku",                     // per-agent model, like ModelConfig
     "effort": "medium",
     "env": { "RFA_PM_KNOWLEDGE": "..." },
     "rooms": ["r_9a25e48c0e"],
     "mcp_servers": [{ "name": "rfa-hub", "url": "http://localhost:8790/mcp" }],
     "restart": { "policy": "on-crash", "max_restarts": 10, "min_uptime_ms": 5000,
                  "backoff_ms": { "initial": 1000, "max": 60000 } },
     "drain_timeout_ms": 30000
   }
   ```
   This is kagent's Agent+ModelConfig CRD collapsed into a file, and pm2's per-app block. The supervisor reconciles registry -> running children exactly like kagent's controller reconciles CRDs -> pods. It also matches the managed-deep-agents "project folder" shape (agent def + instructions + tools + skills), which the capable-agents dimension will want.

2. **One tiny supervisor process, pm2-semantics, launchd-anchored.** Write `src/supervisor.ts` (~200-300 lines): reads the registry, `spawn`s each resident (fork mode, never cluster: residents hold a single serve() loop), and implements exactly pm2's proven policy vocabulary: `autorestart`, `max_restarts` + `min_uptime` (crash-loop detection), exponential backoff (`exp_backoff_restart_delay` equivalent), `kill_timeout` (SIGTERM, drain, then SIGKILL), `wait_ready` (child sends ready over IPC once it has joined its room). launchd keeps only the supervisor alive: `RunAtLoad` + `KeepAlive{Crashed:true, SuccessfulExit:false}` + `ThrottleInterval 10`. The hub gets its own sibling plist (it already enforces single ownership of `./data` via lockfile, so double-start is safe-loud). Rationale for not adopting pm2 itself: the supervisor needs RFA-specific health (presence leases, room re-join, drain protocol) that pm2 cannot express; but if v0.4 needs a day-one stopgap, a pm2 ecosystem.config.js with the fields above is a correct interim.

3. **Health = presence leases, not liveness probes.** RFA already has the right health primitive: a resident that fails to renew its lease is unhealthy by protocol. The supervisor joins the hub as an observer (or reads the roster over HTTP) and treats a stale lease + live process as "wedged" -> SIGTERM + restart. This is better than kagent-style HTTP probes because it measures the thing that matters (the agent is serving its room).

4. **Durable runs: LangGraph's data plane, scaled to one Mac.** Adopt the split exactly, substituting SQLite for Postgres and the hub's push for Redis: a `data/runs.db` (SQLite) with `runs(run_id, agent, room, task_id, status, input, output, attempt, created_at, updated_at)`; wake-up is the hub's existing `room_watch`/tasks-board push (the Redis sentinel's job); streaming is the room itself (messages are the stream). Copy the numbers as defaults: max 3 attempts per run, N pending runs per worker as the backpressure gauge.

5. **Durable steps: the Inngest/Restate memoized-step primitive, in the client SDK.** Add to RoomMember a run context with `await ctx.step("step-id", fn)`: result JSON persisted to `steps(run_id, step_id, seq, result_json, completed_at)`; on retry/restart of a run, completed steps return journaled results without re-execution (Inngest semantics verbatim: "the response is saved in the function run state and the step will not re-run"). This is <200 lines over SQLite and delivers 80% of what Temporal/Restate offer for RFA's needs. Include `ctx.sleepUntil(date)` (row + supervisor timer) and `ctx.waitForMessage(filter, timeout)` mapping to room_listen (the step.waitForEvent equivalent RFA gets for free from the protocol).

6. **Conversation durability via `claude -p --resume`.** The brain subprocess already has session persistence in Claude Code; store the session id in the run row so a restarted resident resumes the model conversation, not just the wire state. This substitutes for Temporal's replay of the model context at zero cost.

7. **Scheduling API: copy Cloudflare's shape onto SQLite.** Residents need cron/delayed self-invocation (daily digest, lease housekeeping). Adopt `schedule(when: Date | string | number, callback, payload)` + `Schedule<T>` discriminated union (`scheduled | delayed | cron | interval`) + `listSchedules`/`cancelSchedule`, stored in `schedules` table, fired by the supervisor. It is the cleanest agent-facing scheduling contract surveyed.

8. **Upgrade story: Restate-style versioned drain.** Deployments are immutable versions in Restate; RFA already has the analog: the signed capability card digest. Procedure per agent: supervisor SIGTERMs the child; child finishes the in-flight serve() turn, releases the floor, lets its lease lapse gracefully (or sets presence away), exits; supervisor respawns from new code; the new card digest in the roster IS the deployed-version marker, observable in the console. `rfa agents reload <name>` = that sequence; `rfa agents reload --all` iterates. No blue-green needed while the single-loop-owner constraint holds (two instances of one member id would fight over the serve loop).

## What to adapt

- **Temporal's workflow/activity boundary as a design rule, not a dependency.** Keep "everything non-deterministic behind a journaled step" (their activity discipline) inside the SDK's `ctx.step`, without adopting replay determinism for the surrounding code. RFA's serve loop stays ordinary TypeScript; only step results are journaled (Hatchet's checkpoint-log model rather than Temporal's full replay).
- **Hatchet's durable-task restriction as a spec guideline**: durable agent runs should only wait (sleep, message, task event) and spawn child work (post tasks to the board); side effects go in journaled steps. Adopting the doctrine keeps the journal small and the semantics explainable.
- **kagent's reconcile loop, minus Kubernetes**: the supervisor should treat the registry as desired state and continuously reconcile (file watch on `agents/*.agent.json` -> start/stop/restart children), not just read it at boot. `WatchPaths` on launchd can bounce the supervisor as a coarse fallback, but in-process chokidar is cheaper.
- **LangGraph autoscaling numbers -> capacity guards**: on one Mac, "scale" means refuse: a per-agent `max_concurrent_runs` (their 10-pending-runs target inverted) so a resident sheds load through the protocol (`busy` presence) rather than through memory pressure.
- **Inngest self-host topology as the growth path**: if RFA later moves to the small server, the same supervisor + SQLite design ports as-is; only if multi-machine workers appear does an external engine (Restate first, being a single binary with no Postgres) earn its place. Keep `ctx.step` signatures compatible with a future Restate `ctx.run` adapter (same name-keyed journaling shape) so migration is mechanical.
- **Cloudflare's `onStateChanged` + synchronized state**: adapt as "resident state file writes emit a room event to the console" for observability, not as a sync protocol.

## What to reject and why

- **Kubernetes and kagent as infrastructure**: a controller + CRDs + cluster for a solo operator on one Mac is pure overhead; adopted only as the shape of the registry record. Same for LangGraph Platform's Postgres+Redis pair: two servers to babysit where SQLite + the hub's own push already exist.
- **Temporal as a dependency (even start-dev)**: a second always-on service (7233/8233), determinism rules over workflow code, and a plugin surface designed for OpenAI-SDK agents. RFA's brain is a `claude -p` subprocess; a whole turn is one activity, so the engine would journal one opaque blob per turn: the cost (operational + cognitive) buys almost nothing at this scale. Revisit only if multi-day, many-step autonomous runs become the norm.
- **Inngest/AgentKit runtime**: the serve-over-HTTP inversion (engine calls your endpoint) contradicts RFA's resident model (agent owns a long-lived room membership and lease). AgentKit's Network/Router also duplicates what RFA rooms + capability discovery already are: the room IS the network, the roster IS the router's input.
- **Hatchet**: hard Postgres dependency and a cloud-oriented control plane for what SQLite covers locally; its doctrine is adopted, its runtime is not.
- **Cloudflare Agents SDK as runtime**: Durable Objects only exist on Cloudflare's edge; local-first rules it out. Interface copied, platform rejected.
- **pm2 as the permanent supervisor**: no lease-aware health, no room drain protocol, a global daemon with its own state dir; fine as interim, wrong as the end state. Similarly reject nohup/tmux (the status quo): no restart, no backoff, no logs discipline, no boot persistence.
- **Restate today**: closest external fit (single binary, brew, clean TS journaling), but it still adds a second stateful service (RocksDB) + endpoint registration for durability needs that a 200-line SQLite journal meets. Explicitly parked as the designated upgrade if step-durability needs outgrow the home-built journal (keep `ctx.step` API Restate-compatible).

## Sources (URLs)

- https://docs.temporal.io/evaluate/understanding-temporal (workflows, activities, workers, event history, replay, Commands)
- https://docs.temporal.io/develop/typescript/integrations/openai-agents (TemporalOpenAIRunner, OpenAIAgentsPlugin, activityAsTool, determinism rules, ModelActivityOptions)
- https://docs.temporal.io/cli/server (start-dev flags, SQLite --db-filename, ports 7233/8233)
- https://temporal.io/blog/announcing-openai-agents-sdk-integration and https://github.com/temporalio/sdk-python/blob/main/temporalio/contrib/openai_agents/README.md (integration scope, MCP stateless/stateful wrappers)
- https://agentkit.inngest.com/overview (createAgent/createNetwork/Router/State)
- https://www.inngest.com/docs/learn/inngest-steps (step.run/sleep/sleepUntil/waitForEvent/waitForSignal/invoke/sendEvent, memoization)
- https://www.inngest.com/docs/self-hosting (inngest start, SQLite ./.inngest/main.db, in-memory Redis, flags/env)
- https://docs.restate.dev/concepts/durable_building_blocks (journaling, ctx.run, durable timers, awakeables/signals, virtual objects)
- https://docs.restate.dev/get_started/quickstart (brew/npm install, restate.service/serve, deployments register, ports 8080/9070/9080)
- https://docs.restate.dev/deploy/server (single binary, RocksDB, operator versioning, TOML roles)
- https://docs.hatchet.run/home (tasks/workers/durable workflows, Postgres-backed)
- https://docs.hatchet.run/home/durable-execution (checkpoint event log, wait+spawn restriction, or-groups)
- https://docs.hatchet.run/home/your-first-task (hatchet.task TS shape)
- https://docs.langchain.com/langgraph-platform/data-plane (server/queue-workers/Postgres/Redis split, sentinel wake-up, cancellation, streaming, autoscaling targets)
- https://docs.langchain.com/langsmith/managed-deep-agents-overview (define_deep_agent, project folder, managed runtime feature list)
- https://github.com/kagent-dev/kagent (CRD set, controller role, ADK engines)
- https://kagent.dev/docs/kagent/concepts/architecture (controller/engine/CLI/UI, Python vs Go ADK startup)
- https://kagent.dev/docs/kagent/concepts/agents/ and https://kagent.dev/docs/kagent/examples/documentation (Agent YAML with spec.declarative.modelConfig/systemMessage/tools)
- https://developers.cloudflare.com/agents/api-reference/agents-api/ (Agent class, lifecycle, this.state/this.sql)
- https://developers.cloudflare.com/agents/api-reference/schedule-tasks/ (schedule/scheduleEvery/Schedule<T>/listSchedules/cancelSchedule)
- https://pm2.keymetrics.io/docs/usage/application-declaration/ (ecosystem.config.js field names)
- https://www.launchd.info/ (plist keys, KeepAlive dict, ThrottleInterval, launchctl bootstrap/kickstart/print)
