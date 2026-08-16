# LangSmith Observability and Evals: what to steal for RFA

Dimension: langsmith-obs-evals. Researched 2026-08-16 from primary docs (docs.langchain.com/langsmith) and the openevals/agentevals GitHub READMEs. Focus: the minimal observability + evals data model a solo operator needs on top of RFA's existing OTel spans (`rfa.{tool}` spans in `src/hub.ts` with `rfa.room` / `rfa.member` / `rfa.seq` / `rfa.error_code` attributes, SEP-414 traceparent joining) and room event logs.

## What it is

LangSmith is LangChain's observability + evals platform. Its durable contribution is not the SaaS but a small set of data-model contracts that the whole ecosystem has converged on:

- A **run tree** model (runs nested in traces, grouped into projects, threaded into sessions) with one clever encoding trick (`dotted_order`).
- A **feedback** record attached to any run: `{key, score, value, comment, correction, source}`.
- A **dataset/example/experiment** triangle: examples are `{inputs, reference outputs, metadata}`, experiments are "this app version ran over that dataset", and every experiment row is itself a full trace.
- One universal **evaluator function contract**: `({inputs, outputs, referenceOutputs, ...}) => {key, score, comment}`. Offline evaluators get reference outputs; online evaluators run on live traffic without them.
- **Automation rules** on live traffic: filter + sampling rate + action (evaluate, queue for human annotation, add to dataset, webhook, alert).
- Two MIT-licensed npm/pip packages, **openevals** (LLM-as-judge + code evaluators) and **agentevals** (trajectory evaluators), which implement that contract and work standalone, without LangSmith.

## Architecture (how it actually works)

### Tracing data model

- **Run**: "a single unit of work executed by an agent" (an LLM call, a tool call, a retrieval, a chain step). Each run is one span-like record.
- **Trace**: a collection of runs for a single operation, bound by one `trace_id`. Hard limit: 25,000 runs per trace.
- **Thread**: a sequence of traces representing one multi-turn session. Configured purely by convention: a metadata key (`thread_id`, `session_id`, or `conversation_id`) shared across traces. No schema change, just metadata.
- **Project** (internally `session`): the container for all traces of one application or service. In the API, `session_id` on a run means "tracing project id".
- **Trajectory**: a flat, ordered list of messages projecting the path an agent took, derived from the traces in a thread. This is the unit agent evals operate on.

Ingestion is dual-path: the LangSmith SDK posts runs directly, or any OTel SDK posts OTLP to `https://api.smith.langchain.com/otel/v1/traces` and LangSmith maps GenAI semantic-convention attributes onto run fields (exact mapping below). This means the run model is deliberately isomorphic to an OTel span plus LLM-specific fields (token counts, costs, run_type, inputs/outputs as structured JSON rather than flattened attributes).

### The tree encoding: dotted_order

Every run carries a `dotted_order` string: `<start_time>Z<uuid>.<child_start_time>Z<child_uuid>...`, one segment per ancestor, ending with the run itself. Invariants:

- The run's own `id` is the last 36 chars after the last `Z`.
- `trace_id` = first UUID (`split('.')[0].split('Z')[1]`).
- `parent_run_id` = penultimate UUID.
- Lexicographic sort of `dotted_order` = depth-first, time-ordered tree traversal.

One indexed string column gives you the whole tree UI query (`ORDER BY dotted_order`), subtree queries (`WHERE dotted_order LIKE prefix || '%'`), and ancestry, with no recursive CTEs. This is the single best implementation trick to copy.

### Feedback

Feedback is a first-class record attached to a run (and transitively to its trace/session). Human clicks, LLM judges, code evaluators, and API calls all write the same record, distinguished only by `feedback_source.type` (`api`, `app`, `evaluator`, model). Aggregates (`feedback_stats`) hang off runs and projects. Everything downstream (dashboards, alerts on feedback score, filters like `and(eq(feedback_key, "correctness"), lt(feedback_score, 0.5))`) is generic over this one table.

### Datasets, experiments, evaluators

