/**
 * The classification of every built-in this platform is willing to pre-approve
 * (RFA-0.9 sect. 3.1), and the two things that hang off it: what a pack may
 * legally name in `tools.allow` (3.2), and which packs the fence covers (3.3).
 *
 * It exists because the fence's coverage predicate was `hasWriteSurface()` - a
 * pack declaring `Write`, `Edit` or `NotebookEdit` - which is correct for the
 * property RFA-0.8 sect. 9 protects and too narrow for egress. A pack declaring
 * `Bash` and none of those got NO OS sandbox, and its `Bash` sits pre-approved
 * in `allowedTools`, so it never reached door one either: it had no egress
 * decision at all, not even the accidental one E10b measured (sect. 1.1
 * finding 3).
 *
 * Matching is on the tool HEAD, the substring before the first `(`, so a
 * specifier form (`Bash(git:*)`, `Task(explore)`) classifies with its base tool
 * exactly as `toolsSchema`'s existing `entry.split("(")[0]` already does.
 *
 * The table MUST be maintained across SDK bumps, and Appendix B item 5 records
 * that this is a real cost: it will refuse a pack that works today by naming a
 * built-in the table does not list yet. That is the intended direction of
 * failure. The alternative is a future SDK built-in that executes processes or
 * reaches the network entering a pack's pre-approved set by being unclassified.
 */

/**
 * The write-shaped built-ins this SDK offers (`sdk-tools.d.ts` on 0.3.233:
 * FileWriteInput, FileEditInput, NotebookEditInput; there is no MultiEdit).
 *
 * Declared here rather than in `src/writefence.ts` so that the class table below
 * cannot disagree with it; the fence re-exports it, and a test asserts every
 * member classifies as `guarded`.
 */
export const GUARDED_BUILTINS = ["Write", "Edit", "NotebookEdit"] as const;
export type GuardedBuiltin = (typeof GUARDED_BUILTINS)[number];

export type ToolClass = "guarded" | "command" | "reach" | "read" | "subagent";

/**
 * What each class can do, and which door answers for it. The prose is here
 * because every renderer (`rfa agent show`, `rfa doctor`, the definition
 * refusal) needs the same sentence and a copy per renderer is how copies drift.
 */
export const CLASS_NOTE: Record<ToolClass, string> = {
  guarded: "writes to a path nameable in its arguments; door one's per-run path guard holds it, and it is kept out of allowedTools so the call falls through to the callback (RFA-0.8 sect. 9)",
  command: "executes a process, whose effects cannot be traced from its arguments; door two, the OS sandbox, is its ONLY door, and a pack declaring one is fenced for that reason (RFA-0.9 sect. 3.3)",
  reach: "network I/O inside the SDK's own process, which the sandbox's network settings explicitly carve out: NEITHER door covers it (RFA-0.9 sect. 5.3)",
  read: "unconfined read across the resident process's whole filesystem view, not merely the session surface; pre-approved, and a read inside the working directory never reaches the callback at all (RFA-0.9 sect. 3.5)",
  subagent: "spawns a child run; pre-approvable only with tools.allow_subagents: true (wire 18.7). Whether a child inherits the parent query's sandbox and tools is UNMEASURED (RFA-0.9 Appendix B item 8)",
};

/** The table itself (sect. 3.1). Anything not in it is refused by 3.2, never pre-approved. */
export const BUILTIN_CLASSES: Readonly<Record<string, ToolClass>> = {
  ...(Object.fromEntries(GUARDED_BUILTINS.map((t) => [t, "guarded" as const])) as Record<GuardedBuiltin, "guarded">),
  Bash: "command",
  WebFetch: "reach",
  WebSearch: "reach",
  Read: "read",
  Grep: "read",
  Glob: "read",
  Agent: "subagent",
  Task: "subagent",
};

/** The MCP servers this platform injects into every resident query (sect. 5.2). */
export const PLATFORM_MCP_SERVERS = ["rfa", "memory"] as const;

/** The substring before the first `(`: `Bash(git:*)` classifies as `Bash`. */
export function toolHead(entry: string): string {
  return entry.split("(")[0].trim();
}

