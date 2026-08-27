/**
 * kind: live-concurrent, the RUNNER half (src/evals/concurrent.ts).
 *
 * Why this file exists: everything that decides whether a concurrent case
 * MEASURES anything lived inside src/evals/runner.ts, which calls main() at
 * import and so cannot be imported by a test. Nothing pinned the simultaneous
 * issuance, the index attribution, the refusal classification, the probe release
 * or the run-window read - a SEQUENTIAL loop would have passed the whole suite.
 * The port is injected, so a fake drives the real code here and resolves OUT OF
 * ORDER, which is what the live path does.
 */
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { AccountLedger } from "../src/account.js";
import type { AskResult } from "../src/client.js";
import { Dispatcher } from "../src/dispatch.js";
import { Engine } from "../src/engine.js";
import {
  classifyRefusal,
  liveConcurrentPort,
  openRunWindows,
  overlapVerdict,
  runConcurrentCase,
  type ConcurrentAsker,
  type ConcurrentPort,
  type TrialRecord,
} from "../src/evals/concurrent.js";
import { measureRunOverlap, type ConcurrentAsk, type RfaEvent } from "../src/evals/trajectory.js";
import type { PresenceRecord } from "../src/model.js";

const SUBJ = "m_pm";
const CAP = "answer-protocol-question";

const ASKS: ConcurrentAsk[] = [
  { ask: "what does evidence_required gate?", must_mention: ["accept"], must_not_mention: ["skill_ids"] },
  { ask: "which roster field carries capabilities?", must_mention: ["skill_ids"], must_not_mention: ["accept"] },
];
/** Two answers that are each right about their OWN question and mention nothing of the sibling's. */
const CLEAN = ["a verifier must accept it first, see spec/RFA-0.1.md", "card_summary.skill_ids, see spec/RFA-0.1.md"];

let n = 0;
function msg(from: string, kind: string, text: string): RfaEvent {
  n += 1;
  return {
    seq: n, ts: new Date(1755400000000 + n * 1000).toISOString(), type: "message",
    envelope: {
      rfa: "0.1", message_id: `m${n}`, seq: n, ts: "", room: "r_t", from: { id: from, name: from, origin: "agent" },
      kind, to: [], mentions: [], conversation_id: "c1", in_reply_to: null, reply_by: null, task: null,
      body: [{ type: "text", text }], chunk: null, refusal: null, _meta: {}, ext: {},
    },
  } as never;
}

function subjectRecord(): PresenceRecord {
  return {
    id: SUBJ, name: "pm", role: "member", held: false, state: "ready", detail: null, waiting_for: null, task: null,
    digest: "sha256:deadbeef", card_verified: true,
    card_summary: { name: "pm", description: "answers", skill_ids: [CAP] } as PresenceRecord["card_summary"],
    joined_at: "", last_seen: "", lease_expires: "", epoch: 1,
  };
}

interface FakeOpts {
  /** ms of fake clock each ask takes, by index. Index 1 shorter than index 0 makes the tuple settle OUT OF ORDER. */
  durations?: number[];
  /** Per index, per trial: an answer text, or a refusal to return instead. */
  answers?: (trial: number, index: number) => { text?: string; refuse?: { reason: string; detail: string }; noJson?: boolean; throws?: string };
  /** The subject's own run windows by run id. Absent means the row could not be read. */
  runWindows?: (runId: string) => { startedAt: number; endedAt: number } | null;
  roster?: PresenceRecord[];
}

/**
 * A fake port with a LOGICAL clock. `events` records every start and end in the
 * order they happened, which is what separates a simultaneous implementation from
 * a sequential one: sequential issuance can only ever produce start,end,start,end.
 */
