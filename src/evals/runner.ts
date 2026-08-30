/**
 * The eval runner (RFA v0.4 spec section 8).
 *
 *   rfa evals run                     tier 2: replay + live cases, baseline-diff gate (exit 1 on regression)
 *   rfa evals run --update-baseline
 *   rfa evals run --judged            tier 3: adds the claude judge on live trajectories
 *   rfa evals run --room <alias>      live cases against that room (default: the first non-ops room in rooms.json)
 *
 * Cases are directories holding case.yaml (+ reference.ndjson for replay):
 * discovered under <hub directory>/evals/cases/ (tracked, generic) and
 * agents/<x>/evals/cases/ (pack-local, gitignored when they carry internal
 * facts). kind: replay scores a recorded event slice; kind: live asks the real
 * resident (by capability) through a room, N trials for pass^k; kind:
 * live-concurrent asks a TUPLE of questions at once, where one trial is one
 * simultaneous pair (or N-tuple) rather than one ask. Every live verdict lands
 * as evaluator feedback in obs.db, keyed on the run_id the answer carries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { RoomMember, type AskResult } from "../client.js";
import type { Envelope, RfaEvent } from "../model.js";
import { ObsStore } from "../obs.js";
import { corroborateRefusal, resolveRun, type RunLookup } from "./runresolve.js";
import { claudeJudge } from "./judge.js";
import { loadPack } from "../agentdef.js";
import { findRoom, HubDirError, requireHubDir, roomsStore, type HubDir } from "../hubdir.js";
import { compareToBaseline, gateValue, GATE_BAND, GATE_K, nextBaseline, type CaseBaseline } from "./gate.js";
import { liveConcurrentPort, overlapVerdict, runConcurrentCase } from "./concurrent.js";
import {
  computeReward,
  passHatK,
  rfaLogToTrajectory,
  validateConcurrentCase,
  type ConcurrentAsk,
  type ExpectBlock,
} from "./trajectory.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

let hubdir: HubDir;
try {
  hubdir = requireHubDir({ dir: flag("--dir") });
} catch (err) {
  if (err instanceof HubDirError) {
    console.error(`evals: ${err.message}\n  ${err.hint}`);
    process.exit(2);
  }
  throw err;
}

// A hub with tokens configured refuses an unauthenticated /mcp, and this harness
// joins rooms like any other client. Without this the whole gate reported
// regressions whose real cause was a 401 (observed).
{
  const { transportToken } = await import("../secrets.js");
  const tok = transportToken(hubdir.paths.secrets);
  if (tok && !process.env.RFA_TOKEN) process.env.RFA_TOKEN = tok;
}

interface CaseDef {
  id: string;
  kind: "replay" | "live" | "live-concurrent";
  subject?: string;
  subject_capability?: string;
  ask?: string;
  /**
   * kind: live-concurrent only. At least two entries, each carrying its OWN
   * markers: one trial issues all of them at once, from one probe per ask.
   */
  asks?: ConcurrentAsk[];
  trials?: number;
  timeout_ms?: number;
  expect: ExpectBlock;
  /**
   * kind: live-concurrent only, default false. Whether the subject really running
   * two asks at once is a PASS CONDITION, asserted at CASE level (at least one
   * trial overlapped) and never per trial: one legitimately serialized tuple must
   * not zero a correct pack. Left unset the overlap is measured and reported but
   * never asserted, because a pack at `concurrency: 1` serializes correctly and a
   * correct configuration must not fail the gate.
   *
   * The overlap is measured on the SUBJECT's own run windows out of runs.db. When
   * those cannot be read it is UNMEASURED, and this assertion FAILS on unmeasured
   * rather than passing.
   */
  expect_overlap?: boolean;
}

const isLive = (kind: string): boolean => kind === "live" || kind === "live-concurrent";

interface CaseResult {
  id: string;
  kind: string;
  trials: boolean[];
  /** Trials the subject REFUSED (budget, overloaded, busy): infrastructure, not quality; excluded from pass^k. */
  refused?: string[];
  /** Set when every trial was refused: the case did not run, and the gate says so instead of calling it a regression. */
  blocked?: string;
  score: number; // pass^1
  passk: { k: number; value: number } | null;
  comments: string[];
  judge?: { score: number; comment: string };
  /** The subject's definition hash at run time (spec 20.3): a definition change must not read as a quality change. */
  definition_hash?: string | null;
  /** Trials the harness could not MEASURE (an answer with no json part): excluded, never scored 0. */
  unmeasurable?: string[];
  /**
   * live-concurrent only: whether the subject really ran the tuple's asks at
   * once, MEASURED per trial on its own run windows out of runs.db. Reported here
   * (and in the run report) whatever the case asserts; `assertion` is the
   * case-level verdict, set only when the case declared expect_overlap.
   *
   * `max_in_flight_together_ms` is the CLIENT's send-to-reply intersection, kept
   * beside it as a separate datum and never as the overlap: the asks are issued in
   * one tick, so it is non-empty however thoroughly the subject serialized them.
   */
  overlap?: {
    trials: number;
    overlapped: number;
    serialized: number;
    unmeasured: number;
    max_overlap_ms: number;
    max_in_flight_together_ms: number;
    asserted: boolean;
    assertion: { ok: boolean; detail: string } | null;
  };
}

