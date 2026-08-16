# Evals for agents: evidence notes (dimension 09)

Researched 2026-08-16 for the RFA v0.4 "protocol demo -> daily work tool" transition.
Primary sources fetched and read: agentevals + openevals READMEs and source, LangSmith
evaluate()/Vitest docs, Braintrust run-in-code + CI docs, DeepEval README, promptfoo
config guide, OpenAI evals repo + platform graders, tau-bench (paper + types.py),
SWE-bench README, terminal-bench README + task schema. Exact schemas copied below.

Local anchors this must fit: RFA room logs are append-only NDJSON per room
(`data/rooms/<room>.ndjson`, `RfaEvent` union in `src/model.ts`: message | presence |
roster | task | system, each with `seq` and `ts`), which means every agent run is
already a replayable trajectory. The tasks profile has an evidence gate
(`evidence_required` -> `complete` carries `evidence {summary, artifacts[]}` -> sets
`verification.pending` -> a different member calls `verify` accept/reject, spec 10.2).
The existing `npm run e2e` writes `reports/latest.md`. Tests are Vitest-style via
`npm test` (48 tests). CI is explicitly deferred by the owner.

## What it is

Six tool families and three benchmark harnesses, evaluated for one question: what
should the RFA eval harness v0.4 look like for a solo TypeScript builder whose agents
already leave complete trajectories in room logs?

- **agentevals / openevals** (LangChain, MIT, npm): small evaluator libraries.
  agentevals = trajectory evaluators (exact-ish matching + LLM-as-judge over message
  lists); openevals = generic LLM-as-judge factory + string/JSON/code evaluators.
  Usable standalone, no LangSmith account needed. TypeScript-native.
- **LangSmith experiments**: hosted dataset + `evaluate()` runner + a Vitest/Jest
  integration (`langsmith/vitest`) with a local dry-run mode.
- **Braintrust**: evals-in-code (`Eval()` in `.eval.ts` files), autoevals scorers,
  `trialCount`, GitHub Action that posts score diffs on PRs. Hosted platform.
- **DeepEval**: pytest-for-LLMs, GEval rubric metrics, agent metrics
  (TaskCompletionMetric, tool correctness). Python-first, Confident AI platform pull.
- **promptfoo**: YAML config matrix runner (prompts x providers x tests) with
  assertion types incl. `llm-rubric`. Prompt-level, local, OSS.
- **OpenAI evals**: legacy repo (registry YAML + JSONL) and the newer platform
  graders API (string_check, text_similarity, score_model, python).
- **tau-bench**: the canonical agent benchmark design: tasks as
  {instruction, ground-truth actions, required outputs}, reward = final DB state hash
  match x required-output substring match, and the pass^k reliability metric.
- **SWE-bench**: verifier design via dual test sets (FAIL_TO_PASS + PASS_TO_PASS),
  docker harness, result caching by run_id + instance_id.
- **terminal-bench**: task-as-directory format (instruction + environment + test
  script + reference solution), agent/verifier separation, per-task timeouts.

## Architecture (how it actually works)

### agentevals: trajectory = OpenAI-style message list

The whole package reduces an agent run to a `ChatCompletionMessage[]` (role +
content + tool_calls). Two evaluator families:

1. **Trajectory match** (`createTrajectoryMatchEvaluator`): compares an output
   trajectory against a reference trajectory. Four `trajectoryMatchMode`s:
   - `strict`: same messages, same order, matching tool calls
   - `unordered`: same tool calls allowed in any order
   - `subset`: agent used no tools beyond the reference set
   - `superset`: agent used at least the reference tools
   Tool argument comparison is separately tunable (`toolArgsMatchMode`:
   `exact | ignore | subset | superset`, plus per-tool `toolArgsMatchOverrides`,
   which can be a custom comparator function per tool).
2. **Trajectory LLM-as-judge** (`createTrajectoryLLMAsJudge`): formats the whole
   trajectory into a judge prompt (`TRAJECTORY_ACCURACY_PROMPT`, full text copied
   below) and returns a graded result. Reference trajectory optional
   (`TRAJECTORY_ACCURACY_PROMPT_WITH_REFERENCE` variant).

Every evaluator returns the same shape: `{key, score: boolean|number, comment?}`.
This uniform result shape is the load-bearing convention: match evaluators, judges,
and hand-written scorers all interoperate, and LangSmith/Braintrust-style loggers
consume it directly.