function fakePort(opts: FakeOpts = {}) {
  const events: string[] = [];
  const timeouts: number[] = [];
  const roster = opts.roster ?? [subjectRecord()];
  let clock = 1000;
  let inFlight = 0;
  let inFlightMax = 0;
  let released = 0;
  let trial = -1;
  let minted = 0;
  const runIdFor = (t: number, i: number) => `run_t${t}_a${i}`;

  const port: ConcurrentPort = {
    now: () => clock,
    async mint(label: string): Promise<ConcurrentAsker> {
      // One probe per ask; the label tells the trial and the ask apart.
      if (label.endsWith("a1")) trial += 1;
      minted += 1;
      const memberId = `m_probe_${label}`;
      return {
        memberId,
        name: `eval-${label}`,
        roster,
        async ask(target: string, text: string, o: { timeoutMs?: number }): Promise<AskResult> {
          const index = ASKS.findIndex((a) => a.ask === text);
          timeouts.push(o.timeoutMs ?? -1);
          events.push(`start${index}`);
          inFlight += 1;
          inFlightMax = Math.max(inFlightMax, inFlight);
          const plan = opts.answers?.(trial, index) ?? {};
          // Real await: the point is that both asks are in flight across a real
          // microtask boundary, not that the numbers line up.
          await new Promise((r) => setTimeout(r, (opts.durations?.[index] ?? 10 - index * 5)));
          inFlight -= 1;
          clock += opts.durations?.[index] ?? 1000;
          events.push(`end${index}`);
          if (plan.throws) throw new Error(plan.throws);
          if (plan.refuse) {
            return { kind: "refuse", text: "", parts: [], envelope: {} as AskResult["envelope"], refusal: plan.refuse } as AskResult;
          }
          return {
            kind: "response",
            text: plan.text ?? CLEAN[index],
            parts: plan.noJson ? [] : [{ type: "json", value: { run_id: runIdFor(trial, index) } } as never],
            envelope: {} as AskResult["envelope"],
            refusal: null,
          } as AskResult;
        },
      };
    },
    async release() {
      released += 1;
    },
    runWindow: (runId) =>
      opts.runWindows
        ? opts.runWindows(runId)
        // Default: two windows that really intersect, so the subject interleaved.
        : { startedAt: 0, endedAt: 100 },
    slice: (asker, ask, answer) => [msg(asker.memberId, "request", ask), msg(SUBJ, "response", answer.text)],
    json: (answer) => {
      const part = answer.parts.find((p) => p.type === "json");
      return part ? { runId: (part.value as { run_id?: string }).run_id ?? null } : null;
    },
  };
  return { port, events, timeouts, state: () => ({ inFlightMax, released, minted }) };
}

const CASE = { id: "c-pair", asks: ASKS, subject_capability: CAP, trials: 1, expect: { protocol: ["citations_present"] } };

test("a trial issues its whole tuple AT ONCE: a sequential implementation cannot produce this event order", async () => {
  const f = fakePort();
  const out = await runConcurrentCase(CASE, f.port);
  assert.deepEqual(out.trials, [true], out.comments.join(" | "));
  // THE assertion a sequential loop fails. Ask 1 starts before ask 0 ends, and
  // ask 1 (shorter) ends first: a loop that awaited each ask in turn could only
  // ever emit start0,end0,start1,end1.
  assert.deepEqual(f.events, ["start0", "start1", "end1", "end0"], "both asks in flight together, settling out of order");
  assert.equal(f.state().inFlightMax, 2, "two asks in flight at the same moment");
  assert.equal(f.state().minted, 2, "one fresh probe per ask (duplicate suppression is per sender)");
  assert.equal(f.state().released, 1, "the probes are released once, at the end");
});

