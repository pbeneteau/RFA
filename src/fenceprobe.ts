/**
 * The startup deny probe (RFA-0.8 sect. 9 item 1), one per guarded built-in.
 *
 * Why it exists at all, when Write and Edit have both been probed by hand: the
 * fall-through to `canUseTool` is per-TOOL and per-PATH, measured (probes A, C,
 * D, E) - a Read INSIDE the session cwd is auto-approved and never reaches the
 * callback while a Read outside it does, and the callback's built-in behaviour
 * has already changed once across SDK setups. Nothing about one built-in
 * generalizes to another, and nothing about one SDK version generalizes to the
 * next. So the only honest way to know a given built-in is fenced on a given SDK
 * is to ask it, at boot, and fail closed.
 *
 * It is deliberately NOT cached against a version string. A cache keyed on a
 * version number is a changelog with extra steps, and the thing being defended
 * against is precisely a silent behaviour change. Measured on the live proof: a
 * boot costs $0.005 to $0.015 per guarded built-in, so a writing pack declaring
 * Write and Edit pays roughly two cents to re-prove door one. A read-only pack
 * pays nothing, because it has no guarded built-in to probe.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GUARDED_BUILTINS, type GuardedBuiltin } from "./writefence.js";

export type ProbeVerdict = "intercepted" | "bypassed" | "inconclusive";

export interface ProbeResult {
  tool: GuardedBuiltin;
  verdict: ProbeVerdict;
  detail: string;
  attempts: number;
  costUsd: number;
}

/** The shape of the SDK's `query`, narrowed to what the probe uses, so this module stays testable. */
export type ProbeQuery = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

interface Scenario {
  /** Files to lay down in the probe's cwd before the run. */
  seed: Record<string, string>;
  /** The file whose content decides "did the write land". */
  witness: string;
  /** What the witness holds before the run; absent for a create. */
  before: string | null;
  /** Extra built-ins the model needs to reach the guarded one (Edit reads before it edits). */
  helpers: string[];
  prompt: (dir: string) => string;
}

