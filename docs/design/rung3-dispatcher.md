# The dispatcher (RFA-0.8 rung 3), designed

Status: design accepted and built 2026-08-26. RFA-0.8 sect. 6.2 states four
requirements and says the design is open; Appendix B item 3 says the dispatcher
"does not exist, even on paper". This document is the paper. It is a design note,
not spec text: nothing here binds another implementation, and where it makes a
choice the spec left open, it says which requirement the choice discharges.

## 0. The thing being replaced

`RoomMember.serve()` is a single loop:

```
while (!aborted) {
  events = await listenOnce()          // long poll, THIS member's shared cursor
  for (const event of events) await handler(event)   // the turn happens HERE
}
```

It is serial twice over. The second serialization is the expensive one: while a
turn is running, `listenOnce` is not called, so incoming requests are not queued
behind the turn, they are **unread**. A peer asking a busy resident gets dead air
until its `reply_by`, and the resident cannot even tell it is busy. Rung 2 could
only reach the cycle case from the ask-wait loop, which runs on its own cursor,
because that loop was the one thing still reading.

## 1. Four layers, each with one job

The requirements name queues, one-writer-per-session, backpressure and deadlines.
It is tempting to build one object that does all four. Four separate things is
better here, because three of them already exist and each has a different scope:

| Layer | Scope | Owns | Fails how |
|---|---|---|---|
| `Dispatcher` (`src/dispatch.ts`) | one resident's room traffic | queues, admission, deadlines, backpressure, the in-process turn cap | a refusal on the wire |
| keyed turn lock (`src/turnlock.ts`) | one process, every caller | one turn per session id, FIFO | a wait |
| `SessionBook.enter` (`src/sessions.ts`) | one process | the assertion that the two above worked | a throw |
| `AccountLedger` (`src/account.ts`) | every process on this host | the cross-process slot cap and the money | a refusal at admission |

The dispatcher is **policy**; the keyed turn lock is **mechanism**; the session
book is the **assertion**. If the dispatcher is correct the turn lock never
blocks and the session book never throws. That is deliberate: two of the three
exist to catch the day the first one is wrong, and they cost nothing when it is
right. The account ledger is a different axis entirely (across processes), and
conflating it with the in-process cap is how a resident ends up believing a
number the supervisor owns.

### Why the turn lock narrows rather than disappears

Spec 6.1: "Rung 3 narrows its scope from one turn per process to one turn per
session id via the dispatcher; it never disappears." Concretely, three callers
run model turns and only one of them goes through the dispatcher:

- the serve path (room requests and chats) - dispatched;
- the task wake (`onTask`) - dispatched, same queues, key `task:<id>`;
- the schedule timer, firing on its own clock - **not** dispatched.

The schedule timer is what the process-wide lock was built for on 2026-08-25
(two turns sharing a `currentLease` cell). Narrowing to a key would leave it
unguarded if the key were the only guard, so the keyed lock covers every caller
and the dispatcher's cap is applied to the dispatched ones. A scheduled turn
overlapping a serve turn is now legal and is bounded by the account cap and its
lane reserve, which is exactly what lane reserves are for.

## 2. The conversation key, and why requirements 1 and 2 are one mechanism

Requirement 1 asks for per-conversation FIFO queues keyed by `(room, counterparty
membership)`. Requirement 2 asks for one writer per session id. These are the
same mechanism seen twice, and it matters that they are keyed **identically**:

- a conversation key owns a session id (`SessionBook.byConvo`), and `adopt`
  already refuses to let two conversation keys share one session id;
- therefore "at most one running job per conversation key" **is** "at most one
  writer per session id".

If the dispatcher keyed on anything else, two jobs on one session id would run
concurrently and the session book would throw - correctly, and too late to be
useful. So there is exactly one key function, `conversationKey(envelope)` in
`src/client.ts`, and it is what both the queue and the session map use. It
arrives on `ServeContext.conversationKey` so the resident cannot compute a
second opinion.

```
conversationKey(env) = env.conversation_id ?? `peer:${env.from.id}`
```

