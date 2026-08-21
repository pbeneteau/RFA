/**
 * v0.6.1 claim leases and v0.6.2 verification authority (spec 10.3, 10.4).
 *
 * The defect these fix was found by an outside integrator following the
 * documented happy path: claim a task, file evidence, leave cleanly. Nothing
 * released the claim, and `complete` requires the original owner id, so the
 * board wedged and an operator had to unstick it by hand.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { RoomHub } from "../src/store.js";
import type { AgentCard, RfaTask } from "../src/model.js";

const card = (name: string): AgentCard => ({
  name,
  description: `${name} does things.`,
  skills: [{ id: `${name}-skill`, description: `${name}'s skill.` }],
});

/** Captures the error whether the call throws synchronously or rejects. */
async function fails(fn: () => unknown): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a failure, got none");
}

async function room(cfg: Record<string, unknown> = {}) {
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0, humanKeys: ["hk_lease"], ...cfg });
  const host = hub.createRoom({ topic: "leases", name: "creator", card: card("creator") });
  const join = (name: string, extra: Record<string, unknown> = {}) =>
    hub.join({ room: host.room, join_secret: host.join_secret!, name, card: card(name), ...extra });
  return { hub, handle: host.room, creator: host.contract.you, join };
}

test("a worker that leaves hands its claim back, and the next worker can finish it", async () => {
  const { hub, handle, creator, join } = await room();
  const worker = join("worker");
  const created = (await hub.task({
    room: handle, membership_token: creator.membership_token, action: "create",
    title: "survive a departing worker", evidence_required: true,
  })) as RfaTask;

  const claimed = (await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "claim", id: created.id })) as RfaTask & { claim_token: string };
  assert.equal(claimed.owner, worker.you.id);
  assert.equal(claimed.attempt, 1, "attempts are public and orderable");
  assert.ok(claimed.lease_expires, "a claim carries a lease");
  assert.ok(claimed.claim_token?.startsWith("ct_"), "the fence's secret half comes back in the claim RESULT");

  // The secret must never be visible to anyone else, which is the whole reason
  // it is not a field on the task.
  const asSeenByCreator = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "get", id: created.id })) as Record<string, unknown>;
  assert.equal(asSeenByCreator.claim_token, undefined, "a fence inside the task object would be broadcast on first use");

  // The documented happy path that used to wedge the board.
  hub.leave({ room: handle, membership_token: worker.you.membership_token });
  const afterLeave = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "get", id: created.id })) as RfaTask;
  assert.equal(afterLeave.owner, null, "the claim came back");
  assert.equal(afterLeave.state, "submitted", "and the task is claimable again");
  assert.ok(afterLeave.released_at, "with the release stamped");

  const events = (await hub.listen({ room: handle, membership_token: creator.membership_token, since: 0, timeout_ms: 0, wait_for: "all" })) as { events: any[] };
  const released = events.events.find((e) => e.type === "system" && e.event === "task_released");
  assert.ok(released, "the release is auditable");
  assert.equal(released.refs.reason, "leave");
  assert.equal(released.refs.attempt, 1);

  // A second worker can now actually finish it: raise the attempt cap first,
  // since one attempt is the default and it has been used.
  await hub.task({ room: handle, membership_token: creator.membership_token, action: "update", id: created.id, max_attempts: 3 });
  const second = join("worker-2");
  await hub.task({ room: handle, membership_token: second.you.membership_token, action: "claim", id: created.id });
  const done = (await hub.task({
    room: handle, membership_token: second.you.membership_token, action: "complete", id: created.id,
    evidence: { summary: "did the work" },
  })) as RfaTask;
  assert.equal(done.verification.pending, true, "evidence still needs a verifier");
  hub.close();
});

