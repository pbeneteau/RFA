/**
 * The evidence-gate flywheel (RFA v0.4 spec section 8): slice a real room log
 * around a conversation or task into a labeled replay eval case. Real work
 * becomes the dataset at zero annotation cost.
 *
 * Every case carries the five provenance keys of spec 20.2, stamped here because
 * this is the only moment the answers are known: after the fact nobody can say
 * which room, which run or which seq range a case was cut from, and a case whose
 * origin is unknown cannot be re-cut when the corpus moves under it.
 *
 * Was scripts/promote-case.ts; now `rfa evals promote`, and a function so the
 * labelling sitting delegates to it rather than carrying a second slicer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { RfaEvent } from "../model.js";

export interface PromoteOptions {
  /** The room log to slice: `.rfa/data/rooms/<handle>.ndjson`, or a backup of it. */
  logFile: string;
  room: string;
  conversation?: string;
  taskId?: string;
  caseId: string;
  /** Where case directories go. */
  outRoot: string;
  /** The label this case exists to catch, in the words of the findings ledger. */
  failureMode?: string;
  now?: Date;
}

export interface PromoteResult {
  dir: string;
  events: number;
  seqFrom: number;
  seqTo: number;
  originRunId: string | null;
  notes: string[];
}

export function promoteCase(o: PromoteOptions): PromoteResult {
  if (!o.conversation && !o.taskId) throw new Error("promote needs a conversation id or a task id");
  const events = fs
    .readFileSync(o.logFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RfaEvent);

  // The slice: everything in the linked seq range, plus enough roster history to
  // resolve the subject. "Enough" is ONE snapshot, not all of it: a roster event
  // carries the complete members array, and the runner takes the first event
  // that advertises the capability. On the standing room the alternative wrote
  // 1041 roster events beside 2 messages, a 4.6 MB reference.ndjson in a TRACKED
  // directory.
  const linked = events.filter((e) => {
    if (e.type === "message") return o.conversation ? e.envelope.conversation_id === o.conversation : e.envelope.task === o.taskId;
    if (e.type === "task") return o.taskId ? e.task.id === o.taskId : e.task.conversation_id === o.conversation;
    return false;
  });
  if (linked.length === 0) throw new Error(`nothing linked to ${o.conversation ?? o.taskId} in ${o.logFile}`);
  const lo = Math.min(...linked.map((e) => e.seq));
  const hi = Math.max(...linked.map((e) => e.seq));
  const rosterBefore = events.filter((e) => e.type === "roster" && e.seq < lo).at(-1);
  const slice = events.filter((e) => e === rosterBefore || (e.seq >= lo && e.seq <= hi));

  const finalTasks = new Map<string, { id: string; state: string; verified: boolean }>();
  for (const e of slice) if (e.type === "task") finalTasks.set(e.task.id, { id: e.task.id, state: e.task.state, verified: e.task.verification.verdict === "accept" });
  // The engine run id of the answer (spec 20.2 origin_run_id): residents stamp it
  // into the json part of every answer. The LAST one wins: a slice with several
  // answers is anchored on the one being judged.
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
    id: o.caseId,
    kind: "replay" as const,
    subject_capability: "CHANGE-ME (or set subject: m_xxx)",
    expect: {
      ...(finalTasks.size ? { state: [...finalTasks.values()].map((t) => ({ id: t.id, state: t.state, ...(t.verified ? { verified: true } : {}) })) } : {}),
      output: { must_mention: ["EDIT-ME"] },
      protocol: ["citations_present", "atomic_claims", "no_gone_quiet"],
    },
    origin_run_id: originRunId,
    origin_room: o.room,
    origin_seq_range: { from: lo, to: hi },
    promoted_at: (o.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    failure_mode: o.failureMode ?? "UNLABELLED",
  };
  const dir = path.join(o.outRoot, o.caseId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "reference.ndjson"), slice.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "case.yaml"), YAML.stringify(def));
  const notes = ["edit case.yaml: set the subject and real must_mention expectations before trusting it"];
  if (!originRunId) notes.push("no run_id in this slice, so origin_run_id is null: the slice holds no resident answer (a task-only slice, or a log written before residents stamped run ids)");
  if (!o.failureMode) notes.push("failure_mode is UNLABELLED: pass --failure-mode with the label this case exists to catch, the same words used in the findings ledger");
  return { dir, events: slice.length, seqFrom: lo, seqTo: hi, originRunId, notes };
}
