# Project status and handoff

Last updated 2026-08-25. **Read this first when resuming work.** Live counts come only from running the gates (`npm test` prints its count, `npm run e2e` writes `reports/latest.md`, `rfa evals run|parity` print theirs); no document states one.

- **State**: protocol 0.1.9 (draft; wire Appendix F in `spec/RFA-0.1.md` is the single per-requirement status table); specs RFA-0.4 through RFA-0.8 in force; the owner's instance is the hub directory `~/rfa/acme` (the Mac Studio test project: `~/Dev/rfa-test`). Rung status lives in THIS file's two rung lists below, never in a spec. The merged v0.5/v0.6 ladder (content in spec/RFA-0.5-platform.md sect. 22): every locally buildable rung SHIPPED, the admission half parked per the decisions below; its only open remainders are already in the open-items list.
- **Decisions in force**: the audience is any organization self-hosting, never a personal tool (2026-08-17). The repository stays private and CI stays declined, do not re-offer (2026-08-19). Direction review: read the gitignored `reports/direction-review-2026-08-21.md` before any strategy work (2026-08-21). The sixty-day remote decision was re-ruled: a counterparty exists, remote MECHANICS un-parked, admission HARDENING parked until the first uncontrolled peer or a release (2026-08-21). The run, never the turn, is the unit of parallelism, and the turn lock (`src/turnlock.ts`) is permanent architecture (2026-08-25).
- **Open items**: the labelling sitting (Paul's: the dashboard's Evals tab, or `rfa evals label --prepare` then `--apply`); the handbook clone, one `rfa knowledge add` command awaiting Paul's GitLab credential (context in docs/HISTORY.md); the watchdog corpus reaches 14 days around 2026-08-30, re-run `scripts/watchdog-replay.ts` then and ship what is still clean; `redact` plus retention/export; the mixed local+remote test week; the live stack was restarted on 2026-08-26 and parity is 4/4 twice plus once under load, so the turn lock is trusted now.
- **Moved content**: the findings ledger is `docs/LEDGER.md` (new findings go there directly); completed-work narrative is `docs/HISTORY.md`.

## v0.8: concurrency (accepted 2026-08-25; rung status lives HERE, never in the spec)

The spec is [spec/RFA-0.8-concurrency.md](spec/RFA-0.8-concurrency.md), drafted from research wave 05 ([research/05-concurrency/REPORT.md](research/05-concurrency/REPORT.md)); its wire half is transplanted into protocol 0.1.9 (draft). Build order per spec sect. 15: rungs 1 and T together, then 2, 3, 4, 5, 6, 7; diffs touching the named concurrency surfaces run the second parity pass under parallel load (sect. 14).

