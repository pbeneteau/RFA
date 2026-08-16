/** v0.4.4 evals core: trajectory mapping, lints, computed reward, pass^k. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LINTS, computeReward, passHatK, rfaLogToTrajectory } from "../src/evals/trajectory.js";
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
    msg(SUBJ, "pm", "response", "500 EUR, see goodlife-fonds.md"),
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
    msg(SUBJ, "pm", "response", "500 EUR (1000 sans VLP), source goodlife-fonds.md"),
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