test("an owner that goes offline releases its task on the sweep", async () => {
  let now = 1_000_000_000_000;
  const { hub, handle, creator, join } = await room({ defaultLeaseS: 60, flapWindowS: 10, now: () => now });
  const worker = join("ghost");
  const t = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "create", title: "outlive a ghost" })) as RfaTask;
  await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "claim", id: t.id });

  now += 71_000; // past the lease plus the flap window
  hub.sweep();
  const after = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "get", id: t.id })) as RfaTask;
  assert.equal(after.owner, null, "an offline owner cannot finish its work, so the task goes back");
  const events = (await hub.listen({ room: handle, membership_token: creator.membership_token, since: 0, timeout_ms: 0, wait_for: "all" })) as { events: any[] };
  assert.equal(events.events.filter((e) => e.event === "task_released").pop()?.refs.reason, "offline");
  hub.close();
});

test("release is explicit too, and only the owner or a token holder may call it", async () => {
  const { hub, handle, creator, join } = await room();
  const worker = join("worker");
  const other = join("bystander");
  const t = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "create", title: "give it back" })) as RfaTask;
  const claimed = (await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "claim", id: t.id })) as RfaTask & { claim_token: string };

  const denied = await fails(() => hub.task({ room: handle, membership_token: other.you.membership_token, action: "release", id: t.id }));
  assert.match(denied.message, /only the owner/, "a bystander cannot release someone else's claim");
  const released = (await hub.task({
    room: handle, membership_token: other.you.membership_token, action: "release", id: t.id, claim_token: claimed.claim_token,
  })) as RfaTask;
  assert.equal(released.owner, null, "but a valid fence holder can, which is how a restarted worker recovers");
  hub.close();
});

test("attempts are bounded: a used-up task waits for a human rather than looping", async () => {
  const { hub, handle, creator, join } = await room();
  const t = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "create", title: "one shot" })) as RfaTask;
  const first = join("worker-a");
  await hub.task({ room: handle, membership_token: first.you.membership_token, action: "claim", id: t.id });
  hub.leave({ room: handle, membership_token: first.you.membership_token });

  const second = join("worker-b");
  const capped = await fails(() => hub.task({ room: handle, membership_token: second.you.membership_token, action: "claim", id: t.id }));
  assert.equal(capped.code, "task_conflict", "the default is one attempt, and the second claim is refused");
  assert.equal(capped.data?.max_attempts, 1);
  const still = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "get", id: t.id })) as RfaTask;
  assert.equal(still.state, "submitted", "it stays submitted, NOT failed: a released task may already have had side effects");
  // The creator may reopen it.
  await hub.task({ room: handle, membership_token: creator.membership_token, action: "claim", id: t.id });
  hub.close();
});

test("verification authority: the same party cannot accept its own evidence, and rejection is bounded", async () => {
  const { hub, handle, creator, join } = await room();
  const worker = join("worker");
  const t = (await hub.task({
    room: handle, membership_token: creator.membership_token, action: "create", title: "needs a real verifier", evidence_required: true,
  })) as RfaTask;
  await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "claim", id: t.id });
  await hub.task({
    room: handle, membership_token: worker.you.membership_token, action: "complete", id: t.id, evidence: { summary: "trust me" },
  });

  const selfVerify = await fails(() => hub.task({ room: handle, membership_token: worker.you.membership_token, action: "verify", id: t.id, verdict: "accept" }));
  assert.match(selfVerify.message, /differ from the owner/, "the owner still may never verify itself");

  // A local member may verify, and the record says which home accepted it.
  const verified = (await hub.task({
    room: handle, membership_token: creator.membership_token, action: "verify", id: t.id, verdict: "reject", note: "not good enough",
  })) as RfaTask;
  assert.equal(verified.verification.verifier_home, "local", "a reader can tell which organization accepted the evidence");
  assert.equal(verified.verification.rejections, 1, "rejections are counted per attempt");

  // Bounded: past the cap a reject needs a human, so a reject loop cannot wedge the board.
  for (const n of [2, 3]) {
    await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "complete", id: t.id, evidence: { summary: `try ${n}` } });
    await hub.task({ room: handle, membership_token: creator.membership_token, action: "verify", id: t.id, verdict: "reject" });
  }
  await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "complete", id: t.id, evidence: { summary: "try 4" } });
  const atCap = await fails(() => hub.task({ room: handle, membership_token: creator.membership_token, action: "verify", id: t.id, verdict: "reject" }));
  assert.equal(atCap.code, "task_conflict", "an unbounded reject loop wedges a board as effectively as a stuck claim");
  assert.equal(atCap.data?.max_rejections, 3);
  hub.close();
});

