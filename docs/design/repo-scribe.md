# The repo scribe: the external working repository, designed

> **STATUS 2026-08-28: REVIEWED, NOT READY. Do not build from this note yet.**
>
> Two adversarial reviews (buildability, and governance honesty) read it against the
> code and returned twelve BLOCKING findings, seven important and three minor. The
> corrections were not applied: three separate attempts to apply them died, twice to
> the machine sleeping and once to an agent stalling, and patching a note this size
> through a fourth attempt is worse than saying plainly where it stands.
>
> **What survived review and is worth keeping.** D1's workspace decision, which is
> MEASURED on this repository rather than argued: a git worktree costs 0.108 s and
> materializes 245 files, a copy-on-write clone of the working directory costs 2.565 s
> and 17,580 files, and the worktree's admin state lands OUTSIDE the run's allow root
> with only a pointer file inside it. The inversion behind it holds: the research
> rejected worktrees for PACK trees because a pack's mutable bulk is gitignored, and a
> source repository is the opposite case, so "materializes tracked files only" flips
> from defect to selection. D2's boundary, where the operator GRANTS a workspace and
> the pack only names the grant, on the reasoning that a pack file is data and rung 5
> exists because a pack could write the hub directory. And D7, which the governance
> reviewer called the strongest section: it treats a confident falsehood written into
> the evidence record as the central design problem, is honest that a diff shows what
> changed and never why, and draws the conclusion that shrinks the job.
>
> **What does not hold.** The pack as sketched cannot reach four of the seven inputs
> D7 is built on; its `role: observer` binding cannot send the room message section 5
> uses for delivery, because the hub refuses send for a non-participant; `serve: false`
> is called "the strong one, because it removes the channel" and is inert in the
> resident; the `workspace` key it declares is silently STRIPPED by the schema, which
> is a plain `z.object` with no `.strict()`, verified by running the section 11 pack
> through `parseAgentMd`; and rung 8a claims to need no schema change while nothing in
> it carries the repository path to the run.
>
> **The three findings worth reading even if the note is never built.** Nothing
> constrains the scribe's `Edit` of the ledger to APPENDING, and the larger damage to
> an evidence record is silently altering or deleting a true entry rather than adding a
> false one. The note is organized around the risk of a wrong entry and never says what
> happens the first time a human APPROVES one: no retraction procedure, no way to
> enumerate which merged entries a given run authored. And D6's claim that the
> provenance mark survives promotion is contradicted by the note's own flow.
>
> Full findings are in this session's workflow transcript. Rebuilding this note should
> start from D1, D2 and D7 and re-derive everything downstream of the pack sketch.


Written 2026-08-28, before any edit, in the shape rungs 3, 4, 5 and 7 established. This
one differs from those four in a way worth stating at the top: **there is no rung to
build yet.** The shape it designs is the row parked in
[spec/RFA-0.8-concurrency.md](../../spec/RFA-0.8-concurrency.md) Appendix A as "an
external working repository as the run workspace", whose trigger is "a pack whose work is
a repository the operator owns rather than the pack's own tree". The trigger has arrived:
the owner wants an agent that keeps `docs/LEDGER.md` and `STATUS.md` current, work a human
has done by hand six or seven times in the last two days. So this note is the design pass
Appendix A says that row needs, and section 10 below names the spec text it owes.

The normative sources read before deciding anything: RFA-0.8 sects. 8.1, 8.2 and 9, its
Appendix A and Appendix B, and [rung5-writefence.md](rung5-writefence.md). Where this note
and a spec disagree, the spec governs and this note is wrong.

---

## 0. The verdict, before the reasoning

| # | Question | Verdict |
|---|---|---|
| D1 | Where does a run write? | A **git worktree** of the operator's repository, one per run, at `agents/<pack>/workspaces/<runId>/`. The CoW clone of 8.1 loses here, and the reason 8.1 rejected worktrees inverts |
| D2 | How is the boundary declared? | The **operator grants** a workspace by name with `rfa workspace add`; the pack names the GRANT, never a path. Same shape as `secrets` |
| D3 | What do the two doors become? | **One allow root per run**, and for a workspace run it is the worktree. Door one gains a repo-relative file allowlist beside the path guard. The pack tree, `.rfa/`, the operator's own checkout and the worktree's `.git` pointer all stay denied |
| D4 | What lands, and how is it reviewed? | **Propose only**, and the unit is a **commit on a branch in the operator's own repository**, not a diff in an approval card. The card is adopted for the *substance* of the owner's instinct and argued against as the *mechanism*, in section 5 |
| D5 | What may it touch? | An allowlist carried by the GRANT: `docs/LEDGER.md` and `STATUS.md`. `spec/` and `CLAUDE.md` are OUT, and stay out |
| D6 | How is an agent-authored entry marked? | The **branch is the quarantine and the merge is the promotion**, mirroring the memory gate. The durable mark is a commit trailer; the visible mark is prose a human may rewrite |
| D7 | What does it learn from? | Commits and the reports, plus instrument rows the resident injects. It can write the EVIDENCE half of a ledger entry and must refuse the REASON half, which is where the ledger's value actually lives |
| D8 | What must it never do? | Section 9, one mechanism per prohibition, none of them a request in a prompt |
| D9 | Who supplies that input? | A **host-side input renderer**, RFA code outside the model's reach, because the pack can reach none of those sources itself. It is the trust boundary for every citation the model can produce, and it is the bulk of rung 8a |

The first shippable slice is **rung 8a**: RFA renders the input, and the scribe writes a
worksheet into its own `scratch/<runId>`. It needs no spec change, no schema change and no
fence change, and it is nonetheless the LARGEST of the four rungs rather than the smallest,
because D9's renderer is in it. Section 12 has the ladder.

---

## 1. Why this pack is different from every writing pack so far

Three facts, and each one is why a design pass exists instead of a pack file.

**Every writing pack so far has been a throwaway.** The ledger's rung 6 entry records the
census: on 2026-08-26 the instance ran `pm-agent` (`Read, Grep, Glob`) and `linear-scribe`
(whose one acting tool writes to a remote SaaS workspace), and the only pack that ever
declared a guarded built-in was `filer`, built for `npm run fence-proof` and deleted with
its temp hub directory. So rung 5's two-door fence is proven by a synthetic probe doing
synthetic work. This pack is the first real load on it.

**The workspace is outside the hub directory entirely.** The pack lives at
`~/rfa/acme/agents/repo-scribe/`; the repository is `~/Dev/agent-com`. Nothing in the pack
schema, in 8.1's subtree map, or in either door of the fence contemplates a writable
surface outside the hub directory. 8.1's map is a map of PACK SUBTREES; rung 6a and 6b are
both about the pack's own tree, which section 15 says in as many words, and 8.2's
repository-ownership decision deliberately does not settle this shape.

**The output is the project's evidence record.** `docs/LEDGER.md` says of itself that it
holds "evidence, not vibes", and its authority comes from every entry being true. A memory
file that acquires a false fact costs an answer; a ledger that acquires a false finding
costs the next session's reasoning about what is already known. That asymmetry is why D6
and D7 are the two decisions this note spends the most words on, and why D7 concludes that
the honest scope of the agent is smaller than the job as stated.

---

## 2. D1. The workspace is a git worktree, and 8.1's rejection inverts here

**Verdict: one `git worktree` per run, checked out on a run branch, at
`agents/<pack>/workspaces/<runId>/`, created before the turn and removed after it.**

Appendix A rejects "git worktree as the pack workspace mechanism" with the reason
"worktrees materialize tracked files only; pack bulk is gitignored by design", and gives
the reopen trigger as "a pack layout change that tracks the mutable surfaces". That reason
is sound and it is about PACK trees. A source repository is the opposite case by
construction: its content IS its tracked set, so "materializes tracked files only" stops
being the defect and becomes the selection. The row is not being relitigated; a different
subject is being decided, and section 10 makes the spec say which is which.

Measured on this repository on 2026-08-28, macOS/APFS, git 2.50.1, both paths on one
volume:

| | `git worktree add` | `cp -Rc` of the working directory |
|---|---|---|
| Wall clock | 0.108 s | 2.565 s |
| Files materialized | 245 | 17,580 |
| Bytes | 6.5 M | 815 M |
| What arrives | exactly the tracked set at a named commit | the tracked set, plus `node_modules` (482 M), plus `.git` (121 M), plus `dist/` and `reports/` |
| Merge-back unit | a branch in the operator's own repository | a second repository at a path the operator was never told about |

The clone is not merely slower. Three things make it wrong here rather than expensive:

1. **There is no subtree map for someone else's repository.** 8.1's map is what makes a
   pack clone safe: it names, row by row, what is cloned, what is excluded and why. For
   `~/Dev/agent-com` there is no such map and RFA has no standing to write one, so a clone
   copies whatever is on disk, including build output and a `node_modules` the run has no
   business holding.