A resident serves one room, so room is implicit in the member; the counterparty
membership is `from.id`. This also fixes a latent bug: the old fallback key was
the literal string `"adhoc"`, so **every** counterparty with no conversation id
shared one SDK session. Serially that leaked context between askers; at N > 1 it
would be a same-session concurrent resume, which is documented corruption. The
key is narrower than the requirement asks (a conversation id is finer than a
counterparty), which is the safe direction.

## 3. The Dispatcher

Transport-agnostic on purpose: it takes jobs and callbacks, never an envelope
and never the hub. That is what lets its acceptance test be a unit test with
barriers rather than a live room.

```ts
submit(job): "queued" | { refuse: reason, detail, retryAfterS? } | { skip: detail }
```

Synchronous, because admission has to be an answer the caller can put on the
wire in the same tick. The caller (the serve loop) owns the wire; the dispatcher
never sends anything.

State:

```
queues:  Map<key, Job[]>   // insertion-ordered: FIFO within a key, round-robin across keys
running: Set<key>          // the one-writer-per-session fence
inFlight: number           // <= concurrency
```

`pump()` runs whenever a slot frees or a job arrives: while `inFlight <
concurrency`, take the first key whose queue is non-empty and which is not in
`running`, shift its head, re-check it (section 5), and start it. A key whose
queue drains and which is not running is deleted from the map, so an idle
resident holds no per-conversation memory.

Round-robin across keys falls out of `Map` insertion order plus the `running`
skip: a key that is running is passed over, so a chatty conversation cannot
starve a quiet one. In-process lane priority stays PARKED (Appendix A); the
account layer already has per-lane reserves and there is no measured
serve-latency incident.

### Backpressure (requirement 3)

Two bounds, both refusing the **arriving** job, never dropping a queued one:

- `queueLimit` per key (default 4);
- `maxQueued` overall (default `concurrency * 8`).

Refusing the newcomer is the honest shape. Dropping a queued job means somebody
who is already waiting gets silence, which is the failure mode the requirement
calls "never a silent drop". The refusal is the wire's ordinary `overloaded`
with `retry_after_s`, which every client SDK already treats as transient.

### Deadline-aware admission (requirement 4)

Checked twice, because a queue makes the answer change over time.

