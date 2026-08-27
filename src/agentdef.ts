/**
 * Agent pack definitions (RFA v0.4 spec section 3): the ONE zod schema shared
 * by the resident runner, the supervisor, and (later) the console editor.
 *
 * A pack is a directory `agents/<name>/` whose `agent.md` is YAML frontmatter
 * (the definition, inert data) plus a markdown body (the system prompt).
 * The capability card and its digest are DERIVED from the definition, so a
 * definition edit rotates the digest and is visible in every roster.
 *
 * Spec delta (to fold into RFA-0.4 3.2): `offers` is the explicit list of
 * room-facing card skills; `skills` stays reserved for Agent SDK skill packs.
 * Deriving card skills from SKILL.md folders conflated two different things.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { effectiveMode } from "./posture.js";
import { guardedBuiltinsOf, shadowingFailures } from "./writefence.js";
import * as z from "zod";
import { sha256hex } from "./jcs.js";
import type { AgentCard } from "./model.js";

/**
 * Tool names that turn one pack into a fan-out tree (spec 18.7). Matching is on
 * the tool HEAD, so a specifier form (`Task(explore)`) cannot slip past the
 * assertion.
 */
const SUBAGENT_TOOLS = new Set(["agent", "task"]);

/**
 * Fan-out is opt-in (spec 18.7). The assertion lives in the schema, at the
 * layer where the risk would arrive: `canUseTool` default-denying today is a
 * property of the current runtime, not a control, and a runtime check on a path
 * that does not exist cannot be relied on when the path appears.
 */
const toolsSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    allow_subagents: z.boolean().default(false),
  })
  .superRefine((tools, ctx) => {
    if (tools.allow_subagents) return;
    for (const entry of tools.allow ?? []) {
      if (!SUBAGENT_TOOLS.has(entry.split("(")[0].trim().toLowerCase())) continue;
      ctx.addIssue({
        code: "custom",
        path: ["allow"],
        message: `lists \`${entry}\`, which spawns subagents; declare tools.allow_subagents: true to permit fan-out`,
      });
    }
  });

/**
 * The memory verbs an answer-path turn carries for free, and the ones a pack has
 * to declare (RFA-0.8 sect. 4 item 2, the ownership split; the enforcement
 * mechanism is the one v0.4 sect. 3.12 already owns, which is that tools ARE the
 * declaration).
 *
 * Destructive verbs belong to the consolidation lane. Two turns appending to one
 * file compose; two turns where one deletes what the other is rewriting do not,
 * and no shipped system merges the result. So `delete` and `rename` are granted
 * only to a pack that names them, and a pack that names one cannot run at
 * `concurrency > 1` (sect. 10 gate 2).
 *
 * `str_replace` is the awkward one and is split by PATH rather than by name: on
 * `notes/*` it is the loud-stale compare-and-swap sect. 4 item 1 pins
 * deliberately, on `blocks/*` it is a whole-block rewrite, which is the
 * documented lost-update shape. So the verb is granted always and its
 * destructive half is opt-in, through the same declaration.
 */
export const MEMORY_DESTRUCTIVE_TOOLS = ["mcp__memory__delete", "mcp__memory__rename", "mcp__memory__str_replace"] as const;

