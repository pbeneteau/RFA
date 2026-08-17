# 04 - Hub deployment: running a hub that serves more than one operator, and where it lives

Dimension 04 of research wave 04 (remote agents as first-class room members). Depth: DEEP.
Research date: **2026-08-17**. Grounding read first: `STATUS.md`, `spec/RFA-0.1.md` (0.1.7), `spec/RFA-0.4-platform.md`, `research/02-platform/REPORT.md`, `research/03-reach-and-collaboration/REPORT.md` + `notes/01-remote-reach.md`, and the source: `src/store.ts`, `src/main.ts`, `src/hub.ts`, `src/engine.ts`, `src/obs.ts`, `src/memoryfs.ts`, `src/supervisor.ts`, `src/secrets.ts`, `src/platform.ts`, `src/client.ts`.
Method: primary sources only for load-bearing claims (specs, RFCs and drafts, official docs, source code, measured local state). Everything I could not confirm is prefixed `UNVERIFIED:`.
Premise honored: RFA is a tool **any organization** runs. The prior waves' "personal tool for one operator on one laptop" justification is retired.

---

## Verdict

### Headline

**The hub is already correctly shaped for multi-operator use where it is hard (durable append-only room log, rooms that survive restart, no protocol sessions, server-minted handles) and wrongly shaped where it is cheap to fix (one global human-key list with no principal identity, one shared join secret per room, an unauthenticated `/mcp` plane where anyone reachable can `room_create`, and a workbench that reads and writes the operator's filesystem hub-wide with no room scoping).** The deployment answer is not a platform: it is **one hub per org**, shipped as a container image plus a compose file (and a systemd unit), with **rooms as the isolation unit** and remote agents from other orgs joining **your** rooms as guests. Federation is a reject with a named trigger, not a roadmap item.

**The storage question, honestly re-opened, has a different answer than the one that was parked.** The room state that multi-operator use actually stresses is **not in SQLite at all**: `src/store.ts` persists rooms as NDJSON plus a `meta.json` snapshot using `node:fs` only, and holds every event of every room in RAM. So the previously parked "SQLite to Postgres swap" was aimed at the engine/obs/memory stores, which are 64 KB and 225 KB on the live machine and are not the problem. The room store has three real defects, and Postgres fixes none of them:

1. `writeMeta` does a non-atomic full-file `writeFileSync` (`src/store.ts:2199`), and `loadFromDisk` **silently skips a room whose meta file fails to parse** (`src/store.ts:2303-2305`). A crash mid-write therefore makes a whole room disappear at next boot, log intact but unloaded. This is the most serious durability bug found in this dimension.
2. The entire room log lives in `room.events: RfaEvent[]` (`src/store.ts:204`) and is fully re-read and re-hashed at boot (`src/store.ts:2261-2274`). Measured: `data/rooms/r_9a25e48c0e.ndjson` is 897,126 bytes today for one standing room with two residents.
3. Send idempotency does not survive a restart. `room.dedupe` is in-memory and reset on load (`src/store.ts:208`, `2225`), while the send path checks only `room.dedupe` (`src/store.ts:742-743`). `sentIds` **is** rebuilt from the log (`src/store.ts:2271`) but is not consulted for idempotency. So a remote peer that retries with the same `message_id` across your restart gets a duplicate appended, contradicting the tool's own contract ("retries with the same id are idempotent", `src/hub.ts:230`).

**Multi-tenancy is decided by the workbench, not by the rooms.** Rooms are already isolated (opaque handle, membership tokens, per-room join secret, per-room policies). The workbench is not: `/api/agents`, `/api/agents/<n>/definition`, `/api/runs`, `/api/summary` and `/api/approvals` are hub-scoped with no room filter (`src/main.ts:224-302`), and `hub.pendingApprovals()` returns pending approvals across **every** room (`src/store.ts:1151-1200`). One session token therefore reads every org's agent prompts and every org's pending draft. That single fact settles the single-hub-multi-org question: **one hub per org**, and remote peers get room membership, never workbench access.

### The six decisions

| # | Question | Decision | Why, in one line |
|---|---|---|---|
| 1 | Storage engine | **Keep SQLite for engine/obs/memory; keep NDJSON + snapshot for rooms; port `better-sqlite3` to `node:sqlite`** | The Postgres swap is not a driver change (sync-to-async propagates through 56 prepared-statement sites and 5 transactions, plus FTS5 has no PG analog), and the native addon is what actually blocks a clean artifact |
| 2 | Postgres | **Reject now, keep the seam** | PG buys nothing at 64 KB and 225 KB of data, and costs a second daemon with a stop-the-world major-version ritual |
| 3 | Tenancy model | **One hub per org; rooms are the isolation unit; remote agents join as guests** | The workbench is hub-scoped by construction, so a multi-org hub leaks across orgs on day one |
| 4 | Federation | **Reject cross-hub room replication. Defer federated *directory search* behind the reserved fields** | The reserved FIPA fields are about propagating a *search*, not about replicating a room; Matrix shows what a real cross-server room log costs |
| 5 | Where it runs and what ships | **The org's own box or a small VPS. Artifact: OCI image + `compose.yaml`, plus a systemd unit template. Keep `npx rfa-hub` for dev** | Managed serverless is disqualified by its ephemeral filesystem; Kubernetes and a single binary both cost more than they return here |
| 6 | Availability | **No SLA, published posture, four small protocol additions** | The durable log already is store-and-forward; peers need retry rules and a task claim TTL, not new infrastructure |

### Recommendations

| # | Recommendation | Verdict | Rationale (evidence) | Effort | Spec impact |
|---|---|---|---|---|---|
| 1 | Atomic snapshot write: `writeMeta` writes `<file>.tmp` then `fs.renameSync`; a meta file that fails to parse **refuses to boot that room loudly** (surfaced in `/healthz`) instead of `console.error` + skip | **adopt** | `src/store.ts:2199` writes in place; `src/store.ts:2303-2305` swallows the failure. A torn 49 KB snapshot silently loses a room's membership, tasks, approvals and quarantine list | 2 h | Platform spec 10: "the snapshot write MUST be atomic; a hub MUST NOT start a room from an unparseable snapshot" |
| 2 | Restart-durable send idempotency: check `sender.sentIds.has(message_id)` before append and return the existing event's seq | **adopt** | `src/store.ts:742-743` consults only the in-memory `dedupe`, reset at `src/store.ts:2225`; `sentIds` is already rebuilt at `src/store.ts:2271`. Remote peers retrying across your outage duplicate messages today | 2 h | Protocol 9.1: idempotency window MUST survive hub restart for as long as the log retains the message |
| 3 | Window the in-RAM log: keep the last N events per room (N >= `replayCap`), serve older `since` values by streaming the NDJSON from disk | **adapt** | `src/store.ts:204` + `2261-2274`: full log in RAM and a full re-read plus re-hash at boot. 897 KB today for one room; cross-org rooms grow faster | day | Protocol 11.1: `bad_cursor` gains "below the retained window" semantics only if the disk fallback is dropped; with the fallback, no wire change |
| 4 | Per-human principal records: replace `humanKeys: string[]` with `{key_hash, principal_id, label, roles[]}` loaded from a file, compared with `timingSafeEqual`; stamp `principal_id` on the membership, on every `intervention` and on every approval decision | **adopt** | `src/store.ts:62`, `464-470`: any valid key yields `origin: "human"` with no identity. `decidedBy` (`src/store.ts:1384`) records a member id that, for console decisions, is always the same shared membership | day | Protocol 4.2: human principals gain a `principal_id`; intervention and approval events carry it. 0.1.8 wire text |
| 5 | Console mints a membership **per principal** (`console-<principal_id>`), not one shared `console` | **adopt** | `src/store.ts:1203-1219` reuses one membership named `console`; `src/main.ts:293` decides approvals through it. Two humans are indistinguishable in the hash-chained log | 2 h | None (same authority path, per 0.4 spec 9) |
| 6 | `--workbench-root <dir|none>`: the agent-pack/registry/lifecycle surface becomes opt-in, defaulting to the repo root, and `none` disables it | **adopt** | `src/main.ts:139-140, 189-209, 225-254` make the hub read the operator's `agents/` tree, read heartbeat files, serve and **write** `agent.md`, and append to `data/supervisor-commands.ndjson`. A hub hosting other orgs' agents must be able to run without that surface | 3 h | Platform spec 9: workbench routes are an optional profile, not part of the hub |
| 7 | Room-scope the workbench reads: `/api/approvals`, `/api/runs`, `/api/summary` take a required `room` (or a principal-to-room grant list) | **adopt** | `src/store.ts:1151-1200` returns approvals for all rooms; `src/main.ts:255-286` filters runs only by an optional `group` param. Blast radius of one leaked session token is currently "every room on the hub" | day | None (workbench is out of the protocol) |
| 8 | Bearer credential at the MCP transport, per member, checked before the MCP handler; `room_create` requires it | **adopt** | `src/main.ts:327-330` routes everything but `/auth` and `/api/*` straight to the MCP handler with no auth, so `room_create` (`src/hub.ts:163`) is an unauthenticated, unrate-limited resource-creation primitive for anyone who can reach the port. MCP 2026-07-28 makes authorization OPTIONAL, so a static audience-bound bearer is conformant | day | Protocol 4.2: restate T1 as "audience-bound bearer at the transport"; keep full OAuth 2.1 for the cross-org tier (wave 03 rec 9 stands) |
| 9 | Ship an OCI image + `compose.yaml` (named volume for `data/`, `restart: unless-stopped`, `healthcheck` against `/healthz`) as the primary artifact, and a systemd unit template using `LoadCredentialEncrypted=` for human keys and secrets | **adopt** | Compose spec defines `healthcheck` and `restart: unless-stopped` normatively; systemd credentials are readable only by the service user and are not in the environment or the process listing, which is exactly what `data/secrets.json` + env injection is not | day | Platform spec 10 replaces "two launchd plists" with "one container image + compose, one systemd unit, launchd for macOS operators" |
| 10 | `GET /healthz`, unauthenticated, no per-room detail: `{ok, version, uptime_s, rooms, lock_ok, data_dir_writable, corrupt_rooms}` | **adopt** | There is no standard to follow (the IETF health-check draft expired in 2022 at Informational), and Compose needs a command that exits non-zero | 2 h | Platform spec 10 |
| 11 | `PRAGMA user_version` migrations for the three SQLite files; `meta_version` in the room snapshot with refuse-to-load-if-newer | **adopt** | `user_version` is "an integer that is available to applications to use however they want" (sqlite.org). Room snapshots already migrate by defaults-on-load (`src/store.ts:2211`), which worked live in v0.5.0, but nothing stops an older binary from eating a newer snapshot | half day | Platform spec 10 |
| 12 | Port `better-sqlite3` to `node:sqlite` (`DatabaseSync`, `prepare/run/get/all/exec`, `database.backup()`), keeping the synchronous call shape | **adopt** | `node:sqlite` is Stability 1.2 (release candidate), synchronous, supports `PRAGMA journal_mode = WAL`, and has `backup()`. Dropping the native addon removes the Docker/arm64 and SEA failure modes and removes the `sqlite3` CLI dependency in `src/platform.ts:38`. **Gate: confirm FTS5 is compiled in** (`src/memoryfs.ts:246`) | day | None |
| 13 | Migrate the rooms store to SQLite or Postgres | **reject** | The NDJSON log is the audit artifact: tailable (`npm run tail`), offline-verifiable against the hash chain (`src/store.ts:2134-2137`), and an append is the simplest durable write there is. Fix the snapshot's atomicity instead | - | None |
| 14 | Postgres for engine/obs/memory | **defer** (trigger below) | Enum names do match LangGraph verbatim, but the port is sync-to-async across 31+15+10 prepared statements and 5 transactions, plus an FTS5 rewrite, plus `pg_upgrade`'s stop-both-servers ritual, for zero benefit at 64 KB + 225 KB | - | Platform spec 4.3 keeps the "adopted from LangGraph" note but drops "a Postgres swap is a driver change" as inaccurate |
| 15 | Cross-hub federation (replicated room logs across hubs) | **reject** | RFA's room is a single-writer total order with `seq` as the cursor and a linear hash chain. Federation replaces that with a DAG plus a state-resolution rule, which invalidates the cursor, the chain, and the atomic task claim. Matrix's price list is in the evidence | - | Appendix D: split the parked item into "federated directory search (reserved)" and "cross-hub rooms (out of scope)" |
| 16 | Federated **directory search** using the reserved `search_id` / `max_depth` / `scope` | **defer** | FIPA's semantics are propagation rules for a *search*, verbatim in the evidence, and they are cheap. But the trigger is "a second hub exists that you want to discover agents on", and today there is one | - | Protocol: keep reserved, add the FIPA propagation rules as informative text so the reservation means something |
| 17 | Multi-process or clustered hub behind a load balancer | **reject** | Waiters and watchers are per-process (`src/store.ts:205-206`, `src/hub.ts:434-444`), the data dir is exclusive by design (`src/store.ts:317-360`, spec 3), and WAL "does not work over a network filesystem". If it ever happens it needs sticky routing (nginx `ip_hash` / `sticky`), which is a lot of machinery for a room with 3 agents | - | None (spec 3 already forbids two hubs over one store) |
| 18 | Managed serverless runtime (Cloud Run and friends) | **reject** | "It is an in-memory file system, so writing to it uses the instance's memory. Data written to the file system doesn't persist when the instance stops." The hub is a stateful, long-polling, file-backed server | - | None |
| 19 | Single binary via Node SEA | **reject for now** | SEA is Stability 1.1 (active development), only built-in modules load by default, and native addons produced via postject on Linux arm64 "will crash on `process.dlopen()`". Revisit after rec 12 lands and `useCodeCache: false` is acceptable | - | None |
| 20 | homebrew-core formula as a distribution channel | **reject as primary, adopt as convenience later** | homebrew-core requires an immutable tagged release with SHA-256 and no self-updating, all satisfiable, but the audience for a server that an org self-hosts is a Linux box with a compose file, not a Mac laptop | - | None |
| 21 | Add roles beyond participant/observer/supervisor | **reject** | `role` is already per-membership (`src/store.ts:133`), so "supervisor in room A, observer in room B" works the moment principal identity exists (rec 4). A role matrix is ceremony | - | None |
| 22 | Console becomes an identity provider (OAuth/OIDC in the hub) | **reject**; support a trusted-proxy identity assertion instead | Wave 03 already established that a self-hostable AS cannot satisfy MCP's RFC 8707 requirement today. Two supported modes: per-human key at `/auth`, or a configured JWKS verifying an identity assertion from a proxy the operator runs | - | Platform spec 9: name the two modes |
| 23 | Optional task `claim_ttl_s` with a `task_released` event on expiry | **adopt** | A remote peer that claims a task and then dies (or never learns your hub came back) leaves the task in `working` forever: `reply_by` only emits `task_overdue` (`src/store.ts:1942-1956`), nothing releases it. This is the one protocol change remote workers actually need | day | Protocol 10: `room_task create` gains `claim_ttl_s`; new system event `task_released` |
| 24 | `hub_unavailable` error code with `retry_after_s`, and a client retry obligation with jitter in spec 9.5 | **adopt** | `src/client.ts:597` has no retry, no backoff and no `Authorization` support: a single fetch, and any hub blip throws to the caller. MCP 2026-07-28 removed stream resumability, so re-issuing is the transport's own model | half day | Protocol 15 (new code) + 9.5 (client obligations) |
| 25 | A queue, Redis, a message broker, or store-and-forward at the client | **reject** | The room log already is store-and-forward, and the platform spec's "no Redis, no queue infrastructure" stance survives the premise change unchanged | - | None |

### Unparks under the new premise

| Parked item | Now | Why the premise change flips it |
|---|---|---|
| **Multi-operator credential isolation** | **UNPARK** | It was parked verbatim because there was one operator (`spec/RFA-0.4-platform.md` section 13: "Deferred beyond v0.4: ... second-human credential isolation"; wave 03 section 7.9: "Does v0.5 admit a second human principal? No"). An org has several humans and at least one of them approves side-effecting tool calls. Without rec 4 the hash-chained log cannot say **who** approved, which is the one thing an org needs from it. Cheap: a file of principal records and a constant-time compare |
| **Normative REST binding** (spec 11.4, planned v0.2) | **UNPARK to a decision, not necessarily to code** | A remote agent built on LangChain/LangGraph, or exposed by another org's product, is much more likely to speak plain HTTP+JSON than MCP. 11.4 already reserves `POST /rfa/v0/{tool_name}` with identical bodies and `GET /rfa/v0/room/{room}/events?since=&timeout_ms=`. Deployment-relevant because it changes what has to be proxied and what has to be authenticated. Owner: the reach/interop dimension, not this one |
| **T1 transport auth** | **UNPARK, re-scoped** | An unauthenticated `/mcp` (`src/main.ts:327-330`) is defensible for a loopback laptop and indefensible for a hub other orgs dial into. Adopt the audience-bound bearer now (rec 8); the MCP **Client Credentials** authorization extension (draft, `grant_type=client_credentials` with `resource=`) is the shape to grow into when a real AS exists |
| **SQLite-to-Postgres swap** | **STAYS PARKED, with an honest correction** | Keep parked, but stop justifying it with "the field names are verbatim so it is a driver change". The enums are verbatim; the port is not mechanical (evidence E2) |
| **Cross-hub federation** | **STAYS PARKED, and should be split** | Guest membership delivers the user-visible outcome (a remote org's agent working in your room) with zero new protocol. Split the Appendix D item so the reserved fields are honestly labelled as directory search |
| **Group encryption (MLS), registry publication, contract-net auctions, per-message signatures** | **STAY PARKED** | None of them is a deployment or storage question. Per-message signatures and registries belong to the trust and discovery dimensions of this wave |

### What stays deliberately simple

- **One hub process, one data dir, one lockfile.** No clustering, no sticky routing, no leader election. Spec 3 already mandates exclusive store ownership and the lockfile already fails loudly (`src/store.ts:336-342`).
- **One hub per org.** No tenant object, no organization table, no cross-tenant admin. The room is the boundary; guests are members.
- **Files you can read with `cat`.** The room log stays NDJSON. The audit story stays "grep the log, verify the chain offline".
- **No Kubernetes, no service mesh, no Redis, no broker, no Postgres, no autoscaling, no blue/green.** A restart costs a peer one long-poll round trip, and the log makes it invisible.
- **No OAuth authorization server inside the hub.** A bearer token the operator provisions, or an identity assertion from a proxy the operator already runs.
- **Three roles, no matrix.** participant / observer / supervisor, plus host, per room.
- **Restarts are a normal operation, announced, not engineered around.**

---

## Evidence

### E1. What breaks today, read from the repo

All line numbers verified against the working tree at commit `02025de` (hub 0.6.0, protocol 0.1.7). Severity is relative to the new premise (remote peers may belong to another org and may be hostile or incompetent).

| # | Assumption | Where | What breaks with more than one operator / org | Severity |
|---|---|---|---|---|
| 1 | All room state in one process heap | `src/store.ts:286` `private rooms = new Map<string, Room>()`, `:287` `private tokens = new Map(...)` | Two hub processes = two truths. Forecloses any HA story; correct today, must stay a stated invariant | invariant |
| 2 | Whole event log in RAM, full re-read at boot | `src/store.ts:204` `events: RfaEvent[]`; `:2261-2274` reads the entire NDJSON, re-hashes every event | Measured: `data/rooms/r_9a25e48c0e.ndjson` = 897,126 bytes for ONE standing room. Boot cost and RSS grow linearly and forever | high |
| 3 | **Non-atomic snapshot write + silent room loss** | `src/store.ts:2199` `fs.writeFileSync(file, ...)` (49,138 bytes today for the standing room); `:2303-2305` `catch { console.error("skipping corrupt room file") }` | A crash or a full disk during a 49 KB in-place rewrite truncates the snapshot, and the next boot **drops the entire room** (members, tasks, approvals, quarantine list, join secret) with one stderr line. The log survives but is never loaded | **critical** |
| 4 | **Send idempotency is in-memory only** | `src/store.ts:208` `dedupe: Map<string, SendResult>`; `:742-743` the only idempotency check; `:2225` reset to `new Map()` on load; `:2271` `sentIds` IS rebuilt but is never consulted for dedupe | A remote peer retrying the same `message_id` across your restart gets a duplicate appended, breaking `src/hub.ts:230` ("retries with the same id are idempotent"). Exactly the case an outage produces | **high** |
| 5 | Rate limits and duplicate suppression reset on restart | `src/store.ts:2255` `rateWindow: []`, `bodyHashes: []`; limit enforced at `:786-790` | Spec 14.7 makes per-sender rate limits REQUIRED as a blast-radius control. A hostile peer gets a free reset every time you restart | high |
| 6 | Watchers and waiters are per-process, per-connection | `src/store.ts:205-206`; `src/hub.ts:151` `connectionId`, `:434-444` `deliver` closes over `server.server.notification` | Push delivery is bound to the process that holds the connection. Already documented in STATUS ("single-hub HA only"); becomes a hard ceiling if a second process is ever wanted | invariant |
| 7 | Floor state is restart-transient | `src/store.ts:2236` (documented), spec 12.3 | Deliberate and fine. Listed so the enumeration is complete | none |
| 8 | Lockfile liveness is PID-based and TOCTOU | `src/store.ts:320-349`: read, then `process.kill(pid, 0)`, then `writeFileSync` (no `O_EXCL`) | PID liveness is meaningless across containers/PID namespaces and across hosts on shared storage: a live hub elsewhere looks dead and the lock is stolen. Two racing starts can both pass the check | medium |
| 9 | **`/mcp` has no transport authentication at all** | `src/main.ts:327-330` routes only `/auth` and `/api/*` to the authed workbench; everything else goes to `handler.fetch`. The only `Authorization` parse in the file is `:170`, for `/api/*` | Anyone who can reach the port can call `room_create` (`src/hub.ts:163`) with no credential and no rate limit, and can attempt joins/quarantine-probing all day. Loopback binding is the only thing holding this together, and the premise says other orgs must reach it | **critical** |
| 10 | One shared join secret per room | `src/store.ts:384` `randomBytes(12).toString("base64url")`, checked at `:433-435` | T0 as designed. Revoking one org's agent means rotating the secret for every member. Spec 4.2 already labels T0 "same team / trusted cluster" | high |
| 11 | Human principals are an anonymous key list | `src/store.ts:62` `humanKeys: string[]`; `:464-470` `resolveOrigin` returns `"human"` with no identity; `src/main.ts:215` `hub.cfg.humanKeys.includes(...)` (non-constant-time) | No audit attribution across several humans. `origin: "human"` is a class, not a person | high |
| 12 | The console is ONE shared membership per room | `src/store.ts:1203-1219` reuses the member named `console` with `origin: "human", role: "supervisor"`; `src/main.ts:293-301` decides approvals through it | Every human's console decision is stamped with the same member id in the hash-chained log. `decidedBy` (`:1384`) is therefore uninformative for exactly the decisions an org cares about | high |
| 13 | Session tokens are in-process and unpersisted | `src/main.ts:141` `const sessions = new Map<string, number>()`, TTL 12 h sliding at `:142, 174` | Every restart logs out every human mid-approval. Two processes never share a token | medium |
| 14 | The hub reads and writes the operator's filesystem | `src/main.ts:139-140` `ROOT`/`AGENTS_DIR` from `import.meta.dirname`; `:189-209` lists packs and reads `state/heartbeat`; `:225-241` GET and **PUT** `agents/<n>/agent.md`; `:243-254` appends `data/supervisor-commands.ndjson`; `:311` reads `console/index.html` per request | The hub, the supervisor and the residents must be the same machine, same checkout, same user. In a container that is a bind mount; on a shared hub it is a cross-org read of system prompts and a cross-org write of agent definitions | **critical** for multi-org, medium otherwise |
| 15 | Workbench reads are hub-scoped, not room-scoped | `src/store.ts:1151-1200` `pendingApprovals()` iterates all rooms; `src/main.ts:255-286` filters runs only by an optional `group` | One session token reads every room's approvals and every run payload. This is what makes single-hub-multi-org untenable without real work | **critical** for multi-org |
| 16 | One global policy gate for every room, executing subprocesses as the hub user | `src/main.ts:48` `--gate` parsed once; `src/store.ts:80-96` `GateCheck`; `:1102` `command` tier via `execFile` (`src/store.ts:8`) | Cross-org rooms want different gates. A `command` check runs with hub privileges on the hub host | medium |
| 17 | One global trusted-key map for card verification | `src/main.ts:39, 44` `--trusted-keys` -> `HubConfig.trustedKeys` (`src/store.ts:58`) | No per-room or per-org trust anchor. Cross-org card verification wants one anchor per counterparty | medium |
| 18 | Secret VALUES in one JSON file, injected into child env | `src/secrets.ts:11-23` (mode is checked but only warned: `console.error(... run chmod 600)`); `src/supervisor.ts:82-88` `env = {...process.env, ...picked}` | On a shared box, another process of the same user (and root) reads `/proc/<pid>/environ`. Fine for one operator, wrong for a multi-user host | high |
| 19 | Residents are LOCAL children of the supervisor | `src/supervisor.ts:89` `spawn("npx", ["tsx", RESIDENT, "--agent", ...])`; `src/resident.ts:30` and `src/supervisor.ts:261` default `RFA_HUB_URL` to `http://localhost:8790/mcp` | The supervisor needs the repo, node, npx and (first run) network. Remote agents by definition do not go through this path, which is the point of the premise: the supervisor is for LOCAL agents only, and that should be said in the spec rather than implied | by design, document it |
| 20 | Three WAL SQLite files shared by hub + supervisor + residents | `src/engine.ts:67-68`, `src/obs.ts:90-91`, `src/memoryfs.ts:230` and `:389` | WAL requires every process on the same host (E2). This is the hard architectural boundary: the platform cannot be split across machines while these files are shared | invariant, state it |
| 21 | Backups shell out and target `$HOME` | `src/platform.ts:38` `execFileP("sqlite3", [db, ".backup ..."])`, `:47` `tar`; `src/supervisor.ts:344` `destRoot: $HOME/Backups/rfa-agent-com` | A container image must contain `sqlite3` and `tar` and must mount a backup volume. Rec 12 removes the `sqlite3` dependency via `database.backup()` | medium |
| 22 | Boot persistence is launchd only | `deploy/com.rfa.hub.plist`, `deploy/com.rfa.supervisor.plist`, `deploy/install.sh`; no Dockerfile, no compose file, no systemd unit in the tree | macOS-only deployment story for a tool an org is supposed to self-host | high |
| 23 | The client SDK has no retry and no auth header | `src/client.ts:597-627`: a single `fetch`, no backoff, no `Authorization`, no `retry_after_s` handling | Every peer must reimplement outage handling. Also means rec 8 requires a client change in the same commit | high |

### E2. The storage question, honestly re-opened

**First, the framing correction.** The room store is not SQLite. `src/store.ts` imports `node:fs` and `node:path` only (`src/store.ts:8-11`); `better-sqlite3` appears in exactly three files: `src/engine.ts`, `src/obs.ts`, `src/memoryfs.ts`. Measured on the live machine, 2026-08-17: `data/runs.db` 64 KB, `data/obs.db` 225 KB, `data/rooms/*.ndjson` 971 lines total of which 897 KB is one room's log. The previously parked "SQLite to Postgres swap" therefore concerned the smallest and least-stressed data in the system.

**SQLite's real concurrent-writer limits (sqlite.org, primary).**

From <https://www.sqlite.org/wal.html>:

> "Writers merely append new content to the end of the WAL file. Because writers do nothing that would interfere with the actions of readers, writers and readers can run at the same time. However, since there is only one WAL file, there can only be one writer at a time."

> "All processes using a database must be on the same host computer; WAL does not work over a network filesystem. This is because WAL requires all processes to share a small amount of memory and processes on separate host machines obviously cannot share memory with each other."

> "However, if a database has many concurrent overlapping readers and there is always at least one active reader, then no checkpoints will be able to complete and hence the WAL file will grow without bound."

> "But there are some obscure cases where a query against a WAL-mode database can return SQLITE_BUSY, so applications should be prepared for that happenstance." (cases listed: another connection in exclusive locking mode; the last connection closing and cleaning up the WAL; recovery after a crashed connection.)

From <https://www.sqlite.org/whentouse.html>:

> "SQLite supports an unlimited number of simultaneous readers, but it will only allow one writer at any instant in time. For many situations, this is not a problem. Writers queue up. Each application does its database work quickly and moves on, and no lock lasts for more than a few dozen milliseconds. But there are some applications that require more concurrency, and those applications may need to seek a different solution."

> "SQLite only supports one writer at a time per database file. But in most cases, a write transaction only takes milliseconds and so multiple writers can simply take turns. SQLite will handle more write concurrency than many people suspect. Nevertheless, client/server database systems, because they have a long-running server process at hand to coordinate access, can usually handle far more write concurrency than SQLite ever will."

> "Generally speaking, any site that gets fewer than 100K hits/day should work fine with SQLite. The 100K hits/day figure is a conservative estimate, not a hard upper bound. SQLite has been demonstrated to work with 10 times that amount of traffic." (the sqlite.org site itself: "about 400K to 500K HTTP requests per day, about 15-20% of which are dynamic pages touching the database")

`BEGIN CONCURRENT` does not change the conclusion. From <https://sqlite.org/hctree/doc/begin-concurrent/doc/begin_concurrent.md>: it "allows multiple writers to process write transactions simultaneously if the database is in 'wal' or 'wal2' mode", but "the system still serializes COMMIT commands", conflicting transactions get `SQLITE_BUSY_SNAPSHOT` and must roll back, and it lives on the hctree branch, not in a release.

**Read for RFA: writer concurrency is not the constraint at any volume RFA will see. Host locality is.** The invariant to write into the spec is: *hub, supervisor and residents share a machine for as long as they share `runs.db` / `obs.db` / `memory.db`. Anything that must run on another machine talks to the hub over MCP and owns its own storage.*

**Is the Postgres swap mechanical? Verify the claim.** `spec/RFA-0.4-platform.md:110` says: "`data/runs.db`, field names and enums ADOPTED from LangGraph so a later Postgres swap is a driver change". `src/engine.ts:1-12` repeats it.

The **enums are verbatim correct**. From `langgraph_sdk/schema.py` (<https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/sdk-py/langgraph_sdk/schema.py>):

```python
RunStatus = Literal["pending", "running", "error", "success", "timeout", "interrupted"]
ThreadStatus = Literal["idle", "busy", "interrupted", "error"]
MultitaskStrategy = Literal["reject", "interrupt", "rollback", "enqueue"]
```

`src/engine.ts:17-19` matches character for character:

```typescript
export type RunStatus = "pending" | "running" | "error" | "success" | "timeout" | "interrupted";
export type ThreadStatus = "idle" | "busy" | "interrupted" | "error";
export type MultitaskStrategy = "reject" | "interrupt" | "rollback" | "enqueue";
```

The **column set is not verbatim, and does not need to be.** LangGraph's `Run` TypedDict is `{run_id, thread_id, assistant_id, created_at, updated_at, status, metadata, multitask_strategy}` (same source). RFA's `runs` table (`src/engine.ts:77-94`) is `{run_id, thread_id, agent, status, kind, attempt, input_json, output_json, error, checkpoint_json, created_at, started_at, ended_at, cost_usd, num_turns}`: `agent` instead of `assistant_id`, no `updated_at`, no `metadata`, and `multitask_strategy` is a per-call argument (`src/engine.ts:136`) rather than a stored column. So a Postgres port writes fresh DDL; it does not copy a schema.

**The real cost is the API shape, not the DDL.** `better-sqlite3` is synchronous by design. From its API docs (<https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md>):

> "Transaction functions do not work with async functions." ... "Technically speaking, async functions always return after the first `await`, which means the transaction will already be committed before any async code executes." ... "Also, because SQLite serializes all transactions, it's generally a very bad idea to keep a transaction open across event loop ticks anyways."

Measured call-site count in this repo: `prepare(` appears **31 times in `src/engine.ts`, 15 in `src/memoryfs.ts`, 10 in `src/obs.ts`**, plus **5 `db.transaction(...)` blocks in `src/engine.ts`**. `node-postgres` is async. Converting means every store method returns a Promise, which propagates into `src/resident.ts`, `src/supervisor.ts`, `src/evals/*`, `src/main.ts` and the tests, and introduces a fresh class of await-ordering bugs in the per-thread mutex (`src/engine.ts:141-175`), which today is safe precisely because `db.transaction()` cannot be interleaved.

**One piece is genuinely non-mechanical**: `src/memoryfs.ts:246` `CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, content='facts', content_rowid='id')`. FTS5 has no Postgres equivalent; it becomes `tsvector` + a GIN index + a rewritten ranking query, and the recency x importance rerank has to be re-tuned.

**Postgres operational cost for a small team (postgresql.org, primary; current release is 18.6, dated 2026-08-13).**

From <https://www.postgresql.org/docs/current/pgupgrade.html>:

> "pg_upgrade allows data stored in PostgreSQL data files to be upgraded to a later PostgreSQL major version without the data dump/restore typically required for major version upgrades"
> "Make sure both database servers are stopped" ... "Obviously, no one should be accessing the clusters during the upgrade."
> "If you use link mode, the upgrade will be much faster (no file copying) and use less disk space, but you will not be able to access your old cluster once you start the new cluster after the upgrade. Link mode also requires that the old and new cluster data directories be in the same file system."
> "Many extensions and custom modules use shared object files (or DLLs) ... shared object files matching the new server binary must be installed in the new cluster, usually via operating system commands."
> statistics: run `vacuumdb --all --analyze-in-stages --missing-stats-only` then `vacuumdb --all --analyze-only`.

From <https://www.postgresql.org/docs/current/backup.html>: "three fundamentally different approaches to backing up PostgreSQL data": SQL dump, file system level backup, continuous archiving. Three approaches to choose among, versus `sqlite3 <db> .backup <out>` which `src/platform.ts:38` already does.

From <https://www.postgresql.org/docs/current/runtime-config-connection.html>: `max_connections` "The default is typically 100 connections" and "can only be set at server start"; "PostgreSQL sizes certain resources based directly on the value of `max_connections`. Increasing its value leads to higher allocation of those resources, including shared memory"; `superuser_reserved_connections` default is three.

**Decision: stay on SQLite, change the binding.** `node:sqlite` removes the native addon without changing the call shape. From <https://nodejs.org/api/sqlite.html>: "Stability: 1.2 - Release candidate", "Added in: v22.5.0", no longer behind `--experimental-sqlite` as of v23.4.0 / v22.13.0, "All APIs exposed by the `node:sqlite` module execute synchronously", WAL is settable (`db.exec('PRAGMA journal_mode = WAL')`), and `database.backup(sourceDb, path[, options])` exists. Classes/methods: `DatabaseSync`, `prepare`, `exec`, `run`, `get`, `all`, `iterate`, plus `Session` with `changeset()`/`patchset()`. **Open gate: whether the bundled SQLite has FTS5 compiled in.** UNVERIFIED: I did not confirm FTS5 availability in `node:sqlite`; spike S1 below settles it in ten minutes.

**Backups and snapshots, primary.** From <https://sqlite.org/lang_vacuum.html>: `VACUUM schema-name INTO filename` is "an alternative to the backup API for generating backup copies of a live database"; "The resulting backup database is minimal in size ... all deleted content is purged from the backup, leaving behind no forensic traces"; "The backup API uses fewer CPU cycles and can be executed incrementally"; "The file named by the INTO clause must not previously exist, or else it must be an empty file". From <https://sqlite.org/pragma.html>: `user_version` "is an integer that is available to applications to use however they want. SQLite makes no use of the user-version itself", which is the migration counter; `schema_version` is SQLite's own and must not be repurposed.

**Replication is not needed, and its cost is instructive.** Litestream (<https://litestream.io/how-it-works/>) "starts a long-running read transaction to prevent any other process from checkpointing" and then "continually reads new WAL pages and manually calls out to SQLite to perform checkpoints as necessary", shipping LTX files with monotonic TXIDs; restore "fetches the most recent snapshot that does not overshoot the requested restore point and then applies each subsequent LTX file in TXID order", and "Litestream replays whole LTX files and never applies part of one", with a 24 h default retention. It requires exclusive control of checkpointing, which conflicts with the repo's `sqlite3 .backup` habit and with any other checkpointer. Verdict: **defer**. A nightly `.backup` plus an off-box copy is the right size for an org self-hosting one hub; Litestream is the answer only if the RPO target drops below a day.

### E3. Multi-tenancy: one hub per org, rooms as the isolation unit

**The two candidate architectures.**

*A: one hub hosts rooms for several orgs.* Everything that is currently process-global would have to become scoped: human keys (`src/store.ts:62`), trusted card keys (`:58`), gate config (`src/main.ts:48`), the secrets file (`src/secrets.ts`), the workbench filesystem surface (`src/main.ts:139-254`), the obs store (every room's runs land in one `obs.db`, keyed only by `group_id`, `src/obs.ts`), and the backup (one tar of everything, `src/platform.ts:44-49`). Blast radius today, before any of that work: one leaked 12 h session token reads **every** room's pending approvals (`src/store.ts:1151-1200`), **every** agent definition (`src/main.ts:225-229`), and **every** run payload (`:255-266`). Wave 03 measured what that leaks in practice: the French Goodvest system prompt, whole draft documents, question and answer text.

*B: each org runs its own hub; rooms include remote guests.* Nothing new is needed except rec 8 (transport bearer) and per-room credentials for guests. A remote agent joins your room with a join secret (or, better, its own per-member credential), works the task board from its side, and never touches your workbench. Isolation between orgs is the isolation that already exists between rooms: opaque handle, membership token, per-room policies, per-room quarantine sets.

**Decision: B.** A is a product with a compliance surface; B is the current shape with the holes closed. State it in the spec so nobody builds A by accident.

**The one thing worth adopting from a real multi-tenant messaging server** is NATS's account boundary, because it names the property the four global configs lack. From <https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts>:

> "A account is an isolated tenant with its own subject space."
> "This is stronger than the permissions the previous page built. Permissions narrow what one user may do inside its account. An account boundary is absolute: the message doesn't cross it."
> "An account can also **export** a subject for another account to **import**. That's the one deliberate way to let a subject cross the boundary."

Applied to RFA: the room already is the account (absolute boundary), and guest membership already is the deliberate export. The mismatch is that human keys, trusted keys, gate config and the workbench sit **outside** any account. Recs 4, 6, 7, 16 and 17 pull them inside.

**And if federation is ever wanted, NATS's leaf node is the shape to copy, not Matrix's.** From <https://docs.nats.io/running-a-nats-service/configuration/leafnodes>: a leaf node "opens an _outbound_ connection to a remote NATS system and bridges subject interest across it"; "The leaf initiates the connection to a hub server; the hub never dials into the leaf"; default port 7422; the `credentials` field proves identity and the `account` field binds the traffic to one account; recommended "for edge deployments and separate administrative domains where inbound firewall rules are impossible but outbound connectivity exists". That maps exactly onto a smaller partner org whose network cannot accept inbound connections, and it needs no DAG.

### E4. Federation: what the spec reserved, and what a cross-hub room would really cost

**What the spec reserved.** `spec/RFA-0.1.md:769` (Appendix D, v0.2 backlog), verbatim:

> "federation (cross-hub rooms; reserve `search_id`, `max_depth`, `scope` per FIPA federated search)"

**Those fields are about propagating a directory SEARCH, not about replicating a room.** From the FIPA Agent Management Specification, SC00023 (local copy: `research/01-protocol/papers/fipa-sc00023-agent-management.pdf`), section 4.1.3 "Federated Directory Facilitators", verbatim:

> "When a DF receives a search action, it may determine whether it needs to propagate this search to other DFs that are registered with it. It should only forward searches where the value of the max-depth parameter is greater than 1 and where it has not received a prior search with the same search-id parameter. If it does forward the search action, then it must use the following rules:
> 1. It must not change the value of the search-id parameter when it propagates the search and the value of all search-id parameters should be globally unique.
> 2. Before propagation, it should decrement the value of the max-depth parameter by 1."

And:

> "The DF encompasses a search mechanism that searches first locally and then extends the search to other DFs, if allowed. The default search mechanism is assumed to be a depth-first search across DFs. For specific purposes, optional constraints can be used ... such as the number of answers (max-results). The federation of DFs for extending searches can be achieved by DFs registering with each other with fipa-df as the value of the type parameter in the service-description."

> "Some DFs may not support federated search, in which case the max-result, max-depth and search-id parameters have no effect."

Example constraint syntax, verbatim: `(search-constraints :max-depth 2)`.

So the reserved fields buy **federated discovery** ("does any hub I peer with have an agent that can do X?") at a cost of one propagation rule and a seen-set. They buy nothing toward a room whose log lives on two hubs. The Appendix D parenthetical conflates the two and should be split.

**What a cross-hub room costs, evidenced.** Matrix is the reference implementation of "one room, many servers". From <https://spec.matrix.org/latest/server-server-api/>:

- Request auth: an `Authorization: X-Matrix origin="...",destination="...",key="...",sig="..."` header over a canonical JSON object wrapping "method, target, origin, destination, and content", signed with the origin server's key.
- Key distribution: servers publish `verify_keys` at `/_matrix/key/v2/server`, "valid for signing federation requests made by the homeserver and for signing events", plus old keys for historical validation; a **notary** model at `/_matrix/key/v2/query/{serverName}` lets a server "corroborate the keys returned by a given notary server by querying other servers".
- Room state: "the state of a room is a map of (event_type, state_key) to event_id"; events name parents via `prev_events`; `auth_events` is "the set of events which give the sender permission to send the event"; when branches merge "a state resolution algorithm must be used to determine the resultant state", **varying by room version**.
- History repair: `/backfill` is "a server-to-server analog of the /messages client API"; `/get_missing_events` fills gaps by breadth-first traversal of parent references.
- Transport limits: transactions "can have at most 50 PDUs and 100 EDUs".
- Offline peers: "If the server fails to respond to this request, intermediate notary servers should continue to return the last response they received from the server".

**Why this is a rewrite of RFA's core, not a feature.** Three load-bearing RFA properties assume a single writer over a total order:

1. `seq` is a monotonic per-room integer assigned by the hub and used as **the** replay cursor (spec 2, `src/store.ts:2135`). A DAG has no single seq.
2. The hash chain is linear: `prev_hash` = JCS-SHA256 of the previous event, genesis = hash of the room handle (`src/store.ts:2136-2137`, spec 13). A DAG needs a merkle-DAG audit story instead.
3. `room_task claim` is atomic because one process owns the task map ("claim (atomic: exactly one claimant wins)", `src/hub.ts:344`). Across hubs, exactly-one-claimant is a consensus problem.

**Verdict: reject cross-hub rooms.** Guest membership gives the same user-visible result. If federated discovery is ever wanted, implement the FIPA rules above verbatim, and make hub-to-hub identity reuse what already exists: a JWS-signed hub card verified against a provisioned `kid -> public JWK` set (the exact mechanism RFA already implements for agent cards, `src/signing.ts`, spec 6.1), plus RFC 8693 token exchange for on-behalf-of (E7).

### E5. Where the hub runs, and what ships

**Disqualifiers first.**

Managed serverless is out. From the Cloud Run container runtime contract (<https://docs.cloud.google.com/run/docs/container-contract>):

> "It is an in-memory file system, so writing to it uses the instance's memory. Data written to the file system doesn't persist when the instance stops."
> "When a revision does not receive any traffic, it is scaled in to the minimum number of instances configured (zero by default)."
> request timeout: "your container must send a response within the time specified in the request timeout setting after it receives a request ... Otherwise the request is ended and a 504 error is returned"; idle connections time out at 10 minutes (VPC) / 20 minutes (internet).

The hub is a stateful, file-backed, long-polling server holding waiters in the heap. It is the wrong shape for that contract, and the room log would evaporate.

A single binary is out for now. From <https://nodejs.org/api/single-executable-applications.html>: "Stability: 1.1 - Active development"; "By default, only built-in modules can be loaded" (file system modules need `module.createRequire()`); `import()` does not work with `useCodeCache: true`; `useCodeCache` and `useSnapshot` "must be `false` for cross-platform SEAs"; and decisively, "**Native addons on Linux arm64**: If produced via postject on Linux arm64 Docker, addons will crash on `process.dlopen()`". `better-sqlite3` is a native addon. Rec 12 removes that blocker; revisit then.

A homebrew-core formula is not the primary channel. From <https://docs.brew.sh/Acceptable-Formulae>: "Upstream must identify the packaged version as stable and provide an immutable tag or release"; "An install step must not fetch code from a moving default branch or an unversioned, unchecksummed archive"; sources must be "verified with SHA-256"; not accepted: "Self-updating software (unless behavior can be disabled)", "Proprietary or binary-only software". All satisfiable. The reason to skip it is audience: the org self-hosting a hub runs Linux with a compose file, and a brew formula for a stateful server invites `brew services` as a supervisor, which is a worse launchd.

**What ships.**

1. **An OCI image.** `node:22-slim` base (or 24), the built `dist/`, `console/index.html`, and (until rec 12) `sqlite3` + `tar` for `src/platform.ts`. Non-root user. `VOLUME /data`. `ENTRYPOINT ["node","dist/main.js","--http","8790","--data","/data"]`. `--bind 0.0.0.0` is correct **inside** a container (the container's network namespace is the boundary), which means `src/main.ts:380`'s "REACHABLE OFF-HOST" warning needs a container-aware wording rather than a scary line in every log.
2. **A `compose.yaml`.** From the Compose Specification (<https://github.com/compose-spec/compose-spec/blob/main/05-services.md>): `restart: unless-stopped` "restarts the container irrespective of the exit code but stops restarting when the service is stopped or removed"; `healthcheck` takes `test` (list whose first item is `NONE`, `CMD` or `CMD-SHELL`), `interval`, `timeout`, `retries`, `start_period`, `start_interval`; and "Compose waits for healthchecks to pass on dependencies marked with `service_healthy`". Two services (hub, supervisor) with the supervisor `depends_on` the hub `condition: service_healthy`, one named volume for `/data`, one bind mount for `agents/` when the workbench surface is enabled.
3. **A systemd unit template**, because that is what a Linux org actually uses for boot persistence, and because it fixes the secrets story for free. From <https://systemd.io/CREDENTIALS/>: `LoadCredential=` "reads credentials from disk, AF_UNIX sockets, or propagates system credentials"; `LoadCredentialEncrypted=` "loads and automatically decrypts encrypted credentials before service activation"; `SetCredentialEncrypted=` "safely embeds encrypted credentials in unit files, even for sensitive information"; "Service credentials are accessible to service code as regular files, the path to access them is derived from the environment variable `$CREDENTIALS_DIRECTORY`"; "Access to credentials is restricted to the service's user", credential data "is not inherited by child processes", and with filesystem namespacing "credentials remain invisible to other services". That is strictly better than `data/secrets.json` (0600, warn-only) plus env injection (`src/secrets.ts:13-16`, `src/supervisor.ts:82-88`), and it costs a unit-file stanza.
4. **Keep the existing paths**: `npx tsx src/main.ts` for development, `npm i -g rfa-hub` for the CLI (`package.json` already declares `bin: {rfa-hub: dist/main.js}`), launchd plists for macOS operators.

**2026 expectation check, from a comparable self-hosted developer tool.** Gitea's official backup/restore docs (<https://docs.gitea.com/administration/backup-and-restore>) are refreshingly honest about the ops surface: one `gitea dump -c /path/to/app.ini` command producing `app.ini`, `custom/`, `data/`, `repos/`, `gitea-db.sql`, `log/`; "To ensure the consistency of the Gitea instance, it must be shutdown during backup"; and "There is currently no support for a recovery command", restore being a manual unzip-and-move plus a native DB restore plus `gitea admin regenerate hooks`. The 2026 bar for a self-hosted tool is therefore: a container image, a compose file, one dump command, a documented (even manual) restore, and a health endpoint. **RFA already exceeds Gitea on one axis**: its backup does not require a shutdown (SQLite `.backup` is online, `src/platform.ts:38`) and its restore procedure has actually been exercised (STATUS.md, 2026-08-17). Do not lose that in the packaging.

**If a second process is ever wanted** (rejected today), the routing requirement is session affinity, and nginx open source can do it as of 1.29.6. From <https://nginx.org/en/docs/http/ngx_http_upstream_module.html>: `ip_hash` "ensures that requests from the same client will always be passed to the same server except when this server is unavailable"; `hash key [consistent]` uses ketama so "only a few keys will be remapped to different servers when a server is added"; `sticky cookie|route|learn` enables affinity and, verbatim, "Prior to version 1.29.6, this directive was available only as part of commercial subscription".

### E6. The boring parts

**Does a room survive a hub restart? Yes, and it is tested.** `test/hub.test.ts:335` "persistence: rooms, tokens, and history survive a hub restart"; `test/hub.test.ts:415` "reply_by deadlines survive a hub restart (rebuilt from the log)"; `test/hub.test.ts:712` "tasks: survive a hub restart"; `test/moderation.test.ts:381` "moderation state survives a restart: quarantine, held, origin, approvals"; `test/governance.test.ts:196` "hash chain: every event links to the previous via JCS-SHA256, across restarts too". Mechanically: `loadFromDisk` (`src/store.ts:2202`) rehydrates rooms from `<handle>.meta.json`, replays `<handle>.ndjson` to restore `seq`, `chainHead` and `sentIds`, re-registers the membership tokens of present members (`:2259`), marks everyone offline until they call in (`:2247`), sets leases expired so `auth()` restores them on first call (`:2252`), and rebuilds `pendingReplies` from the log so `reply_by` timeouts survive (`:2279-2301`). What does NOT survive: floor state (deliberate, `:2236`), waiters and watchers (they are resolved and dropped by `close()`, `src/store.ts:303-310`), rate windows (`:2255`, a defect, E1 #5), the dedupe index (`:2225`, a defect, E1 #4), and console session tokens (`src/main.ts:141`, a nuisance).

**Upgrades without dropping live rooms.** Blue/green is impossible while the data dir is exclusive (`src/store.ts:317-360`; spec 3: "A hub instance MUST have exclusive ownership of its persistence store"), and it is not worth inventing. The honest design is a **drain**, and most of it already exists:

- On `SIGTERM`/`SIGINT` (`src/main.ts:110-117`) the hub calls `hub.close()`, which resolves every waiter with its current cursor and writes each room's meta.
- What to add: (a) stop accepting new sends/joins with `503` + `Retry-After` for the drain window, (b) make the meta write atomic (rec 1) so the drain cannot be the thing that corrupts a room, (c) close the HTTP server rather than letting in-flight long-polls die on socket close.
- The client side is already the transport's own model. MCP 2026-07-28 removed stream resumability: "A broken response stream loses the in-flight request; clients **MUST** re-issue it as a new request with a new request ID" (changelog, major change 9), and for subscriptions "the client **MUST** re-send `subscriptions/listen` to re-establish its subscriptions - the server holds no subscription state across reconnections" (subscriptions spec). RFA's interim `room_watch` binding already does replay-before-register (spec 11.2b, `src/store.ts` watch path), so a restart costs a watcher one re-registration and zero events.
- Publishable expectation: **a hub restart is lossless for room content and costs each peer one long-poll round trip.**

**Migrations.** Two mechanisms, both cheap:

- Room snapshots migrate by defaults-on-load today (`src/store.ts:2211`: `policies: { mode: "open", moderator: null, ...meta.policies }`), which is why v0.5.0 migrated the standing room in place without downtime (STATUS.md). Add `meta_version: <int>` and refuse to load a snapshot whose version is newer than the binary. With several operators on possibly different versions, silent downgrade-eats-newer-snapshot is a real failure mode.
- SQLite files get `PRAGMA user_version` plus an ordered migration list. `user_version` is exactly the intended tool: "an integer that is available to applications to use however they want. SQLite makes no use of the user-version itself" (sqlite.org/pragma.html). Do not use `schema_version`, which SQLite owns.

**Health checks.** There is no standard: `draft-inadarei-api-health-check-06` ("Health Check Response Format for HTTP APIs") was published 16 October 2021, intended status Informational, and **expired 19 April 2022** without becoming an RFC. So ship a plain `GET /healthz` with a small JSON body and a non-zero exit path for the Compose `test` command. Keep it unauthenticated but content-free about rooms: `{ok, version, uptime_s, rooms: <count>, lock_ok, data_dir_writable, corrupt_rooms: <count>}`. `corrupt_rooms > 0` is how rec 1's refuse-to-load becomes visible instead of a lost stderr line.

**Backups.** Keep the existing nightly `.backup` + tar (`src/platform.ts`), which has been exercised end to end (STATUS.md restore procedure, verified 2026-08-17). Three changes: use `database.backup()` from `node:sqlite` instead of shelling to the `sqlite3` CLI (removes an image dependency); make the destination a configured path rather than `$HOME/Backups` (`src/supervisor.ts:344`) so a container can mount it; and copy off-box. `VACUUM INTO` is the alternative when a compact, forensically clean copy matters ("all deleted content is purged from the backup, leaving behind no forensic traces", sqlite.org/lang_vacuum.html), at the cost of more CPU and no incrementality.

### E7. Operator-facing multi-user concerns

**The gap is identity, not roles.** `role` is already per-membership (`src/store.ts:133`, spec 5.2), so "Alice supervises room A and only observes room B" is expressible today. What does not exist is **which human**. Two code paths make this concrete:

- `resolveOrigin` (`src/store.ts:464-470`) maps any member of `humanKeys` to `origin: "human"` and throws `join_denied` otherwise. Possession of any provisioned key is the whole principal model. Spec 4.2 states this deliberately: "Possession of a provisioned key IS the principal class".
- `consoleMembership` (`src/store.ts:1203-1219`) finds or mints **one** membership named `console` per room with `origin: "human", role: "supervisor"`, and every `/api/approvals/decide` call goes through it (`src/main.ts:293-301`). So two humans approving two different Linear writes produce two `intervention` events with the same actor.

**The fix, sized.** Replace `humanKeys: string[]` with a small record type loaded from a file (never argv: STATUS.md already records finding a human key sitting in `ps aux`):

```jsonc
// data/principals.json, 0600 or a systemd credential
[ { "principal_id": "p_paul", "label": "Paul B", "key_sha256": "…", "rooms": { "r_9a25e48c0e": "supervisor", "*": "observer" } } ]
```

Compare with `crypto.timingSafeEqual` over the SHA-256 (fixes the non-constant-time `includes` at `src/main.ts:215` at the same time), stamp `principal_id` on the `Member` and on every `intervention` and approval decision, mint `console-<principal_id>` memberships, and put a per-IP attempt limit on `/auth`. That is one file, one compare, one field on three event shapes.

**The console must not become an identity provider.** Two supported modes, both boring:

1. **Per-human key** presented once at `POST /auth`, which already mints a 12 h sliding session token (`src/main.ts:213-221`). Add an absolute cap and a revoke path (wave 03 already specified this).
2. **Trusted proxy assertion**: the operator runs whatever SSO they already have in front of the hub, and the hub verifies a signed assertion (JWT against a configured JWKS) and maps a claim to a `principal_id`. Wave 03 documented the concrete instance (Cloudflare Access's RS256 `Cf-Access-Jwt-Assertion` verified against a published JWKS, with service tokens for machine clients) and the concrete trap (a header injected by a proxy is only trustworthy if nothing else can reach the port, denoland/clawpatrol#316).

Building an OAuth 2.1 authorization server inside the hub stays rejected, and wave 03's reason still holds: MCP requires audience-bound tokens ("MCP servers **MUST** validate that access tokens were issued specifically for them as the intended audience, according to RFC 8707 Section 2", <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>) and the leading self-hostable AS could not satisfy RFC 8707 as of that wave.

**When cross-org delegation eventually needs a wire format, it exists.** RFC 8693 (OAuth 2.0 Token Exchange, January 2020, Standards Track, <https://www.rfc-editor.org/rfc/rfc8693.html>): `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, request parameters `resource`, `audience`, `scope`, `requested_token_type`, `subject_token` (REQUIRED), `subject_token_type` (REQUIRED), `actor_token`, `actor_token_type` (REQUIRED if `actor_token` present); token type URNs `urn:ietf:params:oauth:token-type:access_token` / `refresh_token` / `id_token` / `saml1` / `saml2`; and the delegation claims:

```json
{ "sub": "user@example.com", "act": { "sub": "admin@example.com" } }
{ "sub": "user@example.com", "may_act": { "sub": "admin@example.com" } }
```

`act` expresses "that delegation has occurred and identify the acting party to whom authority has been delegated"; `may_act` expresses "that one party is authorized to become the actor and act on behalf of another party". That is the right shape for "another org's agent acts on behalf of a named human in my org", and it is spec 4.2's T1 text already. Do not invent an alternative.

**And the machine-to-machine half now has an official MCP home.** The MCP authorization extensions repository (<https://github.com/modelcontextprotocol/ext-auth>) lists exactly two: **Enterprise-Managed Authorization** (stable) and **Client Credentials** (draft, `specification/draft/oauth-client-credentials.mdx`). The draft's shape, verbatim:

```
POST /token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer
&client_assertion=[signed JWT]
&resource=[URL-encoded resource URI]
&scope=[requested scopes]
```

with the client-secret variant using `client_id` + `client_secret`, client identification via the JWT's `sub` claim, and the stated purpose "machine-to-machine authentication without user interaction". Note also that DCR is now deprecated: MCP 2026-07-28's changelog "Deprecate the OAuth 2.0 Dynamic Client Registration Protocol" in favour of Client ID Metadata Documents (`draft-ietf-oauth-client-id-metadata-document-00`), and clients "**MUST** key persisted credentials by the issuer identifier, **MUST NOT** reuse them with a different authorization server, and **MUST** re-register when the authorization server changes" (SEP-2352).

### E8. Availability when other orgs' agents depend on your hub

**The posture, stated rather than measured.** No SLA. Publish three sentences in the README and in the room's topic metadata: (1) the hub is operated best-effort by one team; restarts are routine and lossless for room content; expect minutes, not seconds, of recovery. (2) Peers must retry idempotent calls with bounded jitter and must honor `retry_after_s`. (3) A hub that cannot be reached means "presence unknown", not "peers gone": re-listen from your last cursor when it returns and the log will tell you everything you missed.

**Why that is honest and not lazy.** The transport already assumes it. MCP 2026-07-28 removed SSE resumability and message redelivery: "A broken response stream loses the in-flight request; clients **MUST** re-issue it as a new request with a new request ID". And RFA's own design principle 3 ("Durable append is delivery") means an outage delays turns, it does not lose them, provided the log write already happened.

**What must change in the protocol, minimally.**

1. **A `hub_unavailable` error code** carrying `retry_after_s` (the error object already has the field, spec 15), plus HTTP `503` + `Retry-After` from the transport during drain. The HTTP semantics are RFC 9110's (503 Service Unavailable; `Retry-After` takes either an HTTP-date or delay-seconds). UNVERIFIED: I could not fetch RFC 9110 sections 10.2.3 and 15.6.4 verbatim (both fetch attempts returned truncated content); the two-format `Retry-After` and the transient-condition semantics of 503 are stated from prior knowledge and should be quoted from the RFC before the spec text is written.
2. **A client retry obligation in spec 9.5**, because `src/client.ts:597-627` is a single unguarded `fetch`: bounded exponential backoff with jitter for `room_listen`, `room_roster`, `agent_describe`, and for `room_send` **only** once idempotency survives restart (rec 2). Without rec 2, telling peers to retry sends is telling them to duplicate messages.
3. **Restart-durable idempotency** (rec 2). This is the single change that makes "just retry" safe.
4. **An optional task `claim_ttl_s` and a `task_released` system event** (rec 23). Today `claim` sets an owner permanently; if a remote org's agent claims a task and dies, `reply_by` produces `task_overdue` (`src/store.ts:1942-1956`) and nothing else. With remote workers whose runtime you cannot see or restart, an expiring claim is the difference between a self-healing board and a board that needs a human every time a peer crashes. Precedent for the state vocabulary is already in the design: A2A's `TaskState` includes `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`, `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`, `TASK_STATE_REJECTED` (<https://a2a-protocol.org/latest/specification/>, latest released version 1.0.0), and RFA already maps to it.

**What must NOT change.** No peer-to-peer fallback, no client-side outbox, no broker. The room log is the outbox. And the idempotency-key header is not the answer at this layer: `draft-ietf-httpapi-idempotency-key-header-07` was published 15 October 2025, Standards Track intended, and **expired 18 April 2026**. RFA's `message_id` already is the key; it just has to survive a restart.

**One more availability-adjacent gap worth recording**: `src/client.ts` has no `Authorization` header path at all, so rec 8 (transport bearer) and rec 24 (retry) are the same commit.

---

## What RFA already solves (do not redesign)

| Concern | Already solved | Where |
|---|---|---|
| Rooms survive a hub restart | Snapshot + log replay rehydrates rooms, tokens, tasks, approvals, quarantine, chain head, and rebuilds `reply_by` deadlines from the log | `src/store.ts:2202-2307`; tests `test/hub.test.ts:335, 415, 712`, `test/moderation.test.ts:381`, `test/governance.test.ts:196` |
| Two hubs cannot corrupt one store | Liveness-checked lockfile that fails loudly and names the fix | `src/store.ts:312-349`; spec 3 ("MUST fail loudly on a contended store"); e2e scenario "hub boot + exclusive-store lockfile" (`scripts/e2e.ts:200`) |
| Horizontal-scale-friendly protocol | No MCP sessions; cross-call state rides in server-minted handles as ordinary tool arguments | spec 3; MCP 2026-07-28 changelog major change 1 |
| Tamper-evident audit across restarts | `prev_hash` = SHA-256 over the RFC 8785 canonical form of the previous event, genesis = hash of the room handle, verifiable offline | `src/store.ts:2134-2137`, `src/jcs.ts`; spec 13 |
| Loopback-by-default binding, Origin allowlist, tokened reads | Fixed in v0.5.0 after wave 03 found the hub on the LAN | `src/main.ts:157-176, 321-326, 374-381` |
| Human-only authority for approvals and quarantine release | `origin: "human"` requires a provisioned key; agents cannot self-promote to supervisor | `src/store.ts:444-446, 464-470`; spec 4.2, 5.2 |
| Console decisions ride the ordinary room machinery | The workbench mints a supervisor membership and calls `hub.admin`, so decisions are normal audited interventions | `src/store.ts:1203-1219`, `src/main.ts:287-302` |
| Secrets declared by name, resolved at spawn, never in `agents/` | Packs declare names; only those values are injected | `src/secrets.ts`, `src/supervisor.ts:81-88`; 0.4 spec 6.3 |
| Backup and a *rehearsed* restore | Online `.backup` of every DB + tar of the state dirs, 7-day rotation; restore exercised 2026-08-17 | `src/platform.ts`, `src/supervisor.ts:340-350`; STATUS.md |
| Versioned redeploy of a resident without room disruption | Validate the new `agent.md` first, then SIGTERM/drain/respawn; the rotated card digest in the roster is the deploy marker | `src/supervisor.ts` drain path; 0.4 spec 4.2 |
| Watcher gap-free re-registration | `room_watch` replays matching events after `since` before registering | spec 11.2b; `src/hub.ts:414-445` |
| Enum vocabulary aligned with LangGraph | `RunStatus`, `ThreadStatus`, `MultitaskStrategy` match `langgraph_sdk/schema.py` character for character | `src/engine.ts:17-19` |
| Blast-radius controls exist as policy | per-sender rpm, `max_pending_requests`, `max_mentions`, `max_members`, payload cap | `src/store.ts:101-128, 786-799`; spec 9.1, 14.7 (but see E1 #5: they reset on restart) |

**Genuinely wrong for cross-org use, bluntly:**

- `src/main.ts:327-330` - the MCP plane is unauthenticated, so `room_create` (`src/hub.ts:163`) is an open resource-creation primitive to anything that can reach the port.
- `src/store.ts:1151-1200` + `src/main.ts:224-302` - the workbench is hub-scoped, so one session token crosses every room. This is what makes a multi-org hub unsafe by construction.
- `src/store.ts:2199` + `:2303-2305` - a torn snapshot silently deletes a room at boot.
- `src/store.ts:742-743` + `:2225` - idempotency does not survive the restart it exists to protect against.
- `src/store.ts:62` + `:464-470` + `:1203-1219` - the hub cannot say which human approved anything.
- `src/store.ts:384` - one shared join secret per room is the wrong credential granularity when members belong to different organizations.

---

## Open questions and spikes

| # | Question | Cheapest spike that settles it | What would change my mind |
|---|---|---|---|
| S1 | Does `node:sqlite` ship FTS5? | `node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec(\"CREATE VIRTUAL TABLE t USING fts5(x)\");console.log('fts5 ok')"` (10 min) | If FTS5 is absent, `src/memoryfs.ts` keeps `better-sqlite3` while `engine`/`obs` move, or the fact search falls back to `LIKE` + the existing recency x importance rerank at this corpus size |
| S2 | Is the torn-snapshot room loss real, and does rename fix it? | Kill -9 the hub mid-`writeMeta` (patch a 200 ms delay into `writeMeta` behind an env var), restart, observe the room vanish; repeat with temp+rename (1 h) | If Node's `writeFileSync` turns out to be atomic on the target filesystem for a 49 KB payload (it is not, but measure), rec 1 shrinks to the refuse-to-load half |
| S3 | Does a restart really duplicate a retried send? | Send `message_id=X`, restart the hub, resend `X`, count message events in the NDJSON (20 min) | Nothing; if it does not duplicate, I have misread the dedupe path and rec 2 is void |
| S4 | What does the in-RAM log actually cost at 10x? | Synthesise 10,000 events into a room file, boot, measure RSS and boot time (1 h) | If boot stays under a second and RSS under 100 MB at 10x, rec 3 drops from "day" to "when it hurts" |
| S5 | Does a container-run hub break the `--bind` warning and the workbench filesystem assumptions? | Build the image, run with `--bind 0.0.0.0 --data /data`, mount `agents/`, exercise console auth + one approval (half day) | If the workbench cannot work without the repo checkout mounted, rec 6 becomes mandatory rather than nice |
| S6 | Can `tailscale serve`/a reverse proxy sit in front of a containerised hub without breaking the Origin/Host allowlist? | Run the image behind the proxy, log the `Origin` and `Host` actually seen (2 h; wave 03 flagged this as unmeasured) | If the proxy rewrites `Host` to the loopback target, the allowlist config shape changes |
| S7 | Does a per-member bearer at the transport break Claude Code / other MCP hosts as clients? | Add the check behind a flag, register the hub with `--header "Authorization: Bearer …"`, run the e2e suite (half day) | If a host cannot send static headers, rec 8 needs a per-room credential in the tool arguments instead of the transport |
| S8 | How long does a full drain actually take, and what does a peer observe? | Instrument `close()`, restart under a live `room_listen` from two clients, measure the observed gap (2 h) | If the gap exceeds a few seconds, the drain needs work before the "one round trip" claim can be published |
| S9 | Is `claim_ttl_s` the right shape, or does an explicit heartbeat-on-task fit better? | Prototype both against one remote-agent scenario (day) | If remote peers already renew presence while working, a task claim could inherit the presence lease instead of carrying its own TTL, which is simpler |
| S10 | Are there two hubs to federate? | Ask. Until the answer is yes, rec 15/16 stay parked | A second org standing up its own hub and wanting capability discovery across the pair |

**Explicitly out of scope for this dimension** (owned by the wave's other dimensions, flagged so nothing falls between): the per-message signature profile and T2 message signing; the REST binding's normative text; tool passthrough; the remote-agent onboarding UX and capability-card exchange; contract-net auctions. This dimension's only claim on them is that **rec 8 (transport credential) and rec 4 (principal identity) are prerequisites** for any of them to mean anything across an organizational boundary.

---

## Sources

Primary, fetched or read on 2026-08-17 unless dated otherwise.

**Repo (read directly, working tree at `02025de`)**: `src/store.ts`, `src/main.ts`, `src/hub.ts`, `src/engine.ts`, `src/obs.ts`, `src/memoryfs.ts`, `src/supervisor.ts`, `src/secrets.ts`, `src/platform.ts`, `src/client.ts`, `spec/RFA-0.1.md` (0.1.7, dated 2026-08-16), `spec/RFA-0.4-platform.md`, `STATUS.md`, `test/hub.test.ts`, `test/moderation.test.ts`, `test/governance.test.ts`, `scripts/e2e.ts`, `package.json`, `deploy/`. Live measurements: `data/rooms/r_9a25e48c0e.ndjson` 897,126 B, `data/rooms/r_9a25e48c0e.meta.json` 49,138 B, `data/runs.db` 64 KB, `data/obs.db` 225 KB.

**SQLite**: <https://www.sqlite.org/wal.html> · <https://www.sqlite.org/whentouse.html> · <https://sqlite.org/hctree/doc/begin-concurrent/doc/begin_concurrent.md> · <https://sqlite.org/lang_vacuum.html> · <https://sqlite.org/pragma.html>

**Node.js**: <https://nodejs.org/api/sqlite.html> (Stability 1.2, added v22.5.0) · <https://nodejs.org/api/single-executable-applications.html> (Stability 1.1) · <https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md>

**PostgreSQL 18.6 (2026-08-13)**: <https://www.postgresql.org/docs/current/backup.html> · <https://www.postgresql.org/docs/current/pgupgrade.html> · <https://www.postgresql.org/docs/current/runtime-config-connection.html>

**MCP 2026-07-28**: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization> · <https://github.com/modelcontextprotocol/ext-auth> · <https://raw.githubusercontent.com/modelcontextprotocol/ext-auth/main/specification/draft/oauth-client-credentials.mdx> · local spec copies `research/01-protocol/papers/mcp-2026-07-28-changelog.mdx`, `-streamable-http.mdx`, `-subscriptions.mdx`

**OAuth / IETF**: <https://www.rfc-editor.org/rfc/rfc8693.html> (Token Exchange, January 2020, Standards Track) · RFC 8707, RFC 9728, RFC 9207, `draft-ietf-oauth-v2-1-13`, `draft-ietf-oauth-client-id-metadata-document-00` (all as normatively referenced by the MCP authorization spec above) · `draft-ietf-httpapi-idempotency-key-header-07` (15 Oct 2025, **expired** 18 Apr 2026) · `draft-inadarei-api-health-check-06` (16 Oct 2021, Informational, **expired** 19 Apr 2022)

**Federation / multi-tenancy**: <https://spec.matrix.org/latest/server-server-api/> · FIPA SC00023 Agent Management Specification, section 4.1.3 (local: `research/01-protocol/papers/fipa-sc00023-agent-management.pdf`) · <https://docs.nats.io/running-a-nats-service/configuration/securing_nats/accounts> · <https://docs.nats.io/running-a-nats-service/configuration/leafnodes> · <https://a2a-protocol.org/latest/specification/> (latest released 1.0.0)

**Deployment / ops**: <https://github.com/compose-spec/compose-spec/blob/main/05-services.md> · <https://systemd.io/CREDENTIALS/> · <https://docs.cloud.google.com/run/docs/container-contract> · <https://docs.brew.sh/Acceptable-Formulae> · <https://nginx.org/en/docs/http/ngx_http_upstream_module.html> · <https://docs.gitea.com/administration/backup-and-restore> · <https://litestream.io/how-it-works/>

**LangGraph (for the schema-verbatim claim)**: <https://raw.githubusercontent.com/langchain-ai/langgraph/main/libs/sdk-py/langgraph_sdk/schema.py> · <https://reference.langchain.com/python/langgraph-sdk/schema/Run/>

**Prior waves (internal, not counted as external sources)**: `research/02-platform/REPORT.md` + `notes/10-engines-deployment.md`; `research/03-reach-and-collaboration/REPORT.md` + `notes/01-remote-reach.md`.