- A **dataset** is a collection of **examples**; each example has `inputs`, optional reference `outputs`, optional `metadata`, and optional `split` membership (`"train"`, `["training","validation"]`...). Examples are often promoted from live runs (`source_run_id` remembers provenance). Datasets are versioned (`as_of` reads).
- An **experiment** = run the target app over a dataset, once per example (times `num_repetitions`), then run evaluators on each (run, example) pair. Each experiment row stores outputs, evaluator feedback, and the full execution trace. Experiments on the same dataset are comparable side by side.
- **Evaluator kinds**: code (deterministic), LLM-as-judge (reference-free or reference-based), human (annotation queues), pairwise (compare two outputs).
- **Summary evaluators** run once over the whole experiment (e.g., precision across all rows) instead of per row.
- **Offline vs online**: offline evaluators receive Example + Run (reference outputs available); online evaluators receive only the Run (live traffic, no references). Same output contract either way.

### Online evaluation = automation rules

A rule on a tracing project is: **filter** (same query syntax as trace search) + **sampling rate** (0 to 1) + **action**. Actions, in execution order: add to annotation queue, add to dataset, trigger webhook, run online (LLM) evaluator, run custom code evaluator, trigger alert. Rules can backfill historical runs from a start date as background jobs. LLM judge rules have per-evaluator weekly spend limits (paused at cap, reset Monday 00:00 UTC). Evaluation scores attach as feedback on the run; webhook rules can gate on `has(feedback_key, "...")` to fire only after evaluation completes. Runs touched by rules get extended data retention automatically.

### Annotation queues

A queue is configured with: name, description, optional default dataset (for one-click export of corrected examples), instructions shown to annotators, and feedback rubrics (keys with descriptions and categorical options). Reservation settings: number of reviewers per run, reservation lock duration, optional assigned reviewers with a Needs Review -> Needs Others' Review -> Completed flow. Items arrive manually (from trace views, max 100 per batch) or via automation rules. Reviewers score feedback keys, write reviewer notes, and can "Add to Dataset" with corrections, which is the flywheel: production failure -> human label -> dataset example -> regression test.

### Alerts

Five threshold metrics per project: run count, cost, errors (count or percentage), feedback score (average, per feedback key), latency (average). Config: aggregation method (Average / Percentage / Count), comparison operator, threshold value, aggregation window (5 or 15 minutes), optional filters (status, run type, tag, error field). Channels: Slack, PagerDuty (Events API v2), Dynatrace, generic webhook (custom headers + body template). Webhook payloads auto-append: `alert_rule_name`, `project_name`, `workspace_name`, `triggered_metric_value`, `triggered_threshold`, `timestamp`, `alert_rule_url`, `runs_url`.

### Dashboards

Prebuilt per project, six sections: Traces (count, latency, error rate), LLM Calls (count + latency for `run_type = "llm"`), Cost and Tokens (total and per-trace, by token type), Tools (top 5 tools: run counts, error rates, latency), Run Types (immediate children of roots, top 5), Feedback Scores (top 5 feedback keys, aggregate stats). Custom dashboards add metrics (count; latency avg/p50/p99; time-to-first-token; tokens and cost total/input/output with sum/avg/percentile; feedback score avg/min/max; custom ratio), chart types (line, stacked bar, KPI, ranked bar, donut, table), group-by (run name, run type, tag, project, metadata, feedback label), and run-level / trace-level / tree-level filter scoping.

### Self-hosting

Self-hosted LangSmith is an add-on to the Enterprise plan only. Stack: PostgreSQL (metadata, users, operational data), Redis (queuing, caching), ClickHouse (traces and feedback), optional blob storage for run inputs/outputs, an ACE (arbitrary code execution) backend for custom code evaluators, deployed via Helm on Kubernetes (GKE/EKS/AKS/OpenShift tested). Not a realistic solo-operator path.

## Exact schemas and APIs (copied)

### Run schema (LangSmith run data format)

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | unique identifier for the span |
| `name` | string | run name |
| `run_type` | string | enum below |
| `inputs` | object | for LLM runs typically `{messages: [...]}` |
| `outputs` | object | for LLM runs the returned message objects |
| `start_time` / `end_time` | datetime | |
| `error` | string | error message if any |
| `status` | string | `'pending' | 'success' | 'error'` |
| `parent_run_id` | UUID | |
| `trace_id` | UUID | |
| `dotted_order` | string | tree encoding, see above |
| `session_id` | string | tracing project id |
| `extra` | object | metadata lives in `extra.metadata` |
| `serialized` | object | serialized state of the executing object |
| `events` | array | streaming events |
| `tags` | string[] | |
| `feedback_stats` | object | aggregated feedback |
| `in_dataset` | boolean | run was promoted to a dataset |
| `reference_example_id` | UUID | set on experiment runs |
| `total_tokens` / `prompt_tokens` / `completion_tokens` | int | |
| `total_cost` / `prompt_cost` / `completion_cost` | decimal | |
| `first_token_time` | datetime | TTFT |
| `child_run_ids` / `direct_child_run_ids` / `parent_run_ids` | UUID[] | derivable from dotted_order |
| `share_token` | string | public sharing |

