# 07-live-probes: SDK interception and in-process session concurrency

Wave 05, probe note. Written 2026-08-25.

Premise: two design-ladder rungs depend on unverified SDK behavior: rung 4 assumes `canUseTool` can act as a path guard on built-in Write/Edit, and rung 2 assumes one process can drive several SDK sessions at once. Both were probed live against the pinned SDK, `@anthropic-ai/claude-agent-sdk` 0.3.233 (installed version read from `node_modules/@anthropic-ai/claude-agent-sdk/package.json`; `package.json` pins `^0.3.233`). Model used for all probes: `claude-haiku-4-5`, maxTurns 1-2, trivial prompts. Probes ran 2026-08-25 on the operator's machine, scripts in the session scratchpad, scratch cwd outside any hub directory.

**Verdict: both rungs survive the probe, with one sharp condition. (A) `canUseTool` DOES fire for the built-in Write tool, so a path guard on Write/Edit is implementable in the callback, BUT only when the tool is NOT listed bare in `allowedTools`: a bare `allowedTools: ['Write']` entry auto-approves the call before the callback is consulted, the callback never fires, and the file is written. The SDK 0.3.233 even emits a named process warning (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) for exactly this shadowing. This refines the CLAUDE.md rule that `canUseTool` is "consulted for MCP tools only": in 0.3.233 it is consulted for built-ins too, unless allowedTools or settings allow-rules shadow it. (B) One Node process ran two concurrent `query()` calls and then two concurrent resumes of their own distinct sessions with zero errors, no cross-session contamination, and no SDK-imposed serialization; timings show true overlap. The mechanics: each `query()` spawns its own `claude` CLI child process, so in-process concurrency is really process-level fan-out multiplexed by the parent.**