At submit, the estimated start is `now + jobsAheadOnThisKey * meanTurnMs`, where
`meanTurnMs` is an EWMA of observed turn durations seeded conservatively at 20 s
(the pm-agent's measured range is 10-17 s). Refuse with `deadline_expired` when
`replyBy <= estimatedStart + MIN_VIABLE_TURN_MS`. With nothing ahead on the key
this degenerates to the plain past-tense check, so the prediction can only make
the dispatcher refuse work it could not have finished anyway.

At dequeue, the same check runs again with no estimate: a job whose `reply_by`
passed while it sat in the queue is **shed** with `deadline_expired` instead of
started. This is the half that makes bounded queues honest: the alternative is
paying for a model turn into a dead deadline, which is a bill with no reader.

## 4. The three things rung 2 left to carry

### 4.1 The inline-refusal memory

Rung 2's `refusedInline` set lives on `RoomMember` and is read by `serve()`. It
must be consulted **twice** now, and the second one is new:

- before enqueue, as today;
- **at dequeue**, because the window is no longer instantaneous. A request can
  be queued, then refused inline with `would_deadlock` by the ask-wait loop
  while it sits in the queue, and answering it minutes later from a turn nobody
  is waiting on is exactly the second-order bug rung 2 recorded. The dispatcher
  takes a `shouldSkip(job)` predicate for this and drops the job silently, since
  the refusal has already gone out.

### 4.2 The park overshoot bound, re-derived

Rung 2 states the bound as "at most one park per resident process, because the
turn lock holds one turn per process". Rung 3 is the change that breaks that
premise, so the bound is re-derived here and the conclusion is a rule, not a
number.

Naively, N concurrent turns can each park, and `unpark` takes its slot back
after a short grace whether or not capacity exists, so the account could sit at
`cap + sum over residents of N_i`. At cap 2 with one pack at N=2 that is a
doubling. Rejected: an overshoot that scales with `concurrency` turns a ceiling
the operator set into a suggestion, and the ceiling is money.

The three ways out, and why this one:

- **Serialize the over-cap returns** - only delays the overshoot. The second
  returning turn eventually takes its slot too, because the alternative is
  killing a turn that has already spent money. It bounds nothing.
- **Refuse the return** - this is the "bill with no answer" that rung 2
  rejected outright, and the reason does not weaken at N > 1.
- **Bound the parks** - adopted. **A process may have at most one parked turn.**
  A turn that would park while another turn of the same process is already
  parked simply keeps its slot through the blocked wait, which is the pre-rung-2
  behaviour for that turn only.

So the bound is `cap + (resident processes with a returning parked turn)`,
unchanged from rung 2 and **independent of `concurrency: N`**. The anti-freeze
property 6.3 exists for survives: a process with any blocked turn still frees at
least one slot, so the depth-2 chain a remote peer can provoke cannot own the
whole account.

The price, stated rather than hidden: with `concurrency: N` and k > 1 turns
blocked at once in one process, k-1 of them hold a slot they are not spending.
That is latency for other work. The trade is deliberate - a bounded hold on one
process's own turns is a smaller failure than an unbounded, N-scaled overshoot
of a shared spending cap, because the first costs waiting and the second costs
money past a ceiling.

### 4.3 `serving` is already a count; what changes is who owns it

Rung 1 made `serving` a count. Rung 3 makes the count come from the dispatcher
(`dispatcher.inFlight()`), so the consolidation timer's "no turn in flight" test
reads the same number the scheduler enforces rather than a parallel tally that
can drift.

Consolidation does **not** get a drain barrier, and that is a decision. Spec
sect. 4 item 2 puts every destructive memory verb in the consolidation lane and
gate (b) of sect. 10 refuses `concurrency > 1` to any pack whose answer-path
surface holds one. So at N > 1 the answer path cannot tear what consolidation
writes: the ownership split is the mechanism, and a second barrier would be
belt-and-braces bought with a stall. Consolidation still waits for zero in-flight
turns in its own process, and is still single-flight across processes through
the named lock rung 1 built.

## 5. The turn binding under N > 1

`TurnRegister.current()` returns `null` whenever two turns are live - by design,
since with two live turns there is no lease that is right for both.
`src/turnbinding.ts` predicted this exact moment: "rung 3 narrows that lock to
one turn per SESSION, at which point the dispatcher must thread a binding per
run and `current()` starts returning null instead of the wrong answer."

Threading it: `AsyncLocalStorage`. `turns.run(binding, fn)` establishes the
store for the whole turn, and `current()` returns the store first, falling back
to the single-live-turn heuristic. Two of the three readers do not need it
(`canUseTool` and the approval wait are built inside `brainTurn` and close over
their own binding directly, which is stronger than any ambient lookup); the one
that does is the nested-ask tool, registered once at module load.

Known limit, stated rather than assumed: ALS propagates through promise chains,
so a tool handler invoked from within the query's own iteration inherits the
store. Whether the SDK ever invokes an MCP handler from a context rooted outside
that iteration is not something this repository can prove. If it does, the
fallback still covers N = 1, and at N > 1 the nested ask degrades to the
documented behaviour - no chain propagated, no slot parked, with a log line
naming why. Failing visibly at that boundary is what `turnbinding.ts` is for.

## 6. What this does not do

- No in-process lane priority (PARKED, Appendix A; trigger is a measured
  serve-latency incident).
- No lease grant-order or starvation policy (PARKED).
- No same-session concurrency of any kind (REJECTED; sessions fork, they do not
  share).
- No cross-process dispatch. The queues are one resident's. The account ledger
  is the only cross-process scheduler and stays that way.
- `concurrency: N` is N full `claude` CLI child processes, not N threads (probe
  B). Host sizing is the operator's, and the schema's documentation says so.
