/** v0.4.4 evals core: trajectory mapping, lints, computed reward, pass^k, concurrent tuples. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LINTS, computeReward, intersectWindows, measureRunOverlap, passHatK, rfaLogToTrajectory, scoreConcurrentTrial, validateConcurrentCase, type AskObservation, type ConcurrentAsk } from "../src/evals/trajectory.js";
import type { RfaEvent } from "../src/model.js";

const SUBJ = "m_pm";
let seq = 0;

function msg(from: string, name: string, kind: string, text: string, extra: Record<string, unknown> = {}): RfaEvent {
  seq += 1;
  return {
    seq, ts: new Date(1755400000000 + seq * 1000).toISOString(), type: "message",
    envelope: {
      rfa: "0.1", message_id: `m${seq}`, seq, ts: "", room: "r_t", from: { id: from, name, origin: "agent" },
      kind, to: [], mentions: [], conversation_id: "c1", in_reply_to: null, reply_by: null, task: null,
      body: [{ type: "text", text }], chunk: null, refusal: null, _meta: {}, ext: {}, ...extra,
    },
  } as never;
}

function taskEv(actor: string, action: string, task: Record<string, unknown>): RfaEvent {
  seq += 1;
  return {
    seq, ts: new Date(1755400000000 + seq * 1000).toISOString(), type: "task", action, actor,
    task: {
      id: "t_1", room: "r_t", title: "ship it", description: null, state: "submitted", created_by: "m_dev",
      owner: null, parent_id: null, conversation_id: "c1", blocks: [], blocked_by: [], reply_by: null,
      evidence_required: false, evidence: null, verification: { pending: false, verifier: null, verdict: null, note: null },
      note: null, created_at: "", updated_at: "", ...task,
    },
  } as never;
}

test("rfaLogToTrajectory: subject-centric roles, task actions as tool_calls", () => {
  const events = [
    msg("m_dev", "dev", "request", "what is the minimum?"),
    taskEv(SUBJ, "claim", { state: "working", owner: SUBJ }),
    msg(SUBJ, "pm", "response", "500 EUR, see plan-b-funds.md"),
    taskEv("m_dev", "verify_accept", { state: "completed", owner: SUBJ }),
  ];
  const traj = rfaLogToTrajectory(events, { subject: SUBJ });
  assert.deepEqual(traj.map((m) => m.role), ["user", "assistant", "assistant", "user"]);
  assert.equal(traj[1].tool_calls?.[0].function.name, "room_task_claim");
  assert.match(traj[3].content, /verify_accept/);
  // Conversation filter drops other-conversation messages.
  const other = msg("m_x", "x", "chat", "noise", { conversation_id: "c2" });
  assert.equal(rfaLogToTrajectory([...events, other], { subject: SUBJ, conversation: "c1" }).length, 4);
});

test("lints: timeouts, gone_quiet, double claims, citations, evidence gate", () => {
  const good = [
    msg("m_dev", "dev", "request", "q?"),
    msg(SUBJ, "pm", "response", "answer per enveloppes.md"),
    taskEv(SUBJ, "claim", { state: "working", owner: SUBJ }),
  ];
  for (const id of ["reply_by_honored", "no_gone_quiet", "atomic_claims", "citations_present"]) {
    assert.equal(LINTS[id](good, SUBJ).ok, true, id);
  }
  const uncited = [msg("m_dev", "dev", "request", "q?"), msg(SUBJ, "pm", "response", "trust me, it is 500")];
  assert.equal(LINTS.citations_present(uncited, SUBJ).ok, false);
  const doubleClaim = [taskEv("m_a", "claim", {}), taskEv("m_b", "claim", {})];
  assert.equal(LINTS.atomic_claims(doubleClaim, SUBJ).ok, false);
  const gq: RfaEvent = { seq: ++seq, ts: "", type: "system", event: "gone_quiet", refs: { member: SUBJ } } as never;
  assert.equal(LINTS.no_gone_quiet([gq], SUBJ).ok, false);
  const badEvidence = [taskEv("m_a", "complete", { state: "completed", evidence_required: true, owner: "m_a" })];
  assert.equal(LINTS.evidence_gate_respected(badEvidence, SUBJ).ok, false);
});

test("computeReward: r = r_state x r_output x r_protocol, components reported", () => {
  const events = [
    msg("m_dev", "dev", "request", "minimum for Basique?"),
    taskEv(SUBJ, "claim", { state: "working", owner: SUBJ }),
    msg(SUBJ, "pm", "response", "500 EUR (1000 without a standing order), source plan-b-funds.md"),
    taskEv(SUBJ, "complete", { state: "completed", owner: SUBJ }),
  ];
  const full = computeReward(events, SUBJ, {
    state: [{ title_regex: "ship", state: "completed" }],
    output: { must_mention: ["500", "1000|1 000"] },
    protocol: ["citations_present", "atomic_claims"],
  });
  assert.equal(full.score, 1);
  assert.deepEqual(full.components, { r_state: 1, r_output: 1, r_protocol: 1 });
  // One missing goal zeroes the product but the components tell you which.
  const miss = computeReward(events, SUBJ, { output: { must_mention: ["750"] }, protocol: ["citations_present"] });
  assert.equal(miss.score, 0);
  assert.deepEqual(miss.components, { r_state: 1, r_output: 0, r_protocol: 1 });
  assert.match(miss.comment, /missing \["750"\]/);
});

// ------------------------------------------------- kind: live-concurrent (one trial = one simultaneous tuple)

/** The two questions a concurrent case asks at once: different knowledge areas, so a bleed is unmistakable. */
const PRODUCT: ConcurrentAsk = {
  ask: "Quel est le versement initial minimum pour l'offre Basique de Goodlife ?",
  must_mention: ["500"],
  // A token the SIBLING's correct answer is certain to carry and this one cannot.
  must_not_mention: ["reply_by"],
};
const PROTOCOL: ConcurrentAsk = {
  ask: "Quel est le role du champ reply_by dans une enveloppe RFA ?",
  must_mention: ["deadline|délai"],
  must_not_mention: ["Goodlife", "versement initial"],
};

