#!/usr/bin/env node
/**
 * `rfa`: the operator CLI (RFA-0.7). Parse, find the command, resolve the hub
 * directory lazily, run, and turn every failure into one line of cause and one
 * of fix with the exit code a script can act on.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { detectLegacyLayout, HubDirError } from "../hubdir.js";
import { CliContext, CliError } from "./context.js";
import { GLOBAL_OPTIONS, GROUPS, Router, UsageError } from "./router.js";
import { suggestCommands } from "./suggest.js";
import { Ui } from "./ui.js";
import { agentBind, agentEdit, agentLs, agentMode, agentNew, agentReflect, agentRestart, agentRetire, agentShow, agentStart, agentStop, agentValidate } from "./commands/agent.js";
import { connectClaude, connectCursor, connectMcp, hubExpose, peerAdd, peerLs, peerRevoke, peerShow } from "./commands/connect.js";
import { configGet, configSet, configShow, humanAdd, humanLs, humanRemove, humanRotate, keyNew, keySign, secretsLs, secretsSet, secretsUnset, tokenLs, tokenMint, tokenRevoke } from "./commands/creds.js";
import { doctor } from "./commands/doctor.js";
import { completionCommands } from "./commands/completion.js";
import { dashboardCommands } from "./commands/dash.js";
import { init } from "./commands/init.js";
import { evalsFlag, evalsLabel, evalsLs, evalsParity, evalsPromote, evalsRun, knowledgeAdd, knowledgePin, knowledgeStatusCmd, knowledgeSync, logVerify } from "./commands/instruments.js";
import { demo, docs, migrate, version } from "./commands/misc.js";
import { backupLs, backupNow, backupRestore, serviceInstall, serviceStatus, serviceUninstall } from "./commands/ops.js";
import { consoleCmd, down, hubRun, logs, restart, status, supervisorRun, up } from "./commands/procs.js";
import { roomAdopt, roomAllow, roomCreate, roomDisallow, roomEnd, roomEvict, roomHold, roomInject, roomLs, roomPolicy, roomQuarantine, roomRelease, roomSecret, roomShow, roomTail } from "./commands/room.js";
import { server } from "./commands/server.js";
import { approvalsApprove, approvalsLs, approvalsReject, approvalsShow, ask, taskCancel, taskCreate, taskLs, taskShow, taskVerify } from "./commands/talk.js";

process.title = "rfa";
// `rfa status | head` closes our stdout early; that is the reader's business, not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
}

const router = new Router();
router.register(
  init, up, down, restart, status, doctor, logs, consoleCmd, hubRun, supervisorRun, migrate, demo, docs, version,
  agentNew, agentLs, agentShow, agentValidate, agentBind, agentStart, agentStop, agentRestart, agentEdit, agentMode, agentReflect, agentRetire,
  roomCreate, roomLs, roomShow, roomTail, roomAllow, roomDisallow, roomPolicy, roomSecret, roomEvict, roomHold, roomRelease, roomQuarantine, roomInject, roomEnd, roomAdopt,
  ask, taskLs, taskShow, taskCreate, taskCancel, taskVerify, approvalsLs, approvalsShow, approvalsApprove, approvalsReject,
  humanAdd, humanLs, humanRotate, humanRemove, tokenMint, tokenLs, tokenRevoke, secretsSet, secretsLs, secretsUnset, configShow, configGet, configSet, keyNew, keySign,
  connectClaude, connectCursor, connectMcp, peerAdd, peerLs, peerShow, peerRevoke, hubExpose,
  knowledgeAdd, knowledgeSync, knowledgeStatusCmd, knowledgePin, evalsRun, evalsLs, evalsPromote, evalsLabel, evalsFlag, evalsParity, logVerify,
  backupNow, backupLs, backupRestore, serviceInstall, serviceUninstall, serviceStatus,
  server,
);
router.register(...dashboardCommands(router), ...completionCommands(router));

async function main(argv: string[]): Promise<number> {
  // Global flags first, leniently, so `rfa --dir x status --json` and
  // `rfa status --json --dir x` both work before any command is known.
  let globals: { values: Record<string, unknown> };
  try {
    globals = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true, allowNegative: true, strict: false });
  } catch {
    globals = { values: {} };
  }
  const g = globals.values as { dir?: string; json?: boolean; yes?: boolean; quiet?: boolean; color?: boolean; debug?: boolean; help?: boolean };
  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const color = g.color === false ? false : g.color === true ? true : tty && !process.env.NO_COLOR && !g.json;
  const ui = new Ui({ color, json: Boolean(g.json), quiet: Boolean(g.quiet), tty });
  const ctx = new CliContext({ dir: g.dir, json: Boolean(g.json), yes: Boolean(g.yes), quiet: Boolean(g.quiet), debug: Boolean(g.debug) }, ui);

  const found = router.find(argv);
  const words = Router.commandWords(argv);
  if (!found) {
    // The front door (RFA-0.7 sect. 11): `rfa` alone on a terminal opens the
    // onboarding where there is no hub directory and the dashboard where there
    // is one. On a pipe, or with --json, it stays the help it always was.
    if (argv.length === 0 && tty && !g.json && !g.quiet) return frontDoor(ctx);
    if (argv.length === 0 || g.help || words.length === 0) {
      // `rfa agent --help` lists the group's commands; bare `rfa` lists the groups.
      process.stdout.write(router.help(words.slice(0, 2)) + "\n");
      return argv.length === 0 || g.help ? 0 : 2;
    }
    if (words.length === 1 && GROUPS.some((x) => x.name === words[0])) {
      // `rfa agent` names a group, not a command: the group's own listing is
      // the answer (the same text `rfa agent --help` prints), never a guess at
      // a typo. Exit 2 because nothing ran; --help is the exit-0 form.
      process.stdout.write(router.help(words) + "\n");
      return 2;
    }
    const guesses = suggestCommands(words, router.all());
    if (guesses.length) {
      ui.fail(`no such command: rfa ${words.join(" ")}`, `did you mean: ${guesses.map((g) => `rfa ${g}`).join("  ·  ")}`);
      process.stderr.write(`   rfa --help lists everything; rfa alone opens the dashboard\n`);
      return 2;
    }
    process.stderr.write(router.help(GROUPS.some((x) => x.name === words[0]) ? words.slice(0, 1) : words.slice(0, 2)) + "\n");
    return 2;
  }
  if (g.help) {
    process.stdout.write(router.help(found.def.path) + "\n");
    return 0;
  }
  try {
    const parsed = router.parse(found.def, found.rest);
    const code = await found.def.run(ctx, parsed);
    return code ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      ui.fail(err.message, err.usage ? `usage: ${err.usage}` : undefined);
      if (ctx.flags.json) ui.json({ error: err.message, usage: err.usage ?? null, exit: 2 });
      return 2;
    }
    if (err instanceof CliError) {
      ui.fail(err.message, err.hint);
      if (ctx.flags.json) ui.json({ error: err.message, hint: err.hint ?? null, exit: err.exitCode });
      return err.exitCode;
    }
    if (err instanceof HubDirError) {
      ui.fail(err.message, err.hint);
      if (ctx.flags.json) ui.json({ error: err.message, hint: err.hint ?? null, exit: 3 });
      return 3;
    }
    const e = err as Error & { code?: string; hint?: string };
    ui.fail(e.message ?? String(err), e.hint);
    if (ctx.flags.debug && e.stack) process.stderr.write(e.stack + "\n");
    if (ctx.flags.json) ui.json({ error: e.message ?? String(err), exit: 1 });
    return 1;
  }
}

/** `rfa` with nothing after it, on a terminal. */
async function frontDoor(ctx: CliContext): Promise<number> {
  const { makeChildRunner, runDashboard, runOnboarding } = await import("./tui/index.js");
  let h = null;
  try {
    h = ctx.maybe();
  } catch (err) {
    if (err instanceof CliError || err instanceof HubDirError) {
      ctx.ui.fail(err.message, (err as { hint?: string }).hint);
      return 3;
    }
    throw err;
  }
  if (h) return runDashboard(ctx, h, { commands: router.all(), runChild: makeChildRunner() });
  const target = path.resolve(ctx.flags.dir ?? process.cwd());
  const legacy = detectLegacyLayout(target);
  if (legacy) {
    ctx.ui.fail(`${target} has the pre-0.7 layout (${legacy.found.join(", ")})`, "rfa migrate --dry-run shows the move; rfa migrate performs it");
    return 3;
  }
  return runOnboarding(ctx, { target, existing: null, flags: {} });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(` ✖ ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
