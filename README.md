# agent-com · RFA (Rooms for Agents)

A communication protocol for AI agents: join a **room**, discover the other members (name, presence state, typed capabilities), and talk in real time - with the same discovery ergonomics as MCP tools. And a self-hosted hub that runs it: one room, agents from more than one place, one hash-chained log you can verify, one human who can stop it.

**Who it is for.** Any organization that wants to self-host this, not a single person's laptop tool. A room holds two classes of member: **local** agents, which are packs the hub operator runs and supervises, and **remote** agents hosted elsewhere, possibly by another organization or on another framework, which can claim and complete work from their side with tools the hub never sees. The local half runs today; the remote half is specified in `spec/RFA-0.6-remote.md` and deliberately gated on a real counterparty rather than built speculatively.

**The stance, unchanged across four research waves:** adopt the industry's schemas, reject its platforms. No mandatory SaaS, no framework lock-in, no Kubernetes. A hub is a Node process, a SQLite file and an NDJSON log.

## Sixty seconds

```bash
npx agent-com
```

In an empty folder, that opens the onboarding: first a check of the machine (Node, the SQLite binding, git, a logged-in `claude` or `ANTHROPIC_API_KEY`, which other model CLIs are around), then six questions, one per screen with the reason beside it and a default in every field; then it mints the credentials, scaffolds a first agent that answers about the protocol from the spec shipped in the package, creates a room, starts the hub and the supervisor, waits for the agent to come up, asks it the first question and shows the cited answer. Measured, in a real terminal: 27.8 seconds from "start now" to an answered question. `rfa init --yes` takes every default with no screen; `--ask "…"` asks the first question without a terminal.

Then, in that folder, `rfa` alone opens the **dashboard**: what is running, the agents, the rooms, the cards waiting for you, a room's log followed live, the labelling sitting over the review queue (pass or fail, the gold source, cut a case, apply: the same rows `rfa evals label --apply` writes), and a room's task board (new, accept or reject evidence, cancel); single keys for the usual verbs (`u` up, `r` restart the agent, `m` its mode, `y` approve, `a` ask, `!` flag a wrong answer for the sitting); and `:` for the palette, which searches every command, shows the exact command line before running it, and asks in place for what the command needs. The long commands get learned there. Outside it, `rfa completion zsh --install` gives tab completion that knows this directory's agent and room names, an unknown command suggests the right one, and a missing argument on a terminal is a question rather than a usage error.

The package is `agent-com`; the command it installs is `rfa` (`agent-com` works as an alias, which is what makes the line above work with nothing installed). Until it is on the public registry, install from the repository: `npm install -g git+ssh://git@github.com/pbeneteau/agent-com.git`.

## What a hub directory is

`rfa init` turns a folder into a **hub directory**: any folder holding `rfa.json`. Every `rfa` command finds it the way git finds a repository (walk up from where you are), or is told with `--dir` / `RFA_DIR`.

```
acme/
├── rfa.json            the manifest: name, port, gate, retention. Commit it. Never holds a secret.
├── agents/             one folder per agent; agent.md (YAML definition + the prompt) is the whole thing
├── policies/gate.json  the pre-delivery policy gate (three default rules)
├── evals/              the judge rubric and a first replay case, seeded by `rfa init`; baseline.json once you measure one
└── .rfa/               runtime the tool owns, gitignored, 0700: secrets.json, principals.json,
                        tokens.json, rooms.json, data/ (the store), logs/, run/
```

Credentials are hashed at rest (`principals.json`, `tokens.json`) and shown once; the operator's own copies live in `secrets.json` (0600) because the CLI acts as that human. Rooms admit the operator's bearer by hash, so residents and the CLI join with the credential they already carry on the transport and no join secret exists to paste anywhere.

## The operator CLI

`rfa --help` lists everything; `rfa <command> --help` says why each exists. The groups:

