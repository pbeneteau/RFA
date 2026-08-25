# 01-prior-art-platforms: How shipping agent products run parallel work over shared workspaces

Wave 05, dimension 01. Written 2026-08-25.
Premise: RFA wants one agent (and a fleet) to run many tasks at once over a shared identity, pack directory, memory store, sessions and task board; the pre-research design ladder (brief sect. "The hypothesis to attack") gates concurrency on declared tool surface, keys it per conversation, and climbs from read-only parallelism to copy-on-write worktrees to partition-at-assignment.
Repo read at commit 50f538d. All web sources fetched 2026-08-25 unless a publication date is given.
Papers read in full from `research/05-concurrency/papers/`: `swe-agent-aci.pdf` (arXiv 2405.15793v3), `openhands-platform.pdf` (arXiv 2407.16741, ICLR 2025), `openhands-agent-sdk.pdf` (arXiv 2511.03690v2, MLSys 2026).

---

## Verdict

**No surveyed product, out of twelve, runs two concurrent model turns inside one agent loop, and none attempts automatic merge-back of concurrent edits; both of those hold 12 for 12. The clone-plus-branch-handoff story is near-universal but not unanimous: 10 of 12 products clone the workspace (container, VM, or git worktree), run another full agent in it, and hand the results back as a git branch or PR for explicit review, while Amp and opencode (sect. 12) ship parallel full agents over ONE shared checkout, with no workspace isolation and no merge story at all, leaving file collisions to the user. That near-unanimity, with the two non-isolating outliers illustrating the cost of skipping isolation, confirms the ladder's overall shape (gate concurrency on workspace isolation, partition work at assignment) and kills any thought of in-process parallel turns. But the evidence breaks three specific rungs as written: rung 0's static posture gate is refuted by the one product that actually enforces worktree isolation (Claude Code needs four runtime checks, including refusing command shapes it cannot statically trace, precisely because a Bash-declaring agent can never be statically cleared); rung 4's enforcement mechanism is broken by this repo's own three-doors rule, since Write/Edit/Bash are harness built-ins that never reach `canUseTool` (src/posture.ts:40-47), so a canUseTool path guard guards nothing that matters; and rung 5's "merge-back at run completion" would exceed what any shipping product attempts, because the industry-wide answer to concurrent agent edits is a branch plus a human (or a coordinating agent turn), never an automatic merge. The ladder also misses three things the products all had to build: a warm-start story for fresh workspaces (Devin machine snapshots, Cursor snapshots/Dockerfile, Codex setup scripts), a defined channel for intermediate artifacts between isolated runs (per-run VMs create a file-exchange problem the isolation itself cannot solve), and terminal-state reconciliation for async run bookkeeping (Claude Code's own background tasks get stuck "running" forever and hang the conversation).**

## Recommendations

