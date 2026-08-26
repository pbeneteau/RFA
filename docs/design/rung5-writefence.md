# RFA-0.8 rung 5: the two-door write fence

Written 2026-08-26, before any edit, in the shape rung 3 and rung 4 established. The
spec is [spec/RFA-0.8-concurrency.md](../../spec/RFA-0.8-concurrency.md) sections 8.1,
9 and 10; the evidence is `research/05-concurrency/REPORT.md` sect. 2.2 and
[research/05-concurrency/notes/07-live-probes.md](../../research/05-concurrency/notes/07-live-probes.md).

What the rung delivers: a pack that declares a write-shaped built-in becomes eligible
to run, and to run concurrently, with every write confined to its own per-run scratch
surface. Packs that must mutate the SHARED pack tree are rung 6 and are out of scope.

---

## 0. The two preconditions, discharged before the design

**Precondition one (Edit's interception) was already discharged** on 2026-08-26 by
probes C-E in the live-probe note: Edit falls through to `canUseTool` exactly as Write
does, and is shadowed by a bare `allowedTools` entry with the same named warning. What
those probes ALSO found is why the startup self-check is still owed: the fall-through is
per-tool AND per-path (a Read inside the session cwd never reaches the callback). No
built-in generalizes to another, so the only way to know a given built-in is fenced on a
given SDK is to probe it and fail closed. This rung builds that probe, over every
guarded built-in the pack actually declares.

**Precondition two (per-run door two) is resolved, and the degraded path is NOT needed.**
The question was whether the pinned SDK lets a policy be attached per `query()` when the
SDK spawns the CLI child itself. It does, two ways, and the better one is native:

| Mechanism | Per query? | Verdict |
|---|---|---|
| `Options.sandbox` (`SandboxSettings`: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `filesystem`, `network`) | Yes, it is an ordinary per-`query()` option | **CHOSEN** |
| `Options.spawnClaudeCodeProcess` + `SandboxManager.wrapWithSandboxArgv(..., customConfig)` | Yes; `customConfig` is per invocation | Rejected: it sandboxes the CLI process ITSELF, so the CLI's own bookkeeping writes (session transcript, shell snapshots) must be re-granted by hand, and the write set we would have to reconstruct is the CLI's, not the pack's |

Probes run for this rung, all on the pinned SDK 0.3.233 and srt 0.0.73, macOS/Seatbelt,
`claude-haiku-4-5`, recorded in the live-probe note as probes F-J. The four that decided
the design:

1. **srt's write model is ALLOW-ONLY, and `denyWrite` is a carve-out *within* the allow
   set that beats it.** `wrapWithSandbox` computes
   `allowOnly = [...getDefaultWritePaths(), ...allowWrite]` and
   `denyWithinAllow = denyWrite`. So `allowWrite: [scratch] + denyWrite: [packTree]`
   denies the scratch too, because the scratch sits under the pack tree (probe H case G).
   Section 9's phrase "denyWrite = the pack tree, the knowledge clones and `.rfa/`" must
   therefore NOT be implemented literally: the pack tree is denied by construction, and
   a `denyWrite` entry that is an ANCESTOR of the allowWrite root is a self-inflicted
   outage. The implementation filters such ancestors out and says why.
2. **The CLI grants its own working directory.** With `sandbox: { enabled: true }` and no
   filesystem block at all, a Bash write into the cwd lands and a write outside it is
   refused (probe F case 3). That single fact is what makes door two expressible per run
   without fighting the deny-beats-allow rule: **a fenced run's `cwd` IS its scratch
   directory**. Measured directly (probe I): with `cwd` = `scratch/<runId>`, a Bash write
   into the pack tree is refused, a write into the scratch lands, a write into an
   unrelated directory is refused. A `git init` at the pack root does not widen it.
3. **`allowUnsandboxedCommands` defaults to TRUE, and that makes the fence advisory.**
   Probe J: told that the Bash tool takes a `dangerouslyDisableSandbox` parameter, the
   model hit "operation not permitted", set the parameter, re-ran the same command and
   **wrote into the pack tree**. With `allowUnsandboxedCommands: false` the same two-step
   attempt is refused twice and the file is unchanged. Every fenced query passes
   `allowUnsandboxedCommands: false`. A door with a documented handle on the inside is
   not a door.
4. **`sandbox.filesystem.allowWrite` alone does not widen the CLI's write set** in the way
   its own description suggests ("Merged with paths from `Edit(...)` allow permission
   rules"): passing the scratch in `allowWrite`, in `settings.sandbox`, as an
   `Edit(...)` allow rule, and as `additionalDirectories` all left the scratch write
   refused while the cwd grant alone allowed it (probes F, G). We therefore do not rely
   on `allowWrite` to OPEN anything; the cwd grant opens the scratch and `denyWrite`
   closes the surfaces that a future cwd change might otherwise expose. Recorded because
   the natural reading of the option is the wrong one.

Consequence for the spec's degraded path: it stays unbuilt and unclaimed. This
deployment is per-RUN isolation, not a per-pack fence, and the startup log says which
one it is rather than leaving the reader to assume.

---

## 1. What a "writing pack" is, and why the name had to be pinned down

`agentPosture()` calls a pack `read-only` when `interrupt_on` names none of its tools.
A pack declaring the built-in `Write` with no `interrupt_on` rule is `read-only` by that
definition and can write the whole hub directory today, because a bare `allowedTools`
entry auto-approves it before `canUseTool` is consulted. That is not a hole this rung
opens; it is one this rung closes, and it is why gate 1 needed a second predicate.

- **Guarded built-ins** (`src/writefence.ts`): `Write`, `Edit`, `NotebookEdit`. These are
  the write-shaped built-ins the pinned SDK offers (`sdk-tools.d.ts`; there is no
  `MultiEdit` in 0.3.233). `Bash` is deliberately NOT in the set: its write set cannot be
  traced from its arguments, so it is door two's alone.
- **A writing pack** is one whose `tools.allow` names any guarded built-in. Its
  **declared write set** is its per-run scratch surface, and nothing else, at this rung.
- Gate 1 of sect. 10 is therefore read as two clauses: no gated ACTING tool (unchanged,
  schema-visible), and, for a pack with a declared write set, the fence available AND
  established (runtime, resident startup, fails closed).

---

## 2. Door one: the callback reached by fall-through

Guarded built-ins move OUT of `allowedTools` and stay in the SDK's base `tools` set, for
every pack, not only concurrent ones: the fall-through IS the interception, and a bare
entry is what turns it off. Three checks stand behind that, all at startup, all fatal:

1. **The shadowing assert.** No guarded built-in may appear in the computed
   `allowedTools`. This is now true by construction, so the assert exists for the edit
   that breaks it.
2. **The SDK's own warning, read rather than ignored.** `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`
   is emitted per query whenever `canUseTool` is set and `allowedTools` holds bare
   entries. It already fires on every resident query today, naming the MCP tools we
   auto-approve on purpose, so "any warning is fatal" would be a boot loop. The listener
   parses the tool list out of the message and is fatal only when it INTERSECTS the
   guarded set. That is exactly the case the warning's own text cannot cover from the
   inside (settings-file allow rules shadow invisibly), which is why check 3 exists.
3. **The per-built-in startup deny probe, on the installed SDK.** For each guarded
   built-in the pack declares, the resident runs one throwaway `query()` in a temp
   directory with a deny-everything callback and asks for one mundane file operation.
   Three outcomes: the callback fired -> PASS; the file changed without the callback
   firing -> FATAL (this SDK no longer routes that built-in through the callback); the
   model never attempted the tool -> retry once, then FATAL as inconclusive. The probe
   is re-run every boot rather than cached against a version string, because the
   callback's built-in behaviour has already changed once across SDK setups and a cache
   keyed on a version number is a changelog with extra steps. Measured on the live
   proof: $0.005 to $0.015 per guarded built-in per boot, so roughly two cents for a
   pack declaring Write and Edit, and only a writing pack pays it. The probe's verdict
   is NOT the query's own outcome: a denied tool makes the model retry until `maxTurns`
   and the SDK then throws, which the first implementation reported as inconclusive
   after the callback had already fired. The iteration error is remembered; the verdict
   is computed from the observations either way.
   - It also refuses a `sandbox.permission_mode` that shadows the callback wholesale
     (`bypassPermissions`, `acceptEdits`, `dontAsk`, `auto`). `acceptEdits` auto-accepts
     exactly the two tools this door exists to intercept.

**The per-run path guard.** A guarded call reaching the callback is allowed only if every
path it would write resolves inside THIS run's scratch surface.

- Targets by tool: `file_path` (Write, Edit), `notebook_path` (NotebookEdit). A guarded
  tool whose target field is unknown is DENIED, not allowed: an SDK that adds a fourth
  write-shaped built-in must not arrive as a silent hole.
- Normalization is `realpath` on both sides, and on the target it is realpath of the
  nearest EXISTING ancestor with the remainder rejoined, because the file being created
  does not exist yet. This repository has already paid for string-prefix comparison once:
  a path climbed to the filesystem root because the hub directory and an attached path
  sat on opposite sides of the macOS `/var` -> `/private/var` symlink. Traversal
  (`../../etc/passwd`) and a symlinked target (a link inside the scratch pointing at the
  pack tree) both resolve outward and are refused by the same comparison.
- The refusal message is written for the model to act on: it names the surface it may
  write and repeats the path it tried.

**The claim-fence check.** A run working a board task carries the task's `attempt` and
`owner` from the moment it started. Before a guarded write lands, the resident reads the
live task and refuses the write when the claim has moved, distinguishing the two cases
the operator cares about, which is the `{current_attempt, current_owner, task_state}`
triple sect. 2.4 names:

| Observed | Verdict in the refusal |
|---|---|
| `attempt` advanced, owner is someone else | re-claimed: another worker owns attempt N+1; stop, do not re-do the work |
| owner is null / task released | abandoned: the claim lapsed; stop and let the board hand it out |
| task terminal (completed, cancelled, failed) | over: nothing to write for |

**What door one does NOT do.** Two cases the first draft got wrong and the code now
states in comments:

- **It does not replace a card the pack asked for.** A pack that names a guarded built-in
  in `interrupt_on` has declared that every one of its writes pauses on a human decision.
  Door one runs its guards and then FALLS THROUGH to the card path with the fence already
  satisfied. The fence narrows where a write may land; it never widens who may authorize
  one.
- **It does not exempt plan mode.** "Propose, never act" covers a file write, including
  one into the run's own private directory. A guarded built-in in plan mode is refused
  with the plan-mode message naming the file and its content as the thing to put in the
  answer. An operator who wants scratch writes uses `ask` or `bypass`, which is what
  those modes are.

Scope, stated because the next rung threads the same door: the fence here is on the TASK
claim's attempt. Resource-keyed claims are rung 7 and are not built now. The
notify-and-repair channel of sect. 8.2 is rung 6; door one leaves the branch a named
place and no implementation.

---

## 3. Door two: the OS sandbox, per run

Every turn of a writing pack passes, on its own `query()`:

```
cwd:     <pack>/scratch/<runId>          // the grant that opens the surface
sandbox: {
  enabled: true,
  failIfUnavailable: true,               // loud refusal at the SDK layer too
  allowUnsandboxedCommands: false,       // probe J: the default is an escape hatch
  autoAllowBashIfSandboxed: true,
  filesystem: {
    allowWrite: [<scratch>],             // redundant with the cwd grant, and cheap
    denyWrite: [<state/>, <knowledge/*-clone>, <.rfa/>, ...],   // ancestors filtered out
  },
}
```

`denyWrite` carries sect. 8.1's never-reachable surfaces, minus any entry that is an
ancestor of the allowWrite root (finding 1 above). The pack tree itself is NOT in the
list and does not need to be: allow-only denies it.

Door two is the ONLY door for Bash. No attempt is made to parse a Bash command into a
write set; the surveyed precedent is to refuse untraceable shapes rather than pretend to
trace them.

**Loud refusal, never silent degrade.** Before a writing pack serves anything, the
resident asks whether the sandbox can establish itself on this host, and REFUSES TO BOOT
when it cannot. The check is in three parts and the third one is the one that matters:

1. `isSupportedPlatform()` - is this OS supported at all;
2. `checkDependenciesAsync()` - are the primitives present. In an unprivileged
   `node:24-slim` container with no bubblewrap this returns an explicit list
   (`ripgrep (rg) not found, bubblewrap (bwrap) not installed, socat not installed`) and
   the wrap then throws the same list, so the MISSING-primitive case is loud at both
   layers;
3. **establishment**: wrap and RUN a trivial write inside a temp allow root, then wrap
   and run one outside it, and require the first to land and the second to be refused.

Part 3 is not belt and braces, and BOTH platforms have a state that needs it. Probe K
measured what the first two say inside an already-sandboxed macOS context:
`isSupportedPlatform()` true, `checkDependenciesAsync()` zero errors, and the first
wrapped command dead on a nested `sandbox-exec`. Linux has the exact twin: in an
unprivileged container with bubblewrap INSTALLED, the binary is present for any
dependency check to find and using it fails with `Creating new namespace failed:
Operation not permitted`. A fence checking only dependencies would have reported
"available" in both, booted, and failed at the first turn. Asking about dependencies is a different question from "can this host
sandbox a command right now", and only the second one is the fence's precondition. The
negative half is there for the inverse failure: a sandbox that establishes and then
permits everything would pass the positive half alone.

`failIfUnavailable: true` on every query is the fourth part, at the SDK layer, for a host
that changes under a running resident. The failure mode being avoided throughout is the
one Bazel ships: a sandbox that silently falls back to no sandbox and reports success.

---

## 4. The run's working directory moves, and what that touches

`BRAIN_CWD` was a module constant (the pack directory since 2026-08-23, for the MCP-root
reason). It becomes per-run: the scratch surface for a fenced run, the pack directory
otherwise. Exactly two readers exist and both are handled:

- `cwd` on the query. Narrowing the advertised MCP root from the pack directory to one
  run's scratch is strictly better than what it replaces.
- `knowledgePath()`, which renders knowledge files relative INSIDE the base and absolute
  OUTSIDE it. With the base at `scratch/<runId>`, every knowledge file is outside and is
  rendered absolute. That is the branch the 2026-08-26 parity regression already fixed
  and the reason the base is now a parameter instead of a constant: two readers of one
  base must not be allowed to disagree again.

A consequence worth stating rather than discovering: a fenced run's Read of the pack tree
now falls OUTSIDE its cwd, so it no longer gets the auto-approval probe E measured. It is
still allowed, because `Read` remains bare in `allowedTools`; nothing narrows and nothing
widens.

**Scratch lifecycle at this rung.** Every run of a writing pack gets
`scratch/<runId>/`, created before the turn. A candidate run's loser is deleted as rung 4
already does. An ordinary run's surface is KEPT if it holds anything (it is the run's
artifact and rung 6 is what publishes it) and removed if the run wrote nothing, so a
writing pack answering ordinary questions leaves no litter.

---

## 5. Gate 1, wired

`concurrency > 1` on a writing pack passes validation (the schema can see the declared
write set but not the fence) and is then decided at resident startup, in this order,
every one of them fatal:

1. the posture has no gated acting tool (unchanged);
2. no guarded built-in is bare in `allowedTools`;
3. the permission mode does not shadow the callback;
4. the OS sandbox can establish itself on this host;
5. the deny probe passes for every guarded built-in the pack declares.

A writing pack whose fence cannot establish refuses to serve. It never serves unfenced.

---

## 6. What this rung does NOT assert

In the shape of RFA-0.8's own Appendix B, so the next session does not inherit
confidence nobody measured.

1. **The probes are macOS/Seatbelt.** bubblewrap on Linux is exercised only through
   srt's own dependency check, which is the mechanism we fail closed on; no Linux host
   and no unprivileged container was available to run the fence end to end. What is
   built is the refusal path, and the refusal path is unit-tested with an injected
   checker. A Linux deployment should re-run probes F-J before trusting the fence.
2. **The deny probe proves interception, not enforcement.** It proves the callback is
   consulted for a given built-in on this SDK. Door one's path guard and door two are
   what enforce; the probe only certifies that door one is reachable at all.
3. **The claim-fence check reads the hub, so it is as fresh as the last read.** A claim
   that moves between the check and the write lands the write. The window is one
   round-trip wide and the fence is a claim fence, not a lock; sect. 8.2's publish
   lifecycle, not this rung, is where the durable answer lives.
4. **A resumed conversation's earlier turns name a scratch directory that is no longer
   the cwd.** Sessions are resumed per conversation key, and each RUN gets a fresh
   surface, so a follow-up turn's transcript refers to the previous run's directory. The
   fence is not weakened by this (the guard and the sandbox both use the new run's
   surface, and the system prompt names it every turn), but a model that tries to re-open
   what it wrote last turn will be refused. The alternative, a per-CONVERSATION surface,
   would break the per-run isolation this rung exists to provide, so this is the trade
   rather than an oversight. It is unmeasured at this rung: no writing pack has yet held
   a multi-turn conversation here.
5. **`getDefaultWritePaths()` is srt's, and it is not empty**: `/dev/*`, `/tmp/claude`,
   `/private/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug` are writable inside every
   sandboxed command by construction. A pack CAN write there. Nothing in the hub
   directory is among them, which is what matters here, but "only the scratch is
   writable" is a sentence about the hub directory, not about the filesystem.

---

## 7. The proof is a command, not a session log

`npm run fence-proof` (`scripts/fence-proof.ts`) builds a throwaway writing pack at
`concurrency: 2` in a temp hub directory and proves the eight claims above end to end:
the two boot refusals, the fence establishing with its per-built-in probe, an allowed
write inside the surface, a Write refused just outside it, a Write refused into the
knowledge corpus, the same write refused through Bash with door one never seeing the
call, and two overlapping turns writing only their own surfaces. It never touches the
operator's packs: the owner's one gated acting tool writes to a real Linear workspace,
and proving a fence with it would mean proving it against production data.

It is a command rather than a paragraph in a ledger because door one is version-fragile
by design. "Re-run this after an SDK bump" has to be something somebody can actually run.