2. **Copying a live `.git` is 8.1's own torn-database hazard one layer up.** 8.1 excludes
   `state/` from the clone because "a mid-transaction CoW copy of a WAL database captures a
   torn db/-wal/-shm triple". A `.git` copied while the operator's own git is mid-write
   captures `index.lock` and a possibly torn index or ref update. The clone would need the
   same exclusion discipline, which is to say it would need the map it does not have.
3. **A copied repository's merge-back is a fetch from a directory nobody knows exists.**
   That is the wedge 8.2 item 6 was written about: the operator cannot act through
   machinery they were never told about, so the exit has to be a command they can run. A
   worktree has no such problem, because the branch it commits to is already a branch in
   their repository and `git log`, `git diff` and every review tool they own already see it.

Two smaller alternatives, recorded so they stay rejected:

- **A local `git clone --shared` under the hub directory.** It avoids writing into the
  operator's `.git` at setup, and it buys a real hazard in exchange: a `--shared` clone
  borrows the source's object store, and a `git gc` in the source can break it. Trading a
  visible administrative file for an invisible corruption mode is the wrong direction.
- **`rfa knowledge add` on the repository, and write nowhere.** The knowledge lane already
  turns a git remote into a tracked clone under the pack. It is fast-forward only and
  read-only by design, so it serves the READ half and forbids the write half, and it would
  put a second copy of every spec file on disk against the one-fact-one-file rule. It is
  the right mechanism for a pack that only reads, which is exactly what the spec-citation
  sibling of section 13 is.

**What the worktree costs the operator, stated rather than discovered.** `git worktree add`
writes `<repo>/.git/worktrees/<id>/` (HEAD, index, commondir, gitdir) and a 66-byte `.git`
POINTER FILE in the worktree. So the run's administrative git state, index included, lives
OUTSIDE the run's writable surface, which is a property D3 leans on. The operator's
repository already carries worktrees from other tooling (Claude Code keeps its own under
`.claude/worktrees/`), so RFA's must be namespaced to be tellable apart, and pruning is a
shared concern: `git worktree prune` is a command the operator may run at any time, and a
run whose worktree is pruned under it must fail rather than write into a stale path.

**Tracked-only cuts both ways, and it cuts this design.** The property that wins the table
above also guarantees that `reports/latest.md` and `reports/latest.json` are NOT in the
worktree: `reports/` is gitignored, so no copy of it is ever materialized. Reading the e2e
reports therefore means reading the operator's LIVE checkout by absolute path, against a
working tree that may sit at a different commit than the worktree's base. That is a read into
the one directory D3 names in `denyWrite` and section 9 calls the single largest safety gain
of D1, and the gain is about WRITES. The decision is taken in D7's read-set paragraph rather
than left implicit here: the two reports stay in the input set as a named read-only exception,
listed by path, with their mtimes disclosed on the proposal, and "the run cannot touch
`~/Dev/agent-com` at all" is narrowed to "cannot WRITE into it".

