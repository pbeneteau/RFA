# 06 — The self-improving loop: eval flywheel, prompt/memory optimization, workbench gaps

Research date: 2026-08-17. Depth: SURVEY (24 primary sources). Wave 03 (the v0.5 agenda).
Context judged against: ONE operator (Paul), ONE laptop, personal Goodvest work tool, no CI (declined), no framework dependencies wanted, TypeScript + SQLite + Claude Agent SDK.
Prior art in-repo this extends: `src/evals/{trajectory,runner,judge}.ts`, `scripts/promote-case.ts`, `src/consolidate.ts`, `src/obs.ts` (runs + feedback), `dogfood/parity.ts`, console tabs Agents/Runs/Inbox.

---

## Verdict

**The flywheel is already 80% built; what is missing is not machinery but a *review discipline* and three small schema additions. Automatic prompt optimization is a REJECT at Paul's scale — not because the algorithms are immature, but because their unit of cost is a rollout, and in RFA one rollout is an 11-25 second live agent run. GEPA's own reference tutorial spends 1,643 metric calls on a 66-example task; at RFA rollout prices that is 5-18 hours of wall clock and $30-150 for a 5-case corpus.** What transfers is the *reflective* half of GEPA/ACE with the search loop deleted: one reflection pass per review cycle over the failing trajectories plus their reward components, emitting a **proposed diff** to `agent.md` that Paul applies by hand. That is exactly the human-in-the-loop shape spec 5.1 L4 already mandates, and ACE (arXiv 2510.04618) supplies the diff format that avoids destroying the prompt.

Second headline: **the current judge is mis-shaped.** `src/evals/judge.ts` uses `CHOICES = [0, 0.25, 0.5, 0.75, 1]` — a 5-point Likert in disguise, which the strongest practitioner source (updated July 2026) rejects outright, and it is unvalidated against any human label. Making it **binary pass/fail with a versioned rubric, calibrated against ~30-50 of Paul's own labels via TPR/TNR**, is a half-day change that turns a decorative number into a measurement. Position bias does not bite the current pointwise judge but bites the moment a definition A/B ships — so A/B must use pairwise + order swap + ties, and count only order-consistent verdicts (MT-Bench: GPT-4 only 65.0% order-consistent by default).

Third: **the two deferred console panels are worth building, small, and should be built in the opposite order to intuition.** The assembled-context viewer is the higher-value one (it explains *why* a run failed, is pure read-side, and RFA already owns every part of the context it assembles). The definition A/B is lower value at 5-20 cases because the statistics are too weak to decide anything a per-case reward table doesn't already show — build it as a thin comparison over the existing eval runner, not as a new execution path.

### Recommendations

| # | Recommendation | Verdict | Rationale | Effort |
|---|---|---|---|---|
| 1 | **Review lane with three deterministic queues** (failures/`needs_review`, judge-vs-computed disagreements, novelty sample), assembled by a scheduled job and posted into `#ops` | **adopt** | LangSmith's automation-rule shape is exactly `filter + sampling rate + action`; RFA already has the filter surface (`obs.db` runs+feedback), the scheduler (engine schedules) and the delivery channel (`#ops`). Only the queue query and the console lane are missing. | day |
| 2 | **Case provenance + lifecycle metadata in `case.yaml`**: `origin_run_id`, `origin_room`, `origin_seq_range`, `promoted_at`, `failure_mode`, `tier`, `last_failed_at` | **adopt** | LangSmith's example/experiment triangle keys regression tests to the production failure via `source_run_id`; without it a case cannot be re-audited or retired. This is the single cheapest anti-ossification lever. | spike |
| 3 | **Binary judge + versioned rubric + TPR/TNR calibration** against 30-50 Paul-labelled trajectories; record `rubric_hash` on every judge feedback row | **adopt** | Hamel/Shankar (mod. 2026-07-18): "Binary evaluations force clearer thinking and more consistent labeling"; use TPR/TNR on a held-out labeled set, not accuracy. Criteria drift is documented and real, so the rubric must be a versioned artifact. | day |
| 4 | **Anti-ossification rules**: every cycle must promote ≥1 new case or explicitly record "no new failure modes"; cases passing 60 days demote to a cheap smoke tier; headline is pass^1 AND pass^4, target NOT 100% | **adopt** | "If you're passing 100% of your evals, you're likely not challenging your system enough… A 70% pass rate might indicate a more meaningful evaluation." Goodhart is named explicitly in the applied-LLMs write-up. | spike |
| 5 | **Reflective diff proposal** (one LLM pass per review cycle over failing trajectories + reward components → itemized bullet deltas against `agent.md`/knowledge, written to a review file, never auto-applied) | **adapt** | GEPA's reflection minus its evolutionary search; ACE's delta-bullet curation minus its auto-merge. Cost: one call per cycle instead of 1,643. Honors spec 5.1 L4 ("consolidation MAY propose diffs, a human applies them") and 14.3 (no worm channel). | day |
| 6 | **Assembled-context viewer** in the console Runs tab: per-run itemized sections with token counts + diff vs the previous run of the same agent | **adopt** | Letta ADE's Context Window Viewer is the single best workbench idea in the whole two-wave survey; Claude Code's own `/context` proves the category list. RFA assembles blocks + MEMORY head + retrieved facts + question itself, so it can render them exactly. | day |
| 7 | **Definition A/B as a thin comparison over the existing eval runner** (two definition sources, same cases, N trials, per-case verdict pill Improvement/Regression/Tradeoff/Tie) | **adapt** | Braintrust's diff mode supplies the vocabulary and the "grade pill" idea; do NOT build a second execution path — reuse `runLive`. Statistically weak at 5-20 cases: require `trials>=4` and treat a single-case delta as anecdote. | day |
| 8 | **DSPy / GEPA / MIPROv2 / SIMBA as a wired-in optimizer** | **reject** | Python + framework wrapper around a "prompt" that in RFA is `agent.md` body + knowledge pack + tool set + room bindings — no adapter exists. And the rollout budget is the killer: the DSPy GEPA tutorial reports "approximately 1643 metric calls" at `auto="light"` on 66 train / 66 val examples. One RFA metric call = one live resident run. | — |
| 9 | **TextGrad / textual-gradient optimizers** | **reject** | Same rollout-economics problem, weaker reported gains (GPT-4o GPQA 51%→55%), Python, and the graph abstraction assumes a differentiable-ish pipeline RFA does not have. | — |
| 10 | **SEAL-style self-editing weights (RL on self-generated finetune data)** | **reject** | Requires gradient updates to model weights. Paul has a Claude subscription, not a trainable model. Not available at any price on this stack. | — |
| 11 | **Voyager-style auto-growing skill library** (agent writes and self-verifies new skills, library grows unsupervised) | **defer** | The mechanism is proven (3.3× unique items, 15.3× faster tech tree) but it depends on a *programmatic verifier* in a closed world. RFA's equivalent verifier is the human evidence gate. Revisit only if a workload appears where success is machine-checkable (e.g. a Linear document that must satisfy a schema). | — |
| 12 | **Auto-applied procedural memory** (Letta "dreaming" writing `system/` + `skills/` without review) | **reject** | Directly forbidden by spec 5.1 L4 / 14.3, and the reason is sound: room content is untrusted, so an auto-written instruction is a prompt-injection persistence channel. Letta itself ships an "Agent reviews before applying" toggle — take the *review* idea, not the auto-write. | — |
| 13 | **Multi-judge panel (PoLL)** | **defer** | The evidence is good (a panel of small models beats one big judge, ~7× cheaper, less intra-model bias) but it needs *disjoint model families*, and Paul's auth reaches only Claude. Revisit if a local model (Ollama/llama.cpp) is ever added — then haiku + local model is a genuine 2-family panel. | — |
| 14 | **Raising the judge's 50/day cap** | **reject (no change needed)** | The judge is not the cost centre. A ~30k-char trajectory ≈ ~8k input tokens; at Haiku 4.5 metered rates ($1/MTok in, $5/MTok out) that is ~$0.008/call, so 50/day ≈ $0.40/day — and via `claude -p` under the subscription it is not metered at all. The cost centre is live rollouts ($0.0898 for one scribe run). Spend the budget on trials, not judges. | — |
| 15 | **CI-based gating** | **reject (already declined)** | Recorded for completeness: the gate stays `npm run evals` + the baseline-diff exit code, invoked by hand or by a supervisor schedule that posts to `#ops`. No CI. | — |

