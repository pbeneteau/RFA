# Candidate parallelism (RFA-0.8 rung 4), designed

Status: design accepted and built 2026-08-26. RFA-0.8 sect. 11 is nine lines and
one of them (selection is a verification act under wire 10.4) reads as a
constraint on the WIRE. This document decides which reading is built, records
why, and names the spec amendment that decision owes. It is a design note, not
spec text: nothing here binds another implementation.

## 0. What the rung is

N independent runs of ONE task, in N scratch surfaces that never merge, one
output selected, the rest discarded. No shared-state write conflict exists by
construction, which is why it is the cheap rung. Identical packs produce useful
candidate spread, so **no diversity mechanism is built**: prompt diversity was a
measured null result (W5 sect. 9) and intra-agent spread is enough.

Three things stay parked and are not in this diff: diversity prompting, an agent
selector before human selection works, and candidate parallelism for writing
packs (which needs the two-door fence of rung 5 and the clone of rung 6).

## 1. Decision one: the fan-out is LOCAL, not wire-visible

**Decided: local.** The room sees one task, one owner, one completion. The N
candidates exist only inside the resident and in the hub directory's own
`runs.db`. Wire 10.4 still governs the final gate, on the winner, by a member
that is not the owner, exactly as it governs every other evidence-bearing
completion today.

### The alternative, and why it lost

The sentence in sect. 11 leans the other way: "selection is a verification act
under spec 10.4, performed by a member that did not generate the candidates".
Read strictly, that puts the candidates on the wire, because a member cannot
verify what it cannot see. The wire task object supports **one owner and one
`evidence`** (wire 10.2), so wire-visible candidates need either N evidences or
N child tasks under `parent_id`. Both are new wire surface:

| Shape | What the wire would need | Cost |
|---|---|---|
| N evidences | `evidence[]` or a repeated verify verb, plus a rule for which one `accept` accepts | A protocol delta, its own Appendix F rows, a bump past 0.1.9 |
| N child tasks | Nothing NEW in the object (`parent_id` exists), but N tasks, N claims, N completions and N events per real task | The room log becomes the wall of noise item 5 exists to prevent |

RFA-0.8 staged neither. Its section 2 is the complete list of wire deltas it
proposed for 0.1.9, and candidates are not in it. Adding a field here would be
the ad-hoc protocol change the v0.5 sect. 18.7 rule forbids: two
implementations of an unnamed field do not interoperate.

Three further reasons the local shape is the right reading and not merely the
cheap one:

1. **The local-only guarantees paragraph already covers it** (RFA-0.8 sect. 2.5,
   transplanted into wire sect. 14): turn and run mechanics are local resident
   properties that no peer may assume. A candidate set is run mechanics.
2. **10.4 is not weakened, it is reached unchanged.** The resident files ONE
   evidence, for the winner. The verifier is a different member, may not be the
   owner, and must be local / creator / human principal. Every clause of 10.4
   applies to that act with no amendment.

   The honest footnote, found in the live run rather than in the design: 10.4's
   gate only bites when `evidence_required` is set on the task, so a candidate
   task created without it completes on the winner's evidence with no verifier
   at all. That is unchanged wire behaviour and not something this rung altered,
   but "a different member verifies the winner" is a promise only for a task
   created `--evidence-required`, and the CLI does not currently pair the two
   flags.
3. **Item 5 of the rung (room-log hygiene) is satisfied by construction** rather
   than by discipline. If candidates were wire objects, "only the winner speaks"
   would be a rule somebody has to keep. Locally it is the only thing possible.

The residue, stated rather than hidden: **the human who selects is choosing
between candidates the wire never saw.** A remote member cannot audit the
discarded two. That is acceptable at this rung because the selection is the
operator's own, inside their own hub directory, over their own pack's runs; it
would NOT be acceptable if the selector were a remote peer, and that is the
trigger for reopening the wire shape (section 7).

### What this decision owes

Section 11's sentence reads as the wire shape, so it gets a clarifying
amendment: selection among candidates is a LOCAL act; wire 10.4 governs the
verification of the completion the winner produces. Wire Appendix F gains no
row, because no wire requirement changed. Recorded in the spec, not only here.

