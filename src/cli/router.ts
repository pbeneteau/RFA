/**
 * The command tree (RFA-0.7 Appendix D): `rfa <verb>` and `rfa <group> <verb>`,
 * each command a definition the help is generated from, so the help can never
 * describe a command that does not exist.
 */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { CliContext } from "./context.js";

export interface Parsed {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export interface CommandDef {
  /** `["up"]` or `["agent", "new"]`. */
  path: string[];
  /** One line, shown in the group listing. */
  summary: string;
  /** The paragraph under `--help`: why the command exists, in the project's voice. */
  why?: string;
  /** The synopsis after the command name: `<name> [--kind answerer|tool]`. */
  usage?: string;
  options?: ParseArgsOptionsConfig;
  examples?: string[];
  /** Not listed; still runs. */
  hidden?: boolean;
  run: (ctx: CliContext, args: Parsed) => Promise<number | void>;
}

export const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  dir: { type: "string" },
  json: { type: "boolean", default: false },
  yes: { type: "boolean", short: "y", default: false },
  quiet: { type: "boolean", short: "q", default: false },
  color: { type: "boolean" },
  debug: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

export const GROUPS: { name: string; summary: string }[] = [
  { name: "init", summary: "Create a hub directory here, interactively or from flags" },
  { name: "dashboard", summary: "The live dashboard: what rfa alone opens in a hub directory" },
  { name: "up", summary: "Start the hub and the supervisor as daemons" },
  { name: "down", summary: "Stop them" },
  { name: "restart", summary: "Stop, then start" },
  { name: "status", summary: "What is running: hub, supervisor, agents, rooms" },
  { name: "doctor", summary: "Every check the findings ledger paid for, with the fix named" },
  { name: "logs", summary: "Tail the hub, the supervisor or an agent" },
  { name: "console", summary: "Open the live room view in the browser" },
  { name: "ask", summary: "Ask an agent by capability, as a human principal" },
  { name: "hub", summary: "The hub process: run in the foreground, expose it" },
  { name: "supervisor", summary: "The supervisor process, in the foreground" },
  { name: "agent", summary: "Packs: new, ls, show, validate, bind, start, stop, restart, mode, edit, reflect, retire" },
  { name: "room", summary: "Rooms: create, ls, show, tail, allow, policy, secret, evict, end, adopt" },
  { name: "task", summary: "The task board of a room" },
  { name: "approvals", summary: "Pending approval cards and their decision" },
  { name: "human", summary: "Human principals: the only thing that can approve" },
  { name: "token", summary: "Transport bearers: what reaches /mcp at all" },
  { name: "secrets", summary: "Values by name, for packs that declare them" },
  { name: "key", summary: "Signing keys and signed cards" },
  { name: "connect", summary: "Let an MCP host (Claude Code, Cursor) talk to this hub" },
  { name: "peer", summary: "Agents running elsewhere" },
  { name: "knowledge", summary: "What an agent answers from: paths and tracked clones" },
  { name: "evals", summary: "The eval gate, the flywheel, the labelling sitting, parity" },
  { name: "log", summary: "Verify the hash chain of a room log, offline" },
  { name: "backup", summary: "Now, list, restore" },
  { name: "config", summary: "rfa.json, through the schema" },
  { name: "service", summary: "Boot persistence: launchd or systemd" },
  { name: "migrate", summary: "Move a pre-0.7 checkout into a hub directory" },
  { name: "demo", summary: "The spec's worked example, in memory, in ten seconds" },
  { name: "docs", summary: "The interop guide, the specs and the README shipped in the package" },
  { name: "version", summary: "Tool, manifest and protocol versions" },
  { name: "completion", summary: "Tab completion for zsh, bash or fish" },
];

export class UsageError extends Error {
  constructor(
    message: string,
    readonly usage?: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

export class Router {
  private readonly commands: CommandDef[] = [];

  register(...defs: CommandDef[]): void {
    this.commands.push(...defs);
  }

  list(): readonly CommandDef[] {
    return this.commands;
  }

  /** Every registered command, hidden ones included; the palette, completion and did-you-mean read it. */
  all(): CommandDef[] {
    return this.commands;
  }

  /**
   * The command words: the first one or two bare tokens, skipping the global
   * options and their values (`rfa --dir x agent new foo` is `agent new`). The
   * scan stops at the first option it does not know, because a command's own
   * options always come after the command.
   */
  static commandWords(argv: readonly string[]): string[] {
    const words: string[] = [];
    for (let i = 0; i < argv.length && words.length < 2; i++) {
      const a = argv[i];
      if (a === "--") break;
      if (a.startsWith("--")) {
        const name = a.slice(2).split("=")[0].replace(/^no-/, "");
        const opt = GLOBAL_OPTIONS[name];
        if (!opt) break;
        if (opt.type === "string" && !a.includes("=")) i++;
        continue;
      }
      if (a.startsWith("-")) continue;
      words.push(a);
    }
    return words;
  }

  /** The longest registered path that prefixes the command words: `agent new` before `agent`. */
  find(argv: readonly string[]): { def: CommandDef; rest: string[] } | null {
    const words = Router.commandWords(argv);
    for (const len of [2, 1]) {
      const head = words.slice(0, len);
      const def = this.commands.find((c) => c.path.length === len && c.path.every((p, i) => p === head[i]));
      if (def) {
        // Drop exactly the matched words from argv, leaving flags where they were.
        const rest: string[] = [];
        let remaining = [...def.path];
        for (const a of argv) {
          if (remaining.length && !a.startsWith("-") && a === remaining[0]) {
            remaining = remaining.slice(1);
            continue;
          }
          rest.push(a);
        }
        return { def, rest };
      }
    }
    return null;
  }

  parse(def: CommandDef, argv: readonly string[]): Parsed {
    const options: ParseArgsOptionsConfig = { ...GLOBAL_OPTIONS, ...(def.options ?? {}) };
    try {
      const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true, allowNegative: true, strict: true });
      return { values: values as Parsed["values"], positionals };
    } catch (err) {
      // Non-greedy on purpose: Node's message continues after the quoted option
      // (". To specify a positional argument…"), and a greedy capture swallowed
      // it into the flag name.
      throw new UsageError((err as Error).message.replace(/^Unknown option '([^']+)'[\s\S]*$/, "unknown option $1"), this.usageOf(def));
    }
  }