### The concrete flywheel Paul should run

Six stages. Everything marked EXISTS is already in the repo; everything marked ADD is the delta.

```
                 ┌──────────────────────────────────────────────────────┐
                 │ 1. CAPTURE   every serve turn = a run in obs.db      │  EXISTS
                 │    run_id travels back inside the answer             │
                 └───────────────────────┬──────────────────────────────┘
                                         v
   ┌─────────────────────────────────────────────────────────────────────┐
   │ 2. SAMPLE   nightly job builds three queues, posts counts to #ops   │  ADD (rec 1)
   │    Q1 failures    : feedback.score<=0 (human thumbs-down) OR runs.needs_review
   │    Q2 disagreement: judge feedback and evaluator feedback differ by >=0.5
   │    Q3 novelty     : first run of a capability / first use of a tool /
   │                     cost or latency > p90 / gate outcome != allow
   └───────────────────────┬─────────────────────────────────────────────┘
                           v
   ┌─────────────────────────────────────────────────────────────────────┐
   │ 3. LABEL   Paul opens the console review lane, 10-20 traces/week.   │  ADD (lane)
   │    For each: binary pass/fail + a one-line critique + a failure-mode │
   │    tag from an OPEN list he extends as he goes (open coding).        │
   └───────────────────────┬─────────────────────────────────────────────┘
                           v
   ┌─────────────────────────────────────────────────────────────────────┐
   │ 4. PROMOTE  promote-case.ts on the failures worth locking in;        │  EXISTS + rec 2
   │    stamps origin_run_id / failure_mode / tier / promoted_at.         │
   │    Binary assertion first (must_mention, protocol lints, task state); │
   │    judge only where the semantics are genuinely irreducible.         │
   └───────────────────────┬─────────────────────────────────────────────┘
                           v
   ┌─────────────────────────────────────────────────────────────────────┐
   │ 5. IMPROVE  Paul edits agent.md / knowledge / retrieval hints.        │  EXISTS
   │    Assisted by: (a) the reflective diff proposal (rec 5), (b) the      │
   │    assembled-context viewer showing what the model actually saw.       │
   │    Consolidation may propose; the human applies. Always.              │
   └───────────────────────┬─────────────────────────────────────────────┘
                           v
   ┌─────────────────────────────────────────────────────────────────────┐
   │ 6. GATE     npm run evals (tier 2) before any definition edit lands; │  EXISTS
   │    npm run evals:judged + pass^4 weekly and after model/prompt/       │
   │    knowledge changes; baseline-diff exit 1 on regression.             │
   │    The parity gate stays the fast pre-flight for brain changes.       │
   └─────────────────────────────────────────────────────────────────────┘
```

**What gets promoted.** A trace becomes a case when *all three* hold: (a) Paul labelled it fail (or labelled it pass but it surprised him), (b) the failure is reproducible enough to assert on — a wrong fact, a missing citation, a violated protocol lint, a wrong Linear team — not a stylistic preference, and (c) it represents a failure *mode* not already covered by an existing case. If (c) fails, add the new example to the existing case's `must_mention` rather than creating a case; case count is the thing that ossifies.

**When.** Nightly: queue build (piggyback the existing 03:00 backup schedule). Weekly (or after any definition/model/knowledge edit): the label pass + `npm run evals:judged` with pass^4. Per-edit: `npx tsx dogfood/parity.ts` then `npm run evals` (tier 2). Never in the answer path.

**What gates it.** Three gates in ascending cost:
1. `dogfood/parity.ts` — recorded-answer parity, seconds, catches retrieval regressions (it already caught one on day one).
2. `npm run evals` — computed reward `r_state × r_output × r_protocol` over all cases, exit 1 on baseline regression. **This is the only gate allowed to block.**
3. `npm run evals:judged` + pass^4 — advisory, weekly. A judge score MUST NOT block a promotion; it can only flag `needs_review`.

