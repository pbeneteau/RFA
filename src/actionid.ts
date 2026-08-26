/**
 * Canonical action identity and effect class for approval cards (RFA-0.8
 * sect. 6.4 items 1 and 3; the wire keys are registered in spec Appendix B,
 * 0.1.9, and ride beside the approval ext of spec 12.5).
 *
 * The problem this exists for, measured rather than imagined: the card clock of
 * v0.5 sect. 16 fixed WHEN a card dies and nothing fixed HOW MANY TIMES its
 * approval fires. 39.8 percent of uncertain execution outcomes induce a
 * semantically equivalent re-proposal of an already-authorized action, and
 * fresh per-call approval does not help, because the retry legitimately earns a
 * fresh card. Without a stable identity the HUMAN is the ledger: the only thing
 * that knows "I already approved this save" is the person's memory.
 *
 * The input set is fixed by the spec (the acting tool's name, its normalized
 * input, and the task or conversation scope the action serves); only the
 * normalization below is this module's design. It is deliberately SYNTACTIC.
 * Semantic equivalence is not computable here and pretending otherwise would be
 * the worse failure: a normalization that collapses two genuinely different
 * document bodies into one identity would silently DROP the second write. So
 * the rule is that normalization may only remove things that carry no meaning
 * for the action (whitespace shape, absent fields, key order, Unicode
 * composition), never things that might.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./jcs.js";

/** Registered ext keys (wire Appendix B, 0.1.9; semantics owned here). */
export const ACTION_IDENTITY_EXT = "io.github.pbeneteau/action-identity";
export const EFFECT_CLASS_EXT = "io.github.pbeneteau/effect-class";

/**
 * How an action fails when its outcome is unknown, which is the only question
 * that matters after a crash between claim and settlement.
 *
 *  - `irreversible`: gate until settlement. A send, a payment, a publish. When
 *    the outcome is unknown, DO NOT re-run it; stop and surface it. Measured:
 *    0 of 500 leaked sends under gate-until-settlement versus 400 of 500 under
 *    Saga-style compensate-after.
 *  - `reversible_with_cost`: the compensator shape is the fallback here, and
 *    only here. A re-run is affordable but not free.
 *  - `reversible`: a re-run costs nothing anyone will notice.
 *
 * The DEFAULT is `irreversible`, and that direction is the point. A tool worth
 * putting in front of a human is a tool with a side effect; classing an unknown
 * effect as reversible would make the safe path the one an operator has to
 * remember to ask for.
 */
export type EffectClass = "irreversible" | "reversible_with_cost" | "reversible";
export const EFFECT_CLASSES: readonly EffectClass[] = ["irreversible", "reversible_with_cost", "reversible"];
export const DEFAULT_EFFECT_CLASS: EffectClass = "irreversible";

/** An unknown or absent class reads as the safe one, never as "reversible". */
export function effectClassOf(raw: unknown): EffectClass {
  return typeof raw === "string" && (EFFECT_CLASSES as readonly string[]).includes(raw) ? (raw as EffectClass) : DEFAULT_EFFECT_CLASS;
}

/** Whether an unsettled claim on this class may be taken over and re-run. */
export function mayRetryUnsettled(cls: EffectClass): boolean {
  return cls !== "irreversible";
}

/**
 * Keys stripped before the identity is computed.
 *
 * An idempotency key is a CONSEQUENCE of the identity, so including it in the
 * identity is circular: the retry that echoes back a key we injected would mint
 * a different identity and claim a second slot, which is exactly the double-fire
 * this module exists to stop. `request_id` is the card's own id and rotates per
 * card by construction.
 */
const IDENTITY_BLIND_KEYS = new Set(["idempotency_key", "idempotencykey", "request_id", "requestid"]);

/**
 * Normalize one input value for identity purposes.
 *
 * Rules, each with its reason:
 *  - strings: NFC (two spellings of the same character are the same argument),
 *    trimmed, internal whitespace runs collapsed to one space. A model
 *    re-proposing an action reflows its own prose; the reflow is not a
 *    different action.
 *  - absent-ish values (null, undefined, empty string after trimming): dropped
 *    from objects. A retry that stops sending an optional empty field is the
 *    same action.
 *  - arrays: recursed, ORDER PRESERVED. Order is meaning in an argument list
 *    (recipients, ordered steps), so sorting here would merge distinct actions.
 *  - objects: recursed; key order is handled by JCS at serialization, not here.
 *  - numbers and booleans: untouched.
 */
export function normalizeInput(value: unknown): unknown {
  if (typeof value === "string") {
    return value.normalize("NFC").replace(/\s+/g, " ").trim();
  }
  if (Array.isArray(value)) return value.map(normalizeInput);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (IDENTITY_BLIND_KEYS.has(k.toLowerCase())) continue;
      const n = normalizeInput(v);
      if (n === null || n === undefined || n === "") continue;
      out[k] = n;
    }
    return out;
  }
  return value === undefined ? null : value;
}

/**
 * The canonical identity of an action: stable across retries, restarts and
 * processes, and computable independently by two mints that never talk.
 *
 * The `act1_` prefix is the NORMALIZATION VERSION and it is load-bearing. If
 * these rules ever change, every identity changes with them, and a silent split
 * would re-open the double-fire window on the exact actions that were mid-flight
 * across the upgrade. Bumping the prefix makes the split visible in the claim
 * table instead.
 */
export function actionIdentity(args: { toolName: string; input: unknown; scope: string }): string {
  const digest = createHash("sha256")
    .update(
      canonicalize({
        tool: args.toolName,
        input: normalizeInput(args.input ?? {}),
        scope: args.scope,
      }),
    )
    .digest("hex");
  return `act1_${digest.slice(0, 32)}`;
}

/**
 * The scope an action serves (the third fixed input): the task it works, else
 * the conversation it answers. Never the run id, which rotates per attempt and
 * would make every retry a new action, defeating the whole mechanism.
 */
export function actionScope(args: { taskId?: string | null; conversationId?: string | null; room?: string | null }): string {
  if (args.taskId) return `task:${args.taskId}`;
  if (args.conversationId) return `conversation:${args.conversationId}`;
  return `room:${args.room ?? "unknown"}`;
}