`run_type` enum: `chain` (a sequence or composition of steps), `llm`, `embedding`, `prompt`, `tool`, `retriever`, `parser`.

### OTLP ingestion and attribute mapping

Endpoint: `https://api.smith.langchain.com/otel/v1/traces`. Headers: `OTEL_EXPORTER_OTLP_HEADERS="x-api-key=<key>,Langsmith-Project=<project>"`. Env: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`; for LangChain apps `LANGSMITH_OTEL_ENABLED=true` + `LANGSMITH_TRACING=true`.

GenAI semconv -> run field mapping:

| OTel attribute | LangSmith field |
|---|---|
| `gen_ai.system` | `metadata.ls_provider` |
| `gen_ai.prompt` | `inputs` |
| `gen_ai.completion` | `outputs` |
| `gen_ai.prompt.{n}.role` / `.content` | `inputs.messages[n].role` / `.content` |
| `gen_ai.request.model` | `invocation_params.model` |
| `gen_ai.usage.input_tokens` / `output_tokens` | `usage_metadata.input_tokens` / `output_tokens` |

LangSmith-specific attributes (the escape hatch when semconv is not enough):

| Attribute | Maps to |
|---|---|
| `langsmith.span.kind` | run_type (`llm`, `chain`, `tool`, `retriever`, `embedding`, `prompt`, `parser`) |
| `langsmith.trace.id` / `langsmith.span.id` | trace id / run id override |
| `langsmith.trace.session_id` / `session_name` | project |
| `langsmith.span.tags` | tags (comma-separated) |
| `langsmith.metadata.{key}` | custom metadata |

### Feedback data format

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `created_at` / `modified_at` | datetime | |
| `run_id` | UUID | the run being scored |
| `session_id` | UUID | experiment or tracing project |
| `key` | string | criteria, e.g. `'correctness'` |
| `score` | number/bool | numeric or boolean score |
| `value` | string | categorical display value when not a metric |
| `comment` | string | justification / judge chain-of-thought |
| `correction` | object | ground truth for this run |
| `feedback_source` | object | `{type: 'api' | 'app' | 'evaluator' | 'model', metadata, user_id}` |
| `feedback_group_id` / `comparative_experiment_id` | UUID | pairwise grouping |

### Dataset / example API (TS SDK)

```typescript
const dataset = await client.createDataset(datasetName, { description, data_type: "kv" });
await client.createExamples({
  inputs,               // array of input objects
  outputs,              // array of reference output objects
  metadata,             // array of metadata dicts
  datasetId: dataset.id
});
// update: client.updateExample(exampleId, { inputs, outputs, metadata, split: "train" })
// splits may be string or array: ["training", "validation"]
// list with structured filters: 'and(not(has(metadata, ...)), exists(metadata, ...))'
```

### evaluate() SDK

```typescript
import { evaluate } from "langsmith/evaluation";
await evaluate(targetFunction, {
  data: datasetNameOrUuid,        // or example iterator
  evaluators: [evaluatorFns],
  summaryEvaluators,               // run once over whole experiment
  experimentPrefix: "name_prefix",
  maxConcurrency: 4,
  metadata: {...}                  // reserved keys: models, prompts, tools
});
// Python adds num_repetitions=1
```

Evaluator contract (the shape everything shares):

```typescript
function myEvaluator({ run, example, inputs, outputs, referenceOutputs }): EvaluationResult
// EvaluationResult = { key: string; score: number | boolean; comment?: string }
```

### openevals (npm `openevals`, MIT, standalone)

```typescript
import { createLLMAsJudge, CORRECTNESS_PROMPT } from "openevals";
const evaluator = createLLMAsJudge({
  prompt,            // f-string template, LangChain template, or function
  model,             // "provider:model_name" string (initChatModel)
  feedbackKey,       // defaults to "score"
  judge,             // alternative: a chat-model instance (custom judge injection point)
  outputSchema,      // Zod or JSON schema for structured judge output
  fewShotExamples,
  continuous,        // boolean: float 0-1 instead of pass/fail
  choices,           // number[]: constrained score choices
  useReasoning       // default true: judge explains in `comment`
});
const result = await evaluator({ inputs, outputs, referenceOutputs });
// => { key, score, comment }
```

Prebuilt prompts (exported string constants, usable with any judge): `CORRECTNESS_PROMPT`, `CONCISENESS_PROMPT`, `HALLUCINATION_PROMPT`, `ANSWER_RELEVANCE_PROMPT`, `CODE_CORRECTNESS_PROMPT`, `RAG_HELPFULNESS_PROMPT`, `RAG_GROUNDEDNESS_PROMPT`, `RAG_RETRIEVAL_RELEVANCE_PROMPT`, `TOXICITY_PROMPT`, `FAIRNESS_PROMPT`, `PII_LEAKAGE_PROMPT`, `PROMPT_INJECTION_PROMPT`.

Non-LLM evaluators: `create_json_match_evaluator({aggregator: "average" | "all", list_aggregator, exclude_keys, rubric, model})`; `create_embedding_similarity_evaluator()` returning `{key: 'embedding_similarity', score: 0..1}`; `create_code_llm_as_judge({prompt, model, code_extraction_strategy: "llm" | "markdown_code_blocks"})`.

### agentevals (npm `agentevals`, MIT, standalone)

```typescript
import { createTrajectoryMatchEvaluator } from "agentevals";
const evaluator = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: "strict" | "unordered" | "subset" | "superset",
  toolArgsMatchMode:   "exact" | "ignore" | "subset" | "superset",
  toolArgsMatchOverrides  // { toolName: mode | (actual, expected) => boolean }
});
// input: OpenAI-style message arrays (assistant messages carry tool_calls)
// => { key: "trajectory_strict_match" (per mode), score: boolean, comment: null }
```

```typescript
import { createTrajectoryLLMAsJudge, TRAJECTORY_ACCURACY_PROMPT } from "agentevals";
const judge = createTrajectoryLLMAsJudge({
  prompt: TRAJECTORY_ACCURACY_PROMPT,
  model: "openai:o3-mini",     // or judge injection as in openevals
  continuous, system, few_shot_examples
});
// input: outputs (message list), optional reference_outputs
// => { key: "trajectory_accuracy", score, comment: "reasoning" }
```

Graph variants for step-level control flow: `createGraphTrajectoryLLMAsJudge()`, `graphTrajectoryStrictMatch()`; input `{ inputs: list, outputs: { results: list, steps: list[] }, reference_outputs? }`.

### Automation rules and filter syntax

Rule = filter + sampling rate (0 to 1) + action(s): add to annotation queue (retention opt-out), add to dataset (opt-in), trigger webhook (opt-in), run online evaluator, run custom code evaluator, trigger alert; extend data retention always on; backfill from a start date.

Filter query language: comparators `eq, neq, gt, gte, lt, lte, has, search, in`; logic `and, or`; fields include `name, run_type, status, latency, start_time, end_time, tags, metadata_key, metadata_value, feedback_key, feedback_score, id`. Examples:

```
eq(name, "my_chain")
eq(status, "error")
gt(latency, "5s")
and(eq(run_type, "llm"), gt(latency, "2s"))
has(tags, "production")
and(eq(feedback_key, "correctness"), lt(feedback_score, 0.5))
```

### Alert config

Metric: run count | cost | errors (count or percent) | feedback score (avg, per key) | latency (avg). Aggregation: Average / Percentage / Count; window: 5 or 15 minutes; operator + threshold; optional filters. Webhook payload auto-fields: `alert_rule_name, project_name, workspace_name, triggered_metric_value, triggered_threshold, timestamp, alert_rule_url, runs_url`.

## What to adopt for RFA

1. **The run table + dotted_order, in SQLite.** Add a `runs` table next to the existing room event log: `id, name, run_type, inputs, outputs, error, status, start_time, end_time, parent_run_id, trace_id, dotted_order, project (room or agent id), tags, metadata, input_tokens, output_tokens, cost, reference_example_id`. Keep `dotted_order` exactly as specified (lexicographic sort = tree). Derive it in the RoomMember SDK and agent engine; the hub's existing `rfa.{tool}` spans become `run_type: "tool"` runs in the same tree via the already-propagated traceparent. This is a few hundred lines, not a platform.

2. **The feedback record, verbatim.** One table: `id, run_id, key, score, value, comment, correction, source_type (api|app|evaluator|model|human), source_metadata, created_at`. Human thumbs in the console, LLM judges, and code checks all write the same row. Every later feature (dashboards, alerts, filters, annotation view) reads only this table.

3. **The evaluator contract, verbatim**: `({inputs, outputs, referenceOutputs, run}) => {key, score, comment}`. It is the ecosystem-standard shape; adopting it means openevals and agentevals plug in unmodified.

4. **npm install agentevals for trajectory evals.** `createTrajectoryMatchEvaluator` is pure code (no API key, no LLM): strict/unordered/subset/superset tool-call matching with per-tool arg-match overrides. RFA already has the trajectory data (envelopes + tool spans per task); write one projector from a room task's runs to OpenAI-style messages with `tool_calls` and the whole package works. This is the highest-leverage eval for agent work: "did the pm-agent consult the right capability before answering".

5. **Examples promoted from live runs.** `examples` table: `id, dataset, inputs, outputs (reference), metadata, split, source_run_id`. The one-click loop "bad answer in the console -> correct it -> becomes a dataset example -> regression eval" is the actual product of LangSmith; it is ~1 console button + 1 table locally.

6. **Experiments as plain run groups.** An experiment = a generated project name (`experimentPrefix + timestamp`) + runs carrying `reference_example_id`. No new machinery: `npm run eval -- --dataset pm-smoke` loops examples, calls the agent, applies evaluators, writes feedback, prints a table to `reports/`. Repetitions = a loop counter.

7. **Online eval rules, miniaturized.** Per room: `{filter, sampleRate, evaluator, action}` in a JSON config. A watcher on the runs table applies code evaluators synchronously and LLM judges via a queued `claude -p` call, writing feedback rows. Adopt the filter grammar subset: `eq/neq/gt/lt/has/and/or` over `name, run_type, status, latency, tags, feedback_key, feedback_score` compiles to SQL trivially.

8. **The prebuilt dashboard section list as the console spec.** Add to the existing console: traces count + error rate + latency, LLM calls, tokens/cost per trace, top-5 tools, top-5 feedback keys. Skip a custom dashboard builder forever.

9. **GenAI semconv attribute names on engine spans.** When the agent engine emits LLM-call spans, use `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (and optionally `langsmith.span.kind`) so the same spans are readable by LangSmith cloud, Langfuse, or any OTel backend if Paul ever wants a second sink.

