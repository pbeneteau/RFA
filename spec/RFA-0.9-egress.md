# RFA v0.9: Egress and the declared surface

**Platform specification, version 0.9.0 (PROPOSAL)**
Status: Accepted 2026-08-29 · License: Apache-2.0 (see LICENSE)
Depends on, and does not supersede: the wire protocol ([spec/RFA-0.1.md](RFA-0.1.md), 0.1.9 draft), [RFA-0.4](RFA-0.4-platform.md), [RFA-0.5](RFA-0.5-platform.md), [RFA-0.6](RFA-0.6-remote.md), [RFA-0.7](RFA-0.7-cli.md) and [RFA-0.8](RFA-0.8-concurrency.md), all of which stay in force in full. Two dependencies are explicit rather than incidental: RFA-0.8 sect. 9 (the two-door write fence) is the mechanism this document extends, and v0.4 sect. 3.12 (a resident's tools are its declaration) is the doctrine it completes.
Amends and extends: **RFA-0.8 sect. 9** (the fence's coverage predicate, and door one's handling of the sandbox's own decisions), **v0.4 sect. 3.2** (`sandbox.network`, `sandbox.allowed_domains`, `sandbox.cwd` and `offers`), **v0.4 sect. 3.12** (the enforcement mechanisms gain a named boundary), **RFA-0.7 sects. 3.2, 3.6, 3.8 and 3.9** (this document's 4.6, 5.2, 8.2 and 10.1 change `rfa agent new`, `rfa agent show`, `rfa connect`, `rfa status` and `rfa doctor`).

**Section numbering.** This document always writes "v0.4 sect. N", "v0.5 sect. N", "RFA-0.6 sect. N", "RFA-0.7 sect. N", "RFA-0.8 sect. N", "spec N" (the wire protocol), or "W6 sect. N" (the research report); a bare number means this document. Sections that amend earlier documents say so in the heading, in the form *amends v0.N sect. M*.

Evidence: design context is [research/06-agent-fabric/REPORT.md](../research/06-agent-fabric/REPORT.md), cited as **W6 sect. N**. That wave is a landscape comparison of vendor material, not a measurement, and nothing normative here rests on it alone; it is cited only for provenance and for the rejected alternatives in Appendix A. Everything load-bearing rests instead on twelve live probes run on 2026-08-29 against `@anthropic-ai/claude-agent-sdk` 0.3.233 (claudeCodeVersion 2.1.233) and `@anthropic-ai/sandbox-runtime` 0.0.73 on darwin-arm64, cited as **E1** to **E12** and recorded in Appendix D. Claims about current repository behavior were checked against the code at commit `f0dff8e`; file anchors drift, so re-resolve them rather than trusting them.

**Implementation-status markers: this document carries none, deliberately.** It moves no wire Appendix F row (8.3), so per-requirement status is recorded on the STATUS.md rung line that names the requirement number, and nowhere else. The reasons are the ones RFA-0.8's header gives at length.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are as in RFC 2119.

---

## 1. What this document is for

RFA has spent five specifications making a pack's declaration true: which tools it may call, which turns it may run at once, where it may write. This document extends the same doctrine to what a pack may **reach**, and closes the places where the declaration and the reality have come apart.

It exists because a comparison against a shipping enterprise product (W6) found RFA ahead on runtime containment and behind on one thing that product does well: nothing in RFA *declares* an outbound network policy, while two settings claim to.

### 1.1 The findings that forced it

1. **Two settings parse and do nothing.** `sandbox.network` and `sandbox.allowed_domains` have zero readers anywhere outside their own schema line, and `rfa agent new` writes `network: none` into every generated pack, beside two settings that *are* read.
2. **Egress is decided today, by accident, in a branch written for something else.** E10 measured what actually happens on a fenced run: the OS sandbox routes each outbound host to `canUseTool` as a synthetic tool call, `SandboxNetworkAccess {"host": "..."}`. A resident denies it, but only because it is an unrecognized name with no `interrupt_on` rule and so falls into door one's catch-all, which answers `tool SandboxNetworkAccess is not allowed for this pack`. The confinement is real and nobody designed it, nothing declares it, the log line does not say what was refused, and one `interrupt_on` pattern or one pre-approval turns it into an allow (E10a: with an allowing callback the same request returned `HTTP:200`).
3. **A pack can hold a command surface with no fence at all.** Door two attaches only when a pack declares a guarded built-in (`Write`, `Edit`, `NotebookEdit`). A pack declaring `Bash` and not those gets no OS sandbox, and its `Bash` is pre-approved in `allowedTools`, so it never reaches door one either. It therefore has no egress decision at all, not even the accidental one.
4. **The platform's own model calls are outside its containment doctrine.** The consolidation and reflection lane runs `query()` with no `tools` restriction, no `canUseTool`, no sandbox and no connector suppression, with a working directory of the hub root, on untrusted room episodes. E9 measured its tool surface: `Write` is refused and a `Bash` redirection outside the working directory is blocked, but **`Read` inside the working directory is auto-approved and returns file contents**, and `.rfa/secrets.json` is inside that surface. E12 then measured the same read under the lane's production `maxTurns: 1`: the read executes and the file's contents enter the model's context, after which the lane errors `error_max_turns` and `llmOnce` throws.
5. **The fence stops at the SDK's process, and nothing said so.** E5 measured a stdio MCP server, spawned by the SDK for a fenced query, reaching a host the sandbox denied to `Bash` in the same run and writing a file outside the run's allow root that was still there afterwards.

Findings 2 to 5 were discovered while grounding finding 1. They are here because a specification that said "egress is confined at door two" while door two does not exist for command-only packs, does not cover MCP servers, does not apply to the platform's own calls, and rests on a catch-all branch nobody wrote for it, would be the exact defect this project has now paid for five times.

### 1.2 Division of labor

| Concern | Where |
|---|---|
| What crosses the wire between members | The wire protocol. This document proposes no wire delta (8.3) |
| Which turns a pack may run at once | RFA-0.8 sects. 10 and 11 |
| Where a run may write | RFA-0.8 sect. 9, as amended by 3 below |
| What a run may reach on the network | This document, sects. 3 to 5 |
| Which tools a pack may call | v0.4 sect. 3.12, as extended by 3.1 and 7 |
| Who a pack acts as against a third-party system | This document, sect. 9, which records a non-goal |
| Testing obligations | 12, which is working rules, not spec text |

---

## 2. The measured ground

Every claim in the table is measured. Where a consequence below rests on vendor documentation rather than on a probe it says so at the point of use, and where a type definition contradicts a measurement the measurement governs and the contradiction is named.

| # | What was run | Result |
|---|---|---|
| **E1** | Sandbox enabled, no `network` key, **no `canUseTool`**, `Bash` curl to a public host | **Denied**, reason `(user denied)` |
| **E2** | `network: {allowedDomains: ["api.anthropic.com"], strictAllowlist: true}`, no callback, curl a host not on the list | **Denied**, reason `(host is not on the allow list)` |
| **E3** | Same allowlist, `strictAllowlist` **omitted** | **Denied**, reason `(user denied)` |
| **E4** | `{allowedDomains: ["example.com"], strictAllowlist: true}`, curl that host | **Allowed**, `HTTP:200` |
| **E5** | E2's policy plus a **stdio MCP server** whose tools fetch the denied host and write outside the allow root | **Both succeeded**; the file was on disk afterwards |
| **E10a** | Sandbox enabled, no `network` key, **`canUseTool` installed and allowing** | **Allowed**, `HTTP:200`. The callback received `SandboxNetworkAccess {"host":"example.com"}` |
| **E10b** | Same, callback denying an unrecognized name (a resident's actual semantics) | **Denied**, reason `(user denied)` |

Six consequences, each of which a requirement below turns on:

1. **The per-`query()` `sandbox` option does confine network** (E2, E4). The SDK folds it into the `--settings` flag tier, one of the three tiers `strictAllowlist` names as honored. The `Options.sandbox` doc comment saying "Filesystem and network restrictions are configured via permission rules, not via these sandbox settings" is, for the sandboxed-command path on this version, wrong. Nothing here rests on either doc sentence; it rests on the probes, and 10.2 re-proves them.
2. **With no network policy, the sandbox asks, and door one answers.** E10a and E10b are the same configuration with two callbacks and opposite outcomes. So the confinement a fenced pack has today is not a policy: it is door one's catch-all deny reached by a name nobody classified. That is why 4.7 makes it an explicit branch driven by the declared posture, and why consequence 3 matters more than it looks.
3. **`strictAllowlist` is the difference between a policy and an accident** (E2 versus E3, and E10a versus E10b). Without it the denial reason is `user denied`: the request reached the ask path and was resolved by whoever happened to answer. That is a property of the deployment, and E10a shows it resolving as an **allow** under a callback that says yes. The platform MUST NOT rest a security property on who answers.
4. **The allowlist is real** (E4).
5. **The sandbox ends at the SDK's own process** (E5). A stdio MCP child is outside it, for network and for filesystem.
6. **What today's packs actually have, stated without generalizing.** A pack declaring a guarded built-in gets door two and, through consequence 2, an accidental deny for `Bash` egress. A pack declaring `Bash` and no guarded built-in gets neither. A pack's MCP servers are outside all of it, measured (E5). A `reach` built-in is outside it too, but that half is **read, not measured**: it rests on one SDK doc sentence, "Enforced for sandboxed commands only - in-process tools such as WebFetch are not gated by this setting", which names `WebFetch` and not `WebSearch`, and no probe here exercises either (Appendix B item 10). No pack on any instance has ever had a declared egress policy, because no code reads the field that would declare one.

---

## 3. What a pack may declare, and what the fence covers (amends RFA-0.8 sect. 9, v0.4 sect. 3.12)

RFA-0.8 sect. 9 attaches the fence to a **writing pack**, `hasWriteSurface()`: a pack declaring one of `Write`, `Edit`, `NotebookEdit`. That predicate is correct for the property sect. 9 protects and too narrow for this one.

**3.1 Classification.** The platform MUST classify every built-in it is willing to pre-approve, in one exported table. Classification matches on the tool **head**, the substring before the first `(`, so a specifier form classifies with its base tool, exactly as `toolsSchema`'s existing `entry.split("(")[0]` already does.

| Class | Members today | What it can do | Fence consequence |
|---|---|---|---|
| `guarded` | `Write`, `Edit`, `NotebookEdit` | Writes to a path nameable in its arguments | Door one's path guard, per RFA-0.8 sect. 9. Kept out of `allowedTools` |
| `command` | `Bash` | Executes a process; effects untraceable from arguments | Door two, its only door |
| `reach` | `WebFetch`, `WebSearch` | Network I/O in the SDK's own process | **Neither door.** 5.3 |
| `read` | `Read`, `Grep`, `Glob` | Unconfined read across the resident process's whole filesystem view, not merely the session surface | Pre-approvable, with 3.5's rendering |
| `subagent` | `Agent`, `Task` | Spawns a child run | Pre-approvable only with `tools.allow_subagents: true` (wire 18.7). Whether a child inherits the parent query's `sandbox` and `tools` is **unmeasured**; 10.2 must establish it and Appendix B item 8 records that it is not asserted |

**3.2 Unclassified names are refused.** A `tools.allow` entry whose head is neither a classified built-in nor an `mcp__<server>__<tool>` name whose `<server>` is declared in `mcp_servers` or is platform-owned (`rfa`, `memory`) MUST be **refused at definition load**, naming the entry and the reason. The grammar is `<Builtin>`, `<Builtin>(<specifier>)`, or `mcp__<server>__<tool>`. Today an arbitrary string, an empty string, a duplicate, and an `mcp__` name for an undeclared server all parse and land verbatim in the SDK's base tool set. Refusing is the fail-closed reading, and it has a second purpose: a future SDK built-in that executes processes or reaches the network cannot enter a pack's pre-approved set by being unclassified. The table MUST be maintained across SDK bumps, and Appendix B item 5 records that this is a real cost.

**3.3 The coverage predicate.** The fence attaches to a run whenever the pack declares any built-in of class `guarded` or `command`. That predicate, not `hasWriteSurface()`, MUST govern whether door two is established, whether a run scratch directory is minted, and whether the resident's startup fence checks run and fail closed.

**3.4 A command-only pack.** A pack of class `command` with no guarded built-in gets door two with the same filesystem policy a writing pack gets: `allowWrite` is this run's `scratch/<runId>`, the run's working directory is that scratch surface, `allowUnsandboxedCommands` is false. It does not get door one's path guard, because it declares nothing door one can guard.

**3.4b `sandbox.cwd` is constrained on every pack, not only a fenced one.** `sandbox.cwd` is read into a resident's working directory with no constraint on where it may point, so `cwd: "."` puts a resident's working directory at the hub root, where `.rfa/secrets.json` sits and where `Read` is auto-approved before door one runs (E9). The platform MUST require `sandbox.cwd` to resolve inside the pack directory and MUST refuse it otherwise at definition load, naming the read-surface reason. On a fenced pack it is additionally **not in force**, because a fenced run's working directory is its scratch surface; the platform MUST refuse it there rather than silently overriding it. Nothing in `templates/` or the scaffold writes the key today, so neither refusal breaks an existing pack.

**3.5 What a `read` pack is told about itself.** `Read`, `Grep` and `Glob` are pre-approved as bare `allowedTools` entries, which by this project's own measured doctrine auto-approves them before door one runs. Read inside the working directory never reaches the callback at all, so the surface a `read` pack holds is decided entirely by where that directory points, which is what 3.4b constrains. `rfa agent show` and `rfa doctor` MUST render a pack declaring a `read` built-in as holding an unconfined read surface, naming it as such. Narrowing that surface is not specified here (Appendix A).

**3.6 The prose that must move with it.** RFA-0.8 sect. 9 item 2 and CLAUDE.md both read "door two is the ONLY door for Bash". That is a statement of mechanism and is read as one of coverage. Both MUST be amended in the same change to say that door two is the only door for `Bash` **and that a pack declaring `Bash` is fenced for that reason**, which is 3.3.

---

## 4. The network posture (amends v0.4 sect. 3.2)

`sandbox.network` and `sandbox.allowed_domains` exist in the schema, are published by v0.4 sect. 3.2 as `none | allowlist | open   # open requires room_admin override`, and are read by nothing.

**4.1 Scope, stated before the semantics.** A pack's network posture governs **its sandboxed command surface**: built-ins of class `command`, and any process they start. It does not govern the pack's MCP servers (5.1), the platform's own injected MCP tools (5.2), built-ins of class `reach` (5.3), or the SDK's own model traffic. Every rendering of the posture, in the pack file's comments, `rfa agent show`, `rfa status`, `rfa doctor` and the `rfa agent edit` walkthrough, MUST carry that scope. A posture displayed without its scope is read as total, which is how a partial control becomes a false one.

**4.2 The values.**

- **`none`** (the default): on a pack the predicate of 3.3 fences, no sandboxed egress is permitted, and door two is established with `network.allowedDomains: []` and `network.strictAllowlist: true`. On any other pack there is no sandboxed command surface, so the field governs nothing; the platform MUST render it as inert there rather than as a posture in force. Every pack the scaffold has ever generated is of that second kind, which is why 4.6 removes the line rather than leaving it to be read as a control.
- **`allowlist`**: `allowed_domains` MUST be present and non-empty; door two is established with those domains and `strictAllowlist: true`. An `allowlist` posture with an empty or absent `allowed_domains` MUST be refused at definition load, never silently treated as `none`.
- **`open`** is **refused by name**, in the manner RFA-0.8 sect. 8.1 refuses `sandbox.isolation: container`: with what it would require rather than a generic enum error. Two grounds, both checkable. First, there is no allowlist entry meaning "any host": the pinned runtime documents wildcards in `allowedDomains` and states in the `deniedDomains` describe text beside it that, "Unlike allowedDomains, a bare `*` is accepted here (deny-all)", so a bare `*` is refused on the allow side by design. Second, the one route to unconfined egress that WAS measured is E10a, omitting the network policy and letting door one answer yes to every host, which is exactly the property 4.3 forbids: a security outcome decided by whoever answers. **This bullet supersedes v0.4 sect. 3.2's `# open requires room_admin override` comment**, which named a wire-level room authority for a hub-local pack setting. Reopening it requires an allowlist grammar that can express "any host", or a decision to withhold door two from such a pack entirely, which would withdraw its filesystem fence too and is not proposed here.

**4.3 `strictAllowlist` is mandatory.** Whenever the platform establishes door two with any network policy it MUST pass `strictAllowlist: true`. E3 and E10a measured the alternative from both sides: without it the outcome is decided by whoever answers the ask, and an answering callback returns `HTTP:200`.

**4.4 Inapplicability is refused, not decorated.** A pack declaring no built-in of class `command` has no sandboxed command surface, so a `network` value other than the default has nothing to govern. Declaring `allowlist` on such a pack MUST be refused at definition load, naming the reason. This is the rule of 3.2 and of RFA-0.8 sect. 8.1 applied to the field this document makes real: a setting that cannot act MUST refuse rather than reassure.

**4.5 Establish, never ask, and prove the half that carries the property.** A pack with a command surface MUST refuse to serve if door two's network half cannot be established on the host. The establishment at boot is the **deny half only**: one request to a host that must be refused, with the verdict checked for the allow-list reason and **not** the no-approver reason, which is exactly the distinction 4.3 rests on. The target MUST be a name that cannot resolve to a third party (an RFC 2606 `.invalid` host), so no resident boot depends on reaching anyone. The allow half belongs to `npm run egress-proof` (10.2), which runs against a platform-controlled host and not on every boot. RFA-0.8 sect. 9's existing startup check calls `srt.initialize({ network: {}, ... })`, deliberately asking for no network policy; that call MUST be replaced by the pack's own policy or this establishment proves nothing.

**4.6 Removing the false statement, without breaking every pack on disk.** Until 4.1 to 4.5 and 4.7 ship, the schema MUST keep `none` parsing as the accepted default and MUST refuse `allowlist` by name with what it would require, which is precisely how `sandbox.isolation` behaves. `allowed_domains` MUST be refused by name when present. `rfa agent new` MUST stop writing `network:` into generated packs in the same change. Packs already on disk carry `network: none`, written by every scaffold run of every kind, and `parseAgentMd` throwing on them would stop every existing resident booting; `none` therefore stays legal, and the line is stripped from packs already on disk by a command that runs against a **live** hub directory, through the one pack-writing function `rfa agent edit` already uses, surfaced as an `rfa doctor` fix. It MUST NOT be put on `rfa migrate`, which refuses by construction to run into a directory that already holds a manifest and so can never reach an existing instance's packs. Shipping this ahead of the feature is deliberate: it removes a false statement in hours and depends on nothing else in this document.

**4.7 The sandbox's own decision becomes a fail-closed backstop, never the decision point (amends RFA-0.8 sect. 9 item 1).** E10 measured that with no network policy in force the OS sandbox surfaces each outbound host to door one as a synthetic tool call, `SandboxNetworkAccess` with a `host` argument, and that door one's answer decides it.

Under 4.3 that path is closed by construction, and this is the crux of the section: `strictAllowlist` is precisely the switch that stops the runtime consulting the callback at all. The pinned runtime says so in its own source, immediately above the branch: "No matching rules - ask user or deny. strictAllowlist makes the allowlist deterministic enforcement: never fall through to the callback." So once 4.2's policy is established, the posture is enforced deterministically at door two and door one is never asked.

Therefore door one MUST deny `SandboxNetworkAccess` by name, with an egress-specific message naming the host, and MUST NOT decide it from the posture, which would be a second and weaker authority over a question door two has already answered. And its **arrival is itself the alarm**: on a run whose posture established a policy, receiving that name means `strictAllowlist` was not honored, so the run MUST fail loudly rather than proceed on a deny that happens to be correct. An `interrupt_on` rule matching `SandboxNetworkAccess` MUST be refused at definition load: a per-host human card on outbound traffic is a different feature, 4.2 has no value meaning "ask", and such a rule would convert the backstop into an approval path.

---

## 5. Where the fence stops (adds to v0.4 sect. 3.12)

**5.1 The boundary, measured.** A stdio MCP server the SDK spawns for a fenced query runs **outside** that query's OS sandbox (E5): it reached a host `strictAllowlist` denied to `Bash` in the same run, and wrote a file outside `filesystem.allowWrite` that was on disk afterwards. What confines an MCP server today is exactly two things: which of its tools the pack declares, since door one refuses every MCP tool a pack did not name (v0.4 sect. 3.12 item 1), and which credentials the supervisor injects. Its filesystem reach, its network reach, and the arguments of the tools the pack *did* declare are unconfined by this platform.

**5.2 The platform's own injected tools are part of the surface.** `rfa` and `memory` are registered on every resident query. `mcp__rfa__ask` sends model-authored text to another room member, and its candidate filter is keyed on `role`, not on `home`, so a pack that declares it has a voice that reaches other organizations by design. `rfa doctor` and `rfa agent show` MUST render every unconfined surface a pack holds, MCP servers and platform-injected tools alike, and MUST do so whenever the pack declares any network posture, so the posture can never be read as covering them.

**5.3 Built-ins of class `reach`.** `WebFetch` and `WebSearch` execute in the SDK's own process, which the network settings explicitly carve out. This is a **rendering and confirmation** requirement and never a posture-keyed refusal: the posture governs the command surface and has no value that could describe a `reach` tool. A pack declaring one MUST carry the acknowledgement **in the definition**, as an explicit key named alongside the `reach` built-in and refused at definition load when absent, in the manner 3.2 and 4.4 refuse. A command-level confirmation was considered and rejected: `rfa agent mode` can prompt before writing `mode:` because one command owns that field, whereas nothing owns `tools.allow` (`rfa agent edit` has no tools flag, and the only path that adds a built-in is the free-form `--editor`), so a confirmation promised at the command line would be unenforceable at the only place the tool can actually arrive. Such a pack MUST also be warned by `rfa doctor`, shown by `rfa status`, and named in 4.1's scope sentence as an unconfined surface. Refusing a posture value because of a `reach` declaration would leave a pack that declares `WebFetch` and no `Bash` with no legal value of the field at all.

**5.4 Confining a pack's MCP servers is on the ladder, not parked.** An earlier draft parked this behind a trigger. The trigger is already met by code this package ships: `rfa agent new --kind tool` scaffolds `mcp_servers.linear: { builtin: linear }`, and that server POSTs room-derived documents to a third party. The seam is the `mcpServers` option itself: the SDK spawns those children, so confinement means wrapping the spawn, and it can cover the `command` and `builtin` server forms and **not** the `url` form, whose process is not ours to wrap. Rung 8 MUST name that residual surface so 5.2's rendering stays true afterwards. `SrtLocalBackend` in `src/execbackend.ts` is not that mechanism, despite carrying a `network` policy: it wraps one shell string and captures stdout at process exit, which cannot host a long-lived bidirectional pipe. It has no production caller and its deletion is separate housekeeping, not the alternative to confinement.

---

## 6. Every model call the platform makes (amends v0.4 sect. 3.12)

v0.4 sect. 3.12 names three mechanisms that hold a resident's tool surface, and RFA-0.8 sect. 9 adds the fence. All four are written as properties of a *resident serving a turn*. The platform makes model calls that are not that.

**6.1 The invariant (amended 2026-08-30: any mechanism).** Every model call this platform makes, on any lane and **through any mechanism**, MUST declare its tool surface explicitly. For a call through the SDK's `query()` that means: the `tools` option set to exactly what that lane needs, `settings: { disableClaudeAiConnectors: true }`, and either a `canUseTool` callback or an empty tool set. A lane needing no tools MUST pass `tools: []`, not merely `allowedTools: []`. The two differ: the first makes the tool absent from the model's context, the second leaves it present and relies on the permission layer.

The amendment exists because the first wording said `query()` and was read as the boundary of the rule, when it was only the mechanism the rule's author had in front of him: the evals judge reached the model by **spawning the `claude` CLI** - the same account, the same connectors, prompts carrying untrusted room text - and inherited its caller's working directory, which is the hub root holding `.rfa/secrets.json`. Nothing in this section covered it and nothing in 6.3's scan could see it. A spawned model call MUST carry the argv equivalents of the declarations above: `--tools ""` (or the exact set the lane needs), `--strict-mcp-config` with no MCP config unless the lane declares servers, the same connector suppression via `--settings`, and an explicit working directory that is neither the hub root nor above it. A mechanism this document does not know yet inherits the invariant, not the exemption: the rule is "declare the surface of every model call", and the enumeration of mechanisms is maintenance, never scope.

**6.2 The consolidation and reflection lane.** Its material is untrusted room episodes and its working directory is `hubdir.root`, which contains `.rfa/secrets.json`. E9 ran that lane's options with `maxTurns` raised from its production value of 1, so the model could report: `Write` was refused, a `Bash` redirection outside the working directory was blocked, and **`Read` succeeded and returned the file's contents**. E12 then ran the production `maxTurns: 1`: the read **executes**, the file's contents enter the model's context, and the lane then errors `error_max_turns` so `llmOnce` throws. The bound is therefore real and narrow: untrusted episode text can cause an arbitrary readable file to be read into a context that is then discarded, and one change to `maxTurns` removes even that bound. A lane consuming untrusted material MUST pass `tools: []` and MUST NOT run with a working directory at or above the hub root. The prompt-level instruction that lane already carries, telling the model the episodes are material and never instructions, is a mitigation and not a control; wire spec principle 7 says so directly.

**6.3 An inventory, enforced (amended 2026-08-30: the spawn reach).** The platform MUST hold, in one module, the list of every model-call site and the declarations each makes, and a test MUST fail when a module the list does not name reaches the model. The check covers three reaches, each with its own anchor. For the SDK it MUST be anchored on the **import** (a module importing `query` from `@anthropic-ai/claude-agent-sdk`, plus any injected query seam such as the fence probe's), never on the text `query(`, which today matches a GraphQL literal and two prose comments and would make the test red on arrival. For a spawned CLI it MUST be anchored on the process API with the literal binary name **in prompt mode** (`-p`/`--print` leading the argv), because the binary name alone is not a model call: this platform legitimately runs `claude auth status` and `claude --version`, which spend no tokens and read no prompt, and the first draft of the spawn anchor flagged both. A requirement to "keep an inventory" that no test enforces is a wish; this finding exists because the containment doctrine was written about one call site and read as covering all of them - and then repeated itself one layer up, when the inventory was written about one *mechanism* and read as covering all of them.

---

## 7. The declared tool surface (extends v0.4 sect. 3.12)

**7.1** One function MUST compute a pack's total reachable tool surface: declared built-ins, declared MCP tools, and the platform's own injected tools (5.2). No such function exists today, which is why no check can be written against the total.

**7.2** Above 25 reachable tools the platform MUST warn at definition load and in `rfa doctor`, naming the count. The threshold is a vendor observation reported in W6 sect. 2.6, not a measurement made here, and the warning text MUST say so. It is a warning and never a refusal: the number is not ours, and a threshold that refuses on someone else's number will be wrong loudly.

**7.3** Unknown keys in an `offers` entry MUST be refused rather than silently discarded, which is what `z.object`'s default does today. An operator who mistypes a key on a capability card currently gets a card missing that field and no error anywhere.

---

## 8. Capability lifecycle (amends v0.4 sect. 3.2)

An offer is how a pack advertises what it can do. Today an offer that is removed disappears from the roster on the next digest rotation, and every consumer discovers it by failing.

**8.1** An offer MAY carry `deprecated: true` and MAY carry `superseded_by: <offer id>`. The requirement binds **selectors that read pack definitions locally**: such a selector MUST NOT choose a deprecated offer when a non-deprecated offer matches, MUST name the deprecation when it chooses one anyway, and `rfa doctor` MUST list every deprecated offer with its successor. A selector that reads `card_summary.skill_ids` from the roster **cannot see the flag**, because 8.3 keeps it off the card; that blindness is the cost 8.3 names and MUST be stated wherever the feature is documented, so an operator does not read a local guarantee as a room-wide one.

**8.2** `rfa connect` writes offer ids and their full descriptions into a skill file and a command file in a **different repository**, at `process.cwd()`, recording the destination nowhere, and it generates the hint from the offers of **every** pack bound to the room through a tolerant scan that skips broken packs. `rfa connect` MUST therefore record, in hub state, the absolute destinations it wrote, the set of `(pack name, definition hash)` pairs the hint was generated from, and any pack skipped as broken. `rfa doctor` MUST compare each recorded destination that still exists against the live set and report drift. This is CLAUDE.md's configured-versus-happening rule applied to an artifact that lives outside the hub directory.

**8.3 No wire delta, deliberately.** `deprecated` and `superseded_by` are pack-local: the agent card the hub serves is unchanged, so no roster, no remote member and no interop client sees a new field, and wire Appendix F gains no row. Advertising deprecation to other members is parked with a trigger (Appendix A). The local half solves the pain that exists on this instance; the wire half solves a pain no counterparty has reported, at the price of a wire version.

---

## 9. End-user identity: a recorded non-goal

W6 sect. 4.4 found the one enterprise capability RFA has no answer to and a shipping competitor documents thoroughly: carrying an end user's identity through each hop to the backend a request finally reaches, so that backend authorizes and audits the person rather than the service.

**9.1 The non-goal, stated so it is a boundary and not an oversight.** RFA does not propagate an end-user identity to any system a pack calls. A pack's MCP server credential is the **operator's**, injected by the supervisor from the hub directory's secrets. Every action a pack takes against a third-party system is attributable to the operator and to that pack, and to nothing finer. Wire sect. 4.2 defers RFC 8693 token exchange to T2; this section says what that deferral means downstream, which nothing said before.

**9.2 What an operator MUST do instead.** Give each pack its own credential at the backend, under its own principal there, so that system's audit log distinguishes packs. The mechanism is one secret name per pack per server: `env_secrets` maps a name to its own value with no interpolation and is spread after `env`, so a name in both is clobbered by the secret. There is no rename, and a literal value in `agent.md` is forbidden by that file's own rule.

**9.3 The trigger for reopening.** A pack that must act on a **named end user's** behalf against a system with per-user authorization. The answer then is the standard one (RFC 8693 token exchange, an audience-narrowing hop per call), and it is a wire-adjacent design rather than a platform knob. Building it before that trigger would be building an IdP integration for a room with one organization in it.

---

## 10. Instruments

**10.1 `rfa doctor`** gains: the network posture in force per pack with its scope sentence (4.1); every unconfined surface a pack holds, MCP servers, platform-injected tools and `read` built-ins alike (3.5, 5.2); every pack declaring a `reach` built-in (5.3); reachable tool count above threshold (7.2); deprecated offers with their successors (8.1); generated-artifact drift (8.2). Each MUST read the running system's own record where one exists. Where none exists it MUST say the value is from disk, because a resident's `state/member.json` records no tool surface, no posture and no fence state, and a check that reads `agent.md` and presents it as what is being served is the defect CLAUDE.md's rule was written for.

**10.2 `npm run egress-proof`** MUST establish, live and re-runnably: that a denied host is denied with the allow-list reason and not the no-approver reason; that an allowed host is reached; that under a posture-derived policy the name `SandboxNetworkAccess` does **not** reach door one at all, together with a deliberately non-strict control run in which it does and door one denies it (4.7); that a stdio MCP child is outside the sandbox (5.1); and whether a `subagent`-class child inherits the parent query's `sandbox` and `tools` (3.1). It MUST be re-run after every SDK bump alongside `npm run fence-proof`, for the same reason: this behavior is version-fragile, the SDK's type documentation contradicts itself about it, and a cache keyed on a version number is a changelog with extra steps.

---

## 11. Build path

| Rung | Delivers | Verdict | Effort | Amends |
|---|---|---|---|---|
| **1** | The inert fields stop lying: `allowlist` refused by name, `none` still parses, scaffold stops writing it, an `rfa doctor` fix strips it from live packs (4.6) | Do first, alone | hours | v0.4 sect. 3.2 |
| **2** | The platform's own lanes declare their surface; the consolidation lane leaves the hub root; the enforced inventory (6) | Do second | ~1 day | v0.4 sect. 3.12 |
| **3** | The five-class table, unclassified entries refused, the coverage predicate widened, the command-only pack fenced, `sandbox.cwd` refused where inapplicable (3) | Do third | ~1 day | RFA-0.8 sect. 9, v0.4 sects. 3.2 and 3.12 |
| **4** | The posture wired to door two, `strictAllowlist` mandatory, `SandboxNetworkAccess` an explicit branch, boot establishment, `npm run egress-proof` (4, 10.2) | The feature | 1-2 days | v0.4 sect. 3.2, RFA-0.8 sect. 9 item 1 |
| **5** | Tool-surface function, threshold warning, strict `offers` (7) | After 3 | half a day | v0.4 sect. 3.12 |
| **6** | Offer deprecation and generated-artifact drift (8) | After 5 | ~1 day | v0.4 sect. 3.2, RFA-0.7 |
| **7** | The doctor and `agent show` renderings (3.5, 5.2, 5.3, 10.1) | After 4 | half a day | RFA-0.7 |
| **8** | MCP-server confinement at the `mcpServers` spawn seam, with the residual `url`-form surface named (5.4) | Decide after 4 | ~2 days | v0.4 sect. 3.12 |

**Build order:** 1, 2, 3, 4, then 5, 6, 7 in any order, then 8. Rungs 1 and 2 are deliberately ahead of the feature: each removes a false statement or a live exposure, and neither depends on the design of the rest. The wire half of deprecation (8.3) is trigger-gated, sits outside this sequence and blocks nothing.

**What acceptance registers.** On acceptance: `research/06-agent-fabric/` and its `research/README.md` row are committed, since every `W6` citation here resolves to a file that is untracked today; CLAUDE.md's specification list gains a v0.9 bullet and its count moves from six to seven; STATUS.md's State line names RFA-0.9 and gains a third rung list headed "v0.9: egress (accepted on its acceptance date; rung status lives HERE, never in the spec)"; and research/README.md's wave-06 Outcome cell changes from "no spec change" to name this document. No wire file changes and no Appendix F row moves.

---

## 12. Testing obligations (working rules, not spec text)

These bind this repository's gates and impose nothing on another implementation.

1. A diff touching door two's policy construction, the coverage predicate, door one's branches, or any `query()` call site runs `npm run fence-proof` **and** `npm run egress-proof` before it is claimed done. Neither belongs in `npm test`: both need a real model, a real sandbox and a real refusal, and nondeterminism in a trust anchor erodes it.
2. Rung 4 lands its probes as a script, not as output pasted into a document. Appendix D is a snapshot, not a gate.
3. Every refusal added by rungs 1, 3 and 4 gets a mutation test: flip the refusal to an acceptance and prove the test fails. An instrument that cannot report failure is worse than none, and this repository has shipped one.
4. Rung 2 touches the memory consolidation path, a named concurrency surface, so RFA-0.8 sect. 14 item 3 applies: two parity passes, the second under load.
5. Rung 1 is not done until an existing scaffolded pack on a real hub directory still boots and serves.

---

## Appendix A: REJECTED and PARKED

| Item | Reason | Reopen trigger |
|---|---|---|
| An RFA-operated egress proxy (the Flex Gateway shape, W6 sect. 2.1) | The right design for governing agents you do not host, and RFA hosts its packs. An in-process sandbox costs nothing and cannot be declined by the pack it confines | RFA admits a local pack it does not run, or egress policy is needed over remote members' traffic |
| A SaaS control plane | Contradicts the self-hosting audience decision of 2026-08-17, and is the component W6 sect. 7 identifies as the lock-in critique's target | Never, absent an audience decision reversing 2026-08-17 |
| An org-wide agent scanner and catalogue (W6 sect. 4.10) | Fabric's answer to a problem a single-hub operator does not have | A second hub in one organization, or agents on a platform RFA does not host |
| Hierarchical broker trees as the scaling answer (W6 sect. 2.6) | Their workaround for having no multi-party primitive. A room addresses by capability without nesting routers, and the context-window argument that motivates the hierarchy does not apply to a roster | A room whose roster grows past what a capability match can usefully rank |
| An LLM broker for routing (W6 sect. 4.2) | Adds a model hop and its failure modes in front of routing the room already does by capability | Never on current evidence |
| RFC 8693 token exchange now (9) | Real, standard, premature | 9.3's trigger |
| A refusal keyed on the 25-tool threshold (7.2) | The number is a vendor observation, not measured here | An RFA-side measurement of where a pack's accuracy degrades |
| Narrowing the `read` class (3.5) | Would take `Read`, `Grep` and `Glob` out of `allowedTools` and route every read through door one, on every turn of every pack. The cost is real and the threat is not yet | A pack whose read surface holds something the operator cannot afford it to read, or a resident whose cwd stops being its own pack directory |
| `sandbox.network: open` (4.2) | No allowlist entry means "any host" (the runtime accepts a bare `*` only in `deniedDomains`), and the one measured route to unconfined egress, E10a's ask-and-answer-yes, is what 4.3 forbids | An `allowedDomains` grammar that can express "any host" |

**PARKED**, each with its trigger at the point of use: advertising offer deprecation on the wire (8.3); a Linux verification of the network half, since every probe ran on darwin-arm64 (Appendix B item 1).

## Appendix B: what acceptance does NOT assert

1. **That the network half behaves this way on any host but this one.** E1 to E12 ran on darwin-arm64 with `@anthropic-ai/sandbox-runtime` 0.0.73. The types name `socat` and `bwrap` as Linux/WSL dependencies for the sandbox proxy and neither was exercised. A Linux deployment MUST run rung 4's proof before relying on sect. 4.
2. **That an http or sse MCP client behaves like the stdio child E5 measured.** Only a stdio server was probed. 5.1's conclusion is stated for what was measured; 5.2's rendering covers all of them because it claims no confinement for any.
3. **That the SDK will keep honoring `strictAllowlist` from the flag tier, or keep surfacing `SandboxNetworkAccess` under that name.** The `Options.sandbox` doc comment currently denies that network restrictions are configurable there at all, and `SandboxNetworkAccess` is undocumented in the installed package. Both are exactly the situation in which a future version resolves things the other way. 10.2 exists for this, and 4.7 MUST fail closed if the name stops arriving.
4. **That `Read`'s auto-approval inside the working directory is stable.** 6.2's requirement holds either way: `tools: []` and a working directory outside the hub root are correct regardless.
5. **That refusing unclassified `tools.allow` entries (3.2) is free.** It will refuse packs that work today by naming a built-in the table does not list yet. That is the intended direction of failure, and the cost is a table maintained across SDK bumps.
6. **That 25 is the right number** (7.2). It is someone else's observation, carried with its provenance.
7. **That W6 is a verified source.** It is a single-session survey of vendor material and says so in its own first paragraph. It motivated this document and proves nothing in it.
8. **That a `subagent`-class child inherits its parent's fence** (3.1). Unmeasured. Until 10.2 establishes it, a pack with `allow_subagents: true` and a command or write surface MUST be treated as unproven, and `rfa doctor` MUST say so.
9. **That `reach` built-ins are outside the sandbox by measurement.** That half of consequence 6 rests on one SDK doc sentence naming `WebFetch` and not `WebSearch`; no probe here exercises either. 5.3's rendering is correct either way, because it claims no confinement for them.
10. **That today's accidental egress denial (consequence 2) holds for every pack.** It was measured for a fenced pack with a resident-shaped callback (E10b). A pack with no command surface never reaches it, and no pack's MCP servers or `reach` built-ins are covered by it at all.

## Appendix C: changelog

**Amended 2026-08-30** (owner decision, same day as the finding): sect. 6 covers every model call **whatever the mechanism**, not every `query()`. The evals judge spawned the `claude` CLI - no SDK import, so 6.1 did not bind it and 6.3's import-anchored scan could not see it - with rubric-plus-untrusted-trajectory prompts from the hub root. 6.1 now states the invariant mechanism-independently and names the argv equivalents for a spawned call; 6.3 gains the spawn reach with a prompt-mode anchor (`-p`/`--print`), measured against the two token-free CLI subcommands this platform runs that a name-only anchor false-flags. The code landed first (`spawnsClaudeCli` in `src/querysites.ts`, the judge confined in `src/evals/judge.ts`, both pinned by `test/egress.test.ts`); this amendment makes the check required rather than a courtesy of this implementation, so another implementer cannot spawn the CLI un-contained while claiming conformance. Findings ledger 60 and 67.

**Accepted 2026-08-29**, and built out over 2026-08-29 to 2026-08-30. Sect. 11's acceptance registration is discharged: `research/06-agent-fabric/` and its `research/README.md` row are committed, CLAUDE.md's specification list carries a v0.9 bullet and its count moved from six to seven, STATUS.md's State line names RFA-0.9 and carries a third rung list, and research/README.md's wave-06 Outcome cell names this document. No wire file changed and no Appendix F row moved, as sect. 8.3 said. One decision the document deferred was taken at rung 8 ("Decide after 4" in sect. 11's table): a wrapped MCP server's policy is **declared per server** in `mcp_servers.<name>.sandbox`, never derived from the pack's own `sandbox.network`, because sect. 4.1 scopes that posture to the command surface and reusing it would make the scope sentence false wherever it is rendered. No normative text in this document was changed at acceptance.

**0.9.0 (2026-08-29)** - initial proposal. Drafted from [research/06-agent-fabric/REPORT.md](../research/06-agent-fabric/REPORT.md) and from twelve live probes run the same day, then revised before proposal after a six-lens adversarial review whose findings were verified by refutation. Seven blocking defects in the first draft were corrected: an unmeasured historical claim about today's packs (fixed by E10, which changed the finding rather than the wording); an unsatisfiable `reach` refusal that left a `WebFetch` pack with no legal posture value; a `none` posture whose establishment nothing proved; `open` defined as a value that cannot be expressed; a by-name field refusal that would have stopped every scaffolded pack from booting; a classification table with no row for `Agent`, `Task` or specifier forms; and an MCP-confinement trigger that this package's own scaffold already meets. A second review of the revision then found that the first fix had introduced a defect of the family this document polices: 4.7 required door one to decide egress from the posture, while 4.3 mandates the one setting that stops the runtime consulting door one at all ("strictAllowlist makes the allowlist deterministic enforcement: never fall through to the callback", in the pinned runtime's own source). 4.7 is now a fail-closed backstop whose arrival is an alarm. That round also replaced a false justification for refusing `open`, constrained `sandbox.cwd` on every pack rather than only a fenced one, moved the field cleanup off `rfa migrate` (which refuses an existing hub directory by construction), named the real MCP spawn seam, anchored 6.3's check on the import rather than the text, and turned 6.2's hedge about `maxTurns: 1` into E12. Amends RFA-0.8 sect. 9, v0.4 sects. 3.2 and 3.12, and RFA-0.7's command surface. No wire text is proposed and no Appendix F row moves.

## Appendix D: the probes

Run 2026-08-29 against `@anthropic-ai/claude-agent-sdk` 0.3.233 (claudeCodeVersion 2.1.233), `@anthropic-ai/sandbox-runtime` 0.0.73, darwin-arm64, model `claude-haiku-4-5-20251001`. The scripts were throwaway and lived under a gitignored path; rung 4 promotes them to `scripts/egress-proof.ts`. Total cost of the run was about one dollar and a half.

Common shape for E1 to E4 and E10: `query()` with `tools: ["Bash"]`, `allowedTools: ["Bash"]`, `cwd` a fresh temp directory, and `sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: [tmp] }, network: <varies> }`. The prompt asked for exactly `curl -sS -m 8 -o /dev/null -w "HTTP:%{http_code}" https://example.com`. E1 to E4 carried **no** `canUseTool`; E10 carried one.

- **E1**, no `network` key, no callback: `curl: (56) CONNECT tunnel failed, response 403 HTTP:000 <sandbox_violations> deny network-outbound example.com:443 (user denied) </sandbox_violations>`
- **E2**, `{allowedDomains: ["api.anthropic.com"], strictAllowlist: true}`: `... deny network-outbound example.com:443 (host is not on the allow list) ...`
- **E3**, `{allowedDomains: ["api.anthropic.com"]}`: `... (user denied) ...`
- **E4**, `{allowedDomains: ["example.com"], strictAllowlist: true}`: `HTTP:200`
- **E5**, E2's policy plus `mcpServers: { probe: { type: "stdio", command: node, args: [server] } }` whose tools fetch the denied host and write outside `allowWrite`: `NETWORK-REACHED status=200`, `WRITE-SUCCEEDED at /var/.../outside-13319.txt`, and `forbidden file exists on disk afterwards: true`
- **E6 to E8**, `Options.sandbox`'s argv and merge behavior: it is serialized into `--settings`; `failIfUnavailable: true` is injected when `enabled` is true and the caller omitted it; a settings **path** plus the sandbox option throws `Cannot use both a settings file path and the sandbox option`
- **E9**, `llmOnce`'s options with `maxTurns` raised from its production value of 1, asked to write a file, run a Bash redirection and read a file in `cwd`: `Write` refused (`Claude requested permissions to write to ..., but you haven't granted it yet`), `Bash` redirection blocked (`Output redirection to '...' was blocked`), **`Read` succeeded and returned the file's contents**. Neither file existed on disk afterwards
- **E10a**, no `network` key, `canUseTool` installed and allowing: `HTTP:200`, and the callback recorded exactly one invocation, `SandboxNetworkAccess {"host":"example.com"}`
- **E10b**, identical but with the callback denying an unrecognized name, which is a resident's semantics: `... deny network-outbound example.com:443 (user denied) ...`, same single callback invocation
- **E12**, `llmOnce`'s options at its production `maxTurns: 1`, asked to read a file in `cwd`: `TOOL_USE: Read`, the tool result carried the file's contents, then `subtype: error_max_turns`, `is_error: true`, and the call threw `Reached maximum number of turns (1)`. The read executes; the reporting turn does not
- **E11**, the SDK's shadowing warning observed in both E10 runs: `canUseTool will not be invoked for: Bash. Bare allowedTools entries auto-approve the whole tool before the callback is consulted.` The warning names `Bash` and the network decision reached the callback anyway, so the synthetic `SandboxNetworkAccess` call is not shadowed by its own tool's pre-approval

One observation recorded but not specified: in E1 to E4 the reported `total_cost_usd` was $0.12 to $0.17 against a `maxBudgetUsd` of $0.05. If that overshoot is real rather than an artifact of the error path, it matters to `llmOnce`, which caps consolidation at $0.10. It is one observation on four samples and belongs in the findings ledger, not in a requirement.
