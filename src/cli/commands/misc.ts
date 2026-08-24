/**
 * `version`, `docs`, `migrate` and `demo`: the commands that need no running hub.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { RFA_SPEC_VERSION } from "../../hub.js";
import { detectLegacyLayout, MANIFEST_VERSION } from "../../hubdir.js";
import { applyMigration, planMigration } from "../../migrate.js";
import { packageFile, packageVersion } from "../../pkg.js";
import { CliError, numberFlag, type CliContext } from "../context.js";
import type { CommandDef } from "../router.js";
import { runDemo } from "../demo.js";

export const version: CommandDef = {
  path: ["version"],
  summary: "Tool, manifest and protocol versions",
  run: async (ctx) => {
    const h = ctx.maybe();
    const v = { tool: packageVersion(), protocol: RFA_SPEC_VERSION, manifest: MANIFEST_VERSION, node: process.version, hub_directory: h ? { root: h.root, name: h.manifest.name, mode: h.mode } : null };
    if (ctx.flags.json) return void ctx.ui.json(v);
    ctx.ui.line(`rfa ${v.tool} · protocol ${v.protocol} · manifest v${v.manifest} · node ${v.node}`);
    if (h) ctx.ui.line(ctx.ui.dim(`hub directory ${h.root} (${h.manifest.name}, ${h.mode})`));
  },
};

const DOCS: Record<string, string[]> = {
  interop: ["INTEROP.md"],
  spec: ["spec", "RFA-0.1.md"],
  platform: ["spec", "RFA-0.4-platform.md"],
  plan: ["spec", "RFA-0.7-cli.md"],
  readme: ["README.md"],
  client: ["interop", "rfa_min.py"],
};

export const docs: CommandDef = {
  path: ["docs"],
  summary: "The interop guide, the specs and the README shipped in the package",
  usage: `<${Object.keys(DOCS).join("|")}> [--path] [--open]`,
  options: { path: { type: "boolean", default: false }, open: { type: "boolean", default: false } },
  why: "What to hand a peer: `rfa docs interop --path` is the file a stranger needs to join a room and do work, verified by an engineer who had only that document. `rfa docs client --path` is the dependency-free reference client beside it.",
  run: async (ctx, a) => {
    const which = a.positionals[0];
    if (!which || !DOCS[which]) throw new CliError(2, `rfa docs takes one of ${Object.keys(DOCS).join(", ")}`);
    const file = packageFile(...DOCS[which]);
    if (!fs.existsSync(file)) throw new CliError(1, `${path.relative(packageFile(), file)} is not in this installation`);
    if (ctx.flags.json) return void ctx.ui.json({ doc: which, path: file });
    if (a.values.path) return void process.stdout.write(file + "\n");
    if (a.values.open) return void execFile(process.platform === "darwin" ? "open" : "xdg-open", [file], () => {});
    process.stdout.write(fs.readFileSync(file, "utf8"));
  },
};

export const migrate: CommandDef = {
  path: ["migrate"],
  summary: "Move a pre-0.7 checkout into a hub directory",
  usage: "[--from <checkout>] [--to <dir>] [--name] [--port] [--human <label>] [--room-alias <alias>] [--dry-run]",
  why: "Before 0.7 the repository checkout was the instance. This plans the move as a list a human can read, refuses a store whose hub is still serving, and then performs exactly that list. Without --to the instance stays in place (the runtime moves under .rfa/); --to moves it out of the checkout, which is the separation the plan asked for.",
  options: { from: { type: "string" }, to: { type: "string" }, name: { type: "string" }, port: { type: "string" }, human: { type: "string" }, "room-alias": { type: "string" }, "dry-run": { type: "boolean", default: false } },
  examples: ["rfa migrate --dry-run", "rfa migrate --from ~/Dev/agent-com --to ~/rfa/acme --name acme --human paul --room-alias product"],
  run: async (ctx, a) => {
    const from = path.resolve((a.values.from as string | undefined) ?? process.cwd());
    const to = path.resolve((a.values.to as string | undefined) ?? from);
    if (!detectLegacyLayout(from)) throw new CliError(3, `${from} has no pre-0.7 layout (no data/, dogfood/ROOM.md or dogfood/state/)`, "pass --from <checkout>");
    const plan = planMigration(from, to, {
      name: a.values.name as string | undefined,
      port: numberFlag(a.values.port, "port", { int: true, min: 1, max: 65535 }),
      human: a.values.human as string | undefined,
      roomAlias: a.values["room-alias"] as string | undefined,
    });
    const ui = ctx.ui;
    if (ctx.flags.json && a.values["dry-run"]) return void ui.json(plan);
    ui.line(`${ui.bold(plan.inPlace ? "in place" : `${from} -> ${to}`)}  ${ui.dim(`manifest: ${plan.manifest.name}, hub ${"port" in plan.manifest.hub ? `port ${plan.manifest.hub.port}` : ""}`)}`);
    for (const w of plan.warnings) ui.warn(w);
    ui.blank();
    for (const s of plan.steps) ui.step(s.detail);
    ui.blank();
    ui.line(ui.bold("afterwards, with the hub up:"));
    for (const s of plan.afterwards) ui.note(`- ${s}`);
    if (a.values["dry-run"]) {
      ui.blank();
      ui.line(ui.dim("dry run: nothing changed. Run again without --dry-run to perform it."));
      return;
    }
    if (plan.warnings.some((w) => /fresh heartbeat/.test(w))) throw new CliError(3, "a hub is serving the legacy store", "stop it (launchctl bootout …, or kill the nohup'd process), then run the migration again");
    ui.blank();
    const res = applyMigration(plan);
    for (const d of res.done) ui.done(d);
    for (const s of res.skipped) ui.step(`skipped: ${s}`);
    ui.blank();
    ui.line(`${ui.bold("migrated.")} next: cd ${to} && rfa doctor && rfa up`);
    if (ctx.flags.json) ui.json({ plan, ...res });
  },
};

export const demo: CommandDef = {
  path: ["demo"],
  summary: "The spec's worked example, in memory, in ten seconds",
  why: "Two MCP clients (dev-agent, pm-agent) through one in-process hub: create, join, discover by digest, a mentions listen, a request, a busy refusal, a presence change, a three-chunk streamed answer, the room ended. No hub directory, no credential, no model: just the protocol.",
  run: async (ctx) => {
    await runDemo(ctx.ui);
  },
};