/**
 * The subject's model tier, read from its pack, so the judge can pick a
 * different one (spec 20.1). Null when the subject is not a local pack, in which
 * case the judge falls back to its own default tier.
 */
function subjectModel(memberName: string): string | null {
  try {
    const dir = path.join(hubdir.paths.agents, memberName);
    if (!fs.existsSync(path.join(dir, "agent.md"))) return null;
    return loadPack(dir).def.model ?? null;
  } catch {
    return null;
  }
}

/**
 * Cases under agents/<name>/evals/ belong to that pack. A retired pack keeps its
 * directory (retirement archives the definition, memory and membership, and
 * deliberately does not delete an operator's data), so without this check a
 * retired agent's cases keep running forever and failing forever.
 */
function packIsLive(caseRoot: string): boolean {
  const marker = path.join(path.dirname(path.dirname(caseRoot)), "agent.md");
  return !marker.includes(`${path.sep}agents${path.sep}`) || fs.existsSync(marker);
}

function discoverCases(): { dir: string; def: CaseDef }[] {
  const agentsDir = hubdir.paths.agents;
  const roots = [hubdir.paths.evalCases, ...(fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).map((a) => path.join(agentsDir, a, "evals", "cases")) : [])];
  const out: { dir: string; def: CaseDef }[] = [];
  for (const root of roots.filter((r) => fs.existsSync(r) && packIsLive(r))) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name, "case.yaml");
      if (entry.isDirectory() && fs.existsSync(file)) {
        // `?? {}` because an empty or comment-only case.yaml parses to null, and
        // a case with no id at all is a malformed case (blocked), never a crash
        // that takes the whole run down before the replay cases are scored.
        const def = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as CaseDef;
        out.push({ dir: path.join(root, entry.name), def });
      }
    }
  }
  return out.sort((a, b) => (a.def.id ?? "").localeCompare(b.def.id ?? ""));
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
  /** Null when the probe joins on its transport bearer alone (bearer-implied admission). */
  secret: string | null;
}

/**
 * The room live cases ask in: `--room <alias|handle>`, or the first room in
 * rooms.json that is not `ops`. A room the CLI did not create can still be
 * named by handle; the probe then relies on the operator bearer being allowed in
 * it, which is what `rfa room create` and `rfa room allow` arrange.
 */
function liveEnv(): LiveEnv | null {
  const wanted = flag("--room");
  const file = roomsStore(hubdir).read();
  const record = wanted ? findRoom(file, wanted) : file.rooms.find((r) => r.alias !== "ops");
  // No room is the INSTANCE's state, not a case's quality, and it used to kill
  // the whole run before any replay case was scored. The live cases are reported
  // BLOCKED instead, which is the shape the gate already has for "did not run".
  if (!record && !wanted) return null;
  return {
    hubUrl: process.env.RFA_HUB_URL ?? hubdir.hubUrl,
    room: record?.handle ?? wanted!,
    secret: record?.join_secret ?? null,
  };
}

/**
 * A FRESH membership per ask. Duplicate suppression is per sender, so asking the
 * same question four times from one member is refused as a duplicate after the
 * first (measured: every multi-trial case failed with "identical body
 * suppressed"). The alternatives were worse: altering the question per trial
 * stops measuring the same thing, and sleeping past the 30s window adds minutes
 * per case for nothing. A concurrent TUPLE needs the same thing per ask, for the
 * same reason plus one more: two asks from one member would be one member's
 * conversation, which is not what a concurrency case is measuring.
 */
function probePool(def: CaseDef, env: LiveEnv) {
  const probes: RoomMember[] = [];
  return {
    async mint(label: string): Promise<RoomMember> {
      const p = await RoomMember.create({
        hubUrl: env.hubUrl, room: env.room, joinSecret: env.secret ?? undefined, name: `eval-${def.id.slice(0, 16)}-${label}`,
        card: { name: "eval-probe", description: "eval harness probe", skills: [{ id: "eval", description: "runs eval cases" }] },
      });
      probes.push(p);
      return p;
    },
    /** Leave every probe, or the roster fills with eval corpses (this is how the zombie-membership finding started). */
    async release(): Promise<void> {
      for (const p of probes) await p.leave().catch(() => {});
    },
  };
}