  usageOf(def: CommandDef): string {
    return `rfa ${def.path.join(" ")}${def.usage ? ` ${def.usage}` : ""}`;
  }

  /** `rfa` alone: the groups. `rfa <group>`: that group's commands. `rfa <cmd> --help`: the command. */
  help(words: string[] = []): string {
    const out: string[] = [];
    if (words.length === 0) {
      out.push("rfa: Rooms for Agents. A hub directory is any folder holding rfa.json; every command finds it like git finds a repository.", "");
      out.push("Commands:");
      const width = Math.max(...GROUPS.map((g) => g.name.length));
      for (const g of GROUPS) out.push(`  ${g.name.padEnd(width)}  ${g.summary}`);
      out.push("", "Global flags: --dir <hub directory>  --json  --yes  --quiet  --no-color  --debug  --help", "rfa <command> --help shows a command's flags and why it exists.");
      return out.join("\n");
    }
    const group = words[0];
    const members = this.commands.filter((c) => c.path[0] === group && !c.hidden);
    if (members.length === 0) return `rfa: no such command \`${words.join(" ")}\`. \`rfa --help\` lists them.`;
    if (words.length === 1 && members.some((c) => c.path.length === 2)) {
      const g = GROUPS.find((x) => x.name === group);
      out.push(`rfa ${group}: ${g?.summary ?? ""}`, "");
      const width = Math.max(...members.map((c) => c.path.join(" ").length));
      for (const c of members) out.push(`  rfa ${c.path.join(" ").padEnd(width)}  ${c.summary}`);
      return out.join("\n");
    }
    const def = members.find((c) => c.path.join(" ") === words.join(" ")) ?? members[0];
    out.push(this.usageOf(def), "", `  ${def.summary}`);
    if (def.why) out.push("", ...wrap(def.why, 96).map((l) => `  ${l}`));
    const opts = Object.entries(def.options ?? {});
    if (opts.length) {
      out.push("", "Flags:");
      const width = Math.max(...opts.map(([k]) => k.length));
      for (const [k, o] of opts) out.push(`  --${k.padEnd(width)}  ${o.type === "string" ? "<value>" : ""}${(o as { help?: string }).help ? `  ${(o as { help?: string }).help}` : ""}`.replace(/\s+$/, ""));
    }
    if (def.examples?.length) out.push("", "Examples:", ...def.examples.map((e) => `  ${e}`));
    return out.join("\n");
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if ((line + " " + word).trim().length > width) {
        out.push(line.trim());
        line = word;
      } else line = `${line} ${word}`;
    }
    if (line.trim()) out.push(line.trim());
  }
  return out;
}
