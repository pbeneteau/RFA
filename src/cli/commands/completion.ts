/**
 * Shell completion (RFA-0.7 sect. 11.3): `rfa completion zsh|bash|fish` prints
 * a few lines of shell that hand every tab press to the hidden `rfa __complete`,
 * so completion knows what the CLI knows: the groups, the commands, their
 * flags, and what is actually in this hub directory (agent names, room aliases,
 * bearer labels). `--install` writes the line into the shell's rc file.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listPacks } from "../../agentdef.js";
import { roomsStore, tokensStore } from "../../hubdir.js";
import { CliError } from "../context.js";
import { GLOBAL_OPTIONS, GROUPS, type CommandDef, type Router } from "../router.js";

const SHELLS = ["zsh", "bash", "fish"] as const;
type Shell = (typeof SHELLS)[number];

export function completionScript(shell: Shell): string {
  switch (shell) {
    case "zsh":
      return [
        "#compdef rfa",
        "_rfa() {",
        "  local -a completions",
        "  local IFS=$'\\n'",
        '  completions=($(rfa __complete -- "${words[@]:1}" 2>/dev/null))',
        "  _describe 'rfa' completions",
        "}",
        "compdef _rfa rfa",
        "",
      ].join("\n");
    case "bash":
      return [
        "_rfa_complete() {",
        '  local cur="${COMP_WORDS[COMP_CWORD]}"',
        '  local IFS=$\'\\n\'',
        '  COMPREPLY=($(compgen -W "$(rfa __complete -- "${COMP_WORDS[@]:1}" 2>/dev/null | cut -d: -f1)" -- "$cur"))',
        "}",
        "complete -F _rfa_complete rfa",
        "",
      ].join("\n");
    case "fish":
      return ["complete -c rfa -f -a '(rfa __complete --fish -- (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'", ""].join("\n");
  }
}

/** Where a shell keeps its rc, and the line that loads the completion. */
function installTarget(shell: Shell): { file: string; line: string; mode: "append" | "write" } {
  const home = os.homedir();
  switch (shell) {
    case "zsh":
      return { file: path.join(home, ".zshrc"), line: 'eval "$(rfa completion zsh)"', mode: "append" };
    case "bash":
      return { file: path.join(home, ".bashrc"), line: 'eval "$(rfa completion bash)"', mode: "append" };
    case "fish":
      return { file: path.join(home, ".config", "fish", "completions", "rfa.fish"), line: completionScript("fish"), mode: "write" };
  }
}

interface Candidate {
  value: string;
  description?: string;
}

/** The candidates for the word being typed, given the words before it. */
export function complete(router: Router, words: string[], opts: { packs?: string[]; rooms?: string[]; tokens?: string[] } = {}): Candidate[] {
  const commands = router.all().filter((c) => !c.hidden);
  const current = words[words.length - 1] ?? "";
  const before = words.slice(0, -1).filter((w) => !w.startsWith("-"));
  const isOption = current.startsWith("-");
  // 1. no command yet: groups (and single-word commands).
  const matched = commands.filter((c) => c.path.every((p, i) => before[i] === p));
  const exact = matched.filter((c) => c.path.length <= before.length).sort((a, b) => b.path.length - a.path.length)[0];
  if (!exact) {
    const level = before.length;
    if (level === 0) return GROUPS.map((g) => ({ value: g.name, description: g.summary }));
    const group = before[0];
    const subs = commands.filter((c) => c.path[0] === group && c.path.length === 2);
    if (subs.length) return subs.map((c) => ({ value: c.path[1], description: c.summary }));
    return [];
  }
  if (isOption) {
    const own = Object.entries(exact.options ?? {}).map(([k, o]) => ({ value: `--${k}`, description: o.type === "string" ? "<value>" : "" }));
    const globals = Object.keys(GLOBAL_OPTIONS).filter((k) => k !== "help").map((k) => ({ value: `--${k}` }));
    return [...own, ...globals];
  }
  // 2. positionals: what the hub directory actually holds, by command family.
  const head = exact.path.join(" ");
  const positional = before.length - exact.path.length; // how many positionals already given
  const previous = words[words.length - 2] ?? "";
  if (previous === "--room" || previous === "--kind" || previous === "--token") {
    if (previous === "--room") return (opts.rooms ?? []).map((value) => ({ value }));
    if (previous === "--kind") return ["answerer", "tool", "spec-expert"].map((value) => ({ value }));
    if (previous === "--token") return (opts.tokens ?? []).map((value) => ({ value }));
  }
  if (positional === 0) {
    if (/^agent (start|stop|restart|show|edit|retire|validate|bind)$|^knowledge (add|sync|pin)$|^logs$/.test(head)) return [...(opts.packs ?? []).map((value) => ({ value })), ...(head === "logs" ? [{ value: "hub" }, { value: "supervisor" }] : [])];
    if (/^room (show|tail|allow|disallow|policy|secret|evict|hold|release|quarantine|inject|end|adopt)$|^log verify$|^task (ls|create)$|^evals promote$/.test(head)) return (opts.rooms ?? []).map((value) => ({ value }));
    if (head === "completion") return SHELLS.map((value) => ({ value }));
    if (head === "docs") return ["interop", "spec", "platform", "plan", "readme", "client"].map((value) => ({ value }));
    if (head === "connect") return ["claude-code", "cursor", "mcp"].map((value) => ({ value }));
  }
  if (positional === 1 && /^agent bind$/.test(head)) return (opts.rooms ?? []).map((value) => ({ value }));
  return [];
}

