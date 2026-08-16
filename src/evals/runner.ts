/**
 * The eval runner (RFA v0.4 spec section 8).
 *
 *   npm run evals                     tier 2: replay + live cases, baseline-diff gate (exit 1 on regression)
 *   npm run evals -- --update-baseline
 *   npm run evals:judged              tier 3: adds the claude judge on live trajectories
 *
 * Cases are directories holding case.yaml (+ reference.ndjson for replay):
 * discovered under evals/cases/ (tracked, generic) and agents/<x>/evals/cases/
 * (pack-local, gitignored when they carry internal facts). kind: replay scores
 * a recorded event slice; kind: live asks the real resident (by capability)
 * through the standing room, N trials for pass^k. Every live verdict lands as
 * evaluator feedback in obs.db, keyed on the run_id the answer carries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { RoomMember } from "../client.js";
import type { Envelope, RfaEvent } from "../model.js";
import { ObsStore } from "../obs.js";
import { claudeJudge } from "./judge.js";
import { computeReward, passHatK, rfaLogToTrajectory, type ExpectBlock } from "./trajectory.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..", "..");

interface CaseDef {
  id: string;
  kind: "replay" | "live";
  subject?: string;
  subject_capability?: string;
  ask?: string;
  trials?: number;
  timeout_ms?: number;
  expect: ExpectBlock;
}

interface CaseResult {
  id: string;
  kind: string;
  trials: boolean[];
  score: number; // pass^1
  passk: { k: number; value: number } | null;
  comments: string[];
  judge?: { score: number; comment: string };
}

function discoverCases(): { dir: string; def: CaseDef }[] {
  const roots = [path.join(ROOT, "evals", "cases"), ...fs.existsSync(path.join(ROOT, "agents")) ? fs.readdirSync(path.join(ROOT, "agents")).map((a) => path.join(ROOT, "agents", a, "evals", "cases")) : []];
  const out: { dir: string; def: CaseDef }[] = [];
  for (const root of roots.filter((r) => fs.existsSync(r))) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name, "case.yaml");
      if (entry.isDirectory() && fs.existsSync(file)) {
        const def = YAML.parse(fs.readFileSync(file, "utf8")) as CaseDef;
        out.push({ dir: path.join(root, entry.name), def });
      }
    }
  }
  return out.sort((a, b) => a.def.id.localeCompare(b.def.id));
}

function readEvents(file: string): RfaEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RfaEvent);
}

/** Resolve the subject member id: explicit, or by capability from roster events in the slice. */
function resolveSubject(def: CaseDef, events: RfaEvent[]): string {
  if (def.subject) return def.subject;
  if (def.subject_capability) {
    for (const e of events) {
      if (e.type !== "roster") continue;
      const hit = e.members.find((m) => m.card_summary.skill_ids.includes(def.subject_capability!));
      if (hit) return hit.id;
    }
  }
  throw new Error(`case ${def.id}: cannot resolve subject (set subject or subject_capability with roster events present)`);
}

async function runReplay(dir: string, def: CaseDef): Promise<CaseResult> {
  const events = readEvents(path.join(dir, "reference.ndjson"));
  const subject = resolveSubject(def, events);
  const reward = computeReward(events, subject, def.expect);
  return { id: def.id, kind: "replay", trials: [reward.score === 1], score: reward.score, passk: null, comments: [reward.comment] };
}

interface LiveEnv {
  hubUrl: string;
  room: string;
  secret: string;
}