/** The exchange as an event slice: live Q&A cases score messages, not board state. */
function askedAnsweredSlice(asker: { memberId: string; name: string }, ask: string, answer: AskResult): RfaEvent[] {
  const asked: RfaEvent = {
    seq: 1, ts: new Date().toISOString(), type: "message",
    envelope: { ...answer.envelope, message_id: "eval_q", seq: 0, from: { id: asker.memberId, name: asker.name, origin: "agent" }, kind: "request", body: [{ type: "text", text: ask }], refusal: null } as Envelope,
  } as never;
  const answered: RfaEvent = { seq: 2, ts: answer.envelope.ts, type: "message", envelope: answer.envelope } as never;
  return [asked, answered];
}

/**
 * The answer's json part (src/resident.ts puts run_id in it), or null when the
 * answer carried NO json part at all. The distinction matters: no json part is
 * the harness being blind (an older resident, a member that is not one of ours),
 * and a tuple it cannot read is UNMEASURABLE rather than a quality zero.
 */
function jsonPartOf(answer: AskResult): { runId: string | null } | null {
  const part = answer.parts.find((p) => p.type === "json");
  if (!part) return null;
  return { runId: (part.value as { run_id?: string } | undefined)?.run_id ?? null };
}

/** The run id the answer's json part carries (src/resident.ts): what a concurrent tuple asserts on. */
function runIdOf(answer: AskResult): string | null {
  return jsonPartOf(answer)?.runId ?? null;
}

/** A refusal is the subject's state (budget exhausted, overloaded, busy), never the answer's quality. */
function refusalOf(answer: AskResult): string {
  return `${answer.refusal?.reason ?? "refused"}${answer.refusal?.detail ? `: ${answer.refusal.detail}` : ""}`;
}