**Anti-ossification, explicitly.** (i) The baseline JSON records the definition hash it was measured against, so a diff is meaningful. (ii Each case carries `last_failed_at`; a case that has passed for 60 days and whose `failure_mode` has a newer representative demotes to `tier: smoke` (still run as cheap replay, excluded from the headline). (iii) Each review cycle must either promote a new case or write one line into the cycle log: "reviewed N traces, no new failure modes" — that is the saturation signal ("if ~20 traces don't turn up a new category, you can stop"). (iv) The headline metric is pass^1 *and* pass^4, never a single "% passing", and 100% is treated as a warning, not a win. (v) The judge rubric is a versioned file whose hash is recorded on each judge feedback row, so criteria drift is visible in the data instead of silently rewriting history.

### Verdict on automatic optimization: research toy *at his scale*, and the cost math is the reason

The algorithms work. The published numbers are real and recent (GEPA revised 2026-02-14; ACE Oct 2025). The blocker is arithmetic:

| Quantity | Value | Source |
|---|---|---|
| GEPA `auto="light"` budget, real tutorial | **~1,643 metric calls** = "12.45 full evaluations on the train+val set combined", train 66 / val 66 / test 68 | https://dspy.ai/tutorials/gepa_facilitysupportanalyzer/ |
| MIPROv2 recommended corpus | "**200 examples or more**" for the full version | https://raw.githubusercontent.com/stanfordnlp/dspy/main/docs/docs/learn/optimization/optimizers.md |
| One RFA "metric call" | one live resident run: **~11s typical, ~25s long** (haiku pm-agent), **$0.0898** measured for one sonnet scribe run | `STATUS.md` findings ledger |
| 1,643 rollouts at RFA prices | **~5 h serial at 11s** (18 h at 40s), **$33 (haiku) to $148 (sonnet)** | derived |
| Paul's realistic corpus | **5 cases today**, 10-20 realistic | `evals/cases/` + `agents/*/evals/cases/` |

Two independent disqualifications on top of the arithmetic:

1. **No adapter exists for RFA's unit of optimization.** DSPy optimizes a `Signature`'s instruction string and demos inside a Python program. RFA's optimizable surface is an `agent.md` frontmatter + markdown body + `knowledge/**` retrieval hints + tool allow/deny + `offers` + room bindings. Wiring DSPy in means either reimplementing the resident inside DSPy (throwing away the Agent SDK, sessions, the gate, the room) or writing a Python↔hub bridge whose only job is to burn rollouts. Both violate "no framework dependencies".
2. **The optimizers cannot discover new failures, only fit known ones** — stated plainly by the strongest practitioner source: automated tools "can refine a prompt to perform better on known failures, but it cannot discover *new* ones", and the pragmatic path is "use LLMs to improve your prompt based on open coding (open-ended notes about traces)", saving automated optimization "for that last mile of performance". At 5 cases Paul is nowhere near the last mile; he is in the discovery phase, where the bottleneck is *his attention on traces*, not search over prompt space.

**What survives, and is worth wiring:** the *reflection* step. GEPA's own claim is that "it can often turn even just a few rollouts into a large quality gain" *because* it reflects in natural language over trajectories instead of scalar rewards — and RFA already produces exactly the input that makes reflection good: a trajectory (`rfaLogToTrajectory`) plus reward *components* (not just a scalar) plus protocol lint names. Feeding that to one model call and asking for an itemized diff proposal is a ~150-line script with a ~$0.02 cost per cycle. It is GEPA's insight without GEPA's budget, and it lands as a *file for review*, not an applied change. Ship that; skip the optimizer.

**What would change my mind:** (a) an eval corpus that reaches ~50 cases *and* a case set that can run replay-only (no live rollout) for most of the metric calls — replay rollouts are nearly free, and a replay-only reward surface would drop GEPA's budget from hours to minutes; (b) a rollout cost under ~$0.005 and ~2s (e.g. a scored replay harness with a cached brain); (c) a TypeScript reimplementation of GEPA's Pareto loop small enough to own (~300 lines: candidate pool, per-instance score matrix, reflection proposer, merge) — plausible, and much more attractive than importing DSPy, but only worth it after (a).

---

## Evidence

### 1. Eval-flywheel practice in 2026

#### 1.1 The strongest practitioner source (updated July 2026)

"LLM Evals: Everything You Need to Know" — Hamel Husain & Shreya Shankar. **Published 2025-05-28, last modified 2026-07-18.** https://hamel.dev/blog/posts/evals-faq/

Verbatim and near-verbatim answers relevant to every design decision below:

- **Sample size for error analysis**: review "at least 100 traces" as a baseline; saturation rule — "if ~20 traces don't turn up a new category, you can stop (but review at least 100 to start)". Ongoing: "at least 100+ fresh traces each review cycle", typical interval 2-4 weeks; between major analyses, review 10-20 traces weekly focusing on outliers.
- **Binary over Likert**: "Binary evaluations force clearer thinking and more consistent labeling. Likert scales introduce significant challenges: the difference between adjacent points (like 3 vs 4) is subjective and inconsistent across annotators." Likert also needs larger samples for significance, and annotators "often default to middle values to avoid making hard decisions."
- **Judge agreement**: use **Cohen's Kappa** for multiple annotators (chance-corrected); for an LLM judge, target high **TPR and TNR on a held-out labeled test set**, "rather than overall accuracy."
- **CI datasets**: "small (in many cases 100+ examples)" covering "core features, regression tests for past bugs, and known edge cases"; favour "assertions or other deterministic checks over LLM-as-judge evaluators" due to cost.
- **Automated prompt optimization (DSPy/GEPA)**: automated tools "can refine a prompt to perform better on known failures, but it cannot discover *new* ones." Pragmatic approach: "use LLMs to improve your prompt based on open coding (open-ended notes about traces)". Save automated optimization "for that last mile of performance."
- **Criteria drift**: "evaluation criteria tends to shift after reviewing a model's outputs, a phenomenon known as 'criteria drift'"; re-run error analysis "when making significant changes: new features, prompt updates, model switches, or major bug fixes."
- **Overfitting**: "Be wary of optimizing for high eval pass rates. If you're passing 100% of your evals, you're likely not challenging your system enough… A 70% pass rate might indicate a more meaningful evaluation that's actually stress-testing your application."
- **Synthetic data**: use structured *dimensions*, "Create 20 tuples by hand", then two-step generation. Avoid for "complex domain-specific content", low-resource languages, high-stakes domains.

Companion artifact: `hamelsmu/evals-skills` (published 2026-03-02, mod. 2026-08-15) — https://github.com/hamelsmu/evals-skills/blob/main/questions.md — sections cover binary-over-Likert, error analysis before metrics, "code-based checks come before LLM judges", evaluator design, RAG/agent evaluation, CI/CD integration, review-tool building, annotation tooling, A/B frameworks. Quoted principle from it: "error analysis must come before writing evaluators: users need evaluation criteria to grade outputs, but grading outputs helps users define criteria."

#### 1.2 The multi-author practitioner consensus (2024, still the reference)

"What We've Learned From A Year of Building with LLMs" — Eugene Yan, Bryan Bischof, Charles Frye, Hamel Husain, Jason Liu, Shreya Shankar. **2024-06-08.** https://applied-llms.org/

- Evals from production: "Create unit tests (i.e., assertions) consisting of samples of inputs and outputs from production, with expectations for outputs based on at least three criteria."
- Dogfooding: "using your product as intended for customers (i.e., 'dogfooding') can provide insight into failure modes on real-world data." (RFA already does this; the finding ledger is the proof.)
- Judge mechanics (four rules, all cheap): **pairwise** — "Instead of asking the LLM to score a single output on a Likert scale, present it with two options and ask it to select the better one"; **position swap** — "do each pairwise comparison twice, swapping the order of pairs each time"; **allow ties** — "allow the LLM to declare a tie"; **CoT** — "Asking the LLM to explain its decision before giving a final answer can increase eval reliability."
- The "intern test": "If you took the exact input to the language model, including the context, and gave it to an average college student in the relevant major as a task, could they succeed?" — the design brief for the assembled-context viewer (§5).
- Goodhart, named: "When a measure becomes a target, it ceases to be a good measure", with the concrete case that "an overemphasis on NIAH evals can reduce performance on extraction and summarization tasks."
- Criteria drift, named: "developers' perceptions of what constitutes 'good' and 'bad' outputs shift as they interact with more data (i.e., criteria drift)."

#### 1.3 The automation shape worth copying (and its exact fields)

LangSmith **automation rules** — https://docs.langchain.com/langsmith/rules

Verbatim structure: a rule is **a filter + a sampling rate + an action**. Available actions, exact names and descriptions:

| Action | Description (verbatim) |
|---|---|
| Add to dataset | "Add the inputs and outputs of the trace to a dataset" |
| Add to annotation queue | "Add the matching run/trace to an annotation queue as a run item" |
| Trigger webhook | "Trigger a webhook with the trace data" |
| Extend data retention | "Extends the data retention period on matching traces that use base retention" |

Sampling: "You can specify a sampling rate between 0 and 1 for automations" — 0.5 processes 50% of matching traces. Rules also keep **execution logs** (runs processed in a timeframe, error messages, backfill progress, per-run "View run"). No documented API/SDK for rule creation — UI only. Documented canonical use cases: "sending all traces with negative feedback to an annotation queue for human review", and "sending 10% of all traces to an annotation queue for human review to spot check for issues."

Trace→dataset promotion (UI path) — https://docs.langchain.com/langsmith/manage-datasets : filter traces in the project view by evaluation score or other criteria, then "multi-select runs to add to the dataset, and click **Add to Dataset**." Programmatic filtering exists via `list_examples` with `metadata` and `splits`.

**Read for RFA:** the four actions collapse to two Paul needs — *add to dataset* is `promote-case.ts`, *add to annotation queue* is the console review lane. The sampling rate is the novelty queue's knob. The rule *engine* is unnecessary: three SQL queries over `obs.db` in a scheduled job give the same result with no new abstraction. Note the negative signal too: LangSmith gates dataset-from-trace behind manual multi-select — even the vendor whose business is this does not auto-promote failures into the regression set. Neither should RFA.

#### 1.4 Anthropic's own eval-design doc

"Define success criteria and build evaluations" — https://platform.claude.com/docs/en/test-and-evaluate/develop-tests (note: the older `test-and-evaluate/eval-tool` URL now **redirects to this page**; UNVERIFIED whether the hosted Console eval tool still exists as a separate product — the dedicated docs page no longer resolves).

Load-bearing guidance: SMART criteria; "Be task-specific — mirror your real-world task distribution and include edge cases"; "**Prioritize volume over quality** — More test cases with automated grading beats fewer hand-graded evaluations"; "Best practice: Use a different model for evaluation than the model being evaluated" (relevant to self-preference, §4); LLM-graded examples use `max_tokens=50` to keep grader output terse. Grading methods enumerated: exact match, cosine similarity, ROUGE-L, LLM Likert 1-5, LLM binary classification, LLM ordinal 1-5. Edge cases they insist on including: irrelevant/nonexistent input data, overly long input, harmful/irrelevant user input, "ambiguous test cases where humans would struggle", sarcasm, typos, "long, rambling questions with irrelevant information."

Tension to record honestly: Anthropic's page offers Likert/ordinal graders as first-class, while the practitioner sources reject them. Resolution for RFA: keep the *ordinal* only for advisory signals, use *binary* for anything that gates.

---

### 2. Automatic prompt / definition optimization: state of the art, judged at 10-100 examples on a laptop

#### 2.1 DSPy optimizer roster (primary doc, from the repo)

https://raw.githubusercontent.com/stanfordnlp/dspy/main/docs/docs/learn/optimization/optimizers.md

| Optimizer | Class | Recommended train examples | Cost note (verbatim where given) |
|---|---|---|---|
| LabeledFewShot | `dspy.LabeledFewShot` | — (args `k`, `trainset`) | — |
| BootstrapFewShot | `dspy.BootstrapFewShot` | **~10 examples** | "around $2 USD and takes around ten minutes" |
| BootstrapFewShotWithRandomSearch | `dspy.BootstrapFewShotWithRandomSearch` | **50+ examples** | similar per-run to BootstrapFewShot |
| KNNFewShot | `dspy.KNNFewShot` | — | — |
| COPRO | `dspy.COPRO` (arg `depth`) | — | instruction-only coordinate ascent |
| MIPROv2 | `dspy.MIPROv2` (`metric`, `auto`, `num_threads`) | **200+ examples** for longer runs | "can cost as little as a few cents or up to tens of dollars" |
| SIMBA | `dspy.SIMBA` | — | stochastic mini-batch; introspects high-variance failures, emits self-reflective rules or adds demos |
| GEPA | `dspy.GEPA` | see §2.2 | see §2.2 |
| BootstrapFinetune | `dspy.BootstrapFinetune` | — | requires weight tuning |
| Ensemble / BetterTogether | `dspy.Ensemble`, `dspy.BetterTogether` | — | — |

Verbatim selection guidance: "If you have **very few examples** (around 10), start with `BootstrapFewShot`." / "If you have **more data** (50 examples or more), try `BootstrapFewShotWithRandomSearch`." / "If you prefer to do **instruction optimization only**, use `MIPROv2` configured for 0-shot optimization." / "If you're willing to use more inference calls…and have enough data (e.g. 200 examples or more), then try `MIPROv2`."

**Judged against Paul's corpus (5-20 cases):** only `BootstrapFewShot` is in-range by example count — and it optimizes *demonstrations*, which is the one thing an RFA resident cannot easily consume (its "demos" would be full room trajectories injected into a system prompt whose cache Paul depends on). Everything instruction-shaped starts at 50-200 examples.

#### 2.2 GEPA — the strongest 2026 result, and its real budget

Paper: **"GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning"**, Lakshya A Agrawal, Shangyin Tan, Dilara Soylu, Noah Ziems, Rishi Khare, Krista Opsahl-Ong, Arnav Singhvi, Herumb Shandilya, Michael J Ryan, Meng Jiang, Christopher Potts, Koushik Sen, Alexandros G. Dimakis, Ion Stoica, Dan Klein, Matei Zaharia, Omar Khattab. **Submitted 2025-07-25, revised 2026-02-14.** https://arxiv.org/abs/2507.19457

Abstract, verbatim (the load-bearing sentences): "…we introduce GEPA (Genetic-Pareto), a prompt optimizer that thoroughly incorporates natural language reflection to learn high-level rules from trial and error. Given any AI system containing one or more LLM prompts, GEPA samples trajectories (e.g., reasoning, tool calls, and tool outputs) and reflects on them in natural language to diagnose problems, propose and test prompt updates, and combine complementary lessons from the Pareto frontier of its own attempts. As a result of GEPA's design, it can often turn even just a few rollouts into a large quality gain. Across six tasks, GEPA outperforms GRPO by 6% on average and by up to 20%, while using up to 35x fewer rollouts. GEPA also outperforms the leading prompt optimizer, MIPROv2, by over 10% (e.g., +12% accuracy on AIME-2025), and demonstrates promising results as an inference-time search strategy for code optimization."

API — https://dspy.ai/api/optimizers/GEPA/overview/ — constructor, verbatim:

```python
dspy.GEPA(
    metric: GEPAFeedbackMetric,
    *,
    auto: Literal['light', 'medium', 'heavy'] | None = None,
    max_full_evals: int | None = None,
    max_metric_calls: int | None = None,
    reflection_lm: LM | None = None,
    candidate_selection_strategy: Literal['pareto', 'current_best'] = 'pareto',
    reflection_minibatch_size: int = 3,
    skip_perfect_score: bool = True,
    add_format_failure_as_feedback: bool = False,
    instruction_proposer: ProposalFn | None = None,
    component_selector: ReflectionComponentSelector | str = 'round_robin',
    use_merge: bool = True,
    max_merge_invocations: int | None = 5,
    num_threads: int | None = None,
    failure_score: float = 0.0,
    perfect_score: float = 1.0,
    log_dir: str | None = None,
    track_stats: bool = False,
    use_wandb: bool = False, wandb_api_key: str | None = None, wandb_init_kwargs: dict | None = None,
    track_best_outputs: bool = False,
    warn_on_score_mismatch: bool = True,
    use_mlflow: bool = False,
    seed: int | None = 0,
    gepa_kwargs: dict | None = None,
)
```

Constraint, verbatim: "Exactly one of `auto`, `max_full_evals`, or `max_metric_calls` must be provided." `reflection_lm` is mandatory unless a custom `instruction_proposer` is supplied; docs note "GEPA performs best with models like `dspy.LM(model='gpt-5', temperature=1.0, max_tokens=32000)`."

**The feedback-metric contract — this is the part RFA already satisfies:**

```python
def metric(gold: Example, pred: Prediction, trace=None, pred_name=None,
          pred_trace=None, program_trace=None) -> float | ScoreWithFeedback:
    # return a scalar, or {'score': float, 'feedback': str}
```

The protocol "accepts rich textual feedback alongside scores, enabling domain-aware optimization informed by execution logs, validation failures, and error messages." RFA's `computeReward` already returns `{score, components, comment}` — i.e. a `ScoreWithFeedback` in all but name. **The signal exists; the rollout budget does not.**

Sizing guidance, verbatim: "Provide the smallest valset that is just large enough to match your downstream task distribution, while keeping trainset as large as possible." With no `valset`, GEPA uses `trainset` for both and behaves as an inference-time search strategy.

Real measured budget — https://dspy.ai/tutorials/gepa_facilitysupportanalyzer/ :

```python
optimizer = GEPA(
    metric=metric_with_feedback,
    auto="light",
    num_threads=32,
    track_stats=True,
    use_merge=False,
    reflection_lm=dspy.LM(model="gpt-5", temperature=1.0, max_tokens=32000, api_key=api_key),
)
```
Dataset: **train 66 / val 66 / test 68**. Unoptimized test score 75.4% (51.3/68); optimized val score 86.1% (56.83/66), converged after 9 iterations. Consumption: "**approximately 1643 metric calls**", representing "12.45 full evaluations on the train+val set combined". Note `num_threads=32` — the wall-clock number in the tutorial assumes 32-way parallelism, which RFA cannot do (per-member serve loops, `member_rpm` room budgets, one laptop).

#### 2.3 Textual gradients

"TextGrad: Automatic 'Differentiation' via Text" — Mert Yuksekgonul, Federico Bianchi, Joseph Boen, Sheng Liu, Zhi Huang, Carlos Guestrin, James Zou. **Submitted 2024-06-11.** https://arxiv.org/abs/2406.07496 . LLMs "backpropagate textual feedback" through a computation graph; PyTorch-shaped API. Reported: GPT-4o zero-shot GPQA 51% → 55%; LeetCode-Hard "20% relative performance gain"; molecule design and radiotherapy-planning case studies. The arXiv abstract page carries no journal-publication note (UNVERIFIED: I could not confirm from a primary source whether a peer-reviewed journal version exists; do not cite one). Judged: same rollout economics as GEPA with smaller reported deltas, plus a Python graph abstraction RFA has no analogue for. **Reject.**

#### 2.4 Anthropic / OpenAI first-party prompt tooling

- **Anthropic prompt improver**: the documented URL `platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompt-improver` and `.../prompting-tools` both **redirect to "Prompting best practices"** as of 2026-08-17. That page's substantive guidance on examples is the usable part: "Include 3–5 examples for best results. You can also ask Claude to evaluate your examples for relevance and diversity, or to generate additional ones based on your initial set." Secondary reporting (weak evidence, recorded as such) attributes to the improver a chain-of-thought section, restructuring, prefill, error handling, and reports "30% accuracy improvement" on a classification prompt and "100% adherence to word count requirements" on a summarisation prompt — https://claude.com/blog/prompt-improver . **UNVERIFIED: whether the Console prompt improver and hosted eval tool still ship as products in 2026-08.** Treat the pattern (LLM rewrites the prompt from examples + feedback) as available for free by simply asking Claude Code — no product needed.
- **OpenAI**: wave 02 established that OpenAI killed the hosted Evals platform and Reusable Prompts (both off 2026-11-30), pointing users at open-source Promptfoo. Nothing to adopt; the deprecation record is itself the recommendation to keep the loop in-repo.
- **The pattern that IS worth copying, from Anthropic engineering** ("Writing effective tools for agents — with agents", **2025-09-11**, https://www.anthropic.com/engineering/writing-tools-for-agents ), verbatim: "You can even let agents analyze your results and improve your tools for you. Simply concatenate the transcripts from your evaluation agents and paste them into Claude Code." The article shows human-written vs Claude-optimized tool performance graphs for Slack and Asana. No iteration count, signal definition, or improvement percentage is given for the analyse-and-rewrite loop itself (I looked; it isn't there). **This is the cheapest usable version of "automatic optimization": concatenate failing trajectories → one Claude pass → a proposed diff.** That is recommendation 5.

---

### 3. Procedural memory that improves itself

#### 3.1 Reflexion — the origin of "store the critique, not the weights"

"Reflexion: Language Agents with Verbal Reinforcement Learning" — Noah Shinn, Federico Cassano, Edward Berman, Ashwin Gopinath, Karthik Narasimhan, Shunyu Yao. **Submitted 2023-03-20, final revision 2023-10-10.** https://arxiv.org/abs/2303.11366 . Agents "verbally reflect on task feedback signals", store the reflections in an **episodic memory buffer**, and use them on subsequent attempts. Feedback may be "scalar values or free-form language", from external or internally simulated sources. Reported: **HumanEval 91% pass@1** vs GPT-4's 80% SOTA at the time. Read for RFA: RFA already has the episode log (`state/memory.db` `episodes`); Reflexion's contribution is that the *critique text* is the durable artifact, which maps onto the review-lane critique field (rec 3) and the reflective diff input (rec 5).

#### 3.2 Voyager — the skill library, and why it needs a verifier

"Voyager: An Open-Ended Embodied Agent with Large Language Models" — Guanzhi Wang, Yuqi Xie, Yunfan Jiang, Ajay Mandlekar, Chaowei Xiao, Yuke Zhu, Linxi Fan, Anima Anandkumar. **Submitted 2023-05-25, revised 2023-10-19.** https://arxiv.org/abs/2305.16291 . Skills stored as **executable code** in an "ever-growing skill library"; behaviours are "temporally extended, interpretable, and compositional" and composable. The growth loop is "a new iterative prompting mechanism that incorporates environment feedback, execution errors, and self-verification for program improvement", all via black-box queries (no finetuning). Reported: **3.3× more unique items, 2.3× longer distances, 15.3× faster tech-tree milestones**, plus generalization to novel worlds.

Read for RFA: the library grows unsupervised *because Minecraft is a verifier*. RFA's verifier is a human (the evidence gate, the approval card). Therefore: **defer** — the shape returns the day a workload has machine-checkable success (a Linear document that must contain named sections; a form validation that must pass a test). Note that RFA's `skills/` directory in each pack is already the right container; what is missing is not storage but a verifier that licenses unsupervised writes.

#### 3.3 ACE — the diff format to copy

"Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models" — **arXiv:2510.04618** (Oct 2025). https://arxiv.org/abs/2510.04618 · full text https://arxiv.org/html/2510.04618v1 · code https://github.com/ace-agent/ace

Mechanism: three roles. **Generator** produces reasoning paths (highlighting effective strategies and common mistakes); **Reflector** extracts lessons; **Curator** synthesizes lessons into compact updates and merges them.

Representation, verbatim in substance: context is "structured, itemized bullets" rather than one block of text. Each bullet carries **metadata (a unique identifier and counters tracking helpful/harmful markings)** plus content (reusable strategies, domain concepts, failure modes). "This itemized design enables localization, fine-grained retrieval, and incremental adaptation."

Update mechanism: **delta contexts** — small sets of candidate bullets — never a monolithic rewrite. **Grow-and-refine**: append bullets with new identifiers, update existing bullets in place (incrementing counters), de-duplicate via semantic embeddings (proactively or lazily).

The failure it is designed to prevent, quoted from the paper's case study: at step 60 the context held "18,282 tokens and achieved an accuracy of 66.7", and "at the very next step it collapsed to just 122 tokens, with accuracy dropping to 57.1 — worse than the baseline accuracy of 63.7." The paper names two named pathologies: **brevity bias** (dropping domain insight for concise summaries) and **context collapse** (iterative rewriting erodes detail).

Numbers: **+10.6% on agents, +8.6% on finance** vs strong baselines. Offline (AppWorld) **82.3% latency reduction, 75.1% fewer rollouts vs GEPA**; online (FiNER) **91.5% latency reduction, 83.6% lower token cost vs Dynamic Cheatsheet**. Crucially: **"average improvement of 14.8% over the ReAct baseline" without ground-truth labels**, using execution feedback (code success/failure) instead. Offline = optimize on a train split, evaluate test with pass@1; online = evaluate sequentially, predicting then updating context per sample.

**Read for RFA — this is the single most directly transferable finding in the dimension.** Do not let any diff proposer rewrite `agent.md` wholesale. The proposal format is:

```yaml
# reports/reflect/<ts>/proposal.yaml   (written for review, never applied)
target: agents/pm-agent/agent.md        # or knowledge/<file>.md, or memory/blocks/<b>.md
basis:
  cycle: 2026-08-24
  runs: [run_abc, run_def]              # the failing runs this was derived from
  failure_modes: [wrong-source-file, missing-citation]
  reward_components: {r_state: 1, r_output: 0, r_protocol: 1}
deltas:
  - op: add                             # add | revise | retire
    id: b-014                           # stable id, never reused
    section: "Retrieval hints"
    text: "For fee questions, read knowledge/product.md before knowledge/glossary.md."
    evidence: run_abc                   # the trace that motivated it
    helpful: 0                          # counters, updated by later cycles
    harmful: 0
  - op: revise
    id: b-007
    was:  "Cite your sources."
    text: "Cite sources as file paths in the structured sources part, not in prose."
    evidence: run_def
```

Rules that fall straight out of the ACE findings: (i) `op: retire` marks, never deletes (mirrors the FactStore's invalidate-never-delete rule, spec 5.1 L3); (ii) a bullet with `harmful > helpful` over 3 cycles is proposed for retirement; (iii) no proposal may reduce a target file's bullet count by more than 20% in one cycle — that is the context-collapse tripwire, and it is a five-line check.

#### 3.4 Dynamic Cheatsheet — test-time memory without labels

"Dynamic Cheatsheet: Test-Time Learning with Adaptive Memory" — Mirac Suzgun, Mert Yuksekgonul, Federico Bianchi, Dan Jurafsky, James Zou. **Submitted 2025-04-10.** https://arxiv.org/abs/2504.07952 . A persistent, evolving memory maintained during inference; accumulates "concise, transferable snippets" rather than transcripts; **functions "without requiring explicit ground-truth labels or human feedback"**, usable with black-box models. Reported: Claude 3.5 Sonnet AIME accuracy "more than doubled"; GPT-4o Game of 24 10% → 99%; equation balancing near-perfect vs ~50%; GPQA-Diamond +9%, MMLU-Pro +8% (Claude). ACE reports beating it on cost/latency (§3.3). Read for RFA: this is the closest published analogue to what `src/consolidate.ts` already does for *facts*; the delta is that DC's snippets are *procedural* ("how to solve this class of problem") rather than declarative. In RFA that class of write must stay behind the human gate — but it is the right *content* for the reflective diff proposal.

#### 3.5 Letta 2026 — the closest commercial implementation of the mandated shape

- **MemFS** — https://docs.letta.com/concepts/memfs . "MemFS is how a Letta agent works with its long-term memory." Layout, verbatim:

```
$MEMORY_DIR/
├── system/
│   ├── persona.md
│   └── human.md
├── reference/
│   └── project-notes.md
└── skills/
    └── my-skill/
        └── SKILL.md
```

Files are Markdown with YAML frontmatter. `system/` is "loaded into the system prompt each turn — ideal for identity, user preferences, and workflow rules"; everything outside `system/` stays out of context until accessed. **Versioning: "Every edit commits to the underlying git repository", giving version history and conflict resolution.** **Skills: "Agent-owned procedural instructions live in `$MEMORY_DIR/skills/`", versioned alongside memory.** Search: keyword built in; semantic/vector needs the MemFS Search mod + QMD tool. Background processes ("dreaming") use **git worktrees** to update memory without blocking the main agent.

- **Sleep-time agents / "dreaming"** — https://docs.letta.com/guides/agents/sleep-time-agents . Background subagents "review recent conversations, consolidate lessons, and update memory without interrupting active work". Configured via `/sleeptime` in the CLI or "Dream settings" in the app; trigger is either "a set number of completed agent steps or when the context window is compacted". Critically: an optional **"Agent reviews before applying"** setting has the agent "review and revise proposed memory updates in a second background conversation before finalizing changes." (UNVERIFIED: exact config field names — the page does not expose e.g. `enable_sleeptime`; and it does not state whether the persona/system prompt can be self-edited or whether human approval is ever required.)

**Read for RFA:** Letta has independently converged on git-backed memory with a review step and procedural instructions in `skills/` — exactly spec 5.1 L4's stance, minus the human. Two adoptions: (a) **use git as the diff surface** — write the proposal as a real patch against tracked files so `git apply --check`/`git diff` is the review UI Paul already knows; (b) **run the reflection in a worktree-equivalent** — a scratch dir, not the live pack, so a half-written proposal can never be read by the running resident.

#### 3.6 SEAL — the weight-update branch, and why it is out of scope

"Self-Adapting Language Models" — Adam Zweiger, Jyothish Pari, Han Guo, Ekin Akyürek, Yoon Kim, Pulkit Agrawal. **Submitted 2025-06-12, revised 2025-09-18.** https://arxiv.org/abs/2506.10943 . Model generates "self-edits" (restructured information, hyperparameters, tool invocations for augmentation) which are applied via supervised finetuning to yield "persistent weight updates"; trained with "a reinforcement learning loop with the downstream performance of the updated model as the reward signal". Promising on knowledge incorporation and few-shot generalization. (The abstract does not carry the numeric results or the catastrophic-forgetting/compute discussion; UNVERIFIED beyond the abstract — I did not read the body.) **Out of scope for RFA at any effort: requires gradient access to weights.** Recorded so a future reader does not re-litigate it.

---

### 4. Judge reliability: the measured failure modes and the cheap mitigations

#### 4.1 The canonical bias numbers

"Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena" — Lianmin Zheng, Wei-Lin Chiang, Ying Sheng, Siyuan Zhuang, Zhanghao Wu, Yonghao Zhuang, Zi Lin, Zhuohan Li, Dacheng Li, Eric P. Xing, Hao Zhang, Joseph E. Gonzalez, Ion Stoica. **Submitted 2023-06-09, last revised 2023-12-24.** https://arxiv.org/abs/2306.05685 · body read via https://ar5iv.labs.arxiv.org/html/2306.05685

| Failure mode | Measured | Paper location |
|---|---|---|
| **Position bias** — order-swap consistency, default prompt | **GPT-4 65.0%**, GPT-3.5 46.2%, Claude-v1 **23.8%** | Table 2 |
| **Verbosity bias** — "repetitive list" attack failure rate | Claude-v1 **91.3%**, GPT-3.5 **91.3%**, GPT-4 **8.7%** | Table 3 |
| **Self-enhancement bias** | "GPT-4 favors itself with a 10% higher win rate; Claude-v1 favors itself with a 25% higher win rate" (paper notes data limits prevented a conclusive determination) | biases section |
| **Human agreement** (2nd turn) | GPT-4 vs humans **70% with ties / 85% excluding ties**; human-to-human **81%** | Table 5b |

Mitigations they measure, with effect sizes:
1. **Position swapping** — call the judge twice with reversed order; declare a winner only if consistent.
2. **Few-shot examples** — "Improved GPT-4 consistency from 65% to 77.5%."
3. **Reference-guided grading** — give the judge its own independently-derived answer as reference; "reduced math grading failures from 70% to 15%."
4. **Chain-of-thought** — ask the judge to solve the problem independently first.
Also: human raters found GPT-4 judgments "reasonable in 75% of cases" when they disagreed with it.

#### 4.2 Self-preference is causal, not just correlational

"LLM Evaluators Recognize and Favor Their Own Generations" — Arjun Panickssery, Samuel R. Bowman, Shi Feng. **Submitted 2024-04-15.** https://arxiv.org/abs/2404.13076 . "LLMs such as GPT-4 and Llama 2 have non-trivial accuracy at distinguishing themselves from other LLMs and humans." The paper establishes a **linear relationship** between self-recognition capability and self-preference bias, and via finetuning experiments shows increased self-recognition **causally** strengthens self-preference. Flagged implication for "reward modeling, constitutional AI development, and self-refinement methods that depend on model-based evaluation."

**Direct bite on RFA:** `claudeJudge` runs `claude -p --model haiku` over trajectories produced by… a haiku resident. That is same-model self-evaluation. Anthropic's own eval doc says "Use a different model for evaluation than the model being evaluated" — inside the Claude family Paul can at least *cross tiers*: judge haiku-produced trajectories with sonnet and vice versa. That is a one-line change (`opts.model`) and it is the cheapest available mitigation. It does not eliminate family-level self-preference; nothing available under one subscription does, which is precisely why the judge must never be the gate.

#### 4.3 Panels beat single judges, and are cheaper — but need disjoint families

"Replacing Judges with Juries: Evaluating LLM Generations with a Panel of Diverse Models" — Pat Verga, Sebastian Hofstatter, Sophia Althammer, Yixuan Su, Aleksandra Piktus, Arkady Arkhangorodsky, Minjie Xu, Naomi White, Patrick Lewis. **Submitted 2024-04-29, revised 2024-05-01.** https://arxiv.org/abs/2404.18796 . PoLL (Panel of LLm evaluators): a panel of smaller models "outperforms a single large judge", is "over seven times less expensive", and "exhibits less intra-model bias due to its composition of disjoint model families". Six datasets, three judge settings.

**Read for RFA: defer.** The cost argument is irrelevant (§4.5) and the bias argument requires disjoint families, which one Claude subscription cannot supply. Revisit if a local model is ever added to the stack.

#### 4.4 Who validates the validators

"Who Validates the Validators? Aligning LLM-Assisted Evaluation of LLM Outputs with Human Preferences" — Shreya Shankar, J.D. Zamfirescu-Pereira, Björn Hartmann, Aditya G. Parameswaran, Ian Arawjo. **Submitted 2024-04-18.** https://arxiv.org/abs/2404.12272 . Core claim, verbatim: "LLM-generated evaluators simply inherit all the problems of the LLMs they evaluate, requiring further human validation." Names **criteria drift**: users need criteria to grade outputs, but grading outputs is what refines the criteria — and "some criteria depend on the specific LLM outputs observed rather than being predefined independently, challenging assumptions that evaluation criteria can be established *a priori*." EvalGen is the mixed-initiative answer: generate candidate evaluator implementations (Python functions and LLM grader prompts) while requesting human feedback on selected outputs, then select implementations that match the user's preferences.

**Read for RFA:** the rubric in `src/evals/judge.ts` is currently a hardcoded string constant written *before* the failure data existed — the exact a-priori-criteria assumption this paper falsifies. Move it to `evals/rubric.md`, hash it, record `rubric_hash` on every judge feedback row, and expect to revise it every review cycle.

#### 4.5 Judge economics at a personal-tool budget (so this stops being a worry)

Transport today is `claude -p --model haiku --output-format json` under Paul's subscription → **not metered per token**. If it ever moves to the API: a 30,000-character trajectory (the current `.slice(0, 30_000)` cap) is roughly 8k input tokens; output is one small JSON object (~100 tokens). At **Claude Haiku 4.5 $1.00/MTok input, $5.00/MTok output** that is ≈ **$0.0085 per judge call**, so the existing `DAILY_CAP = 50` costs **≈ $0.42/day** worst case. At **Claude Sonnet 5 $3.00/$15.00 per MTok** (intro $2.00/$10.00 through 2026-08-31) it is ≈ **$0.026/call**, ≈ $1.30/day at the cap. (Pricing per the bundled `claude-api` skill's cached model table, cached 2026-06-24.) Compare a single **live rollout: $0.0898 measured** for one sonnet scribe run (STATUS.md). **A judged run of 20 trajectories costs less than two live rollouts.** Conclusion: never trade trials for judges — but also never treat the judge cap as a constraint worth engineering around.

#### 4.6 The concrete judge change list for RFA

| Change | Why | Where |
|---|---|---|
| `CHOICES = [0, 0.25, 0.5, 0.75, 1]` → binary `{pass, fail}` + free-text critique | Likert is rejected by every practitioner source; adjacent points are not comparable; binary forces the criterion to be stated | `src/evals/judge.ts` |
| Move `RUBRIC` to `evals/rubric.md`; hash it; write `rubric_hash` into the feedback row's `value` | Criteria drift is documented; without the hash the score history is uninterpretable | `judge.ts` + `obs.ts` |
| Anchor with 2-3 few-shot critiques taken from Paul's own labels | Measured: 65% → 77.5% order-consistency from few-shot on GPT-4 | `evals/rubric.md` |
| Judge a *different tier* than the subject (sonnet judges haiku, haiku judges sonnet) | Self-preference is causal; Anthropic's own guidance says use a different model | `judge.ts` `opts.model` |
| Calibrate: label 30-50 trajectories by hand, report **TPR/TNR** (not accuracy) against them, store the labeled set as `evals/judge-calibration.ndjson` | Class imbalance makes accuracy meaningless; TPR/TNR is the recommended metric | new script |
| For A/B only: pairwise, both orders, ties allowed, count only order-consistent verdicts | Position bias 65% default consistency; the swap is the documented fix | new A/B path |
| Judge never gates; it may only set `needs_review` | Computed reward is the gate (`r = r_state × r_output × r_protocol`); the judge is advisory | `src/evals/runner.ts` |

---

### 5. The workbench gaps: assembled-context viewer and definition A/B

#### 5.1 What the field does

**Letta ADE** — https://docs.letta.com/guides/ade/overview . Three panels. Left: agent configuration (LLM/model selection, system instructions, tools add/remove/configure, data sources, advanced settings incl. context window size). Centre: Agent Simulator — "Chat directly with your agent to test its capabilities" and "Send system messages to simulate events and triggers." Right: Agent State Visualization, three components: **Context Window Viewer** — "Examine exactly what information your agent is currently processing"; **Core Memory Blocks** — "View and edit the persistent knowledge your agent maintains"; **Archival Memory** — "Monitor and search your agent's external (out-of-context) memory store". (Field-level detail and token displays are not documented on that page.)

**Claude Code `/context`** — https://code.claude.com/docs/en/context-window . The page ships an interactive simulation whose event list is effectively the canonical category taxonomy, with illustrative token costs against a 200,000-token window:

| Category (verbatim label) | Illustrative tokens | Note (verbatim where quoted) |
|---|---|---|
| System prompt | 4,200 | "Core instructions for behavior, tool use, and response formatting. Always loaded first. You never see it." |
| Auto memory (MEMORY.md) | 680 | "The first 200 lines or 25KB, whichever comes first, are loaded into the conversation context." |
| Environment info | 280 | "Working directory, platform, shell, OS version, and whether this is a git repo. Git branch, status, and recent commits load as a separate block at the very end of the system prompt." |
| MCP tools (deferred) | 120 | "MCP tool names listed so Claude knows what is available. By default, full schemas stay deferred…" (`ENABLE_TOOL_SEARCH=auto` loads schemas upfront when they fit within 10% of the window; `=false` loads everything) |
| Skill descriptions | 450 | |
| `~/.claude/CLAUDE.md` | 320 | |
| Project `CLAUDE.md` | 1,800 | |
| Your prompt | 45 | |
| per-file reads, rules, hook output, tool results, subagent spawn/return, `/compact` summary | 100-2,400 each | subagent has its own system prompt + own CLAUDE.md copy + own MCP/skills |

Visibility is itself a documented axis: "Invisible in your terminal" / "One-liner in your terminal" / "Shown in your terminal".

**Braintrust playground** — https://www.braintrust.dev/docs/guides/playground . "diff mode" to "visually compare variations across models, prompts, or workflows"; a base task plus optional comparison tasks; each comparison column header shows a **comparison grade pill (Improvement, Regression, Tradeoff, or Tie)**; link a dataset "to test multiple inputs at once"; scorers "run automatically after each generation"; grid has "a row for each dataset record"; diff mode emphasises "output differences between tasks", "score changes", and "timing and token usage variations". Trace viewer compares traces side by side. (The docs do **not** state whether the fully rendered prompt is shown — UNVERIFIED.) Braintrust also ships **Loop** — https://www.braintrust.dev/docs/guides/loop — "Braintrust's AI agent, available throughout the product": creates and optimizes prompts in playgrounds, generates scorers from identified patterns, builds datasets from logs, generates SQL filters from natural language, finds semantically similar traces. It reads project logs, traces, datasets, experiments, playgrounds, SQL. Documentation does **not** indicate it runs experiments automatically.

**LangSmith** — dataset/experiment mechanics per §1.3; the playground's differentiator relative to RFA is the versioned-prompt + dataset + side-by-side experiment triangle, which RFA already has in `agents/*/agent.md` (git) + `evals/cases/` + `reports/evals/<ts>`.

#### 5.2 The assembled-context viewer RFA should build

**The honest constraint first:** the Agent SDK does not hand you the assembled prompt string. `Options.systemPrompt` accepts `string | {type:'preset', preset:'claude_code', append?, excludeDynamicSections?}`; the init `SDKSystemMessage` carries `capabilities` and session metadata; `getContextUsage(): Promise<SDKControlGetContextUsageResponse>` exists but its field list is not in the reference page I could read (UNVERIFIED: the exact fields of `SDKControlGetContextUsageResponse` — resolve via `llms.txt` or the installed `.d.ts` before implementing). So the viewer's contract must be stated precisely:

> **RFA-assembled context is rendered exactly, byte for byte. SDK-side overhead (preset prompt, built-in tool schemas, environment block) is *measured*, not itemized.**

That is fine, because everything Paul actually edits is on the RFA side. Panel spec — one run per view, in prompt order:

| Section | Source in the repo | Show |
|---|---|---|
| Definition identity | `src/agentdef.ts` pack load | name, model, effort, **definition hash** (the digest driver), git ref if clean |
| System prompt body | `agent.md` markdown body | full text, collapsible, token count |
| Memory blocks | `memory/blocks/*.md` compiled in Letta XML | per block: `label`, `description`, `read_only`, **`chars_current/chars_limit`** (Letta's exact rendering), token count |
| MEMORY.md head | `memoryfs.ts` | the exact injected prefix, with the truncation boundary marked (Claude Code's precedent: first 200 lines / 25KB) |
| Retrieved facts | `FactStore` FTS5 top-5, recency×importance | the 5 facts *as injected*, each with `source_origin` (human/self/agent), `importance`, `episode_ids`, and **why it ranked** (bm25 × recency × importance) |
| Knowledge hints | `agent.md` `knowledge:` globs + derived per-file hints | the hint text, plus which files the run actually Read/Grepped (from the trace) |
| Tool surface | `agentdef` allow/deny + `interrupt_on` + in-process servers | every tool name, its origin (`mcp__rfa__*`, `mcp__memory__*`, in-process linear, built-in), and **whether it was excluded from `allowedTools` because it is an `interrupt_on` tool** (the v0.4.6 bridge behaviour — this is the field most likely to confuse a future debugging session) |
| The question | envelope | the raw ask, plus the **`<room-message>`-wrapped** peer form and its **gate verdict + check_id** if it passed through the gate |
| Session state | run checkpoint | `claude_session_id`, `room_cursor`, turn index, whether this turn resumed or started fresh |
| Measured totals | `SDKResultMessage` + `getContextUsage()` | total input tokens, cache read/write split, `num_turns`, `total_cost_usd`, `permission_denials`, and the RFA-assembled share as a percentage of the total |

Two features that make it weekly-useful rather than a curiosity:
- **Diff against the previous run of the same agent** — highlight which sections changed. Most "why did it regress?" questions are answered by "the definition hash rotated" or "a different fact was retrieved".
- **A per-section "why is this here" link** to the file and the rule that injected it.

Design brief for the whole panel, borrowed verbatim from the applied-LLMs write-up: could an average college student in the relevant major, given exactly this, succeed? If not, the fix is context, not the prompt.

#### 5.3 The definition A/B RFA should build

Reuse, do not rebuild: the eval runner already resolves subjects by capability, runs N trials, computes reward, and writes feedback. A/B is a wrapper.

- **Inputs**: definition A = the live pack (or a git ref); definition B = a raw-YAML edit from the console Agents tab (already possible) staged into a scratch pack. Deploy B via the existing versioned-drain mechanism under a temporary name so the room sees a distinct member, then drain it.
- **Case set**: the existing discovered cases (`evals/cases/` + `agents/*/evals/cases/`), `trials >= 4`.
- **Grid**: one row per case, columns A and B, each cell showing `r` with its components (`r_state`/`r_output`/`r_protocol`), pass^1, pass^4, cost, latency, and the judge verdict if the judged tier ran.
- **Verdict pill per case**: adopt Braintrust's exact vocabulary — **Improvement / Regression / Tradeoff / Tie** (Tradeoff = reward up, cost or latency materially worse, or one component up and another down).
- **Promotion gate**: B promotes only if **no case regresses** and pass^4 does not drop. A single case improving is not evidence.
- **The statistical honesty note, shown in the UI**: with 5-20 cases and a measured ~5% per-question flake, a 1-case delta at `trials=1` is noise. Print the flake rate next to the verdict.
- **Bundle the assembled-context diff between A and B** — that is what turns "B is better" into "B is better *because* it retrieves the product file first".

Explicitly out of scope: multi-variant sweeps, prompt-space search, automatic promotion. One operator, weekly.

---

## Open questions and spikes

| # | Open question | Cheapest experiment to settle it |
|---|---|---|
| 1 | Does the judge agree with Paul at all? Unknown today — there is no labeled set. | **Label 30 existing trajectories pass/fail by hand** (they are already in `data/rooms/*.ndjson` + `obs.db`), run the current 5-choice judge and a binary variant over the same 30, compute TPR/TNR for each. Half a day. Decides rec 3 outright, and tells you whether the judge is worth keeping at all. |
| 2 | Does cross-tier judging measurably reduce self-preference here, or just cost more? | Same 30 labeled trajectories, judge with haiku and with sonnet, compare TPR/TNR and disagreement rate. One extra hour on top of spike 1. |
| 3 | Is the review queue non-empty at Paul's volume? A flywheel needs traces. | **Run the three queue queries against today's `obs.db`** and count. If Q1+Q2+Q3 yields <3 traces/week, the bottleneck is usage, not tooling — in which case rec 1 shrinks to a weekly `#ops` digest and the console lane defers. One hour. |
| 4 | Can the reflective diff proposal produce a *useful* delta from one cycle's failures, or does it produce platitudes? | Take the ONE real regression already on record (haiku grepped the glossary instead of the product file), feed the failing trajectory + reward components + lint names to one sonnet call with the ACE delta-bullet output format, and compare its proposal against the fix Paul actually made (per-file retrieval hints). If it lands within paraphrase distance, ship rec 5. Two hours; the ground truth already exists in STATUS.md. |
| 5 | What are the actual fields of `SDKControlGetContextUsageResponse`, and does the SDK expose any per-category token breakdown? | `grep` the installed `@anthropic-ai/claude-agent-sdk` `.d.ts` and log one `getContextUsage()` call from `src/resident.ts`. Fifteen minutes. Determines how much of the viewer's "measured totals" row is real vs derived. |
| 6 | Would a replay-only reward surface make a small home-grown GEPA loop viable (the one thing that would flip rec 8)? | Take the 5 existing cases, measure the cost and wall clock of scoring all of them in **replay** mode only (`kind: replay`, no live rollout). If a full pass is <2s and $0, then 1,643 "metric calls" is minutes, and a ~300-line TS Pareto loop over `agent.md` bullets becomes arguable — but note it optimizes against *recorded* trajectories, so it can only fit known failures, exactly the limitation §1.1 names. One hour to measure, and the measurement is worth having regardless. |
| 7 | Does a case set of 5-20 have enough power to gate anything, or is the baseline-diff gate theatre? | Run `npm run evals` five times with **no changes** and record how often the baseline diff trips. That is the false-positive rate of the gate. If it trips at all, raise `trials` before adding cases. Thirty minutes, and it is the highest-value half-hour in this list. |
| 8 | Is `promote-case` output actually good enough to gate on, or do its auto-derived expectations need heavy hand-editing every time? | Promote three cases from the live log and diff the generated `case.yaml` against what Paul edits it to. The script itself warns "edit before trusting" — quantify how much. One hour; decides whether rec 2 also needs better `must_mention` inference. |
| 9 | Does the 20%-bullet-reduction tripwire (context-collapse guard) ever fire in practice, and is 20% the right threshold? | Cannot be settled before rec 5 ships; record the check's outcome per cycle and revisit after 5 cycles. Zero extra cost. |
| 10 | Would a local model (Ollama) give a genuinely disjoint second judge family, at acceptable quality? | Only worth asking after spike 1 shows the Claude judge's TPR/TNR. If the Claude judge already exceeds ~0.85/0.85, a panel buys nothing. Deferred by design. |

**Standing revision triggers for this whole dimension.** (a) Corpus reaches ~50 cases → re-open rec 8 with spike 6. (b) A workload appears whose success is machine-checkable without a human → re-open rec 11 (Voyager-style growth). (c) A non-Claude local model joins the stack → re-open rec 13 (PoLL). (d) Any Anthropic first-party prompt-optimization API ships (as opposed to a Console UI) → re-check §2.4, whose two documented URLs currently redirect. (e) Anything in §1.1 changes: that page is *live*, last modified 2026-07-18, and it is the load-bearing practitioner source for half these recommendations — re-read it before the next wave.