## 2. Decision two: losing candidates must not reach memory

Rung 3 keeps ONE memory store shared across a pack's concurrent runs (sect. 4,
deliberately: partitioning it per run creates the diverging-replica case no
shipped system merges). A serve turn records an episode; consolidation later
distills episodes into facts. N candidates each recording an episode means the
rejected candidates' reasoning becomes remembered fact, which is the fact store
learning from work a human threw away.

Two write paths can reach memory from a candidate turn, and each gets its own
rule.

### 2.1 Episodes: a candidate writes NONE, the winner writes ONE

The spec offers two shapes: candidates record nothing until one wins, or
episodes are tagged and consolidation excludes non-winners. **The first is
built**, and the tagging shape was tried on paper first and rejected for a
concrete reason:

> Consolidation advances its watermark to `batch[batch.length - 1].id` (see
> `src/consolidate.ts`). If `since()` filtered pending candidate episodes out of
> the batch, the watermark would advance PAST them, and a candidate promoted
> after that pass would never be consolidated at all. The tagging shape needs a
> watermark that can go backwards, which is exactly what rung 1's compare-and-set
> exists to prevent.

So: a candidate turn writes no episode. Its answer is durable immediately, in
`candidate_runs.text` in `runs.db`, where `rfa task candidates` reads it and the
audit is real. On selection, and only then, the WINNER's answer is written to
the episode log through the ordinary `recordOwn`, in normal id order, ahead of
the watermark. The losers' text stays in `runs.db` forever and never enters the
episode log at all: **it does not vanish, it just never becomes fact.**

**Enforced at the write, not by convention.** `EpisodeLog` takes an optional
guard closure; the resident wires it to "is a candidate turn in scope right
now", read from the same `AsyncLocalStorage` turn binding rung 3 built. A
`recordOwn` from inside a candidate turn THROWS. The candidate path does not
call it, so the throw is a tripwire for a future author rather than a runtime
path, which is what a structural guard should be.

### 2.2 `/memories`: mutating verbs are refused inside a candidate turn

Every pack gets `view/create/insert/str_replace` on `/memories`, so a candidate
CAN reach the file layer even at a read-only posture. Three options existed:

- **Let all N write.** Rejected: that is N candidates' notes in one shared store
  with one of them selected, which is precisely the trap.
- **Buffer each candidate's writes and replay the winner's on selection.** This
  is a miniature of rung 6's clone-and-publish, including its conflict
  lifecycle, and rung 6 owns it. Building a second, weaker copy here is how two
  merge stories end up in one repository.
- **Refuse, loudly, with a reason.** Adopted.

The refusal names the rung and tells the model to put the conclusion in its
answer instead, where the winner's copy reaches memory through 2.1 anyway. Same
enforcement point as sect. 4 item 2's ownership split: the tool handler, keyed
on the turn binding. Reopen trigger: rung 6's CoW clone, at which point
candidates write into their own clone and the winner's is published.

## 3. Decision three: N candidates are N reservations against one day budget

Rung 3's ledger reserves `min(per_task_usd, remaining)` per admitted run. A
four-candidate task on a five-dollar pack is a four-way claim on the same
remainder, and admitting four so three can die at the viability floor is the
dishonest shape: the operator paid for one candidate and got a refusal for
three, with the fan-out reporting nothing useful about why.

So the fan-out **asks the ledger first**. `AccountLedger.affordableCandidates()`
computes, in one read of the same `settled + reserved` the admission transaction
uses, how many reservations fit before the remainder drops under the floor:

```
remaining = per_day_usd - (settled + live reservations)
per_task declared   ->  k = floor((remaining - viable) / per_task) + 1
per_task absent     ->  k = remaining >= viable ? 1 : 0
```

The second line is not a degenerate case, it is the honest answer: with no
per-task ceiling the FIRST reservation is the whole remainder, so exactly one
candidate is affordable. That is a real reason to declare `per_task_usd` before
using candidates, and the CLI says so at the point of use.

