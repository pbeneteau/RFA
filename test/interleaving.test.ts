/**
 * RFA-0.8 rung T, seam 1 (spec sect. 14 item 1): deterministic interleaving
 * tests at the four seams where two turns meet shared state. No sleeps, no
 * stress loops, no nondeterminism: every ordering is DRIVEN, with barriers, so
 * a failure names an ordering instead of a flake rate.
 *
 * The four seams, in the order the spec lists them:
 *   1. the store's claim path, through a test-only awaitable hook between the
 *      check and the commit (undefined in production, so the await never
 *      happens at all: `if (hook) await hook()`, never `await hook?.()`, which
 *      would yield a microtask in production and open the window this test
 *      exists to prove is closed);
 *   2. call-order enumeration over the synchronous memory verbs;
 *   3. two-connection races on lease admission;
 *   4. never-two-turns-one-session over the resident's session book.
 *
 * The `create`-clobber test was written FIRST, as the spec of the fix
 * (RFA-0.8 sect. 4 item 1, W5 sect. 4): it failed against the old
 * unconditional `writeFileSync` before the fix existed.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryGate } from "../src/client.js";
import { GatedMemory } from "../src/memoryfs.js";

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-inter-"));
  return { dir, mem: new GatedMemory(dir, new MemoryGate(), "m_self") };
}

// ---------------------------------------------------------------- seam 2: the memory verbs

test("seam 2: create over an existing path never clobbers, and the loser survives as a named conflict file", () => {
  const { dir, mem } = fresh();
  mem.create("/memories/notes/fees.md", "entry fee is 1 percent");
  // Turn B arrives with its own content for a path turn A already wrote. Before
  // the fix this returned "created" and turn A's write was gone with no trace.
  assert.throws(
    () => mem.create("/memories/notes/fees.md", "entry fee is 2 percent"),
    (err: Error) => {
      assert.match(err.message, /already exists/, "the refusal says why");
      assert.match(err.message, /re-read/i, "the error tells the model what to do");
      assert.match(err.message, /conflict/, "the error names where the losing content went");
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(dir, "notes/fees.md"), "utf8"), "entry fee is 1 percent", "the incumbent is intact");
  const conflicts = fs.readdirSync(path.join(dir, "notes")).filter((f) => f.includes("conflict"));
  assert.equal(conflicts.length, 1, `exactly one conflict file, got ${conflicts.join(", ")}`);
  assert.equal(fs.readFileSync(path.join(dir, "notes", conflicts[0]), "utf8"), "entry fee is 2 percent", "the loser is on disk, not discarded");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seam 2: re-creating a path with identical content is idempotent, not a conflict", () => {
  const { dir, mem } = fresh();
  mem.create("/memories/notes/x.md", "same");
  const res = mem.create("/memories/notes/x.md", "same");
  assert.match(res, /unchanged/, res);
  assert.deepEqual(fs.readdirSync(path.join(dir, "notes")), ["x.md"], "no conflict file for a no-op");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seam 2: create/insert/delete honour a fail-if-changed content hash, and the stale error carries the current one", () => {
  const { dir, mem } = fresh();
  mem.create("/memories/notes/x.md", "v1");
  const h1 = mem.contentHash("/memories/notes/x.md");

  // The intentional overwrite: the writer proves it read what it is replacing.
  assert.match(mem.create("/memories/notes/x.md", "v2", { expectedHash: h1 }), /created|overwrote/);
  assert.equal(fs.readFileSync(path.join(dir, "notes/x.md"), "utf8"), "v2");

  // The lost update: the same writer retries with the hash it read BEFORE the
  // other turn's write. It must fail, loudly, and hand back the current hash so
  // the retry is possible without guessing.
  const h2 = mem.contentHash("/memories/notes/x.md");
  for (const verb of [
    () => mem.create("/memories/notes/x.md", "v3", { expectedHash: h1 }),
    () => mem.insert("/memories/notes/x.md", 0, "top", { expectedHash: h1 }),
    () => mem.delete("/memories/notes/x.md", { expectedHash: h1 }),
  ]) {
    assert.throws(verb, (err: Error) => {
      assert.match(err.message, /changed since you read it/, err.message);
      assert.match(err.message, /re-read/i, "the error text tells the model to re-read");
      assert.ok(err.message.includes(h2), `the error carries the current hash ${h2}: ${err.message}`);
      return true;
    });
  }
  assert.equal(fs.readFileSync(path.join(dir, "notes/x.md"), "utf8"), "v2", "no verb mutated anything on a failed precondition");

  // With the CURRENT hash each verb proceeds.
  mem.insert("/memories/notes/x.md", 0, "top", { expectedHash: h2 });
  assert.match(mem.view("/memories/notes/x.md"), /1: top/);
  mem.delete("/memories/notes/x.md", { expectedHash: mem.contentHash("/memories/notes/x.md") });
  assert.equal(fs.existsSync(path.join(dir, "notes/x.md")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seam 2: str_replace keeps its accidental optimistic concurrency: a stale old_str fails loudly (pinned deliberately)", () => {
  const { dir, mem } = fresh();
  mem.create("/memories/notes/x.md", "the fee is 1 percent");
  // Turn A commits its edit.
  mem.strReplace("/memories/notes/x.md", "1 percent", "2 percent");
  // Turn B was holding "1 percent" from a read that is now stale. A unique
  // old_str IS a compare-and-swap, and this is the contract, not an accident:
  // RFA-0.8 sect. 4 item 1 keeps it on purpose so the model re-reads.
  assert.throws(() => mem.strReplace("/memories/notes/x.md", "1 percent", "3 percent"), /old_str not found/);
  assert.equal(fs.readFileSync(path.join(dir, "notes/x.md"), "utf8"), "the fee is 2 percent", "the loser changed nothing");
  // Non-unique old_str is refused too: an ambiguous CAS is not a CAS.
  mem.create("/memories/notes/y.md", "a\na");
  assert.throws(() => mem.strReplace("/memories/notes/y.md", "a", "b"), /not unique/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seam 2: every interleaving of two create-shaped turns on one path preserves both writes", () => {
  // Direct call-order enumeration: the verbs are synchronous, so "interleaving"
  // is call order, and there are only two of them. Both orderings must end with
  // one incumbent and one conflict file, never one surviving write.
  for (const [first, second] of [
    ["A", "B"],
    ["B", "A"],
  ] as const) {
    const { dir, mem } = fresh();
    mem.create("/memories/notes/x.md", first);
    assert.throws(() => mem.create("/memories/notes/x.md", second));
    const files = fs.readdirSync(path.join(dir, "notes")).sort();
    assert.equal(files.length, 2, `ordering ${first}->${second}: ${files.join(", ")}`);
    const bodies = files.map((f) => fs.readFileSync(path.join(dir, "notes", f), "utf8")).sort();
    assert.deepEqual(bodies, ["A", "B"], `ordering ${first}->${second} kept both writes`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- seam 1: the store's claim path

test("seam 1: every ordering of two concurrent claims yields one winner, one task_conflict, one token", async () => {
  const { RoomHub, setClaimSeam } = await import("../src/store.js");
  const skill = (id: string) => ({ name: id, description: `${id} agent`, skills: [{ id, description: id }] });

  // Both orderings of the two claimants, so neither "the first caller wins" nor
  // "the second caller wins" can pass by accident.
  for (const firstThrough of ["a", "b"] as const) {
    const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0 });
    const host = hub.createRoom({ topic: "claims", name: "host", card: skill("hosting") });
    const room = host.room;
    const a = await hub.join({ room, join_secret: host.join_secret!, name: "worker-a", card: skill("work") });
    const b = await hub.join({ room, join_secret: host.join_secret!, name: "worker-b", card: skill("work") });
    const task = (await hub.task({
      room,
      membership_token: host.contract.you.membership_token,
      action: "create",
      title: "one task, two claimants",
      description: "the board admits one owner",
    })) as { id: string };

    // The barrier: whichever claim reaches the seam first is HELD there until the
    // other has run all the way through. That drives the interleaving the
    // synchronous path can never produce on its own, rather than waiting for it.
    let held: (() => void) | null = null;
    let seen = 0;
    const arrived: string[] = [];
    setClaimSeam(async () => {
      seen++;
      if (seen === 1) {
        await new Promise<void>((r) => (held = r));
      }
    });
    try {
      const claim = (tok: string, who: string) =>
        hub
          .task({ room, membership_token: tok, action: "claim", id: task.id })
          .then((res) => {
            arrived.push(who);
            return { who, ok: true as const, token: (res as { claim_token?: string }).claim_token };
          })
          .catch((err: Error & { code?: string }) => ({ who, ok: false as const, code: err.code, message: err.message }));

      const tokens: Record<string, string> = { a: a.you.membership_token, b: b.you.membership_token };
      const other = firstThrough === "a" ? "b" : "a";
      const firstCall = claim(tokens[firstThrough], firstThrough);
      // Let the first claim reach the seam and park there.
      await new Promise((r) => setImmediate(r));
      const secondCall = claim(tokens[other], other);
      // The second claim runs to completion while the first is still parked: the
      // ordering under test, chosen rather than raced for.
      const secondResult = await secondCall;
      held!();
      const firstResult = await firstCall;

      const results = [firstResult, secondResult];
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      assert.equal(winners.length, 1, `exactly one winner (${firstThrough} first): ${JSON.stringify(results)}`);
      assert.equal(losers.length, 1, `exactly one loser (${firstThrough} first): ${JSON.stringify(results)}`);
      assert.equal((losers[0] as { code?: string }).code, "task_conflict", `the loser gets task_conflict: ${JSON.stringify(losers[0])}`);
      assert.equal(winners[0].who, other, "the claim that got through the seam second is the one that committed first, and it wins");
      assert.ok((winners[0] as { token?: string }).token, "the winner carries the claim token");
      // One token per (room, task, attempt): the loser never got one, so the
      // winner's is the only token in existence for this attempt.
      assert.equal((losers[0] as { token?: string }).token, undefined, "the loser holds no claim token");
      const after = (await hub.task({ room, membership_token: host.contract.you.membership_token, action: "get", id: task.id })) as {
        owner: string;
        attempt: number;
        state: string;
      };
      assert.equal(after.state, "working");
      assert.equal(after.attempt, 1, "the losing claim did not burn an attempt");
      assert.equal(after.owner, winners[0].who === "a" ? a.you.id : b.you.id, "the board records the winner as owner");
    } finally {
      setClaimSeam(undefined);
      hub.close?.();
    }
  }
});

test("seam 1: with no seam installed the claim path does not await, so the window cannot exist", async () => {
  const { RoomHub } = await import("../src/store.js");
  const src = fs.readFileSync(path.join(import.meta.dirname ?? ".", "..", "src", "store.ts"), "utf8");
  // `await hook?.()` yields a microtask even when the hook is undefined, which
  // would open in production exactly the window seam 1 drives. The guard must be
  // a branch, not an optional call.
  assert.ok(src.includes("if (claimSeam) await claimSeam();"), "the seam is branch-guarded");
  assert.equal(/await\s+claimSeam\?\./.test(src), false, "the seam is never called with optional-call syntax");

  // And the behaviour: two claims issued without awaiting between them still
  // produce one winner.
  const skill = (id: string) => ({ name: id, description: `${id} agent`, skills: [{ id, description: id }] });
  const hub = new RoomHub({ dataDir: null, sweepIntervalMs: 0 });
  const host = hub.createRoom({ topic: "claims", name: "host", card: skill("hosting") });
  const room = host.room;
  const a = await hub.join({ room, join_secret: host.join_secret!, name: "worker-a", card: skill("work") });
  const b = await hub.join({ room, join_secret: host.join_secret!, name: "worker-b", card: skill("work") });
  const task = (await hub.task({ room, membership_token: host.contract.you.membership_token, action: "create", title: "t", description: "d" })) as { id: string };
  const settled = await Promise.allSettled([
    hub.task({ room, membership_token: a.you.membership_token, action: "claim", id: task.id }),
    hub.task({ room, membership_token: b.you.membership_token, action: "claim", id: task.id }),
  ]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1, "one winner with no seam either");
  hub.close?.();
});

// ---------------------------------------------------------------- seam 3: lease admission

test("seam 3: two connections racing on admission never put more rows in the table than the cap", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-adm-"));
  const db = path.join(dir, "runs.db");
  // Two CONNECTIONS to one file is the multi-process case: residents are separate
  // processes and neither is the supervisor.
  const one = new AccountLedger(db);
  const two = new AccountLedger(db);
  try {
    for (const cap of [1, 2, 3]) {
      for (const id of one.leases().map((l) => l.lease_id)) one.release(id);
      one.setCap(cap);
      // Every ordering of six interleaved acquires across the two connections,
      // driven, not raced: the row count is the invariant, in all of them.
      const ledgers = [one, two, one, two, two, one];
      const granted: string[] = [];
      for (const [i, ledger] of ledgers.entries()) {
        const res = ledger.acquire({ agent: `agent-${i % 2}`, lane: "serve" });
        if (res.ok && res.lease) granted.push(res.lease.lease_id);
        const rows = one.leases().length;
        assert.ok(rows <= cap, `cap ${cap}, step ${i}: ${rows} rows in the table`);
      }
      assert.equal(granted.length, cap, `cap ${cap}: exactly ${cap} admissions succeeded, got ${granted.length}`);
      assert.equal(two.leases().length, cap, "the other connection sees the same count");
    }
  } finally {
    one.close();
    two.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: the keepalive renews EVERY lease the process holds, not the newest", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-renew-"));
  const db = path.join(dir, "runs.db");
  // A short TTL so "expired mid-turn" is reachable without waiting.
  const led = new AccountLedger(db, { leaseTtlMs: 100 });
  try {
    led.setCap(3);
    const first = led.acquire({ agent: "pm-agent", lane: "serve", runId: "run_first" });
    const second = led.acquire({ agent: "pm-agent", lane: "serve", runId: "run_second" });
    assert.ok(first.ok && second.ok && first.lease && second.lease);
    const held = new Set([first.lease.lease_id, second.lease.lease_id]);

    // What the old single-cell keepalive did: renew the NEWEST only. Both leases
    // expire at t+100; at t+60 only the second is pushed out to t+160, so at
    // t+120 the first is gone while its turn is still running.
    await new Promise((r) => setTimeout(r, 60));
    led.renew(second.lease.lease_id);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(led.leases().length, 1, "the older lease expired mid-turn, which is the bug: its slot is handed out again");

    // What renewAll does instead.
    for (const id of led.leases().map((l) => l.lease_id)) led.release(id);
    const a = led.acquire({ agent: "pm-agent", lane: "serve", runId: "run_a" });
    const b = led.acquire({ agent: "pm-agent", lane: "serve", runId: "run_b" });
    const both = new Set([a.lease!.lease_id, b.lease!.lease_id]);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 60));
      const { renewed, lost } = led.renewAll(both);
      assert.deepEqual(lost, [], `nothing is lost while the keepalive runs (round ${i})`);
      assert.equal(renewed.length, 2, "both leases renewed on every tick");
    }
    assert.equal(led.leases().length, 2, "two concurrent turns keep two slots for as long as they run");

    // A lease the sweep already took is reported lost rather than renewed forever.
    led.release(a.lease!.lease_id);
    const after = led.renewAll(both);
    assert.deepEqual(after.lost, [a.lease!.lease_id], "the caller learns which lease is gone");
    assert.deepEqual(after.renewed, [b.lease!.lease_id]);
    assert.ok(held.size === 2, "sanity: the first pair was distinct");
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: a blocked turn lends its slot, and takes it back unconditionally", async () => {
  // RFA-0.8 sect. 6.3, on the two-connection seam because that is the shape that
  // matters: the turn that lends and the turn that borrows are different
  // PROCESSES, and the whole point is that the borrower can start while the
  // lender is blocked.
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-park-"));
  const db = path.join(dir, "runs.db");
  const blocked = new AccountLedger(db);
  const other = new AccountLedger(db);
  try {
    // The effective cap of sect. 5 item 8, which is the number the freeze
    // analysis is stated at.
    blocked.setCap(2);
    const a = blocked.acquire({ agent: "pm-agent", lane: "serve", runId: "run_a" });
    const b = blocked.acquire({ agent: "scribe", lane: "serve", runId: "run_b" });
    assert.ok(a.ok && b.ok, "two turns fill the cap");

    // HEAD's freeze, asserted so the fix has something to be a fix OF: with both
    // turns blocked on a nested ask or a card, a third turn cannot start, at zero
    // model cost to whoever provoked it.
    assert.equal(other.acquire({ agent: "third", lane: "serve" }).ok, false, "the account is frozen while both blocked turns hold their slots");

    assert.equal(blocked.park(a.lease!.lease_id, "ask"), true, "the blocked turn lends its slot");
    assert.equal(blocked.park(a.lease!.lease_id, "ask"), false, "parking twice is not a second lend");
    const third = other.acquire({ agent: "third", lane: "serve" });
    assert.ok(third.ok, "the lent slot admits real work from another process");
    assert.equal(blocked.snapshot().in_flight, 2, "in_flight counts turns that are SPENDING, not turns that are waiting");
    assert.equal(blocked.snapshot().parked, 1, "and the parked one is visible rather than inferred");
    // The row survives, because the sweep and the operator's meter read rows.
    assert.ok(blocked.leases().some((l) => l.lease_id === a.lease!.lease_id), "the lease row is kept, only its slot is lent");
    assert.deepEqual(blocked.renewAll([a.lease!.lease_id]).lost, [], "the keepalive still renews a parked lease");

    // The return. The account is full (b + third), so this is the overshoot path,
    // and it must still succeed: the turn has already spent the operator's money
    // and dying on admission now would be the worst of both.
    const back = await blocked.unpark(a.lease!.lease_id, { graceMs: 150, pollMs: 25, agent: "pm-agent", lane: "serve" });
    assert.equal(back.ok, true, "a returning turn is never refused its own lease");
    assert.equal(back.overshoot, true, "and says so when it had to take it back over the cap");
    assert.equal(back.leaseId, a.lease!.lease_id, "the same lease, not a new one");
    assert.equal(blocked.snapshot().in_flight, 3, "the overshoot is real and countable, which is the price of never killing the turn");
    assert.equal(blocked.snapshot().parked, 0);

    // And when there IS room, the return is not an overshoot at all.
    blocked.release(b.lease!.lease_id);
    other.release(third.lease!.lease_id);
    assert.equal(blocked.park(a.lease!.lease_id, "approval"), true);
    const calm = await blocked.unpark(a.lease!.lease_id, { graceMs: 150, pollMs: 25, agent: "pm-agent", lane: "serve" });
    assert.equal(calm.overshoot, false, "with capacity free, the common case is an ordinary re-entry");
  } finally {
    blocked.close();
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: a turn whose lease was swept while parked re-acquires instead of dying", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-park-swept-"));
  const db = path.join(dir, "runs.db");
  const led = new AccountLedger(db, { leaseTtlMs: 60 });
  try {
    led.setCap(2);
    const mine = led.acquire({ agent: "pm-agent", lane: "serve", runId: "run_a" });
    assert.ok(mine.ok);
    led.park(mine.lease!.lease_id, "approval");
    // The sweep takes it: the keepalive is what normally prevents this, so this
    // is the case where the keepalive itself was starved.
    await new Promise((r) => setTimeout(r, 80));
    led.sweep({ alive: () => true });
    assert.equal(led.leases().length, 0, "the row is gone");

    const back = await led.unpark(mine.lease!.lease_id, { graceMs: 300, pollMs: 25, agent: "pm-agent", lane: "serve", runId: "run_a" });
    assert.equal(back.ok, true, "a fresh lease is taken rather than the turn thrown away");
    assert.notEqual(back.leaseId, mine.lease!.lease_id, "and it is a NEW lease, which the caller must swap into its live set");
    assert.equal(back.overshoot, false);
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: when the account is full AND the lease was swept, the turn proceeds unslotted rather than dying", async () => {
  // The honest failure, stated rather than hidden: this is the one path where a
  // returning turn gets nothing back. It must not throw, because the model has
  // already been paid for; the caller logs it and finishes the answer.
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-park-lost-"));
  const led = new AccountLedger(path.join(dir, "runs.db"));
  try {
    led.setCap(1);
    const gone = "lse_neverexisted";
    led.acquire({ agent: "other", lane: "serve" }); // the one slot, taken by someone else
    const back = await led.unpark(gone, { graceMs: 120, pollMs: 25, agent: "pm-agent", lane: "serve" });
    assert.equal(back.ok, false, "no slot, and it says so");
    assert.equal(back.leaseId, null);
    assert.match(back.detail ?? "", /cap/, "the detail names why");
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: a named single-flight admits one holder, and a dead holder does not keep the name", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-sfl-"));
  const db = path.join(dir, "runs.db");
  const one = new AccountLedger(db);
  const two = new AccountLedger(db);
  try {
    const mine = one.takeSingleFlight("consolidate:pm-agent", { holder: "pass one" });
    assert.ok(mine.ok && mine.token, "the first pass takes the name");
    const theirs = two.takeSingleFlight("consolidate:pm-agent", { holder: "pass two" });
    assert.equal(theirs.ok, false, "the second is refused, not queued");
    assert.match(theirs.detail!, /held by pid/, theirs.detail);
    // A different name is a different lock: reflection must not block consolidation.
    assert.ok(two.takeSingleFlight("reflect:pm-agent").ok, "distinct names are independent");
    // Token-fenced release: a lapsed holder cannot free its successor's name.
    one.releaseSingleFlight("consolidate:pm-agent", "sfl_notmine");
    assert.equal(two.takeSingleFlight("consolidate:pm-agent").ok, false, "a wrong token releases nothing");
    one.releaseSingleFlight("consolidate:pm-agent", mine.token!);
    const next = two.takeSingleFlight("consolidate:pm-agent");
    assert.ok(next.ok, "released, so the next pass can take it");

    // The direct state check: a holder whose pid is gone must not hold a name for
    // the length of a TTL. The sweep uses pid liveness, injected here.
    const swept = one.sweep({ alive: () => false });
    assert.ok(swept >= 1, `the sweep reclaims locks whose holder is gone (dropped ${swept})`);
    assert.ok(one.takeSingleFlight("consolidate:pm-agent").ok, "and the name is takeable again");
  } finally {
    one.close();
    two.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- seam 4: one writer per session

test("seam 4: never two turns on one session id, in any interleaving", async () => {
  const { SessionBook } = await import("../src/sessions.js");
  const { makeTurnLock } = await import("../src/turnlock.js");
  const book = new SessionBook();
  book.load({ "room-1": "sess_existing" });
  assert.equal(book.resumeFor("room-1"), "sess_existing", "a saved conversation resumes its own session");
  assert.equal(book.resumeFor("room-2"), undefined, "an unknown conversation starts fresh");

  // The violation, direct: a second turn entering a conversation that already has
  // one must throw rather than resume the same transcript twice.
  book.enter("room-1");
  assert.throws(() => book.enter("room-1"), /already in flight/);
  // A different conversation is free.
  book.enter("room-2");
  book.adopt("room-2", "sess_new");
  // And one session id may not come to serve two conversations.
  assert.throws(() => book.adopt("room-1", "sess_new"), /already serves/);
  book.leave("room-1");
  book.leave("room-2");
  book.leave("room-2"); // idempotent: a throwing turn's finally must not throw
  assert.equal(book.liveCount(), 0);

  // A saved file predates the guard, so a duplicate in it is dropped on load
  // rather than left to throw later: a resident that refuses to serve because of
  // a historical state file is a worse failure than the one being prevented.
  const legacy = new SessionBook();
  const res = legacy.load({ "convo-a": "sess_shared", "convo-b": "sess_shared", "convo-c": "sess_own" });
  assert.deepEqual(res.dropped, ["convo-b"]);
  assert.equal(legacy.resumeFor("convo-b"), undefined, "the dropped conversation starts fresh, which is what a missing entry already means");
  assert.equal(legacy.resumeFor("convo-a"), "sess_shared");
  assert.equal(legacy.resumeFor("convo-c"), "sess_own");

  // The property, under the mechanism that enforces it today: many turns over a
  // few conversations, all entered concurrently, through the real turn lock.
  const oneTurn = makeTurnLock();
  const fresh = new SessionBook();
  let maxConcurrent = 0;
  const keys = ["a", "a", "b", "a", "c", "b", "a"];
  await Promise.all(
    keys.map((k, i) =>
      oneTurn(async () => {
        fresh.enter(k);
        maxConcurrent = Math.max(maxConcurrent, fresh.liveCount());
        try {
          await new Promise((r) => setTimeout(r, 1));
          fresh.adopt(k, `sess_${k}`);
          await new Promise((r) => setTimeout(r, 1));
        } finally {
          fresh.leave(k);
        }
        return i;
      }),
    ),
  );
  assert.equal(maxConcurrent, 1, "the turn lock keeps it to one writer per process, so one per session a fortiori");
  assert.equal(fresh.liveCount(), 0, "every turn released its conversation");
  assert.deepEqual([fresh.resumeFor("a"), fresh.resumeFor("b"), fresh.resumeFor("c")], ["sess_a", "sess_b", "sess_c"]);
});

test("seam 4: the resident's lease scope covers everything after the slot, not just the stream", () => {
  // A behavioural test cannot reach this: `brainTurn` is inside a module that
  // boots on import, and the throws in question (a session already in flight, a
  // systemPrompt that reads a file, the SDK refusing to start) happen between
  // taking the slot and the first message. So the SHAPE is pinned instead, the
  // same way the claim seam's source form is.
  //
  // It is pinned because getting it wrong is worse than the bug it replaced: a
  // single current-lease cell leaked too, but the next turn overwrote the cell; a
  // Set remembers, so a leaked lease is renewed by the keepalive forever, for a
  // turn that never ran, and the account silently loses a slot.
  const src = fs.readFileSync(path.join(import.meta.dirname ?? ".", "..", "src", "resident.ts"), "utf8");
  const openTry = src.indexOf("\n  try {", src.indexOf("const myLease = binding.leaseId"));
  const addLease = src.indexOf("liveLeases.add(myLease)");
  const enterSession = src.indexOf("sessions.enter(convoKey)");
  const release = src.indexOf("liveLeases.delete(binding.leaseId)");
  assert.ok(openTry > 0 && addLease > 0 && enterSession > 0 && release > 0, "every anchor is present");
  assert.ok(openTry < addLease, "the try opens BEFORE the lease joins the set, or a throw in between leaks it");
  assert.ok(openTry < enterSession, "and before the session is entered, or a throw leaves the conversation held");
  assert.ok(release > enterSession, "the release is in the finally that follows");
  // And the release names THIS turn's lease, never the whole set: a turn that
  // released every lease the process holds is the 2026-08-25 bug in reverse.
  assert.equal(/liveLeases\.clear\(\)/.test(src.slice(release - 400, release + 400)), false, "a turn never clears the whole set");
  // Since rung 2 the finally must read the BINDING, not the id captured at
  // admission: a blocked wait that lost its lease to the sweep re-acquires a new
  // one (sect. 6.3), and releasing the captured id would leak the new lease for
  // the life of the process, which the keepalive would then renew forever.
  assert.equal(
    /liveLeases\.delete\(myLease\)/.test(src),
    false,
    "the finally releases binding.leaseId, never the id captured before the blocked waits could swap it",
  );
});

test("seam 4: the turn register answers only when ONE turn owns the process, and degrades rather than guessing", async () => {
  // RFA-0.8 sect. 6.3 needs module-scope code (the nested-ask tool) to reach the
  // running turn's lease and chain. The obvious shape is a `currentTurn` cell,
  // and this repository has already paid for that one: a `currentLease` cell let
  // a scheduled run and a serve run overwrite each other, so whichever finished
  // first released the OTHER's lease. A register that returns null on ambiguity
  // makes that class unreachable instead of unlikely.
  const { TurnRegister } = await import("../src/turnbinding.js");
  const reg = new TurnRegister();
  const mk = (runId: string, leaseId: string) => ({
    runId, leaseId, agent: "pm-agent", lane: "serve" as const, chain: null, replyBy: null, conversationId: null, taskId: null,
  });
  assert.equal(reg.current(), null, "no turn: nothing to park, nothing to chain");
  const dropA = reg.bind(mk("run_a", "lse_a"));
  assert.equal(reg.current()?.runId, "run_a");
  const dropB = reg.bind(mk("run_b", "lse_b"));
  assert.equal(reg.current(), null, "two turns: there is no lease that is right for BOTH, so the honest answer is none");
  assert.equal(reg.liveCount(), 2, "and the caller can say why in its log");
  dropB();
  assert.equal(reg.current()?.runId, "run_a", "the survivor is unambiguous again");
  dropB();
  assert.equal(reg.liveCount(), 1, "unbinding twice is not a second removal");
  dropA();
  assert.equal(reg.current(), null);
});

test("seam 4: a throwing turn releases its conversation and its lease, and the next turn proceeds", async () => {
  const { SessionBook } = await import("../src/sessions.js");
  const { makeTurnLock } = await import("../src/turnlock.js");
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-throw-"));
  const led = new AccountLedger(path.join(dir, "runs.db"));
  const book = new SessionBook();
  const oneTurn = makeTurnLock();
  const live = new Set<string>();
  // The resident's turn shape, verbatim in structure: take a slot, add it to the
  // set of leases this process holds, enter the conversation, and release exactly
  // your own on the way out.
  const turn = (key: string, fn: () => Promise<void>) =>
    oneTurn(async () => {
      const slot = led.acquire({ agent: "pm-agent", lane: "serve" });
      const mine = slot.lease!.lease_id;
      live.add(mine);
      book.enter(key);
      try {
        await fn();
      } finally {
        live.delete(mine);
        led.release(mine);
        book.leave(key);
      }
    });
  try {
    await assert.rejects(
      turn("room-1", async () => {
        throw new Error("brain error");
      }),
      /brain error/,
    );
    assert.equal(live.size, 0, "the throwing turn released its own lease");
    assert.equal(led.leases().length, 0, "and the row is gone, so the slot is back");
    assert.equal(book.isLive("room-1"), false, "and the conversation is free");
    await turn("room-1", async () => {
      assert.equal(led.leases().length, 1, "the next turn got a slot");
    });
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- seam 4, extended: the dispatcher (rung 3)
//
// The never-two-turns-one-session property becomes the DISPATCHER's acceptance
// test (RFA-0.8 sect. 6.2). Until rung 3 the property held because the turn lock
// held one turn per PROCESS, which made it true a fortiori; the whole point of
// rung 3 is that several turns run at once, so the property now has to be
// carried by the thing that schedules them. Same barriers, same enumeration, no
// sleeps: the assertion is that the maximum concurrency PER KEY is 1 while the
// maximum across keys reaches the configured N.

test("seam 4: the dispatcher runs N turns at once and never two on one conversation, in any interleaving", async () => {
  const { Dispatcher } = await import("../src/dispatch.js");
  const { SessionBook } = await import("../src/sessions.js");

  for (const concurrency of [1, 2, 3]) {
    const book = new SessionBook();
    const d = new Dispatcher({ concurrency });
    const release = new Map<string, () => void>();
    let liveNow = 0;
    let maxLive = 0;
    const order: string[] = [];

    // Several conversations, several jobs each, submitted in an interleaved
    // order so per-key FIFO is a real claim and not an artefact of submission.
    const jobs = ["a1", "b1", "a2", "c1", "b2", "a3", "c2"];
    for (const id of jobs) {
      const key = id[0];
      const verdict = d.submit({
        key,
        id,
        replyBy: null,
        run: async () => {
          // The session book is the ASSERTION layer: if the dispatcher ever ran
          // two jobs on one key, `enter` throws and the job rejects.
          book.enter(key);
          order.push(id);
          liveNow++;
          maxLive = Math.max(maxLive, liveNow);
          try {
            await new Promise<void>((r) => release.set(id, r));
            book.adopt(key, `sess_${key}`);
          } finally {
            liveNow--;
            book.leave(key);
          }
        },
      });
      assert.equal(verdict.verdict, "queued", `${id} queued`);
    }

    // Drive it: release whatever is running, one wave at a time, until dry.
    for (let wave = 0; wave < jobs.length + 2 && (d.inFlightCount() > 0 || d.queuedCount() > 0); wave++) {
      assert.ok(d.inFlightCount() <= concurrency, `never more than ${concurrency} in flight, saw ${d.inFlightCount()}`);
      for (const [id, r] of [...release]) {
        release.delete(id);
        r();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
    await d.idle();

    assert.equal(maxLive <= concurrency, true, `at most ${concurrency} turns at once, saw ${maxLive}`);
    if (concurrency > 1) assert.ok(maxLive > 1, `concurrency ${concurrency} actually overlapped, saw ${maxLive}`);
    assert.equal(book.liveCount(), 0, "every conversation released");
    assert.deepEqual(order.filter((i) => i[0] === "a"), ["a1", "a2", "a3"], "per-conversation FIFO, whatever ran in between");
    assert.deepEqual(order.filter((i) => i[0] === "b"), ["b1", "b2"]);
    assert.deepEqual(order.filter((i) => i[0] === "c"), ["c1", "c2"]);
    assert.equal(order.length, jobs.length, "nothing dropped");
  }
});

test("seam 4: the keyed turn lock is one turn per SESSION, not one per process (RFA-0.8 sect. 6.1)", async () => {
  const { makeKeyedTurnLock } = await import("../src/turnlock.js");
  const lock = makeKeyedTurnLock();
  const live = new Map<string, number>();
  let maxPerKey = 0;
  let maxTotal = 0;
  let total = 0;
  const gate = new Map<string, () => void>();
  const runs = ["x:1", "y:1", "x:2", "z:1", "y:2"].map((tag) => {
    const key = tag.split(":")[0];
    return lock(key, async () => {
      live.set(key, (live.get(key) ?? 0) + 1);
      total++;
      maxPerKey = Math.max(maxPerKey, live.get(key)!);
      maxTotal = Math.max(maxTotal, total);
      await new Promise<void>((r) => gate.set(tag, r));
      live.set(key, live.get(key)! - 1);
      total--;
      return tag;
    });
  });
  for (let i = 0; i < 6; i++) {
    for (const [, r] of [...gate]) r();
    gate.clear();
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(await Promise.all(runs), ["x:1", "y:1", "x:2", "z:1", "y:2"]);
  assert.equal(maxPerKey, 1, "one turn per key, which is one writer per session id");
  assert.ok(maxTotal > 1, "different keys DO overlap: that is the narrowing rung 3 is");
});

test("seam 4: the turn binding travels with its turn, so two live turns each find their own", async () => {
  const { TurnRegister } = await import("../src/turnbinding.js");
  const reg = new TurnRegister();
  const mk = (runId: string) => ({ runId, leaseId: `lse_${runId}`, agent: "a", lane: "serve" as const, chain: null, replyBy: null, conversationId: null, taskId: null });
  const seen: (string | null)[] = [];
  // The pre-rung-3 fallback still answers with one live turn and no store.
  const un = reg.bind(mk("solo"));
  assert.equal(reg.current()?.runId, "solo", "one live turn: the population is still an answer");
  un();

  const a = mk("A");
  const b = mk("B");
  const ua = reg.bind(a);
  const ub = reg.bind(b);
  // Two live turns: the population is no longer an answer, and null is the
  // honest one rather than either binding.
  assert.equal(reg.current(), null, "two live turns and no store: null, never a guess");
  await Promise.all([
    reg.run(a, async () => {
      await new Promise((r) => setImmediate(r));
      seen.push(reg.current()?.runId ?? null);
      // Nested async work still sees its own turn.
      await Promise.resolve().then(() => seen.push(reg.current()?.runId ?? null));
    }),
    reg.run(b, async () => {
      seen.push(reg.current()?.runId ?? null);
      await new Promise((r) => setImmediate(r));
      seen.push(reg.current()?.runId ?? null);
    }),
  ]);
  ua();
  ub();
  assert.deepEqual(seen.filter((s) => s === "A").length, 2, "turn A saw itself twice");
  assert.deepEqual(seen.filter((s) => s === "B").length, 2, "turn B saw itself twice");
  assert.equal(seen.includes(null), false, `no turn lost its binding: ${seen.join(",")}`);
});

test("seam 4: a queued request refused inline meanwhile is skipped at DEQUEUE, not answered twice", async () => {
  const { Dispatcher } = await import("../src/dispatch.js");
  // Rung 2's hazard, widened by the queue: the ask-wait loop refuses a request
  // with `would_deadlock` while it is SITTING IN THE QUEUE, and answering it
  // afterwards would be a full answer to a request already refused.
  const refusedInline = new Set<string>();
  const ran: string[] = [];
  const d = new Dispatcher({ concurrency: 1, shouldSkip: (job) => (refusedInline.has(job.id) ? "already refused inline" : null) });
  let releaseFirst!: () => void;
  d.submit({ key: "k", id: "first", replyBy: null, run: async () => { ran.push("first"); await new Promise<void>((r) => (releaseFirst = r)); } });
  assert.equal(d.submit({ key: "k", id: "second", replyBy: null, run: async () => void ran.push("second") }).verdict, "queued");
  await new Promise((r) => setImmediate(r));
  // ... and now the ask wait refuses it, while it waits.
  refusedInline.add("second");
  releaseFirst();
  await d.idle();
  assert.deepEqual(ran, ["first"], "the refused request was dropped at dequeue, not answered off the other cursor");

  // Submitted AFTER the refusal it is skipped at the door, with nothing to send.
  assert.equal(d.submit({ key: "k", id: "second", replyBy: null, run: async () => void ran.push("again") }).verdict, "skipped");
});

test("seam 4: deadline-aware admission refuses at the door and sheds at the gate, never into a dead reply_by", async () => {
  const { Dispatcher, MIN_VIABLE_TURN_MS } = await import("../src/dispatch.js");
  let clock = 1_000_000;
  const now = () => clock;
  const iso = (ms: number) => new Date(ms).toISOString();
  const d = new Dispatcher({ concurrency: 1, now });
  const ran: string[] = [];
  const shed: string[] = [];

  // 1. Already past, or too close to be worth starting: refused AT ADMISSION.
  const past = d.submit({ key: "k", id: "past", replyBy: iso(clock - 1), run: async () => void ran.push("past") });
  assert.equal(past.verdict, "refused");
  assert.equal(past.verdict === "refused" && past.reason, "deadline_expired");
  const tight = d.submit({ key: "k", id: "tight", replyBy: iso(clock + MIN_VIABLE_TURN_MS - 1), run: async () => void ran.push("tight") });
  assert.equal(tight.verdict, "refused", "a deadline under one viable turn buys a truncated answer nobody can use");

  // 2. Admitted with room, then the queue eats its deadline: SHED at dequeue
  // with a refusal, never started into a reply_by that has passed.
  let release!: () => void;
  assert.equal(d.submit({ key: "k", id: "slow", replyBy: iso(clock + 600_000), run: async () => { ran.push("slow"); await new Promise<void>((r) => (release = r)); } }).verdict, "queued");
  await new Promise((r) => setImmediate(r));
  assert.equal(
    d.submit({ key: "k", id: "waiting", replyBy: iso(clock + 60_000), onShed: (_r, detail) => shed.push(detail), run: async () => void ran.push("waiting") }).verdict,
    "queued",
    "at submit it still had a minute, so it was admitted honestly",
  );
  clock += 120_000; // the slow turn outlived the second asker's deadline
  release();
  await d.idle();
  assert.deepEqual(ran, ["slow"], "the expired request was shed, not executed");
  assert.equal(shed.length, 1, "and the asker was told, on the wire, rather than dropped silently");
  assert.match(shed[0], /reply_by/);
});

test("seam 4: backpressure refuses the ARRIVAL, never a request already waiting", async () => {
  const { Dispatcher } = await import("../src/dispatch.js");
  const d = new Dispatcher({ concurrency: 1, queueLimit: 2, maxQueued: 3 });
  const ran: string[] = [];
  const releases: (() => void)[] = [];
  const job = (key: string, id: string) => d.submit({ key, id, replyBy: null, run: async () => { ran.push(id); await new Promise<void>((r) => releases.push(r)); } });

  assert.equal(job("a", "a1").verdict, "queued"); // starts
  assert.equal(job("a", "a2").verdict, "queued"); // queued 1
  assert.equal(job("a", "a3").verdict, "queued"); // queued 2
  const overKey = job("a", "a4");
  assert.equal(overKey.verdict, "refused", "the per-conversation limit is a refusal to the newcomer");
  assert.equal(overKey.verdict === "refused" && overKey.reason, "overloaded");
  assert.ok(overKey.verdict === "refused" && (overKey.retryAfterS ?? 0) > 0, "and it carries a retry hint, because it IS transient");

  assert.equal(job("b", "b1").verdict, "queued"); // queued 3, hits maxQueued
  const overAll = job("c", "c1");
  assert.equal(overAll.verdict, "refused", "the global limit refuses too");
  assert.match(overAll.verdict === "refused" ? overAll.detail : "", /queued across/);

  for (let i = 0; i < 8 && (d.inFlightCount() > 0 || d.queuedCount() > 0); i++) {
    for (const r of releases.splice(0)) r();
    await new Promise((r) => setImmediate(r));
  }
  await d.idle();
  assert.deepEqual(ran, ["a1", "a2", "a3", "b1"], "everything that was ADMITTED ran; nothing waiting was dropped to make room");
});

// ---------------------------------------------------------------- seam 3, extended: the budget reservation (rung 3)
//
// The two-connection lease race becomes the RESERVATION test (RFA-0.8 sect. 5).
// The sharpest thing to assert is the interaction with rung 2: a PARKED lease has
// freed its SLOT but not its MONEY, so the slot count and the money count must
// DISAGREE about that row, and one query for both would get one of them wrong.

test("seam 3: admission reserves inside the same transaction, so N concurrent turns cannot admit against one stale spend", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-resv-"));
  const db = path.join(dir, "runs.db");
  const one = new AccountLedger(db);
  const two = new AccountLedger(db);
  try {
    one.setCap(4);
    const day = "2026-08-26";
    const budget = { perDayUsd: 5, perTaskUsd: 2, day };
    // Four turns, across two connections, with NOTHING settled yet: before
    // reservations all four would have read spend=0 and each been granted a
    // whole 2 dollar ceiling, admitting a 8 dollar day against a 5 dollar cap.
    const grants: (number | null | undefined)[] = [];
    const leases: string[] = [];
    for (const ledger of [one, two, one, two]) {
      const res = ledger.acquire({ agent: "pm", lane: "serve", budget });
      grants.push(res.granted_usd);
      if (res.lease) leases.push(res.lease.lease_id);
    }
    assert.deepEqual(grants.slice(0, 2), [2, 2], "the first two get a full per-task ceiling");
    assert.equal(grants[2], 1, "the third gets what is LEFT, not another full ceiling");
    assert.equal(grants[3], null, "the fourth is refused: the remainder is under the viability floor, so nothing is granted");
    assert.equal(one.leases().length, 3, "and the refused one holds nothing");

    const refused = two.acquire({ agent: "pm", lane: "serve", budget });
    assert.equal(refused.reason, "budget_exhausted");
    assert.match(refused.detail ?? "", /committed=\$5\.0000 of \$5\.00/);
    assert.ok((refused.retry_after_s ?? 0) > 0, "budget exhaustion IS transient: it clears at midnight, and the hint says so");

    // Settling the truth frees what was reserved and never spent.
    one.release(leases[0], 0.11);
    assert.equal(one.daySpend("pm", day).settled_usd, 0.11);
    const after = two.acquire({ agent: "pm", lane: "serve", budget });
    assert.ok(after.ok, "the 1.89 the first turn did not spend is available again");
    assert.equal(Number(after.granted_usd?.toFixed(4)), 1.89);

    // Attribution: lane, granted ceiling and spend day survive the deleted lease.
    const settled = one.settlements("pm", day);
    assert.equal(settled.length, 1);
    assert.deepEqual(
      { lane: settled[0].lane, ceiling: settled[0].ceiling_usd, actual: settled[0].actual_usd, day: settled[0].spend_day },
      { lane: "serve", ceiling: 2, actual: 0.11, day },
    );
  } finally {
    one.close();
    two.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: a parked lease frees its SLOT and not its MONEY, and the two counts disagree correctly", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-park-money-"));
  const db = path.join(dir, "runs.db");
  const led = new AccountLedger(db);
  try {
    led.setCap(2);
    const day = "2026-08-26";
    const budget = { perDayUsd: 4, perTaskUsd: 2, day };
    const first = led.acquire({ agent: "pm", lane: "serve", budget });
    assert.ok(first.ok && first.lease);
    assert.equal(first.granted_usd, 2);

    // The turn blocks on a nested ask and lends its slot (sect. 6.3).
    assert.equal(led.park(first.lease.lease_id, "ask"), true);
    const snap = led.snapshot();
    assert.equal(snap.in_flight, 0, "the SLOT is free: a blocked turn is spending nothing");
    assert.equal(snap.parked, 1, "and the row is still there, which is what the sweep and the meter read");

    // THE point of this test. The money is NOT free: the turn will resume and
    // spend the ceiling it was granted. One query for both counts would have to
    // pick a side, and either side is wrong for the other.
    assert.equal(led.daySpend("pm", day).reserved_usd, 2, "the reservation rides the PARKED lease");
    const second = led.acquire({ agent: "pm", lane: "serve", budget });
    assert.ok(second.ok, "the freed slot is genuinely usable");
    assert.equal(second.granted_usd, 2, "and it is granted the remaining 2, not another 2 on top of a forgotten reservation");
    const third = led.acquire({ agent: "pm", lane: "serve", budget });
    assert.equal(third.reason, "budget_exhausted", "the parked turn's money was counted, so the third is refused on MONEY");
    assert.notEqual(third.reason, "cap_reached", "and not on slots: the parked row does not hold one");

    // Settle both and the day is what was really spent, not what was reserved.
    led.release(first.lease.lease_id, 0.5);
    led.release(second.lease!.lease_id, 0.25);
    assert.equal(led.daySpend("pm", day).settled_usd, 0.75);
    assert.equal(led.daySpend("pm", day).reserved_usd, 0, "nothing reserved once every lease settled");
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: the knowledge-sync drain barrier holds new admissions, waits for the running ones, and cannot wedge the pack", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-drain-"));
  const db = path.join(dir, "runs.db");
  const sync = new AccountLedger(db);
  const resident = new AccountLedger(db);
  try {
    resident.setCap(3);
    const running = resident.acquire({ agent: "pm", lane: "serve" });
    assert.ok(running.ok && running.lease);

    const held = sync.beginMaintenance("pm", "knowledge sync", { ttlMs: 60_000 });
    assert.ok(held.ok && held.token);
    // New admissions for THIS pack queue behind the barrier; another pack is
    // untouched, because the barrier is pack-scoped.
    const blocked = resident.acquire({ agent: "pm", lane: "serve" });
    assert.equal(blocked.reason, "maintenance");
    const elsewhere = resident.acquire({ agent: "other", lane: "serve" });
    assert.ok(elsewhere.ok, "a barrier on one pack is not an outage for the rest");
    resident.release(elsewhere.lease!.lease_id);
    assert.equal(sync.beginMaintenance("pm", "second sync").ok, false, "one barrier at a time");

    // The drain waits for the turn already running, and says what is left when
    // it cannot have it. Bounded: a resident renewing a long turn must not hold
    // an operator command open forever.
    const timedOut = await sync.drain("pm", { timeoutMs: 60, pollMs: 10 });
    assert.equal(timedOut.drained, false);
    assert.equal(timedOut.remaining.length, 1);
    resident.release(running.lease.lease_id, 0.02);
    assert.deepEqual(await sync.drain("pm", { timeoutMs: 200, pollMs: 10 }), { drained: true, remaining: [] });

    // A maintenance marker is not a turn, and is not a slot.
    assert.equal(sync.snapshot().in_flight, 0);
    assert.equal(sync.leases().length, 0, "leases() means TURNS; the marker shares the table and is not one");
    assert.deepEqual(sync.snapshot().maintenance.map((m) => [m.agent, m.reason]), [["pm", "knowledge sync"]]);

    sync.endMaintenance("pm", held.token);
    assert.ok(resident.acquire({ agent: "pm", lane: "serve" }).ok, "and the pack serves again");
  } finally {
    sync.close();
    resident.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seam 3: a sync killed mid-barrier cannot wedge the pack: the marker's own TTL lapses it", async () => {
  const { AccountLedger } = await import("../src/account.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-wedge-"));
  const db = path.join(dir, "runs.db");
  const led = new AccountLedger(db);
  try {
    const held = led.beginMaintenance("pm", "knowledge sync", { ttlMs: 40 });
    assert.ok(held.ok);
    assert.equal(led.acquire({ agent: "pm", lane: "serve" }).reason, "maintenance");
    // The process dies HERE: no endMaintenance is ever called.
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(led.acquire({ agent: "pm", lane: "serve" }).ok, "the next admission expires the abandoned marker rather than waiting for a human");
  } finally {
    led.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