test("answers are attributed by the index the issuing closure captured, not by settle order", async () => {
  // The asks settle in reverse. If attribution followed settle order, ask 0's
  // markers would be applied to ask 1's answer and BOTH asks would fail, so the
  // pass below is only reachable when the index is carried.
  const f = fakePort();
  const out = await runConcurrentCase(CASE, f.port);
  assert.deepEqual(out.trials, [true]);
  const perAsk = out.perTrial[0].observations;
  assert.deepEqual(perAsk.map((o) => o.index), [0, 1], "in tuple order, whatever order they settled in");
  assert.equal(perAsk[0].ask.ask, ASKS[0].ask);
  assert.match(perAsk[0].events.at(-1)!.type === "message" ? (perAsk[0].events.at(-1) as never as { envelope: { body: { text: string }[] } }).envelope.body[0].text : "", /accept/);
  // And the swap is really detectable: feed each answer to the other ask and the tuple fails.
  const swapped = fakePort({ answers: (_t, i) => ({ text: CLEAN[1 - i] }) });
  const bad = await runConcurrentCase(CASE, swapped.port);
  assert.deepEqual(bad.trials, [false], "cross-attributed answers fail, so the passing case above is not vacuous");
});

test("the per-ask deadline is the case's timeout MULTIPLIED by the tuple size, because both clocks start at t0", async () => {
  const f = fakePort();
  await runConcurrentCase({ ...CASE, timeout_ms: 60_000 }, f.port);
  assert.deepEqual(f.timeouts, [120_000, 120_000], "a pack that serializes the pair must fit BOTH answers inside one ceiling");
  const dflt = fakePort();
  await runConcurrentCase(CASE, dflt.port);
  assert.deepEqual(dflt.timeouts, [240_000, 240_000], "and the default 120s per answer scales the same way");
});

test("an unresolvable subject_capability is BLOCKED, never a score of 0", async () => {
  // A configuration state must not enter a baseline as quality: this used to throw
  // into the runner's catch, which recorded trials: [false] and score 0.
  const f = fakePort({ roster: [{ ...subjectRecord(), card_summary: { name: "x", description: "", skill_ids: ["something-else"] } as PresenceRecord["card_summary"] }] });
  const out = await runConcurrentCase(CASE, f.port);
  assert.match(out.blocked ?? "", /no roster member offers answer-protocol-question/);
  assert.deepEqual(out.trials, [], "nothing was scored");
  assert.equal(f.state().released, 1, "and the probes are still released");
});

test("a throwing ask propagates, and the probes are released anyway", async () => {
  const f = fakePort({ answers: (_t, i) => (i === 1 ? { throws: "hub went away" } : {}) });
  await assert.rejects(() => runConcurrentCase(CASE, f.port), /trial 1: hub went away/);
  assert.equal(f.state().released, 1, "release runs in a finally: a leaked probe is a zombie membership");
});

test("a tuple of fewer than two asks is refused: one ask is not a concurrency measurement", async () => {
  const f = fakePort();
  await assert.rejects(() => runConcurrentCase({ ...CASE, asks: [ASKS[0]] }, f.port), /at least two asks/);
});

// ------------------------------------------------- refusal classification (finding 7)