/** This entry's class, or null when it is not a classified built-in (an MCP name included). */
export function classifyBuiltin(entry: string): ToolClass | null {
  return BUILTIN_CLASSES[toolHead(entry)] ?? null;
}

/** Every built-in of one class this pack declares, in declaration order, deduplicated by head. */
export function declaredOfClass(allow: readonly string[] | undefined, cls: ToolClass): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of allow ?? []) {
    const head = toolHead(entry);
    if (classifyBuiltin(entry) !== cls || seen.has(head)) continue;
    seen.add(head);
    out.push(head);
  }
  return out;
}

/**
 * THE COVERAGE PREDICATE (sect. 3.3), replacing `hasWriteSurface()` wherever the
 * question is "is this run fenced".
 *
 * A pack of class `command` gets door two with the same filesystem policy a
 * writing pack gets (sect. 3.4): `allowWrite` is this run's `scratch/<runId>`,
 * the run's working directory is that scratch surface, `allowUnsandboxedCommands`
 * is false. It does not get door one's path guard, because it declares nothing
 * door one can guard.
 */
export function fenceApplies(def: { tools?: { allow?: string[] } }): boolean {
  const allow = def.tools?.allow;
  return declaredOfClass(allow, "guarded").length > 0 || declaredOfClass(allow, "command").length > 0;
}

/** Which classes this pack's declaration puts it in, for a renderer that has to name them. */
export function declaredClasses(def: { tools?: { allow?: string[] } }): ToolClass[] {
  const allow = def.tools?.allow;
  return (Object.keys(CLASS_NOTE) as ToolClass[]).filter((c) => declaredOfClass(allow, c).length > 0);
}

/**
 * Is this an `mcp__<server>__<tool>` name for a server this pack can actually
 * reach?
 *
 * The split is done against the KNOWN server names rather than by a regex on
 * underscores, and that is not fussiness: a server name may contain `__` itself
 * (`memory__str_replace` is a real tool id whose server is `memory`), so a
 * greedy or lazy pattern picks a different boundary depending on which way it
 * leans and is wrong either way. Asking "does any declared server prefix this"
 * has exactly one answer, and it fails closed for an undeclared one.
 */
export function mcpToolServer(entry: string, servers: readonly string[]): string | null {
  for (const s of servers) {
    const prefix = `mcp__${s}__`;
    if (entry.startsWith(prefix) && entry.length > prefix.length) return s;
  }
  return null;
}

/**
 * Sect. 3.2: every `tools.allow` entry whose head is neither a classified
 * built-in nor an `mcp__<server>__<tool>` name for a declared or platform-owned
 * server, plus the entries that are not names at all.
 *
 * Refusing is the fail-closed reading. Today an arbitrary string, an empty
 * string, a duplicate, and an `mcp__` name for an undeclared server all parse
 * and land verbatim in the SDK's base tool set.
 */