/**
 * One ask's observed outcome. Note the two clocks, which is the whole point of
 * the rebuild: `client` is the harness's send-to-reply window ("both in flight",
 * always overlapping because the asks are issued in one tick), and `run` is the
 * SUBJECT's own run window out of runs.db, which is what the overlap is measured
 * on. The defaults here are deliberately SERIALIZED run windows, so a test that
 * wants overlap has to say so.
 */
function observed(
  ask: ConcurrentAsk,
  answer: string,
  runId: string | null,
  opts: { run?: { startedAt: number; endedAt: number } | null; client?: { startedAt: number; endedAt: number }; noJson?: boolean } = {},
): AskObservation {
  return {
    index: ask === PRODUCT ? 0 : 1,
    ask,
    events: [msg("m_probe", "probe", "request", ask.ask), msg(SUBJ, "pm", "response", answer)],
    json: opts.noJson ? null : { runId },
    client: opts.client ?? { startedAt: 1000, endedAt: 9000 },
    run: opts.run === undefined ? { startedAt: ask === PRODUCT ? 1000 : 5200, endedAt: ask === PRODUCT ? 5000 : 9000 } : opts.run,
  };
}

const CLEAN_PRODUCT = "500 EUR pour l'offre Basique de Goodlife, source knowledge/handbook/offre/goodlife.md";
const CLEAN_PROTOCOL = "reply_by porte la deadline de reponse; passe ce delai le hub emet un timeout (knowledge/RFA-0.1.md sect. 5)";

/** A tuple whose two RUN windows really intersect: the subject held both turns at once. */
const interleaved = (): AskObservation[] => [
  observed(PRODUCT, CLEAN_PRODUCT, "run_a", { run: { startedAt: 1000, endedAt: 9000 } }),
  observed(PROTOCOL, CLEAN_PROTOCOL, "run_b", { run: { startedAt: 1200, endedAt: 8000 } }),
];

