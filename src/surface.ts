/**
 * What a pack's declaration actually reaches, rendered for a person (RFA-0.9
 * sects. 3.5, 5.2, 5.3, 7.2, 10.1).
 *
 * One module, because `rfa agent show` and `rfa doctor` must not disagree about
 * this and each rendering copied per command is how the copies drift. Every line
 * it produces names the thing it is talking about and says whether that thing is
 * confined, because the failure this whole document is about is a control that
 * reads as wider than it is.
 *
 * It reads the DEFINITION on disk. A resident's `state/member.json` records no
 * tool surface, no posture and no fence state, so there is no running record to
 * compare against; every caller says "from disk" rather than presenting it as
 * what is being served (CLAUDE.md's configured-versus-happening rule, answered
 * by naming the source when there is only one). `rfa doctor`, `rfa agent show`
 * and `rfa status` each carry that attribution; if a fourth renderer appears
 * without it, this sentence is the one that has gone stale.
 */
import { NETWORK_SCOPE_NOTE, postureView } from "./egress.js";
import { CLASS_NOTE, declaredOfClass, reachableToolSurface, toolCountWarning } from "./toolclass.js";

export interface UnconfinedSurface {
  kind: "read" | "reach" | "mcp-server" | "mcp-confined" | "platform-tool" | "subagent";
  what: string;
  why: string;
}

/**
 * Every unconfined surface this pack holds, named (sects. 3.5, 5.2, 5.3).
 *
 * "Unconfined" here means precisely: no door of the fence covers it, and no
 * value of `sandbox.network` describes it. Each entry says which of those it is,
 * because "unconfined" without the mechanism is the vague warning an operator
 * learns to skip.
 */
export function unconfinedSurfaces(def: {
  tools?: { allow?: string[]; allow_subagents?: boolean };
  mcp_servers?: Record<string, unknown>;
}): UnconfinedSurface[] {
  const out: UnconfinedSurface[] = [];
  const read = declaredOfClass(def.tools?.allow, "read");
  if (read.length > 0) {
    out.push({
      kind: "read",
      what: read.join(", "),
      why:
        `${CLASS_NOTE.read}. These are pre-approved as bare allowedTools entries, and a read INSIDE the working directory never reaches canUseTool at all (measured), ` +
        `so what the pack can read is decided entirely by where sandbox.cwd points - which RFA-0.9 sect. 3.4b constrains to the pack's own directory. ` +
        `Narrowing it is not specified: Appendix A parks it, because routing every read of every turn through door one costs more than the threat today`,
    });
  }
  const reach = declaredOfClass(def.tools?.allow, "reach");
  if (reach.length > 0) {
    out.push({ kind: "reach", what: reach.join(", "), why: CLASS_NOTE.reach });
  }
  /**
   * Sect. 5.4, after rung 8: a server this platform SPAWNS is now wrapped in its
   * own OS sandbox per its own declaration, so it is no longer an unconfined
   * surface and is not listed as one. The `url` form is: that process is not
   * ours to spawn, and naming that residual surface is what keeps sect. 5.2's
   * rendering true now that its siblings are confined.
   *
   * What stays unconfined even for a wrapped server, and is said rather than
   * implied: the ARGUMENTS of the tools the pack declared. Door one refuses
   * every MCP tool the pack did not name, and refuses nothing about what a named
   * one is asked to do.
   */
  for (const [name, cfg] of Object.entries(def.mcp_servers ?? {})) {
    const o = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
    if (!("url" in o)) continue;
    out.push({
      kind: "mcp-server",
      what: `mcp_servers.${name} (url form)`,
      why:
        `the RESIDUAL surface rung 8 could not cover (RFA-0.9 sect. 5.4): confinement means wrapping the spawn, and this server's process is not ours to spawn. It runs wherever it runs, ` +
        `with whatever reach it has. What confines it is exactly two things: which of its tools the pack declared, and which credentials the supervisor injects. Its filesystem reach, its ` +
        `network reach, and the arguments of the tools the pack DID declare are unconfined by this platform. Only a stdio server was probed (Appendix B item 2), so this is stated for what it claims: no confinement at all`,
    });
  }
  for (const [name, cfg] of Object.entries(def.mcp_servers ?? {})) {
    const o = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
    if ("url" in o) continue;
    const sb = o.sandbox as { network?: string; allowed_domains?: string[]; allow_write?: string[] } | undefined;
    out.push({
      kind: "mcp-confined",
      what: `mcp_servers.${name} (${"builtin" in o ? "builtin" : "command"} form)`,
      why:
        `CONFINED at the spawn seam (RFA-0.9 sect. 5.4): this platform spawns it through the launcher, which establishes its own OS sandbox before exec - ` +
        `network ${sb?.network ?? "(undeclared: the definition is refused)"}${sb?.network === "allowlist" ? ` over ${(sb.allowed_domains ?? []).join(", ")}` : ""}, ` +
        `writes limited to ${(sb?.allow_write ?? []).join(", ") || "nothing beyond the sandbox defaults"}. Still unconfined, and said rather than implied: the ARGUMENTS of the tools the pack declared`,
    });
  }
  out.push({
    kind: "platform-tool",
    what: "mcp__rfa__*, mcp__memory__* (injected on every resident query)",
    why:
      `the platform registers these whether the pack asked or not (RFA-0.9 sect. 5.2). \`mcp__rfa__ask\`, where a pack declares it, sends model-authored text to another room member, ` +
      `and its candidate filter is keyed on \`role\` and not on \`home\`, so such a pack has a voice that reaches other organizations by design`,
  });
  if (def.tools?.allow_subagents) {
    out.push({
      kind: "subagent",
      what: "tools.allow_subagents: true",
      why:
        `whether a subagent child inherits the parent query's sandbox and tools is established by \`npm run egress-proof\` on THIS host and this SDK, and by nothing else ` +
        `(RFA-0.9 sect. 3.1, Appendix B item 8). Until that proof has been run here, treat this pack's child runs as unproven`,
    });
  }
  return out;
}

export interface SurfaceReport {
  posture: ReturnType<typeof postureView>;
  surfaces: UnconfinedSurface[];
  tools: ReturnType<typeof reachableToolSurface>;
  toolWarning: string | null;
  /** Sect. 4.1: the scope sentence, so a caller cannot render the posture without it. */
  scope: string;
}

export function surfaceReport(def: Parameters<typeof unconfinedSurfaces>[0] & Parameters<typeof postureView>[0]): SurfaceReport {
  return {
    posture: postureView(def),
    surfaces: unconfinedSurfaces(def),
    tools: reachableToolSurface(def),
    toolWarning: toolCountWarning(def),
    scope: NETWORK_SCOPE_NOTE,
  };
}