test("a reconnected worker finishes its own task through the claim_token, not its lost member id", async () => {
  const { hub, handle, creator, join } = await room();
  const worker = join("worker");
  const t = (await hub.task({
    room: handle, membership_token: creator.membership_token, action: "create", title: "survive a worker restart",
  })) as RfaTask;
  const claimed = (await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "claim", id: t.id })) as RfaTask & { claim_token: string };

  // The worker's process restarts: same party, new membership, new member id.
  const reborn = join("worker-reborn");
  assert.notEqual(reborn.you.id, worker.you.id);

  // Without the token, the new membership is a stranger to the task.
  const denied = await fails(() => hub.task({ room: handle, membership_token: reborn.you.membership_token, action: "complete", id: t.id }));
  assert.equal(denied.code, "unauthorized");

  // With it, update and complete both work: the fence is the identity that survives.
  await hub.task({
    room: handle, membership_token: reborn.you.membership_token, action: "update", id: t.id, state: "working",
    note: "resumed after restart", claim_token: claimed.claim_token,
  });
  const done = (await hub.task({
    room: handle, membership_token: reborn.you.membership_token, action: "complete", id: t.id, claim_token: claimed.claim_token,
  })) as RfaTask;
  assert.equal(done.state, "completed", "the spec 10.3 restart-recovery story finally works on the wire");

  // A dead fence stays dead: after release the token no longer completes anything.
  const t2 = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "create", title: "released fence" })) as RfaTask;
  const c2 = (await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "claim", id: t2.id })) as RfaTask & { claim_token: string };
  await hub.task({ room: handle, membership_token: worker.you.membership_token, action: "release", id: t2.id });
  const stale = await fails(() => hub.task({ room: handle, membership_token: reborn.you.membership_token, action: "complete", id: t2.id, claim_token: c2.claim_token }));
  assert.equal(stale.code, "unauthorized", "releaseTask deletes the fence with the claim");
  hub.close();
});

test("create honors max_attempts, and the default stays 1", async () => {
  const { hub, handle, creator, join } = await room();
  const w1 = join("w1");
  const w2 = join("w2");

  // Advertised by the schema and, until 2026-08-21, silently dropped by create.
  const generous = (await hub.task({
    room: handle, membership_token: creator.membership_token, action: "create", title: "three tries", max_attempts: 3,
  })) as RfaTask;
  assert.equal(generous.max_attempts, 3, "the argument the schema advertises lands on the task");
  await hub.task({ room: handle, membership_token: w1.you.membership_token, action: "claim", id: generous.id });
  await hub.task({ room: handle, membership_token: w1.you.membership_token, action: "release", id: generous.id });
  const second = (await hub.task({ room: handle, membership_token: w2.you.membership_token, action: "claim", id: generous.id })) as RfaTask;
  assert.equal(second.attempt, 2, "a second worker gets the second attempt");

  // Unchanged default: a task created without the argument is still single-attempt.
  const strict = (await hub.task({ room: handle, membership_token: creator.membership_token, action: "create", title: "one try" })) as RfaTask;
  await hub.task({ room: handle, membership_token: w1.you.membership_token, action: "claim", id: strict.id });
  await hub.task({ room: handle, membership_token: w1.you.membership_token, action: "release", id: strict.id });
  const capped = await fails(() => hub.task({ room: handle, membership_token: w2.you.membership_token, action: "claim", id: strict.id }));
  assert.equal(capped.code, "task_conflict");
  assert.match(capped.message, /must reopen it/, "the refusal says who can unstick it");
  hub.close();
});