**Where the worktree lives.** Under the pack, at `agents/<pack>/workspaces/<runId>/`, not
under `.rfa/`. 8.1's map says `.rfa/` is "never visible to runs", and putting a run's
writable surface there would contradict the one line of the map that is unconditional. The
pack tree keeps the property every existing mechanism already assumes (retire archives one
directory, `scanPacks` scans one directory, the fence's deny list names one directory), and
the map gains one EXCLUDED row instead of the hub gaining a new top-level concept. It also
inherits a scar: `templates/gitignore` and `GITIGNORE_LINES` in `src/migrate.ts` were found
on 2026-08-26 to be missing `agents/*/memory/` and `agents/*/scratch/`, so an operator
versioning their hub directory was tracking both. `agents/*/workspaces/` goes into both
lists in the same rung that creates the directory, or the same defect ships a third time.

---

## 3. D2. The operator grants a workspace; the pack names the grant

**Verdict: the pack declares `workspace: <name>`, a name and never a path.
`.rfa/workspaces.json` maps the name to a path, and only `rfa workspace add` writes it.**

The question the prompt asks is the right one: what stops a pack from declaring someone
else's checkout, or a path it has no business in? The answer cannot be validation of the
path the pack names, because **a pack file is data, and this platform already knows it**.
Rung 5 exists because a pack declaring `Write` with no `interrupt_on` rule was `read-only`
by `agentPosture()`'s definition and could write the whole hub directory, pack files
included. A design in which a pack's own text names its writable surface is a design in
which the first successful escape rewrites the fence. So the pack's declaration must be an
INDEX into something the operator wrote, not a path.

The shape already exists in this project and is worth copying exactly: a pack's `secrets`
block names secret NAMES; the values live in `.rfa/secrets.json` in the hub root, which the
2026-08-23 cwd change put outside a resident's reach. `workspace` is the same sentence
about a different resource.

What `rfa workspace add <name> --path <abs> --allow <glob>...` validates before it writes:

1. the path resolves (realpath) and is the ROOT of a git work tree, checked by
   `git rev-parse --show-toplevel` returning the same resolved path. A subdirectory of a
   repository is refused by name, because a worktree is a whole-repository object and a
   grant that looks narrower than it is would be a lie;
2. it is not inside the hub directory, and does not contain the hub directory. Either would
   let a "workspace" swallow `.rfa/`;
3. it is not inside any pack tree;
4. it is owned by the invoking user (uid), which is the only cheap mechanical answer to
   "someone else's checkout" on a shared host;
5. no in-progress git operation (rebase, merge, bisect, cherry-pick) is live in it;
6. the `--allow` set is non-empty and every entry is repo-relative with no `..`. A grant
   with no allowlist is refused, so the permissive case is unreachable rather than default;
7. the command prints the whole grant and what it permits before writing it, because this
   is the moment the operator is actually deciding.

Resolution is a startup check, not a schema check, and it fails closed: a resident whose
pack names a grant that does not resolve refuses to boot, exactly as a writing pack whose
fence cannot establish refuses to boot. The schema can see the NAME's shape; it cannot see
`.rfa/`, and pretending otherwise is how a gate becomes decoration (the sect. 10 gate 2
lesson, where the resident granted all six memory verbs unconditionally so no pack could
ever have passed).

**The field does not exist until 8b builds it, and the schema will not say so.**
`agentDefSchema` in `src/agentdef.ts` is a plain `z.object` with no `.strict()` and no
catchall, so an unknown key is STRIPPED and not refused: a pack carrying `workspace: agent-com`
parses clean today, and the parsed definition simply has no `workspace` on it. That is exactly
the defect the `sandbox.isolation` comment records a few lines above it in the same file, where
the enum accepted `worktree` and `container` while no production module read the value. So two
things follow. The section 11 sketch's `workspace:` line is annotated as 8b-only and is a
silent no-op before then. And 8b's schema change lands as a hard REFUSAL rather than as an
optional field with a runtime lookup: a pack naming a grant that does not resolve in
`.rfa/workspaces.json` fails `parseAgentMd`, and a pack naming a workspace with no declared
write surface is a definition error. An optional field with a lookup would reproduce the
inert-field failure one rung later, in a place that decides where a model may write.

**`sandbox.cwd` is the path-in-the-pack field that already exists, and the argument above does
not cover it.** The argument is that a pack may not name a path. The schema already lets it:
`sandbox.cwd` is `z.string().optional()` with no validation at all, and the resident resolves
it as `path.resolve(HUB_ROOT, pack.def.sandbox.cwd)` into `BRAIN_CWD`, so an absolute path or a
`../..` chain in a pack file sets the resident's cwd and, with it, the MCP root the SDK
advertises to every server it starts. That is the hole the 2026-08-23 cwd change closed for the
hub root, reopened by a field nobody looked at since.

The decision: **8b validates it and does not remove it.** Removing it would break the base that
`knowledgePath` renders against, which is the two-readers-of-one-base disagreement that cost
three days on 2026-08-26. So the field stays and gains the validation it never had (it must
resolve inside the pack directory, refused at `parseAgentMd` otherwise). D2's argument holds as
stated for the WRITABLE surface; the read and MCP-root surface is named here as an open hole
with its own repair rather than left implied. Until that validation lands, a pack file can
still point a resident's read surface anywhere, which is risk 2 with a mechanism attached.

**The grant is a WRITE grant.** It bounds where a run may write and bounds nothing about what a
run may read: `Read` is bare in `allowedTools` and never reaches door one (risk 2, and D7's
read-set paragraph). A READ grant is a separate and unbuilt thing, and section 10 says whether
the spec owes one.

**Rejected: a path in the pack with validation.** It is one edit away from being wrong, and
the edit is the exact capability rung 5 was built to remove. **Rejected: a path in
`rfa.json`.** `rfa.json` is in the hub directory root, which is operator-visible and
operator-editable, but it is also the file the onboarding writes and the one a future
`rfa init` template touches; `.rfa/` is where hub-owned state lives and where a run cannot
read it.

---

## 4. D3. The fence: one allow root per run, and it moves

Rung 5's fence was built with one shape in mind: the allow root is
`<pack>/scratch/<runId>`, which sits INSIDE the pack tree. Both doors change here, and the
change is smaller than it looks because rung 5 already made the base per-run.

**Door two.** The policy on every workspace run's `query()`:

```
cwd:     <pack>/workspaces/<runId>        // the worktree. The cwd grant is what opens it (A2)
sandbox: {
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,        // probe J: the default leaves the handle on the inside
  autoAllowBashIfSandboxed: true,         // what sandboxPolicy() already passes; not a new choice
  filesystem: {
    allowWrite: [<worktree>],             // declared for defence in depth, never relied on (A2)
    denyWrite: [
      <worktree>/.git,                    // the pointer file: repointing it is the one git write inside the root
      ...every path INSIDE the worktree the grant's allowlist does not permit,
         COMPUTED from the grant (so: `CLAUDE.md`, `spec/`, `docs/design/`, `src/` …),
      <pack>/state, <pack>/knowledge, <pack>/memory, <pack>/scratch,
      <hub>/.rfa,
      <repo root>, <repo root>/.git,      // the operator's OWN checkout, named though already outside
    ],                                    // filtered of any entry containing the allow root (A3)
  },
}
```

**Door two's deny list is COMPUTED from the grant, and that is the whole of the fix.** The
first draft of this block hand-listed the pack's subdirectories and the operator's checkout
and left the worktree's own contents alone. That left `CLAUDE.md` and `spec/` sitting INSIDE
the allow root with nothing denying them, while section 6 claimed "both doors say it": one of
the two sentences was wrong, and a reader implementing from the sketch would have got the
weaker one. Deny beats allow within srt's allow-only model (probe H case G), which is what
makes the carve-out expressible at all, so the rule is stated as a rule rather than as a list:
door two denies every path inside the allow root that the grant's allowlist does not permit,
derived from the grant at run start. Widening the allowlist then cannot silently widen door
two, and the two doors cannot drift apart through an edit in one of them.

**What this costs `sandboxPolicy()` in `src/writefence.ts`.** Its signature today is
`{ scratchDir, denyWrite }` and it always sets `autoAllowBashIfSandboxed: true`; the policy
above is the same function with `scratchDir` renamed to an allow-root parameter and every
caller updated. Its existing ancestor filter (an entry containing the allow root is dropped
rather than silently kept) is already what A3 needs and does not change. Two things in the
block are UNMEASURED, and 8b owes a probe for each, in the same list and for the same reason:
whether an `allowWrite` entry opens a SECOND root while a cwd grant is in force, and whether
srt's `denyWrite` accepts a FILE path at all, since `<worktree>/.git` is a file in a worktree
and not a directory. A `denyWrite` entry the runtime ignores is a silent no-op, which is the
class of defect this project has already recorded twice.

**Which cwd wins on a workspace run.** `runCwd()` returns the run's scratch for a writing pack
and `BRAIN_CWD` otherwise, and `BRAIN_CWD` is `sandbox.cwd` when the pack declares one. On a
workspace run the WORKTREE wins and `sandbox.cwd` loses, because the cwd IS the allow root and
a pack that could move it could move the fence. The loser is not overridden silently, which is
the failure mode this note keeps finding elsewhere: a pack declaring both `workspace` and
`sandbox.cwd` is a STARTUP REFUSAL naming both, in the same fail-closed shape as an
unresolvable grant.

Three consequences, each stated because each is easy to get wrong:

- **The pack tree is no longer the allow root's parent.** At rung 5 the pack tree was
  "denied by construction" only in the sense that allow-only denies everything outside the
  scratch, and the scratch was inside it. Now the allow root is a sibling of nothing in the
  pack, so the pack tree is denied plainly. The deny entries above are still named, for the
  reason rung 5 named them: `allowWrite` opens nothing on its own, so the deny list is
  insurance against a future cwd change, and an entry that costs nothing today is the one
  that catches that change.
- **The operator's own checkout is outside the allow root and is named anyway.** This is
  the strongest single argument for the worktree over running in the repository directly:
  the run cannot touch `~/Dev/agent-com` at all, so an uncommitted edit of the operator's
  cannot be clobbered by a model, only conflicted with by a merge the operator performs.
- **There is exactly ONE allow root, and the scratch is not a second one.** Probes F and G
  measured that `filesystem.allowWrite` did not open a path through any of four routes; what
  nobody has measured is whether an `allowWrite` entry opens a SECOND root while a cwd grant
  is already in force. This design assumes it does not, which is the safe direction, so a
  workspace run has no scratch surface: intermediate files go in the worktree and are simply
  never committed. If a later rung needs two roots, it probes first and does not reason from
  A2's wording. Note that this is a DECISION and not a description of the code: the resident
  mints a scratch unconditionally for every writing-pack run today, and keeps it whenever it is
  non-empty, so 8b has to branch that mint site (named in section 12).

**Door one.** The per-run path guard gains a second test and keeps everything else:

1. realpath of the target, and of the nearest existing ancestor with the remainder rejoined,
   resolves inside THIS run's worktree. Unchanged in mechanism, including the reason
   (the `/var` to `/private/var` symlink incident) and the rule that a guarded built-in whose
   target field is unknown is DENIED, never allowed;
2. **new:** the target's repo-relative path matches the GRANT's allowlist. This is where D5
   is enforced, at the tool, in the same place the surface is enforced, so a reader of the
   refusal sees one rule and not two systems;
3. **new:** the target is not `.git` and not under it;
4. the claim fence, unchanged.

The refusal keeps rung 5's form: it names the surface the model may write and repeats the
path it tried, and the allowlist refusal additionally names the allowed files, because "not
allowed" without the list makes the model guess and guessing costs turns.

**What does not change, and must not.** Door one still does not replace a card the pack
asked for, and still does not exempt plan mode. Plan mode's refusal is why the pack in
section 11 is `ask` and not `plan`: "propose, never act" refuses a guarded built-in even
into the run's own private directory, so a writing pack in plan mode cannot write anything
at all, and the propose-only property of D4 is bought by the branch, not by the mode.

---

## 5. D4. Propose only, and the argument with the default

**Verdict: propose only, adopted. The unit of review is a commit on a branch in the
operator's own repository, with a rendered diff beside it. The approval card is NOT the
review unit, and this is where I argue with the owner's instinct rather than adopting it
whole.**

The instinct is right about the thing that matters: nothing lands without a human seeing
the diff. What I disagree with is routing that review through `interrupt_on` the way
`linear-scribe` does, for four reasons that are measurements or shipped behaviour rather
than taste.

1. **The card's clock is the wrong clock.** `approvalWindowMs` derives the window from the
   asker's own `reply_by` and falls back to thirty minutes, and the comment above it records
   the live scar: the card must never outlive its audience. Reviewing a findings entry for
   TRUTH is a human reading prose against their own memory of the week, which is a
   minutes-to-hours job and often a tomorrow-morning job. Sizing that to a room deadline
   either expires the review or stretches a room deadline into something it is not.
2. **A blocked card holds a turn open, and the code says which part of it is actually held.**
   The first draft of this reason said the parked run holds a slot. It does not, and the
   correction is worth carrying: `withSlotParked` (`src/resident.ts:277`, RFA-0.8 sect. 6.3)
   parks the lease successfully for the first blocked turn in the process, so a
   `concurrency: 1` scribe's single turn RELEASES its slot for the wait and takes one back
   after. What is held is the SDK session and the serve loop behind it, for a run that has
   nothing left to do. And the wait cannot be long anyway: `waitForDecision` runs to a hard
   deadline of `timeoutMs + 5_000` (`src/bridge.ts:232`), so an overnight review is not
   merely expensive, it is unreachable: the card expires and the write comes back
   `deadline_expired`. Which makes this a second instance of reason 1 rather than an
   independent reason, and that is the honest way to count it.
3. **The granularity is wrong.** `interrupt_on` fires per tool call. A proposal touching two
   files is two cards, and each card asks a human to approve a WRITE, which is mechanism. The
   decision that matters is one decision over the whole entry's content.
4. **Rung 5 already separated these two things and said so:** the fence "narrows where a
   write may land; it never widens who may authorize one". Cards and fences are orthogonal,
   and using the card as the review gate conflates them.

So the flow is: the run writes into its worktree, the run ends, and the RESIDENT (host side,
outside the model's reach) commits the allowlisted paths to a branch `rfa/scribe/<runId>`,
then removes the worktree. The proposal that reaches the operator is an `rfa scribe ls` /
`rfa scribe show` row and the dashboard row that calls the same function, carrying: the
branch name, the base commit, the diffstat, the number of existing lines the change touches
(D5), the input range, the live paths read with their mtimes (D7), the validator results,
and the run's cost. The human reviews with their own git. Nothing merges.

**The delivery channel is NOT a room message, and that is forced by the binding rather than
chosen.** The pack's binding is `role: observer` (section 11), and the hub refuses a send from
any member whose role is not `participant`: `src/store.ts:1534` throws `unauthorized` with
"observers and supervisors are read-only on the message plane". An earlier draft of this
paragraph had the proposal arriving as a room message, which would have 401'd on every run.
The same refusal covers task actions (`src/store.ts:2831`, "observers cannot act on tasks"),
so an operator TASK cannot be the trigger either: the trigger is a cron schedule, and D8's
trigger row says so. Keeping the observer role and losing the room message is the deliberate
trade, because the observer role is what makes D8's injection row structural at the hub.
One consequence to carry into 8b rather than discover: the resident sends a
definition-change status message into the room at boot, just after the fence block, and for
an observer pack that send fails with the same 401 on every definition edit. 8b either
tolerates it as a logged non-fatal or skips the send for a non-participant binding, and the
note is not deciding which here beyond saying it must not be a boot failure.

**Why a branch and not a patch file in scratch:** a patch file is a third artifact with no
home, invisible to every tool the human reviews with, and it dies with the scratch. **Why
`refs/heads/rfa/scribe/*` and not a private `refs/rfa/*` namespace:** the private namespace
keeps `git branch` tidy and is invisible to `git log --all`, gitk, and any forge, which
defeats the entire point of proposing. Tidiness loses to reviewability. **Why the resident
commits and not the model:** door two is the only door for Bash, a git command's write set
cannot be traced from its arguments, and the index lives outside the allow root anyway. The
model edits files; RFA turns files into a commit. That is also what lets the commit trailer
of D6 be trustworthy, since the model never writes it.

**When the repository moved under the run.** Four cases and one rule, which is that
staleness is DISCLOSED and never repaired:

| State | What happens |
|---|---|
| `main` advanced while the run was in flight | The proposal records `base_commit` and the input range. The review renders how far behind the branch's base is at review time. The scribe's picture of "what changed" is honest about its own boundary, and a human deciding to re-run is cheaper than a machine deciding to re-derive |
| The operator's tree was dirty at worktree creation | Not a refusal. The worktree is a copy at a commit, so nothing WRITABLE is at risk, and the proposal records the dirty paths. What it must NOT say is "the run saw committed history only": the run also read the live `reports/latest.*` out of the operator's checkout (D7's read set), so the proposal lists those paths with their mtimes and states that everything else it saw was committed history at `base_commit` |
| A rebase, merge, bisect or cherry-pick is in progress | Refuse to start, and say which. Creating branches and worktrees against a repository mid-operation is how a tool ends up being blamed for a state it did not create |
| The worktree was pruned or the path vanished under the run | The run fails. It does not re-create the worktree, because a surface that reappears after being removed is not a fence |

**The one thing I am NOT proposing:** any landing automation. There is no merge path in the
code at these rungs. If one is ever wanted it is a separate rung with the card in its right
place, and the card's principal is the OPERATOR approving a merge, not a model approving a
write.

---

## 6. D5. The allowlist, and why `spec/` and `CLAUDE.md` are out

**Verdict: the grant carries the allowlist, and at the first grant it is exactly
`docs/LEDGER.md` and `STATUS.md`.** It is an allowlist and never a denylist, for the reason
the SDK's `tools` option is a list and not a preset: listing what is permitted makes
everything else absent, including a file that does not exist yet.

**`spec/` is OUT, and should stay out even when the scribe is trusted.** Three reasons, and
the third is the one that generalizes. The specs are normative documents with a changelog
discipline, cross-document citation conventions and a rule that a bare section number is
ambiguous across files. Editing one changes what the project MEANS, not what it records.
Second, this week produced a phantom "v0.5 sect. 14", a "five items" that were six (the
defect that forced the A1-A6 relabelling), and two stale descriptions of what `rfa init`
seeds: those are exactly the class of error an agent with citation confidence produces, so
the specs are the file where an agent's failure mode is most expensive. Third, RFA-0.8
carries no status markers BY DESIGN under a single-writer status rule; an agent editing spec
text would be that rule's first violation, and the rule is the repair for two documented
incidents.

**`CLAUDE.md` is OUT, and this is the most important line in the allowlist.** It is the
instruction file that steers this agent and every future session in this repository. An
agent that can edit its own operating instructions is a self-modifying prompt, and the
project's own doctrine already refuses that shape one level down: destructive memory verbs
belong to the consolidation lane, and `rfa agent reflect` PROPOSES by default because
`--apply` "is a memory change that moves behaviour like a definition change". CLAUDE.md is
the same class of artifact with a larger blast radius, since the untrusted input of D7
(commit messages, diffs) would have a durable channel into every later session. It is
excluded by the allowlist and named in door two's deny list as well, so both doors say it.

**`STATUS.md` is IN, and its cap is a design input, not a footnote.**
`test/statusclaims.test.ts` fails the file past 250 lines, and it also pins load-bearing wire
Appendix F rows to greppable code anchors. So a proposal touching STATUS.md must be
validated against both, and section 12's rung 8c owes that validator. Note what cannot be
done and must not be claimed: the repository's own gates cannot run inside a bare worktree,
because `node_modules` is untracked and an `npm ci` per run is not a cost this pays.
Symlinking `node_modules` into the worktree was considered and rejected: a symlink out of the
allow root is precisely the traversal shape door one's realpath comparison exists to refuse,
and building a deliberate one into the workspace is arguing with your own fence. So RFA runs
the checks it can honestly run (the line cap, the anchors' presence, links resolving, no em
dash, the citation rule of D7) and the proposal says which gates a HUMAN still owes. An
instrument that implied it had run `npm test` would be the same defect as the `def` column
printing the on-disk hash as if served.

**The allowlist says which files, and it must also say which LINES.** Everything above is
about adding a false entry, which is the smaller damage. The larger damage to an evidence
record is silently altering or deleting a true one, and `Edit` on an allowlisted file can
rewrite any line in a file this long. Every validator rung 8c owes inspects the NEW prose,
so all of them are blind to a one-word change two hundred lines down, in a diff whose top a
human is reading because the entry is there. So the grant carries a shape per file, enforced
HOST-SIDE on the rendered diff by the resident's commit builder and never in the prompt:

- **`docs/LEDGER.md` is APPEND-ONLY**, in the prepend-at-the-top sense the file actually
  has. The change MUST consist of inserted lines only: zero deleted lines and zero modified
  lines anywhere in the file. A proposal that fails this is not committed, and the resident
  says which existing lines the model touched.
- **`STATUS.md` is edited in place and gets the weaker form**, which has to be a list rather
  than a rule because the file is genuinely rewritten line by line: a proposal may touch the
  rung status lines and the date line, and may not touch the decisions-in-force prose or the
  open-items prose. Same host-side check, same refusal.
- **The proposal prints the count of existing lines touched as its own line**, zero for a
  clean ledger append. A human reviewing a diff sees a zero rather than having to notice the
  absence of a number, which is the difference between a check and a hope.

**`docs/HISTORY.md` is the named candidate for the first widening**, with its trigger: it is
the same job (a rung's story moves there when the rung flips) and it is excluded now only
because the anti-accretion rule says that move happens in the same commit as the flip, which
is a human's commit today.

---

## 7. D6. Provenance: the branch is the quarantine, the merge is the promotion

The governance question is the right one, and the project already has a posture for it. The
memory gate's shape for a write it cannot yet trust is defer, review, admit: a `/memories`
write attributed to a non-local requester is recorded with its hub-derived provenance in
`.provenance.json`, withheld from OTHER turns' retrieval, and promoted by the consolidation
lane, and `promote()` flips `quarantined` to false while KEEPING the record. Three properties
transfer exactly:

1. **Quarantine is a place, not a flag.** For memory it is the retrieval path; here it is the
   branch. An agent-authored entry is not in `docs/LEDGER.md` until a human merges it, and
   nothing in RFA can merge it.
2. **Promotion is somebody else's act.** The consolidation lane promotes a memory write; the
   operator merges a branch. Neither is the writer.
3. **The mark survives SOME merges, and the expected ones are not among them.** The first
   draft of this property said "the mark survives promotion" flatly, and the note's own flow
   is the counter-example, so here is the honest version. There are two marks with different
   lifetimes:
   - **The durable mark is a commit trailer.** RFA's commit carries `Rfa-Scribe-Run: <runId>`
     and `Rfa-Scribe-Input: <base>..<head>` beside the project's existing `Co-Authored-By`
     convention. It is written by the resident, which the model cannot reach, and no later
     edit of the prose can change it without rewriting history.
   - **The visible mark is one line in the entry**, naming the run and the input range. It is
     expected to be EDITED, because a human who rewrites the entry into ledger voice is
     rewriting the sentence around it, and pretending otherwise produces a mark people learn
     to skip.

   **Which merge shapes preserve the trailer:** a fast-forward and a true merge commit
   preserve it, because the scribe's own commit stays in the graph. **Which destroy it:** a
   squash merge, a rebase with reword, a cherry-pick of the text, and the plainest case of
   all, a human copying the worksheet's prose into their own commit. D4's expected path is a
   human who rewrites the entry into ledger voice, and D7 says the human's job is converting
   a worksheet, so the DESTROYING shapes are the expected ones. Add the top-of-file conflict
   of risk 3, whose resolution is re-authoring, and the realistic outcome is a merged
   `docs/LEDGER.md` carrying no mark at all.

   **So the claim is dropped rather than propped up.** A per-entry `drafted: <runId>` token
   the human is asked to keep was considered and is not adopted as a property: it is a
   convention, conventions erode, and a provenance mark that is usually absent is worse than
   none because its absence stops meaning anything. Provenance is LOST AT MERGE in the
   expected path, by design and not by oversight. What actually defends the ledger is the
   two things section 8 already leans on: the citation rule, which makes every sentence
   point at an artifact a reader can check, and the human's authorship, which is real
   authorship after a rewrite and not a rubber stamp. The trailer is kept for the case it
   does cover, which is the audit question "did a machine draft anything in this range", and
   the next paragraph says exactly how far that reaches.

**What the trailer is, and what it is not.** It is an operator-local audit handle. The
`<runId>` in it refers to a row in `<hub>/.rfa/data/runs.db`, which is gitignored per-hub
runtime state on one machine, and the obs store beside it PRUNES: `ObsStore.prune`
(`src/obs.ts:339`) deletes runs past `keepDays` unless they carry feedback or need review. So
the trailer is not a citation a repository reader can follow. A contributor who clones this
repository, or this operator after the retention window passes, reads a string whose referent
is gone. Two consequences, and both are owed by 8c rather than assumed: the commit carries a
SECOND trailer, `Rfa-Scribe-Facts: <base commit>, <input range>, <model>, <ISO date>,
<cost usd>`, so the record stands alone in the repository the trailer travels with; and the
retention rule the ledger's own "evidence, not vibes" claim needs is stated where it is
enforced, which is `ObsStore.prune`'s `keepDays` and nowhere else. A run whose proposal was
merged is feedback-bearing in exactly the sense `prune` already exempts, and 8c marks it so.

**How a reader tells an agent's claim from a measured one.** Not by the mark, which records
ORIGIN and not authority. The facts layer already models this correctly: `source_origin` is a
trust TIER (`human` > `self` > `agent`), it rides into the prompt as `[origin]` on every
consolidated line, and the block's own note tells the model that any of it may be stale. The
ledger's equivalent is the citation, and D7 makes it a rule rather than a habit: every
sentence the scribe writes carries the artifact it came from (a commit sha, a path, a run id,
an instrument's own line), and a sentence that cannot carry one is a sentence it may not
write. After a human rewrites and merges, the entry is THEIRS and its authority is theirs;
the trailer records that a machine drafted the evidence half, which is a fact about how the
text got there and nothing more.

**When a human approves a wrong entry.** The whole note is organized around this failure and
an earlier draft designed everything except it, which is the shape of a plan that assumes its
own precondition. Section 13 item 1 names the precondition (a human rewrites before merging)
and says the day that stops happening is the day this stops being safe. Here is what happens
on the day it has already happened.

1. **Retraction is an entry, not a deletion.** A merged entry found false is STRUCK in place:
   the text stays, marked retracted, with the run id, the date, and what was wrong. Deleting
   it would destroy the record of the failure, and this file is the project's memory of its
   own defects, so a ledger that quietly loses its bad entries is a ledger that has learned
   nothing. The retraction is a human's commit like any other; RFA has no write path to a
   merged file.
2. **Enumeration after the merge has one query and it is worth writing down**:
   `git log --grep=Rfa-Scribe-Run -- docs/LEDGER.md` over the file, plus the same over
   `STATUS.md`. What makes it work is the trailer surviving, and the previous property is
   blunt that the expected merge shapes destroy it. So the honest statement is that this
   query is reliable for fast-forward and true-merge landings and returns NOTHING for squashed
   or re-authored ones, and the fallback there is the operator's own `rfa scribe ls` history
   against dates, which is local and prunable. An enumeration that can come back empty for a
   run that really did land is a known hole, not a working control.
3. **One confirmed false merged entry condemns the whole run, not the sentence.** Every other
   entry and every other file from the same run id is re-reviewed, because the failure being
   diagnosed is a register collapse across a draft and not a typo in a line. Re-reviewing only
   what was caught is how a systematic fault gets recorded as an isolated one.
4. **The stop condition is a command, not a judgment.** On a confirmed false merged entry the
   operator runs `rfa workspace rm agent-com`, which makes every later run of this pack a
   startup refusal (D2's resolution fails closed), or `rfa agent retire repo-scribe` if the
   pack is done. Removing the grant is the smaller of the two and is the default, because it
   stops the writes while leaving the pack and its record intact for the post-mortem.

And the thing that must be said plainly rather than left as an implication: **a merged
falsehood is permanent in every reader's mind until somebody happens to check it**, and this
design has no detector for one. Everything above is a procedure for after a human noticed. No
part of the system notices.

---

## 8. D7. Its input, which is the central risk

The scribe cannot read a human's session. What it can read, and by what route, because the
route is the point of D9 below: **the model reaches none of these sources itself.** Its
declared tools are `Read, Grep, Glob, Write, Edit` and no `Bash`, and its whole MCP surface is
`mcp__rfa__roster`, `mcp__rfa__task_read` and the memory verbs (`src/resident.ts:766-775`), of
which the pack declares nothing. So the "Reached by" column is not decoration: every row it
marks as INJECTED is a row that exists only because host-side RFA code put it in front of the
model.

| Source | Where | Reached by | What it honestly supports | What it cannot support |
|---|---|---|---|---|
| `git log` and `git diff <base>..HEAD` | the worktree | INJECTED (D9; no `Bash`) | which files changed and by how much, when, in what order, and what the commit messages SAY | whether anything works, why it was done, what was tried and rejected |
| `docs/LEDGER.md`'s own last-touching commit | the worktree | INJECTED (D9; it is a `git log` call) | the lower bound of the range, mechanically | that the human agrees that is where the last entry stops |
| the worktree's file contents | the worktree | the model, with `Read`/`Grep`/`Glob` | what the two target files currently say, so an edit is against the real text | anything about what changed, which is the diff's job |
| `reports/latest.md`, `reports/latest.json` | the operator's checkout, gitignored | the model, by absolute path (see the read set below) | which e2e scenarios ran and how they came out, with the report's own timestamp | that they ran against the code in the range. The timestamp must be compared to the range or the report is about different code |
| `runs.db` | the hub directory's `.rfa/data/` | INJECTED: the RESIDENT queries it and renders rows. `Read` cannot parse a binary SQLite file and no declared tool can open one | runs, statuses, costs, timestamps, candidate sets, settlements | anything about the repository at all |
| the obs store | the same | INJECTED, same reason and same mechanism | latency, error rates, the review queues | causation between a change and a number |
| the room log and the task board | the hub store | INJECTED, and only if 8c adds it. The pack declares no `mcp__rfa__task_read`, and its observer binding cannot act on tasks anyway (`src/store.ts:2831`) | what was asked, what was answered, tasks and their evidence | the operator's own reasoning |
| the human's session transcript | NOWHERE | | | this is the whole point |

**Reading a live WAL database from a second process is a hazard, not a convenience.** The two
injected database rows are the resident querying `runs.db` and `obs.db` while the supervisor
and other residents are writing them (`src/engine.ts:95`, `src/obs.ts:94`, both
`journal_mode = WAL`). That is the same torn-read shape section 2 item 2 uses to argue AGAINST
the CoW clone, one layer down, and the answer is the same discipline: the read is a normal
sqlite reader inside a transaction, never a file copy, and it takes what a consistent snapshot
gives it. 8c owns those two queries and owns saying, in the rendered block, the instant the
snapshot was taken.

**The read set, stated as a set, because the grant does not bound it.** A workspace grant is a
WRITE grant (D2). Nothing in this design fences a read, so what follows is INTENT with nothing
enforcing it, which is risk 2 with its consequences written out:

1. the worktree, entire, at `base_commit`. This is the bulk of it and it is the only part that
   is fenced-adjacent, in the weak sense that it is where the cwd points;
2. exactly two absolute paths in the operator's LIVE checkout, `reports/latest.md` and
   `reports/latest.json`. They are gitignored, so section 2 already established they cannot be
   in the worktree, and reading them is a read into the one directory D3 names in `denyWrite`.
   This is a deliberate READ-ONLY exception to "the run cannot touch `~/Dev/agent-com`", which
   D1 accordingly narrows to "cannot WRITE into it". They are live files at an unknown commit,
   so the proposal lists both paths with their mtimes and D4's staleness row 2 no longer claims
   the run saw committed history only;
3. the blocks D9's renderer injects, which the model does not fetch and cannot widen;
4. nothing else, by intent, and `Read` is bare in `allowedTools` so nothing stops item 4 from
   being false. A scribe pack can read the operator's home directory today. The fix direction
   is risk 2's, it is a change to every pack, and it is not this note's.

**The range's lower bound is a watermark, and it must be monotonic.**
`git log -1 --format=%H -- docs/LEDGER.md` is the commit that last touched the ledger, and
that commit to HEAD is the range. It is the same shape as consolidation's watermark, and it
inherits the same rule rung 1 shipped: a watermark that can go backwards re-consolidates, and
one that jumps forward skips. The failure mode here is specific and should be in the
proposal's own text: if a human edits the ledger without committing, the watermark does not
move and the next run re-derives a range that is already covered.

**Now the central risk, which is not hallucination.** Handed a diff and asked for a findings
entry, a competent model will produce ledger-VOICE prose, because that is the register of the
surrounding file and matching register is what models are good at. "Found while writing the
test", "measured as probe H case G", "the first implementation reported that as inconclusive":
those sentences are the file's most valuable content and every one of them comes from a human
being surprised. A generated sentence in that voice is indistinguishable from a real one by
inspection, carries the authority of the file rather than of its content, and will be cited
by a later session as established. That is worse than an obvious hallucination, and no
validator catches it, because a citation-shaped token is trivial to produce and proves nothing
about the sentence attached to it.

Three mitigations, in decreasing order of how much I trust them:

1. **The output is a worksheet, not an entry, and it does not look like one.** The scribe
   writes a fixed template with labelled fields, and the field that holds the reason is
   `WHY (human):`, left empty. An unedited worksheet cannot be mistaken for a ledger entry
   because it is not shaped like one, and an entry with an empty WHY is visibly unfinished at
   a glance. The human's job is converting it, which is the job they were going to do anyway,
   with the gathering already done.
2. **Three registers, and the third is refused.** OBSERVED (subject is a thing in the input,
   with its citation) is allowed. REPORTED (restating what an artifact says, attributed to the
   artifact: "the commit message says") is allowed only in the attributed form. CONCLUDED
   (causation, "works", "fixed", "faster", "safe", "done") is refused. The refusal is in the
   system prompt AND in the validator, and the validator's word list is deliberately crude:
   its job is to make the boundary visible in a refusal the model can act on, not to be
   uncircumventable.
3. **Every bullet carries a citation token or the proposal is refused** (a sha of at least
   seven hex characters, a path that exists at the base commit, a run id, or an ISO timestamp).
   Weak on its own, listed third for that reason, and worth having because it makes the
   uncited sentence a visible outlier rather than a smooth one.

**What it must refuse to assert, concretely.** That a fix works, since a commit saying "fix X"
is evidence that someone wrote "fix X". That a rung is DONE, since rung status is a human's
judgment plus the gates and lives in exactly one file. Any count of tests or scenarios, since
this repository has watched a stated count rot twice and no document states one. Any number it
did not read from an instrument. Any causal link between a change and a measurement. Anything
about what a model "decided" from a log line that only shows a tool call.

**The honest conclusion, which shrinks the job.** The ledger's value is its reasons and the
reasons are not in the scribe's inputs. So the scribe does not write ledger entries. It writes
the evidence half and asks the questions the reason half needs, which is most of the typing
and none of the judgment. STATUS.md is the opposite balance: dates, rung lines, pointers and a
line cap are largely mechanical, and that is where the scribe does the whole job. Section 12's
ladder is ordered accordingly, and the acceptance measurement in section 12 measures the
saving rather than assuming it.

### 8.1 D9. The input renderer, which is host-side RFA code and the trust boundary

**Verdict: a host-side input renderer, written in RFA and outside the model's reach, runs
every command and every query the table above marks INJECTED, writes the results into the
run's own surface, and points the prompt at them. It is the largest single thing in rung 8a
and an earlier draft of this note did not mention it at all**, while claiming 8a needed "no
new surface of any kind". It needs the most load-bearing surface in the design.

The reason it must exist is mechanical rather than architectural: the pack declares no `Bash`,
so nothing in the model's hands can run `git log`; `Read` cannot parse a SQLite file; and the
pack declares no MCP tool at all. Every honesty property this note claims lives here, because
every citation the model can produce is a citation of something the renderer handed it. A
model cannot cite what it was never shown, and it cannot check what it was shown.

**What it runs, where, and what it writes.**

| Step | Command or query | Where it runs | Output |
|---|---|---|---|
| watermark | `git log -1 --format=%H -- docs/LEDGER.md` | the worktree at 8b, the operator's checkout at 8a | `base_commit` |
| range | `git log --format=… <base>..HEAD` | same | `commits.md`, one block per commit |
| diff | `git diff --stat` and `git diff <base>..HEAD` | same | `diffstat.md`, `diff.md` |
| runs | a read-only sqlite query over `.rfa/data/runs.db` | the resident's process | `runs.md`, rows with the snapshot instant |
| obs | a read-only sqlite query over `.rfa/data/obs.db` | the resident's process | `instruments.md`, same |
| reports | a file read of the two absolute paths | the operator's checkout | `reports.md`, each with the file's mtime |

All of it lands in the run's scratch at 8a and in the worktree at 8b, in a directory the model
reads and the commit builder never commits. The model's prompt names those files and nothing
else.

**Three rules, and each one is there because its absence is a specific lie the model would
tell in good faith.**

1. **A truncation is DISCLOSED, never a silent narrowing.** A long diff and a range with many
   commits both have to be cut somewhere. Whatever is cut is stated in the rendered block AND
   carried onto the proposal, in the form "the diff for `src/resident.ts` is 4,100 lines and
   the first 400 are shown". A renderer that silently shows the first N is a renderer that
   teaches the model the change was small.
2. **Every rendered block carries the artifact identifier the citation rule expects.** The
   citation rule of mitigation 3 above demands a sha, a path, a run id or an ISO timestamp per
   bullet. That is only satisfiable if the block the sentence came from carries one, so the
   renderer emits the identifier as part of the block rather than expecting the model to
   reconstruct it. A citation the model reconstructs is a citation the model can invent.
3. **A source that could not be read is NAMED as absent, never omitted.** If `reports/latest.md`
   is missing, or the obs query throws, the block says so in the place the content would have
   been, and the proposal repeats it. An input set that silently shrinks on an error produces a
   confident entry about a narrower world, which is the reassuring-instrument defect in its
   purest form and this project has recorded it three times in two days.

**What this changes about rung 8a**, and section 12 says it there too: 8a is the renderer plus
the worksheet, the renderer is the bulk of it, and 8a is the LARGEST of the four rungs rather
than the smallest. What stays true is that 8a is still the first shippable slice and still the
cheapest way to learn whether the output is worth anything, because everything it builds is
needed by every later rung and none of it touches the fence, the schema or the spec.

---

## 9. D8. What it must not do, and the mechanism for each

One row per prohibition. A prohibition whose mechanism is a sentence in a prompt is marked as
such, because there is one and it should be visible.

| Must not | Mechanism | If the mechanism were removed |
|---|---|---|
| Write outside the two allowlisted files | Door one's allowlist check, door two's allow root, and the resident's commit builder, which treats a modified path inside the worktree that is outside the grant's allowlist as a FENCE BREACH and not as a path to filter out | Three independent places; each refusal names the grant, so a reader of any one finds the others |
| Write anywhere outside its own worktree | Door two's cwd grant (allow-only), door one's realpath guard | The fence is rung 5's, unchanged, and its proof command still covers it |
| Touch the operator's actual checkout | The worktree is a different directory, so the checkout is outside the allow root; named in `denyWrite` anyway | Uncommitted operator work would be reachable by a model. This is the single largest safety gain of D1 |
| Corrupt the repository's git state | The index and all admin state live in `<repo>/.git/worktrees/<id>/`, outside the allow root; the `.git` pointer file inside is denied | A repointed `.git` file would move a future run's git operations, which is why the pointer is denied even though it opens nothing by itself |
| Commit, merge, push, or run git at all | It declares no `Bash` and no git tool. The resident commits; the resident never pushes, at any rung, because a push is a publication | A `git push` is the only operation here that leaves the building, and nothing in this design can perform one |
| Land its own work | No merge path exists in the code. The branch is the terminus | An added merge path is a new rung with a card and an operator principal, never a default |
| Edit `CLAUDE.md` or `spec/` | The allowlist, plus `CLAUDE.md` named in `denyWrite` | Section 6 |
| Take instructions from room traffic | Its binding is `role: observer`, so the hub refuses every task action (`src/store.ts:2831`, "observers cannot act on tasks") and every send (`src/store.ts:1534`). Its trigger is a cron schedule and nothing else, since an operator task is exactly what an observer cannot claim. `serve: false` is declared beside the role and is INERT today | **Not the strong row it was first drafted as.** The first draft called this the strong one "because it removes the channel rather than refusing on it", and the flag that was supposed to remove it does nothing: the resident reads `serve` only to pick WHICH binding to join (`src/resident.ts:321`) and calls `member.serve(...)` unconditionally (`src/resident.ts:2557`), while `rfa agent new` writes the comment "false makes it a listener that never answers" (`src/cli/agentmd.ts:23`) for behaviour no module implements. This is the same inert-field defect as `sandbox.isolation` and as `workspace` before 8b. So until rung 8b honours the flag, an inbound ask is READ and the turn is SPENT, and only the hub's role check stops the answer leaving, at the hub, after the money is gone. The mechanism today is one refusal at a cost of one turn; 8b's item is what makes it structural |
| Treat commit messages and diffs as instructions | A sentence in the system prompt, and the fact that it cannot act on one (its only output is prose into a branch a human reads) | **This is the prompt-only row.** Repository content is untrusted input written by whoever committed, and in a repository with more than one contributor it is an injection surface. What holds is not the prompt: it is that the blast radius of a successful injection is a paragraph in a proposal a human reads before merging |
| Reach memory destructively | `str_replace` on `blocks/*`, `delete` and `rename` reach a pack only if its `tools.allow` NAMES them. This pack names none | The sect. 10 gate 2 mechanism, unchanged |
| Spend unboundedly | `budgets.per_day_usd` and `per_task_usd`, reserved before the turn and settled after | Section 11 |
| Run two runs over one repository | `concurrency: 1`, and no candidates. Two runs publishing into one repository is 8.2's conflict lifecycle, which is not built | The schema gate refuses the pack, and section 12 keeps it at 1 until 8.2 exists |

---

## 10. The spec text this owes

Nothing here is on the wire, so **no wire Appendix F row moves**. That is the test of whether
the decision was really local, in the shape rung 4 used when it decided candidates are not
wire objects.

1. **Appendix A's parked row is replaced, not deleted.** "An external working repository as
   the run workspace" leaves the PARKED list and keeps a one-line pointer to the new section,
   in the form Appendix A already uses for a superseded row ("None; the 8.2 lifecycle
   supersedes it"). The row's own text already says the CoW mechanism transfers and its
   subtree map does not, and section 2 above is the design pass it asks for.
2. **A new section 8.3, "The external working repository"**, in
   `spec/RFA-0.8-concurrency.md`, amending v0.4 sect. 6 beside 8.1 and 8.2. It carries: the
   worktree verdict with the statement that 8.1's rejection is about pack trees and does not
   transfer to a fully tracked repository; the grant model of D2, normatively (the operator
   declares, the pack names, resolution fails closed); the branch-as-terminus rule; the
   allowlist requirement with "a grant with no allowlist MUST be refused"; and the staleness
   table of D4.
3. **8.2 item 4 gains a carve-out at the point of use**, exactly as item 3 states its own for
   the `.rfa/` git directory. Item 4 forbids adopting a repository the operator owns as a side
   effect of anything; an operator-declared workspace grant is not a side effect, and the
   conditions that make it not one (an explicit command, a named path, a uid check, worktrees
   only, RFA removes what it created) belong in the item so nobody reads the two rules as
   contradicting.
4. **Section 9 gains amendment item A7**, generalizing A2 rather than replacing it: the allow
   root is the run's SINGLE declared write surface, which is `scratch/<runId>` for an ordinary
   fenced run and the workspace worktree for a workspace run; there is at most one per run; and
   whether a second root can be opened alongside a cwd grant is UNMEASURED and assumed closed.
5. **8.1's subtree map gains a row**: `workspaces/<runId>/`, created fresh per run, read-write,
   never cloned, removed at run end, present in RFA's own `info/exclude` and in the operator's
   template gitignore.
6. **Section 10 gains `workspace`**, a grant name, with its own gates: a pack naming one must
   have a declared write surface (naming a workspace without one is a definition error, not a
   no-op), and must be `concurrency: 1` until 8.2's lifecycle exists.
7. **`spec/RFA-0.7-cli.md` gains `rfa workspace add|ls|rm` AND `rfa scribe ls|show|accept|reject`**
   in its command surface. Both are operator actions and the CLI is where operator actions are
   specified; an earlier draft sent only the first family, which would have landed a whole
   operator-facing command family and a dashboard row unspecified. The dashboard's scribe row is
   a THIN CALL into the same function per CLAUDE.md's front-door rule, with the palette showing
   the command line before it runs, and the spec text says so rather than leaving it to the
   implementer.
8. **`.rfa/workspaces.json` joins the backup set and gains a `rfa doctor` check.** It is new
   hub-owned state, and hub-owned state this project does not back up is state it loses:
   `backupPlan` in `src/platform.ts:34` names the room logs, the supervisor state, `secrets.json`,
   the principals, the tokens and the rooms file by hand, so a new one has to be added by hand.
   The RESTORE behaviour is normative and is the interesting half: a hub restored onto a machine
   where a granted path does not exist, or exists under another uid, resolves to a STARTUP REFUSAL
   for the pack naming it, never a silent skip, which is the same fail-closed rule D2 states for
   resolution generally. `rfa doctor` gains a grant-resolution check beside the two write-fence
   checks it already runs (`fenceDeclarationCheck` and `write-fence-sandbox` in
   `src/cli/commands/doctor.ts`), because a check is where this project puts everything the
   ledger paid for.
9. **The read half is deliberately NOT owed yet, and that is stated rather than omitted.** D2
   says the grant is a WRITE grant and that a read grant is a separate, unbuilt thing. The spec
   text says the same in the negative: 8.3 defines no read grant, the read set of D7 is INTENT
   with nothing enforcing it, and risk 2 is the open hole. A future read grant is its own section
   and its own rung, and it is a change to every pack rather than to this one.
10. **Section 15's ladder gains rung 8** with its sub-rungs, trigger-gated OUTSIDE the build
    order the way 6a and 6b are, blocking nothing.
11. **A changelog entry (0.8.0-a5)** recording all of the above, and STATUS.md's v0.8 rung list
    gains the rung 8 lines. CLAUDE.md gains a line only when something is built, not now.

---

## 11. The pack, sketched

```yaml
rfa_agent: 1
name: repo-scribe
description: >
  Drafts the evidence half of a docs/LEDGER.md entry and the mechanical half of
  STATUS.md for the agent-com repository, as a branch a human reviews and merges.
# no `mode:` key, deliberately. See below: its absence is what makes plan mode unreachable.
tools:
  allow: [Read, Grep, Glob, Write, Edit]
  allow_subagents: false
workspace: agent-com            # 8b ONLY. A GRANT name (D2), resolved from .rfa/workspaces.json.
                                # Today's agentDefSchema is a plain z.object with no .strict(),
                                # so this key is STRIPPED and the line is a silent no-op before
                                # 8b lands the refusal (D2). Do not ship it earlier believing
                                # it does something.
knowledge: []
rooms:
  - room: ops
    role: observer
    serve: false                # declared, and INERT until 8b (D8, src/resident.ts:321, :2557)
schedules: []                   # a cron at 8b. NOT an operator task: an observer cannot claim one
budgets:
  per_day_usd: 2
  per_task_usd: 0.5
  max_turns: 30
concurrency: 1
candidates: 1
secrets: [RFA_TOKEN]
sandbox:
  isolation: none
  permission_mode: default
  network: none
```

Why each field is what it is:

- **`Write` and `Edit`, and nothing else write-shaped.** `Edit` is the verb for both target
  files, and its unique-`old_str` requirement is a compare-and-swap in the same sense sect. 4
  item 1 pins for `str_replace`: a stale match fails loudly and the model re-reads. `Write` is
  there for the worksheet file at rung 8a. `NotebookEdit` is omitted deliberately: nothing here
  is a notebook, and every guarded built-in a pack declares costs a live deny probe at every
  boot (measured at roughly a cent per built-in per boot).
- **No `Bash`.** Door two is its only door, a git command's write set cannot be traced, and the
  resident does the git. This also means the model cannot run the gates, which section 6 already
  says must not be claimed.
- **No `mode:` key and no `interrupt_on`, which together buy a mechanism rather than a
  default.** `effectiveMode()` returns `read-only` only when the pack has no acting tool AND
  declares no `mode`, and on a `read-only` pack `rfa agent mode <name> plan` exits 2 with "has
  no acting tool (nothing in `interrupt_on`); a mode would change nothing". So omitting the key
  makes plan mode unreachable through the CLI, which matters because plan mode refuses guarded
  built-ins outright, including into the run's own surface: a writing pack in plan mode writes
  nothing at all. A hand edit adding `mode: plan` still breaks it, in the safe direction (it
  refuses to write, it does not write unfenced). `read-only` and `ask` share one posture branch
  (`onActing: "card"`), so nothing else changes. Note the sentence a reader of `rfa agent ls`
  will see: this pack's mode column says `read-only` beside a declared `Write`, which is
  precisely the pair `hasWriteSurface()` exists to tell apart, and it belongs in the pack's own
  comment so nobody reads it as a mistake.
- **`role: observer`, and `serve: false` beside it that does nothing yet.** The observer role is
  the half the HUB enforces: it refuses a send (`src/store.ts:1534`) and every non-read task
  action (`src/store.ts:2831`), which is what makes the room neither a work channel nor a
  delivery channel (D4, D8). `serve: false` is declared for the shape it is meant to have and is
  inert until 8b implements it (`src/resident.ts:321` and `:2557`), so it is written here as a
  declaration of intent and never counted as a control. One consequence of the observer role to
  carry into 8b rather than discover in a log: the resident's boot-time definition-change status
  message into the room is a send, so it 401s for this pack on every definition edit, and 8b
  either tolerates it as a logged non-fatal or skips it for a non-participant binding.
- **`concurrency: 1`, `candidates: 1`.** Two runs over one repository is a lifecycle that does
  not exist. Candidates would be N drafts of one entry, which is a real future want and is
  blocked by the same thing.
- **`per_day_usd` and `per_task_usd` both declared.** `per_day_usd` is gate 3 and would be
  required anyway above concurrency 1; `per_task_usd` is declared because rung 4 measured what
  its absence does (with no per-task ceiling the first reservation is the whole day remainder).
  Note the known defect before editing it: `rfa agent edit --per-day` rewrites the whole budgets
  block and destroys comments inside it.
- **`knowledge: []`.** The repository is read from the worktree, not attached as a knowledge
  clone. Attaching it would put a second copy of every spec file on disk against the
  one-fact-one-file rule.
- **`permission_mode: default`.** Anything else is refused at definition validation for a pack
  with a declared write surface (A5), and `acceptEdits` would auto-accept exactly the two tools
  door one exists to intercept.

---

## 12. The build order, and the smallest first shippable slice

Four rungs, trigger-gated outside RFA-0.8's build order the way 6a and 6b are, each shippable
alone behind the existing gates.

**Rung 8a, the worksheet on scratch. THE SMALLEST FIRST SHIPPABLE SLICE.** No spec change, no
schema change, no fence change, no new surface of any kind. The pack is a rung-5 writing pack
whose allow root is its own `scratch/<runId>`; it READS the repository (see the honest note
below), and it writes one worksheet file into its scratch, which rung 5 already keeps as the
run's artifact when it is non-empty. The operator opens the file. Everything expensive about
this design is deferred and the one genuinely hard thing, D7's register discipline, is exercised
immediately and cheaply. It also makes the write fence's first real load a run whose worst
outcome is a wrong paragraph in a file nobody reads by accident. **Ship this before deciding
whether the rest is worth building**, and its acceptance measurement is section 13 item 8's:
whether the human's edit distance from worksheet to entry is smaller than writing it fresh.

**Rung 8b, the grant and the worktree.** `.rfa/workspaces.json`, `rfa workspace add|ls|rm` with
D2's seven validations, the pack's `workspace` field, startup resolution failing closed,
`agents/<pack>/workspaces/<runId>/` with the gitignore lines in both places, the fence changes of
D3 (one allow root, the allowlist at door one, the deny list), and the worktree lifecycle
including the pruned-under-the-run failure. Its terminus is a worktree with edits in it and a log
line; the commit is 8c's. Spec items 1 to 6 of section 10 land with this rung.

**Rung 8c, the proposal.** The resident's commit onto `rfa/scribe/<runId>` with D6's trailers,
the validators (the STATUS.md line cap, the Appendix F anchors' presence, links, the em dash
rule, D7's citation rule and register word list), the staleness disclosure of D4, and the
operator surface (`rfa scribe ls|show`, a dashboard row, a room message with the diffstat).

**Rung 8d, landing. Trigger-gated and possibly never.** An operator-approved merge, with the card
in its right place and the operator as the principal. The trigger is a measured record of
proposals landed unchanged, which is a thing that has to happen before it can be relied on.

Gates for each: `npm test` and `npm run e2e` throughout; 8b and 8c touch no named concurrency
surface, so the parity-under-load rule does not bite, but 8a changes a pack's prompt and its
knowledge posture, so parity runs twice; and `npm run fence-proof` re-runs on 8b, since it is the
first change to the fence's allow root since rung 5 built it.

---

## 13. What could go wrong

In the shape of RFA-0.8's own Appendix B, so the next session does not inherit confidence nobody
measured.

1. **The register collapses and the ledger acquires ledger-voice fiction.** Section 8's central
   risk, restated here because it is the one that would do lasting damage. The mitigations are a
   template, a word list and a citation rule, and none of them is a fence. What actually holds
   the line is that a human rewrites the entry before merging, and the day that stops happening
   is the day this stops being safe.
2. **The read surface is not fenced by anything.** `Read` is bare in `allowedTools`, so it is
   auto-approved before the callback for every path, and inside the cwd it never reaches the
   callback at all. The workspace grant bounds WRITES. A scribe pack can read the operator's home
   directory today, exactly as `pm-agent` can. That is not new and it is not this design's to fix,
   but a note about an agent pointed at the operator's source tree should say it out loud. The fix
   direction, for its own rung: take `Read` out of `allowedTools` and give it a path guard at door
   one, which is a change to every pack and needs its own probe of the per-path fall-through.
3. **The ledger is one file that prepends at the top, which is the highest-conflict shape
   possible.** Every entry touches the same few lines, and 8.2's own stated expectations are the
   figures to read here: 27.67 percent of real agent pull requests conflict, roughly 9.9 percent at
   2-line median churn and near 30 percent at 25 lines, and a ledger entry is well past 25 lines.
   Two proposals outstanding at once, or one proposal and one human edit, conflict at the top of
   the file. The structural answer (one file per entry with the ledger as an index)
   changes the project's own document layout and is a bigger decision than this note should make;
   it is the named trigger for reopening D1's file shape.
4. **The worktree writes into the operator's repository and RFA does not own the cleanup.** Stale
   `worktrees/<id>` entries accumulate if a resident dies mid-run, a stale worktree holding a
   branch blocks `git branch -d`, and `git worktree prune` is a command the operator may run
   whenever they like, including mid-run. The sweep is owed by 8b and it is a reconcile loop over
   observed state, never a lock cleanup, for the reason 8.2 gives.
5. **Commit messages are untrusted input and this repository is a single-author one today.** The
   moment it is not, the scribe's input includes prose written by people the operator does not
   control, in a channel that reaches a document later sessions treat as established. The blast
   radius is bounded by a human reading the proposal, which is a control that degrades with
   familiarity.
6. **The proposal's gate line can only ever be partial.** The repository's real gates cannot run
   in a bare worktree. Every honest version of this says which checks ran and which a human still
   owes, and the failure mode is the reassuring instrument this project has now recorded three
   times in two days.
7. **Door one is version-fragile by design, and this pack makes it load-bearing for real work.**
   Until now the fall-through was proven at every boot for a probe pack. An SDK bump that changes
   the callback's built-in behaviour now stops a real workflow, which is the correct failure and
   still a failure. `npm run fence-proof` after every bump, and the boot probe is what makes the
   stoppage loud instead of silent.
8. **It may not be worth it.** A worksheet the human rewrites completely saves nothing but the
   gathering. The measurement that decides whether 8b is built is taken at 8a: the edit distance
   from worksheet to landed entry, over several real entries, against the cost of the runs. If the
   human rewrites everything, the honest answer is that the gathering is the product and the
   drafting should be dropped rather than improved.
9. **Nothing here is measured against a second repository.** Every number in section 2 is this
   repository on this machine: 244 tracked files, 6.5 M of tracked content, a working directory
   dominated by `node_modules`. A repository whose tracked set is large, or one using submodules
   or LFS, changes the worktree's cost and possibly its correctness, and neither was tried.

---

## 14. The siblings, named and not designed

Two more agents were raised and neither is designed here, because both are cheaper than this one
and would be badly served by inheriting its shape.

**A spec-citation checker.** Read-only: it needs the grant's READ half and no write surface, no
worktree, no branch, no fence change, so it is servable at rung 8a's level or below. Its output is
a report, never an edit, which is the correct posture for the one directory section 6 puts out of
reach. Its acceptance corpus already exists: the phantom "v0.5 sect. 14", the "five items" that
were six, and the two stale descriptions of what `rfa init` seeds are three real defects from one
week, and an agent that finds them retroactively has proved something.

**A release-notes agent.** It needs the same range machinery as the scribe, and it differs in the
way that matters most: its output LEAVES THE BUILDING. That is where `interrupt_on` and the
approval card belong, in the sense `linear-scribe` uses them, and it is the reason section 5
argues the card away from the ledger. The card is for the act that cannot be taken back, and a
branch in a private repository can always be deleted.
