/**
 * An agent's mode (RFA-0.4 sect. 3.1 amendment, 2026-08-22): one word in
 * agent.md that sets how the pack's acting tools are treated, the way Claude
 * Code's permission modes do for a session.
 *
 *   ask     every acting tool pauses on a card a human approves, edits or rejects (the default)
 *   plan    proposes, never acts: an acting tool is refused with "put the call in your answer"
 *   auto    the SDK's own classifier decides; in every live run so far it approved without a card
 *   bypass  acts without asking; the room gate, budgets, hold and quarantine still apply
 *
 * "Acting tools" are the ones `interrupt_on` names. A pack with none (an
 * answerer) has nothing a mode could change, and reports `read-only`.
 *
 * This is a pure mapping so the resident's wiring can be tested without
 * booting one: the resident passes `allowedTools` and `permissionMode` to the
 * SDK and consults `canUseTool` for whatever is not pre-allowed.
 */
import type { AgentDef } from "./agentdef.js";
import { interruptMatch } from "./bridge.js";

export const MODES = ["ask", "plan", "auto", "bypass"] as const;
export type AgentMode = (typeof MODES)[number];

export const MODE_SUMMARY: Record<AgentMode, string> = {
  ask: "every acting tool pauses on a card you approve, edit or reject",
  plan: "proposes, never acts: the answer is the plan",
  auto: "the SDK decides for itself; so far it has approved every acting call without a card, so treat it as bypass with a second opinion",
  bypass: "acts without asking; the room gate, budgets, hold and quarantine still apply",
};

export type SdkPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

export interface Posture {
  /** The effective mode; `read-only` for a pack with no acting tools. */
  mode: AgentMode | "read-only";
  permissionMode: SdkPermissionMode;
  /** Tools pre-allowed at the SDK: everything in `tools.allow`, minus the acting ones unless the mode lets them through. */
  allowedTools: string[];
  /** The acting tools: what `interrupt_on` names, among what the pack may call. */
  acting: string[];
  /** What `canUseTool` does when an acting tool reaches it. */
  onActing: "card" | "refuse-plan" | "allow";
}

export function effectiveMode(def: AgentDef): AgentMode | "read-only" {
  const acting = actingTools(def);
  if (acting.length === 0 && !def.mode) return "read-only";
  return def.mode ?? "ask";
}

export function actingTools(def: AgentDef): string[] {
  return (def.tools?.allow ?? []).filter((t) => interruptMatch(def.interrupt_on, t) !== null);
}

export function agentPosture(def: AgentDef): Posture {
  const allow = def.tools?.allow ?? [];
  const acting = actingTools(def);
  const mode = effectiveMode(def);
  const base = def.sandbox?.permission_mode ?? "default";
  switch (mode) {
    case "plan":
      // NOT the SDK's own plan mode: that one injects "write a plan file, then
      // call ExitPlanMode", neither of which exists in a room, and the model
      // spent its answer apologising for them (two live runs). Our plan mode is
      // the default posture with the acting tools refused and the answer named
      // as the plan.
      return { mode, permissionMode: base, allowedTools: allow.filter((t) => !acting.includes(t)), acting, onActing: "refuse-plan" };
    case "auto":
      return { mode, permissionMode: "auto", allowedTools: allow.filter((t) => !acting.includes(t)), acting, onActing: "card" };
    case "bypass":
      return { mode, permissionMode: "bypassPermissions", allowedTools: allow, acting, onActing: "allow" };
    case "ask":
    case "read-only":
    default:
      return { mode, permissionMode: base, allowedTools: allow.filter((t) => !acting.includes(t)), acting, onActing: "card" };
  }
}

export function isMode(s: string): s is AgentMode {
  return (MODES as readonly string[]).includes(s);
}
