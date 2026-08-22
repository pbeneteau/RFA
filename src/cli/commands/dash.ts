/**
 * `rfa dashboard` (alias `rfa ui`): the screen `rfa` alone opens in a hub
 * directory, as a command, for the operator who types it on purpose and for a
 * shell alias. Needs a terminal; scripts get `rfa status --json`.
 */
import { CliError } from "../context.js";
import type { CommandDef, Router } from "../router.js";

export function dashboardCommands(router: Router): CommandDef[] {
  const run: CommandDef["run"] = async (ctx) => {
    if (!ctx.ui.opts.tty || ctx.flags.json) throw new CliError(2, "the dashboard needs a terminal", "rfa status --json is the same data for a script");
    const h = ctx.hubdir();
    const { makeChildRunner, runDashboard } = await import("../tui/index.js");
    return runDashboard(ctx, h, { commands: router.all(), runChild: makeChildRunner() });
  };
  return [
    { path: ["dashboard"], summary: "The live dashboard: what `rfa` alone opens in a hub directory", why: "Five tabs over the same data every command prints, single-key verbs that run the same code the commands run, and a palette that shows the command line before running it. It exists because the long forms were being forgotten; it teaches them while doing the work.", run },
    { path: ["ui"], summary: "Alias of rfa dashboard", hidden: true, run },
  ];
}
