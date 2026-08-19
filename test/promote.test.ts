/**
 * Promotion turns a real room log into an eval case (spec 20.2), and this guards
 * the two things that made it wrong in practice: the provenance keys, and the
 * size of the slice.
 *
 * The slice used to include EVERY roster event since the room opened, on the
 * reasoning that subject resolution needs them. It needs one: a roster event
 * carries the whole `members` array, and the runner takes the first event that
 * advertises the capability. On the standing room that wrote 1041 roster events
 * beside 2 messages, a 4.6 MB reference.ndjson into a TRACKED directory where the
 * existing case is 3.5 KB. Nothing failed, which is why it needs a test.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** A log shaped like the real thing: a long roster history, then one short conversation. */
function syntheticLog(file: string): void {
  const lines: string[] = [];
  let seq = 0;
  const members = (skills: string[]) => [
    { id: "m_subject", name: "pm-agent", role: "participant", state: "ready", card_summary: { skill_ids: skills } },
    { id: "m_asker", name: "asker", role: "participant", state: "ready", card_summary: { skill_ids: [] } },
  ];
  // 200 roster events of history: the bloat this test exists to catch.
  for (let i = 0; i < 200; i++) {
    lines.push(JSON.stringify({ seq: seq++, ts: "2026-08-19T10:00:00Z", type: "roster", reason: "join", epoch: i, actor: null, members: members(["answer-product-question"]) }));
  }
  const ask = seq++;
  lines.push(JSON.stringify({
    seq: ask, ts: "2026-08-19T11:00:00Z", type: "message",
    envelope: { message_id: "msg_ask00001", conversation_id: "c_test", from: { id: "m_asker", name: "asker" }, kind: "request", body: [{ type: "text", text: "what is the fee?" }] },
  }));
  const answer = seq++;
  lines.push(JSON.stringify({
    seq: answer, ts: "2026-08-19T11:00:20Z", type: "message",
    envelope: {
      message_id: "msg_answer001", conversation_id: "c_test", from: { id: "m_subject", name: "pm-agent" }, kind: "response",
      body: [{ type: "text", text: "1 % per year." }, { type: "json", value: { answered_by: "pm-agent", run_id: "run_deadbeef1234", cost_usd: 0.04, num_turns: 3 } }],
    },
  }));
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

test("promotion stamps all five provenance keys, from the log itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-promote-"));
  const log = path.join(dir, "room.ndjson");
  syntheticLog(log);
  execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts", "promote-case.ts"), "r_test", "--conversation", "c_test",
     "--id", "cs", "--out", dir, "--log", log, "--failure-mode", "retrieval-wrong-file"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const def = YAML.parse(fs.readFileSync(path.join(dir, "cs", "case.yaml"), "utf8")) as Record<string, unknown>;

  assert.equal(def.origin_run_id, "run_deadbeef1234", "the run id comes out of the answer's own json part");
  assert.equal(def.origin_room, "r_test");
  assert.deepEqual(def.origin_seq_range, { from: 200, to: 201 }, "two integers, inclusive");
  assert.match(String(def.promoted_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "ISO-8601 UTC instant, no millis");
  assert.equal(def.failure_mode, "retrieval-wrong-file", "the label used in the findings ledger");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the slice carries one roster snapshot, not the room's whole roster history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-promote-"));
  const log = path.join(dir, "room.ndjson");
  syntheticLog(log);
  execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts", "promote-case.ts"), "r_test", "--conversation", "c_test",
     "--id", "cs", "--out", dir, "--log", log],
    { cwd: ROOT, encoding: "utf8" },
  );
  const events = fs
    .readFileSync(path.join(dir, "cs", "reference.ndjson"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; members?: { card_summary: { skill_ids: string[] } }[] });

  const roster = events.filter((e) => e.type === "roster");
  assert.equal(roster.length, 1, `one snapshot is sufficient and 200 is bloat (got ${roster.length})`);
  assert.equal(events.length, 3, "the snapshot plus the two messages, and nothing else");
  // The reason the snapshot is there at all: the runner resolves the subject from it.
  assert.ok(
    roster[0].members!.some((m) => m.card_summary.skill_ids.includes("answer-product-question")),
    "the retained snapshot must still advertise the capability, or subject resolution breaks",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an unlabelled promotion still carries the key, and says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-promote-"));
  const log = path.join(dir, "room.ndjson");
  syntheticLog(log);
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts", "promote-case.ts"), "r_test", "--conversation", "c_test",
     "--id", "cs", "--out", dir, "--log", log],
    { cwd: ROOT, encoding: "utf8" },
  );
  const def = YAML.parse(fs.readFileSync(path.join(dir, "cs", "case.yaml"), "utf8")) as Record<string, unknown>;
  assert.equal(def.failure_mode, "UNLABELLED", "spec 20.2 wants five keys present, not four and a silence");
  assert.match(out, /failure_mode is UNLABELLED/, "and the operator is told to label it");
  fs.rmSync(dir, { recursive: true, force: true });
});
