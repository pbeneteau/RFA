# RFA v0.7: the operator CLI and the hub directory

**Platform plan, version 0.7.0 (PROPOSAL)**
Status: **ACCEPTED by the owner on 2026-08-22, with the recommendations of section 10 as written. In force; being built rung by rung** (section 9; each rung's status is recorded in STATUS.md, never here, so this document cannot drift from the code). Date: 2026-08-22 · License: Apache-2.0 (see LICENSE)
Depends on: protocol 0.1.8 (no wire change is proposed), [RFA-0.4-platform.md](RFA-0.4-platform.md) (packs, supervisor, secrets, deployment), [RFA-0.5-platform.md](RFA-0.5-platform.md) (exposure, the verdict surface), [RFA-0.6-remote.md](RFA-0.6-remote.md) (transport auth, admission, packaging).
Amends: v0.4 sect. 3.1 (where packs live), 6.3 (where secrets live), 10 (deployment: `rfa.json` is finally built, launchd becomes `rfa service`), 11 (the `rfa ask` CLI grows into the whole operator surface); v0.5 sect. 17.2 (the verdict surface); v0.6 sect. 3.1 (the admission file's location), 8.8 (packaging). Section 11 lists every amendment with its reason.

The key words MUST, MUST NOT, SHOULD and MAY are as in RFC 2119, and they are used sparingly here: this is a plan, and most of it is a design to be accepted or changed, not a conformance rule.

---

## 0. Summary

Today the tool and the thing the tool runs are one directory. The repository checkout is the hub: `agents/`, `data/`, `dogfood/ROOM.md`, `deploy/gate.json` and `evals/` sit beside `src/`, every entrypoint resolves its paths from `path.resolve(import.meta.dirname, "..")`, and the way an organization gets a hub is `git clone` plus four shell incantations from a runbook. That is the shape of a research repository, not of a product an organization installs.

This plan separates the two and puts a complete operator CLI in front of the result:

- **The tool** is an npm package, `agent-com`, that installs one binary, `rfa` (with `agent-com` as an alias so `npx agent-com init` works from an empty folder with nothing installed). It contains the hub, the supervisor, the resident runner, the client SDK, the console page, the specs, the interop guide and the CLI. It contains no instance state.
- **A hub directory** is any folder holding `rfa.json`, the deployment manifest RFA-0.4 sect. 10 specified and never built. It is the operator's: packs under `agents/`, policies, evals, and a gitignored `.rfa/` runtime the tool owns. `rfa init` creates one. The tool finds it the way git finds a repository: walk up from the working directory.
- **The CLI is the whole operator surface.** Lifecycle (`init`, `up`, `down`, `status`, `doctor`, `logs`, `service`), agents (`agent new|ls|show|validate|bind|start|stop|restart|edit|retire`), rooms (`room create|ls|show|tail|allow|policy|evict|end`), talking (`ask`, `task`, `approvals`, `console`), credentials (`human`, `token`, `secrets`, `key`), reach (`connect`, `peer`, `hub expose`), instruments (`evals`, `knowledge`, `log verify`, `backup`), and the tool's own affairs (`config`, `migrate`, `docs`, `demo`, `version`). Every command has a non-interactive form and a `--json` form. The fourteen scripts under `scripts/` and `dogfood/parity.ts` fold into it; only the tool's own development scripts (`e2e`, the demos, `watchdog-replay`, `repair-obs-cost`) stay behind.
- **Admission for the operator's own agents becomes bearer-implied.** A room created by the CLI lists the operator bearer's hash in `join_bearer_sha256` (shipped 2026-08-21), so residents, the CLI and a developer's Claude Code session join with the credential they already carry on the transport and no join secret exists to paste anywhere. The join secret stays as the legacy path for clients that cannot send a header.
- **Rooms become something the operator creates**, hosts and administers, with an alias (`product`), instead of a side effect of which pack booted first without a `rooms:` binding. `dogfood/ROOM.md` and its six regex readers go away.
- **Onboarding is one command.** `rfa init` in an empty folder asks six questions, explains the three parts it is creating, mints the credentials, scaffolds a first agent (a zero-config one that answers about the protocol from the spec shipped inside the package), creates a room, starts the hub and the supervisor, waits for the agent to come up, and offers the first question. Target: a fresh machine with a logged-in `claude` goes from empty folder to an answered question in under two minutes.

The work is sequenced in six rungs (section 9). Rung 0 is the refactor that moves every path through one module; it is the prerequisite for everything else and is the only rung that touches the live hub's layout. Six decisions are the owner's and are collected in section 10; the one with consequences outside this repository is publishing, because `npx agent-com init` from an empty folder needs a public package and the repository is private by decision.

---

## 1. Diagnosis: where the tool and the instance are fused today

Every item below was read from the code at HEAD (`f11ef7e`) on 2026-08-22, not inferred from a status table.

**Paths.** The repository root is the instance root, by construction, in every entrypoint: `src/main.ts:227`, `src/supervisor.ts:36`, `src/resident.ts:33`, `src/consolidate.ts:23`, `src/evals/runner.ts:63`, `dogfood/parity.ts:38`, and every script under `scripts/`. From that root, fixed relative paths are read or written in at least these places:

| Path | Readers and writers |
|---|---|
| `agents/` | supervisor registry, resident, hub workbench (`/api/agents`, definition GET/PUT), evals runner, new-agent, retire-agent, consolidate |
| `data/rooms/`, `data/runs.db`, `data/obs.db`, `data/auth.log.ndjson`, the store lock | hub, supervisor, resident, retire-agent (reads meta snapshots), verify-log, promote-case, label, watchdog-replay |
| `data/secrets.json` | supervisor (injection), `transportToken()` in ask, parity, evals, retire-agent, init |
| `data/supervisor-state.json`, `data/supervisor-commands.ndjson`, `data/ops-room.json`, `data/ops-digest.json`, `data/judge-count.json`, `data/retired/` | supervisor, hub workbench (lifecycle route appends commands), retire-agent, judge |
| `dogfood/ROOM.md` | written by the room-creating resident; read with a regex by ask, parity, the evals runner, new-agent, and the two `.claude/` skills (six readers; `scripts/init.ts` documents the ENOENT this produced) |
| `dogfood/state/human-key.txt`, `dogfood/state/*.log`, `dogfood/state/parity.json`, `dogfood/state/pm-agent.json` | init, ask, retire-agent, the resident's legacy-state migration, parity, the launchd plists |
| `deploy/gate.json`, `deploy/*.plist` | the hub runbook; `deploy/install.sh` |
| `evals/cases`, `evals/baseline.json`, `evals/rubric.md`, `reports/` | evals runner, judge, sync-handbook `--pin`, label |
| `console/index.html` | served by the hub from the SOURCE tree, read per request (`src/main.ts:922`) |
| `~/Backups/rfa-agent-com` | the supervisor's nightly backup (`src/supervisor.ts:548`) |

**Processes.** The supervisor spawns `src/resident.ts` through `node --import tsx` (`src/supervisor.ts:38`, `src/proc.ts`). `tsx` is a devDependency, so a published package cannot start a resident at all. `foreignResident()` in the supervisor and `residentAlive()` in retire-agent scan `ps` for the literal `resident.ts`. The launchd plists bake in `/Users/paulbeneteau/Dev/agent-com` and run `npx tsx`, the three-process shape `src/proc.ts` documents as unkillable.

**Configuration.** The hub is configured by eleven argv flags and seven environment variables; the supervisor and residents by `RFA_HUB_URL`, `RFA_TOKEN`, `RFA_JOIN_SECRET` and `RFA_ACCOUNT_MAX_INFLIGHT`. The runbook in STATUS is four lines of shell, and `scripts/init.ts` records that `RFA_HUB_URL` "is the one people get wrong": a second checkout's residents pointed themselves at the first checkout's hub and were saved by a 401.

**The package.** `package.json` is named `rfa-hub`, declares one bin (`rfa-hub` → `dist/main.js`, the hub only), has no `files` field, and `tsconfig.json` builds `src/**` alone, so nothing under `scripts/` ships. `dist/` has never been built in this checkout; `tsc --noEmit` is clean (checked after `npm install` on 2026-08-22; an earlier check in the same session read `$?` of a `tail` rather than of `tsc` and reported success on a checkout with no `node_modules`, which is recorded here because a gate whose exit code is not the one read is not a gate).

**Tenant code inside the generic runner.** `src/resident.ts:401-451` hard-codes a Linear MCP tool server and `LINEAR_API_KEY`, and the resident's `query()` passes a fixed `mcpServers: { rfa, memory, linear }`. The pack schema (`src/agentdef.ts`) has no `mcp_servers` field although RFA-0.4 sect. 3.2 lists one. Consequence: `npm run new-agent -- x --kind tool` scaffolds `tools.allow: [mcp__yourservice__do_thing]` and an `interrupt_on` entry for it, and the runtime has no way to load that server. The scaffold is a promise the runner cannot keep. A CLI that offers "an agent that acts" must fix this or not offer it.

**The room.** A room exists because the first resident with no `rooms:` binding created one and wrote its join info to a markdown file. The comment in `scripts/init.ts` gives the reason (one code path for room creation rather than two that disagree), and it was the right call for a dogfood tenant. For an operator it means the room is an accident of boot order, the secret lives in a file a regex reads, and there is no way to create a second room except by scaffolding an unbound pack.

None of this is a defect in the hub or the protocol. It is the difference between a repository that was built by running it and a tool that is installed.

---

## 2. The shape

### 2.1 Two things, two homes

| | The tool | A hub directory |
|---|---|---|
| What | The npm package `agent-com` | Any directory containing `rfa.json` |
| Who owns it | This repository | The operator (usually its own git repository) |
| Contains | `dist/` (hub, supervisor, resident, consolidate, evals, cli), `console/`, `templates/`, `interop/` + `INTEROP.md`, `spec/`, `README.md`, `LICENSE` | `rfa.json`, `agents/`, `policies/`, `evals/`, `peers/` (later), `.rfa/` |
| State | none | all of it |
| Found by | `PATH` | `--dir`, then `RFA_DIR`, then walking up from the working directory |

One machine can hold several hub directories (staging and production, two tenants), each on its own port, each with its own store lock. Nothing in the tool is per-user or global: no `~/.rfa`, no registry of known directories. That can come later if a real need appears; today it would be a second place for state to live.

### 2.2 The hub directory layout

```
acme/                          a hub directory: any folder holding rfa.json
├── rfa.json                   the manifest (tracked). Never holds a secret.
├── agents/                    one pack per folder (tracked). state/ and knowledge clones are gitignored.
│   ├── pm/agent.md
│   └── scribe/agent.md
├── policies/
│   ├── gate.json              the pre-delivery policy gate (tracked; was deploy/gate.json)
│   └── trusted-keys.json      optional: kid -> public JWK for card verification (tracked)
├── evals/                     cases/, baseline.json, rubric.md, parity.json (tracked)
├── peers/                     admission records, when the guest path lands (tracked: hashes and thumbprints only)
├── .gitignore                 written by init
└── .rfa/                      runtime, owned by the tool. Gitignored. Mode 0700.
    ├── secrets.json           NAME -> value, 0600. RFA_TOKEN, RFA_HUMAN_KEY, and whatever packs declare.
    ├── principals.json        human principals: {id, label, key_sha256, created_at}. 0600. No plaintext.
    ├── tokens.json            transport bearers: {id, label, kind, sha256, created_at, expires_at}. 0600. No plaintext.
    ├── rooms.json             rooms this operator created: alias, handle, join_secret, the operator's membership. 0600.
    ├── data/                  the hub store: rooms/*.ndjson + *.meta.json, runs.db, obs.db, auth.log.ndjson, the lock
    ├── supervisor/            state.json, commands.ndjson, ops-room.json, ops-digest.json, judge-count.json
    ├── logs/                  hub.log, supervisor.log
    ├── run/                   hub.pid, supervisor.pid (written by rfa up, removed by rfa down)
    └── retired/               archives written by rfa agent retire
```

Pack-local state stays where it is, inside the pack: `agents/<name>/state/` keeps `member.json`, `memory.db`, `heartbeat` and `resident.log`, because they belong to that agent and `rfa agent retire` archives them as a unit. Only the hub's and the supervisor's files move under `.rfa/`.

Why a dot-directory and not `data/` beside `agents/`: the complaint this plan answers is that what the operator edits and commits is mixed with what the tool owns. After `rfa init` an `ls` shows four things a person wrote or will write (`rfa.json`, `agents/`, `policies/`, `evals/`) and nothing else. The audit artifact is still a file you can `cat` (`.rfa/data/rooms/<handle>.ndjson`), `rfa room tail` and `rfa log verify` point at it, and `rfa.json` can relocate it (`paths.runtime`) for an operator who wants it visible.

### 2.3 `rfa.json`, the manifest

One JSON file, validated by a zod schema in `src/hubdir.ts`, versioned by an integer so a newer tool can migrate it and an older tool can refuse it. It holds configuration and nothing secret. RFA-0.4 sect. 10 named it and sketched its contents ("residents map, env, checkpointer/store TTL sweeper, http toggles, modeled on `langgraph.json`"); this is the first concrete form.

```jsonc
{
  "rfa": 1,
  "name": "acme",                       // names the instance: process titles, backup folder, service labels
  "hub": {
    "port": 8790,                       // this directory RUNS a hub. Mutually exclusive with "url".
    "bind": "127.0.0.1",                // loopback stays the default (v0.5 sect. 15.1)
    "public_url": null,                 // e.g. "https://rfa.acme.example": console links, push links, the Origin allowlist
    "allow_origins": [],                // extra browser origins; public_url's origin is added automatically
    "otel": true,
    "gate": "policies/gate.json",
    "require_signed_cards": false,
    "trusted_keys": null,               // "policies/trusted-keys.json"
    "push_url": null                    // notification-only push (v0.5 sect. 17.3); the URL is not a secret
  },
  "agents": {
    "dir": "agents",
    "max_inflight": 2                   // the account layer's cap (RFA_ACCOUNT_MAX_INFLIGHT today)
  },
  "retention": {
    "obs_days": 14,
    "backup_keep": 7,
    "backup_dir": "~/Backups/rfa/acme"  // outside the directory on purpose: a backup inside the thing backed up is not one
  },
  "paths": {
    "runtime": ".rfa"                   // relocate the runtime if you must
  }
}
```

A directory whose hub runs elsewhere (section 2.6) writes `"hub": { "url": "https://rfa.acme.example/mcp" }` instead of `port`/`bind`. The two forms are a discriminated union in the schema; a manifest with both is invalid.

Every hub flag that exists today keeps working (`--http`, `--data`, `--gate`, `--human-key`, `--mcp-token`, `--otel`, `--allow-origin`, `--console-url`, `--push-url`, `--bind`, `--trusted-keys`, `--require-signed`), because `test/hubproc.ts` and `scripts/e2e.ts` start hubs with them and an e2e harness that has to write a manifest to start a throwaway hub is worse. Precedence: explicit flag, then environment, then `rfa.json`, then the built-in default. `rfa hub run` reads the manifest and passes nothing on argv that is a secret.

### 2.4 Credentials: four kinds, one model

Today there are three credentials with three homes and three delivery paths: human keys in `dogfood/state/human-key.txt` passed through `RFA_HUMAN_KEYS`, transport bearers in `data/secrets.json` passed through `RFA_MCP_TOKENS`, and a join secret in `ROOM.md` passed through `RFA_JOIN_SECRET`. The CLI is the moment an operator forms a mental model of them, so the model has to be small.

| Kind | What it grants | At rest | Who holds the plaintext | Commands |
|---|---|---|---|---|
| **Human principal key** | `origin: human`: approve, release a quarantine, supervise, unlock the console | `.rfa/principals.json` as `{id: "hp_…", label, key_sha256}`. **Hashed.** | The human it was shown to, once. The operator's own key also sits in `.rfa/secrets.json` as `RFA_HUMAN_KEY`, because the CLI acts as that human. | `rfa human add|ls|rotate|remove` |
| **Transport bearer** | Reach `/mcp` at all (RFA-0.6 sect. 4.2). Kinds: `operator` (residents and the CLI), `client` (a developer's MCP host), `peer` (an agent elsewhere) | `.rfa/tokens.json` as `{id, label, kind, sha256, expires_at}`. **Hashed.** | Operator: `.rfa/secrets.json` as `RFA_TOKEN`. Client and peer: shown once, or written into the MCP host's config when the operator asks. | `rfa token mint|ls|revoke`, and `connect`/`peer` mint them for you |
| **Room admission** | Which bearers may `room_join` without a secret | The room's own `join_bearer_sha256` policy, in the hub store (wire 4.3, first slice, shipped 2026-08-21) | nobody: hashes only | `rfa room create` lists the operator bearer; `rfa room allow <room> --token <label>` adds another |
| **Join secret** | The legacy, attribution-free admission for a client that cannot send a header | `.rfa/rooms.json` | the operator | `rfa room secret show` (rotation is not implemented in the hub today; see section 11) |

Membership tokens are runtime and stay the hub's business; the CLI persists only its own, in `rooms.json`.

Two hub changes make the table true, both contained and both aligned with rules the specs already state:

1. **`--principals-file` and `--tokens-file`.** The hub loads both, compares `sha256(presented)` against the stored digests in constant time (`constantTimeMatch` in `src/principals.ts` already exists; `matchPrincipal` derives `hp_` ids from the key today and simply stores them instead), and **watches both files for changes**, applying RFA-0.6 sect. 3.1's reload rule as written: a malformed edit is refused loudly and the previous set retained, never an empty set. Revoking a token or a human takes effect on the next request without a restart, which is what "revoke" has to mean for a CLI verb. `RFA_HUMAN_KEYS`, `RFA_MCP_TOKENS`, `--human-key` and `--mcp-token` stay for tests and throwaway hubs; when a file is given it wins.
2. **`home` is unchanged.** A bearer-admitted membership is `home: "local"`, exactly as wire 4.3 says for "a principal presenting an operator-provisioned transport credential". A `peer` bearer therefore admits an agent of the operator's own organization running elsewhere, which is the counterparty STATUS names (the owner's LangChain agent and cross-account Claude sessions). A true guest (`home !== "local"`) needs the admission record and the signed card of RFA-0.6 sect. 3, which stays gated (section 9, rung 5); the CLI reserves the flag (`rfa peer add --home`) and refuses it with the reason until that rung lands.

What disappears: `RFA_JOIN_SECRET` as something a pack must declare and an operator must export. The pack scaffold keeps `secrets: [RFA_TOKEN]` only; the approval sidekick (`<name>-hitl`) joins with the same bearer the resident holds. The `join_secret` field of `member.json` stays nullable, as it already is.

### 2.5 Rooms are created by the operator

`rfa room create product --topic "product questions"` calls `room_create` as the operator: `human_key` from secrets (so the creating membership is `origin: human`), the operator bearer on the transport, and policies `{ join_bearer_sha256: [<operator bearer sha256>], history_visibility: "joined_after" }` at create (`createRoom` accepts a `policies` partial; `set_policy` right after covers a hub that does not). The creator is the room's host (wire 5.2), so the operator holds every admin verb on every room it made. The CLI persists `{alias, handle, topic, join_secret, membership_token, member_id, name}` in `.rfa/rooms.json` and resumes that membership for `room policy`, `room allow`, `room evict`, `task`, and `room end`. Aliases are CLI sugar and never reach the wire or `agent.md`: packs bind by handle, exactly as they do today, and `rfa agent bind pm --room product` writes the handle.

Two room-creation paths exist today (a resident with no binding; the supervisor minting `#ops`). After this plan there is one: the CLI. `rfa init` creates the first room and `ops`; the supervisor reads `ops` from `rooms.json` instead of minting it; a pack with no `rooms:` binding fails validation with the fix named (`rfa agent bind <name> --room <alias>`) instead of quietly founding a room. The reason the implicit path existed ("one code path, not two that disagree") is preserved by making the CLI that path.

The operator membership's name is the human's label (`paul`), which the reserved-token rule of wire 4.1 permits for a human principal; the CLI still refuses `human`, `console`, `system`, `hub` and `rfa` as a label so the roster reads unambiguously.

### 2.6 Processes

Nothing merges. The hub owns the store lock; the supervisor is a hub client and a process manager; residents are the supervisor's children in their own process groups (`src/proc.ts`). The CLI adds the two things missing for an operator: a way to start and stop all of it with one word, and a way to name what is running.

- `rfa up` starts the hub and the supervisor as detached daemons (group leaders, stdio to `.rfa/logs/*.log`, pid files in `.rfa/run/`), waits for `GET /healthz` to answer 200 and for the supervisor's state file to appear, and prints what it started. Running it twice says "already up" and does nothing. `rfa down` signals each group with `stopTree` (SIGTERM, wait, SIGKILL the group) and removes the pid files; `rfa restart` is both. `rfa status` asks `/healthz`, reads the lock heartbeat, the pid files and the supervisor state, and never trusts a pid file alone (a stale pid is reported as stale).
- `rfa hub run` and `rfa supervisor run` are the foreground forms, which is what a service manager runs. `rfa service install` generates a launchd user agent on macOS or a systemd `--user` unit on Linux from `templates/`, pointing at the hub directory and running those two commands with `KeepAlive`/`Restart=on-failure`, and writes logs to the same `.rfa/logs/`. `rfa up` is for a laptop session; `rfa service install` is for a box that reboots. The CLI says so in `rfa up`'s output the first time.
- Children receive `RFA_DIR` and derive everything from the manifest. `RFA_HUB_URL` stops being a thing an operator types: a resident's hub URL is `http://127.0.0.1:<hub.port>/mcp` or `hub.url`. The variable survives as an override for tests.
- A hub directory in remote-hub mode (`hub.url`) starts only the supervisor. Its residents join the far hub with the `RFA_TOKEN` in `.rfa/secrets.json`, which the far operator minted with `rfa peer add`. This is the developer-laptop and second-machine shape: accountable-local, supervised locally, a client of a hub it does not run.

The earlier stance, recorded in `scripts/init.ts`, was that init must start nothing, because "a script that launches a hub, a supervisor and an agent leaves an operator who has never seen the parts running four processes they cannot name". The stance was about naming, not about starting. `rfa status` names them and `rfa down` stops them, and the onboarding explains each part in one line before it starts it. That is the difference, and it is why this plan reverses the letter of that comment while keeping its reason.

---

## 3. The command tree

Groups first, then the commands that need more than a line. Every command: `--dir <hub directory>` (or `RFA_DIR`), `--json` where there is anything to print, `--yes` where there is anything to ask, `--quiet`, `--help`. Synopses for all of them are in Appendix D.

### 3.1 Lifecycle

| Command | Does | Wraps / status |
|---|---|---|
| `rfa init` | Creates a hub directory here, interactively or from flags (section 4) | `scripts/init.ts`, rewritten |
| `rfa up` / `down` / `restart` | Starts and stops the hub and the supervisor as daemons (2.6) | new (`src/daemon.ts` over `src/proc.ts`) |
| `rfa status` | One screen: hub, supervisor, agents, rooms, account state (3.8) | `/healthz`, `/api/agents`, new `/api/rooms`, supervisor state |
| `rfa doctor` | Every check the findings ledger paid for, with the fix named (3.9) | new; absorbs the credential preflight from `scripts/init.ts` |
| `rfa logs [hub\|supervisor\|<agent>] [-f] [-n]` | Tails the right log file | new |
| `rfa console [--room <alias>]` | Prints the console URL and opens it | new |
| `rfa hub run [--stdio]` / `rfa supervisor run` | Foreground processes for service managers; `--stdio` serves MCP on stdio with `--data none` for hosts that want an ephemeral hub | `src/main.ts`, `src/supervisor.ts` |
| `rfa hub expose --tailscale [--off]` | Runs `tailscale serve` in front of the loopback hub and records `public_url` and the Origin allowlist in `rfa.json` | new; only when the binary is present, otherwise prints the three lines from the runbook |
| `rfa service install\|uninstall\|status` | Boot persistence: launchd or systemd user unit from templates | replaces `deploy/*.plist` and `deploy/install.sh` |
| `rfa demo` | The spec's worked example (dev asks PM) in memory: no hub, no credential, ten seconds | `scripts/demo.ts` |
| `rfa version` | Tool version, manifest version, spec version | new |

### 3.2 Agents

| Command | Does | Wraps / status |
|---|---|---|
| `rfa agent new <name> [--kind answerer\|tool\|spec-expert] [--room <alias>] [--knowledge <path>] [--model] [--dry-run]` | Scaffolds the whole pack (agent.md, memory blocks, MEMORY.md, a skill, an eval case), validated through the supervisor's schema; binds to a room | `scripts/new-agent.ts`. `spec-expert` is new: knowledge globs point at the package's own `spec/`, so it works with nothing else on the machine |
| `rfa agent ls` | Packs with supervisor status, presence, room, model, spend today, definition hash | `/api/agents` + supervisor state |
| `rfa agent show <name>` | The definition, the derived card and digest, resolved knowledge files with counts, budgets and today's spend, the room binding | `loadPack`, `deriveCard`, `knowledgeFiles` |
| `rfa agent validate [<name>]` | Parses through `parseAgentMd`, resolves bindings against `rooms.json`, warns on zero knowledge files | new |
| `rfa agent bind <name> --room <alias\|handle> [--observer] [--no-serve]` | Edits the `rooms:` block in place, the only editor that touches agent.md | new |
| `rfa agent start\|stop\|restart <name>` | Through the supervisor command channel, waits for the state change | `data/supervisor-commands.ndjson` |
| `rfa agent edit <name> [--model] [--description] [--offer] [--offer-description] [--per-task] [--per-day] [--max-turns] [--mode] [--room] [--knowledge] [--editor]` | Alone on a terminal, the walkthrough over the pack's settings (13.7); with flags, the same changes headless; `--editor` opens agent.md for the prompt and everything else. Every change rewrites its own line or block, validated before one write; the supervisor drains and respawns | new |
| `rfa agent retire <name> [--dry-run] [--timeout]` | Stop, release leases, leave, evict remnants, archive, deregister: eight re-runnable steps | `scripts/retire-agent.ts` |

**`--kind tool` requires pack-declared MCP servers.** The scaffold cannot keep promising a tool the runner cannot load (section 1). Rung 2 adds `mcp_servers` to `src/agentdef.ts` in the shape RFA-0.4 sect. 3.2 already lists (stdio or HTTP, with `secrets` by name injected into the server's environment), the resident builds its `mcpServers` map from it, and the Linear server leaves `src/resident.ts` for the owner's `scribe` pack's own declaration. Until that lands, `--kind tool` prints what it would scaffold and says why it refuses.

### 3.3 Rooms

| Command | Does | Wraps / status |
|---|---|---|
| `rfa room create <alias> [--topic] [--history member\|joined_after] [--mode open\|sequential\|moderator]` | Creates a room as the operator (2.5) | `room_create` |
| `rfa room ls` | Every room on the hub: alias, handle, topic, members present, guests, open tasks, pending approvals | new `GET /api/rooms` (operator-only, behind the session token); falls back to reading `.rfa/data/rooms/*.meta.json` when the hub is down, reconnaissance only, as `retire-agent` already does |
| `rfa room show <alias>` | Roster with presence, `home`, card digests and skills; policies; task summary | `room_roster`, `room_task list` |
| `rfa room tail <alias> [-f]` | The conversation-level debugger over the NDJSON log | `scripts/tail.ts` |
| `rfa room allow <alias> --token <label>` / `disallow` | Adds or removes a bearer's hash in `join_bearer_sha256` | `room_admin set_policy` |
| `rfa room policy <alias> set <key>=<value>` | Any `set_policy` key, validated against the hub's accepted list | `room_admin set_policy` |
| `rfa room secret show <alias>` | The legacy join secret, for a client that cannot send a header | `rooms.json` |
| `rfa room evict <alias> <member>` / `hold` / `release` / `quarantine` / `inject` | The moderation verbs, for when the console is not at hand | `room_admin` |
| `rfa room end <alias> [--summary]` | Ends the room | `room_end` |
| `rfa room adopt <handle> [--alias] [--secret]` | Registers a room the CLI did not create (the migration case and the legacy fallback) | new |

### 3.4 Talking

| Command | Does | Wraps / status |
|---|---|---|
| `rfa ask "<question>" [--room] [--capability] [--timeout 1800]` | Asks by capability as a human principal; the default-capability rule stays exactly as `scripts/ask.ts` has it | `scripts/ask.ts` |
| `rfa task ls\|show\|create\|cancel\|verify [--room]` | The task board from the operator membership; `create --capability` assigns by what a member offers (ask's rule); `verify` is a human principal's verb (wire 10.4) | `room_task` |
| `rfa approvals ls\|show\|approve\|reject <request_id> [--edit key=value]` | Pending approval cards and their decision, landing as human-origin interventions carrying the principal | `/api/approvals`, `/api/approvals/decide` |

`rfa approvals approve` makes the CLI a verdict surface, and v0.5 sect. 17.2 says the console is the sole one. The sentence was written against push channels that carry a button over a broadcast transport; a CLI on the operator's machine holding the human key is the console's equal (same `/auth`, same per-principal membership, same intervention event with `refs.principal`), and `npm run ask` has been a human-origin channel since v0.4.6. Section 11 proposes the amendment; until the owner accepts it, `rfa approvals` ships read-only and prints the console link.

### 3.5 Credentials

| Command | Does |
|---|---|
| `rfa human add <label>` / `ls` / `rotate <label>` / `remove <label>` | Human principals, hashed at rest, the key shown once. `remove` refuses to remove the last one. |
| `rfa token mint <label> [--kind client\|peer] [--expires 90d]` / `ls` / `revoke <label>` | Transport bearers, hashed at rest, shown once. Revocation reaches the hub on its next request. |
| `rfa secrets set <NAME> [--stdin\|--from-env VAR]` / `ls` / `unset <NAME>` | `.rfa/secrets.json`. Values are prompted with echo off or piped; never an argument (argv is readable in `ps`, the scar of 2026-08-17). `ls` prints names only. |
| `rfa key new [--alg es256] [--out <prefix>]` / `rfa key sign <card.json> <key.json>` | The signing profile (`scripts/keygen.ts`, `scripts/sign-card.ts`) |

### 3.6 Reach: other hosts, other machines, other organizations

| Command | Does | Status |
|---|---|---|
| `rfa connect claude-code [--room <alias>] [--scope user\|project] [--skill]` | Mints a `client` bearer labelled `claude-code@<host>`, allows it in the room, runs `claude mcp add --transport http --scope <scope> rfa http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"` (the path measured live on 2026-08-21), and with `--skill` writes a `consult-room` skill into the current project that names the room handle and nothing secret | rung 3 |
| `rfa connect cursor` / `rfa connect mcp --print` | The same bearer as JSON for hosts that take an MCP config file | rung 3 |
| `rfa peer add <name> [--room <alias>...] [--expires 90d] [--home <org>]` | Mints a `peer` bearer, allows it in the rooms, prints the one-time credential block: hub URL (`public_url` or the loopback with a note that it needs a proxy), room handles, the bearer, the `rfa_min.py` invocation, and where `INTEROP.md` is. `--home` other than `local` is refused with the reason until rung 5 | rung 3 (own-org); rung 5 (guests) |
| `rfa peer ls` / `show <name>` / `revoke <name>` | Peers with their rooms, last seen, live memberships; revoke removes the hash from `tokens.json` and every room policy, then evicts live memberships | rung 3 |
| `rfa peer invite <name> --room <alias> [--ttl]` | `room_admin invite` for an admitted guest | rung 5, gated on RFA-0.6 v0.6.0b |
| `rfa docs interop\|spec\|platform\|plan\|readme\|client [--path] [--open]` | Opens or prints the documents shipped in the package | rung 3 |

`rfa init --hub-url <url> --token <bearer>` is the other half of `peer add`: it creates a remote-hub directory (2.6) on the machine that will host the agents. Between the two, "connect an agent running elsewhere" is two commands, one on each side, for agents built on this tool; `INTEROP.md` and `rfa_min.py` cover agents built on anything else.

### 3.7 Instruments and operations

| Command | Does | Wraps |
|---|---|---|
| `rfa knowledge add <agent> <path\|git-url> [--docs <subdir>]` / `sync` / `status` / `pin` | A path becomes a glob in agent.md; a git URL becomes a tracked shallow clone under `agents/<name>/knowledge/<repo>/` (gitignored) with per-file provenance from `git log`, exactly as spec 19.1 wants | `scripts/sync-handbook.ts`, generalized to any pack and any remote |
| `rfa evals run [--judged] [--update-baseline]` / `ls` / `promote <room> (--conversation\|--task) --id` / `label --prepare\|--apply` / `flag <run id>` / `parity [--capture]` | The eval gate, the flywheel, the labelling sitting (also the dashboard's Evals tab, 13.10), a person's way into the review queue, and the parity gate reading `evals/parity.json` | `src/evals/runner.ts`, `scripts/promote-case.ts`, `scripts/label.ts`, `dogfood/parity.ts` |
| `rfa log verify [<alias\|handle>\|all] [--json]` | Offline chain verification; reads files, never boots a hub | `scripts/verify-log.ts` |
| `rfa backup now` / `ls` / `restore <date> [--dry-run]` | The nightly backup on demand, and the restore procedure that STATUS says must be exercised, as a command: stop, copy the `__`-named files back, untar, start | `src/platform.ts` |
| `rfa config show` / `get <key>` / `set <key> <value>` | `rfa.json` edits through the schema, with "restart the hub to apply" said when it is true | new |
| `rfa migrate [--from <legacy checkout>] [--dry-run]` | The legacy-layout move of section 7, and future manifest-version upgrades | new |

### 3.8 `rfa status`, designed

```
acme · ~/rfa/acme                                             rfa 0.7.0 · protocol 0.1.8

hub         ● running   pid 4021   http://127.0.0.1:8790   healthz ok · lock fresh · up 3h 12m
            /mcp authenticated (3 bearers: operator, claude-code@mbp, langchain-vps)
supervisor  ● running   pid 4022   account 0/2 in flight · not paused · last backup 2026-08-22 03:04

agents
  pm             ● ready    product    haiku    $0.31 today   heartbeat 4s    def hgZq4ETb
  scribe         ● ready    product    sonnet   $0.00 today   heartbeat 12s   def 3Kp0vQ9L
  spec-expert    ○ stopped  product    haiku    manual stop (rfa agent start spec-expert)

rooms
  product   r_9a25e48c0e   4 present · 0 guests · 2 open tasks · 1 approval pending  ← rfa approvals ls
  ops       r_fb3993fc90   1 present
```

The one screen answers the question every session in STATUS eventually asked: is the thing that looks healthy actually able to work. A `credential` outage (every recent run `unauthorized`) prints on its own line in red, with no volume guard, because that is the rule the findings ledger wrote.

### 3.9 `rfa doctor`, the checks and their scars

Each check names the finding it comes from, because a check with a story is maintained and a check without one is deleted.

| Check | Scar |
|---|---|
| Node ≥ 22; `better-sqlite3` loads; `claude` on PATH and `claude auth status` logged in, or `ANTHROPIC_API_KEY` in the environment the supervisor will inherit | a credential-less machine came up green everywhere and the first ask died (2026-08-21); the credential expired and the room reported three ready agents (2026-08-19) |
| `rfa.json` valid; `.rfa` is 0700; `secrets.json`, `principals.json`, `tokens.json`, `rooms.json` are 0600 and parse | `loadSecrets` only warns on a wide mode today |
| The port is free, or held by OUR hub: `/healthz` answers and the lock heartbeat is fresh and names this directory | two hubs on one store; a port held by another directory's hub |
| Pid files point at live processes in the expected group; no resident process exists that the supervisor does not own | 119 orphaned hubs; duplicate residents serving one membership |
| Every pack validates; declares `RFA_TOKEN`; has an offer; binds to a room that exists in `rooms.json`; resolves at least one knowledge file | the opaque `unauthorized` from a missing secret; a join refused for a card with no skill; a pack that "loads but never serves" |
| Every room the packs bind to lists the operator bearer's hash in `join_bearer_sha256` | a resident that cannot join its own room |
| `hub.public_url`'s origin is in the Origin allowlist | the 403 that "looks exactly like a wrong credential" (STATUS runbook) |
| `policies/gate.json` parses as a `GateCheck[]` | the gate is a MUST and a malformed file must not mean "no gate" |
| Account pause state, crash-looped agents, stale heartbeats | the supervisor that gave up "until the definition changes" after a hub blip |
| Last backup date and whether `rfa backup restore --dry-run` has ever run | "the restore procedure is only real if it has run" |
| Recent runs all `unauthorized` | the alert triad that was blind to a total outage |
| Room log sizes and `.rfa/data` free space | the in-RAM log (RFA-0.6 sect. 8.3's open window) |
| With `--deep`: `rfa log verify all` | a chain that had never been checked |

---

## 4. `rfa init`: the onboarding

The first five minutes are the product's first impression and the repository has already paid for two of them ("a poor first five minutes for something an organization is meant to self-host", `scripts/init.ts`). The flow below is what `npx agent-com init` prints in an empty folder on a Mac with a logged-in `claude`. Prompts are real prompts (arrow keys, enter); the dim lines are the explanations; every `✔` is something that was just done, never something that will be done.

```
$ npx agent-com init

   ┌─────────────────────────────────────────────────────────────┐
   │  rfa · Rooms for Agents                                     │
   │                                                             │
   │  One room. Agents from more than one place. One log you    │
   │  can verify. One human who can stop it.                    │
   └─────────────────────────────────────────────────────────────┘

   This folder will become a hub directory. It gets three parts:

     hub          the room server. Agents and people talk through it, over MCP.
     supervisor   keeps your local agents running and restarts them when they die.
     agents/      one folder per agent: a markdown file is the whole definition.

   Nothing here phones home. The hub listens on this machine only until you
   expose it on purpose (rfa hub expose).

 ◆ Run a hub here, or host agents for a hub that runs elsewhere?
 │ ● Run a hub here
 │ ○ Connect to a hub elsewhere   (you will need its URL and a bearer from its operator)
 │
 ◆ Name this hub  › acme
 │   used in process names, the backup folder and the service label. The folder name is the default.
 ◆ Port           › 8790
 │   free ✔
 ◆ Your name      › paul
 │   your human principal. Only a human principal can approve an agent's action or lift a quarantine.

 ✔ rfa.json                                  the manifest. Commit it.
 ✔ .rfa/secrets.json  (0600)                 RFA_TOKEN, the bearer your agents and this CLI use to reach the hub
 ✔ .rfa/principals.json, .rfa/tokens.json    hashes only; plaintext never rests here
 ✔ policies/gate.json                        three default rules: alert on injection markers, refuse private keys, hold on a review marker
 ✔ .gitignore                                .rfa/, agents/*/state/, knowledge clones
 ✔ model credential                          `claude` is logged in (oauth). Agents inherit it from the supervisor's shell.

 ◆ Your first agent?
 │ ● spec-expert      answers questions about the RFA protocol from the spec shipped in this package. Works with nothing else.
 │ ○ an answerer      answers from a folder of markdown you point it at
 │ ○ a tool user      acts on requests, behind your approval, with an MCP server you name
 │ ○ none yet
 │
 ◆ Name it         › spec-expert
 ✔ agents/spec-expert/agent.md                definition sha256:hgZq4ETb… · model haiku · 1 offer: answer-protocol-question
     the pack is a folder: agent.md, knowledge/, memory/, skills/, evals/. rfa agent show spec-expert lists it.

 ◆ A room for it?  › product
 │   topic: "product questions"   (rooms are the isolation unit: everyone in a room sees everything in it)
 ✔ room product  r_3f9a1c2e7b                 you host it. Your agents join it with the bearer above; there is no secret to paste.
 ✔ room ops      r_b77d0a4e19                 the supervisor posts alerts, the nightly backup and the daily review digest here
 ✔ spec-expert bound to product

 ◆ Start the hub and the supervisor now?  › Yes
 ✔ hub           pid 4021   http://127.0.0.1:8790        console at /console
 ✔ supervisor    pid 4022   1 agent
 ◐ waiting for spec-expert to join product …  ✔ ready (11s)

 ◆ Ask it something?  › How do presence leases work?
 ◐ asking spec-expert …

   A member renews its lease on every listen, send or presence call; miss two
   renewals (default 180s) and the room marks it offline, and return-from-offline
   restores the declared state. [spec/RFA-0.1.md sect. 7.2]

   answered in 9.4s · $0.004 · run_1b2c

 ◆ Let your Claude Code sessions ask this hub?  (claude found on PATH)  › Yes
 ✔ bearer claude-code@mbp minted and allowed in product
 ✔ claude mcp add rfa --scope user            sessions can now room_join r_3f9a1c2e7b with no secret

   Your hub is up.

     rfa status                     what is running
     rfa ask "…"                    ask by capability, from anywhere in this folder
     rfa console                    the live room view; unlock it with your human key
     rfa agent new <name>           another agent
     rfa peer add <name>            admit an agent running on another machine
     rfa service install            keep it running across reboots

   Your human key, shown once (rfa human rotate paul if you lose it):

     hk_5d0b…f31a

   It unlocks the console and is the only thing that can approve. Keep it like a password.
```

Rules the flow obeys:

- **Every question has a flag**, and `--yes` takes every default: `rfa init --yes --name acme --port 8790 --human paul --agent spec-expert --room product --no-start` is the whole thing in one line, and it is what the cold-start operator test runs (section 8).
- **Re-running is safe.** An existing `rfa.json` is read, not overwritten; credentials are never rotated without `--force` (rotating the bearer would lock out every resident holding it, the reason `scripts/init.ts` gives); an existing agent or room is left alone and reported.
- **The model-credential preflight stays verbatim.** Its three verdicts (set in this shell, logged in, cannot verify) and its wording were tuned by measurement on 2026-08-21 and the strong warning is reserved for a confirmed absence. It moves into `rfa doctor` and `init` calls it.
- **No credential is printed except once, at the end,** after everything that could have failed.
- **Non-TTY** (`stdin` not a terminal, or `--yes`) prints the same lines without prompts or spinners, one per event, so a script's log is readable.
- **The "connect to a hub elsewhere" branch** asks for the URL and reads the bearer with echo off, writes `hub.url`, tests `GET /healthz` and an authenticated `room_roster` against it, and creates no room (the far operator did).

What `init` does not do: install a service (it says how), expose the hub (it says how), or create a second agent. A tool user needs an MCP server the operator has to name, so that branch asks for the server command and the tool id before scaffolding, and refuses with the reason if `mcp_servers` is not yet supported by the installed tool version.

---

## 5. Interaction and output design

The project already has a voice: it explains, it says why, it states the limit of what it just did, and it never reassures. The CLI keeps it.

- **Every command prints what it did, in the past tense, and what is true now.** `✔ room product r_3f9a1c2e7b  you host it` not `Creating room…`. A long wait gets a spinner with elapsed seconds; the spinner is replaced by the result line, never left above it.
- **Errors are one line of cause and one line of fix**, the shape `scripts/ask.ts` already uses ("no dogfood/ROOM.md, so there is no room to talk to yet. New checkout? npm run init"). No stack traces unless `--debug`. The hub's own error codes are shown by name (`join_denied`, `unauthorized`, `rate_limited`) with their `retry_after_s` when present.
- **Help is layered:** `rfa` prints the groups with one line each; `rfa agent` prints that group; `rfa agent new --help` prints the synopsis, the flags, and two example invocations. The first paragraph of each help text is the "why this exists" comment that already heads the script it replaces: those comments are the best documentation in the repository and should not be lost in the move.
- **Visual kit**, applied consistently and nowhere else: `✔ ✖ ◐ ◆ ▸ ● ○`; presence dots colored as the demo already colors them (green ready, amber busy, dim offline, purple supervisor, gold human); one accent color (the console's `#5aa9e6`), one danger color; tables with a two-space gutter and `tabular-nums`-style right-aligned numbers; a single box, for the init banner, and no other box anywhere. Colors through `util.styleText`, honoring `NO_COLOR`, `--no-color` and a non-TTY stdout.
- **`--json` on every command that reports**, the same object the human view was rendered from, and never both at once. Exit codes: `0` done, `1` failed, `2` usage, `3` precondition (not a hub directory, hub not running, not authenticated), so a script can tell "you ran it wrong" from "it is not up".
- **Secrets never touch argv.** Values are prompted with echo off, read from stdin, or taken from a named environment variable. Spawned processes receive them through files under `.rfa/` (the hub) or a minimal environment (residents), never through flags.
- **Reserved names are refused at write time** with the suggestion, as `new-agent` already does; the CLI's own memberships avoid the reserved first tokens even where a human principal could use them.
- **Dependencies.** Argument parsing through `node:util`'s `parseArgs` (no dependency). Colors through `util.styleText` (no dependency). Interactive prompts through `@clack/prompts`, the one dependency this plan adds, because a select prompt that handles raw mode, arrow keys, SIGINT and non-TTY fallback correctly is a week of work that four small packages already did. `engines.node` moves to `>= 22`: Node 20 reached end of life in April 2026, `styleText` is stable from 22.13, and the machine this runs on has 26.
- **Platforms:** macOS and Linux. Windows is not supported and `rfa` says so on startup there, in one line, because nothing under it (process groups, launchd/systemd, srt) is.

---

## 6. Code changes

### 6.1 New modules

| Module | Responsibility |
|---|---|
| `src/hubdir.ts` | The manifest schema and its migrations; resolution (`--dir` → `RFA_DIR` → walk up → a precondition error naming `rfa init`); every path under the directory as a typed object; atomic JSON stores for `rooms.json`, `tokens.json`, `principals.json`, `secrets.json` (write temp + rename + fsync, 0600, the discipline the store already has); the legacy-layout detector used by `migrate`. **The only module allowed to join a path onto the hub directory.** A lint rule (a unit test that greps `src/` for `"agents"`, `"data"`, `"dogfood"`, `"deploy"` string joins outside this file) keeps it that way. |
| `src/daemon.ts` | Detached start with pid file, log file, readiness probe; stop through `stopTree`; liveness that distrusts pid files. |
| `src/cli/main.ts` | Entry: parse, resolve the hub directory lazily (`init`, `demo`, `version`, `docs` need none), dispatch, format errors, exit codes. |
| `src/cli/router.ts` | The command tree: `{name, summary, why, args, flags, run}` per command, help generation from it. |
| `src/cli/ui.ts` | Colors, symbols, spinner, table, the box, prompt wrappers, TTY and JSON modes. |
| `src/cli/context.ts` | What every command needs: the hub directory, the manifest, secret accessors, an operator `RoomMember` per room (resumed from `rooms.json`), a workbench session (`POST /auth` with `RFA_HUMAN_KEY`), the daemon handles. |
| `src/cli/commands/*.ts` | One file per group. The bodies of `scripts/*.ts` move here with their head comments intact. |
| `templates/` | `agents/answerer/`, `agents/tool/`, `agents/spec-expert/`, `gate.json`, `launchd.plist`, `systemd.service`, `skills/consult-room/SKILL.md`, `gitignore`. |

### 6.2 Changes to existing files

| File | Change |
|---|---|
| `src/main.ts` | `--dir`; defaults from the manifest; `--principals-file` and `--tokens-file` with digest comparison and reload (2.4); `GET /api/rooms`; the console served from the package (`import.meta.dirname/../console/index.html` resolves the same in `src/` and `dist/`); the workbench's `agents/` and supervisor paths through `hubdir`; the startup banner names the hub directory. |
| `src/supervisor.ts` | `--dir`; paths through `hubdir`; spawns the resident through `spawnEntry` (6.3) with `RFA_DIR` and a derived `RFA_HUB_URL`; reads `ops` from `rooms.json` instead of minting it; `foreignResident()` matches `resident.(ts\|js)`; backup destination from the manifest. Optional, flagged separately in section 10: spawn residents with a minimal environment (`PATH HOME USER TMPDIR LANG`, `ANTHROPIC_*`, `CLAUDE_*`, `RFA_DIR`, `RFA_HUB_URL`, the declared secrets) instead of `{...process.env, ...picked}`, which is what v0.4 sect. 6.3 specified and RFA-0.6 sect. 8.8 records as the gap. |
| `src/resident.ts` | Paths through `hubdir`; `cwd` for the Agent SDK is the hub directory (knowledge paths in the prompt are relative to it; `settingSources: []` stays, so a hub directory inside a user's project does not leak that project's CLAUDE.md into the agent); `writeRoomMd` and the legacy-state migration deleted; a pack with no binding fails loudly; `mcpServers` built from `def.mcp_servers` (rung 2); the Linear server removed (rung 2). |
| `src/agentdef.ts` | `mcp_servers` (rung 2): `{ <name>: { command, args?, env_secrets?: string[] } \| { url, bearer_secret?: string } }`, the v0.4 sect. 3.2 field. `secrets` loses `RFA_JOIN_SECRET` from the scaffold, keeps the name legal. |
| `src/consolidate.ts`, `src/evals/runner.ts`, `src/evals/judge.ts` | Paths through `hubdir`; `readRoomMd` replaced by `rooms.json`; parity fixtures at `evals/parity.json`. |
| `src/proc.ts` | `spawnEntry(name)`: resolves the sibling entry of the calling module by the calling module's own extension, so `dist/supervisor.js` spawns `node dist/resident.js` and `src/supervisor.ts` under tsx spawns `node --import tsx src/resident.ts`. `spawnTsx` stays for tests. |
| `src/secrets.ts` | `transportToken(hubdir)`; `loadSecrets` refuses (not warns) a world-readable file when called by the CLI. |
| `src/principals.ts` | Digest-based matching beside the plaintext one. |
| `src/client.ts` | Nothing required. `RoomMember.create` already joins without a secret when `joinSecret` is undefined, which is the bearer-implied path. |
| `scripts/` | `init`, `new-agent`, `retire-agent`, `sync-handbook`, `ask`, `tail`, `verify-log`, `keygen`, `sign-card`, `label`, `promote-case` move into `src/cli/commands/`. `e2e`, `demo`, `demo-push`, `watchdog-replay`, `repair-obs-cost` stay as tool-development scripts; `demo` is also reachable as `rfa demo`. |
| `dogfood/parity.ts` | Becomes `rfa evals parity`; `dogfood/` stops being source. |
| `agents/pm-agent`, `agents/linear-scribe`, `agents/test-agent` | Leave the repository with the owner's hub directory (section 7). The repository keeps `templates/agents/*` and a `examples/` folder with one pack that runs on a fresh install. |
| `deploy/` | `gate.json` becomes `templates/gate.json`; the plists and `install.sh` become `templates/launchd.plist`, `templates/systemd.service` and `rfa service`. |
| `console/index.html` | Unchanged, shipped in the package. |
| `.claude/commands/ask-pm.md`, `.claude/skills/consult-room/SKILL.md` | Rewritten to read the room from `rfa room show --json` rather than `dogfood/ROOM.md`; the generic form lives in `templates/skills/` and `rfa connect claude-code --skill` writes it. |
| `package.json` | `name: agent-com`; `bin: { rfa, agent-com }` both → `dist/cli/main.js`; `files: [dist, console, templates, interop, INTEROP.md, spec, README.md, LICENSE]`; `engines.node >= 22`; `prepare: tsc` (so `npm install` from a git URL builds); `@clack/prompts` added; scripts: `dev` (`tsx src/cli/main.ts`), `build`, `test`, `e2e`, `e2e:full`, `coldstart` (section 8). The `rfa-hub` bin and the per-script npm aliases go. |
| `tsconfig.json` | Unchanged in shape (`src/**` builds; the CLI is under `src/cli`). |
| `README.md`, `STATUS.md` runbook, `CLAUDE.md` working rules | The first line becomes `npx agent-com init`; every `npm run <script>` becomes the `rfa` command; the runbook becomes `rfa up`. Done in the rung that makes each line true, not before (a README that leads the code is how the ten wrong rows in RFA-0.6 sect. 12 happened). |

### 6.3 Packaging and distribution

The built package must run with no `tsx`, no repository and no network beyond the hub's own port. `npm pack` produces the artifact; the cold-start operator test (section 8) installs exactly that tarball into a temp prefix and runs it, so the `files` list and the entry resolution are tested by the only test that can catch them.

Four install paths, in order of friction, and the plan builds so that all four work:

1. `npx agent-com init` — requires the package on the public npm registry.
2. `npm install -g agent-com` — the same.
3. `npm install -g git+ssh://github.com/pbeneteau/agent-com.git` — works with the private repository for anyone with SSH access; `prepare` builds `dist/`.
4. `npm install -g ./agent-com-0.7.0.tgz` — a tarball handed over by any means.

Paths 1 and 2 publish the code. The repository is private by owner decision (2026-08-19, RFA-0.6 sect. 8.9), and that decision's reasoning was that an organization cannot be told to run a hub whose implementation it cannot read. Publishing the package is the moment that tension resolves one way or the other; it is decision 1 in section 10 and this plan does not make it. Until it is made, the README's first line is path 3.

Docker and compose stay deferred on RFA-0.6 sect. 8.8's own reason (the exposure posture of sect. 4.5). Nothing here makes them harder: a container would run `rfa hub run` and `rfa supervisor run` against a mounted hub directory, and `rfa.json`'s `bind` is where `0.0.0.0` belongs inside one.

---

## 7. Migration

### 7.1 The live hub on the owner's Mac

The standing room `r_9a25e48c0e`, its residents' memberships, three days of `obs.db`, and the launchd plists all live in the repository checkout. `rfa migrate --from <checkout> --to ~/rfa/<name> --dry-run` prints the mapping; without `--dry-run` it performs it. The mapping:

| Legacy | New |
|---|---|
| `data/rooms`, `data/runs.db`, `data/obs.db`, `data/auth.log.ndjson` | `.rfa/data/` (moved, not copied: one store, one lock; the lock file is deleted at rest) |
| `data/secrets.json` | `.rfa/secrets.json` (`RFA_TOKEN` kept; `RFA_JOIN_SECRET` kept for `rooms.json`, then dropped from packs) |
| `dogfood/state/human-key.txt` | hashed into `.rfa/principals.json` with the `hp_` id the hub already derives for it, and copied plaintext into `.rfa/secrets.json` as `RFA_HUMAN_KEY` |
| `data/secrets.json` `RFA_TOKEN` | its sha256 into `.rfa/tokens.json` as kind `operator` |
| `dogfood/ROOM.md` | `.rfa/rooms.json`: alias `product`, the handle, the join secret; then `rfa room adopt` creates the operator's host-less admin membership (the existing host stays the pack that created it; the operator membership is a supervisor) |
| `data/ops-room.json` | `.rfa/supervisor/ops-room.json` and an `ops` entry in `rooms.json` |
| `data/supervisor-*.json`, `ops-digest.json`, `judge-count.json`, `data/retired/` | `.rfa/supervisor/`, `.rfa/retired/` |
| `agents/*` | `agents/*` in the new directory, `state/` included, so every resident resumes its membership from its own `member.json` |
| `deploy/gate.json` | `policies/gate.json` |
| `evals/*`, `dogfood/state/parity.json` | `evals/*`, `evals/parity.json` |
| `~/Library/LaunchAgents/com.rfa.*.plist` | uninstalled; `rfa service install` |

The procedure, with its downtime: `launchctl bootout` both agents (or stop the nohup'd processes), `rfa migrate`, `rfa doctor`, `rfa up`, `rfa status` until every resident shows ready (they resume their memberships, so the room's epoch does not bump), `rfa log verify all`, one `rfa ask`. Minutes, and lossless for room content, which is the property RFA-0.6 sect. 8.6 promises for any hub restart. The nightly backup of the morning before is the rollback.

Each room the packs bind to must then list the operator bearer's hash: `rfa migrate` does it through `set_policy` once the hub is up again and says so, because until it does the residents are joining on the secret they still hold in `member.json`, which keeps working.

### 7.2 The repository

`dogfood/` stops being a directory of source and becomes the place the owner's hub directory is NOT: the live instance moves out to `~/rfa/<name>` (or wherever the owner says), and the repository's own `dogfood/` is either deleted or kept as a gitignored hub directory for development (`rfa init --dir dogfood`). The reference packs go with the instance. `examples/spec-expert/` is the one pack the repository keeps, because it is the pack `rfa init` offers and it must be proven on a fresh install.

The repository's `.claude/` skills keep working against the development hub directory through `rfa room show --json`.

---

## 8. Testing and acceptance

- **Unit** (`npm test`, the glob catches the new files): `test/hubdir.test.ts` (resolution order, walk-up, the legacy detector, manifest validation and migration, the no-stray-paths lint over `src/`), `test/stores.test.ts` (atomic writes, modes, a torn file refused), `test/tokensfile.test.ts` (digest match, reload on change, a malformed edit retains the old set, revocation on the next request), `test/cli.test.ts` (the router, help text snapshots, `--json` shapes, exit codes, non-TTY rendering), `test/daemon.test.ts` (start, readiness, stop leaves no process in the group: the orphan scar, re-proven), `test/mcpservers.test.ts` (a pack-declared stdio server reaches the resident's `mcpServers`).
- **e2e** (`npm run e2e`, new scenarios on the existing harness): "fresh hub directory" (`rfa init --yes --no-start` in a temp dir, `rfa up`, `rfa room create`, `rfa agent new --no-room`, `rfa status --json`, `rfa down`, then a `ps` scan that finds nothing); "two hub directories, two ports, two locks"; "bearer-implied join from a second bearer allowed with `rfa room allow`"; "`rfa approvals` decision lands as a human-origin intervention carrying the principal".
- **The cold-start operator test**, `npm run coldstart`: `npm pack`, install the tarball into a temp prefix, an empty temp folder, `rfa init --yes --agent spec-expert --room product`, wait for ready, `rfa ask "how do presence leases work?"`, assert a citation of the spec, `rfa down`, assert no process survives. It needs a model credential, so it runs like the eval gate (by hand, budgeted) and not in `npm test`. It is the mirror of RFA-0.6 sect. 6.3's cold-start guest test and the only honest measure of whether an operator with nothing but the package can get an answer; every rung after rung 1 keeps it green.
- **Parity twice** after rung 0 and again after rung 2, because both touch `src/resident.ts` (the prompt's knowledge paths change from repository-relative to directory-relative in rung 0, and the tool server map changes in rung 2). **The eval gate once** after rung 2.
- **Live verification on the migrated instance** (section 7.1) is rung 0's proof, recorded in STATUS with the numbers.

---

## 9. Rungs

Each rung is independently shippable and lands behind `npm test`, `npm run e2e`, the parity rule above, and a findings entry in STATUS. Estimates are working days for one person who knows the code; they are guesses and are written down so they can be wrong in public.

| # | Rung | Content | Gate | Est. |
|---|---|---|---|---|
| 0 | **The hub directory** | `src/hubdir.ts`, `rfa.json`, the `.rfa/` layout, every entrypoint and script resolving through it, `spawnEntry`, `rooms.json` replacing `ROOM.md`, `principals.json` and `tokens.json` with the hub's file loaders and reload, `package.json` renamed and packaged, `npm pack` installs and runs, `rfa migrate` with its dry run, the live instance moved and verified | `npm test`, `e2e`, parity ×2, the migration's live proof | 3 |
| 1 | **`rfa` and the lifecycle** | Router, ui, context; `init` (flags first, then the interactive flow), `up`/`down`/`restart`, `status`, `doctor`, `logs`, `console`, `hub run`, `supervisor run`, `demo`, `version`; the cold-start operator test; README's first line | cold-start green | 3 |
| 2 | **Agents and rooms** | `agent *` (with `mcp_servers` in the schema and the runner, the Linear server moved out), `room *`, `ask`, `task`, `approvals` (read-only until decision 3), `human`, `token`, `secrets`, `config`, `key`; the implicit room creation retired; the scaffold's `--kind tool` made honest | eval gate once, parity ×2 | 4 |
| 3 | **Reach** | `connect claude-code|cursor|mcp`, `peer add|ls|show|revoke` (own-org bearers), `docs`, `hub expose --tailscale`, `init --hub-url` (remote-hub directories), the generic `consult-room` skill template | a second machine's session joins with no secret, measured | 2 |
| 4 | **Instruments and operations** | `knowledge *`, `evals *` (parity included), `log verify`, `backup now|ls|restore`, `service install|uninstall|status`; STATUS's runbook and CLAUDE.md's working rules rewritten | `rfa backup restore --dry-run` exercised; a reboot with the service installed | 2 |
| 5 | **The guest path** | `peer add --home`, `peer invite`, the admission record under `peers/`, signed cards required: the CLI half of RFA-0.6 v0.6.0b | **Gated on RFA-0.6 sect. 8.9 and v0.5 sect. 22 rung 11 exactly as they stand**: a named counterparty the operator does not control AND the privacy decision reversed. The command names exist from rung 3; the hub half does not land early | — |
| 6 | **Release** | The publishing decision executed one way or the other; version set; a deliberate week of using the CLI for every operation the runbook used to describe, with the findings ledger as the deliverable | the week | 5 |

Fourteen working days of build before the week of use. Rung 0 is the one that cannot be skipped or reordered, and it is also the one that touches the live hub, so it is the one to do carefully and first.

---

## 10. Decisions for the owner

Each with a recommendation; none is made by this document.

1. **Publishing.** `npx agent-com init` from an empty folder requires the package on the public npm registry, which publishes the implementation the repository keeps private. Options: publish (the product-shaped answer; a private repository can still hold the history and the research), or keep the package private and make path 3 of section 6.3 (`npm install -g git+ssh://…`) the documented on-ramp for people with repository access. Recommendation: decide before rung 6, not before rung 0; the build is identical either way.
2. **The command's name.** Recommended: the package is `agent-com` (what you typed, what the repository is called, what `npx` resolves) and installs `rfa` as the everyday binary with `agent-com` as an alias. The alternative, `agent-com` alone, makes every example in this plan four characters longer and puts a name with no meaning to an operator's organization in front of a protocol that already has one (`RFA_*`, `rfa.json`, `rfa-hub`). Switching later costs one line in `package.json`.
3. **The CLI as a verdict surface.** `rfa approvals approve` contradicts v0.5 sect. 17.2's letter ("the console is the sole verdict surface") and honors its reason (no verdict over a broadcast channel). Recommendation: amend 17.2 to "a human-principal-authenticated surface: the console, or the operator CLI on the operator's own machine", and ship the verb in rung 2. Until then the command is read-only.
4. **Hashed human keys and bearers at rest.** Today plaintext at 0600. Recommendation: hash (2.4). Cost: the two file loaders and the reload in `main.ts`; the operator's own plaintext still sits in `secrets.json` because the CLI acts as that human. Benefit: `rfa human add` for a second person means that person's key exists in exactly one place, theirs.
5. **The minimal resident environment.** v0.4 sect. 6.3 says the SDK `env` replaces the environment; the supervisor spreads `process.env`. Recommendation: do it in rung 0 behind an allowlist (6.2) and measure on the live instance, because the Agent SDK's `claude` child may need variables the allowlist forgot, and the migration's live proof is the cheapest place to find out.
6. **Where the live instance goes, and the version number.** A path outside the checkout (`~/rfa/<name>` is the suggestion) and `0.7.0`, with one caution: STATUS already gives "hub 0.7.0" a wire meaning (the release from which 0.1.8's now-binding half binds, wire 16.1). Either satisfy that in the same release or number this one `0.6.x`; the plan has no opinion beyond "do not let a version number mean two things".

Two smaller calls made here and easy to reverse: `.rfa/` as the runtime directory name (2.2), and `@clack/prompts` as the single added dependency (section 5).

---

## 11. Amendments this plan implies, each with its reason

| Document and section | Amendment | Reason |
|---|---|---|
| RFA-0.4 sect. 3.1 | A pack is a directory under `<hub directory>/agents/`, not under the repository | the separation |
| RFA-0.4 sect. 6.3 | Secret values live in `<hub directory>/.rfa/secrets.json` | same; the 0600 rule and names-only declaration unchanged |
| RFA-0.4 sect. 10 | `rfa.json` is built, in the shape of 2.3; "two launchd plists" becomes "`rfa service install`, which generates a launchd agent or a systemd user unit"; the backup destination is `retention.backup_dir` | the manifest was specified and never built; a tool any organization installs runs on Linux |
| RFA-0.4 sect. 11 | `rfa ask` is one command of the operator CLI of this document | scope |
| RFA-0.5 sect. 17.2 | "the console is the sole verdict surface" → the console or the operator CLI on the operator's own machine (decision 3) | both authenticate the same human principal through the same path; the rule's purpose was to forbid verdicts over broadcast channels, which it still does |
| RFA-0.6 sect. 3.1 | `deploy/peers.json` → `<hub directory>/peers/`; the reload rule is applied to the human and bearer files of 2.4 as well | one rule for every credential file the kill switch depends on |
| RFA-0.6 sect. 4.2, implementation note | Operator bearers are compared as digests loaded from a watched file, not plaintext from argv or the environment | the storage rule sect. 4.2 already states for the admission record, applied early |
| RFA-0.6 sect. 8.8 | "document systemd in three lines and stop there" was sized for one developer's plists; a generator from one template pair is two boot paths at the cost of one, and no encrypted-credential loading is proposed (secrets stay in `.rfa/secrets.json`, read by the supervisor) | the audience changed on 2026-08-17 and packaging had not caught up |
| Wire 4.3, nothing | No wire change. `join_bearer_sha256`, `home: "local"` for operator-provisioned bearers, and the join-secret legacy path are used exactly as written | — |
| STATUS, CLAUDE.md | Every `npm run <script>` in the working rules becomes its `rfa` command; the runbook becomes `rfa up`; "a standing agent room is live in this project" becomes "in the development hub directory" | documentation follows code, rung by rung |

One gap this plan exposes and does not close: the hub cannot rotate a room's join secret (minted once at `room_create`, compared by equality, never changed). `rfa room secret show` exists; `rfa room secret rotate` would need a `set_policy` key or a new verb, and since the join secret becomes the legacy path here, the honest move is to leave rotation unbuilt and say so in the command's help.

---

## 12. Non-goals

- **No daemon manager beyond `up`/`down` and the service templates.** No pm2, no restart policy for the supervisor itself outside a service manager; `rfa up` prints that distinction the first time.
- ~~**No dashboard in the terminal.**~~ Withdrawn by section 13 (2026-08-22): the operator asked for one after three days of forgetting the long commands, and `rfa` alone now opens it. The console stays the browser's live view; `rfa status` stays the snapshot a script reads.
- **No global state.** No `~/.rfa`, no registry of hub directories, no "current hub" switch. The working directory is the context, as it is for git.
- **No plugin system for commands,** no telemetry, no auto-update, no YAML (the manifest is JSON because the spec said `rfa.json` and because JSON has one parser).
- **No merge of hub and supervisor**, and no hub inside the CLI process.
- **No guest admission ahead of its trigger** (rung 5), no Docker ahead of RFA-0.6 sect. 8.8's own condition, no Windows.
- **No second copy of any document.** The CLI's help text is generated from the command definitions; the README links to `rfa --help` output rather than restating it; and the specs keep owning defaults, which the CLI reads from the code that implements them.


## 13. The front door (amendment, 2026-08-22)

Three days into using the rungs above, the operator's verdict was that the command tree is complete and that nobody can remember it: "we are getting lost, we forget the commands". The command tree stays; what changes is how it is reached. This section is normative for `rfa` with no arguments and for the discoverability rules every command now follows. It withdraws the "no dashboard in the terminal" non-goal of section 12.

### 13.1 `rfa`, alone

On a terminal (both ends a TTY, no `--json`, no `--quiet`):

- in a folder that is not a hub directory (and not a pre-0.7 checkout, which is still told to `rfa migrate`): the **onboarding** (13.2);
- in a hub directory: the **dashboard** (13.3).

On a pipe, or with `--json`, `rfa` alone prints the help it always printed and exits 0. Nothing interactive ever starts on a pipe; this is the invariant that keeps every script that ever shelled out to `rfa` working. `rfa dashboard` (alias `rfa ui`) opens the dashboard by name and refuses a pipe with exit 2 and `rfa status --json` named as the script's equivalent.

### 13.2 The onboarding

`rfa init` on a terminal IS the onboarding; `rfa init --yes` and every flag are the same provisioning with no screen. The onboarding is a way to fill the answers `rfa init` takes (`InitAnswers`) and nothing more, so it can never do something the headless path cannot, and `provision()` is the one implementation behind both.

- The first screen checks the machine before anything is written (`src/cli/environment.ts`): the Node version, the native SQLite binding opened once, git, the model credential (a logged-in `claude` or ANTHROPIC_API_KEY; without one agents join and refuse every answer), the other model CLIs if present (codex, gemini: named, with whether they are logged in, and the plain note that rfa does not run residents on them today), tailscale and the service manager for later, and whether the folder is writable. A ✖ blocks with its fix and `r` re-checks; `rfa doctor` prints the same lines first and `rfa init --yes` prints them before provisioning.
- One question per screen, the reason for the question in a panel beside it, the default pre-filled, escape goes back (over the screens that did not apply: an answerer is asked what it reads, a tool user what it acts through, a spec-expert neither; an existing directory skips the manifest questions).
- A tool user names its MCP server before anything is written: one of the servers shipped in the package (`builtin: linear` today, with the secret it needs named on the done screen) or a command plus the tool id that pauses for approval, the server's name derived from the command. A pack with a placeholder server validates and acts on nothing, which is the trap this screen exists to close; `rfa agent new --kind tool --builtin <name>` and `rfa init --builtin <name>` are the headless forms.
- Before the stack is started, the native SQLite binding is opened once in process: a machine with two Nodes runs `rfa` under whichever is on PATH, and a hub spawned under the other dies on its first database with a reason only its log sees. The refusal names both ABIs and the fix, before anything is spawned; `rfa up` and `rfa doctor` do the same.
- Provisioning is a live checklist: each line the headless path prints becomes a line that ticks, with its one-line explanation under it.
- The first minute ends in **first value**: if the stack was started and the agent joined, the last screen asks the question the agent can answer, waits with the agent's name on the spinner, and shows the answer with its citations, duration, cost and run id. Then the next commands that matter, the human key shown once, and enter opens the dashboard (as its own `rfa dashboard` in the directory just written).
- The wordmark reveals itself once, through its gradient, on the welcome screen. That is the whole of the theatre.

### 13.3 The dashboard

One snapshot refreshed every two seconds, under a tab per concern: **Overview** (processes, agents, rooms, the last 24 hours with answers per hour, alerts, what waits to be labelled, recent answers), **Agents**, **Rooms**, **Approvals**, **Feed** (a room's log followed live, from the file, as `rfa room tail -f` reads it), **Evals** (the labelling sitting in place and the gate; 13.10), **Tasks** (a room's board; 13.11). Single-key verbs on each tab do what the matching command does, by calling the same function the command calls: `r s x` restart/start/stop an agent through the supervisor's command channel, `m` cycle its mode (RFA-0.4 sect. 3.12: ask, plan, bypass; bypass confirmed first), `y n` approve (confirmed first: it executes the agent's action, and the CLI's own approve confirms) / reject a card through the same workbench route the console uses, `u d` are `rfa up` and `rfa down`, `a` opens the ask box (discovery by capability, the choice shown when more than one is offered). The keys are the ones operators already have in their fingers from lazygit and k9s: `?` help, `:` (or `/`, or ctrl-k) the palette, numbers and tab for tabs, j/k or arrows to move, q to leave.

**The palette is how the long commands get learned.** Every command, fuzzy-searched by path and summary (a prefix match outranks a scattered one; what was run last is listed first). It ALWAYS shows the exact command line it is about to run, asks in place for the arguments a command requires (one field per `<token>` in its usage), then runs it as an ordinary `rfa` child with the terminal handed over (ctrl-c belongs to the child, so `rfa logs -f` ends the way it always did), waits for a key, and takes the terminal back. Nothing is reimplemented for the dashboard; a verb that is not a thin call into a command's own code is a bug.

### 13.4 Discoverability outside the dashboard

- **Completion.** `rfa completion zsh|bash|fish` prints a few lines that defer every tab to the hidden `rfa __complete`, so completion knows what the CLI knows: groups, commands, flags, and what THIS directory holds (agent names, room aliases, bearer labels), never a list frozen at install time. `--install` writes the line into the shell's rc.
- **Did you mean.** An unknown command is matched fuzzily against every command path: `rfa agnet restrt` and `rfa restart-agent` both suggest `rfa agent restart`. Suggestions only; nothing runs on a guess.
- **A missing argument on a terminal is a question.** `rfa agent restart` with no name lists the packs; `rfa ask` with no question asks for one and, when several capabilities are offered, lists them with who is behind each; `rfa room show` with no room lists the rooms; `rfa approvals approve` with no id lists the pending cards. On a pipe, or under `--yes`/`--json`, the same call is the usage error it always was (exit 2), so scripts never block on a prompt.

### 13.5 Design rules

- The terminal UI is Ink (React rendering to the terminal; the engine under Claude Code's own CLI) with `@inkjs/ui` for text fields and `fuzzysort` for the palette. `@clack/prompts` stays for the one-line prompts of 13.4 and the confirmations that already used it. No other UI dependency.
- One accent (the console's blue), the console's presence colors, the terminal's own palette for everything else, and exactly one flourish: the wordmark's gradient. No animation anywhere after the welcome screen except spinners while something is awaited.
- Every number on the dashboard is a number a command prints (`rfa status --json`, `/api/approvals`, the observability store read-only). The dashboard is a view over the same data, which is what keeps it honest.
- Nothing interactive on a pipe, ever (13.1).

### 13.6 Non-goals, still

No mouse, no web rendering of the dashboard (the console is the browser's view), no global state, no dashboard-only feature: anything the dashboard can do has a command.

### 13.7 The agent walkthrough

`rfa agent new` with no name on a terminal, and `n` on the dashboard, open the walkthrough (`src/cli/tui/agentwizard.tsx`): every setting a pack has, one screen each with the reason beside it: the name, the kind, what an answerer reads (a folder, a git repository cloned and tracked, or later), what a tool user acts through (a built-in server or a command and a tool id) and its mode, the model, the capability it advertises (the id an asker matches on, and its description), the budgets (per task, per day, max turns), the room (a recorded one, a new one created on the spot, or none yet), a review screen, then the same `scaffoldPack` the one-line command runs. The flags of `rfa agent new` remain the headless form of every answer; the walkthrough can never produce a pack the flags could not.

**`rfa agent edit <name>` is the same walkthrough over an existing pack (amendment, 2026-08-23).** Alone on a terminal, and from `e` on the dashboard's Agents tab, it lists the settings with their current values (description, model, capability, budgets, mode for a tool user, room, knowledge); choosing one opens the screen `rfa agent new` asks it on, pre-filled, and returns to the list with the change marked; `apply` writes them all at once through `editPack` (`src/cli/agentmd.ts`), which rewrites one line or block per setting, keeps every other line byte for byte (the scaffold's reason above a block included), and validates the whole through the supervisor's schema before a single write, so a refused edit leaves the file as it was. The flags are the headless form of every answer, `--knowledge` attaches a folder or clones a git remote the way `rfa knowledge add` does (one `attachKnowledge` behind both and the walkthroughs), and `--editor` is agent.md itself in `$EDITOR` for the prompt and everything the list does not hold. A change rotates the definition; the screen says whether a supervisor is running to drain and respawn the resident. On a pipe with no flag it is the usage error.

### 13.8 Following the terminal

Every screen reads the terminal's size and follows it: the onboarding and the walkthrough put the reason panel beside the question above 96 columns and below it otherwise; the dashboard's two-column tabs become one column under 100 and its tables shrink their columns proportionally to the width they have. Ink clears the screen when the terminal gets narrower but not when it gets shorter; the dashboard clears it on any shrink so the next frame repaints from the top.

### 13.9 Testing

The pure parts (the palette's search and argument form, the onboarding's screen order, completion candidates, did-you-mean) and the components rendered headless with `ink-testing-library` run under `npm test`. The other half runs the front door inside a real pseudo-terminal: `npm run tui:smoke` (`scripts/tui-drive.py`, Python's stdlib pty, the one non-TypeScript file under `scripts/`) drives the dashboard through its tabs, help and palette and two window resizes, the walkthrough through an answerer end to end, and the onboarding through its checks and every default to the done screen, and reads back what was painted. It exists because it found the bug no headless render could: a select that fires only on CHANGE left the onboarding stuck on its own default, which is the common case.

### 13.10 The Evals tab: the labelling sitting in place (amendment, 2026-08-23)

RFA-0.5 sect. 20.4 makes labelling one sitting: the binary label, the gold source and the promotion together, over the same traces. `rfa evals label --prepare|--apply` does it through a worksheet; the Evals tab does it in the dashboard, over the same queue, through the same function.

- **The queue** is the review queue of sect. 20.5 (flagged `needs_review`, or carrying feedback at or below zero, without a human label yet; newest first), exactly what `--prepare` would write: `reviewQueue()` in `src/evals/label.ts` is the one query, and the worksheet is a file written over its result. It is read when the tab opens and on `R`, never on the two-second tick: rows moving under a hand that is judging them is how a verdict lands on the wrong trace. The whole answer is read from the room log when it is at hand, matched by the run id every response carries in its json part (residents store a 300-char excerpt in obs.db, and a sitting that judges the fragment as the answer produces anchors that are subtly wrong); the worksheet gets the same, and the excerpt note remains only when the log cannot be read.
- **Per trace**: `p` pass; `f` fail, asking the failure mode in place (in the words the findings ledger will use: it names the case if the trace is cut into one); `g` the gold source (the file#section that should have been cited, with what was cited shown beside the question); `c` cut it into a case (a judged trace only, with a room and a conversation); `x` clear the verdict; `v` the whole answer, scrolled.
- **`enter` applies**, after a confirm that says what will be written: the count of labels with their split, the gold sources, the cases, that the rows are human rows without a rubric hash, and how many traces are left unjudged for a later sitting. It calls `applySitting()`, the function `--apply` delegates to, so the rows the dashboard writes cannot differ from the command's (a test runs both front ends on twin stores and compares the feedback tables). The result screen is the command's output: the counts, the failure modes recorded, each case cut with promote's own notes, the problems, and the ledger line an all-passing sitting owes under sect. 20.4, with the sentence that says why.
- **The gate panel** lists the cases `rfa evals ls` lists, each with its baseline pass^k from `evals/baseline.json` and what the newest report under `.rfa/reports/evals/` recorded for it (one mark per trial, refusals counted, BLOCKED named), and when that run was. `r` runs `rfa evals run` as a child, after a confirm that names the cost, because one run is the day's budget.
- **How a trace enters the queue.** Evals and parity flag their own failures. A person reading a wrong answer does it with `rfa evals flag <run id> ["<why>"]`, or `!` on the ask box's answer: the run is marked `needs_review` and a human `flag` row at 0 keeps the reason, which the queue shows beside the trace. Before this the flywheel had no human entry point: the only wrong answers a sitting could see were the ones an instrument had already caught, and the ask box's closing line ("the sitting lists it if it was wrong") was false.
- The Overview's "last 24 hours" panel carries "to label N · press 6" and the tab's label carries the count: the two numbers `reviewQueueCounts()` reads, refreshed with the snapshot because counting is cheap and reading the queue is not.

### 13.11 The Tasks tab (amendment, 2026-08-23)

The board of one room, as `rfa task ls` lists it, with the selected task in full beside it: title and description, owner and creator by name (the roster is read with the board, so a member id never shows where a name exists), the deadline as a countdown, what blocks it and what it blocks, the evidence it ended with and the verdict it waits for. `[` `]` move between rooms, `f` shows every state rather than the open ones, `n` puts a task on the board (the title; who does it: a present member by name, a capability resolved to its ready offerer at create time — the rule ask uses — or nobody; whether it ends in evidence a different member must accept), `y` accepts pending evidence and `r` rejects it with a note (the task goes back to working), `x` cancels after a confirm, `v` runs `rfa task show`. Every verb is the `room_task` call the task commands make, from the same operator membership (`board()` in `src/cli/commands/talk.ts`), so the tab can do nothing a command cannot.

The board is read when the tab opens or its room changes, then every three seconds while the hub serves. With the hub down the read opens the store in this process, and a store held open at the moment `rfa up` starts the hub would refuse the hub its lock; so, down, the board is read once and on `R` only, and the panel says so.

---

## Appendix A: `rfa.json` schema

```ts
const manifest = z.object({
  rfa: z.literal(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
  hub: z.union([
    z.object({
      port: z.number().int().min(1).max(65535),
      bind: z.string().default("127.0.0.1"),
      public_url: z.string().url().nullable().default(null),
      allow_origins: z.array(z.string().url()).default([]),
      otel: z.boolean().default(true),
      gate: z.string().nullable().default("policies/gate.json"),
      require_signed_cards: z.boolean().default(false),
      trusted_keys: z.string().nullable().default(null),
      push_url: z.string().url().nullable().default(null),
    }).strict(),
    z.object({ url: z.string().url() }).strict(),
  ]),
  agents: z.object({ dir: z.string().default("agents"), max_inflight: z.number().int().min(1).default(2) }).default({}),
  retention: z.object({
    obs_days: z.number().int().min(1).default(14),
    backup_keep: z.number().int().min(1).default(7),
    backup_dir: z.string().default("~/Backups/rfa/<name>"),
  }).default({}),
  paths: z.object({ runtime: z.string().default(".rfa") }).default({}),
}).strict();
```

`strict()` everywhere: an unknown key is a typo, and a typo in a deployment manifest that is silently ignored is a runbook entry waiting to be written.

## Appendix B: `.rfa/` file formats

```jsonc
// principals.json  (0600)
{ "version": 1, "principals": [
  { "id": "hp_bbfb77e8692c", "label": "paul", "key_sha256": "…", "created_at": "2026-08-22T09:00:00Z" } ] }

// tokens.json  (0600)
{ "version": 1, "tokens": [
  { "id": "tk_7f2…", "label": "operator",        "kind": "operator", "sha256": "…", "created_at": "…", "expires_at": null },
  { "id": "tk_a91…", "label": "claude-code@mbp", "kind": "client",   "sha256": "…", "created_at": "…", "expires_at": null },
  { "id": "tk_c04…", "label": "langchain-vps",   "kind": "peer",     "sha256": "…", "created_at": "…", "expires_at": "2026-11-20T00:00:00Z", "rooms": ["r_3f9a1c2e7b"] } ] }

// rooms.json  (0600)
{ "version": 1, "rooms": [
  { "alias": "product", "handle": "r_3f9a1c2e7b", "topic": "product questions", "join_secret": "js_…",
    "operator": { "member_id": "m_…", "membership_token": "mt_…", "name": "paul", "role": "participant", "host": true },
    // Only where the operator membership cannot send (an adopted room's operator is a
    // supervisor, and wire 12.1 gives a supervisor no voice but inject): the ONE
    // participant membership `rfa ask` records and resumes instead of joining per question.
    "speaker": { "member_id": "m_…", "membership_token": "mt_…", "name": "paul-cli" },
    "created_at": "…" } ] }

// secrets.json  (0600)  unchanged shape: NAME -> value
{ "RFA_TOKEN": "tok_…", "RFA_HUMAN_KEY": "hk_…", "LINEAR_API_KEY": "lin_…" }

// run/hub.pid
{ "pid": 4021, "pgid": 4021, "started_at": "…", "port": 8790, "dir": "/Users/paul/rfa/acme" }
```

## Appendix C: environment variables after the change

| Variable | Read by | Status |
|---|---|---|
| `RFA_DIR` | everything | new: the hub directory, set by the CLI for every child |
| `RFA_HUB_URL` | supervisor, resident, CLI | kept as an override; derived from the manifest otherwise |
| `RFA_TOKEN` | residents (injected), CLI | kept; the operator bearer |
| `RFA_HUMAN_KEY` | CLI | new; replaces reading `human-key.txt` |
| `RFA_JOIN_SECRET` | residents | legacy; no longer scaffolded, still honored |
| `RFA_HUMAN_KEYS`, `RFA_MCP_TOKENS`, `RFA_PUSH_URL`, `RFA_CONSOLE_URL`, `RFA_ACCOUNT_MAX_INFLIGHT` | hub, supervisor | kept for tests and throwaway hubs; the manifest and the credential files are the configured path |
| `RFA_KNOWLEDGE_REMOTE`, `RFA_KNOWLEDGE_PACK`, `RFA_KNOWLEDGE_DOCS` | `rfa knowledge` | replaced by arguments; kept one release as a fallback |
| `NO_COLOR`, `EDITOR` | CLI | honored |

## Appendix D: command reference

```
rfa                                    # the front door: the onboarding (no hub directory yet) or the dashboard; the help on a pipe
rfa init [--yes] [--name] [--port] [--human] [--agent spec-expert|answerer|tool|none] [--agent-name] [--knowledge <dir>]
         [--server <name> --command <cmd> --tool <id> | --builtin linear] [--room <alias>] [--topic] [--no-start]
         [--ask "<question>"] [--hub-url <url> --token <bearer> --room-handle <r_…>] [--force]
rfa dashboard                          # by name; refuses a pipe (rfa status --json is the script's form)
rfa up [--only hub|supervisor] | down | restart | status [--json] | doctor [--deep] [--json]
rfa logs [hub|supervisor|<agent>] [-f] [-n <lines>] | console [--room <alias|handle>] [--no-open]
rfa hub run [--stdio] | hub expose --tailscale [--off] [--dry-run] | supervisor run
rfa service install [--print] [--platform darwin|linux] | uninstall | status
rfa demo | version | docs interop|spec|platform|plan|readme|client [--path] [--open]
rfa completion zsh|bash|fish [--install]
rfa migrate [--from <checkout>] [--to <dir>] [--name] [--port] [--human <label>] [--room-alias <alias>] [--dry-run]

rfa agent new <name> [--kind spec-expert|answerer|tool] [--room <alias|handle>] [--knowledge <dir>] [--model haiku|sonnet|opus]
              [--server <name> --command <cmd> --tool <id> | --builtin linear [--tool <id>]] [--mode ask|plan|bypass] [--dry-run]
rfa agent ls | show <name> | validate [<name>] | bind <name> --room <alias|handle> [--observer] [--no-serve]
rfa agent start|stop|restart <name> | mode <name> [ask|plan|bypass] | retire <name> [--dry-run] [--timeout <s>]
rfa agent edit <name> [--model] [--description] [--offer <id>] [--offer-description] [--per-task] [--per-day] [--max-turns]
              [--mode] [--room] [--knowledge <dir|git remote> [--docs <subdir>]] [--editor]

rfa room create <alias> [--topic] [--history member|joined_after] [--mode open|sequential|moderator]
rfa room ls | show <alias|handle> | tail <alias|handle> [-f] [-n <lines>]
rfa room allow <alias|handle> --token <label> | disallow <alias|handle> (--token <label> | --sha256 <hex>)
rfa room policy <alias|handle> set <k>=<v> … | secret show <alias|handle>
rfa room evict|hold|release|quarantine <alias|handle> <member> [--reason] | inject <alias|handle> "<text>" [--to <member>]
rfa room end <alias|handle> [--summary] | adopt <alias|handle> [--alias <alias>] [--secret <join secret>] [--no-allow]

rfa ask "<question>" [--room <alias|handle>] [--capability <skill id>] [--timeout <seconds>]
rfa task ls [--room] [--all] | show <id> [--room]
rfa task create "<title>" [--room] [--description] [--owner <member> | --capability <skill id>] [--reply-by <ISO|+minutes>] [--evidence-required] [--blocked-by <id,id>] [--max-attempts <n>]
rfa task cancel <id> [--room] | verify <id> --verdict accept|reject [--note] [--room]
rfa approvals ls | show <request_id> | approve <request_id> [--edit k=v …] | reject <request_id> [--reason]

rfa human add <label> | ls | rotate <label> | remove <label> [--force]
rfa token mint <label> [--kind client|peer|operator] [--expires 90d] | ls | revoke <label>
rfa secrets set <NAME> [--stdin | --from-env VAR] | ls | unset <NAME>
rfa key new [--alg es256] [--out <prefix>] | sign <card.json> <key.json>

rfa connect claude-code [--room <alias|handle> …] [--scope user|project|local] [--label] [--skill] [--print] | cursor | mcp
rfa peer add <name> [--room <alias|handle> …] [--expires 90d] [--home <org>] | ls | show <name> | revoke <name>
                                       # rung 5 (gated) adds: rfa peer invite <name> --room [--ttl]

rfa knowledge add <agent> <path|git remote> [--docs <subdir>] [--name <clone name>] | sync [<agent>] [--pin] | status | pin [<agent>] [--sha <sha>]
rfa evals run [--judged] [--update-baseline] [--room] | ls
rfa evals promote <room> (--conversation <id> | --task <id>) --id <case id> [--failure-mode] [--out <dir>] [--log <file>]
rfa evals label --prepare [--limit <n>] [--out <file>] | --apply <worksheet> [--out <cases dir>]   [--db <obs.db>]
rfa evals flag <run id> ["<why>"] [--db <obs.db>] | parity [--room] [--capability] [--fixtures <file>] [--capture] [--timeout]
rfa log verify [<alias|handle> …] [--file <log.ndjson | directory>] [--json]
rfa backup now [--keep <n>] | ls | restore <day> [--dry-run]
rfa config show | get <key> | set <key> <value>
```

Global flags on every command: `--dir <hub directory>`, `--json`, `--yes`, `--quiet`, `--no-color`, `--debug`, `--help`.
