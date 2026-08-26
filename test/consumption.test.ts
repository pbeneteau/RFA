/**
 * Approval-card consumption (RFA-0.8 sect. 6.4, rung 2): canonical action
 * identity, the uniqueness-constraint claim in the shared store, the effect
 * class, and the idempotency key.
 *
 * The measured problem, so a later reader knows what these tests defend: the
 * card clock of v0.5 sect. 16 fixed WHEN a card dies and nothing fixed HOW MANY
 * TIMES its approval fires. 39.8 percent of uncertain execution outcomes induce
 * a semantically equivalent re-proposal of an already-authorized action, and a
 * fresh card per call does not help because the retry legitimately earns one.
 * Separately, cross-process double-fire of a parked interrupt was measured at 10
 * of 10 attempts on every durable backend tried.
 *
 * The last test in this file is the only one that proves the second half, and it
 * spawns real processes to do it. A same-process version would assert exactly
 * the property the spec says does not compose.
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  actionIdentity,
  actionScope,
  DEFAULT_EFFECT_CLASS,
  effectClassOf,
  mayRetryUnsettled,
  normalizeInput,
} from "../src/actionid.js";
import { pidAlive } from "../src/account.js";
import { Engine } from "../src/engine.js";
import { nodeArgsFor } from "../src/proc.js";

const execFileAsync = promisify(execFile);

function freshEngine(): { engine: Engine; dir: string; db: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-consume-"));
  const db = path.join(dir, "runs.db");
  return { engine: new Engine(db), dir, db };
}

// ---------------------------------------------------------------- identity

test("identity: the same action minted twice, independently, is one identity", () => {
  // The retry-after-a-restart case. Two mints that never talked must agree, or
  // the ledger is back to being the human.
  const scope = actionScope({ taskId: "t_1" });
  const a = actionIdentity({ toolName: "linear__save_document", input: { title: "Spec", project: "PRJ-118" }, scope });
  const b = actionIdentity({ toolName: "linear__save_document", input: { project: "PRJ-118", title: "Spec" }, scope });
  assert.equal(a, b, "key order is not part of the action");
  assert.match(a, /^act1_[0-9a-f]{32}$/, "the prefix is the NORMALIZATION VERSION, so a rule change is visible in the table");
});

test("identity: a reflowed re-proposal is the same action; a changed argument is not", () => {
  const scope = actionScope({ conversationId: "c_9ab3" });
  const base = actionIdentity({ toolName: "t", input: { body: "one two three" }, scope });
  assert.equal(
    actionIdentity({ toolName: "t", input: { body: "  one   two\n three  " }, scope }),
    base,
    "a model that reflows its own prose has not proposed a different action",
  );
  assert.equal(
    actionIdentity({ toolName: "t", input: { body: "one two three", note: null, extra: "" }, scope }),
    base,
    "dropping an optional empty field is not a different action either",
  );
  assert.notEqual(actionIdentity({ toolName: "t", input: { body: "one two four" }, scope }), base, "a different argument IS a different action");
  assert.notEqual(actionIdentity({ toolName: "u", input: { body: "one two three" }, scope }), base, "so is a different tool");
  assert.notEqual(
    actionIdentity({ toolName: "t", input: { body: "one two three" }, scope: actionScope({ conversationId: "c_other" }) }),
    base,
    "and so is a different scope: the same send to two conversations is two sends",
  );
});

test("identity: array order is meaning and is preserved; the idempotency key is not part of the identity", () => {
  const scope = actionScope({ taskId: "t_1" });
  assert.notEqual(
    actionIdentity({ toolName: "mail", input: { to: ["a@x", "b@x"] }, scope }),
    actionIdentity({ toolName: "mail", input: { to: ["b@x", "a@x"] }, scope }),
    "sorting recipients would merge two genuinely different sends",
  );
  // Circularity guard: the key is a CONSEQUENCE of the identity, so a retry that
  // echoes back an injected key must not mint a second identity and claim a
  // second slot. That is the double-fire this mechanism exists to close.
  assert.equal(
    actionIdentity({ toolName: "t", input: { x: 1, idempotency_key: "idem_abc" }, scope }),
    actionIdentity({ toolName: "t", input: { x: 1 } as Record<string, unknown>, scope }),
    "an echoed idempotency key is blind to the identity",
  );
});

test("identity: normalization only removes what carries no meaning", () => {
  assert.deepEqual(normalizeInput({ a: " x  y ", b: null, c: "", d: 0, e: false }), { a: "x y", d: 0, e: false });
  assert.equal(normalizeInput("é"), "é", "NFC: two spellings of one character are one argument");
  assert.deepEqual(normalizeInput({ nested: { keep: "v", drop: "  " } }), { nested: { keep: "v" } });
  // 0 and false survive. An input that means "off" is not an input that is absent,
  // and folding them together would merge "publish: false" with "publish omitted".
});

// ---------------------------------------------------------------- effect class

test("effect class: an unknown or absent class reads as irreversible, never as reversible", () => {
  assert.equal(DEFAULT_EFFECT_CLASS, "irreversible");
  assert.equal(effectClassOf(undefined), "irreversible");
  assert.equal(effectClassOf("nonsense"), "irreversible", "an unrecognised class must not open the gate");
  assert.equal(effectClassOf("reversible"), "reversible");
  assert.equal(mayRetryUnsettled("irreversible"), false, "gate until settlement: 0 of 500 leaked sends, versus 400 of 500 compensating after");
  assert.equal(mayRetryUnsettled("reversible_with_cost"), true, "the compensator shape is the fallback here, and only here");
});

// ---------------------------------------------------------------- the claim

test("claim: one approval fires once, and the second proposal is told it is already done", () => {
  const { engine, dir } = freshEngine();
  try {
    const identity = actionIdentity({ toolName: "linear__save_document", input: { title: "Spec" }, scope: "task:t_1" });
    const first = engine.claimAction({ identity, agent: "pm", toolName: "linear__save_document", scope: "task:t_1", effectClass: "irreversible" });
    assert.equal(first.ok, true);
    const key = first.idempotency_key;

    // While it runs, a racing proposal sees a live holder.
    const during = engine.claimAction({ identity, agent: "pm", toolName: "linear__save_document", scope: "task:t_1", effectClass: "irreversible" });
    assert.equal(during.ok, false);
    assert.equal(during.ok === false && during.reason, "in_flight");
    assert.equal(during.idempotency_key, key, "a loser is told which key is authoritative, not given a second one");

    engine.settleAction(identity, { ok: true, outcome: "doc PRJ-118-42" });
    const after = engine.claimAction({ identity, agent: "pm", toolName: "linear__save_document", scope: "task:t_1", effectClass: "irreversible" });
    assert.equal(after.ok, false);
    assert.equal(after.ok === false && after.reason, "already_consumed", "the 39.8 percent re-proposal is refused by the record, not by a person's memory");
    assert.equal(engine.readAction(identity)?.state, "settled");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: an irreversible action whose outcome is unknown GATES; a reversible one is taken over on the same key", () => {
  const { engine, dir } = freshEngine();
  try {
    // The crash case. `disownAction` is what a turn's `finally` does when it ends
    // without ever seeing the tool's result: not settled, not failed, UNKNOWN.
    const irreversible = "act1_" + "a".repeat(32);
    const first = engine.claimAction({ identity: irreversible, agent: "pm", toolName: "send", scope: "task:t_1", effectClass: "irreversible" });
    assert.equal(first.ok, true);
    engine.disownAction(irreversible);
    assert.equal(engine.readAction(irreversible)?.state, "claimed", "still claimed: nobody knows whether it took effect");
    const gated = engine.claimAction({ identity: irreversible, agent: "pm", toolName: "send", scope: "task:t_1", effectClass: "irreversible" });
    assert.equal(gated.ok, false);
    assert.equal(gated.ok === false && gated.reason, "unsettled_irreversible");

    const reversible = "act1_" + "b".repeat(32);
    const r1 = engine.claimAction({ identity: reversible, agent: "pm", toolName: "draft", scope: "task:t_1", effectClass: "reversible" });
    assert.equal(r1.ok, true);
    engine.disownAction(reversible);
    const r2 = engine.claimAction({ identity: reversible, agent: "pm", toolName: "draft", scope: "task:t_1", effectClass: "reversible" });
    assert.equal(r2.ok, true, "a reversible effect may be retried after a dead holder");
    assert.equal(r2.ok === true && r2.idempotency_key, r1.idempotency_key, "on the ORIGINAL key, so a service that dedupes on it collapses both attempts");
    assert.equal(r2.ok === true && r2.reclaimed, "after_dead_holder");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: a failed call frees the identity for an honest retry, on the original key", () => {
  const { engine, dir } = freshEngine();
  try {
    const identity = "act1_" + "c".repeat(32);
    const first = engine.claimAction({ identity, agent: "pm", toolName: "send", scope: "task:t_1", effectClass: "irreversible" });
    engine.settleAction(identity, { ok: false, outcome: "connection refused" });
    assert.equal(engine.readAction(identity)?.state, "failed");
    const again = engine.claimAction({ identity, agent: "pm", toolName: "send", scope: "task:t_1", effectClass: "irreversible" });
    assert.equal(again.ok, true, "a call that never reached the far side is not a consumed approval");
    assert.equal(again.ok === true && again.idempotency_key, first.idempotency_key);
    assert.equal(again.ok === true && again.reclaimed, "after_failure");
    assert.equal(engine.unsettledActions().length, 1, "and it shows in the operator's unsettled view while it runs");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: the record survives a restart, which is the whole reason it is not in memory", () => {
  const { engine, dir, db } = freshEngine();
  const identity = "act1_" + "d".repeat(32);
  engine.claimAction({ identity, agent: "pm", toolName: "send", scope: "task:t_1", effectClass: "irreversible" });
  engine.settleAction(identity, { ok: true, outcome: "sent" });
  engine.close();
  // A fresh Engine on the same file is what a restarted resident is.
  const restarted = new Engine(db);
  try {
    const after = restarted.claimAction({ identity, agent: "pm", toolName: "send", scope: "task:t_1", effectClass: "irreversible" });
    assert.equal(after.ok, false);
    assert.equal(after.ok === false && after.reason, "already_consumed", "a human approving one card twice across a restart causes exactly one execution");
  } finally {
    restarted.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claim: pid 0 is not a live holder, which `process.kill` would otherwise say it is", () => {
  // Found while building the disown path, and worth a test of its own because
  // the same helper decides whether an account lease gets swept: `process.kill(0, 0)`
  // signals the caller's whole process GROUP and succeeds, and `process.kill(-1, 0)`
  // broadcasts. Both would read as "alive". A disowned claim would then look
  // in-flight forever, and a lease row carrying a 0 would never be reclaimed.
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(process.pid), true, "and a real live pid still reads as live");
});

test("resident: the pre-check comes BEFORE the card and the claim comes AFTER approval, in that order", () => {
  // A shape test, like the lease-scope seam, because the two halves solve
  // different failures and swapping them is silently wrong in both directions:
  //
  //  - the read-only PRE-CHECK before the card is what stops a person being asked
  //    to decide the same action twice (the 39.8 percent re-proposal), and moving
  //    it after the card puts the question in front of them anyway;
  //  - the consuming CLAIM after approval is the cross-process uniqueness INSERT,
  //    and moving it before approval would consume the identity on a REJECTED
  //    proposal, so an honest corrected retry would then be refused.
  //
  // Neither mistake fails a behavioural test that only drives one process and one
  // approval, which is exactly why the order is pinned here.
  const src = fs.readFileSync(path.join(import.meta.dirname ?? ".", "..", "src", "resident.ts"), "utf8");
  const identity = src.indexOf("const identity = actionIdentity(");
  const precheck = src.indexOf("engine.readAction(identity)");
  const card = src.indexOf("await requestApproval(");
  const approved = src.indexOf("if (!outcome.approved)");
  const claim = src.indexOf("engine.claimAction(");
  // The allow that follows the claim, not the earlier bypass-mode one: searched
  // FROM the claim so the anchor cannot match above it.
  const allow = src.indexOf('behavior: "allow" as const', claim);
  assert.ok([identity, precheck, card, approved, claim, allow].every((i) => i > 0), "every anchor is present");
  assert.ok(identity < precheck, "the identity is minted before anything reads the store for it");
  assert.ok(precheck < card, "the pre-check runs BEFORE a human is paged");
  assert.ok(approved < claim, "nothing is consumed until a human has approved");
  assert.ok(claim < allow, "and the claim is taken BEFORE execution is allowed, which is the placement the spec fixes");
});

// ---------------------------------------------------------------- cross-process

test("claim: eight PROCESSES racing one identity produce exactly one execution", async () => {
  // The measurement this test exists for: cross-process double-fire of a parked
  // interrupt at 10 of 10 attempts on every durable backend, with no ceiling
  // below sixteen racers, and the write-path gate repair built and falsified. So
  // the claim is a uniqueness-constraint INSERT in a SHARED store, and the proof
  // has to cross a process boundary or it proves nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-race-"));
  const db = path.join(dir, "runs.db");
  // Create the schema once from here, so the racers contend on the claim and not
  // on eight simultaneous first-time migrations.
  new Engine(db).close();
  const racer = path.join(import.meta.dirname ?? ".", "claimracer.ts");
  const identity = "act1_" + "e".repeat(32);
  const startAt = Date.now() + 700;
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(process.execPath, [...nodeArgsFor(racer), db, identity, "irreversible", String(startAt)], {
          encoding: "utf8",
          timeout: 60_000,
        }).then((r) => JSON.parse(r.stdout) as { pid: number; ok: boolean; key: string; reason: string | null }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, `exactly one process may execute; got ${winners.length} (${results.map((r) => `${r.pid}:${r.ok}`).join(" ")})`);
    const key = winners[0].key;
    assert.ok(
      results.every((r) => r.key === key),
      "every racer, winner and loser, agrees which idempotency key is authoritative",
    );
    assert.ok(
      results.filter((r) => !r.ok).every((r) => r.reason === "in_flight" || r.reason === "unsettled_irreversible"),
      `the losers are refused for a named reason: ${results.map((r) => r.reason).join(",")}`,
    );
    const engine = new Engine(db);
    assert.equal(engine.unsettledActions().length, 1, "one row, one claim");
    engine.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