10. **Alerting on three metrics only**: error percentage, average latency, average feedback score per key, over a 5 or 15 minute window, delivered as a message into an #ops RFA room (dogfooding: the hub alerts through its own protocol) and optionally a macOS notification. Copy the webhook auto-fields list for the alert payload shape.

## What to adapt

- **Annotation queues -> a single review lane.** Solo operator: no reservations, no multi-reviewer states. Keep: a `needs_review` flag set by rules or manually, a console list view with rubric-driven feedback keys, keyboard next/prev, and the "Add to Dataset with correction" action writing `correction` into feedback and a new example row. That is 90 percent of the value at 5 percent of the machinery.
- **LLM-as-judge execution.** openevals' `model: "provider:model"` path assumes a LangChain chat model and an API key. Paul's constraint is Claude Code auth. Two viable adaptations: (a) pass a custom `judge` object wrapping the Agent SDK / `claude -p` (openevals accepts a judge instance); (b) skip openevals' runner and reuse only its exported prompt constants (`CORRECTNESS_PROMPT`, `HALLUCINATION_PROMPT`, `TRAJECTORY_ACCURACY_PROMPT` from agentevals) inside a small `claude -p --output-format json` judge that returns `{key, score, comment}`. Option (b) is fewer moving parts and keeps the standard contract.
- **Spend limits -> a daily judge budget counter.** LangSmith's weekly per-evaluator spend caps with Monday resets become one counter: max N judge calls per day, pause rule when hit, log it. Same protection, no billing integration.
- **Threads.** Adopt the convention (a `thread_id` metadata key across traces) rather than a schema: RFA rooms already provide the grouping (room id + task id), so map `room/task` to `thread_id` in run metadata and the multi-turn eval unit falls out for free.
- **Projects.** Map LangSmith project = RFA room (or agent) rather than inventing a new namespace. `session/project` on a run is just a string column.
- **Backfill.** Keep the idea (apply a new rule to historical runs) but as a one-shot CLI (`npm run eval:backfill -- --rule X --since date`), not a background-job system.

