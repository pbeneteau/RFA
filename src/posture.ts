/**
 * An agent's mode (RFA-0.4 sect. 3.1 amendment, 2026-08-22): one word in
 * agent.md that sets how the pack's acting tools are treated, the way Claude
 * Code's permission modes do for a session.
 *
 *   ask     every acting tool pauses on a card a human approves, edits or rejects (the default)
 *   plan    proposes, never acts: an acting tool is refused with "put the call in your answer"
 *   bypass  acts without asking; the room gate, budgets, hold and quarantine still apply
 *
 * `auto` (the SDK's classifier deciding) was offered for a day and withdrawn:
 * characterized live on 2026-08-23, it approved the pack's gated tool with no
 * card, writing a file outside the server's own root, and the model refused
 * the dangerous request by itself before the classifier saw it. A mode whose
 * refusals cannot be observed is not a second opinion anyone can rely on.
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
import { guardedBuiltinsOf } from "./writefence.js";

export const MODES = ["ask", "plan", "bypass"] as const;
export type AgentMode = (typeof MODES)[number];

export const MODE_SUMMARY: Record<AgentMode, string> = {
  ask: "every acting tool pauses on a card you approve, edit or reject",
  plan: "proposes, never acts: the answer is the plan",
  bypass: "acts without asking, with its DECLARED tools only; the room gate, budgets, hold and quarantine still apply",
};

export type SdkPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto";

/**
 * The SDK's BUILT-IN tools a pack declares (Read, Grep, Glob, Bash …), as
 * opposed to its MCP ones. The resident passes exactly these as the SDK's base
 * tool set, so every built-in the pack did not name is absent rather than
 * merely denied: `canUseTool` is not consulted for harness-internal tools, so a
 * fence that relies on the callback is not a fence for them at all (found live
 * 2026-08-24: a resident enumerated the operator's other Claude Code sessions
 * with ListAgents and messaged one with SendMessage, neither declared, neither
 * ever reaching the callback). Deny-by-default at the base set also means a
 * tool the SDK adds tomorrow is excluded by construction, which a hand-kept
 * blocklist could never promise.
 */
export function declaredBuiltins(def: AgentDef): string[] {
  return (def.tools?.allow ?? []).filter((t) => !t.startsWith("mcp__"));
}

export interface Posture {
  /** The effective mode; `read-only` for a pack with no acting tools. */
  mode: AgentMode | "read-only";
  permissionMode: SdkPermissionMode;
  /** Tools pre-allowed at the SDK: everything in `tools.allow`, minus the acting ones unless the mode lets them through. */
  allowedTools: string[];
  /** The SDK's base tool set for this pack: the built-ins it declared, and nothing else. */
  builtins: string[];
  /** The acting tools: what `interrupt_on` names, among what the pack may call. */
  acting: string[];
  /**
   * The guarded built-ins this pack declares (RFA-0.8 sect. 9, rung 5): its
   * declared WRITE SURFACE. They sit in `builtins` (the SDK's base tool set) and
   * are deliberately absent from `allowedTools`, because the bare entry is what
   * auto-approves the call before `canUseTool` is consulted and so switches door
   * one off. Measured, twice: probe A for Write, probe C for Edit.
   */
  guarded: string[];
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

/**
 * What the SDK may auto-approve: everything the pack declared, minus the acting
 * tools (they route to the card) and minus the guarded built-ins (they route to
 * door one's path guard). Both exclusions exist for the same reason and it is
 * worth saying once: a bare `allowedTools` entry auto-approves the whole tool
 * BEFORE `canUseTool` is consulted, so pre-approving a tool is the same act as
 * removing every check this platform puts behind it.
 */
function preApproved(allow: string[], acting: string[], guarded: string[]): string[] {
  return allow.filter((t) => !acting.includes(t) && !guarded.includes(t));
}

export function agentPosture(def: AgentDef): Posture {
  const allow = def.tools?.allow ?? [];
  const acting = actingTools(def);
  const guarded: string[] = guardedBuiltinsOf(def);
  const mode = effectiveMode(def);
  const base = def.sandbox?.permission_mode ?? "default";
  switch (mode) {
    case "plan":
      // NOT the SDK's own plan mode: that one injects "write a plan file, then
      // call ExitPlanMode", neither of which exists in a room, and the model
      // spent its answer apologising for them (two live runs). Our plan mode is
      // the default posture with the acting tools refused and the answer named
      // as the plan.
      return { mode, permissionMode: base, allowedTools: preApproved(allow, acting, guarded), builtins: declaredBuiltins(def), acting, guarded, onActing: "refuse-plan" };
    case "bypass":
      // NOT the SDK's bypassPermissions. That auto-approves EVERY reachable
      // tool BEFORE canUseTool is consulted - and a resident logged in through
      // the operator's claude.ai account can reach the account's connectors,
      // plus Bash. Found live 2026-08-24: a linear-agent whose pack declares
      // one gated document tool created real Linear projects and issues
      // through the operator's personal Linear connector, with the deny-by-
      // default canUseTool never asked. Our bypass keeps the default
      // permission flow, so every undeclared tool still dies at canUseTool
      // ("not allowed for this pack"), and only the pack's OWN acting tools
      // become silent approvals: the acting tools stay out of allowedTools so
      // they route through canUseTool, where onActing "allow" answers without
      // a card.
      return { mode, permissionMode: base, allowedTools: preApproved(allow, acting, guarded), builtins: declaredBuiltins(def), acting, guarded, onActing: "allow" };
    case "ask":
    case "read-only":
    default:
      return { mode, permissionMode: base, allowedTools: preApproved(allow, acting, guarded), builtins: declaredBuiltins(def), acting, guarded, onActing: "card" };
  }
}

export function isMode(s: string): s is AgentMode {
  return (MODES as readonly string[]).includes(s);
}