test("the classifier splits the subject's ENVIRONMENT from the subject's own dispatcher", () => {
  // Infrastructure: the trial is excluded, exactly as a single-ask case excludes it.
  assert.equal(classifyRefusal({ reason: "overloaded", detail: "daily budget exhausted: spent $3.02 of $3.00" }), "infrastructure");
  assert.equal(classifyRefusal({ reason: "overloaded", detail: "no account slot (retry in 30s)" }), "infrastructure");
  assert.equal(classifyRefusal({ reason: "unauthorized", detail: "this agent cannot authenticate to its model provider" }), "infrastructure");
  assert.equal(classifyRefusal({ reason: "deadline_expired", detail: "the approval card closed on its clock" }), "infrastructure");
  assert.equal(classifyRefusal(null), "infrastructure");
  // The ACCOUNT's own concurrency cap, driven out of the real AccountLedger rather
  // than typed as a literal: its detail says the word "concurrency", so the side it
  // falls on is a real choice, and it was untested - a reword of either the detail
  // or DISPATCHER_DETAIL could have flipped it into a tuple FAILURE in silence.
  // `cap_reached` reaches the asker as the spec 18.3 `overloaded` refusal through
  // AccountStop (src/resident.ts), and a slot the INSTANCE does not have is the
  // environment the subject runs in: excluded like a budget ceiling, not the
  // subject's dispatcher shedding a simultaneous ask.
  const accountDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rfa-evalaccount-")), "runs.db");
  const account = new AccountLedger(accountDb);
  try {
    account.setCap(1);
    assert.ok(account.acquire({ agent: "pm", lane: "serve", runId: "run_1" }).ok, "the first turn takes the only slot");
    const capped = account.acquire({ agent: "pm", lane: "serve", runId: "run_2" });
    assert.equal(capped.reason, "cap_reached");
    assert.match(capped.detail ?? "", /concurrency cap reached/, "the detail really does carry the word this classifier could trip on");
    // Rendered the way the resident renders it: message + the retry hint.
    const onTheWire = `${capped.detail}${capped.retry_after_s ? ` (retry in ${capped.retry_after_s}s)` : ""}`;
    assert.equal(classifyRefusal({ reason: "overloaded", detail: onTheWire }), "infrastructure", onTheWire);
  } finally {
    account.close();
    fs.rmSync(path.dirname(accountDb), { recursive: true, force: true });
  }
  // The surface UNDER TEST refusing a simultaneous ask.
  assert.equal(classifyRefusal({ reason: "would_deadlock", detail: "chain c_1 would wait on itself" }), "dispatcher");
});

test("every refusal a real Dispatcher produces classifies as dispatcher-produced", async () => {
  // The classifier reads refusal DETAILS, because the wire reason cannot separate
  // "queued behind three others" from "out of budget". That coupling is pinned
  // here against the real component, so a reworded detail fails loudly instead of
  // quietly filing the regression as infrastructure again.
  const held: (() => void)[] = [];
  let draining = false;
  // Held open until the assertions are made, then every job (including one the
  // pump starts afterwards) resolves at once, so the dispatchers can drain.
  const holdOpen = () => new Promise<void>((r) => (draining ? r() : held.push(r)));
  const admissions: { reason: string; detail: string }[] = [];
  const collect = (v: ReturnType<Dispatcher["submit"]>) => {
    if (v.verdict === "refused") admissions.push({ reason: v.reason, detail: v.detail });
  };

  // Shape 1, the per-conversation queue limit.
  const perKey = new Dispatcher({ concurrency: 1, queueLimit: 1, maxQueued: 8 });
  collect(perKey.submit({ key: "k0", id: "m0", replyBy: null, run: holdOpen }));
  collect(perKey.submit({ key: "k0", id: "m1", replyBy: null, run: holdOpen }));
  collect(perKey.submit({ key: "k0", id: "m2", replyBy: null, run: holdOpen }));
  // Shape 2, the process-wide queue ceiling. Distinct keys, so the per-key limit
  // cannot be what fires; maxQueued is floored at queueLimit, so both are 1.
  const global = new Dispatcher({ concurrency: 1, queueLimit: 1, maxQueued: 1 });
  collect(global.submit({ key: "k0", id: "g0", replyBy: null, run: holdOpen }));
  collect(global.submit({ key: "k1", id: "g1", replyBy: null, run: holdOpen }));
  collect(global.submit({ key: "k2", id: "g2", replyBy: null, run: holdOpen }));
  // Shape 3, a reply_by the dispatcher can already see is unreachable.
  collect(global.submit({ key: "k9", id: "g9", replyBy: new Date(Date.now() + 1000).toISOString(), run: holdOpen }));

  const details = new Set(admissions.map((a) => a.detail));
  assert.equal(details.size, 3, `expected the dispatcher's three refusal shapes, got ${[...details].join(" | ")}`);
  for (const a of admissions) {
    assert.equal(classifyRefusal(a), "dispatcher", `${a.reason}: ${a.detail}`);
  }
  draining = true;
  for (const r of held) r();
  await perKey.idle();
  await global.idle();
});