export const agentDefSchema = z.object({
  rfa_agent: z.literal(1),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  tools: toolsSchema.optional(),
  skills: z.array(z.string()).optional(),
  /**
   * MCP servers this pack brings (v0.4 sect. 3.2), by the name that prefixes
   * their tool ids (`mcp__<name>__<tool>`). A stdio server is a command; an HTTP
   * server is a URL. Secrets are NAMES: the supervisor and the resident inject
   * their values from the hub directory's secrets file, never the pack.
   */
  mcp_servers: z
    .record(
      z.string().regex(/^[a-z0-9_-]+$/, "a server name: lowercase letters, digits, underscore, hyphen"),
      z.union([
        z.object({
          command: z.string().min(1),
          args: z.array(z.string()).optional(),
          /** Secret NAMES to inject into the server process's environment. */
          env_secrets: z.array(z.string()).optional(),
          env: z.record(z.string(), z.string()).optional(),
        }),
        z.object({
          url: z.string().url(),
          /** The secret NAME whose value is sent as `Authorization: Bearer`. */
          bearer_secret: z.string().optional(),
        }),
        z.object({
          /** A server this package ships (`src/servers/`), run through the tool's own entry. */
          builtin: z.enum(["linear"]),
          env_secrets: z.array(z.string()).optional(),
        }),
      ]),
    )
    .optional(),
  /** How the acting tools are treated (src/posture.ts): ask (default), plan, bypass. `auto` was withdrawn 2026-08-23. */
  mode: z.enum(["ask", "plan", "bypass"]).optional(),
  knowledge: z.array(z.string()).optional(),
  offers: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1).max(1024),
        input_schema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  memory: z
    .object({
      scope: z.literal("pack").default("pack"),
      blocks: z.array(z.string()).optional(),
      gate: z.literal("memory-gate").default("memory-gate"),
    })
    .optional(),
  sandbox: z
    .object({
      /**
       * Workspace isolation, and only `none` is accepted because only `none` is
       * implemented (RFA-0.8 sect. 8.1). Found 2026-08-26 at rung 6's trigger
       * check: this field was INERT, accepting `worktree` and `container` while
       * no production module read it, so a pack asking for container isolation
       * got none of it and nothing said so. A safety setting that silently does
       * nothing is the lie RFA-0.8 sect. 9 item 3 forbids everywhere else, so the
       * enum keeps the dead values only to refuse them by name rather than with
       * zod's generic enum error. `clone` is listed for the same reason before it
       * works: an operator who reads sect. 8.1 and sets the value the spec names
       * deserves "not until rung 6a" and not "invalid option".
       *
       * The enum therefore carries its OWN error too, for a value that is not
       * even in the list: zod's default would print "expected one of
       * none|worktree|container|clone" and advertise three values as legal,
       * which is the generic-enum outcome this field exists to avoid. It names
       * `none` and points at the refusal below. The refusal itself carries no
       * "sandbox.isolation:" prefix: `parseAgentMd` already prints the path.
       */
      isolation: z
        .enum(["none", "worktree", "container", "clone"], {
          error: "only `none` is implemented; any other value is refused by name, with what that value would require",
        })
        .default("none")
        .refine((v) => v === "none", {
          message:
            "only `none` is implemented. `worktree` is rejected on the merits (RFA-0.8 Appendix A: a worktree materializes tracked files only, and a pack's mutable bulk is gitignored by design), `container` is parked with its own trigger, and `clone` becomes legal with RFA-0.8 rung 6a. Per-run write isolation today is the two-door fence of RFA-0.8 sect. 9, which needs no isolation setting.",
        }),
      permission_mode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).default("default"),
      network: z.enum(["none", "allowlist", "open"]).default("none"),
      allowed_domains: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    })
    .optional(),
  secrets: z.array(z.string()).optional(),
  /**
   * Turns this pack may run at once (RFA-0.8 sect. 10, amending v0.4 sect. 3.2).
   *
   * Sizing, and this is not a detail: each concurrent turn is a full `claude`
   * CLI CHILD PROCESS, not a thread (live probe B, 2026-08-25 - two children
   * were observed during one overlap run). `concurrency: 4` is a statement about
   * four processes' worth of memory and file descriptors on this host, and the
   * account cap (`agents.max_inflight`) bounds the total across every resident.
   *
   * Above 1 it is refused unless all three gates of sect. 10 pass: a read-only
   * posture, no destructive memory verb in the answer-path surface, and a
   * declared per-day budget. The gates are checked below, where the schema can
   * see them; the fence-availability half of the posture gate is a runtime
   * property and is checked at resident startup, failing closed.
   */
  concurrency: z.number().int().min(1).max(16).default(1),
  /**
   * How many CANDIDATES this pack runs for one task by default (RFA-0.8
   * sect. 11, rung 4): N independent runs of the same task, one output
   * selected, the rest discarded. 1, the default, is no fan-out at all.
   *
   * What the number costs, in the field's own documentation, because N
   * candidates is N times the money for ONE answer and the operator pays it:
   * three candidates is three model runs, three account reservations against
   * the same day budget, and three CLI child processes on this host. The
   * per-task ask (`rfa task create --candidates N`) overrides this, and both
   * are cut down to what the day budget can actually reserve, with the reason
   * reported rather than swallowed.
   *
   * Above 1 it requires `concurrency >= candidates` (and therefore the three
   * gates of sect. 10), because running N candidates IS running N turns at
   * once and the pack has to have said so.
   */
  candidates: z.number().int().min(1).max(8).default(1),
  budgets: z
    .object({
      max_turns: z.number().int().min(1).max(200).optional(),
      max_execution_s: z.number().int().min(1).optional(),
      max_rpm: z.number().int().min(1).optional(),
      max_retries: z.number().int().min(0).optional(),
      per_task_usd: z.number().positive().optional(),
      per_day_usd: z.number().positive().optional(),
    })
    .optional(),
  interrupt_on: z
    .record(
      z.string(),
      z.union([
        z.boolean(),
        z.object({
          allowed_decisions: z.array(z.enum(["approve", "edit", "reject", "respond"])),
          /**
           * Input keys of which at least one must be present BEFORE a human is
           * paged; a call missing all of them is bounced back to the model. The
           * generic form of the Linear parent preflight: a save without a
           * project or a team is doomed at Linear's door, and paging a human for
           * it wastes the scarcest thing the platform has.
           */
          require_one_of: z.array(z.string()).optional(),
          /**
           * How this action fails when its outcome is UNKNOWN, which is the only
           * question that matters after a crash between the consumption claim
           * and the tool's answer (RFA-0.8 sect. 6.4 item 3). `irreversible`
           * (the default, applied wherever this is absent) gates until a human
           * settles it; the compensate-after shape is the fallback for the other
           * two, and only for them. Measured: 0 of 500 leaked sends under
           * gate-until-settlement versus 400 of 500 under compensation.
           */
          effect_class: z.enum(["irreversible", "reversible_with_cost", "reversible"]).optional(),
          /**
           * The input field this tool accepts an idempotency key on, if it has
           * one. When named, the key minted by the consumption claim is merged
           * into the call, so a service that dedupes on it collapses two
           * attempts of one approved action.
           *
           * Opt-in on purpose. Injecting an undeclared field into a third-party
           * tool's input is a schema break, and this rung must not make approved
           * calls start failing at the tool's door: that is the same class of
           * failure as the Linear save that died for want of a project, which is
           * what `require_one_of` above exists to prevent.
           */
          idempotency_key_field: z.string().min(1).max(64).optional(),
        }),
      ]),
    )
    .optional(),
  rooms: z
    .array(
      z.object({
        room: z.string().optional(),
        topic: z.string().optional(),
        role: z.enum(["participant", "observer"]).default("participant"),
        serve: z.boolean().default(true),
        presence_ttl_s: z.number().int().min(30).max(900).optional(),
        auto_resume: z.boolean().default(true),
      }),
    )
    .optional(),
  schedules: z
    .array(z.object({ cron: z.string(), timezone: z.string().optional(), prompt: z.string() }))
    .optional(),
});