| # | Recommendation | Verdict | Effort | Spec impact |
|---|---|---|---|---|
| 1 | Concurrency is instance-level only: N concurrent runs means N isolated workspaces plus the existing account lease cap; never two model turns interleaved in one session's context. Keep the turn lock (src/turnlock.ts) permanent, not transitional. | DECIDED (12/12 products keep the loop serial; 10/12 also isolate workspaces, and the two that do not, Amp and opencode, leave writer collisions to the user, which RFA must not; reopened only if an SDK ships forked concurrent turns over one live session) | none | RFA-0.4 concurrency section states the invariant |
| 2 | Rung 0 stands only as a NECESSARY gate, never a sufficient one: `concurrency: N` may be refused on posture (Write/Edit/Bash declared and no isolation configured), but a writing pack is cleared by its isolation mechanism, not its declaration. | DECIDED | small | pack schema: `concurrency` requires posture read-only OR an isolation setting |
| 3 | Rewrite rung 4: the scratch dir is enforced by making it the SDK session's cwd (worktree-style), backed by harness-level hooks, never by `canUseTool`, which built-ins bypass by construction. If hook-level path guards prove unavailable, a writing pack's concurrency falls back to rung 5 (worktree) or 1 (serial). | DECIDED (repo's own three-doors rule, src/posture.ts:40-47, plus Claude Code's four-check design) | medium | RFA-0.4 sect. 3.12 amendment naming the enforcement door |
| 4 | Rewrite rung 5's merge-back: a run's mutations land on a per-run branch; completion PRESENTS the branch (to the operator, or to a designated sequential integration turn), it never auto-merges. Conflicts become review items, matching every surveyed cloud product. | DECIDED | medium | task completion carries a `branch` artifact field |
| 5 | Add the missing warm-start rung: a worktree per run is cheap for git (shares `.git`, like Claude Code), but pack node_modules, venvs and knowledge clone hydration need a `.worktreeinclude`-style copy list or a snapshot step, or per-run setup eats the win. | DECIDED | medium | pack setting: files to carry into a run workspace |
| 6 | Rung 6 (partition at assignment, resource keys on claim leases) is validated: Cognition ships fan-out ONLY as repeated isolated shards under one coordinator that resolves conflicts, and argues fine-grained intra-task parallelism is unreliable. Copilot's one task = one session = one PR is the same shape. | DECIDED | as planned | wire 10.3 resource-key extension proceeds |
| 7 | Rung 3 (read-only packs parallelize freely) is supported but must carry a cost guard: Anthropic measured parallel research subagents at roughly 15x chat token use; RFA's per-day budgets must count concurrent runs against one pool per agent. | DECIDED | small | budget semantics note in RFA-0.5 honest meters |
| 8 | Add run-state reconciliation: any run whose process died must be swept to a terminal state, and the sweep must work at zero traffic (CLAUDE.md threshold rule). Claude Code's stuck-forever background tasks are the failure to avoid. | DECIDED | small | engine DB sweep requirement |
| 9 | Intermediate artifacts between concurrent runs flow through the room (message with artifact, or task record fields), never through the shared pack tree. Per-VM products had to bolt on external storage for exactly this. | DECIDED | small | RFA-0.6 interop artifact already fits; name it for local runs too |
| 10 | Replicas-as-distinct-members stays the zero-mechanics fallback and matches Manus Wide Research (full replica instances coordinated by protocol, not shared files); diverging memory is the known, accepted cost, with reconvergence PARKED. | PARKED (trigger: first operator who runs replicas and asks for merged memory) | none now | none now |
| 11 | Rung 2's conclusion (parallel across conversations, serial within one) stands, but drop its justification: SDK sessions CAN fork (Claude Code `--fork-session`). Serial-within-conversation is a product decision about one coherent thread of intent, and Cognition's argument is the citable basis. | DECIDED | none | wording only |

---

## Evidence

### 1. Claude Code: the only product that enforces worktree isolation at the tool layer

Primary: https://code.claude.com/docs/en/worktrees (fetched 2026-08-25).

One session = one worktree = one branch: "Running each Claude Code session in its own worktree means edits in one session never touch files in another." Subagents get the same treatment declaratively (`isolation: worktree` frontmatter). Concurrency is achieved by more sessions, never by parallel turns inside one.

The part that attacks rung 0 and rung 4 is HOW isolation is enforced. Claude Code applies four runtime checks while a session is isolated:

1. File edits: blocks `Edit`/`Write`/`NotebookEdit` targeting a path in the main checkout.
2. Command working directory: blocks a Bash command "whose working directory resolves to the main checkout, or whose working directory it can't verify stays outside it".
3. Git redirects: blocks `git -C`, `--git-dir`, `GIT_DIR`, `GIT_WORK_TREE`, or a `cd` into the main checkout before git.
4. Command shape: blocks any command "it can't verify stays inside the worktree, even when the command runs no git at all", refusing "shell constructs it can't trace without running them, such as brace expansion and heredocs". The doc adds: "You can't turn this check off."

Read that as a negative result for static gating: the vendor with the most worktree experience concluded that a Bash-capable agent cannot be cleared by inspecting its tool list, only by checking every command at call time and refusing the untraceable ones. Rung 0 survives as a cheap necessary condition (a pack with no Write/Edit/Bash genuinely has no workspace conflict); it cannot be the mechanism that clears a writing pack.