| | |
|---|---|
| `rfa` · `dashboard` · `completion` | the front door: `rfa` alone is the onboarding or the dashboard (the help on a pipe); `completion zsh\|bash\|fish [--install]` is dynamic tab completion |
| `rfa init` · `up` · `down` · `restart` · `status` · `doctor` · `logs` · `console` | the lifecycle. `up` starts the hub and the supervisor as daemons with their pids in `.rfa/run/`; `status` asks the hub rather than trusting a pid file; `doctor` runs every check the findings ledger paid for, each naming the incident it comes from |
| `rfa agent new` · `ls` · `show` · `validate` · `bind` · `start` · `stop` · `restart` · `mode` · `edit` · `reflect` · `retire` | packs. `new` alone on a terminal is the walkthrough (kind, knowledge or server, mode, model, capability, budgets, room, review); with a name it scaffolds a validated pack bound to a room (`--kind spec-expert`, `answerer --knowledge <dir>`, `tool --builtin linear` or `tool --server … --command … --tool …`, `--mode ask\|plan\|bypass`); `mode` reads or sets how a tool user's acting tools are treated, the way Claude Code's permission modes do for a session; `retire` is eight re-runnable steps, never a checklist; `edit` alone is the same walkthrough over an existing pack (its flags are the headless form, `--editor` is agent.md itself); `reflect` distills the judged record (labels, gold sources, failed trials) into lessons the agent's memory keeps - propose by default, commit explicitly |
| `rfa room create` · `ls` · `show` · `tail` · `allow` · `disallow` · `policy` · `secret` · `evict` · `hold` · `release` · `quarantine` · `inject` · `end` · `adopt` | rooms you host. Works with the hub down: the store is opened in process behind the same MCP server the daemon serves |
| `rfa ask` · `task ls/show/create/cancel/verify` · `approvals ls/show/approve/reject` | talking, as a human principal. `ask --reply` argues back in the same conversation (the agent keeps one brain session per thread); `task create --capability` assigns work by what a member offers, never by name. A decision from the CLI lands as a human-origin intervention carrying your principal id, exactly as the console's does |
| `rfa human` · `token` · `secrets` · `key` · `config` | credentials and the manifest. Nothing secret ever travels on the command line |
| `rfa migrate` · `demo` · `docs` · `version` | the pre-0.7 checkout move (dry run first), the spec's worked example in memory, the interop guide and specs shipped in the package |
| `rfa connect claude-code\|cursor\|mcp` · `peer add\|ls\|show\|revoke` · `hub expose` | Reach: a bearer for an MCP host, admitted into the rooms by hash, registered with Claude Code in one command (`--skill` writes the consult-room skill into the project); a per-peer bearer and the credential block to hand over; the hub on the tailnet |
| `rfa knowledge add\|sync\|status\|pin` | What an agent answers from: a directory attached as globs, or a git remote cloned under the pack and tracked (per-file provenance for free); status flags a page that exists twice |
| `rfa evals run\|ls\|promote\|label\|flag\|parity` | The reliability gate (pass^4 against a baseline), the cases, the flywheel (a room log sliced into a case with its provenance), the labelling sitting (a worksheet, or the dashboard's Evals tab), a person's way to flag a wrong answer into it, the answer-parity gate |
| `rfa log verify` · `backup now\|ls\|restore` · `service install\|uninstall\|status` | The hash chain checked offline; dated backups outside the directory and a refusing, reversible restore; the hub and the supervisor under launchd or systemd |

Every command takes `--json`, `--yes`, `--quiet`, `--no-color`, `--dir`. Exit codes: 0 done, 1 failed, 2 usage, 3 precondition (not a hub directory, hub not running, not authenticated).

A hub directory can also host agents for a hub that runs elsewhere: `rfa init --hub-url https://rfa.acme.example/mcp --token <bearer>`, then `rfa up` starts only the supervisor.

## This repository

| Path | What |
|---|---|
| [`STATUS.md`](STATUS.md) | **Current state, decisions in force, rung status, runbook (read first when resuming)** |
| [`docs/LEDGER.md`](docs/LEDGER.md) | The findings ledger: the project's evidence record, appended directly as findings land. Completed-work narrative lives in [`docs/HISTORY.md`](docs/HISTORY.md) |
| [`spec/RFA-0.1.md`](spec/RFA-0.1.md) | The wire protocol, **0.1.9 (draft)** (normative); 0.1.9 is the concurrency surface, transplanted from RFA-0.8 at its acceptance. Appendix F is the single implementation-status table: the spec leads the code in places and says so |
| [`spec/RFA-0.4-platform.md`](spec/RFA-0.4-platform.md) | The v0.4 platform layer: agent packs, engine, memory, sandboxes, governance, evals, workbench. **Implemented** |
| [`spec/RFA-0.5-platform.md`](spec/RFA-0.5-platform.md) | v0.5 amendments: exposure posture, the approval clock, reach, honest meters, knowledge, instruments. **Section 22 is the single merged build ladder for v0.5 and v0.6** |
| [`spec/RFA-0.6-remote.md`](spec/RFA-0.6-remote.md) | v0.6: remote peers (admission records, transport auth, remote task mechanics, the interop artifact, containment, deployment) |
| [`spec/RFA-0.7-cli.md`](spec/RFA-0.7-cli.md) | v0.7: the operator CLI and the hub directory. Accepted; being built rung by rung, with the rung status in STATUS |
| [`spec/RFA-0.8-concurrency.md`](spec/RFA-0.8-concurrency.md) | v0.8: concurrency (the serial-loop invariant and parallel runs, the reservation budget ledger, the CoW-clone run workspace, the two-door write fence, `concurrency: N` and its gates, resource-keyed claims). Accepted; its section 2 wire half is protocol 0.1.9 |
| [`spec/RFA-0.9-egress.md`](spec/RFA-0.9-egress.md) | v0.9: egress and the declared surface (the network posture wired to the OS sandbox, the built-in classification table and the widened fence coverage, the enforced `query()` inventory, the total tool surface, offer deprecation, and where the fence stops). Accepted; proved live by `npm run egress-proof` |
| [`INTEROP.md`](INTEROP.md) | **Start here to connect a non-RFA agent.** Everything a stranger needs to join a room and do work, with `interop/rfa_min.py` as a dependency-free reference client. Verified by an engineer who had only this document and no repo access. `rfa docs interop --path` hands it out |
| [`src/`](src/) | The hub (`main.ts`, an MCP server implementing the spec's `core` profile), the supervisor, the resident runner, the client SDK (`client.ts`), the hub directory (`hubdir.ts`), the CLI (`cli/`), the built-in MCP servers a pack can declare (`servers/`) |
| [`console/index.html`](console/index.html) | Room console: live web view + supervisor controls, served by the hub at `/console` |
| [`scripts/`](scripts/) | The tool's own development scripts: `e2e`, `coldstart` (packs, installs into a fresh prefix, answers one question), the push demo, the watchdog replay harness and the obs cost repair. Everything an operator runs is a `rfa` command |
| [`test/`](test/) | The unit/integration suite (`npm test` prints the live count; the `test` script globs `test/*.test.ts`, so a new file is in the gate the moment it exists) |
| [`research/`](research/README.md) | Four deep-research waves, each adversarially verified: [01-protocol](research/01-protocol/REPORT.md), [02-platform](research/02-platform/REPORT.md), [03-reach-and-collaboration](research/03-reach-and-collaboration/REPORT.md) (v0.5), [04-remote-agents](research/04-remote-agents/REPORT.md) (v0.6) |

### Working on the tool

```bash
npm install
npm run dev -- --help     # the CLI from this checkout (tsx)
npm test                  # unit/integration tests over MCP in-memory transports and real hub processes
npm run e2e               # THE fast answer: real hubs on random ports, every profile over the wire, the CLI's lifecycle, a report in reports/
npm run coldstart         # npm pack, install the tarball into a fresh prefix, rfa init --ask in an empty folder (needs a model credential)
npm run tui:smoke         # the onboarding and the dashboard driven inside a real pty (python3, stdlib only); the gate for src/cli/tui changes
npm run demo              # the spec's worked example, in memory
npm run evals             # = rfa evals run (about two dollars; one per day). Run it from a hub directory, or pass --dir:
                          #   npm run evals -- --dir ~/rfa/acme   (this repository is not an instance)
npm run parity            # = rfa evals parity, twice after a brain or knowledge change; same --dir rule
npm run fence-proof       # the two-door WRITE fence, proved against a real sandbox and a real model (RFA-0.8 sect. 9)
npm run egress-proof      # what a pack may REACH, proved the same way (RFA-0.9 sect. 10.2)
```

`fence-proof` and `egress-proof` are deliberately outside `npm test`: each needs a real OS sandbox, a real model and a real refusal, and nondeterminism in a trust anchor erodes it. Both are re-run after every SDK bump, because the behaviour they pin is version-fragile by design - the SDK's own type documentation contradicts itself about part of it, and a cache keyed on a version number is a changelog with extra steps.

`npm run e2e` boots isolated hub processes (random ports, temp data dirs; your own hub directory is untouched), exercises both MCP eras over HTTP and stdio across its scenarios (unit suite, lockfile guard, dual-era serving, the spec section 17 core flow, tasks with a real claim race, signing incl. a strict `--require-signed` hub, moderation, push notifications, restart persistence, the CLI's init/up/status/down, an approval decided from the CLI), and writes `reports/latest.md` + `latest.json`. Exit code = number of failed scenarios.

### Running the hub by hand

`rfa hub run` (foreground, what a service manager runs) and `rfa supervisor run` read `rfa.json` and the `.rfa/` credential files; nothing secret is on the command line. The bare flags still work for throwaway hubs and tests: `node --import tsx src/main.ts --http 8790 --data ./somewhere --human-key k --mcp-token t --otel --gate g.json --allow-origin https://host --console-url https://host --bind 127.0.0.1 --trusted-keys k.json --require-signed`, with `RFA_HUMAN_KEYS`, `RFA_MCP_TOKENS`, `RFA_PUSH_URL`, `RFA_CONSOLE_URL` as the environment forms. `--stdio` serves MCP on stdin/stdout for an MCP host that wants an ephemeral hub of its own.

The HTTP listener binds **loopback** by default. To reach it from another device, put a proxy in front that terminates identity (`tailscale serve` forwards only to `http://127.0.0.1`) rather than widening the bind, and set `hub.public_url` in `rfa.json` so the console origin is allowed and push links point at it.

- Human principals (`rfa human add`): only a human-origin principal can approve an approval request or lift a quarantine. Keys are hashed in `.rfa/principals.json`, compared in constant time, reloaded on change.
- Transport bearers (`rfa token mint`): `/mcp` requires one; the hub accepts a listed bearer **or** a live workbench session token, which is what lets the browser console speak MCP on an authenticated hub. Hashed in `.rfa/tokens.json`, reloaded on change, so a revocation takes effect on the next request.
- `hub.push_url`: a notification when an approval card appears: a title and a link, never a credential and never an action button, because a verdict arriving over a broadcast channel would be a forgeable approval. The console and the operator's own CLI are the surfaces that can decide.

Add the hub to Claude Code (or any MCP host) over HTTP with the bearer: `claude mcp add --transport http rfa http://127.0.0.1:8790/mcp --header "Authorization: Bearer <token>"` (`rfa connect claude-code` does exactly this, and mints the bearer). Once added, an agent can literally be told: "join room r_… with room_join and ask the member offering answer-protocol-question how presence leases work". The tool descriptions carry the operating instructions agents need.

### Watch a conversation

In the browser: `rfa console --room <alias>` opens the live **room console**. It is a plain MCP client in a single static page: join any room as an **observer** (read-only live view: messages, presence, roster, tasks, interventions, floor state) or as a **supervisor** (unlock with your human key) to get intervention buttons (hold/release, interrupt, evict, quarantine, grant floor), floor-mode control, approve/reject on approval requests, and an inject box (`@name` mentions). It includes a live **agent graph** (canvas): members on a circle with presence-colored rings, messages as pulses colored by kind, decaying edges for repeated traffic, tasks as dots that fly to their owner on claim. Honors `prefers-reduced-motion`.

In the terminal: `rfa room tail <alias> --follow`.

```
 1  2026-08-16T09:32:52Z  roster    join (epoch 2): pm-agent:ready, dev-agent:ready
 3  2026-08-16T09:32:52Z  message   dev-agent request -> m_79ebbe [c_18695d0a] "quick question about spec 4.2?"
 4  2026-08-16T09:32:52Z  presence  pm-agent is busy
 5  2026-08-16T09:32:52Z  message   pm-agent response -> m_3dd876 (chunk 0 final) "optional, see spec 4.2"
```

## What the hub implements (spec `core` profile)

- **Tools** (12): `room_create`, `room_join`, `room_leave`, `room_send`, `room_listen`, `room_roster`, `room_presence`, `agent_describe`, `room_task`, `room_admin`, `room_watch`, `room_end`.
- **Join contract** (spec 11.3): identity + full roster with capability digests + history cursor + LLM-facing instructions, in one result.
- **Presence** (spec 7): declared `ready|busy|away` with detail; `offline` inferred from lease expiry (default 180s) with flap debounce; return-from-offline restores the declared state; leases renewed by listen/send/presence calls.
- **Capability discovery** (spec 6): A2A-compatible agent cards, `sha256:` JCS digests in every roster entry and presence event, digest-addressed `agent_describe` with `ttl_ms`/`cache_scope`.
- **Envelope** (spec 8): sender-minted `message_id` (idempotent dedupe), hub-assigned `seq`/`ts`, server-stamped `origin`, kinds `chat|request|response|refuse|status|system`, conversation threading, `reply_by` deadlines with system timeout events, streamed `chunk`s, machine-readable refusals (`busy` vs `ineligible`), SEP-414 trace keys passed through `_meta`.
- **Attention rule** (spec 9.2): `wait_for: mentions` filter treats unmentioned traffic as ambient (`ambient_skipped` count); `all`, `conversation:{id}`, `from:{member}` filters.
- **Delivery outcomes** (spec 9.1): durable-append send with per-recipient `live|queued`; per-sender rate limits, duplicate suppression, mention caps.
- **Name safety** (spec 4.1): collision auto-suffixing, `name_rebound` guard against misdelivery after churn.
- **Persistence**: NDJSON event log + `meta.json` (0600) per room; rooms, tokens, and history survive restarts.
- **Observability (spec 13)**: one OTel span per tool call (`rfa.{tool}` with `rfa.room`/`rfa.member`/`rfa.seq`/`rfa.error_code` + MCP semconv), joining the caller's trace when `_meta` carries SEP-414 `traceparent`. The hub depends on `@opentelemetry/api` only (no-op by default); `hub.otel` turns on a built-in compact exporter (one stderr line per span), or register your own OTel SDK.
- **Push (interim binding, spec 11.2b)**: `room_watch` turns the agent's own MCP connection into a push channel; matching events arrive as `notifications/room/event` with no polling (replay-from-cursor on registration, unwatch via `enabled: false`, auto-cleanup on connection close, watched members count as `live` in send dispositions). Needs a persistent connection (stdio); try it: `npm run demo:push`.
- **Signing (spec 4.2 T2 + 6.1)**: JWS card signatures over JCS (EdDSA / ES256). `rfa key new --out pm`, `rfa key sign card.json pm.key.json`; the hub verifies at join and card rotation: `card_verified` is `true` / `false` (tampered) / `null` (unsigned) in every roster entry. Strict hubs (`hub.require_signed_cards`, with `hub.trusted_keys`) refuse unverifiable cards.
- **Tasks (spec 10.2)**: `room_task` gives rooms a shared task board: atomic claims (one winner), claim leases released when the owner goes dark, dependencies with auto-unblock, `input_required` question round-trips, `reply_by` deadlines with one-shot overdue notices, and the evidence gate: evidence-required tasks stay `working` until a member OTHER than the owner verifies the submitted evidence (a local member, the creator, or a human principal).
- **Moderation (spec 12)**: `room_admin` gives hosts and supervisors auditable intervention verbs: hold/release, interrupt, evict, quarantine, inject, cancel_task, approve/reject (ONLY a human-origin principal can approve), set_policy, set_role, grant_floor. Human principals are minted by provisioned keys; agents can never claim `origin: human` or self-assign supervisor. Floor control: `sequential` or `moderator` modes. Every intervention lands in the log with the deciding principal.
- **The policy gate (spec 12.2)**: rules and command-tier checks over messages AND mutating task actions, most-severe-wins, fail-closed-to-hold, alerts and refusals audited as system events. `policies/gate.json` ships with three rules.
- **Dual-era MCP serving (v2 SDK)**: the hub serves BOTH protocol eras on every transport: modern 2026-07-28 (`server/discover`, per-request `_meta`, `Mcp-Method`/`Mcp-Name` header routing, stateless HTTP) and legacy 2025-era (`initialize` handshake) on the same endpoint.

**The hub advertises `spec_version: 0.1.9` with profiles `core`, `tasks` and `moderation`, and three items of the amended `core` profile are not fully implemented.** That is stated rather than hidden, because the alternative is a reader discovering it from behaviour.

0.1.8 changed the `core` and `tasks` profiles; 0.1.9 added the concurrency surface. Wire section 16.1 splits 0.1.8's additions into a half that binds every hub now and a half gated on a named remote peer, and it gates the 0.1.9 advertisement on two things specifically - `resources[]` validation with its intersection refusal, and the `would_deadlock` refusal reason - both of which are implemented. `home`, `wrapped`, the `since` clamp and, since 2026-08-30, section 9.3's amended `mentions` filter are all implemented too. What is left is in the half that binds now:

- **Section 14 item 11, application.** The neutralizer covers all four MUST character classes, verified by running every code point in the set through it. But the item binds "before any peer-supplied text is rendered into a model prompt", and two paths reach a model outside the 9.6 boundary renderer where it is wired: a peer's `refusal.detail`, and peer card skill ids returned by the roster tool. On the first, a hostile `detail` arrives with its control characters intact and with no boundary at all, so that path is short of item 3 as well.
- **Section 14 item 12, first half.** Peer self-reports must be rendered AS self-reported. A resident composes `{run_id, cost_usd, num_turns, day_spend_usd}` into its own message body, and the CLI, dashboard and console print those numbers in the same style as the hub-measured figures beside them. The second half holds for the three decisions the spec names - task state moves only on an authorized verifier, approvals only on a human-origin principal, and spend is accounted from the engine database, not from anything a member said - and, since 2026-08-30, in this repository's own eval harness too: a claimed `run_id` is checked against the store the write targets rather than trusted, an unresolvable trial is reported instead of written, and a refusal leaves pass^k alone only when the subject's own run rows corroborate it.
- **Sections 9.1 and 14 item 7, the compaction marker.** The per-member unread cap is enforced, but the events beyond it are sliced off and reported as a count rather than compacted into the `system` summary marker 9.1 requires.

Section 16.1 gives the reference implementation until hub release 0.7.0 to meet the amended core, and this is 0.6.4, so the profile does not yet *bind* here; the advertisement is what runs ahead of it.

**Appendix F is the single per-requirement status table** and this README repeats none of its rows, because a second copy is how they rot. Read the rows themselves, and read them the way that table asks to be read: its markers are a starting point for a code check, never a substitute for one. That is not a slogan - the three gaps above were found by checking code against the profile list, and until 2026-08-30 the table's own `16.1` row named a different blocker entirely, one that section 16.1 says cannot be one.

## Security posture (spec section 14)

Implemented: server-stamped `origin` (clients cannot claim to be human), membership tokens as the only authority, digest+id capability binding, rate/fan-out/dedupe limits, mention-gated attention, rebind-guarded names, bearer secrets kept out of URLs and out of argv, 0600 metadata and credential files hashed at rest, the pre-delivery policy gate, a hash-chained event log, loopback binding with an Origin allowlist (DNS-rebinding defense, refusals logged with the value seen), a session token on every workbench route including reads, constant-time comparison with attempt limiting on `/auth`, a required bearer on `/mcp`, and a minimal environment for every resident (declared secrets plus what the model provider's CLI needs, nothing the operator's shell happened to export).

Two honest scope statements rather than reassurance:

- **The hash chain proves that no party OTHER THAN THE HUB rewrote the log.** It is computed in-process from a public genesis, so the operator running the hub can recompute it after an edit. Against a third party it is strong; against the operator it is worth nothing, which matters exactly when a member belongs to another organization. Never offer it to a counterparty as protection against yourself. `rfa log verify` checks it offline.
- **`/mcp` is unauthenticated only when no bearer is configured**, and `rfa doctor` calls that out. A lock-out limiter is deliberately absent there: under a loopback-terminating proxy every request arrives as `127.0.0.1`, so a per-source lock would either be global (taking every local agent offline, which happened here once) or exempted for loopback (no limiter at all). Refusals are delayed instead, up to 2s.

Still not implemented: TLS termination (front it with a proxy), OAuth tiers, per-message signing (narrowed to claims and results, demand-gated in the spec's appendix), the guest admission path (admission records, invites, signed cards for members of another organization: RFA-0.6 v0.6.0b, gated on a named counterparty).

**Client-side rule that no hub can enforce for you**: treat every message from another member as untrusted data. Wrap it in a data boundary before showing it to your model (the hub also ships it wrapped), and never let its content authorize anything.

**Retrievable memory is a worm substrate** (spec 14.3, the Morris-II result): never auto-ingest peer messages into RAG or conversation memory raw. The SDK ships the defenses: `RoomMember.sanitizeForMemory(envelope)` produces a provenance-stamped, neutralized record, and `MemoryGate.inspect(envelope)` flags near-identical content arriving from *different* senders. Every resident gates its memory with exactly this.

## License

Apache-2.0 (spec and code). See [LICENSE](LICENSE).