/** What a gate is asked about: the subset of a definition the gates read. */
interface ConcurrencyGateInput {
  concurrency?: number;
  candidates?: number;
  tools?: { allow?: string[] };
  mode?: string;
  interrupt_on?: AgentDef["interrupt_on"];
  budgets?: { per_day_usd?: number };
}

/**
 * The gates on `concurrency > 1` (RFA-0.8 sect. 10), as a list rather than a
 * run of `if`s, so that the SHORT NAME of each gate and the check for it are one
 * edit apart.
 *
 * They are separated from the object literal so the reasons can be read, and so
 * the CLI can explain a refusal without re-deriving it. The list shape is the
 * fix for the other half of that: `rfa agent show` and `rfa doctor` both used to
 * hardcode "sect. 10's three gates" and enumerate three of the four, prose
 * restating code that had already moved. `CONCURRENCY_GATE_LABELS` below is what
 * they read now, so a fifth gate cannot be added without its label.
 *
 * Every one of these is a thing that is merely inefficient serially and becomes
 * a correctness or a money problem at N > 1, which is why they are gates and not
 * warnings. A warning is not a control at N > 1: it scales the exposure by N and
 * changes nothing.
 */
const CONCURRENCY_GATES: { label: string; failure: (def: ConcurrencyGateInput, n: { concurrency: number; candidates: number }) => string | null }[] = [
  {
    label: "candidates within concurrency",
    failure: (_def, { concurrency, candidates }) =>
      candidates > concurrency
        ? `it declares candidates: ${candidates} but concurrency: ${concurrency}: ${candidates} candidates for one task is ${candidates} turns at once, ` +
          `each a full CLI child process, so the pack has to declare concurrency: ${candidates} or more (RFA-0.8 sect. 11)`
        : null,
  },
  {
    // Gate 1, posture, in the two halves sect. 10 gives it.
    //
    // The half the schema CAN see: a pack with gated acting tools. Those reach
    // the world through third-party MCP tools whose write set this platform
    // cannot fence at all, and NO rung of RFA-0.8 changes that: rung 6a is a CoW
    // clone of the pack's own tree and 6b is a git publish of it, so neither
    // touches a write that lands in a remote SaaS workspace. An acting pack
    // therefore stays serial rather than waiting for a rung; the fence of sect. 9
    // (rung 5, built) covers guarded BUILT-INS, which is a different surface.
    //
    // The half it CANNOT: a pack with a declared write surface (a guarded
    // built-in in `tools.allow`) is allowed through here on purpose, which is a
    // change of 2026-08-26 and the point of rung 5. Whether the two-door fence
    // is available and ESTABLISHED for that surface is a property of this host
    // and this SDK, not of the definition, so it is checked at resident startup
    // and fails closed there (sect. 10's own split, and sect. 9 item 3). What the
    // definition CAN say about the fence is checked by `writeSurfaceDefFailures`,
    // for every pack and not only a concurrent one.
    label: "read-only posture",
    failure: (def) => {
      const mode = effectiveMode(def as AgentDef);
      return mode === "read-only"
        ? null
        : `its effective posture is \`${mode}\`, not read-only: an acting tool reaches the world through a third-party MCP server whose write set neither door of the write fence can trace (RFA-0.8 sect. 9), and no rung of RFA-0.8 fences those side effects, so an acting pack stays serial`;
    },
  },
  {
    // Gate 2, memory topology (sect. 4 item 2).
    label: "no destructive memory verb",
    failure: (def) => {
      const declared = (def.tools?.allow ?? []).filter((t) => (MEMORY_DESTRUCTIVE_TOOLS as readonly string[]).includes(t));
      return declared.length === 0
        ? null
        : `its answer-path tool surface declares ${declared.join(", ")}, which are destructive memory verbs belonging to the consolidation lane (RFA-0.8 sect. 4 item 2)`;
    },
  },
  {
    // Gate 3, a ceiling (sect. 5 item 7). Unbounded serially is a warning;
    // unbounded times N is not something a warning can hold.
    label: "a declared per-day ceiling",
    failure: (def, { concurrency, candidates }) =>
      def.budgets?.per_day_usd
        ? null
        : `it declares no budgets.per_day_usd: a pack with no daily ceiling goes from unbounded-serially to unbounded-times-${Math.max(concurrency, candidates)} (RFA-0.8 sect. 5 item 7)`,
  },
];