Internally `createTrajectoryLLMAsJudge` is a thin wrapper over openevals'
`_createLLMAsJudgeScorer`: it normalizes any input (LangChain BaseMessage[],
OpenAI dicts, or `{messages: [...]}`) to an OpenAI message list, stringifies it,
and slots it into the `{outputs}` / `{reference_outputs}` template variables.
Nothing about it requires LangGraph: any system that can render its run as a
message list can use it. RFA room logs can.

### openevals: the judge factory

`createLLMAsJudge({prompt, model | judge, feedbackKey, outputSchema, continuous,
choices, useReasoning, fewShotExamples})`. Prompt is an f-string; every extra kwarg
passed at call time is formatted into the prompt, so judges are just prompt
templates plus a scoring convention: boolean by default, `continuous: true` for
0-1 floats, `choices: [...]` for a fixed score menu, `useReasoning` (default true)
makes the judge emit the comment before the score. Model strings route through
LangChain init (`"openai:gpt-5.4"`, `"anthropic:claude-..."`) or you pass a client
as `judge`. Ships prebuilt prompts (CORRECTNESS, CONCISENESS, HALLUCINATION,
RAG_GROUNDEDNESS, etc.) plus deterministic evaluators (exact match, levenshtein,
embedding similarity, `createJsonMatchEvaluator` with per-key `rubric` and
`aggregator`, `createTypeScriptEvaluator` for code).

### LangSmith: dataset -> target -> evaluators -> experiment

`evaluate(target, {data, evaluators, experimentPrefix, maxConcurrency})` runs the
target over every dataset example and applies evaluator functions
`({outputs, referenceOutputs}) => {key, score}`. The interesting piece for a solo
builder is the Vitest integration: `ls.describe` / `ls.test` make each eval case a
normal Vitest test with `{inputs, referenceOutputs}` attached, `ls.logFeedback`
records scores, and `LANGSMITH_TEST_TRACKING=false` runs the whole thing as a
plain local test suite with a local reporter, no cloud. The pattern (eval cases as
first-class test cases in the existing test runner) transfers even without the
package.

### Braintrust: evals as .eval.ts files plus PR gates

`Eval("Project", {data, task, scores, trialCount, metadata, maxConcurrency})` in a
file named `*.eval.ts`, run by `bt eval my_eval.eval.ts` (with `--watch`).
Scorers are `({input, output, expected}) => {name, score}` or autoevals imports
(`Factuality`, `Levenshtein`, ...). `trialCount: 3` reruns each case and averages,
their answer to non-determinism. CI: `braintrustdata/eval-action@v2` runs the eval
files on every PR and posts a comment with per-score diffs against the baseline
experiment (needs `pull-requests: write`). The two ideas worth stealing are the
file convention (evals live next to code, run by one command, watchable) and the
baseline-diff gate (a regression is a diff against the last accepted experiment,
not an absolute threshold).

### DeepEval: metrics as pytest asserts, agents via traces

`assert_test(LLMTestCase(input, actual_output, expected_output, retrieval_context),
[metric])` inside pytest; `deepeval test run test_x.py`. `GEval(name, criteria,
evaluation_params, threshold)` builds a rubric judge from a plain-language
criteria string. Agent metrics (TaskCompletionMetric, tool correctness) hang off
an `@observe` tracing decorator: the metric reads the recorded component trace,
not just the final output. Python-first; the TS surface is exporters into their
platform. Architecture lesson: metrics that read traces beat metrics that read
final strings, which RFA gets for free from room logs.

### promptfoo: declarative matrix, wrong altitude for rooms

`promptfooconfig.yaml` = prompts x providers x tests; each test is `vars` +
`assert[]` (`contains`, `equals`, `similar` with threshold, `llm-rubric`,
`javascript`, `cost`, `latency`). Great for single prompt-response surfaces
(the pm-agent answer prompt could be tuned with it), structurally blind to
multi-turn multi-agent trajectories: an "output" is one completion, not a log.

### OpenAI evals: registry YAML (legacy) and platform graders (current)

Legacy repo: eval = registry YAML naming a class + JSONL samples; templates for
match / includes / fuzzy match / model-graded; `oaieval` CLI. Effectively frozen
and OpenAI-account-bound. The platform Evals API replaced it with typed graders
(schemas copied below): `string_check` (eq/ne/like/ilike), `text_similarity`
(bleu/rouge/cosine/fuzzy with `pass_threshold`), `score_model` (judge with
`range` + `pass_threshold`), `python` (arbitrary `def grade(sample, item)`).
The taxonomy is a good checklist; the service is not usable here.