The number actually started is `min(requested, pack concurrency, affordable)`,
and every clamp is reported: on the task note the room can read, in the CLI's
own output, and in `candidate_sets.degraded`. **The three-becomes-one case is a
first-class outcome with a sentence attached, not a silent one.**

The count is a snapshot, deliberately. Between the plan and the Nth `acquire` a
sibling resident may take the remainder, and the Nth candidate is then refused
`budget_exhausted` by admission exactly as any other turn would be. Planning
narrows that window from "guaranteed for 3 of 4" to "unlikely for the last one";
it cannot close it, and no plan-then-act shape can. The refused candidate is
recorded as `failed` with its reason and the set continues with the rest.

**Every candidate settles its real cost, including the cancelled ones.** This is
the part the early-stop variant tests: cancellation is `query.interrupt()`, NOT
`abortController.abort()`, because interrupt lets the CLI emit its `result`
message and that message is where `total_cost_usd` lives. The turn then leaves
through the same `finally` every other turn leaves through, which settles the
reservation against what was really spent. An aborted controller would have
thrown the iteration away with the cost inside it, and a candidate whose spend
disappears is exactly the unattributable meter the honest-meters doctrine
forbids.

## 4. The mechanism

### 4.1 One set, N runs, N sessions, N scratch surfaces

| Thing | Per candidate | Why |
|---|---|---|
| engine run | `run_<hex>`, `kind: "candidate"`, carrying `candidate_set` and `candidate_index` | Cost per TASK is answerable, not just cost per run (item 6) |
| engine thread | `task:<id>#c<k>` | One thread per run or the per-thread mutex enqueues candidates 2..N behind candidate 1 |
| conversation key | `task:<id>#c<k>` | The keyed turn lock is per session id; identical keys would serialize the fan-out, and `SessionBook.enter` would throw |
| SDK session | fresh (no `resume`) | N INDEPENDENT runs is the definition of the rung |
| scratch surface | `<pack>/scratch/<runId>/` | Per-run write surface; the loser's is deleted |
| account lease | its own, with its own reservation | The money, per section 3 |

The conversation key doing double duty as the thread id is the rung-3 rule
restated: one key, computed once, used by the queue, the lock and the session
book, or they stop being the same fence.

### 4.2 The scratch surface is real and, at this rung, empty

`scratch/<runId>/` is created before the candidate starts and removed when the
candidate loses. It is named in that run's system prompt as its private working
directory.

Stated plainly because an operator will otherwise assume more: **a read-only
pack cannot write to it.** Candidate parallelism rides rung 3's posture gate, so
this rung is read-only packs ONLY, and a read-only posture excludes Write and
Edit from the base tool set. The surface exists now so that rung 5 wires the OS
sandbox's `allowWrite` around something that already has a lifecycle, and so
that the "the losers' scratch is gone" property is proven before anything
depends on it. A writing pack's candidates need rung 5's two-door fence and
rung 6's clone, neither of which exists.

### 4.3 Selection, two variants

**`first-verified` (early stop, selector-free).** When any verified completion is
acceptable, no selector is needed: the first candidate to finish successfully
wins and the rest are interrupted. Buys 1.6-2.2x latency for 1.7-2.6x cost
(W5 sect. 9). The fan-out does not return until every interrupted candidate has
settled, so the set's total cost is complete before the task completes.

**`human` (the default, and the one shipped first).** All candidates run to
completion. The set is filed `awaiting_selection`, the resident posts ONE note
and moves the task to `input_required`, which is already the wire's word for "a
human or the creator owes this task an answer" (10.4 chose it for the same
reason). The resident then goes back to serving: it holds no turn, no lease and
no slot while a human thinks. Selection is `rfa task select` or the dashboard's
Tasks tab; answering an `input_required` task flips it to `working` and the
event wakes the owner, which files the winner as evidence with no further model
turn. A resident that was down at selection time picks the set up at boot.

The cost of the selector variant is written in rather than discovered later:
**expect to lose 10 to 15 points of task coverage to selection when no
executable check exists** (measured collapse from 69.8 to 57.4 percent, W5
sect. 9). The `--select` flag's own help says so. An agent selector is the
second step and is not built: human selection through `rfa task verify` and the
Tasks tab already exists, and a selector that loses coverage is not worth
automating before the manual version is understood.