| # | Recommendation | Verdict | Effort | Spec impact |
|---|---|---|---|---|
| 1 | Rung 4 path guard: route Write/Edit through `canUseTool` and keep those tools OUT of `allowedTools` (rely on fall-through to the callback); assert at pack load that no guarded tool appears bare in `allowedTools` | DECIDED (probe-confirmed on 0.3.233) | S | RFA-0.4 sect 3.12 gains the shadowing caveat |
| 2 | Treat the `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning as a hard startup error in the resident (fail closed), since settings-file allow rules can also shadow the callback invisibly | DECIDED | S | none |
| 3 | Rung 2 per-conversation concurrency: safe at the SDK layer; distinct sessions resume concurrently in one process without interference | DECIDED (probe-confirmed) | M (resident changes, not SDK) | none |
| 4 | Budget one `claude` child process per concurrent run when sizing `agents.max_inflight` and host memory; "in-process" concurrency is N CLI subprocesses | DECIDED | S | RFA-0.5 honest meters should count child processes |
| 5 | Same-session concurrent resume (two turns resuming ONE session id) | PARKED (not probed; trigger: any design that wants intra-conversation parallelism) | - | - |

## Probe A: does canUseTool intercept the built-in Write?

Setup: `query()` with `options: { tools: ['Write'], allowedTools: [], canUseTool: <record + deny> }`, prompt instructing the model to Write one file in a scratch cwd; then the same with `allowedTools: ['Write']`.

Case 1, `allowedTools: []`. The callback fired for the built-in, the deny stuck, no file was created. Raw observed output:

```
"canUseToolInvocations": [ { "toolName": "Write", "input": { "file_path": ".../case1.txt", "content": "probe" } } ],
"events": [ "tool_use:Write", "text:I encountered an error attempting to create the file. The Write tool returned a \"probe-denied\" error...", "result:success" ],
"fileExists": false
```

Case 2, `allowedTools: ['Write']`. The callback never fired, the write went through, and the SDK printed this warning verbatim:

```
(node:58825) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: Write.
Bare allowedTools entries auto-approve the whole tool before the callback is consulted. To gate every
tool call, use a PreToolUse hook; or remove the bare names from allowedTools so they fall through to
canUseTool. Allow rules from settings files can also shadow the callback but are not visible here.
```

Observed result: `"canUseToolInvocations": []`, `"fileExists": true`.

So the bypass direction is exactly the one the ladder needs to avoid: listing a tool in `allowedTools` is what disables interception. A rung 4 scratch-dir guard is viable if and only if the guarded built-ins are declared in the base `tools` set but never in `allowedTools`, and no settings allow-rule matches them. The warning text itself names the second, invisible shadow (settings files), which recommendation 2 turns into a fail-closed check.

## Probe B: two concurrent sessions in one Node process

Round 1: `Promise.all` over two fresh `query()` calls, distinct prompts, no resume. Both completed `success` with distinct session ids (`6f002088-...` and `154ce693-...`). Wall times overlapped: 9951 ms and 7572 ms measured from the same start instant; serialized execution would have pushed the second past 17 s. First message latency was 1.5-1.6 s on both, so neither stream waited for the other.

Round 2: `Promise.all` again, each call resuming its OWN round-1 session id, prompt "What fruit did you reply with before?". Both completed `success`, each kept its own session id, and each answered from its own history only: session B replied `BANANA` (correct recall); session A replied `None.`, which is also correct recall, because in round 1 that model instance had lectured about not having memory instead of saying APPLE. No answer leaked across sessions, no error, no observed queueing.

Process model: a third run listed the parent's children 4 s into two concurrent queries:

```
"childrenDuringRun": [ "59169 esbuild", "59170 claude", "59171 claude" ]
```

One `claude` CLI child per active `query()` (the esbuild process belongs to tsx, not the SDK). The SDK imposes no in-process lock; isolation between concurrent runs comes from the OS process boundary, and the per-run cost is a full CLI process.

## Probe C: does canUseTool intercept the built-in EDIT? (added 2026-08-26)

Run because RFA-0.8 Appendix B item 1 names Edit's interception as UNPROVEN and load-bearing (rung 5 puts the claim-fence check for Edit-based mutations behind the callback and does not ship without either this probe or the per-built-in startup deny probe). Same SDK, 0.3.233, same machine, model `claude-haiku-4-5`, scratch cwd outside any hub directory. Method is probe A's, verbatim, with `tools: ['Read', 'Edit']` so the model can read before it edits.

Case 1, `allowedTools: []`. **The callback FIRED for the built-in Edit, the deny stuck, and the file was unchanged.**

```
"canUseToolInvocations": [ { "toolName": "Edit", "file": ".../fees.txt" } ],
"editIntercepted": true, "events": [ "tool_use:Read", "tool_use:Edit", "text" ],
"fileChanged": false, "fileNow": "the fee is 1 percent"
```

Case 2, `allowedTools: ['Edit']`. The callback never fired, the edit went through, and the SDK emitted `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` naming Edit, with the same text it printed for Write.

```
"canUseToolInvocations": [], "editIntercepted": false, "fileChanged": true, "fileNow": "the fee is 2 percent"
```

**So Edit behaves exactly as Write does, and Appendix B item 1's assumption-by-analogy is now a measurement.** Rung 5's stated precondition is discharged by this probe.

## Probes D and E: the fall-through is PATH-dependent for Read (added 2026-08-26)

Probe C recorded `readIntercepted: false` while `events` showed a Read had executed, with Read in `tools` and absent from `allowedTools`, i.e. exactly the configuration that makes Edit fall through. Two follow-up probes isolated it, and the first reading (that Read is simply exempt) was wrong.

Probe D, Read alone with a deny callback and a relative path the model resolved to `/fees.txt`: **intercepted**, deny stuck, the canary never reached the model.

Probe E, the decisive one: same tool, same deny callback, two absolute paths, one inside the session cwd and one outside it.

```
inside cwd:  "intercepted": false, "contentsLeaked": true    <- the canary reached the model past the deny
outside cwd: "intercepted": true,  "contentsLeaked": false
```

**A read INSIDE the session's working directory is auto-approved without the callback being consulted; a read outside it falls through.** Edit is not path-dependent this way: probe C case 1's Edit target was inside the cwd and was still intercepted. The coherent reading, which matches Claude Code's own permission model: read-only built-ins are auto-approved within the working directory, write-shaped built-ins never are.

The RFA consequence is concrete, because a resident's cwd IS its pack directory: a pack that declares Read can read anything under `agents/<name>/`, its own `state/member.json` (which holds the membership token) and `state/memory.db` included, and `canUseTool` cannot fence it. The hub's `.rfa/secrets.json` is NOT reachable this way, because it sits in the hub root outside the pack directory, which is what the 2026-08-23 cwd change bought. This also strengthens the case for RFA-0.8 sect. 9 item 1's per-built-in startup deny probe: the doctrine is per-tool AND per-path, and the only safe way to know a given built-in is fenced on a given SDK is to probe it and fail closed.

## What these probes do not establish

These are single-shot probes on one machine against SDK 0.3.233 with a Haiku model; they establish existence, not guarantees. Not established: that `canUseTool` fires for every built-in (Write, Edit and Read are now probed, the last of them path-dependent; Bash and the harness-internal tools named in CLAUDE.md are not, and Read's path-dependence is a warning against generalizing from any of them), that the interception behavior is stable across SDK versions (the CLAUDE.md rule recorded the opposite behavior for an earlier setup, so this has already changed once), what settings-file allow rules exist on a given deployment (the warning says they shadow invisibly, and the probe machine's user settings were not audited), whether two turns resuming the SAME session id concurrently are safe (deliberately not probed, see recommendation 5), how concurrency behaves at higher fan-out than 2 or under the account-wide lease cap, and whether resource contention (cwd file locks, /memories writes) stays clean when the concurrent runs actually use tools, since round 1 and 2 ran with `tools: []`. The APPLE non-answer in round 1 is also a reminder that a 1-turn Haiku run does not reliably follow "reply with exactly" instructions; the probe conclusions rest on session ids and interference, not on answer quality.