export function toolsAllowFailures(def: { tools?: { allow?: string[] }; mcp_servers?: Record<string, unknown> }): string[] {
  const allow = def.tools?.allow;
  if (!allow) return [];
  const servers = [...PLATFORM_MCP_SERVERS, ...Object.keys(def.mcp_servers ?? {})];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of allow) {
    if (typeof entry !== "string" || entry.trim() === "") {
      out.push("an empty entry: it lands verbatim in the SDK's base tool set and names nothing");
      continue;
    }
    if (seen.has(entry)) {
      out.push(`\`${entry}\` is listed twice; one declaration is the declaration`);
      continue;
    }
    seen.add(entry);
    if (entry.startsWith("mcp__")) {
      if (mcpToolServer(entry, servers) === null) {
        out.push(
          `\`${entry}\` names an MCP server this pack does not declare. Declared: ${servers.map((s) => `\`${s}\``).join(", ")} ` +
            `(\`rfa\` and \`memory\` are the platform's own, sect. 5.2). Add the server under \`mcp_servers\`, or fix the name`,
        );
      }
      continue;
    }
    if (classifyBuiltin(entry) === null) {
      out.push(
        `\`${entry}\` is not a classified built-in. The grammar is \`<Builtin>\`, \`<Builtin>(<specifier>)\` or \`mcp__<server>__<tool>\`, and the classified built-ins are ` +
          `${Object.keys(BUILTIN_CLASSES).join(", ")} (RFA-0.9 sect. 3.1). A name the table does not list is refused rather than pre-approved, so a future SDK built-in that ` +
          `executes processes or reaches the network cannot enter a pack's surface by being unclassified; if the SDK has gained one, add it to the table with its class`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- the declared surface (RFA-0.9 sect. 7)

/**
 * The MCP tools this platform INJECTS into every resident query (sect. 5.2), for
 * this pack.
 *
 * They are part of the pack's reachable surface and nobody had ever counted
 * them: `mcp__rfa__ask` in particular sends model-authored text to another room
 * member, and its candidate filter is keyed on `role`, not on `home`, so a pack
 * that declares it has a voice that reaches other organizations by design.
 *
 * The two destructive memory verbs are conditional on the pack NAMING them
 * (RFA-0.8 sect. 4 item 2), which is why this takes the definition rather than
 * being a constant.
 */
export function platformInjectedTools(def: { tools?: { allow?: string[] } }): string[] {
  const declared = new Set((def.tools?.allow ?? []).filter((t) => t.startsWith("mcp__memory__")));
  return [
    "mcp__rfa__roster",
    "mcp__rfa__task_read",
    "mcp__memory__view",
    "mcp__memory__create",
    "mcp__memory__str_replace",
    "mcp__memory__insert",
    ...(declared.has("mcp__memory__delete") ? ["mcp__memory__delete"] : []),
    ...(declared.has("mcp__memory__rename") ? ["mcp__memory__rename"] : []),
  ];
}

export interface ToolSurface {
  /** Built-ins the pack declared, by head. */
  builtins: string[];
  /** MCP tools the pack declared, verbatim. */
  mcp: string[];
  /** MCP tools the platform injects whether the pack asked or not (sect. 5.2). */
  platform: string[];
  /** Every distinct tool the model can actually reach. */
  all: string[];
  total: number;
}

/**
 * ONE function for a pack's TOTAL reachable tool surface (sect. 7.1).
 *
 * No such function existed, which is why no check could be written against the
 * total: `posture.builtins` answered about built-ins, `allowedTools` answered
 * about pre-approval, and the platform's own injected servers were counted
 * nowhere. Deduplicated across the three sources, because a pack that also
 * declares an injected memory verb reaches one tool, not two.
 */
export function reachableToolSurface(def: { tools?: { allow?: string[] } }): ToolSurface {
  const allow = def.tools?.allow ?? [];
  const builtins: string[] = [];
  const mcp: string[] = [];
  for (const entry of allow) {
    if (entry.startsWith("mcp__")) {
      if (!mcp.includes(entry)) mcp.push(entry);
    } else {
      const head = toolHead(entry);
      if (!builtins.includes(head)) builtins.push(head);
    }
  }
  const platform = platformInjectedTools(def).filter((t) => !mcp.includes(t));
  return { builtins, mcp, platform, all: [...builtins, ...mcp, ...platform], total: builtins.length + mcp.length + platform.length };
}

/**
 * Sect. 7.2's threshold. A WARNING and never a refusal, and the text says whose
 * number it is: W6 sect. 2.6 is a vendor observation reported in a landscape
 * survey, not a measurement made here, and a threshold that refuses on someone
 * else's number will be wrong loudly.
 */
export const TOOL_COUNT_THRESHOLD = 25;

export function toolCountWarning(def: { tools?: { allow?: string[] } }): string | null {
  const surface = reachableToolSurface(def);
  if (surface.total <= TOOL_COUNT_THRESHOLD) return null;
  return (
    `this pack can reach ${surface.total} tools (${surface.builtins.length} built-in, ${surface.mcp.length} declared MCP, ${surface.platform.length} injected by the platform), ` +
    `above the ${TOOL_COUNT_THRESHOLD}-tool threshold at which a vendor reports accuracy degrading (RFA-0.9 sect. 7.2, citing W6 sect. 2.6). ` +
    `That number is someone else's observation and not a measurement made here, so this is a warning and never a refusal.`
  );
}