test("a dispatcher-produced refusal FAILS the trial with the reason named, instead of reporting BLOCKED", async () => {
  // The regression this case exists to catch is the subject refusing the SECOND
  // simultaneous ask. Filed as infrastructure it excluded every trial, the case
  // reported BLOCKED, and the regression was invisible.
  const f = fakePort({
    answers: (_t, i) => (i === 1 ? { refuse: { reason: "overloaded", detail: "this conversation already has 1 request(s) queued (limit 1)" } } : {}),
  });
  const out = await runConcurrentCase(CASE, f.port);
  assert.deepEqual(out.trials, [false], "a FAILED trial, not an excluded one");
  assert.equal(out.refused.length, 0, "and not filed as infrastructure");
  assert.equal(out.dispatcherRefusals.length, 1);
  assert.match(out.dispatcherRefusals[0], /the subject's DISPATCHER refused a simultaneous ask/);
  assert.match(out.dispatcherRefusals[0], /concurrency surface under test refusing, not infrastructure/);
});

test("a budget refusal still EXCLUDES the trial, and a case whose every trial was refused is blocked", async () => {
  const f = fakePort({ answers: () => ({ refuse: { reason: "overloaded", detail: "daily budget exhausted: spent $3.02 of $3.00" } }) });
  const out = await runConcurrentCase({ ...CASE, trials: 2 }, f.port);
  assert.deepEqual(out.trials, [], "a ceiling is the stack's state, never the answer's quality");
  assert.equal(out.refused.length, 2);
  assert.equal(out.dispatcherRefusals.length, 0);
});

test("an answer with no json part makes the trial UNMEASURABLE, excluded rather than scored 0", async () => {
  const f = fakePort({ answers: (_t, i) => (i === 0 ? { noJson: true } : {}) });
  const out = await runConcurrentCase({ ...CASE, trials: 2 }, f.port);
  assert.deepEqual(out.trials, [], "the harness could not see, which is not the subject failing");
  assert.equal(out.unmeasurable.length, 2);
  assert.match(out.unmeasurable[0], /carried no json part/);
  assert.deepEqual(out.perTrial.map((t) => t.passed), [null, null]);
});

// ------------------------------------------------- the CASE-level overlap assertion (findings 1 and 6)

const trialWith = (state: "overlapped" | "serialized" | "unmeasured", ms = 0): TrialRecord => ({
  index: 0,
  passed: true,
  overlap: { state, overlapped: state === "overlapped", ms, spanMs: 1000, detail: `${state} detail` },
  inFlightTogetherMs: 30_000,
  comment: "",
  observations: [],
});

test("expect_overlap asserts at CASE level: one serialized trial does not zero a correct pack", async () => {
  // Per trial with zero tolerance, one legitimately serialized leg (a lease held
  // elsewhere, a reservation refused on one leg) zeroed a pack that is working.
  const mixed = [trialWith("overlapped", 4000), trialWith("serialized"), trialWith("serialized"), trialWith("overlapped", 2000)];
  const v = overlapVerdict(mixed, true);
  assert.equal(v.assertion?.ok, true, "at least one trial overlapped, which is what the assertion means");
  assert.equal(v.overlapped, 2);
  assert.equal(v.serialized, 2);
  assert.equal(v.max_overlap_ms, 4000);
  // The per-trial measurement stays in the report either way.
  assert.equal(overlapVerdict(mixed, false).assertion, null, "unset: measured and reported, never asserted");
  assert.equal(overlapVerdict(mixed, false).overlapped, 2);
});

test("expect_overlap FAILS when not one trial overlapped, and fails CLOSED on unmeasured", async () => {
  const none = overlapVerdict([trialWith("serialized"), trialWith("serialized")], true);
  assert.equal(none.assertion?.ok, false);
  assert.match(none.assertion!.detail, /not one of 2 trial\(s\) overlapped/);
  // The fail-closed half: an overlap nobody could measure must never pass an
  // assertion. Before the rebuild the metric could not fail at all, so this is
  // the case that must never silently pass again.
  const blind = overlapVerdict([trialWith("unmeasured"), trialWith("unmeasured")], true);
  assert.equal(blind.assertion?.ok, false);
  assert.match(blind.assertion!.detail, /could not be MEASURED on any of 2 trial\(s\)/);
  assert.equal(blind.unmeasured, 2);
  // And the client's "both in flight" number rides along under its own name: it is
  // large here precisely because it is not the overlap.
  assert.equal(blind.max_in_flight_together_ms, 30_000);
});

test("the run windows are read out of a REAL engine DB, so the schema coupling cannot drift silently", async () => {
  // The whole rebuilt metric rests on two column names and an ISO string. Nothing
  // else in the suite touches them, so this drives the actual Engine: if
  // started_at/ended_at are renamed or written in another format, this fails here
  // instead of turning every live overlap into a silent UNMEASURED.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-runwindows-"));
  const file = path.join(dir, "runs.db");
  const engine = new Engine(file);
  try {
    // Two runs on DIFFERENT threads, started together and settled at different
    // times: the shape of a resident that really interleaved two asks.
    const a = engine.createRun({ agent: "pm", threadId: "convo:a", kind: "serve" });
    const b = engine.createRun({ agent: "pm", threadId: "convo:b", kind: "serve" });
    assert.equal(a.action, "start");
    assert.equal(b.action, "start");
    await new Promise((r) => setTimeout(r, 15));
    engine.completeRun(a.runId, { output: {}, costUsd: 0.01, numTurns: 2 });
    engine.completeRun(b.runId, { output: {}, costUsd: 0.01, numTurns: 2 });
    const windows = openRunWindows(file, ".rfa/data/runs.db");
    assert.equal(windows.unavailable, null, "the file is there and readable");
    const wa = windows.lookup(a.runId);
    const wb = windows.lookup(b.runId);
    assert.ok(wa && wb, `both run windows read back (${JSON.stringify({ wa, wb })})`);
    assert.ok(Number.isFinite(wa!.startedAt) && wa!.endedAt >= wa!.startedAt, "and the ISO timestamps parse into a forward window");
    assert.equal(measureRunOverlap([wa, wb]).state, "overlapped", "two runs open at the same time DO overlap on this clock");
    // A run that never settled has no end: unmeasured, never a zero-length window.
    const open = engine.createRun({ agent: "pm", threadId: "convo:c", kind: "serve" });
    assert.equal(windows.lookup(open.runId), null, "a run still in flight is unreadable, not instantaneous");
    assert.equal(windows.lookup("run_nope"), null, "and an unknown run id is null, not a throw");
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // No file at all: the note says so, and every lookup is null.
  const missing = openRunWindows(path.join(dir, "gone.db"), ".rfa/data/runs.db");
  assert.match(missing.unavailable ?? "", /no \.rfa\/data\/runs\.db: nothing local has run here/);
  assert.equal(missing.lookup("run_x"), null);
});

test("an unreadable runs.db makes the whole case's overlap unmeasured, and the note says why", async () => {
  const f = fakePort({ runWindows: () => null });
  const port: ConcurrentPort = { ...f.port, runWindowUnavailable: "no .rfa/data/runs.db: nothing local has run here" };
  const out = await runConcurrentCase({ ...CASE, expect_overlap: true }, port);
  assert.deepEqual(out.trials, [true], "the ANSWERS were still fine: an unreadable clock is not a wrong answer");
  const v = overlapVerdict(out.perTrial, true);
  assert.equal(v.assertion?.ok, false, "but the case asserted overlap and the overlap is unmeasured, so it FAILS");
  assert.equal(out.perTrial[0].observations[0].runNote, "no .rfa/data/runs.db: nothing local has run here");
});

test("the overlap the runner reports comes from the run windows, not from the client windows", async () => {
  // Serialized run windows under a tuple the client held open together: the shape
  // the old metric scored as overlap.
  const f = fakePort({
    runWindows: (runId) => (runId.endsWith("a0") ? { startedAt: 0, endedAt: 5000 } : { startedAt: 5200, endedAt: 9000 }),
  });
  const out = await runConcurrentCase(CASE, f.port);
  assert.equal(out.perTrial[0].overlap.state, "serialized");
  assert.equal(out.perTrial[0].overlap.ms, 0);
  assert.ok(out.perTrial[0].inFlightTogetherMs > 0, "while the client windows DID intersect, which is why they are not the overlap");
});

test("the LIVE port reads the run windows out of a real hub directory's runs.db, and is UNMEASURED when the row is absent", async () => {
  // The last unexercised piece of the rebuilt metric. The openRunWindows call and
  // the runWindow wiring were constructed inline in src/evals/runner.ts, which
  // calls main() at import, so no test could reach them: the live port is built by
  // a factory in src/evals/concurrent.ts now, and this drives that factory against
  // a real engine DB sitting where a hub directory keeps it.
  const hub = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-liveport-"));
  const runsDb = path.join(hub, ".rfa", "data", "runs.db");
  fs.mkdirSync(path.dirname(runsDb), { recursive: true });
  const engine = new Engine(runsDb);
  const f = fakePort();
  try {
    const run = engine.createRun({ agent: "pm", threadId: "convo:a", kind: "serve" });
    await new Promise((r) => setTimeout(r, 5));
    engine.completeRun(run.runId, { output: {}, costUsd: 0.01, numTurns: 1 });
    // What the engine actually wrote, read straight off the table, so "the lookup
    // returns what was written" is an equality and not a plausibility check.
    const raw = new Database(runsDb, { readonly: true });
    const row = raw.prepare(`SELECT started_at, ended_at FROM runs WHERE run_id = ?`).get(run.runId) as { started_at: string; ended_at: string };
    raw.close();

    const port = liveConcurrentPort({
      runsDb,
      runsDbLabel: ".rfa/data/runs.db",
      pool: { mint: (label) => f.port.mint(label), release: () => f.port.release() },
      slice: (asker, ask, answer) => f.port.slice(asker, ask, answer),
      json: (answer) => f.port.json(answer),
    });
    assert.equal(port.runWindowUnavailable, null, "the file is where a hub directory keeps it, and it is readable");
    assert.deepEqual(
      port.runWindow(run.runId),
      { startedAt: Date.parse(row.started_at), endedAt: Date.parse(row.ended_at) },
      "the lookup returns exactly the window the engine wrote",
    );
    assert.equal(port.runWindow("run_absent"), null, "an absent row is null, never an instantaneous window");

    // The wiring, through the real runConcurrentCase: the fake answers carry run
    // ids that have no rows in this DB, so the overlap must be UNMEASURED with the
    // note saying why, instead of reading as serialized (or as overlap).
    const out = await runConcurrentCase({ ...CASE, expect_overlap: true }, { ...port, now: f.port.now });
    assert.deepEqual(out.trials, [true], "the ANSWERS were fine: an absent run row is not a wrong answer");
    assert.equal(out.perTrial[0].overlap.state, "unmeasured");
    assert.match(out.perTrial[0].observations[0].runNote ?? "", /no readable run row for run_t0_a0/);
    assert.equal(overlapVerdict(out.perTrial, true).assertion?.ok, false, "and a case asserting overlap fails CLOSED on it");
  } finally {
    engine.close();
    fs.rmSync(hub, { recursive: true, force: true });
  }
});
