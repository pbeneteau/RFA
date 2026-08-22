/**
 * A missing argument on a terminal is a question, not a usage error (RFA-0.7
 * sect. 11.4): `rfa agent restart` with no name lists the packs, `rfa ask`
 * with no question asks for one. On a pipe, or under --yes/--json, the same
 * call is the usage error it always was, so scripts never block on a prompt.
 */
import { CliError, type CliContext } from "./context.js";

export interface Choice {
  value: string;
  label?: string;
  hint?: string;
}

async function prompts() {
  return import("@clack/prompts");
}

export async function pickOne(ctx: CliContext, message: string, choices: Choice[], usage: string): Promise<string> {
  if (!ctx.interactive) throw new CliError(2, usage);
  if (choices.length === 0) throw new CliError(2, `${usage}  (nothing to choose from)`);
  if (choices.length === 1) return choices[0].value;
  const p = await prompts();
  const v = await p.select({ message, options: choices.map((c) => ({ value: c.value, label: c.label ?? c.value, hint: c.hint })) });
  if (p.isCancel(v)) throw new CliError(2, "cancelled");
  return v as string;
}

export async function askLine(ctx: CliContext, message: string, usage: string, opts: { placeholder?: string; initialValue?: string } = {}): Promise<string> {
  if (!ctx.interactive) throw new CliError(2, usage);
  const p = await prompts();
  const v = await p.text({ message, placeholder: opts.placeholder, initialValue: opts.initialValue, validate: (s) => (s?.trim() ? undefined : "something is needed here") });
  if (p.isCancel(v)) throw new CliError(2, "cancelled");
  return String(v).trim();
}
