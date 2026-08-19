/**
 * The LLM judge (RFA v0.4 spec section 8), last in line by design: computed
 * rewards first, judges only where semantics are irreducible. Transport is
 * `claude -p --output-format json` (the operator's existing subscription, no
 * API key), score constrained to choices for stability, calls capped per day.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { TrajectoryMessage } from "./trajectory.js";

const DAILY_CAP = 50;

/**
 * The judge must run at a DIFFERENT model tier than the subject it judges (spec
 * 20.1). Self-preference is a demonstrated effect, and cross-tier judging is the
 * only mitigation available under one subscription. The subject's tier is passed
 * in; this maps it to something else rather than silently defaulting to haiku
 * and judging haiku with haiku, which is what the call site used to do.
 */
function crossTier(subjectModel: string | null | undefined): string {
  const subject = (subjectModel ?? "").toLowerCase();
  if (subject.includes("haiku")) return "sonnet";
  if (subject.includes("opus")) return "sonnet";
  return "haiku";
}

/** The rubric is a versioned FILE, so an edit is visible as an edit (spec 20.1). */
function loadRubric(root: string): { text: string; hash: string } {
  const file = path.join(root, "evals", "rubric.md");
  const text = fs.readFileSync(file, "utf8");
  return { text, hash: createHash("sha256").update(text).digest("hex") };
}

export interface JudgeResult {
  key: "judge";
  /** 1 for pass, 0 for fail, -1 when the judge did not run. Binary by design (spec 20.1). */
  score: number;
  comment: string;
  /** SHA-256 of the rubric as read at judge time, so a rubric edit is not read as a quality change. */
  rubric_hash?: string;
  /** The tier that judged, recorded because cross-tier judging is the mitigation being relied on. */
  judge_model?: string;
}

function capFile(root: string): string {
  return path.join(root, "data", "judge-count.json");
}

export function judgeBudgetLeft(root: string, cap = DAILY_CAP): number {
  const f = capFile(root);
  const day = new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(f)) return cap;
  const cur = JSON.parse(fs.readFileSync(f, "utf8")) as { day: string; count: number };
  return cur.day === day ? Math.max(0, cap - cur.count) : cap;
}

function consumeBudget(root: string): void {
  const f = capFile(root);
  const day = new Date().toISOString().slice(0, 10);
  const cur = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as { day: string; count: number }) : { day, count: 0 };
  fs.writeFileSync(f, JSON.stringify(cur.day === day ? { day, count: cur.count + 1 } : { day, count: 1 }));
}

export async function claudeJudge(
  root: string,
  trajectory: TrajectoryMessage[],
  opts: { model?: string; subjectModel?: string | null } = {},
): Promise<JudgeResult> {
  if (judgeBudgetLeft(root) <= 0) {
    return { key: "judge", score: -1, comment: `judge budget exhausted (${DAILY_CAP}/day); try tomorrow` };
  }
  consumeBudget(root);
  const rubric = loadRubric(root);
  // Never the subject's own tier: an explicit opts.model wins, otherwise pick a
  // different tier from the subject's.
  const judgeModel = opts.model ?? crossTier(opts.subjectModel);
  const transcript = trajectory
    .map((m) => `${m.role.toUpperCase()}: ${m.content || (m.tool_calls ? m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join("; ") : "")}`)
    .join("\n");
  const prompt = `${rubric.text}\n\n<trajectory>\n${transcript.slice(0, 30_000)}\n</trajectory>`;
  const stdout = await new Promise<string>((resolve, reject) => {
    const p = spawn("claude", ["-p", "--model", judgeModel, "--output-format", "json"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("judge timed out after 120s"));
    }, 120_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 && out.trim() ? resolve(out) : reject(new Error(`judge exited ${code}: ${err.slice(0, 150)}`));
    });
    p.stdin.write(prompt);
    p.stdin.end();
  });
  const outer = JSON.parse(stdout) as { result?: string };
  // Binary: the verdict is a word, not a number, so the model cannot hedge into
  // the middle of a scale that carried no information anyway.
  const m = /\{[^{}]*"verdict"[^{}]*\}/.exec(outer.result ?? stdout);
  if (!m) throw new Error(`judge returned no verdict JSON: ${(outer.result ?? stdout).slice(0, 150)}`);
  const parsed = JSON.parse(m[0]) as { verdict?: string; reason?: string };
  const verdict = String(parsed.verdict ?? "").toLowerCase();
  if (verdict !== "pass" && verdict !== "fail") {
    throw new Error(`judge returned an unusable verdict ${JSON.stringify(parsed.verdict)}; expected "pass" or "fail"`);
  }
  return {
    key: "judge",
    score: verdict === "pass" ? 1 : 0,
    comment: parsed.reason ?? "",
    rubric_hash: rubric.hash,
    judge_model: judgeModel,
  };
}