async function runLive(def: CaseDef, env: LiveEnv, obs: ObsStore | null, judged: boolean): Promise<CaseResult> {
  const pool = probePool(def, env);
  const probe = await pool.mint("t1");
  try {
    const subjectRec = probe.roster.find((r) => def.subject_capability && r.card_summary.skill_ids.includes(def.subject_capability));
    // A CONFIGURATION state, not a quality one: this used to throw into the
    // runner's catch, which recorded trials: [false] and score 0, and
    // `--update-baseline` then wrote that 0 into the baseline as a measurement.
    if (!subjectRec) {
      return {
        id: def.id, kind: "live", trials: [], score: 0, passk: null, comments: [],
        blocked: `no roster member offers ${def.subject_capability ?? def.subject}: the case cannot run until one does (rfa room roster shows who is in)`,
      };
    }
    const trials: boolean[] = [];
    const refused: string[] = [];
    const comments: string[] = [];
    let judge: CaseResult["judge"];
    // The subject's OWN record, not its word (wire 14 item 12). `null` when the
    // store cannot be read at all, which `runresolve` treats as fail-closed.
    const lookup: RunLookup = obs
      ? ({ agent, from, to }) => {
          try {
            return obs.runsForAgent(agent, from, to);
          } catch {
            return null;
          }
        }
      : () => null;
    for (let i = 0; i < (def.trials ?? 1); i++) {
      const asker = i === 0 ? probe : await pool.mint(`t${i + 1}`);
      const from = Date.now();
      const answer = await asker.ask(subjectRec.id, def.ask!, { timeoutMs: def.timeout_ms ?? 120_000 });
      const to = Date.now();
      // Found live: a $3/day answerer hit its ceiling halfway through a gate run
      // and the gate reported two REGRESSIONS. So a refusal still leaves pass^k
      // alone - but only when the subject's own run rows corroborate it, because
      // otherwise a member lowers the denominator of its own gate by declaring
      // its state (wire 14 item 12; `src/evals/runresolve.ts`).
      if (answer.kind === "refuse") {
        const why = refusalOf(answer);
        const verdict = corroborateRefusal({ agent: subjectRec.name, from, to, lookup });
        if (verdict.excluded) {
          refused.push(why);
          comments.push(`trial ${i + 1}: REFUSED ${why} - ${verdict.detail}`);
          continue;
        }
        trials.push(false);
        comments.push(`trial ${i + 1}: REFUSED ${why} - ${verdict.detail}`);
        continue;
      }
      const events = askedAnsweredSlice(asker, def.ask!, answer);
      const reward = computeReward(events, subjectRec.id, def.expect);
      trials.push(reward.score === 1);
      comments.push(`trial ${i + 1}: ${reward.comment}`);
      // The run id the answer CLAIMS is a hint to be checked, never the key.
      // Writing on an unchecked one is how a failing answer misses the review
      // queue: every write below is `... WHERE id = ?` or an unconstrained
      // INSERT, so a wrong id is silently no rows, or an orphan.
      const resolved = obs ? resolveRun({ claimed: runIdOf(answer), agent: subjectRec.name, from, to, lookup }) : null;
      if (obs && resolved) {
        if (resolved.ok) {
          obs.feedback({ run_id: resolved.runId, key: `eval:${def.id}`, score: reward.score, comment: reward.comment, source_type: "evaluator" });
          if (reward.score === 0) obs.markReview(resolved.runId, true);
        } else {
          // Never silent: a score that could not be attached is a hole in the
          // judged record, and the review queue is what a human reads.
          comments.push(`trial ${i + 1}: score NOT recorded - ${resolved.reason}`);
        }
      }
      if (judged && i === 0) {
        // Cross-tier (spec 20.1): pass the subject's own model so the judge
        // picks a different one. Judging haiku with haiku is self-preference.
        const j = await claudeJudge({ rubric: hubdir.paths.evalRubric, counter: hubdir.paths.judgeCount }, rfaLogToTrajectory(events, { subject: subjectRec.id }), {
          subjectModel: subjectModel(subjectRec.name),
        });
        if (j.score >= 0) {
          judge = { score: j.score, comment: j.comment };
          // Same rule as the evaluator score above: the judge's verdict is
          // attached to the run the STORE says happened, or to nothing, and a
          // failure to attach is reported rather than swallowed.
          if (obs && resolved?.ok) {
            obs.feedback({
              run_id: resolved.runId, key: "judge", score: j.score,
              comment: `${j.comment}${j.judge_model ? ` [judged by ${j.judge_model}]` : ""}`,
              source_type: "model", rubric_hash: j.rubric_hash ?? null,
            });
          } else if (obs) {
            comments.push(`trial ${i + 1}: judge score NOT recorded - ${resolved && !resolved.ok ? resolved.reason : "no run could be resolved"}`);
          }
        }
      }
    }
    const k = Math.min(4, trials.length);
    if (trials.length === 0) {
      return { id: def.id, kind: "live", trials, refused, blocked: refused[0] ?? "every trial refused", definition_hash: subjectRec.digest ?? null, score: 0, passk: null, comments, judge };
    }
    return {
      id: def.id, kind: "live", trials, ...(refused.length ? { refused } : {}),
      // The capability digest identifies the definition this was measured
      // against: without it a "regression" cannot be told from a pack edit.
      definition_hash: subjectRec.digest ?? null,
      score: trials.filter(Boolean).length / trials.length,
      passk: trials.length >= 2 ? { k, value: passHatK([trials], k) } : null,
      comments, judge,
    };
  } finally {
    await pool.release();
  }
}

/**
 * kind: live-concurrent. ONE TRIAL IS ONE SIMULTANEOUS TUPLE: every ask in
 * `asks` goes out at the same moment, each from its own fresh probe, and the
 * trial passes only if all of the following hold.
 *
 *  - each asker got the answer to ITS OWN question (its must_mention, and above
 *    all its must_not_mention: an answer carrying the sibling's marker is two
 *    concurrent conversations bleeding into each other);
 *  - every answer's json part carries a run_id, and they are DISTINCT (two
 *    concurrent answers sharing one run id is the shared-run-context bug class);
 *  - the per-ask protocol lints pass for each ask.
 *
 * Whether the subject really ran two asks AT ONCE is measured on its own run
 * windows out of runs.db, per trial, and asserted at CASE level only when the
 * case sets expect_overlap: at `concurrency: 1` serialization is correct.
 *
 * Trials remain independent samples of one thing, so pass^k applies unchanged
 * over the tuple-level pass or fail.
 *
 * The mechanics live in src/evals/concurrent.ts behind a port, so a test can
 * drive them with a fake that resolves out of order. This function is the port's
 * live implementation: real memberships, the real runs.db, the real obs store.
 */
