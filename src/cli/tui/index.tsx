/**
 * The front door (RFA-0.7 sect. 11): `rfa` with no arguments opens the
 * onboarding in a folder that is not a hub directory yet, and the dashboard in
 * one that is. Both are Ink apps; both hand the terminal to an ordinary `rfa`
 * command when asked, run as a child with the terminal inherited, and take it
 * back when the command is done. Nothing in here runs on a pipe: the caller
 * checks for a terminal first.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import type { HubDir } from "../../hubdir.js";
import { nodeArgsFor } from "../../proc.js";
import type { CliContext } from "../context.js";
import type { CommandDef } from "../router.js";
import { Dashboard } from "./dashboard.js";
import { Onboarding, type OnboardingResult } from "./onboarding.js";

export type RunChild = (argv: string[]) => Promise<number>;

/** The CLI entry beside this file, whichever form this installation runs (tsx on src/, node on dist/). */
function cliEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = /\.tsx?$/.test(here) ? ".ts" : ".js";
  return path.join(path.dirname(here), "..", `main${ext}`);
}

/**
 * Run an `rfa` command as a child with the terminal, then wait for a key so
 * the output can be read before the dashboard repaints. While the child runs,
 * ctrl-c belongs to it (an `rfa logs -f` ends that way) and not to us.
 */
export function makeChildRunner(opts: { pause?: boolean } = { pause: true }): RunChild {
  return async (argv) => {
    const entry = cliEntry();
    const swallow = () => {};
    process.on("SIGINT", swallow);
    process.stdout.write(`\x1b[2J\x1b[H$ rfa ${argv.join(" ")}\n\n`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [...nodeArgsFor(entry), ...argv], { stdio: "inherit", env: { ...process.env, RFA_FROM_DASHBOARD: "1" } });
      child.on("exit", (c, sig) => resolve(c ?? (sig ? 130 : 1)));
      child.on("error", () => resolve(1));
    });
    process.off("SIGINT", swallow);
    if (opts.pause !== false) await pressAnyKey(code === 0 ? "done. any key returns to the dashboard" : `exit ${code}. any key returns to the dashboard`);
    return code;
  };
}

export function pressAnyKey(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`\n\x1b[2m${prompt}\x1b[0m`);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.once("data", () => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      process.stdout.write("\n");
      resolve();
    });
  });
}

export async function runDashboard(ctx: CliContext, h: HubDir, deps: { commands: CommandDef[]; runChild: RunChild }): Promise<number> {
  const app = render(<Dashboard ctx={ctx} hub={h} commands={deps.commands} runChild={deps.runChild} />, { exitOnCtrlC: false, patchConsole: true });
  const result = (await app.waitUntilExit()) as { code?: number } | undefined;
  return result?.code ?? 0;
}

export async function runOnboarding(ctx: CliContext, deps: { target: string; existing: HubDir | null; flags: Record<string, string | boolean | undefined> }): Promise<number> {
  const app = render(<Onboarding ctx={ctx} target={deps.target} existing={deps.existing} flags={deps.flags} />, { exitOnCtrlC: false, patchConsole: true });
  const result = (await app.waitUntilExit()) as OnboardingResult | undefined;
  if (!result) return 2;
  if (result.code !== 0) return result.code;
  // The dashboard runs as its own `rfa dashboard`, in the directory just written.
  if (result.openDashboard && result.hub) return makeChildRunner({ pause: false })(["dashboard", "--dir", result.hub.root]);
  return 0;
}