What worktrees deliberately still share with the main checkout: the repository's `.git` directory, project-scope plugins, and saved permission approvals. Crash recovery is lock-plus-sweep, not transactions: "While an agent is running, Claude runs `git worktree lock` on its worktree so that concurrent cleanup cannot remove it"; a periodic sweep removes old subagent worktrees but "skips a worktree that still holds work: changed or untracked files, or unpushed commits", and releases locks left by killed sessions. `.worktreeinclude` (gitignore syntax) exists because a fresh checkout lacks `.env` and friends; this is the warm-start cost of recommendation 5 showing up in practice.

Also relevant to rung 2: `--fork-session` exists ("the forked session starts in the directory you launched Claude from, and Claude Code leaves the original session's worktree untouched"), so "SDK sessions cannot fork" is not the right justification for serial-within-conversation. The conclusion still holds on Cognition's grounds (section 3).

### 2. Claude Code agent teams: shared task list, file locks, ownership by convention

Primary: https://code.claude.com/docs/en/agent-teams (fetched 2026-08-25). Experimental, off by default.

Teammates are full separate sessions with their own context windows; coordination is a shared task list plus JSON mailbox files per agent (`~/.claude/teams/{team}/inboxes/{agent}.json`). "Task claiming uses file locking to prevent race conditions when multiple teammates try to claim the same task simultaneously", which is RFA's wire 10.3 claim lease in miniature. File conflict avoidance is CONVENTION, not mechanism: "Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files." Documented gaps after months of iteration: no teammate resume (`/resume` does not restore in-process teammates), task status can lag and block dependents, one team per session, no nested teams, and until v2.1.207 "a single malformed mailbox entry caused a repeated error every second and blocked delivery for that mailbox". Messages between agents are explicitly demoted to data: "A teammate can't approve a permission prompt or supply consent on your behalf", the same posture RFA's consult-room rule takes.

Reading for RFA: even the vendor shipping this keeps ownership-partitioning as prose guidance while making the CLAIM step the only mechanically-locked object. Rung 6 puts the mechanism at the same place (the board), which is the defensible spot.

### 3. Cognition: the strongest argued negative, and what they ship anyway

Primary: https://cognition.com/blog/dont-build-multi-agents (2025-06-12) and https://cognition.com/blog/devin-can-now-manage-devins (2026-03-19); https://docs.devin.ai/release-notes (fetched 2026-08-25).

The 2025-06-12 essay is the direct attack on fine-grained parallelism inside one coherent task: parallel subagents lack each other's implicit decisions, and "Actions carry implicit decisions, and conflicting decisions carry bad results." Their default is a "single-threaded linear agent"; for tasks exceeding context they prefer compression over parallelism.

Nine months later they shipped fan-out anyway, and the shape is instructive: MultiDevin is one coordinator plus managed workers ("10 at a time" in their audit example), where "Each managed Devin is a full Devin, running in its own isolated virtual machine", and the coordinator "scopes the work, assigns each piece to a managed Devin, monitors progress, resolves any conflicts, and compiles the results". Recommended uses are repeated, isolated shards: parallel QA, migrations, security audits, refactors. The reconciliation of essay and product IS rung 6: parallelize only what was partitioned at assignment; keep one thread per coherent task; make one party own conflict resolution. Devin's cold-start answer is machine snapshots (release notes show a snapshot build system with cancel/delete/history through 2026-07-01): saved states with repos cloned and environments set up, reusable across runs, feeding recommendation 5.

Devin's per-worker VM isolation also creates the artifact-flow problem of recommendation 9: an outside vendor writeup (https://fast.io/resources/devin-ai-multi-agent-file-sharing/, undated, secondary and selling a fix) states it plainly: "Tearing down the subagent virtual machine deletes the generated output before the parent agent or human reviewer can consume it." Weigh the source accordingly, but the mechanism is real: full isolation with no defined exchange channel loses intermediate work by construction.

### 4. OpenAI Codex cloud: container per task, N tasks in parallel, diffs then PRs