There is no clock verdict. A set nobody selects stays `awaiting_selection`
forever, exactly as an unverified completion stays pending forever under 10.4,
and for the same reason: an automatic pick is a verdict produced by a clock.
`rfa task candidates` lists them and the dashboard counts them.

### 4.4 Room-log hygiene

A candidate posts nothing. The whole set produces at most three room events for
one task: `working` at pickup, one `input_required` note naming how many
candidates are ready and what they cost, and the completion. A one-candidate
task produces two, so the fan-out costs the room exactly one extra line.

One honest exception, not blocked: a candidate that makes a nested ask makes a
REAL ask, so N candidates can produce N asks. Blocking it would make candidates
behave differently from the run they are standing in for, which would make the
whole exercise measure the wrong thing. The `--candidates` help says the room
may see up to N consultations.

### 4.5 How a task asks for candidates

Three surfaces were possible (a flag on `rfa task create`, a pack field, a room
policy). Two are built and the third is not:

- **`rfa task create --candidates N [--select ...]`**, the per-task ask. This is
  the one that matters, because candidate parallelism is expensive and belongs
  on the one hard task rather than on every task.
- **`candidates: N` in `agent.md`**, the pack default, gated exactly like
  `concurrency` (and additionally requiring `concurrency >= candidates`, since N
  candidates is N CLI child processes and the pack has to have said so).
- **A room policy: not built.** A room policy is wire surface (wire 5.1 owns the
  policy set and Appendix B owns the defaults), and this rung adds no wire
  surface. Noted so nobody reads its absence as an oversight.

**The flag states N's cost at the point of use**, because N candidates is N
times the money for one answer and the operator is the one who pays. `--help`
carries it, and the command prints the arithmetic against the pack's real
ceilings before it creates anything.

The request is local (there is no wire field to carry it), so it is written to
`runs.db` and read by the resident at pickup. The obvious version of that
races: the CLI writes the row after `create` returns, and the hub's event could
in principle reach the resident first. So the row is written BEFORE the create,
with a null task id, and bound to the task id immediately after; the resident
matches on task id and falls back to an unconsumed row for the same
`(room, title)`, binding it as it consumes it. No timing assumption, in either
direction. Two tasks created simultaneously with the identical title in one room
could take each other's row; either row is equally correct, and the case is
noted rather than defended against.

## 5. Observability

Every candidate run carries `candidate_set` and `candidate_index` on its `runs`
row and in its observability `extra`, so **cost per TASK is a query** and not an
inference:

```sql
SELECT candidate_set, COUNT(*), SUM(cost_usd) FROM runs
WHERE candidate_set IS NOT NULL GROUP BY candidate_set;
```

Without it the meters technically add up and answer nothing: three runs of one
task look exactly like three tasks. `rfa task candidates <id>` prints that per
set with each candidate's state and cost and the set total beside the pack's
per-day ceiling.

## 6. What this rung does NOT do

- No diversity mechanism (measured null, W5 sect. 9).
- No agent selector (second step; human selection first).
- No candidates for writing packs (rungs 5 and 6).
- No candidates for ASKS, only for tasks. An ask is a synchronous request
  against a `reply_by`; a human selection does not fit inside one, and
  `first-verified` on an ask is a latency trade that no measurement here asked
  for. Tasks are where work outlives a conversation, which is where this belongs.
- No room policy for candidates (wire surface, and this rung adds none).
- No change to the hub's advertised `spec_version`. 0.1.9 may not be advertised
  until 10.3's `resources[]` validation and intersection refusal ship, which is
  rung 7.

## 7. Reopen triggers

- **The wire-visible shape** reopens when a selector is a member the operator
  does not host: a remote or cross-org selector cannot verify what it cannot
  see, and at that point the candidates must be wire objects with a properly
  staged protocol delta and their own Appendix F rows.
- **Candidate `/memories` writes** reopen with rung 6's CoW clone.
- **An agent selector** reopens when human selection has been used enough to
  know what it is selecting ON, and with the 10-15 point coverage cost measured
  on this repository's own evals rather than carried from the literature.