## What to reject and why

- **Self-hosted LangSmith.** Enterprise-only license, and the stack (ClickHouse + Postgres + Redis + ACE backend on Kubernetes via Helm) is absurd for one Mac. SQLite plus the existing hub covers the same queries at solo scale.
- **LangSmith cloud as the sink for work data.** Free tier exists and RFA's spans would map cleanly via OTLP + the attribute table above, but envelopes and pm-agent answers contain Goodvest internal data; keeping traces local-first is the point of RFA. Keep the semconv naming so this stays a reversible decision, but do not dual-write by default.
- **Custom dashboard builder** (metrics x chart types x group-bys x filter scopes). Enormous surface; the fixed prebuilt sections cover a solo operator. Build fixed console panels.
- **Pairwise / comparative experiments** (`feedback_group_id`, `comparative_experiment_id`). Real value only with teams doing A/B prompt bake-offs; two experiments side by side on the same dataset (diff two report tables) is enough here.
- **Multi-reviewer annotation machinery** (reservations, assigned reviewers, Needs Others' Review). Meaningless with one human.
- **ACE-style sandboxed custom-code evaluators as a service.** Locally, a code evaluator is just an imported TS function; the sandboxing problem belongs to the agent-engine dimension, not evals.
- **25k-runs-per-trace scale features, extended-retention tiering, share tokens.** Retention tiering becomes a simple vacuum policy (keep runs with feedback or `in_dataset` forever, prune the rest after N days); sharing is out of scope for a personal tool.
- **Reimplementing trajectory matchers.** agentevals is MIT, TypeScript, dependency-light for the code matchers; wrapping beats rewriting.

## Minimal data model summary (the actual deliverable)

Four tables + one contract on top of what RFA already has:

```
runs(id, trace_id, parent_run_id, dotted_order, name, run_type, status, error,
     start_time, end_time, project, inputs, outputs, metadata, tags,
     input_tokens, output_tokens, cost, reference_example_id, needs_review)
feedback(id, run_id, key, score, value, comment, correction,
         source_type, source_metadata, created_at)
examples(id, dataset, split, inputs, outputs, metadata, source_run_id, created_at)
eval_rules(id, project, filter, sample_rate, evaluator, action, enabled)
-- contract: evaluator({inputs, outputs, referenceOutputs, run}) => {key, score, comment}
```

Plus three processes: an ingest bridge (OTel span processor + SDK hook -> runs rows), a rule runner (watch runs, apply eval_rules, write feedback), and an experiment CLI (dataset -> agent -> evaluators -> report). The console gains: run-tree view (ORDER BY dotted_order), fixed metrics panels, review lane, add-to-dataset button.

## Sources

- https://docs.langchain.com/langsmith/observability-concepts (run/trace/thread/project/trajectory definitions, 25k limit)
- https://docs.langchain.com/langsmith/run-data-format (full run schema, run_type enum, dotted_order invariants)
- https://docs.langchain.com/langsmith/trace-with-opentelemetry (OTLP endpoint, headers, GenAI semconv and langsmith.* attribute mapping)
- https://docs.langchain.com/langsmith/feedback-data-format (feedback schema, feedback_source)
- https://docs.langchain.com/langsmith/evaluation-concepts (datasets, experiments, evaluator kinds, offline vs online, summary evaluators)
- https://docs.langchain.com/langsmith/evaluate-llm-application (evaluate() signatures, EvaluationResult)
- https://docs.langchain.com/langsmith/manage-datasets-programmatically (createDataset/createExamples/updateExample, splits, as_of filters)
- https://docs.langchain.com/langsmith/online-evaluations (rules on live traffic, sampling, spend limits, backfill, feedback gating)
- https://docs.langchain.com/langsmith/rules (rule anatomy: filter + sampling + actions, retention defaults)
- https://docs.langchain.com/langsmith/annotation-queues (queue config, reservations, reviewer flow, add-to-dataset)
- https://docs.langchain.com/langsmith/alerts (5 metrics, windows, channels, webhook auto-fields)
- https://docs.langchain.com/langsmith/dashboards (prebuilt sections, custom metrics/charts/group-bys)
- https://docs.langchain.com/langsmith/trace-query-syntax (filter operators, fields, examples)
- https://github.com/langchain-ai/openevals (createLLMAsJudge params, prebuilt prompts, json match, embedding similarity, code judge)
- https://github.com/langchain-ai/agentevals (trajectory match/LLM-judge/graph evaluators, exact params and return shapes)
- https://docs.langchain.com/langsmith/self-hosted and https://docs.langchain.com/langsmith/kubernetes (Enterprise-only, ClickHouse/Postgres/Redis/Helm stack)