### tau-bench: the benchmark design to copy

Task (exact schema below) = user_id + natural-language `instruction` for a
simulated user + ground-truth `actions` (tool calls with kwargs) + `outputs`
(strings the agent must surface to the user). Reward is computed, not judged:
`r = r_action x r_output` in {0,1}, where r_action = final database state hash
equals the ground-truth annotation hash (write actions only; order-insensitive
by construction), and r_output = every annotated string appears in some agent
message (substring match). The user is an LLM (`user_strategy: llm | react |
verify | reflection`), which makes trials i.i.d. samples of the same semantic
task. **pass^k** = `E_task[(c choose k) / (n choose k)]` with c successes out of
n trials: the chance that ALL k i.i.d. trials succeed, versus pass@k's chance
that at least one does. Finding that motivated it: gpt-4o was ~61% pass^1 but
<25% pass^8 on retail; consistency is the scarce property for a tool you rely on
daily. Their fault taxonomy (`goal_partially_completed`, `used_wrong_tool`) is
auto-classified from failed trajectories.

### SWE-bench: dual test sets and cached runs

Instance = {instance_id, repo, base_commit, problem_statement, patch, test_patch,
FAIL_TO_PASS, PASS_TO_PASS}. Verifier: apply model_patch in a per-instance docker
container, run both test lists; resolved iff every FAIL_TO_PASS now passes AND
every PASS_TO_PASS still passes. The PASS_TO_PASS half is the anti-regression
insight: a fix that breaks invariants is a failure even if it fixes the target.
Harness caches by (run_id, instance_id), so reruns only pay for changed cases.

### terminal-bench: task-as-directory, agent/verifier separation

A task is a directory: `task.yaml` (instruction, difficulty, tags,
`max_agent_timeout_sec` default 180, `max_test_timeout_sec` default 30,
`test_scripts`, `run_tests_in_same_shell`), a Dockerfile/compose environment, a
reference `solution.sh`, and `tests/test_outputs.py` (pytest) which the harness
runs AFTER the agent finishes, in the same container. The agent never sees the
tests. `tb run --agent <a> --model <m> --dataset-name terminal-bench-core
--n-concurrent 8`. Design lessons: verifier lives with the task, not the harness;
per-task timeouts; a reference solution doubles as the oracle check that the task
is solvable.

## Exact schemas and APIs (copied)

### agentevals (npm i agentevals @langchain/core)

Trajectory match, TypeScript, verbatim from README:

```ts
import {
  createTrajectoryMatchEvaluator,
  type FlexibleChatCompletionMessage,
} from "agentevals";

const evaluator = createTrajectoryMatchEvaluator({
  trajectoryMatchMode: "strict",  // "strict" | "unordered" | "subset" | "superset"
  // toolArgsMatchMode: "exact" | "ignore" | "subset" | "superset"
  // toolArgsMatchOverrides: { get_weather: (a, b) => ... }
});

const result = await evaluator({ outputs, referenceOutputs });
// { key: 'trajectory_strict_match', score: false }
```

Trajectory input format (OpenAI-style messages, tool calls included):

```ts
const outputs = [
  { role: "user", content: "What is the weather in SF?" },
  {
    role: "assistant",
    content: "",
    tool_calls: [{
      function: {
        name: "get_weather",
        arguments: JSON.stringify({ city: "San Francisco" })
      },
    }]
  },
  { role: "tool", content: "It's 80 degrees and sunny in SF." },
  { role: "assistant", content: "The weather in SF is 80 degrees and sunny." },
] satisfies FlexibleChatCompletionMessage[];
```

Trajectory LLM-as-judge, verbatim:

```ts
import { createTrajectoryLLMAsJudge, TRAJECTORY_ACCURACY_PROMPT } from "agentevals";

const evaluator = createTrajectoryLLMAsJudge({
  prompt: TRAJECTORY_ACCURACY_PROMPT,
  model: "openai:o3-mini",   // any LangChain init string, or pass `judge`
});
const result = await evaluator({ outputs });
// { key: 'trajectory_accuracy', score: true, comment: '...' }
```

TRAJECTORY_ACCURACY_PROMPT, full text verbatim from `js/src/trajectory/llm.ts`:

```
You are an expert data labeler.
Your task is to grade the accuracy of an AI agent's internal trajectory.

<Rubric>
  An accurate trajectory:
  - Makes logical sense between steps
  - Shows clear progression
  - Is relatively efficient, though it does not need to be perfectly efficient
</Rubric>

First, try to understand the goal of the trajectory by looking at the input
(if the input is not present try to infer it from the content of the first message),
as well as the output of the final message. Once you understand the goal, grade the trajectory
as it relates to achieving that goal.

Grade the following trajectory:

<trajectory>
{outputs}
</trajectory>
```

WITH_REFERENCE variant adds to the rubric "Is semantically equivalent to the
provided reference trajectory" and a `<reference_trajectory>{reference_outputs}
</reference_trajectory>` block. Every evaluator returns:

```ts
{ key: string, score: boolean | number, comment?: string }
```

Graph-trajectory variants exist (`createGraphTrajectoryLLMAsJudge`,
`graphTrajectoryStrictMatch`, format `{inputs, results, steps: string[][]}`) but
are LangGraph-thread shaped.

### openevals (npm i openevals @langchain/core)

```ts
import { createLLMAsJudge, CONCISENESS_PROMPT } from "openevals";

const concisenessEvaluator = createLLMAsJudge({
  prompt: CONCISENESS_PROMPT,       // f-string; extra call kwargs get formatted in
  model: "openai:gpt-5.4",
  // judge: chatModelOrOpenAIClient,
  // feedbackKey: "conciseness",
  // continuous: true,              // 0-1 float instead of boolean
  // choices: [0.0, 0.5, 1.0],
  // useReasoning: true,            // default: judge explains, then scores
  // fewShotExamples: [...],
  // outputSchema: zodSchema,       // arbitrary structured judge output
});
const evalResult = await concisenessEvaluator({ inputs, outputs });
// { key: 'score', score: false, comment: '...' }
```

Prebuilt prompts: CORRECTNESS_PROMPT, CONCISENESS_PROMPT, HALLUCINATION_PROMPT,
ANSWER_RELEVANCE_PROMPT, CODE_CORRECTNESS_PROMPT, TOXICITY_PROMPT,
PII_LEAKAGE_PROMPT, PROMPT_INJECTION_PROMPT, RAG_HELPFULNESS_PROMPT,
RAG_GROUNDEDNESS_PROMPT, RAG_RETRIEVAL_RELEVANCE_PROMPT. Deterministic:
createExactMatchEvaluator, createLevenshteinEvaluator,
createEmbeddingSimilarityEvaluator, createJsonMatchEvaluator({aggregator, rubric,
excludeKeys}), createTypeScriptEvaluator, createCodeLLMAsJudge.

### LangSmith evaluate() + Vitest (TS)

```ts
import { evaluate } from "langsmith/evaluation";
await evaluate((inputs) => app(inputs), {
  data: datasetName,
  evaluators: [evaluatorFn],        // ({outputs, referenceOutputs}) => {key, score}
  experimentPrefix: "...",
  maxConcurrency: 4,
});
```

```ts
import * as ls from "langsmith/vitest";
ls.describe("suite", () => {
  ls.test("case", { inputs: {...}, referenceOutputs: {...} },
    async ({ inputs, referenceOutputs }) => {
      ls.logOutputs({ answer });
      ls.logFeedback({ key: "correct", score: 1 });
    });
});
// LANGSMITH_TEST_TRACKING=false -> pure local run, local reporter, no cloud
```

### Braintrust (TS)

```ts
import { Eval, initDataset } from "braintrust";
import { Factuality } from "autoevals";

Eval("My Project", {
  experimentName: "My experiment",
  data: initDataset("My Project", { dataset: "My dataset" }), // or () => [{input, expected}]
  task: async (input) => { /* run the agent */ },
  scores: [Factuality],             // ({input, output, expected}) => {name, score}
  metadata: { model: "gpt-5-mini" },
  maxConcurrency: 10,
  trialCount: 3,                    // rerun each case, average
});
```

CLI: `bt eval my_eval.eval.ts [--watch]`; files named `*.eval.ts`. CI:

```yaml
- name: Run evals
  uses: braintrustdata/eval-action@v2
  with:
    api_key: ${{ secrets.BRAINTRUST_API_KEY }}
    runtime: node