async function runLiveConcurrent(def: CaseDef, env: LiveEnv, obs: ObsStore | null, judged: boolean): Promise<CaseResult> {
  const pool = probePool(def, env);
  // The port is built by a factory in src/evals/concurrent.ts, not inline here:
  // this module calls main() at import, so anything constructed in it is
  // untestable, and the subject's-clock wiring (RFA-0.8 sect. 3's runs table, read
  // read-only) is the part whose silent failure turns every overlap into
  // UNMEASURED.
  const port = liveConcurrentPort({
    runsDb: hubdir.paths.runsDb,
    runsDbLabel: path.relative(hubdir.root, hubdir.paths.runsDb),
    pool,
    slice: askedAnsweredSlice,
    json: jsonPartOf,
  });
  const outcome = await runConcurrentCase(def, port, {
    obs,
    // The subject's own rows, so each ask's score attaches to the run the STORE
    // says happened rather than to the id the answer reported (wire 14 item 12).
    runs: obs
      ? ({ agent, from, to }) => {
          try {
            return obs.runsForAgent(agent, from, to);
          } catch {
            return null;
          }
        }
      : null,
  });
  const overlap = outcome.perTrial.length ? overlapVerdict(outcome.perTrial, def.expect_overlap === true) : undefined;
  const base = {
    id: def.id,
    kind: "live-concurrent",
    definition_hash: outcome.subject?.digest ?? null,
    comments: outcome.comments,
    ...(overlap ? { overlap } : {}),
    ...(outcome.refused.length ? { refused: outcome.refused } : {}),
    ...(outcome.unmeasurable.length ? { unmeasurable: outcome.unmeasurable } : {}),
  };
  if (outcome.blocked) {
    return { ...base, trials: [], score: 0, passk: null, blocked: outcome.blocked };
  }

  let judge: CaseResult["judge"];
  if (judged && outcome.firstScored) {
    // Cross-tier (spec 20.1), on the tuple's FIRST ask: the judge reads one
    // trajectory, and a tuple has no single one.
    const first = outcome.firstScored;
    const subject = outcome.subject!;
    const j = await claudeJudge({ rubric: hubdir.paths.evalRubric, counter: hubdir.paths.judgeCount }, rfaLogToTrajectory(first[0].events, { subject: subject.id }), {
      subjectModel: subjectModel(subject.name),
    });
    if (j.score >= 0) {
      judge = { score: j.score, comment: j.comment };
      // Resolved, never self-reported (wire 14 item 12). This is the concurrent
      // path's own judge write and it had the same defect as the single-ask one.
      const resolved = obs
        ? resolveRun({
            claimed: first[0].json?.runId ?? null,
            agent: subject.name,
            from: first[0].client.startedAt,
            to: first[0].client.endedAt,
            lookup: ({ agent, from, to }) => {
              try {
                return obs.runsForAgent(agent, from, to);
              } catch {
                return null;
              }
            },
          })
        : null;
      if (obs && resolved?.ok) {
        obs.feedback({
          run_id: resolved.runId, key: "judge", score: j.score,
          comment: `${j.comment}${j.judge_model ? ` [judged by ${j.judge_model}]` : ""}`,
          source_type: "model", rubric_hash: j.rubric_hash ?? null,
        });
      } else if (obs && resolved && !resolved.ok) {
        outcome.comments.push(`judge score NOT recorded - ${resolved.reason}`);
      }
    }
  }

  const trials = outcome.trials;
  if (trials.length === 0) {
    // Nothing was SCORED. A refusal is not a measurement and neither is a tuple
    // the harness could not read, so the case is blocked rather than a zero.
    return {
      ...base, trials, score: 0, passk: null,
      blocked: outcome.refused[0] ?? outcome.unmeasurable[0] ?? "no trial could be scored",
      judge,
    };
  }
  return {
    ...base, trials,
    score: trials.filter(Boolean).length / trials.length,
    passk: trials.length >= 2 ? { k: Math.min(GATE_K, trials.length), value: passHatK([trials], Math.min(GATE_K, trials.length)) } : null,
    judge,
  };
}

/**
 * The reasons a case cannot be run, checked at LOAD. A configuration problem must
 * never reach the gate as a score: both of the live-concurrent checks below were
 * silently ignored before, so a case could assert nothing (expect.output on a
 * tuple) or assert the impossible (one marker required and forbidden) and look
 * like a quality measurement either way.
 */
function caseProblems(def: CaseDef): string[] {
  const problems: string[] = [];
  if (!def.id) problems.push("no id");
  if (isLive(def.kind) && !def.subject && !def.subject_capability) problems.push("a live case needs subject or subject_capability: there is nobody to ask");
  if (def.kind === "live-concurrent") problems.push(...validateConcurrentCase(def));
  else if (def.kind === "live" && !def.ask) problems.push("kind live needs an ask");
  return problems;
}

