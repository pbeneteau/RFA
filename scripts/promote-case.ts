/**
 * The evidence-gate flywheel (RFA v0.4 spec section 8): slice a real room log
 * around a conversation or task into a labeled replay eval case. Real work
 * becomes the dataset at zero annotation cost.
 *
 *   npx tsx scripts/promote-case.ts <room-handle> --conversation c_xxx --id my-case
 *   npx tsx scripts/promote-case.ts <room-handle> --task t_3 --id my-case [--out evals/cases]
 *   ... --failure-mode retrieval-wrong-file      (the label this case exists to catch)
 *
 * Every case carries the five provenance keys of spec 20.2, stamped here because
 * this is the only moment the answers are known: after the fact nobody can say
 * which room, which run or which seq range a case was cut from, and a case whose
 * origin is unknown cannot be re-cut when the corpus moves under it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { RfaEvent } from "../src/model.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const room = process.argv[2];
const conversation = arg("--conversation");
const taskId = arg("--task");
const caseId = arg("--id");
const outRoot = arg("--out") ?? "evals/cases";
const failureMode = arg("--failure-mode");
if (!room || !caseId || (!conversation && !taskId)) {
  console.error("usage: promote-case <room-handle> (--conversation c_x | --task t_x) --id <case-id> [--out dir] [--failure-mode label] [--log file]");
  process.exit(2);
}

// `--log` so a case can be cut from a backup or an archived log, and so this
// script is testable at all: data/rooms is owned exclusively by the running hub,
// and a test must never write into it.
const logFile = arg("--log") ?? path.join(ROOT, "data", "rooms", `${room}.ndjson`);
const events = fs
  .readFileSync(logFile, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as RfaEvent);

// The slice: everything in the linked seq range, plus enough roster history to
// resolve the subject.
//
// "Enough" is ONE snapshot, not all of it. A roster event carries the complete
// `members` array, and the runner's subject resolution takes the first event that
// advertises the capability, so the state entering the range plus any roster
// change inside it is exactly equivalent to replaying every roster event since
// the room opened. The difference is not academic: on the standing room this
// wrote 1041 roster events beside 2 messages, a 4.6 MB `reference.ndjson` in a
// TRACKED directory where the existing case is 3.5 KB. Three promotions from a
// long-lived room would have added 14 MB of duplicated roster history to the
// repository.
const linked = events.filter((e) => {
  if (e.type === "message") {
    return conversation ? e.envelope.conversation_id === conversation : e.envelope.task === taskId;
  }
  if (e.type === "task") return taskId ? e.task.id === taskId : e.task.conversation_id === conversation;
  return false;
});
if (linked.length === 0) {
  console.error(`nothing linked to ${conversation ?? taskId} in ${logFile}`);
  process.exit(1);
}
const lo = Math.min(...linked.map((e) => e.seq));
const hi = Math.max(...linked.map((e) => e.seq));
const inRange = (e: RfaEvent) => e.seq >= lo && e.seq <= hi;
const rosterBefore = events.filter((e) => e.type === "roster" && e.seq < lo).at(-1);
const slice = events.filter((e) => e === rosterBefore || inRange(e));

// Skeleton expectations from what actually happened (edit before trusting).
const finalTasks = new Map<string, { id: string; state: string; verified: boolean }>();
for (const e of slice) {
  if (e.type === "task") finalTasks.set(e.task.id, { id: e.task.id, state: e.task.state, verified: e.task.verification.verdict === "accept" });
}
// The engine run id of the answer in this slice (spec 20.2 `origin_run_id`). A
// resident stamps it into the json part of every answer, so it is recoverable
// from the log itself rather than needing to be passed in. The LAST one wins: a
// slice that contains several answers is anchored on the one being judged.
let originRunId: string | null = null;
for (const e of slice) {
  if (e.type !== "message") continue;
  for (const part of e.envelope.body ?? []) {
    if (part.type === "json" && part.value && typeof part.value === "object" && "run_id" in part.value) {
      const id = (part.value as { run_id?: unknown }).run_id;
      if (typeof id === "string") originRunId = id;
    }
  }
}

const def = {
  id: caseId,
  kind: "replay" as const,
  subject_capability: "CHANGE-ME (or set subject: m_xxx)",
  expect: {
    ...(finalTasks.size ? { state: [...finalTasks.values()].map((t) => ({ id: t.id, state: t.state, ...(t.verified ? { verified: true } : {}) })) } : {}),
    output: { must_mention: ["EDIT-ME"] },
    protocol: ["citations_present", "atomic_claims", "no_gone_quiet"],
  },
  // Provenance (spec 20.2), stamped at the moment of the cut.
  origin_run_id: originRunId,
  origin_room: room,
  origin_seq_range: { from: lo, to: hi },
  promoted_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  // Free text, and it must match the label used in the findings ledger: the whole
  // point of a promoted case is that it names a failure someone actually saw.
  failure_mode: failureMode ?? "UNLABELLED",
};

const dir = path.join(path.resolve(ROOT, outRoot), caseId);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "reference.ndjson"), slice.map((e) => JSON.stringify(e)).join("\n") + "\n");
fs.writeFileSync(path.join(dir, "case.yaml"), YAML.stringify(def));
console.log(`case promoted: ${path.relative(ROOT, dir)} (${slice.length} events, seq ${lo}..${hi})`);
console.log(`  provenance: run ${originRunId ?? "UNKNOWN"}, ${room} seq ${lo}..${hi}`);
console.log("edit case.yaml: set the subject and real must_mention expectations before trusting it.");
if (!originRunId) {
  console.log("  NOTE: no run_id in this slice, so origin_run_id is null. The slice holds no resident answer");
  console.log("        (a task-only slice, or a log written before residents stamped run ids).");
}
if (!failureMode) {
  console.log("  NOTE: failure_mode is UNLABELLED. Pass --failure-mode with the label this case exists to catch,");
  console.log("        the same words used in the findings ledger, or the case cannot be traced back to its reason.");
}