/**
 * The gates by short name, in the order they are checked, for the CLI's prose.
 * Derived from `CONCURRENCY_GATES` and never written out by hand: a count or an
 * enumeration typed into a message is a copy of code, and this one had already
 * gone stale at four gates.
 */
export const CONCURRENCY_GATE_LABELS: readonly string[] = CONCURRENCY_GATES.map((g) => g.label);

/** Which of the gates above this definition does NOT pass, with the reason each. */
export function concurrencyGateFailures(def: ConcurrencyGateInput): string[] {
  const concurrency = def.concurrency ?? 1;
  const candidates = def.candidates ?? 1;
  // Candidates ride these gates rather than getting their own: N candidates IS
  // N turns at once, so a pack declaring `candidates: 3` has declared the same
  // exposure as one declaring `concurrency: 3` and answers for it here.
  if (concurrency <= 1 && candidates <= 1) return [];
  return CONCURRENCY_GATES.map((g) => g.failure(def, { concurrency, candidates })).filter((f): f is string => f !== null);
}

/**
 * What a DEFINITION can say about the two-door write fence (RFA-0.8 sect. 9),
 * checked for every pack with a declared write surface regardless of
 * `concurrency`: one turn writing outside its scratch surface is the same defect
 * as two, it is just cheaper to find.
 *
 * The rest of the fence is a runtime property (is the OS sandbox available on
 * this host, does this SDK still route the guarded built-ins through the
 * callback) and lives at resident startup, failing closed.
 */