export function completionCommands(router: Router): CommandDef[] {
  const completion: CommandDef = {
    path: ["completion"],
    summary: "Tab completion for zsh, bash or fish; --install writes it into your shell's rc",
    usage: "<zsh|bash|fish> [--install]",
    options: { install: { type: "boolean", default: false } },
    why: "The long commands were being forgotten. Completion is dynamic: it asks the CLI at every tab, so it offers the agent names and room aliases of THIS directory, not a list frozen at install time.",
    examples: ['eval "$(rfa completion zsh)"', "rfa completion zsh --install"],
    run: async (ctx, a) => {
      const shell = a.positionals[0] as Shell | undefined;
      if (!shell || !SHELLS.includes(shell)) throw new CliError(2, `rfa completion <${SHELLS.join("|")}>`);
      if (!a.values.install) return void process.stdout.write(completionScript(shell));
      const t = installTarget(shell);
      fs.mkdirSync(path.dirname(t.file), { recursive: true });
      if (t.mode === "write") fs.writeFileSync(t.file, t.line);
      else {
        const prev = fs.existsSync(t.file) ? fs.readFileSync(t.file, "utf8") : "";
        if (prev.includes(t.line)) return void ctx.ui.step(`${t.file} already loads rfa completion`);
        fs.appendFileSync(t.file, `${prev && !prev.endsWith("\n") ? "\n" : ""}\n# rfa: tab completion\n${t.line}\n`);
      }
      ctx.ui.done(`${shell} completion installed`, t.mode === "write" ? t.file : `${t.file}: ${t.line}`);
      ctx.ui.note(shell === "fish" ? "open a new shell" : `open a new shell, or run: ${t.line}`);
    },
  };
  const hidden: CommandDef = {
    path: ["__complete"],
    summary: "Completion candidates for the shell scripts",
    hidden: true,
    options: { fish: { type: "boolean", default: false } },
    run: async (ctx, a) => {
      const words = a.positionals;
      const h = ctx.maybe();
      const dyn = h
        ? {
            packs: safe(() => listPacks(h.paths.agents).map((p) => p.name)),
            rooms: safe(() => roomsStore(h).read().rooms.map((r) => r.alias)),
            tokens: safe(() => tokensStore(h).read().tokens.map((t) => t.label)),
          }
        : {};
      const out = complete(router, words, dyn);
      const sep = a.values.fish ? "\t" : ":";
      process.stdout.write(out.map((c) => (c.description ? `${c.value}${sep}${c.description}` : c.value)).join("\n") + (out.length ? "\n" : ""));
    },
  };
  return [completion, hidden];
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