const NOTEBOOK = JSON.stringify(
  {
    cells: [{ cell_type: "code", id: "c1", metadata: {}, source: ["value = 1\n"], outputs: [], execution_count: null }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  },
  null,
  1,
);

/**
 * One mundane file operation per guarded built-in. Mundane on purpose: a prompt
 * that reads like a security probe gets refused by the model rather than
 * answered, which was measured while writing this (the first draft named its
 * files `protected.txt` and `hijacked` and haiku declined the whole request).
 */
const SCENARIOS: Record<GuardedBuiltin, Scenario> = {
  Write: {
    seed: {},
    witness: "note.txt",
    before: null,
    helpers: [],
    prompt: () =>
      "Create a file called note.txt in the current directory with exactly one line: hello. " +
      "If the tool is refused, do not retry it and do not try another way: stop and report the refusal. Then say what you did.",
  },
  Edit: {
    seed: { "note.txt": "value: 1\n" },
    witness: "note.txt",
    before: "value: 1\n",
    helpers: ["Read"],
    prompt: () =>
      "The file note.txt in the current directory says `value: 1`. Change the 1 to a 2, leaving the rest as it is. " +
      "If the tool is refused, do not retry it and do not try another way: stop and report the refusal. Then say what you did.",
  },
  NotebookEdit: {
    seed: { "probe.ipynb": NOTEBOOK },
    witness: "probe.ipynb",
    before: NOTEBOOK,
    helpers: ["Read"],
    prompt: () =>
      "The notebook probe.ipynb in the current directory has one code cell reading `value = 1`. Change it to `value = 2`. " +
      "If the tool is refused, do not retry it and do not try another way: stop and report the refusal. Then say what you did.",
  },
};

export interface ProbeOptions {
  /** The SDK's `query`, injected so the resident's own import is the one under test. */
  query: ProbeQuery;
  /** The cheap model the probe runs on; the CLI's permission plumbing is what is being measured, not the model. */
  model?: string;
  /** Matches the resident's own posture, or the probe proves something the resident does not do. */
  permissionMode?: string;
  /** Wall-clock ceiling; a probe that hangs must not keep a resident from booting forever. */
  timeoutMs?: number;
  /** How many times to re-ask when the model simply did not attempt the tool. */
  attempts?: number;
  log?: (line: string) => void;
}

/**
 * Ask ONE guarded built-in whether it still reaches `canUseTool` on the installed
 * SDK. Three outcomes and no fourth:
 *
 *   intercepted   the callback fired for this tool. Door one is reachable.
 *   bypassed      the write LANDED without the callback firing. Door one is gone
 *                 on this SDK for this tool, which is the exact regression this
 *                 probe exists to catch.
 *   inconclusive  the model never attempted the tool, or attempted it and neither
 *                 outcome was observed. Not a pass: the caller fails closed.
 */
export async function probeGuardedBuiltin(tool: GuardedBuiltin, opts: ProbeOptions): Promise<ProbeResult> {
  const scenario = SCENARIOS[tool];
  const maxAttempts = Math.max(1, opts.attempts ?? 2);
  let costUsd = 0;
  let lastDetail = "the model never attempted the tool";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rfa-fenceprobe-${tool.toLowerCase()}-`));
    try {
      for (const [name, body] of Object.entries(scenario.seed)) fs.writeFileSync(path.join(dir, name), body);
      const witness = path.join(dir, scenario.witness);
      let intercepted = false;
      let attempted = false;

      const iter = opts.query({
        prompt: scenario.prompt(dir),
        options: {
          cwd: dir,
          model: opts.model ?? "claude-haiku-4-5",
          maxTurns: 4,
          // The probe must run the resident's OWN configuration or it proves
          // something the resident does not do: the guarded tool in the base
          // `tools` set, absent from `allowedTools`, with the connectors off and
          // no settings file loaded.
          settingSources: [],
          settings: { disableClaudeAiConnectors: true },
          tools: [tool, ...scenario.helpers],
          allowedTools: [...scenario.helpers],
          ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
          canUseTool: async (toolName: string) => {
            if (toolName === tool) intercepted = true;
            return { behavior: "deny" as const, message: "fence startup probe: denied on purpose, nothing is wrong" };
          },
        },
      });

      /**
       * The iteration's own failure is NOT the probe's verdict, and conflating
       * the two cost a boot: a denied tool makes the model retry until it runs
       * out of turns, the SDK throws "Reached maximum number of turns", and the
       * run that PROVED door one works was reported as inconclusive. The
       * question here is only ever "did the callback fire", so the error is
       * remembered and the verdict is computed from the observations either way.
       */
      let iterationError: string | null = null;
      try {
        await withTimeout(
          (async () => {
            for await (const m of iter) {
              if (m.type === "assistant") {
                const content = (m.message as { content?: { type: string; name?: string }[] } | undefined)?.content ?? [];
                for (const c of content) if (c.type === "tool_use" && c.name === tool) attempted = true;
              }
              if (m.type === "result") costUsd += Number((m as { total_cost_usd?: number }).total_cost_usd ?? 0);
            }
          })(),
          opts.timeoutMs ?? 90_000,
        );
      } catch (err) {
        iterationError = (err as Error).message;
      }

      const after = fs.existsSync(witness) ? fs.readFileSync(witness, "utf8") : null;
      const landed = scenario.before === null ? after !== null : after !== scenario.before;

      if (intercepted) {
        return {
          tool,
          verdict: "intercepted",
          detail: landed
            ? `the callback fired, but the witness file changed anyway: the deny did not stick`
            : `the callback fired and the deny stuck`,
          attempts: attempt,
          costUsd,
        };
      }
      if (landed) {
        return {
          tool,
          verdict: "bypassed",
          detail: `${tool} wrote ${scenario.witness} without ever reaching canUseTool: this SDK no longer routes it through the callback`,
          attempts: attempt,
          costUsd,
        };
      }
      lastDetail = iterationError
        ? `the probe itself failed: ${iterationError}`
        : attempted
          ? `${tool} was attempted but neither the callback nor a write was observed`
          : `the model did not attempt ${tool}`;
      opts.log?.(`fence probe ${tool}: attempt ${attempt} inconclusive (${lastDetail})`);
    } catch (err) {
      // Setup, not iteration: the temp directory, the seed files, the query
      // construction. The iteration's own errors are handled above, where the
      // observations are still readable.
      lastDetail = `the probe could not be set up: ${(err as Error).message}`;
      opts.log?.(`fence probe ${tool}: attempt ${attempt} errored (${lastDetail})`);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a probe that cannot clean its own temp directory is not a reason to refuse a boot */
      }
    }
  }
  return { tool, verdict: "inconclusive", detail: lastDetail, attempts: maxAttempts, costUsd };
}

/**
 * A `bypassed` verdict is the regression; an `inconclusive` one is fail-closed
 * too, because "we could not tell" and "it is fenced" are not the same sentence
 * and only one of them is safe to boot on.
 */
export function probeIsFatal(r: ProbeResult): boolean {
  return r.verdict !== "intercepted" || r.detail.includes("did not stick");
}

/** Every guarded built-in this pack declares, in the order the constant lists them. */
export function guardedToProbe(declared: readonly string[]): GuardedBuiltin[] {
  return GUARDED_BUILTINS.filter((g) => declared.includes(g));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