Primary: launch post 2025-05-16 (https://openai.com/index/introducing-codex/, returned HTTP 403 on 2026-08-25; launch-day claims verified via contemporaneous coverage and the current docs) and https://learn.chatgpt.com/docs/cloud (current docs, fetched 2026-08-25 via redirect from developers.openai.com/codex/cloud).

Each task gets an isolated cloud container preloaded with the repo; at launch, internet access was disabled during execution; the current docs make internet access configurable per environment and let you "Configure the dependencies, tools, variables, and setup steps each repository needs". Parallelism is many tasks at once ("Start work in parallel and return as each task reaches a reviewable result"); results come back as "the summary and diff", then "open a pull request when the work is ready", with follow-up turns continuing in the same task environment. Give-ups: no live shared workspace, no state between tasks beyond repo plus setup script.

### 5. GitHub Copilot coding agent: the hardest task-level serialization in the survey

Primary: https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent (fetched 2026-08-25) and https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ (2025-05-19).

One assigned task = one ephemeral GitHub Actions session with "a maximum execution time of 59 minutes. This is a hard limit", and the agent "can open exactly one pull request to address each task it is assigned" and "can only work on one branch at a time". Branch containment: "The agent can only push to branches it created." Merge containment: "The developer who asks the agent to open a pull request cannot be the one to approve it." Parallelism exists only by assigning more issues. This is the extreme point of the design space: zero shared anything, maximal auditability, and the merge story is 100% human review.

### 6. Google Jules: VM per task, concurrency as a quota

Primary: https://jules.google/docs (fetched 2026-08-25) and https://jules.google/docs/usage-limits/ (fetched 2026-08-25).

"Jules runs in a virtual machine where it clones your code, installs dependencies, and modifies files", with optional environment setup scripts and a plan-approve-then-execute flow. The concurrency quota is now confirmed PRIMARY (the scout had it secondary): concurrent tasks 3 (free) / 15 (Pro) / 60 (Ultra), daily tasks 15 / 100 / 300. Nothing (identity aside) is shared across those VMs. The structural echo for RFA: a per-account concurrent-task cap over isolated per-task workspaces is exactly `agents.max_inflight` (src/account.ts, lease per `query()` call) generalized, which says RFA's account lease table is the right primitive to carry a raised cap.

### 7. OpenHands: isolation as a swappable policy knob, and two hard lessons

Primary: https://docs.openhands.dev/openhands/usage/architecture/runtime (fetched 2026-08-25); `openhands-platform.pdf` p.4 sect. 2.2; `openhands-agent-sdk.pdf` (read in full to p.13).

The platform paper (p.4): "For each task session, OpenHands spins up a securely isolated docker container sandbox, where all the actions from the event stream are executed", driven over a REST action/observation API; the agent loop itself is a serial `step(state) -> action` over one chronological event stream (p.3), and multi-agent work is sequential delegation (`AgentDelegateAction`, p.5), not parallel turns.

The SDK paper is the richest prior art for making isolation a per-pack knob rather than an architecture fork. Sect. 4.10 (pp.10-12): one `Workspace` abstraction with a factory that "resolves to local when only working_dir is provided and to remote when host/runtime parameters are present", concrete backends `LocalWorkspace` (in-process, "a thin, no-op wrapper"), `DockerWorkspace`, `APIRemoteWorkspace`, with agent code unchanged across all three. That is the shape rung 5 should take in the pack schema: `workspace: shared | scratch | worktree | container` as configuration, one resident code path.

Two lessons RFA should steal directly:

- Mandatory isolation was rolled BACK. Sect. 3.1 (p.4): V0 assumed every tool call runs in a sandbox, and "each conversation spanned two independent processes (agent and sandbox) with potentially divergent states", corrupting sessions. The V1 principle: "Sandboxing should be opt-in, not universal." The production numbers (Table 2, p.12): V0's inter-pod design produced 43.0/1k conversations of HTTP 401 auth failures and 18.8/1k runtime pod readiness races; V1's co-located execution eliminated the class, cutting system-attributable failures 61%. RFA already lived a miniature of this (the supervisor's silent 401s, CLAUDE.md); do not reintroduce it by splitting a run's state across processes for isolation's sake.
- One mutable state object per conversation, lock-guarded. Sect. 4.2 (p.7): everything is immutable except `ConversationState`, and "A FIFO lock ensures thread-safe updates". Persist latency is sub-millisecond (per-event persist median 0.20 ms, Table 3, p.13); crash recovery (replay plus unmatched-action scan) is median 7.4 ms, P95 14.9 ms, and 32.1 ms at the max 358-event conversation, with full state replay at 18.9 ms at max (Table 3, p.13). Note: the paper's own prose (p.7 and sect. 5.2 p.13) claims crash recovery under 20 ms, which its Table 3 contradicts at max events. This is rung 1 and rung 2's prior art: serialize the one mutable surface, key state by conversation, event-source the rest. Note for rung 1's scope: an in-process lock covers one resident process only; the moment replicas exist (rung "replicas-as-distinct-members"), each replica has its own store and the lock question becomes the memory-divergence question, which stays PARKED.

Sub-agent delegation in the SDK (sect. 4.5, p.9) is "blocking parallel execution... where the parent agent spawns and monitors sub-agents until all tasks complete", inheriting the parent's workspace context: even here, the parent's own loop stays serial.

### 8. Cursor cloud agents: unlimited parallel VMs, nothing shared

Primary: https://cursor.com/docs/cloud-agent (fetched 2026-08-25).

"Isolated VMs in the cloud with full development environments"; "You can run as many agents as you want in parallel". Environment reproduction by "agent-led setup, a saved snapshot, or a Dockerfile in `.cursor/environment.json`". Output: "merge-ready PRs", the agent "works on a separate branch, then push changes to your repo for handoff". No shared memory or workspace between agents; visibility of runs to the team is the only shared surface. The local Cursor agent remains one loop per window.

### 9. SWE-agent: the research baseline is serial by design

`swe-agent-aci.pdf` (arXiv 2405.15793v3, NeurIPS 2024), read pp.1-8.

One LM, one ACI, one trajectory per task instance: "At each step, SWE-agent generates a thought and a command, then incorporates the feedback from the command's execution" (p.3, sect. 3, ReAct). Evaluation is per-instance with a per-instance budget (p.5); parallelism exists only ACROSS benchmark instances, never within one, and the paper never discusses intra-task concurrency at all. Negative finding: the academic baseline every coding-agent product descends from assumed a single thread per task, so nothing in the lineage ever built for two turns over one workspace, and the concurrency mechanisms surveyed here were all bolted on at the instance boundary.

### 10. Manus: replicas plus protocol, never shared workspace

Primary: https://manus.im/blog/manus-sandbox (2026-01-14), https://manus.im/blog/introducing-wide-research (2025-07-31), https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers (2025-05-06).

"Manus Sandbox is a fully isolated cloud virtual machine that Manus allocates for each task"; sandboxes "can execute in parallel". Substrate: E2B Firecracker microVMs, one per agent, ~150 ms startup. Wide Research is fan-out where "every subagent in Wide Research is a fully capable, general-purpose Manus instance" with its own VM, coordinated by "a protocol for agent-to-agent collaboration", not shared files. This is the closest shipping analogue to RFA's replicas-as-distinct-members note, and it validates the trade: replicas coordinated over a protocol scale wide, and the cost is that state persistence is selective and per-instance (recycled sandboxes restore only "Manus artifacts, uploaded attachments, and important files"; intermediate state is dropped).

### 11. Factory: worktree fan-out as an explicit CLI primitive

Primary: https://docs.factory.ai/droid-exec/overview and https://docs.factory.ai/harness/subagents (fetched 2026-08-25).

`droid exec -w/--worktree` runs each headless job "in an isolated git worktree on its own branch", stated purpose: "useful for fanning out parallel droid exec jobs against the same repo without file conflicts", with `xargs -P 4` shown as the fan-out driver. Merge-back: "Clean worktrees are automatically removed on exit. Dirty worktrees are preserved" for the user to review and push; no automatic merging. Interactive subagents isolate CONTEXT (own session, tools, model, autonomy) but not files. Same split RFA's ladder makes between rung 2 (context keying) and rung 5 (file isolation); same absent auto-merge.

### 12. Amp and opencode: current, deliberate parallel-without-isolation, and its costs

Primary: https://ampcode.com/manual (fetched 2026-08-25). Secondary: https://getbaton.dev/guides/opencode-multiple-sessions (fetched 2026-08-25; a vendor guide, weigh accordingly).

Amp: the main agent loop is single-threaded; "Multiple threads can be started and continue to run at the same time in the same Amp CLI", and subagents "work in isolation - they can't communicate with each other, you can't guide them mid-task", starting "fresh without your conversation's accumulated context". No worktree or workspace isolation is documented; file collision between concurrent threads over one checkout is the user's problem. opencode is the same shape per the Baton guide: multiple sessions over one checkout mean "branches, files, and generated changes can collide", and the ecosystem answer is manual or externally-automated worktrees per session. These are the two shipping data points for what rung 3-without-rung-5 looks like when writing packs slip through: it works until two writers meet, then nothing catches it.

### 13. Anthropic's own multi-agent numbers: rung 3's support and its price tag

Primary: https://www.anthropic.com/engineering/built-multi-agent-research-system (2025-06-13) and https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them (2026-01-23).

The 2025-06-13 engineering post: orchestrator-worker with parallel subagents "outperformed single-agent Claude Opus 4 by 90.2%" on breadth-first research evals, and "multi-agent systems use about 15x more tokens than chats"; explicitly not for coding: "most coding tasks involve fewer truly parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating to other agents in real time." The 2026-01-23 guidance post softens the multiplier to "3-10x more tokens" and adds the design warning that "tightly coupled components belong in the same agent". Both posts support rung 3 (read-heavy parallel work wins) and both price it: RFA's per-day budgets must treat N concurrent read-only runs as N drains on one per-agent pool, or the meter stops being honest the day concurrency lands.

### 14. In-session async bookkeeping is a reliability surface, not free

Primary: https://github.com/anthropics/claude-code/issues/68992 (opened 2026-06-17, still OPEN as of 2026-08-25, read via `gh`).

Even the weakest concurrency Claude Code has inside a session (background bash) shows the failure class: background tasks "can get permanently stuck as running", the conversation "hangs indefinitely on any new message", and "there is no user-facing way to clear it"; the reporter notes the fix must be that "orphaned background tasks reconcile to a terminal state... when their owning session ends or is interrupted". RFA inherits exactly this surface the moment one resident tracks multiple in-flight runs in the engine DB: recommendation 8 is that sweep, and per CLAUDE.md's zero-traffic rule it must be a direct state check, not a rate alert.

---

## Where this leaves the ladder, rung by rung

- Rung 0 (static posture gate): DOWNGRADED to necessary-only. Claude Code's four checks (sect. 1) are the proof that Bash defeats static clearance; posture may refuse `concurrency: N`, it may not grant it to a writing pack.
- Rung 1 (/memories in-process write lock): CONFIRMED as prior art (OpenHands `ConversationState` FIFO lock, sect. 7), with the caveat that it is a single-process answer and says nothing across replicas.
- Rung 2 (parallel across conversations, serial within): CONFIRMED in conclusion, WRONG in justification; sessions can fork (`--fork-session`, sect. 1). Cite Cognition's implicit-decisions argument (sect. 3) instead.
- Rung 3 (read-only packs parallelize freely): CONFIRMED with a 3-15x token price tag and a budget-pool requirement (sect. 13).
- Rung 4 (scratch dir via canUseTool path guard): MECHANISM REJECTED, goal kept. `canUseTool` never sees Write/Edit/Bash (src/posture.ts:40-47; CLAUDE.md three doors); enforce by session cwd plus harness hooks, or fall back to worktrees (sect. 1, 11).
- Rung 5 (copy-on-write worktree, merge-back at completion): HALF CONFIRMED. Worktree-per-run is shipping practice (Claude Code, Factory); automatic merge-back is shipped by NOBODY; completion presents a branch (sect. 1, 4, 5, 6, 8, 11). Add the warm-start answer (Devin snapshots, Cursor snapshots/Dockerfile, Codex setup scripts, `.worktreeinclude`).
- Rung 6 (partition at assignment, resource keys on claims): CONFIRMED by the strongest available source, the vendor that argued against multi-agents and then shipped fan-out only in this shape (sect. 3); Claude Code teams lock exactly the claim step (sect. 2).
- Replicas-as-distinct-members: CONFIRMED as the wide-scaling shape (Manus, sect. 10); memory divergence is the accepted cost everywhere it appears, and no surveyed product merges replica memory at all (negative finding).

## What this dimension could not verify

The OpenAI launch post itself returned HTTP 403 on 2026-08-25, so its launch-day claims (container per task, internet disabled during execution) rest on contemporaneous coverage and the current Codex docs rather than the primary page. Codex's and Cursor's per-account concurrent-task ceilings are not published anywhere found ("as many as you want" is marketing, not a measured limit). The fast.io piece on Devin file exchange is an undated vendor article selling the remedy it describes; the mechanism is credible and consistent with Devin's per-VM isolation, but no Cognition primary source states the parent/child file-exchange gap. Claude Code's agent-teams file locking is asserted by the docs without implementation detail (lock granularity, staleness handling unknown). Amp's manual documents behavior, not rationale; "serial by design" is inferred from what is present and absent, not from a stated position. Manus does not publish Wide Research's coordination protocol, so "protocol, not shared files" rests on their blog's framing. Finally, this note did not measure anything: every number here is a vendor's or a paper's, on their workloads.

## Sources

- https://code.claude.com/docs/en/worktrees (fetched 2026-08-25)
- https://code.claude.com/docs/en/agent-teams (fetched 2026-08-25)
- https://cognition.com/blog/dont-build-multi-agents (2025-06-12)
- https://cognition.com/blog/devin-can-now-manage-devins (2026-03-19)
- https://docs.devin.ai/release-notes (fetched 2026-08-25)
- https://openai.com/index/introducing-codex/ (2025-05-16; 403 on fetch, see caveat)
- https://learn.chatgpt.com/docs/cloud (fetched 2026-08-25)
- https://docs.github.com/copilot/concepts/agents/coding-agent/about-coding-agent (fetched 2026-08-25)
- https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/ (2025-05-19)
- https://jules.google/docs and https://jules.google/docs/usage-limits/ (fetched 2026-08-25)
- https://cursor.com/docs/cloud-agent (fetched 2026-08-25)
- https://docs.openhands.dev/openhands/usage/architecture/runtime (fetched 2026-08-25)
- papers/openhands-platform.pdf (arXiv 2407.16741, ICLR 2025)
- papers/openhands-agent-sdk.pdf (arXiv 2511.03690v2, MLSys 2026)
- papers/swe-agent-aci.pdf (arXiv 2405.15793v3, NeurIPS 2024)
- https://manus.im/blog/manus-sandbox (2026-01-14)
- https://manus.im/blog/introducing-wide-research (2025-07-31)
- https://e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers (2025-05-06)
- https://docs.factory.ai/droid-exec/overview and https://docs.factory.ai/harness/subagents (fetched 2026-08-25)
- https://ampcode.com/manual (fetched 2026-08-25)
- https://www.anthropic.com/engineering/built-multi-agent-research-system (2025-06-13)
- https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them (2026-01-23)
- https://github.com/anthropics/claude-code/issues/68992 (opened 2026-06-17, OPEN)
- https://getbaton.dev/guides/opencode-multiple-sessions (fetched 2026-08-25, secondary)
- https://fast.io/resources/devin-ai-multi-agent-file-sharing/ (undated, secondary)
- Repo: src/turnlock.ts:1-28, src/resident.ts:156 and :550 and :687-699, src/posture.ts:40-51, src/account.ts:12-45 (commit 50f538d)