# needs permissions: pull-requests: write  -> posts score-diff comment on the PR
```

### DeepEval (Python, for the ideas)

```python
GEval(name="Correctness",
      criteria="Determine if the 'actual output' is correct based on the 'expected output'.",
      evaluation_params=[SingleTurnParams.ACTUAL_OUTPUT, SingleTurnParams.EXPECTED_OUTPUT],
      threshold=0.5)
LLMTestCase(input=..., actual_output=..., expected_output=..., retrieval_context=[...])
assert_test(test_case, [metric])          # pytest-native
evaluate([test_case], [metric])           # standalone
# component-level: @observe() + update_current_span(test_case=...)
```

### promptfoo (YAML)

```yaml
prompts: [file://prompt1.txt]
providers: [openai:gpt-5-mini]
defaultTest:
  assert:
    - type: llm-rubric
      value: does not describe self as an AI
tests:
  - vars: { language: French, input: Hello world }
    assert:
      - type: contains-json
      - type: similar
        value: was geht
        threshold: 0.6
      - type: javascript        # arbitrary JS over output
      - type: cost
      - type: latency
```

### OpenAI platform graders (JSON)

```json
{ "type": "string_check", "name": "...", "operation": "eq|ne|like|ilike",
  "input": "...", "reference": "..." }
{ "type": "text_similarity", "evaluation_metric": "fuzzy_match|bleu|gleu|meteor|cosine|rouge_l",
  "pass_threshold": 0.8, "input": "...", "reference": "..." }
{ "type": "score_model", "model": "...", "range": [0, 1], "pass_threshold": 0.7,
  "input": [{"role": "system", "content": "..."}] }
{ "type": "python", "source": "def grade(sample, item):\n    return 1.0" }
```

### tau-bench (Python, exact from tau_bench/types.py)

```python
class Action(BaseModel):
    name: str
    kwargs: Dict[str, Any]

class Task(BaseModel):
    user_id: str
    actions: List[Action]     # ground-truth write actions
    instruction: str          # given to the SIMULATED USER, not the agent
    outputs: List[str]        # strings the agent must surface to the user

class RewardResult(BaseModel):
    reward: float             # r = r_action * r_output, in {0,1}
    info: Union[RewardOutputInfo, RewardActionInfo]  # r_outputs + per-output bools | r_actions + gt_data_hash
    actions: List[Action]

class EnvRunResult(BaseModel):
    task_id: int
    reward: float
    info: Dict[str, Any]
    traj: List[Dict[str, Any]]   # the full trajectory is part of the result record
    trial: int
```

Reward: `r_action` = hash(final DB state) == hash(ground-truth DB state);
`r_output` = every `outputs[i]` appears as substring in some agent message.
Metric: `pass^k = E_task[ C(c,k) / C(n,k) ]`, c = successful trials of n.
(Contrast pass@k from HumanEval: `E[1 - C(n-c,k)/C(n,k)]`, at least one success.)
RunConfig knobs worth noting: `num_trials`, `seed`, `task_ids`, `user_strategy:
llm|react|verify|reflection`, `max_concurrency`, `log_dir`.

### SWE-bench (fields + commands)

Instance fields: `instance_id, repo, base_commit, problem_statement, patch,
test_patch, FAIL_TO_PASS, PASS_TO_PASS`. Prediction: `model_patch`.
Resolved iff all FAIL_TO_PASS pass AND all PASS_TO_PASS still pass, in docker.
`swebench eval verified -p preds.jsonl --run-id r1 -j 8`; `--gold` runs the
reference patch as an oracle; results cached by (run_id, instance_id).

### terminal-bench (task.yaml defaults)

```yaml
instruction: <english task text>
difficulty: medium            # default
tags: []
max_agent_timeout_sec: 180    # default
max_test_timeout_sec: 30      # default
test_scripts: [setup-uv-pytest.sh, run-uv-pytest.sh]
run_tests_in_same_shell: true
```

Task dir: `task.yaml` + `Dockerfile`/`docker-compose.yaml` + `solution.sh`
(reference) + `tests/test_outputs.py` (pytest, run after the agent, hidden from
it). `tb run --agent terminus --model ... --dataset-name terminal-bench-core
--dataset-version 0.1.1 --n-concurrent 8`.

## What to adopt for RFA

1. **agentevals + openevals as npm dependencies, used standalone.** MIT, TS-native,
   zero LangSmith coupling at runtime. Adopt their `{key, score, comment}` result
   shape as THE scorer interface for everything in the harness (deterministic
   checks, judges, protocol lints), so scorers compose and reports are uniform.
2. **A trajectory extractor: `rfaLogToTrajectory()`.** One pure function
   `src/evals/trajectory.ts` mapping a room NDJSON slice to
   `FlexibleChatCompletionMessage[]`: envelope kind `request` from the asker ->
   `user`; `response`/`chat` from the subject agent -> `assistant`; `room_task`
   verbs and admin verbs -> synthetic `tool_calls` entries
   (`{function: {name: "room_task.claim", arguments: JSON.stringify({task})}}`);
   `refuse` -> assistant message with the refusal JSON; other members' traffic ->
   `user`/`tool` context. This single adapter makes every agentevals evaluator
   (match modes AND judge) run unmodified over room logs. The logs already carry
   `seq`, `ts`, `conversation_id`, `task`, so slicing a trajectory = filter by
   conversation_id or task id.
3. **tau-bench's computed-reward design for the primary score.** RFA has the exact
   analog of tau-bench's final-DB-state check: the task board and the evidence
   gate. Primary reward per case, no LLM needed:
   `r = r_state x r_output x r_protocol` where
   - `r_state`: expected final task states hold (task completed, `verification
     .verdict == "accept"`, evidence non-null with artifacts when required)
   - `r_output`: `must_mention: string[]` substrings appear in the subject's
     response envelopes (tau-bench `outputs`)
   - `r_protocol`: protocol lints pass (see adapt #4).
4. **pass^k over trials as the reliability metric.** Report `pass^1` and `pass^k`
   (k=4 default) using the exact estimator `E_task[C(c,k)/C(n,k)]` with n >= k
   trials. The dogfood question "does ask-the-PM beat reading the doc" is a
   consistency question; pass^1 alone will overstate the tool's usefulness.
5. **SWE-bench's dual test sets.** Every eval case gets `must_pass` (the new
   behavior) AND `invariants` (PASS_TO_PASS analog): no unsigned-card regressions,
   leases renewed, no policy violations, no memory-gate bypass, mention-gating
   respected. A case that achieves the goal while violating an invariant fails.
6. **terminal-bench's task-as-directory with verifier-beside-task.** Eval cases
   live in `evals/cases/<case-id>/` with `case.yaml` + optional `seed/` fixtures +
   optional `reference.ndjson` (a golden trajectory promoted from a real room
   log). The verifier config is data in the case, not code in the harness. Adopt
   per-case `max_agent_timeout_sec` / `max_judge_timeout_sec` and
   `difficulty`/`tags` verbatim.
7. **Braintrust's file convention and baseline diff, minus the platform.**
   `evals/*.eval.ts` files run by `npm run evals`; each run writes
   `reports/evals/<timestamp>.json` + a markdown summary (same pattern as the
   existing `reports/latest.md`); the runner diffs against
   `evals/baseline.json` and exits nonzero on regression (score drop > epsilon on
   any case family). That is the CI gate without CI, which respects the owner's
   deferral.
8. **The evidence gate as a data flywheel.** Every real `verify` verdict in the
   standing room is a labeled trajectory (accept/reject + note, verifier id, full
   log context). Adopt Braintrust/LangSmith's "promote production traces to
   dataset" loop as `scripts/promote-case.ts <room> <task-or-conversation-id>`:
   slices the NDJSON, writes a case directory with the trajectory as reference
   and the verdict as the expected outcome. The dataset grows from real work, at
   zero annotation cost beyond verdicts already being given.
9. **LangSmith's evals-as-tests ergonomics.** Wire deterministic trajectory
   scorers into the existing Vitest suite for replay-only cases (no live model):
   `npm test` stays fast and free; the pattern is `ls.test` without the ls.

## What to adapt

1. **Judge model access: claude -p as the judge client.** openevals/agentevals
   take `model: "anthropic:..."` via LangChain init, which needs an API key. The
   owner's constraint is Claude Code auth. Adapt: implement `claudeJudge()` that
   shells `claude -p --output-format json` (or the Agent SDK) with the copied
   TRAJECTORY_ACCURACY_PROMPT wording and a JSON-schema response contract, and
   returns `{key, score, comment}`. Keep the agentevals prompt text and result
   shape exactly; swap only the transport. (openevals' `judge` parameter shows
   the seam is intended.)
2. **Trajectory judge rubric: extend, do not replace.** Start from
   TRAJECTORY_ACCURACY_PROMPT verbatim, add RFA-specific rubric bullets: used the
   room instead of guessing when a capability owner existed; correct envelope
   kinds (request/response/refuse, not chat-for-everything); refused
   out-of-scope asks with a proper `refusal.reason`; citations present when the
   card promises them (pm-agent); no fabricated evidence in `complete`. Grade
   `continuous: true` with `choices: [0, 0.25, 0.5, 0.75, 1]` for stability
   (openevals supports both; discrete choices reduce judge variance).
3. **tau-bench's LLM user simulator -> scripted-first, LLM second.** The existing
   e2e already drives scripted counterparties over the wire; keep scripted
   askers as tier-2 (deterministic, free). Add ONE LLM-simulated asker
   (haiku-class via claude -p, tau-bench `user_strategy: llm`) only for tier-3
   reliability runs where phrasing variation is the point of pass^k.
4. **Protocol lints as a scorer family.** promptfoo's assertion menu and OpenAI's
   grader taxonomy suggest small typed checks; RFA's equivalents are protocol
   assertions over raw events (not the extracted chat trajectory): every
   `request` with `reply_by` got a `response`/`refuse` in time; `gone_quiet`
   never fired for the subject; task claims were atomic (no `task_conflict`
   retries); evidence artifacts reference paths that exist. Implement as pure
   functions `(events: RfaEvent[]) => {key, score, comment}`.
5. **Dataset format: tau-bench Task + terminal-bench yaml, RFA-shaped.** Proposed
   `case.yaml` for v0.4:

   ```yaml
   id: pm-scpi-minimums
   kind: live | replay          # live = spawn hub+agents; replay = score a stored log
   difficulty: easy|medium|hard
   tags: [pm-agent, knowledge]
   subject: pm-agent            # member under evaluation, by capability not name
   setup:
     room_policy: {...}         # optional hub/room seed
     tasks: [...]               # pre-seeded board state
   drive:                       # tau-bench instruction, given to the DRIVER not the subject
     asker: scripted | llm
     instruction: "Ask what the minimum SCPI investment is and push back once."
   expect:
     must_mention: ["5 000", "catalogue"]        # tau-bench outputs[]
     final_state:                                 # r_state
       task: {state: completed, verification: {verdict: accept}}
     trajectory:                                  # agentevals match layer
       reference: reference.ndjson
       match_mode: subset
       tool_args_match_mode: ignore
     invariants: [reply-within-deadline, no-unrequested-broadcast, citations-present]
     judge:                                       # optional tier-3
       rubric: trajectory-accuracy-rfa
       min_score: 0.75
   budget:
     max_agent_timeout_sec: 120
     max_messages: 12           # cost proxy; room logs make this exact
   trials: {n: 4, report: [pass^1, pass^4]}       # tier-3 only
   ```

6. **Result records: keep the trajectory in the result** (tau-bench
   `EnvRunResult.traj`). Each run's report row stores the room log slice path +
   seq range, so any score is one command away from replay
   (`npm run tail -- data/rooms/<room>.ndjson`): scores you cannot replay are
   scores you cannot debug.
7. **Run tiers (when evals run), adapted to solo + no CI:**
   - Tier 1, every `npm test`: replay cases only. Deterministic scorers over
     checked-in NDJSON fixtures. Free, milliseconds.
   - Tier 2, `npm run evals` before commit and on demand: live scripted cases
     against a scratch hub (the e2e harness already does this), deterministic
     reward + protocol lints, baseline diff gate. Minutes, near-free.
   - Tier 3, `npm run evals:judged` weekly or after prompt/model/knowledge-pack
     changes: LLM judge + LLM asker + pass^k trials. Cost-bounded by explicit
     case list. Never in the default loop.
8. **Braintrust `trialCount` -> per-case `trials.n`** with pass^k reporting
   instead of averaging: averaging hides bimodality, which is exactly what
   tau-bench showed matters.

## What to reject and why

1. **LangSmith cloud experiments as the store.** Hosted, account-bound,
   per-seat; the value (datasets, experiment diffs, trace links) is replicated
   locally by case dirs + reports/ + NDJSON logs. Local-first constraint wins.
   Keep the client-side packages only.
2. **Braintrust platform + eval-action.** Same reason, plus the owner explicitly
   deferred CI; adopt the baseline-diff idea as a local script instead. Autoevals'
   hosted-model scorers also assume API keys we do not have.
3. **DeepEval as a dependency.** Python-first (RFA is TS-first), and the useful
   agent metrics are coupled to their `@observe` tracing and Confident AI
   platform. Steal GEval's criteria-string pattern for rubric authoring; skip
   the package.
4. **promptfoo as the harness.** Prompt-matrix altitude, single-completion
   assumption; RFA cases are multi-member trajectories with board state. Could
   return later for tuning a single agent's system prompt in isolation, but not
   the v0.4 spine.
5. **OpenAI evals (repo and platform).** Repo is legacy registry-YAML tied to
   oaieval and OpenAI models; platform graders require the OpenAI Evals API.
   Wrong vendor, no local mode. The grader taxonomy is already covered by
   openevals equivalents.
6. **Docker-per-case (SWE-bench / terminal-bench style isolation) for v0.4.**
   Correct for public benchmarks with hostile diversity; overkill for a solo
   local harness whose subjects are already sandboxed at the hub boundary. A
   scratch data dir per run (the e2e pattern) gives enough isolation; revisit
   when the runtime dimension lands real sandboxes.
7. **Graph-trajectory evaluators from agentevals.** LangGraph-thread shaped
   (`{inputs, results, steps}`); RFA's log-derived message trajectory is richer
   and already fits the flat evaluators.
8. **Judge-only scoring.** Every source that works (tau-bench, SWE-bench,
   terminal-bench) puts a computed verifier first and uses judges only where
   semantics are irreducible. RFA has computable state (board, evidence,
   envelopes); a judge-first harness would be slower, costlier, noisier, and
   would waste the evidence gate.

## Sources (URLs)

- https://github.com/langchain-ai/agentevals (README; match modes, judge API, input/output formats)
- https://raw.githubusercontent.com/langchain-ai/agentevals/main/js/src/trajectory/llm.ts (TRAJECTORY_ACCURACY_PROMPT full text)
- https://github.com/langchain-ai/openevals + https://raw.githubusercontent.com/langchain-ai/openevals/main/README.md (createLLMAsJudge params, prebuilt prompts, result shape)
- https://docs.langchain.com/langsmith/evaluate-llm-application (evaluate() TS API, dataset API)
- https://docs.langchain.com/langsmith/vitest-jest (ls.describe/ls.test/logFeedback, LANGSMITH_TEST_TRACKING=false dry-run)
- https://www.braintrust.dev/docs/evaluate/run-in-code (Eval() signature, trialCount, bt eval, .eval.ts)
- https://www.braintrust.dev/docs/evaluate/run-in-ci (braintrustdata/eval-action@v2 YAML, PR comment gate)
- https://raw.githubusercontent.com/confident-ai/deepeval/main/README.md (assert_test, GEval, LLMTestCase, @observe)
- https://www.promptfoo.dev/docs/configuration/guide/ (promptfooconfig.yaml, assertion types)
- https://raw.githubusercontent.com/openai/evals/main/README.md (registry YAML + JSONL model, status)
- https://developers.openai.com/api/docs/guides/graders (string_check, text_similarity, score_model, python grader JSON)
- https://github.com/sierra-research/tau-bench + https://raw.githubusercontent.com/sierra-research/tau-bench/main/tau_bench/types.py (Task/Action/RewardResult/EnvRunResult, RunConfig)
- https://ar5iv.labs.arxiv.org/html/2406.12045 (pass^k = E_task[C(c,k)/C(n,k)]; r = r_action x r_output; gpt-4o pass^8 < 25% retail)
- https://raw.githubusercontent.com/SWE-bench/SWE-bench/main/README.md (FAIL_TO_PASS/PASS_TO_PASS, docker harness, run_id caching)
- https://raw.githubusercontent.com/laude-institute/terminal-bench/main/README.md (task anatomy, tb run)
- terminal-bench task.yaml defaults via https://harborframework.com/docs/tasks/task-difference and https://evalscope.readthedocs.io/en/latest/third_party/terminal_bench.html (max_agent_timeout_sec 180, max_test_timeout_sec 30, test_scripts, run_tests_in_same_shell)
- Local: /Users/paulbeneteau/Dev/agent-com/src/model.ts (RfaEvent, Envelope, RfaTask, TaskEvidence), spec/RFA-0.1.md section 10.2 (evidence gate), STATUS.md (e2e reports pattern, CI deferral)