test("a concurrent tuple passes when each asker got the answer to ITS OWN question, on distinct run ids", () => {
  const res = scoreConcurrentTrial(interleaved(), SUBJ, { protocol: ["citations_present"] });
  assert.equal(res.score, 1, res.comment);
  assert.equal(res.unmeasurable, null);
  assert.deepEqual(res.perAsk.map((a) => a.score), [1, 1]);
  assert.deepEqual(res.runIds, ["run_a", "run_b"]);
  // The overlap comes from the RUN windows, and the comment says which clock it read.
  assert.equal(res.overlap.state, "overlapped");
  assert.match(res.comment, /overlap 6\.8s of 8\.0s span, on the subject's own run windows/);
});

test("an answer carrying the SIBLING's marker fails the tuple: that is the cross-contamination check", () => {
  // The product answer is right about 500 and then leaks the concurrent
  // conversation's field name. Every other condition holds, so this test isolates
  // must_not_mention as the thing that caught it.
  const bled = `${CLEAN_PRODUCT} - et reply_by porte la deadline de reponse`;
  const res = scoreConcurrentTrial(
    [observed(PRODUCT, bled, "run_a", { run: { startedAt: 1000, endedAt: 9000 } }), observed(PROTOCOL, CLEAN_PROTOCOL, "run_b", { run: { startedAt: 1200, endedAt: 8000 } })],
    SUBJ,
    { protocol: ["citations_present"] },
  );
  assert.equal(res.score, 0, "a leak is a failure even though both must_mention markers are present");
  assert.deepEqual(res.perAsk.map((a) => a.score), [0, 1], "and the report names WHICH ask leaked");
  assert.match(res.comment, /ask 1: .*CONTAMINATED: carries \["reply_by"\]/);
});

test("two concurrent answers sharing one run id fails the tuple; an absent run id fails it; NO json part is unmeasurable instead", () => {
  // The shared-run-context bug class: both answers are individually perfect, so
  // nothing but the run id can be what fails this.
  const shared = scoreConcurrentTrial(
    [observed(PRODUCT, CLEAN_PRODUCT, "run_same"), observed(PROTOCOL, CLEAN_PROTOCOL, "run_same")],
    SUBJ,
    { protocol: ["citations_present"] },
  );
  assert.equal(shared.score, 0);
  assert.match(shared.comment, /run_id SHARED across the tuple \(run_same, run_same\)/);
  // A json part that is THERE and carries no run_id is the resident breaking its
  // own answer contract: a quality failure.
  const absent = scoreConcurrentTrial([observed(PRODUCT, CLEAN_PRODUCT, null), observed(PROTOCOL, CLEAN_PROTOCOL, "run_b")], SUBJ, { protocol: ["citations_present"] });
  assert.equal(absent.score, 0, "an answer with no run_id cannot be told apart from its sibling's");
  assert.match(absent.comment, /run_id absent on 1\/2 answer\(s\) that DID carry a json part/);
  // No json part AT ALL is the harness being blind, not the subject being wrong:
  // unmeasurable, so the runner excludes the trial instead of scoring it 0.
  const blind = scoreConcurrentTrial(
    [observed(PRODUCT, CLEAN_PRODUCT, null, { noJson: true }), observed(PROTOCOL, CLEAN_PROTOCOL, "run_b")],
    SUBJ,
    { protocol: ["citations_present"] },
  );
  assert.equal(blind.unmeasurable !== null, true, "an answer with no json part makes the tuple UNMEASURABLE");
  assert.match(blind.comment, /UNMEASURABLE \(excluded, not scored 0\)/);
});

test("the overlap is measured on the SUBJECT's run windows, never on the client's send-to-reply windows", () => {
  // THE defect this rebuild exists for. Both asks are issued in the same tick, so
  // the client windows below both start at 1000 and their intersection is 4000ms
  // whatever the subject did. The RUN windows say the subject ran them one after
  // the other. The old metric read the client windows and reported overlap on
  // this exact shape, which made expect_overlap an assertion that could not fail.
  const clientBoth = { startedAt: 1000, endedAt: 9000 };
  const serialized = [
    observed(PRODUCT, CLEAN_PRODUCT, "run_a", { client: clientBoth, run: { startedAt: 1000, endedAt: 5000 } }),
    observed(PROTOCOL, CLEAN_PROTOCOL, "run_b", { client: clientBoth, run: { startedAt: 5200, endedAt: 9000 } }),
  ];
  const res = scoreConcurrentTrial(serialized, SUBJ, { protocol: ["citations_present"] });
  assert.equal(res.overlap.state, "serialized", "the run windows are disjoint, so the subject serialized the tuple");
  assert.equal(res.overlap.ms, 0);
  assert.equal(res.score, 1, "serializing is CORRECT at concurrency 1, so the trial still passes");
  // The client windows are still reported, under their own name, and they DO
  // intersect: that is exactly why they must never be the overlap.
  assert.equal(res.inFlightTogether.ms, 8000);
  assert.match(res.comment, /both in flight 8\.0s of 8\.0s client span \(NOT the overlap/);
  assert.match(res.comment, /NO overlap \(the subject serialized the tuple\)/);
});

test("a run window that cannot be read is UNMEASURED, and it never reads as overlap", () => {
  // No runs.db, no run id, a member that is not a local pack: all of them land
  // here. The state is its own thing, distinct from "serialized", because a case
  // that ASSERTS overlap must fail on unmeasured rather than pass by default
  // (overlapVerdict does that, in test/evalconcurrent.test.ts).
  const one = measureRunOverlap([{ startedAt: 0, endedAt: 100 }, null], "no runs.db in this hub directory");
  assert.equal(one.state, "unmeasured");
  assert.equal(one.overlapped, false, "unmeasured is NOT overlapped");
  assert.match(one.detail, /overlap UNMEASURED \(1\/2 run window\(s\) unreadable: no runs\.db in this hub directory\)/);
  assert.match(one.detail, /FAILS on this rather than passing/);
  // And the arithmetic underneath: the widest pairwise intersection, 0 when disjoint.
  assert.equal(intersectWindows([{ startedAt: 0, endedAt: 100 }, { startedAt: 40, endedAt: 300 }]).ms, 60);
  assert.equal(intersectWindows([{ startedAt: 0, endedAt: 100 }, { startedAt: 100, endedAt: 300 }]).ms, 0);
  assert.equal(intersectWindows([{ startedAt: 0, endedAt: 10 }, { startedAt: 500, endedAt: 600 }, { startedAt: 550, endedAt: 560 }]).ms, 10);
  assert.equal(measureRunOverlap([{ startedAt: 0, endedAt: 100 }, { startedAt: 40, endedAt: 300 }]).state, "overlapped");
  assert.throws(() => scoreConcurrentTrial([observed(PRODUCT, CLEAN_PRODUCT, "run_a")], SUBJ, {}), /at least two asks/);
});

test("a live-concurrent case is rejected at LOAD when it asserts nothing or asserts the impossible", () => {
  // expect.output and expect.state are never read for a tuple, so a case setting
  // them looked like it asserted something and asserted nothing.
  assert.deepEqual(validateConcurrentCase({ asks: [PRODUCT, PROTOCOL] }), []);
  assert.match(validateConcurrentCase({ asks: [PRODUCT, PROTOCOL], expect: { output: { must_mention: ["500"] } } })[0], /expect\.output is not read for a tuple/);
  assert.match(validateConcurrentCase({ asks: [PRODUCT, PROTOCOL], expect: { state: [{ state: "completed" }] } })[0], /expect\.state is not read for a tuple/);
  assert.match(validateConcurrentCase({ asks: [PRODUCT] })[0], /at least two asks/);
  // Required AND forbidden on the same ask: no answer can satisfy it, so the case
  // would fail forever and read as a quality collapse.
  const unpassable = validateConcurrentCase({
    asks: [{ ask: "q", must_mention: ["evidence"], must_not_mention: ["evidence"] }, PROTOCOL],
  });
  assert.match(unpassable[0], /ask 1: "evidence" is in must_mention AND must_not_mention/);
  // An any-of marker with ONE alternative still allowed is passable, and must not be rejected.
  assert.deepEqual(
    validateConcurrentCase({ asks: [{ ask: "q", must_mention: ["evidence_required|evidence"], must_not_mention: ["evidence_required"] }, PROTOCOL] }),
    [],
  );
});


test("passHatK: the tau-bench estimator (consistency, not average)", () => {
  // One task, 4 trials, 3 successes: pass^1 = 3/4; pass^2 = C(3,2)/C(4,2) = 3/6.
  assert.equal(passHatK([[true, true, true, false]], 1), 0.75);
  assert.equal(passHatK([[true, true, true, false]], 2), 0.5);
  // All successes: 1 at any k; all failures: 0.
  assert.equal(passHatK([[true, true, true, true]], 4), 1);
  assert.equal(passHatK([[false, false, false, false]], 2), 0);
  // Averaged across tasks: (1 + 0.5) / 2.
  assert.equal(passHatK([[true, true], [true, false]], 1), 0.75);
  assert.throws(() => passHatK([[true]], 2), /at least 2 trials/);
});
