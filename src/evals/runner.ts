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
 * resident (by capability) through a room, N trials for pass^k. Every live
 * verdict lands as evaluator feedback in obs.db, keyed on the run_id the answer
 * carries.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { RoomMember } from "../client.js";
import type { Envelope, RfaEvent } from "../model.js";
import { ObsStore } from "../obs.js";
import { claudeJudge } from "./judge.js";
import { loadPack } from "../agentdef.js";
import { findRoom, HubDirError, requireHubDir, roomsStore, type HubDir } from "../hubdir.js";
import { computeReward, passHatK, rfaLogToTrajectory, type ExpectBlock } from "./trajectory.js";

/**
 * The gate's k and band (spec 20.3). Both are CHOSEN, not measured: k=4 is the
 * value the pass^k estimator was already run at, and 0.15 absolute is a guess at
 * a band wide enough to swallow the observed flake. Neither may be tightened
 * before the gate's own false-positive rate has been measured by repeated
 * no-change runs, which is why every verdict prints the flake rate beside it.
 */
const GATE_K = 4;
const GATE_BAND = 0.15;

interface CaseBaseline {
  passk: number;
  k: number;
  /** The agent definition this baseline was measured against, so a definition change is not read as a quality change. */
  definition_hash: string | null;
}

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
  /** Null when the probe joins on its transport bearer alone (bearer-implied admission). */
  secret: string | null;
}

/**
 * The room live cases ask in: `--room <alias|handle>`, or the first room in
 * rooms.json that is not `ops`. A room the CLI did not create can still be
 * named by handle; the probe then relies on the operator bearer being allowed in
 * it, which is what `rfa room create` and `rfa room allow` arrange.
 */
function liveEnv(): LiveEnv {
  const wanted = flag("--room");
  const file = roomsStore(hubdir).read();
  const record = wanted ? findRoom(file, wanted) : file.rooms.find((r) => r.alias !== "ops");
  if (!record && !wanted) {
    console.error("no room to ask in: rooms.json lists none. Create one with `rfa room create <alias>`, or pass --room <handle>.");
    process.exit(2);
  }
  return {
    hubUrl: process.env.RFA_HUB_URL ?? hubdir.hubUrl,
    room: record?.handle ?? wanted!,
    secret: record?.join_secret ?? null,
  };
}

