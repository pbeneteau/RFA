/** The answer-parity gate's own verdict logic, unit-tested for the first time (audit 2026-08-30, rank 3). */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RoomMember } from "../src/client.js";
import { answerCites, runParity, type ParityFixture } from "../src/evals/parity.js";

test("answerCites: the word 'resources' in prose is not a citation", () => {
  // The defect this pins: `.includes("sources")` over the stringified parts is
  // satisfied by the TEXT part whenever the prose contains "sources" - or
  // "resources", which contains it - so the gate scored uncited answers 1.
  const parts = (text: string) => [{ type: "text", text }];
  assert.equal(answerCites("check the resources tab for details", parts("check the resources tab for details")), false);
  assert.equal(answerCites("there are many sources of confusion here", parts("there are many sources of confusion here")), false);
  // prose containing the QUOTED word still does not fake the key: stringify
  // escapes the quotes, so the unescaped form cannot come from text
  assert.equal(answerCites('the "sources" field is documented', parts('the "sources" field is documented')), false);
  // the three real shapes
  assert.equal(answerCites("per knowledge/fees.md, the fee is 1%", []), true, "a knowledge path in prose");
  assert.equal(answerCites("see RFA-0.1.md section 7.2", []), true, "a named .md file in prose");
  assert.equal(answerCites("the fee is 1%", [{ type: "json", value: { sources: ["fees.md"] } }]), true, "a machine-readable sources key");
});

test("runParity: an answer that mentions every fact but cites nothing FAILS", async () => {
  const fixtures: ParityFixture[] = [{ question: "what is the fee?", must_mention: ["1 %|one percent"] }];
  const me = {
    ask: async () => ({
      kind: "response",
      text: "The fee is one percent, from several sources.",
      parts: [{ type: "text", text: "The fee is one percent, from several sources." }],
    }),
  } as unknown as RoomMember;
  const [v] = await runParity({ me, subjectId: "m_x", subjectName: "pm", fixtures });
  assert.equal(v.cited, false, "prose containing 'sources' is not a citation");
  assert.equal(v.ok, false, "and an uncited answer fails the fixture even with every fact present");
  assert.deepEqual(v.missing, []);
});

test("runParity: the same answer with a real citation passes", async () => {
  const fixtures: ParityFixture[] = [{ question: "what is the fee?", must_mention: ["1 %|one percent"] }];
  const me = {
    ask: async () => ({
      kind: "response",
      text: "The fee is one percent (knowledge/fees.md).",
      parts: [{ type: "text", text: "The fee is one percent (knowledge/fees.md)." }],
    }),
  } as unknown as RoomMember;
  const [v] = await runParity({ me, subjectId: "m_x", subjectName: "pm", fixtures });
  assert.equal(v.cited, true);
  assert.equal(v.ok, true);
});