- Rung 1, the correctness floor: DONE 2026-08-26 (FactStore transaction + unique live-hash index with collapse-by-expiry; consolidation single-flight + CAS watermark; per-turn lease set with keepalive-renews-all; `reconcileDead` on the supervisor's timer; create-exclusive with conflict files and `expected_hash` preconditions; gate skips recorded). Findings in [docs/LEDGER.md](docs/LEDGER.md).
- Rung T, the testing rung, parallel to rungs 1-3: DONE 2026-08-26 (four seams in `test/interleaving.test.ts` with the claim seam in `src/store.ts`; the e2e canary "two asks against one pack"; the parity-under-load rule is in CLAUDE.md, not a new gate). Its first run found a LIVE regression unrelated to v0.8: knowledge paths were rendered against a different base than the model resolves them against, which had made out-of-pack knowledge unreachable since 2026-08-23 ([ledger](docs/LEDGER.md)).
- Rung 2, runtime hygiene: NOT STARTED, and it is next.
- Rung 3, read-only parallelism: NOT STARTED.
- Rung 4, candidate parallelism: NOT STARTED.
- Rung 5, writing packs: NOT STARTED, but its precondition is DISCHARGED: the Edit interception probe ran 2026-08-26 on the pinned SDK 0.3.233 and Edit does fall through to `canUseTool` (method and raw output in [research/05-concurrency/notes/07-live-probes.md](research/05-concurrency/notes/07-live-probes.md), probes C-E). The same probes found the fall-through is per-tool AND per-path, so sect. 9's startup deny probe is still owed.
- Rung 6, shared-tree mutation (last-resort tier, gated on churn): NOT STARTED.
- Rung 7, the fleet: NOT STARTED.

## v0.7: the operator CLI and the hub directory (accepted 2026-08-22; rung status lives HERE, never in the spec)

The plan is [spec/RFA-0.7-cli.md](spec/RFA-0.7-cli.md), accepted 2026-08-22 with its section-10 recommendations as written. One line per rung; every DONE rung's full story is in [docs/HISTORY.md](docs/HISTORY.md).

- Rung 0, the hub directory: DONE 2026-08-22 ([story](docs/HISTORY.md#rung-0-the-hub-directory-done-2026-08-22)).
- Rung 1, `rfa` and the lifecycle: DONE 2026-08-22 ([story](docs/HISTORY.md#rung-1-rfa-and-the-lifecycle-done-2026-08-22)).
- Rung 2, agents and rooms: DONE 2026-08-22 ([story](docs/HISTORY.md#rung-2-agents-and-rooms-done-2026-08-22)).
- Rung 3, reach: DONE 2026-08-22 ([story](docs/HISTORY.md#rung-3-reach-done-2026-08-22)).
- Rung 4, instruments and duties: DONE 2026-08-22 ([story](docs/HISTORY.md#rung-4-instruments-and-duties-done-2026-08-22)).
- The owner's instance migrated to `~/rfa/acme`: DONE 2026-08-22 ([story](docs/HISTORY.md#the-owners-instance-migrated-done-2026-08-22)).
- Rung 7, the front door: DONE 2026-08-22 ([story](docs/HISTORY.md#rung-7-the-front-door-plan-sect-13-amendment-of-2026-08-22-done-2026-08-22); [second pass](docs/HISTORY.md#the-front-door-second-pass-2026-08-22-from-the-owners-first-hour-with-it-done)).
- Agent modes, RFA-0.4 sect. 3.12: DONE 2026-08-22, `auto` withdrawn 2026-08-23 ([story](docs/HISTORY.md#agent-modes-rfa-04-sect-312-amendment-of-2026-08-22-done-2026-08-22)).
- The gate run for real on the Mac Studio test project: DONE 2026-08-23 ([story](docs/HISTORY.md#the-gate-run-for-real-on-the-mac-studios-test-project-2026-08-23)).
- The Evals tab, the labelling sitting in place: DONE 2026-08-23 ([story](docs/HISTORY.md#the-evals-tab-the-labelling-sitting-in-place-2026-08-23-done)).
- `rfa agent edit` as a walkthrough: DONE 2026-08-23 ([story](docs/HISTORY.md#rfa-agent-edit-as-a-walkthrough-2026-08-23-done)).
- The Tasks tab: DONE 2026-08-23 ([story](docs/HISTORY.md#the-tasks-tab-2026-08-23-done)).
- A whole-CLI review, every finding fixed: DONE 2026-08-24 ([story](docs/HISTORY.md#a-whole-cli-review-and-every-finding-fixed-2026-08-24-done)).
- First-use follow-ons (task-by-capability, `rfa ask --reply`): DONE 2026-08-24 ([story](docs/HISTORY.md#first-use-follow-ons-2026-08-24-done)).
- Reflection, rung A (RFA-0.4 sect. 5.4): DONE 2026-08-24 ([story](docs/HISTORY.md#reflection-rung-a-2026-08-24-done)).
- The three-layer tool fence (bypass mapping, harness-internal tools, account connectors): FOUND LIVE AND FIXED 2026-08-24 and 2026-08-25 ([story](docs/HISTORY.md#bypass-was-wider-than-the-pack-2026-08-24-found-live-fixed)).
- Rung 5, the guest path: NOT STARTED, gated exactly as v0.5 sect. 22 rung 11 gates it.
- Rung 6: NOT STARTED, needs the publishing decision (plan sect. 10, owner) and a week of use.

## Runbook (after a reboot or to resume)

The instance is a HUB DIRECTORY, never this checkout (RFA-0.7): the owner's is `~/rfa/acme`, the Mac Studio's test project is `~/Dev/rfa-test`. Every command below runs from inside one, or is told with `--dir` / `RFA_DIR`. This repository carries no `agents/`, no `data/` and no instance of any kind; `templates/evals/` is what `rfa init` seeds a new one from.

```bash
rfa                      # the front door: the dashboard here, the onboarding in a folder that is not one yet
rfa up                   # hub + supervisor as daemons; rfa status names them, rfa down stops them
rfa doctor               # every check the findings ledger paid for, each naming its scar
```

Health check: `curl -s http://127.0.0.1:<port>/healthz` answers `{"ok":true}` and needs no credential (RFA-0.6 sect. 8.7). It returns 503 with `Retry-After` while the hub is draining or if another hub has taken its store lock, so it is the right thing for a monitor or a container healthcheck to poll. Do NOT read a 200 from `/console` as health, which is what this runbook used to do: that only proves a file could be read.

Reaching it from a phone or another machine: `rfa hub expose --tailscale` fronts the loopback listener with the tailnet name and records it as `hub.public_url` (then `rfa restart`, which the hub reads at start). The listener stays on loopback on purpose: a proxy terminates identity, a wider bind does not. The public name must be an allowed origin or the browser's `Origin` is refused with 403 by the DNS-rebinding allowlist, which looks exactly like a wrong credential (see the findings ledger); `hub.public_url` is what allows it.

No credential is ever on argv. `.rfa/secrets.json` (0600) holds the operator's own copies and the CLI reads them per call; `rfa secrets set <NAME>` prompts with echo off, or takes `--stdin` / `--from-env`. A `--human-key` on a command line was found sitting in `ps aux` in full on 2026-08-17.

**Backups and restore**: `rfa backup now` writes the dated backup the supervisor writes nightly (SQLite `.backup` copies plus one archive of the room logs, supervisor state, the four runtime files and every pack's memory) into `retention.backup_dir`, outside the hub directory on purpose. `rfa backup ls` lists them; `rfa backup restore <day>` refuses while the hub or the supervisor is running (a database replaced under a process that holds it open is corruption, not a restore), writes a `pre-restore-<instant>` safety backup first, and drops stale `-wal`/`-shm` beside a restored file. The procedure was exercised 2026-08-17 in its pre-0.7 form.

**Agent lifecycle is a CLI, never a copy-paste** (2026-08-19, now `rfa`):

```bash
rfa agent new                       # alone on a terminal: the walkthrough, every setting with its reason
rfa agent new my-agent --kind tool --builtin linear   # or headless, every answer a flag
rfa agent edit my-agent             # the same walkthrough over an existing pack; --editor opens agent.md
rfa agent mode my-agent ask|plan|bypass
rfa agent retire my-agent           # stop, release leases, leave, evict, archive, deregister: eight re-runnable steps
```

The scaffold writes what hand-written packs got wrong here: `RFA_TOKEN` in `secrets` (without it a resident fails with an opaque `unauthorized`), a skill on the card (a participant join is refused without one), budgets (a pack with neither ceiling spends unbounded and warns once), `allow_subagents: false`, and a room binding. It refuses a reserved first token (human, console, system, hub, rfa) with the reason and a suggestion rather than letting the hub refuse it at join, and validates through the same zod schema the supervisor uses, so a generated pack cannot be one the platform then rejects. A resident's tool surface is its declaration and three mechanisms enforce that (RFA-0.4 sect. 3.12): read them before widening one.

Residents live in `<hub directory>/agents/<name>/` (agent.md + knowledge + state); the supervisor watches definitions and does a versioned drain on edit, so the room sees the digest rotate. Logs: `rfa logs hub|supervisor|<agent> -f`. Boot persistence: `rfa service install` (launchd or systemd units running `rfa hub run` and `rfa supervisor run`; refused while `rfa up` daemons are alive). Brain or knowledge changes must pass the parity gate: `rfa evals parity`, twice.

Human principals (0.5.0): joining with a human key grants `origin: human`, required for `role: supervisor`, `room_admin` approve and quarantine release. `rfa human add|ls|rotate` manages them; the CLI acts as the first one. Verified live 2026-08-16: v0.5.0 migrated the standing room in place, pm-agent kept serving through the swap (11.6s round-trip), supervisor join + interrupt intervention delivered.

Room console: `rfa console --room <alias>` opens it. Observer = read-only live view; supervisor (human key) = intervention buttons, floor control, approve/reject, inject. Includes the live agent graph (canvas: members on a circle, kind-colored message pulses, decaying communication edges, task dots pool->owner->fade, ripples for presence/floor/interventions/gone_quiet; reduced-motion aware; toggle in the header). Verified live in a real browser 2026-08-16: history replay, live long-poll stream, inject with @mention (the pm-agent answered the injected chat and correctly refused it as out-of-scope), interrupt round-trip, and the graph animating a full scripted lifecycle.

- Claude Code: `rfa connect claude-code --room <alias> --skill` registers the hub with its own bearer and writes the consult-room skill into the project.
- Ask: `rfa ask "<question>"`; `--reply` continues that room's last conversation, so a challenge lands in the same brain session.
- Watch a room: `rfa room tail <alias> -f`, or the dashboard's Feed tab.
- Join info: `rfa room show <alias> --json`.
- Knowledge: `rfa knowledge status` says what each pack reads and flags a page that exists twice; a git remote is a tracked clone under the pack, never a copied export.

## Known limitations and parked edges

- **Moderation implemented (0.1.5) + the policy gate (0.1.7)**. Still unimplemented by design: `policies.join: "approve"`, `message_ttl_s`; floor state is restart-transient. Human principals need the hub started with `--human-key <k1,k2>` (or `RFA_HUMAN_KEYS`); without one, `approve` and quarantine-release are impossible (that is the point).
- **Native push binding blocked upstream**: MCP v2 SDK's `SubscriptionFilterSchema` is a closed set (no extension-filter hook), so `subscriptions/listen` push waits on the SDK; `room_watch` (spec 11.2b) is the binding. Watch `McpHttpHandler.notify` as the future attachment point.
- `room_watch` needs a persistent connection (stdio); the stateless HTTP mode cannot push.
- Watchers/waiters are process-local (single-hub HA only); per-room event log fully in memory as well as on disk.
- `ask()` cannot run inside the same member's `serve()` loop (single loop owner; use a second member).
- Member already offline at boot with a pending reply gets no `gone_quiet` (deadline timeout covers it; deliberate).

## Gotchas for future sessions

- **A non-interactive shell gets fnm's default Node v20, not the project's.** The repo needs >= 22 and the better-sqlite3 binding is built for v24.19.0 (ABI 137); under Node 20 the CLI preflight refuses init and every store test fails on the binding. Worse, on 2026-08-25 a missing dependency under Node 20 turned `npm test` into a silent multi-hour hang (askreply's hub outliving a crashed before hook; that hook is guarded now). Prefix gate runs with `PATH="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin:$PATH"`.
- Bash `cd` persists between calls; a leaked cd into node_modules once caused scary false alarms. Prefer absolute paths.
- Scratchpad `.ts` scripts run as CJS; name them `.mts` for top-level await.
- Envelope `message_id` minimum 8 chars; the v2 SDK returns input-validation failures as PLAIN TEXT tool results (not JSON).
- Claim-less legacy HTTP posts get SSE-framed responses (`data:` lines); scripted probes should speak the modern era (`Mcp-Method`/`Mcp-Name` headers + `_meta` protocolVersion) for plain JSON.
- Testing agent flows non-interactively: `claude -p "<prompt or /command>" --model sonnet --allowedTools "Skill,Read,mcp__rfa-hub__room_join,mcp__rfa-hub__room_send,mcp__rfa-hub__room_listen,mcp__rfa-hub__room_roster"`.
- Never commit `reports/` or any hub directory's `.rfa/` (gitignored on purpose: reports, secrets, runtime state). `dogfood/` and `data/` no longer exist in the repository; an on-disk `dogfood/` is untracked residue, not source.
- Anti-accretion: when a rung flips to DONE its story moves to `docs/HISTORY.md` in the same commit, and findings are written to `docs/LEDGER.md` with at most a one-line pointer here; `test/statusclaims.test.ts` fails this file past 250 lines.