async function runLive(def: CaseDef, env: LiveEnv, obs: ObsStore | null, judged: boolean): Promise<CaseResult> {
  // A FRESH membership per trial. Duplicate suppression is per sender, so
  // asking the same question four times from one member is refused as a
  // duplicate after the first (measured: every multi-trial case failed with
  // "identical body suppressed"). The alternatives were worse: altering the
  // question per trial stops measuring the same thing, and sleeping past the
  // 30s window adds minutes per case for nothing.
  const probes: RoomMember[] = [];
  const newProbe = async (n: number): Promise<RoomMember> => {
    const p = await RoomMember.create({
      hubUrl: env.hubUrl, room: env.room, joinSecret: env.secret ?? undefined, name: `eval-${def.id.slice(0, 16)}-t${n}`,
      card: { name: "eval-probe", description: "eval harness probe", skills: [{ id: "eval", description: "runs eval cases" }] },
    });
    probes.push(p);
    return p;
  };
  const probe = await newProbe(1);
  try {
    const subjectRec = probe.roster.find((r) => def.subject_capability && r.card_summary.skill_ids.includes(def.subject_capability));
    if (!subjectRec) throw new Error(`no roster member offers ${def.subject_capability}`);
    const trials: boolean[] = [];
    const refused: string[] = [];
    const comments: string[] = [];
    let judge: CaseResult["judge"];
    for (let i = 0; i < (def.trials ?? 1); i++) {
      const asker = i === 0 ? probe : await newProbe(i + 1);
      const answer = await asker.ask(subjectRec.id, def.ask!, { timeoutMs: def.timeout_ms ?? 120_000 });
      // A refusal is the subject saying it cannot run the trial (a budget
      // exhausted, overloaded, busy), which is the stack's state and not the
      // answer's quality. Found live: a $3/day answerer hit its ceiling halfway
      // through a gate run and the gate reported two REGRESSIONS.
      if (answer.kind === "refuse") {
        const why = `${answer.refusal?.reason ?? "refused"}${answer.refusal?.detail ? `: ${answer.refusal.detail}` : ""}`;
        refused.push(why);
        comments.push(`trial ${i + 1}: REFUSED ${why}`);
        continue;
      }
      // Reconstruct the exchange as an event slice (live Q&A cases score messages, not board state).
      const asked: RfaEvent = {
        seq: 1, ts: new Date().toISOString(), type: "message",
        envelope: { ...answer.envelope, message_id: "eval_q", seq: 0, from: { id: asker.memberId, name: asker.name, origin: "agent" }, kind: "request", body: [{ type: "text", text: def.ask! }], refusal: null } as Envelope,
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
        // Cross-tier (spec 20.1): pass the subject's own model so the judge
        // picks a different one. Judging haiku with haiku is self-preference.
        const j = await claudeJudge({ rubric: hubdir.paths.evalRubric, counter: hubdir.paths.judgeCount }, rfaLogToTrajectory(events, { subject: subjectRec.id }), {
          subjectModel: subjectModel(subjectRec.name),
        });
        if (j.score >= 0) {
          judge = { score: j.score, comment: j.comment };
          if (runId && obs) {
            obs.feedback({
              run_id: runId, key: "judge", score: j.score,
              comment: `${j.comment}${j.judge_model ? ` [judged by ${j.judge_model}]` : ""}`,
              source_type: "model", rubric_hash: j.rubric_hash ?? null,
            });
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
    // Leave every probe, or the roster fills with eval corpses (this is how the
    // zombie-membership finding started).
    for (const p of probes) await p.leave().catch(() => {});
  }
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
  const reportDir = path.join(hubdir.paths.reports, "evals");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, `${ts}.json`), JSON.stringify({ ts, judged, results }, null, 1));
  const md = [
    `# Eval run ${ts}${judged ? " (judged)" : ""}`,
    "",
    "| case | kind | score | pass^k | judge | notes |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.kind} | ${r.blocked ? "BLOCKED" : r.score.toFixed(2)} | ${r.passk ? `${r.passk.value.toFixed(2)} (k=${r.passk.k})` : "-"} | ${r.judge?.score ?? "-"} | ${(r.blocked ?? r.comments.at(-1))?.slice(0, 80) ?? ""} |`),
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
    if (typeof value === "number" && baseCases[id] === undefined) baseCases[id] = { passk: value, k: GATE_K, definition_hash: null };
  }

  /** pass^k at the gate's k, or the point score when a case ran too few trials to estimate one. */
  const gateValue = (r: CaseResult): { value: number; estimated: boolean } =>
    r.trials.length >= GATE_K
      ? { value: passHatK([r.trials], GATE_K), estimated: true }
      : { value: r.score, estimated: false };

  const blocked = results.filter((r) => r.blocked);
  for (const r of blocked) {
    console.error(`BLOCKED ${r.id}: ${r.blocked}`);
    if (/budget/i.test(r.blocked ?? "")) console.error("  the subject's budget, not its quality: raise budgets.per_day_usd in its agent.md, or run the gate tomorrow");
  }
  const rows = results.filter((r) => !r.blocked).map((r) => {
    const { value, estimated } = gateValue(r);
    const base = baseCases[r.id];
    const drop = base ? base.passk - value : 0;
    const definitionChanged = base?.definition_hash != null && r.definition_hash != null && base.definition_hash !== r.definition_hash;
    return { r, value, estimated, base, drop, regressed: base !== undefined && drop > GATE_BAND, definitionChanged };
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

  if (updateBaseline) {
    // A blocked case keeps whatever baseline it had: a refusal is not a measurement.
    const next: Record<string, CaseBaseline> = {};
    for (const r of results) {
      if (r.blocked) {
        if (baseCases[r.id]) next[r.id] = baseCases[r.id];
        continue;
      }
      next[r.id] = { passk: gateValue(r).value, k: GATE_K, definition_hash: r.definition_hash ?? null };
    }
    fs.writeFileSync(
      baselineFile,
      JSON.stringify({ ...(corpusVersion ? { corpus_version: corpusVersion } : {}), gate: { k: GATE_K, band: GATE_BAND }, cases: next }, null, 1) + "\n",
    );
    console.log(`baseline updated: ${results.length} cases at pass^${GATE_K} -> ${path.relative(hubdir.root, baselineFile)}`);
    console.log(`  ${flakeNote}`);
  } else {
    for (const row of rows) {
      if (!row.regressed) continue;
      const why = row.definitionChanged
        ? "the agent DEFINITION also changed, so this is not necessarily a quality movement"
        : corpusVersion
          ? `corpus ${corpusVersion.slice(0, 12)}`
          : "corpus version not pinned, so a knowledge edit is indistinguishable from a quality change";
      console.error(
        `REGRESSION ${row.r.id}: pass^${GATE_K} ${row.base!.passk.toFixed(2)} -> ${row.value.toFixed(2)} ` +
          `(drop ${row.drop.toFixed(2)} > band ${GATE_BAND}${row.estimated ? "" : ", point estimate: too few trials for pass^k"}); ${why}`,
      );
    }
    if (rows.some((row) => row.regressed)) {
      console.error(`  ${flakeNote}`);
      process.exit(1);
    }
  }
  const pass = results.filter((r) => r.score === 1).length;
  const refusedTrials = results.reduce((n, r) => n + (r.refused?.length ?? 0), 0);
  console.log(`evals: ${pass}/${results.length} clean at pass^${GATE_K} band ${GATE_BAND} · ${flakeNote}${refusedTrials ? ` · ${refusedTrials} trial(s) refused by the subject, excluded` : ""} · report: ${path.relative(hubdir.root, path.join(reportDir, "latest.md"))}`);
  if (blocked.length) {
    console.error(`gate incomplete: ${blocked.length} case(s) did not run (${blocked.map((r) => r.id).join(", ")})`);
    process.exit(3);
  }
  if (pass === results.length) {
    // Anti-ossification (spec 20.4): a clean sweep is only meaningful if someone
    // writes down that it was reviewed. The instrument cannot tell whether it
    // has finished or gone blind; only the ledger entry can.
    console.log(`  100% clean: log "reviewed ${results.length} cases, no new failure modes" in STATUS.md, or this run is an unaudited instrument`);
  }
}

await main();
