/**
 * The answer-parity gate: the same questions asked of a live room before and
 * after a brain or knowledge change, each answer checked for the facts it must
 * mention and for a citation. Verdicts land as evaluator feedback on the
 * answer's engine run (the flywheel's first turn), and a failure marks the run
 * for review.
 *
 * Fixtures live in the hub directory at `evals/parity.json`:
 *   [{ "question": "...", "must_mention": ["1 %|one percent", "annual"] }, ...]
 * Each expectation may list alternatives separated by `|`; any one satisfies it.
 *
 * Was dogfood/parity.ts (bound to one tenant's room); now `rfa evals parity`.
 * Run it TWICE after a change: a single pass has hidden a real regression.
 */
import * as fs from "node:fs";
import type { RoomMember } from "../client.js";
import { ObsStore } from "../obs.js";
import { resolveRun, type RunLookup } from "./runresolve.js";

export interface ParityFixture {
  question: string;
  must_mention: string[];
  baseline?: { text: string; ms: number };
}

export interface ParityVerdict {
  question: string;
  ok: boolean;
  ms: number;
  kind: string;
  cited: boolean;
  missing: string[];
  excerpt: string;
  runId: string | null;
  /** Set when the score could not be attached to a run: never silent (wire 14 item 12). */
  unrecorded?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s ]/g, "");

export function loadFixtures(file: string): ParityFixture[] {
  if (!fs.existsSync(file)) throw new Error(`no parity fixtures at ${file}`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.some((f) => typeof f?.question !== "string" || !Array.isArray(f?.must_mention))) {
    throw new Error(`${file} must be an array of { question, must_mention[] }`);
  }
  return parsed as ParityFixture[];
}

export async function runParity(o: {
  me: RoomMember;
  subjectId: string;
  /** The subject's NAME, which is what its run rows are keyed on. See `src/evals/runresolve.ts`. */
  subjectName: string;
  fixtures: ParityFixture[];
  obsDb?: string;
  capture?: boolean;
  timeoutMs?: number;
  onVerdict?: (v: ParityVerdict) => void;
}): Promise<ParityVerdict[]> {
  const obs = o.obsDb && fs.existsSync(o.obsDb) ? new ObsStore(o.obsDb) : null;
  const lookup: RunLookup = obs
    ? ({ agent, from, to }) => {
        try {
          return obs.runsForAgent(agent, from, to);
        } catch {
          return null;
        }
      }
    : () => null;
  const verdicts: ParityVerdict[] = [];
  try {
    for (const f of o.fixtures) {
      const t0 = Date.now();
      const a = await o.me.ask(o.subjectId, f.question, { timeoutMs: o.timeoutMs ?? 120_000 });
      const ms = Date.now() - t0;
      const text = a.text;
      const missing = f.must_mention.filter((m) => !m.split("|").some((alt) => norm(text).includes(norm(alt))));
      const cited = /knowledge\/|\.mdx?\b/.test(text) || JSON.stringify(a.parts).includes("sources");
      const ok = a.kind === "response" && missing.length === 0 && cited;
      const claimed = (a.parts.find((p) => p.type === "json")?.value as { run_id?: string } | undefined)?.run_id ?? null;
      // The subject's own record decides which run this was, never its word
      // (wire 14 item 12; `src/evals/runresolve.ts`). An unresolvable trial is
      // reported on the verdict rather than written somewhere wrong or nowhere.
      const resolved = obs ? resolveRun({ claimed, agent: o.subjectName, from: t0, to: Date.now(), lookup }) : null;
      const runId = resolved?.ok ? resolved.runId : null;
      const v: ParityVerdict = {
        question: f.question, ok, ms, kind: a.kind, cited, missing, excerpt: text.slice(0, 200).replace(/\n/g, " "), runId,
        ...(resolved && !resolved.ok ? { unrecorded: resolved.reason } : {}),
      };
      verdicts.push(v);
      o.onVerdict?.(v);
      if (runId && obs) {
        obs.feedback({ run_id: runId, key: "parity", score: ok ? 1 : 0, comment: ok ? null : `missing=${JSON.stringify(missing)} cited=${cited}`, source_type: "evaluator" });
        if (!ok) obs.markReview(runId, true);
      }
      if (o.capture) f.baseline = { text, ms };
    }
  } finally {
    obs?.close();
  }
  return verdicts;
}