async function main(): Promise<void> {
  const judged = process.argv.includes("--judged");
  const updateBaseline = process.argv.includes("--update-baseline");
  const cases = discoverCases();
  if (cases.length === 0) {
    console.error(`no eval cases found (${hubdir.paths.evalCases}, agents/*/evals/cases/)`);
    process.exit(2);
  }
  const obsPath = hubdir.paths.obsDb;
  const obs = fs.existsSync(path.dirname(obsPath)) ? new ObsStore(obsPath) : null;
  const env = cases.some((c) => isLive(c.def.kind)) ? liveEnv() : null;
  const results: CaseResult[] = [];
  for (const { dir, def } of cases) {
    const t0 = Date.now();
    try {
      let res: CaseResult;
      const problems = caseProblems(def);
      if (problems.length) {
        // A malformed case DID NOT RUN. It reaches the gate as blocked, never as
        // a score: a configuration state written into a baseline is a lie that
        // outlives the session that wrote it.
        res = {
          id: def.id ?? path.basename(dir), kind: def.kind, trials: [], score: 0, passk: null,
          blocked: `case is malformed and was not run: ${problems.join("; ")}`,
          comments: [],
        };
      } else if (def.kind === "replay") res = await runReplay(dir, def);
      else if (!env) {
        res = {
          id: def.id, kind: def.kind, trials: [], score: 0, passk: null,
          blocked: "no room to ask in: rooms.json lists none. Create one with `rfa room create <alias>`, or pass --room <handle>.",
          comments: [],
        };
      } else res = def.kind === "live-concurrent" ? await runLiveConcurrent(def, env, obs, judged) : await runLive(def, env, obs, judged);
      results.push(res);
      const pk = res.passk ? ` pass^${res.passk.k}=${res.passk.value.toFixed(2)}` : "";
      const jd = res.judge ? ` judge=${res.judge.score}` : "";
      // The overlap is what the SUBJECT's run windows say, and the client's
      // "both in flight" number is printed beside it under its own name so the
      // two can never be read as one thing again.
      const ov = res.overlap
        ? ` overlap=${res.overlap.overlapped}/${res.overlap.trials} trials on the subject's run windows (max ${(res.overlap.max_overlap_ms / 1000).toFixed(1)}s` +
          `${res.overlap.unmeasured ? `, ${res.overlap.unmeasured} UNMEASURED` : ""}, ${res.overlap.asserted ? "asserted at case level" : "measured only"}` +
          `; both in flight max ${(res.overlap.max_in_flight_together_ms / 1000).toFixed(1)}s, not the overlap)`
        : "";
      // A blocked case says BLOCK here too, not FAIL at score 0.00: it did not
      // run, and in a scrollback the two read identically otherwise. A failed
      // overlap assertion is a FAIL whatever the answers scored: the case's own
      // pass condition did not hold.
      const overlapFailed = !res.blocked && res.overlap?.assertion?.ok === false;
      const verdict = res.blocked ? "BLOCK" : overlapFailed || res.score === 0 ? "FAIL" : res.score === 1 ? "PASS" : "FLAKY";
      console.log(`${verdict} ${def.id} (${def.kind}) ${res.blocked ? "did not run" : `score=${res.score.toFixed(2)}`}${pk}${jd}${ov} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (overlapFailed) console.log(`      ${res.overlap!.assertion!.detail}`);
      if (res.score < 1) for (const c of res.comments.filter((x) => !/all goals/.test(x))) console.log(`      ${c}`);
    } catch (err) {
      // A THROW is "did not run", never a measurement. This used to push
      // trials: [false] and score 0, and `--update-baseline` then wrote that zero
      // into the baseline as the case's measured quality - the same defect the
      // unresolvable-subject path was fixed for, one level up. `blocked` routes it
      // through the path every other did-not-run state already takes: the previous
      // baseline is kept, the gate reports itself incomplete, exit 3.
      const why = (err as Error).message;
      results.push({ id: def.id, kind: def.kind, trials: [], score: 0, passk: null, blocked: `did not run: ${why}`, comments: [why] });
      console.log(`ERROR ${def.id}: ${why}`);
    }
  }
  obs?.close();

  // Report + baseline gate.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportDir = path.join(hubdir.paths.reports, "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `${ts}.json`), JSON.stringify({ ts, judged, results }, null, 1));
  const md = [
    `# Eval run ${ts}${judged ? " (judged)" : ""}`,
    "",
    "| case | kind | score | pass^k | judge | overlap | notes |",
    "|---|---|---|---|---|---|---|",
    // The overlap column is MEASURED for every live-concurrent case, whether or
    // not the case asserts it: a run report that only said pass/fail could not
    // tell a pack that genuinely interleaved from one that serialized correctly.
    // It reads the SUBJECT's run windows; the client's "both in flight" number
    // rides along under its own name and is never the overlap.
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.blocked ? "BLOCKED" : r.score.toFixed(2)} | ${r.passk ? `${r.passk.value.toFixed(2)} (k=${r.passk.k})` : "-"} | ${r.judge?.score ?? "-"} | ` +
        `${
          r.overlap
            ? `${r.overlap.overlapped}/${r.overlap.trials} overlapped, ${r.overlap.serialized} serialized, ${r.overlap.unmeasured} unmeasured; max ${(r.overlap.max_overlap_ms / 1000).toFixed(1)}s ` +
              `(${r.overlap.asserted ? `asserted: ${r.overlap.assertion?.ok ? "held" : "FAILED"}` : "measured only"}; both in flight max ${(r.overlap.max_in_flight_together_ms / 1000).toFixed(1)}s)`
            : "-"
        } | ` +
        `${(r.blocked ?? (r.overlap?.assertion?.ok === false ? r.overlap.assertion.detail : undefined) ?? r.comments.at(-1))?.slice(0, 80) ?? ""} |`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(reportDir, "latest.md"), md);

  // ---- the gate (spec 20.3) ----------------------------------------------
  // The old gate compared a point estimate against a stored 1 at trials: 1.
  // With a measured per-question flake around 5%, a no-change run of five cases
  // had roughly a one-in-five chance of reporting a regression, and raising
  // trials against a hard 1.0 target makes that WORSE rather than better. The
  // normative gate is pass^k with a stated band, and both numbers below are
  // CHOSEN rather than measured, which is why the gate prints its own flake rate
  // and must not be tightened until that rate has been measured by repeated
  // no-change runs.
  const baselineFile = hubdir.paths.evalBaseline;
  const stored: Record<string, unknown> = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) : {};
  const corpusVersion = typeof stored.corpus_version === "string" ? stored.corpus_version : null;
  const baseCases: Record<string, CaseBaseline> = (stored.cases as Record<string, CaseBaseline>) ?? {};
  // Migrate the flat {id: score} shape written before 0.5.4 without losing it.
  for (const [id, value] of Object.entries(stored) as [string, unknown][]) {
    if (typeof value === "number" && baseCases[id] === undefined) baseCases[id] = { passk: value, k: GATE_K, estimated: true, definition_hash: null };
  }

  const blocked = results.filter((r) => r.blocked);
  for (const r of blocked) {
    console.error(`BLOCKED ${r.id}: ${r.blocked}`);
    if (/budget/i.test(r.blocked ?? "")) console.error("  the subject's budget, not its quality: raise budgets.per_day_usd in its agent.md, or run the gate tomorrow");
  }
  // The arithmetic and the comparison both come from src/evals/gate.ts, so the
  // gate's own test exercises the shipped functions instead of a hand copy.
  const rows = results.filter((r) => !r.blocked).map((r) => {
    const current = gateValue(r.trials);
    const base = baseCases[r.id];
    const comparison = compareToBaseline(current, base);
    const definitionChanged = base?.definition_hash != null && r.definition_hash != null && base.definition_hash !== r.definition_hash;
    return { r, current, base, comparison, definitionChanged };
  });

  // The measured flake rate, printed beside every verdict (spec 20.3): the
  // fraction of trials that failed on cases that did not fail outright. Without
  // it a reader cannot tell a regression from the noise floor.
  const multiTrial = results.filter((r) => r.trials.length >= 2 && r.trials.some(Boolean));
  const flakeTrials = multiTrial.flatMap((r) => r.trials);
  const flakeRate = flakeTrials.length > 0 ? flakeTrials.filter((t) => !t).length / flakeTrials.length : null;
  const flakeNote =
    flakeRate === null
      ? `flake rate UNMEASURED (every case ran ${Math.max(1, ...results.map((r) => r.trials.length))} trial(s); the gate's own false-positive rate is therefore unknown)`
      : `measured flake rate ${(flakeRate * 100).toFixed(1)}% over ${flakeTrials.length} trials`;

  // A case whose own overlap assertion failed. Reported and exited on separately
  // from the baseline diff: it is not a movement against a stored number, it is
  // the case's declared pass condition not holding.
  //
  // BLOCKED cases are excluded, because `rows` excludes them too: a case that did
  // not run must reach the operator as BLOCK and exit 3, not as a failed assertion
  // and exit 1. The assertion still fails CLOSED whenever the case DID score
  // trials - an overlap nobody could measure fails it (overlapVerdict), and that
  // half is not softened here.
  const overlapFailures = results.filter((r) => !r.blocked && r.overlap?.assertion?.ok === false);
  for (const r of overlapFailures) console.error(`OVERLAP ASSERTION FAILED ${r.id}: ${r.overlap!.assertion!.detail}`);

  if (updateBaseline) {
    // nextBaseline() is shipped and tested: a blocked case keeps whatever baseline
    // it had (a refusal, a missing room, an unresolvable subject and a malformed
    // case are all "did not run", and none of them is a measurement), and every
    // stored number carries the k it was ACTUALLY measured at.
    const next = nextBaseline(results, baseCases);
    fs.writeFileSync(
      baselineFile,
      JSON.stringify({ ...(corpusVersion ? { corpus_version: corpusVersion } : {}), gate: { k: GATE_K, band: GATE_BAND }, cases: next }, null, 1) + "\n",
    );
    const estimatedAtK = Object.values(next).filter((b) => b.estimated).length;
    console.log(`baseline updated: ${Object.keys(next).length} cases (${estimatedAtK} at pass^${GATE_K}, ${Object.keys(next).length - estimatedAtK} point estimates below k) -> ${path.relative(hubdir.root, baselineFile)}`);
    if (blocked.length) console.log(`  ${blocked.length} blocked case(s) kept their previous baseline, if any: ${blocked.map((r) => r.id).join(", ")}`);
    console.log(`  ${flakeNote}`);
  } else {
    for (const row of rows) {
      if (row.comparison.verdict === "incomparable") {
        // REFUSED, not guessed. The gate says the case went unchecked rather
        // than inventing or hiding a movement between two different quantities.
        // A baseline written by a runner that stored the gate's k beside every
        // number, whatever the trial count, lands here on its next run: one
        // `--update-baseline` re-records it at the k each case really measures.
        console.error(`INCOMPARABLE ${row.r.id}: ${row.comparison.detail}`);
        continue;
      }
      if (row.comparison.verdict !== "regressed") continue;
      const why = row.definitionChanged
        ? "the agent DEFINITION also changed, so this is not necessarily a quality movement"
        : corpusVersion
          ? `corpus ${corpusVersion.slice(0, 12)}`
          : "corpus version not pinned, so a knowledge edit is indistinguishable from a quality change";
      console.error(
        `REGRESSION ${row.r.id}: ${row.current.estimated ? `pass^${row.current.k}` : `point estimate over ${row.current.k} trial(s)`} ` +
          `${row.base!.passk.toFixed(2)} -> ${row.current.value.toFixed(2)} ` +
          `(drop ${row.comparison.drop.toFixed(2)} > band ${GATE_BAND}${row.current.estimated ? "" : ", point estimate: too few trials for pass^k"}); ${why}`,
      );
    }
    if (rows.some((row) => row.comparison.verdict === "regressed") || overlapFailures.length) {
      console.error(`  ${flakeNote}`);
      process.exit(1);
    }
  }
  const pass = results.filter((r) => !r.blocked && r.score === 1 && r.overlap?.assertion?.ok !== false).length;
  const refusedTrials = results.reduce((n, r) => n + (r.refused?.length ?? 0), 0);
  const unmeasurableTrials = results.reduce((n, r) => n + (r.unmeasurable?.length ?? 0), 0);
  console.log(
    `evals: ${pass}/${results.length} clean at pass^${GATE_K} band ${GATE_BAND} · ${flakeNote}` +
      `${refusedTrials ? ` · ${refusedTrials} trial(s) refused by the subject, excluded` : ""}` +
      `${unmeasurableTrials ? ` · ${unmeasurableTrials} trial(s) UNMEASURABLE (no json part on an answer), excluded` : ""}` +
      ` · report: ${path.relative(hubdir.root, path.join(reportDir, "latest.md"))}`,
  );
  // Computed only when NOT re-baselining. `--update-baseline` has just REWRITTEN
  // every row it could measure, so an incomparable row is precisely what that run
  // fixed: exiting 3 on it told the operator to "re-baseline with rfa evals run
  // --update-baseline", which is the command they were already running. The
  // blocked half of the condition below is unchanged: a case that did not run is
  // still an incomplete gate, whether or not the baseline was rewritten.
  const incomparable = updateBaseline ? [] : rows.filter((row) => row.comparison.verdict === "incomparable");
  if (blocked.length || incomparable.length) {
    if (blocked.length) console.error(`gate incomplete: ${blocked.length} case(s) did not run (${blocked.map((r) => r.id).join(", ")})`);
    if (incomparable.length) {
      console.error(
        `gate incomplete: ${incomparable.length} case(s) could not be compared to the baseline (${incomparable.map((row) => row.r.id).join(", ")}); ` +
          `re-baseline with rfa evals run --update-baseline`,
      );
    }
    process.exit(3);
  }
  if (pass === results.length) {
    // Anti-ossification (spec 20.4): a clean sweep is only meaningful if someone
    // writes down that it was reviewed. The instrument cannot tell whether it
    // has finished or gone blind; only the ledger entry can.
    console.log(`  100% clean: log "reviewed ${results.length} cases, no new failure modes" in docs/LEDGER.md, or this run is an unaudited instrument`);
  }
}

await main();