function liveEnv(): LiveEnv {
  const roomMd = fs.readFileSync(path.join(ROOT, "dogfood", "ROOM.md"), "utf8");
  return {
    hubUrl: process.env.RFA_HUB_URL ?? "http://localhost:8790/mcp",
    room: /Room: `(r_\w+)`/.exec(roomMd)![1],
    secret: /Join secret: `([^`]+)`/.exec(roomMd)![1],
  };
}

async function runLive(def: CaseDef, env: LiveEnv, obs: ObsStore | null, judged: boolean): Promise<CaseResult> {
  const probe = await RoomMember.create({
    hubUrl: env.hubUrl, room: env.room, joinSecret: env.secret, name: `eval-${def.id.slice(0, 20)}`,
    card: { name: "eval-probe", description: "eval harness probe", skills: [{ id: "eval", description: "runs eval cases" }] },
  });
  try {
    const subjectRec = probe.roster.find((r) => def.subject_capability && r.card_summary.skill_ids.includes(def.subject_capability));
    if (!subjectRec) throw new Error(`no roster member offers ${def.subject_capability}`);
    const trials: boolean[] = [];
    const comments: string[] = [];
    let judge: CaseResult["judge"];
    for (let i = 0; i < (def.trials ?? 1); i++) {
      const answer = await probe.ask(subjectRec.id, def.ask!, { timeoutMs: def.timeout_ms ?? 120_000 });
      // Reconstruct the exchange as an event slice (live Q&A cases score messages, not board state).
      const asked: RfaEvent = {
        seq: 1, ts: new Date().toISOString(), type: "message",
        envelope: { ...answer.envelope, message_id: "eval_q", seq: 0, from: { id: probe.memberId, name: probe.name, origin: "agent" }, kind: "request", body: [{ type: "text", text: def.ask! }], refusal: null } as Envelope,
      } as never;
      const answered: RfaEvent = { seq: 2, ts: answer.envelope.ts, type: "message", envelope: answer.envelope } as never;
      const events = [asked, answered];
      const reward = computeReward(events, subjectRec.id, def.expect);
      trials.push(reward.score === 1);
      comments.push(`trial ${i + 1}: ${reward.comment}`);
      const runId = (answer.parts.find((p) => p.type === "json")?.value as { run_id?: string } | undefined)?.run_id;
      if (runId && obs) {
        obs.feedback({ run_id: runId, key: `eval:${def.id}`, score: reward.score, comment: reward.comment, source_type: "evaluator" });
        if (reward.score === 0) obs.markReview(runId, true);
      }
      if (judged && i === 0) {
        const j = await claudeJudge(ROOT, rfaLogToTrajectory(events, { subject: subjectRec.id }));
        if (j.score >= 0) {
          judge = { score: j.score, comment: j.comment };
          if (runId && obs) obs.feedback({ run_id: runId, key: "judge", score: j.score, comment: j.comment, source_type: "model" });
        }
      }
    }
    const k = Math.min(4, trials.length);
    return {
      id: def.id, kind: "live", trials,
      score: trials.filter(Boolean).length / trials.length,
      passk: trials.length >= 2 ? { k, value: passHatK([trials], k) } : null,
      comments, judge,
    };
  } finally {
    await probe.leave().catch(() => {});
  }
}

async function main(): Promise<void> {
  const judged = process.argv.includes("--judged");
  const updateBaseline = process.argv.includes("--update-baseline");
  const cases = discoverCases();
  if (cases.length === 0) {
    console.error("no eval cases found (evals/cases/, agents/*/evals/cases/)");
    process.exit(2);
  }
  const obsPath = path.join(ROOT, "data", "obs.db");
  const obs = fs.existsSync(path.dirname(obsPath)) ? new ObsStore(obsPath) : null;
  const env = cases.some((c) => c.def.kind === "live") ? liveEnv() : null;
  const results: CaseResult[] = [];
  for (const { dir, def } of cases) {
    const t0 = Date.now();
    try {
      const res = def.kind === "replay" ? await runReplay(dir, def) : await runLive(def, env!, obs, judged);
      results.push(res);
      const pk = res.passk ? ` pass^${res.passk.k}=${res.passk.value.toFixed(2)}` : "";
      const jd = res.judge ? ` judge=${res.judge.score}` : "";
      console.log(`${res.score === 1 ? "PASS" : res.score > 0 ? "FLAKY" : "FAIL"}  ${def.id} (${def.kind}) score=${res.score.toFixed(2)}${pk}${jd} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (res.score < 1) for (const c of res.comments.filter((x) => !/all goals/.test(x))) console.log(`      ${c}`);
    } catch (err) {
      results.push({ id: def.id, kind: def.kind, trials: [false], score: 0, passk: null, comments: [(err as Error).message] });
      console.log(`ERROR ${def.id}: ${(err as Error).message}`);
    }
  }
  obs?.close();

  // Report + baseline gate.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportDir = path.join(ROOT, "reports", "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `${ts}.json`), JSON.stringify({ ts, judged, results }, null, 1));
  const md = [
    `# Eval run ${ts}${judged ? " (judged)" : ""}`,
    "",
    "| case | kind | score | pass^k | judge | notes |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.kind} | ${r.score.toFixed(2)} | ${r.passk ? `${r.passk.value.toFixed(2)} (k=${r.passk.k})` : "-"} | ${r.judge?.score ?? "-"} | ${r.comments.at(-1)?.slice(0, 80) ?? ""} |`),
  ].join("\n");
  fs.writeFileSync(path.join(reportDir, "latest.md"), md);

  const baselineFile = path.join(ROOT, "evals", "baseline.json");
  const baseline: Record<string, number> = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : {};
  const regressions = results.filter((r) => baseline[r.id] !== undefined && r.score < baseline[r.id]);
  if (updateBaseline) {
    for (const r of results) baseline[r.id] = r.score;
    fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
    console.log(`baseline updated: ${results.length} cases -> ${path.relative(ROOT, baselineFile)}`);
  } else if (regressions.length > 0) {
    console.error(`REGRESSION vs baseline: ${regressions.map((r) => `${r.id} (${baseline[r.id]} -> ${r.score.toFixed(2)})`).join(", ")}`);
    process.exit(1);
  }
  const pass = results.filter((r) => r.score === 1).length;
  console.log(`evals: ${pass}/${results.length} clean · report: reports/evals/latest.md`);
}

await main();
