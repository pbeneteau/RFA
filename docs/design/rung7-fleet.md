# RFA-0.8 rung 7: the fleet

Written 2026-08-26, before any edit, in the shape rungs 3, 4 and 5 established. The
NORMATIVE source is the wire spec, [spec/RFA-0.1.md](../../spec/RFA-0.1.md) sect. 10.3's
resource-claim block, sect. 8, sect. 14 and Appendices A, B and F; RFA-0.8 sects. 2, 13
and 15 are the acceptance record. Where they differ the wire spec governs. Evidence is
`research/05-concurrency/REPORT.md` sects. 7 and 8.

Two halves that ship independently. Half one is the board's resource claims and is what
gates advertising `0.1.9`. Half two is the remote boundary and gates nothing, by the
conformance rule's own words.

---

## 1. Decisions this rung has to make, and their reasons

The wire text is unusually complete here, so most of the work is faithful implementation.
These are the places it leaves a choice, each decided once and recorded so the code and
the spec cannot drift apart.

**D1. Widening is a `claim` on a task you already own.** Item 6 says a holder needing more
resources "issues a new claim for the additional keys only", refused-not-queued, and that
it "never damages the grant already held". `claim` today requires `state === "submitted"`
and `owner === null`, so a second claim by the holder would fail `task_conflict` before
any of that could happen. The only reading under which item 6 means anything is that a
`claim` by the CURRENT OWNER of a `working` task is a widening rather than a re-claim. It
therefore does NOT increment `attempt` and does NOT mint a new `claim_token`: both would
invalidate the fence the holder is still using, which is the literal damage the item
forbids. A claim by anyone else on an owned task keeps failing exactly as it does today.

**D2. The reservation offer lives on the task, and `update` approves what the hub
offered.** Item 6's fallback has three parties: the hub offers, a creator/host/human
approves over `room_task update`, and the grant is taken "on the creator's authority".
If `update` accepted arbitrary keys, the approver would be granting something the hub
never offered and the audit trail would not show what was agreed. So the third refusal
writes `reservation_offer: {keys, offered_at}` onto the task, the refusal's `data` carries
it, and `update {approve_reservation: true}` grants exactly those keys and clears the
offer. The approver approves an offer, not a wish.

**D3. The digest secret is per-process and random, and it is never the transport
credential.** Item 8 requires stability "for the lifetime of the blocking grant" and
states cross-restart stability is NOT required. A process-random 32-byte secret satisfies
that exactly, needs no new persisted secret, and cannot be confused with or leak the
transport bearer. A grant that outlives a restart gets a different digest afterwards,
which the spec explicitly permits and which a back-off consumer cannot be harmed by,
since it re-reads the digest from the refusal it just received.

**D4. Grants live on the task object; the claim token stays a process-local Map.** The
two halves of the fence have opposite persistence requirements and the code must show
that: `resource_grants` is a task field, and tasks are already persisted and reloaded
(`src/store.ts` room metadata), so a grant survives a restart for free and keeps refusing
claims, which is item 7's whole point. `claimTokens` stays the in-process Map it is,
because the secret half MUST NOT survive (sect. 14 guarantee 8, and RFA-0.6 sect. 6.1's
one-sentence interop statement). Rung 2 already recorded that this Map is honest for a
bearer secret and wrong for a grant; this rung is where that distinction becomes two
different storage decisions rather than one comment.

**D5. The rate-window counter key is `peer_id ?? principal ?? member.id`.** RFA-0.6 sect.
5.6 names exactly this order and adds "a local member keeps the existing per-member key".
No admission record and therefore no `peer_id` exists on this hub yet, so today the key
resolves to the human principal hash where there is one and the member id otherwise. The
windows move OFF the member record and into a room-level map keyed by that string, which
is what stops leave-and-rejoin resetting a peer's budget; a local agent's key is still its
member id, so its behaviour is unchanged.

**D6. The greedy-peer watch fires at 3 offline-releases from one identity in 600 s.** The
spec deliberately picks no number (Appendix B), so this hub picks and says why. Three is
the smallest count that cannot be one flapping network: two releases are a drop plus a
retry, three is a pattern. Ten minutes is long enough to catch a slow flap and short
enough that the alert names a live incident rather than an archaeological one. The
critical property is that this is a STATE count and not a rate: it has no denominator, so
it fires on a room with one task and no traffic, which is exactly the shape the #ops
triad's zero-traffic scar taught this project to check for. Auto-hold is available and
OFF by default: holding a member is an intervention, and an operator who has not asked
for automatic ones should get the alert first.

**D7. Half two ships behind half one and never gates the version.** Sect. 16.1's rule
names `resources[]` validation, intersection refusal and `would_deadlock`. The rate
budgets and the watch are not in that list, so the bump follows half one alone. This is
recorded because the temptation to bundle is real and the conformance rule is the thing
that makes the advertisement honest.

---

## 2. Half one: shape

`src/resources.ts`, pure and testable, holds the grammar and the intersection:

- `validateKeys(keys, {home, roomHandle})` returns validated keys or a `bad_request`
  reason. Unicode NFC, `/` the one separator, no empty, `.` or `..` segment, 256 bytes
  per key, 16 keys per claim, and the authority segment checked against the claimant:
  `room/<handle>/...` for any member of that room, `local/...` for `home === "local"`
  only, `<home>/...` only where the segment equals the claimant's hub-derived home.
  `room` is a reserved home (Appendix B), so the hub must never derive or admit it; the
  join path is asserted for that separately.
- `intersects(a, b)` compares SEGMENT SEQUENCES, prefix-or-equal, never bytes. The test is
  written before the implementation, because `local/agent-a` conflicting with
  `local/agent-ab` is the invisible version of this bug: two unrelated packs deadlock and
  nothing in the log says why.
- `discloseKey(key, {claimantHome, secret})` returns the key, or `hmac-sha256:<hex>` when
  the claimant is non-local and the key is under `local/...`.

The store's `claim` case gains, between the existing seam and the commit: key validation
(`bad_request`), intersection against every live grant in the room (`task_conflict` with
the disclosed blocking key, and never a wait), the widening branch of D1, and the grant
write. `releaseTask` and every terminal transition drop the task's grants, its reservation
offer and its widening counter, so a grant never outlives its task.

Threading to the mutation path (item 10) extends rung 5's door one: `claimStillOurs`
already re-reads the task before a guarded write, so the same read now also checks that
the run's declared resource keys are still granted to it. A write whose grant is gone is
refused at the tool instead of discovered at publish.

## 3. What this rung does NOT do

Item 11's scope statement, in the code where an implementer meets it: resource claims
prevent write-write interference ONLY. Write skew through disjoint write sets survives by
construction and is owned by verification authority (10.4) and idempotent task design. No
queueing, no blocking, no retry loop inside the hub: the parked FIFO-queue variant has a
named trigger and refuse-never-wait is what makes deadlock structurally impossible rather
than merely unlikely.

Parked and untouched: per-resource epochs, a local-member claim head start over guests,
full per-home memory partitions, per-run knowledge pinning.

## 4. The testing gap, stated rather than hidden

No remote peer exists on this instance, so half two is unexercised by construction: every
member is `home: "local"`, no admission record exists, and `peer_id` is absent throughout.
What can be exercised is driven through the interop artifact rather than a private
harness, and what cannot is named here and in the ledger rather than implied to work.