export function writeSurfaceDefFailures(def: {
  tools?: { allow?: string[] };
  sandbox?: { permission_mode?: string };
}): string[] {
  const guarded = guardedBuiltinsOf(def as AgentDef);
  if (guarded.length === 0) return [];
  return shadowingFailures({
    guarded,
    // The definition cannot name `allowedTools` (the resident computes it), so
    // only the permission mode is visible here.
    allowedTools: [],
    permissionMode: def.sandbox?.permission_mode,
  }).map((f) => `it declares the write surface ${guarded.join(", ")} and ${f}`);
}

export type AgentDef = z.infer<typeof agentDefSchema>;

/** Every secret NAME a pack needs injected: its own `secrets` plus what its MCP servers declare. */
export function declaredSecretNames(def: AgentDef): string[] {
  const names = new Set(def.secrets ?? []);
  for (const server of Object.values(def.mcp_servers ?? {})) {
    if ("env_secrets" in server) for (const n of server.env_secrets ?? []) names.add(n);
    if ("bearer_secret" in server && server.bearer_secret) names.add(server.bearer_secret);
  }
  return [...names];
}

export interface AgentPack {
  name: string;
  dir: string;
  def: AgentDef;
  /** The markdown body of agent.md: the system prompt. */
  prompt: string;
  /** sha256 over the full agent.md content: the deployed-version marker. */
  definitionHash: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * The frontmatter object and the body, before any validation.
 *
 * Exported for the one caller that needs a definition the loader REFUSED: `rfa
 * doctor` reports WHICH gate of RFA-0.8 sect. 10, or which half of the write
 * fence's door one, a rejected pack fails, and it cannot ask `loadPack` because
 * `parseAgentMd` throws on exactly those packs. Reading the frontmatter here
 * rather than in the CLI keeps one definition of "the frontmatter block": a
 * second regex would drift from this one silently.
 */
export function splitAgentMd(content: string): { raw: unknown; body: string } {
  const m = FRONTMATTER.exec(content);
  if (!m) throw new Error("agent.md must start with a YAML frontmatter block (--- ... ---)");
  try {
    return { raw: YAML.parse(m[1]), body: m[2] };
  } catch (err) {
    throw new Error(`agent.md frontmatter is not valid YAML: ${(err as Error).message}`);
  }
}

/** Parse an agent.md string. Throws with a precise message on any invalid input. */
export function parseAgentMd(content: string): { def: AgentDef; prompt: string; definitionHash: string } {
  const { raw, body } = splitAgentMd(content);
  const parsed = agentDefSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`agent.md definition invalid at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const def = parsed.data;
  // The concurrency gates (RFA-0.8 sect. 10). Here rather than inside the object
  // literal so `agentDefSchema` stays the plain shared schema every caller
  // reaches for, and beside the `offers` rule below, which is the same kind of
  // check: a cross-field truth the field-level schema cannot see.
  const gates = concurrencyGateFailures(def);
  if (gates.length > 0) {
    throw new Error(
      `agent.md declares concurrency: ${def.concurrency}${def.candidates > 1 ? ` and candidates: ${def.candidates}` : ""} but ${gates.length === 1 ? "does not pass a gate" : `does not pass ${gates.length} gates`} (RFA-0.8 sect. 10):\n` +
        gates.map((g) => `  - ${g}`).join("\n"),
    );
  }
  const fence = writeSurfaceDefFailures(def);
  if (fence.length > 0) {
    throw new Error(
      `agent.md cannot be fenced as written (RFA-0.8 sect. 9):\n` + fence.map((f) => `  - ${f}`).join("\n"),
    );
  }
  const serves = (def.rooms ?? []).some((r) => r.serve && r.role === "participant");
  if (serves && !(def.offers ?? []).length) {
    throw new Error("a pack that serves a room as participant must declare at least one entry in `offers` (its card skills)");
  }
  const prompt = body.trim();
  if (!prompt) throw new Error("agent.md needs a markdown body: it is the system prompt");
  return { def, prompt, definitionHash: "sha256:" + sha256hex(content) };
}

/** Load a pack directory (`agents/<name>/`). */
export function loadPack(dir: string): AgentPack {
  const file = path.join(dir, "agent.md");
  const content = fs.readFileSync(file, "utf8");
  const { def, prompt, definitionHash } = parseAgentMd(content);
  return { name: def.name, dir, def, prompt, definitionHash };
}

/** List every pack under an agents root, skipping directories without agent.md. */
export function listPacks(root: string): AgentPack[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "agent.md")))
    .map((e) => loadPack(path.join(root, e.name)));
}

/** A pack directory whose `agent.md` did not load, named by its directory. */
export interface BrokenPack {
  /** The DIRECTORY name. The declared name is unreadable, which is the whole problem. */
  name: string;
  /** First line of the loader's complaint: enough to act on, short enough for one row. */
  error: string;
}

/**
 * Every pack under an agents root, loaded ONE AT A TIME: the ones that parse and
 * the ones that do not, separately.
 *
 * `listPacks` maps `loadPack` with no catch and keeps that behaviour on purpose,
 * because several callers genuinely want a loud failure. Everything that LISTS,
 * STOPS or SUPERVISES an instance wants the opposite, and got it wrong four
 * times: `rfa doctor` and `rfa status` answered with a parse error instead of
 * the instance (fixed 2026-08-27), `rfa up` and `rfa down` died before starting
 * or stopping anything, and the SUPERVISOR logged one line and reconciled
 * NOTHING, so a single typo left every resident unsupervised on a 30s loop.
 * One implementation, because a subtle scan copied per caller is how the copies
 * drift.
 */
export function scanPacks(root: string): { packs: AgentPack[]; broken: BrokenPack[] } {
  const packs: AgentPack[] = [];
  const broken: BrokenPack[] = [];
  if (!fs.existsSync(root)) return { packs, broken };
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !fs.existsSync(path.join(root, e.name, "agent.md"))) continue;
    try {
      packs.push(loadPack(path.join(root, e.name)));
    } catch (err) {
      broken.push({ name: e.name, error: (err as Error).message.split("\n")[0] });
    }
  }
  return { packs, broken };
}

/**
 * Every name the registry DECLARES, which is not the same as every name that
 * parses.
 *
 * This exists for one decision: the supervisor drains any child whose name has
 * left the registry, and `rfa down` reports any resident whose name is still in
 * it. A pack with a typo in its `agent.md` is NOT a retired pack, so leaving it
 * out of this set would drain a HEALTHY running resident over a syntax error
 * (and, on the CLI side, omit a live resident from the report an operator is
 * given). The declared name is unreadable for a broken pack, so its DIRECTORY
 * name stands in, and any existing child living in that directory is protected
 * by its own name too, because a directory name and a declared name are allowed
 * to differ.
 */
export function declaredPackNames(packs: AgentPack[], broken: BrokenPack[], existing: readonly { name: string; dir: string }[] = []): Set<string> {
  const names = new Set(packs.map((p) => p.name));
  for (const b of broken) {
    names.add(b.name);
    for (const child of existing) if (path.basename(child.dir) === b.name) names.add(child.name);
  }
  return names;
}

/**
 * The capability card DERIVED from the definition (spec 3.1): name,
 * description, offers as card skills, and the definition hash so a definition
 * edit rotates the roster digest (the deployed-version signal).
 */
export function deriveCard(pack: AgentPack): AgentCard {
  return {
    name: pack.def.name,
    description: pack.def.description,
    version: "0.4.0",
    skills: (pack.def.offers ?? []).map((o) => ({
      id: o.id,
      description: o.description,
      ...(o.input_schema ? { inputSchema: o.input_schema } : {}),
    })),
    definition_hash: pack.definitionHash,
  };
}

/** Resolve the pack's knowledge globs to existing absolute file paths (for prompt instructions, not stuffing). */
export function knowledgeFiles(pack: AgentPack): string[] {
  const out: string[] = [];
  for (const pattern of pack.def.knowledge ?? []) {
    const base = path.resolve(pack.dir, pattern.replace(/\*\*?.*$/, ""));
    if (pattern.includes("*")) {
      walk(base, out);
    } else if (fs.existsSync(base)) {
      out.push(base);
    }
  }
  return [...new Set(out)].filter((f) => f.endsWith(".md") && fs.existsSync(f));
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
}
