/**
 * The evidence-gate flywheel (RFA v0.4 spec section 8): slice a real room log
 * around a conversation or task into a labeled replay eval case. Real work
 * becomes the dataset at zero annotation cost.
 *
 *   npx tsx scripts/promote-case.ts <room-handle> --conversation c_xxx --id my-case
 *   npx tsx scripts/promote-case.ts <room-handle> --task t_3 --id my-case [--out evals/cases]
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
if (!room || !caseId || (!conversation && !taskId)) {
  console.error("usage: promote-case <room-handle> (--conversation c_x | --task t_x) --id <case-id> [--out dir]");
  process.exit(2);
}

const logFile = path.join(ROOT, "data", "rooms", `${room}.ndjson`);
const events = fs
  .readFileSync(logFile, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as RfaEvent);

// The slice: roster events (subject resolution needs them) + everything linked
// to the conversation/task, bounded by first..last linked seq.
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
const slice = events.filter((e) => e.type === "roster" && e.seq <= hi || (e.seq >= lo && e.seq <= hi));

// Skeleton expectations from what actually happened (edit before trusting).
const finalTasks = new Map<string, { id: string; state: string; verified: boolean }>();
for (const e of slice) {
  if (e.type === "task") finalTasks.set(e.task.id, { id: e.task.id, state: e.task.state, verified: e.task.verification.verdict === "accept" });
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
};

const dir = path.join(path.resolve(ROOT, outRoot), caseId);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "reference.ndjson"), slice.map((e) => JSON.stringify(e)).join("\n") + "\n");
fs.writeFileSync(path.join(dir, "case.yaml"), YAML.stringify(def));
console.log(`case promoted: ${path.relative(ROOT, dir)} (${slice.length} events, seq ${lo}..${hi})`);
console.log("edit case.yaml: set the subject and real must_mention expectations before trusting it.");
