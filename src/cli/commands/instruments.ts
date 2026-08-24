/**
 * The instruments: `knowledge`, `evals` and `log verify`.
 *
 * These were five scripts bound to one tenant's layout (sync-handbook,
 * promote-case, label, parity, verify-log). They are now commands over any hub
 * directory, and the logic they carry lives in `src/` where a test can reach it
 * without spawning a process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { knowledgeFiles, listPacks, type AgentPack } from "../../agentdef.js";
import { CHAIN_SCOPE_QUALIFIER } from "../../chain.js";
import { runForeground } from "../../daemon.js";
import { applyWorksheet, flagForReview, prepareWorksheet } from "../../evals/label.js";
import { loadFixtures, runParity, type ParityVerdict } from "../../evals/parity.js";
import { promoteCase } from "../../evals/promote.js";
import type { HubDir } from "../../hubdir.js";
import { countDocs, fileProvenance, isGitRemote, knowledgeStatus, packClones, pinCorpus, syncClone } from "../../knowledge-sources.js";
import { describeReport, expandLogTargets, verifyLogFile, type LogReport } from "../../logverify.js";
import { addKnowledge } from "../agentmd.js";
import { attachKnowledge, AttachError, type Attachment } from "../attach.js";
import { CliError, numberFlag } from "../context.js";
import { askLine, pickOne } from "../prompts.js";
import type { CommandDef } from "../router.js";
import { daemonEnv } from "./procs.js";
import { requireRoom } from "./room.js";
import { describeOffers, speaker } from "./talk.js";

function requirePack(h: HubDir, name: string | undefined): AgentPack {
  if (!name) throw new CliError(2, "which agent? pass its name", "rfa agent ls");
  const pack = listPacks(h.paths.agents).find((p) => p.name === name);
  if (!pack) throw new CliError(2, `no agent named ${name} in ${path.relative(h.root, h.paths.agents) || "agents"}/`, "rfa agent ls");
  return pack;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 10) : "?");

// ---------------------------------------------------------------- knowledge

export const knowledgeAdd: CommandDef = {
  path: ["knowledge", "add"],
  summary: "Attach a directory or a git repository to an agent's knowledge",
  usage: "<agent> <path|git remote> [--docs <subdir>] [--name <clone name>]",
  options: { docs: { type: "string" }, name: { type: "string" } },
  why: "A pack reads a TRACKED CLONE, not an export: a clone carries per-file provenance for free (author, commit time and sha for the exact file a fact came from), is fresh the moment someone pushes, and needs no credential at answer time. Seven files copied by hand once drifted from a 46-page handbook without anyone noticing. The clone lands under agents/<agent>/knowledge/<name>-clone/, which the hub directory's .gitignore excludes; a plain directory is attached in place as a glob. Binding a pack to an account-managed MCP connector is explicitly not an option (RFA-0.5 sect. 19.1).",
  examples: ["rfa knowledge add pm-agent ./docs", "rfa knowledge add pm-agent git@gitlab.example.com:org/handbook.git --docs src/content/docs"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const usage = "rfa knowledge add <agent> <path|git remote>";
    const name = a.positionals[0] ?? (await pickOne(ctx, "Which agent?", listPacks(h.paths.agents).map((p) => ({ value: p.name })), usage));
    const source = a.positionals[1] ?? (await askLine(ctx, "A folder of markdown, or a git remote", usage, { placeholder: "./docs  or  git@host:org/handbook.git" }));
    const pack = requirePack(h, name);
    const file = path.join(pack.dir, "agent.md");
    const remote = isGitRemote(source);
    const sp = remote ? ctx.ui.spinner(`cloning ${source}`) : null;
    let att: Attachment;
    try {
      att = attachKnowledge(h, pack, source, { docs: a.values.docs as string | undefined, cloneName: a.values.name as string | undefined });
    } catch (err) {
      sp?.stop({ ok: false, text: `could not attach ${source}` });
      if (err instanceof AttachError) throw new CliError(remote ? 1 : 2, err.message, err.hint);
      throw err;
    }
    if (att.clone) {
      const docs = String(a.values.docs ?? "").replace(/^\/+|\/+$/g, "");
      sp?.stop({ ok: true, text: `${att.clone.created ? "cloned at" : att.clone.fresh ? "updated to" : "already at"} ${short(att.clone.head)}`, detail: `${att.clone.docs} document(s) under ${docs || "the clone root"}` });
      const sample = fs.readdirSync(att.clone.docsDir, { withFileTypes: true }).find((e) => e.isFile() && /\.mdx?$/.test(e.name))?.name;
      const prov = sample ? fileProvenance(att.clone.dir, path.join(docs, sample)) : null;
      if (prov) ctx.ui.note(`provenance works: ${sample} last touched by ${prov.author} at ${prov.committed_at}`);
    }
    const { globs, attached } = att;
    const r = addKnowledge(file, globs);
    const files = knowledgeFiles(requirePack(h, name)).length;
    if (ctx.flags.json) return void ctx.ui.json({ agent: name, attached, globs, knowledge: r.knowledge, files, definition_changed: r.before !== r.after });
    ctx.ui.done(`${name} reads ${attached}`, `${files} file(s) match its knowledge globs now`);
    if (r.before === r.after) ctx.ui.note("agent.md already listed these globs; nothing changed");
    else ctx.ui.note(`agent.md: knowledge now lists ${r.knowledge.length} glob(s)`, `the running resident keeps its old definition: rfa agent restart ${name}`);
  },
};

export const knowledgeSync: CommandDef = {
  path: ["knowledge", "sync"],
  summary: "Fast-forward every attached clone (or one agent's) and say what moved",
  usage: "[<agent>] [--pin]",
  options: { pin: { type: "boolean", default: false } },
  why: "Nothing is copied: the pack reads the clone through its globs, so a sync is a pull. --pin records the synced head as the eval corpus_version afterwards, which is what keeps an upstream edit from reading as a regression.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const packs = a.positionals[0] ? [requirePack(h, a.positionals[0])] : listPacks(h.paths.agents);
    const rows: { agent: string; clone: string; head: string; fresh: boolean; documents: number; error?: string }[] = [];
    for (const pack of packs) {
      for (const c of packClones(pack)) {
        if (!c.remote) {
          rows.push({ agent: pack.name, clone: c.name, head: "?", fresh: false, documents: c.documents, error: "not a git clone (no origin)" });
          continue;
        }
        try {
          const r = syncClone(c.dir, c.remote);
          rows.push({ agent: pack.name, clone: c.name, head: r.head, fresh: r.fresh, documents: countDocs(c.dir) });
        } catch (err) {
          rows.push({ agent: pack.name, clone: c.name, head: c.head ?? "?", fresh: false, documents: c.documents, error: (err as Error).message.split("\n")[0] });
        }
      }
    }
    let pinned: string | null = null;
    if (a.values.pin) {
      const ok = rows.filter((r) => !r.error);
      if (ok.length !== 1) throw new CliError(2, ok.length === 0 ? "nothing to pin: no clone synced" : `${ok.length} clones synced; pin one with rfa knowledge pin <agent>`);
      pinCorpus(h.paths.evalBaseline, ok[0].head);
      pinned = ok[0].head;
    }
    if (ctx.flags.json) return void ctx.ui.json({ synced: rows, pinned });
    if (rows.length === 0) return void ctx.ui.line(ctx.ui.dim("no clones attached: rfa knowledge add <agent> <git remote> attaches one"));
    ctx.ui.table(rows.map((r) => [r.agent, r.clone, r.error ? ctx.ui.bad(r.error) : r.fresh ? ctx.ui.good(`updated to ${short(r.head)}`) : `already at ${short(r.head)}`, `${r.documents} doc(s)`]));
    if (pinned) ctx.ui.done(`pinned corpus_version = ${pinned}`, "live answers read the working clone; evals and parity read this sha");
    if (rows.some((r) => r.error)) return 1;
  },
};

export const knowledgeStatusCmd: CommandDef = {
  path: ["knowledge", "status"],
  summary: "What each agent reads, from where, and whether one page exists twice",
  why: "One knowledge fact must live in exactly one file. Attaching a new source without removing what it superseded produced duplicate pages, and the agent then honestly reported a fact as missing while it sat in the other copy (cost: a day of chasing a phantom eval flake). The duplicate check here is the cheapest detector of that: the same page name resolved from two places.",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const status = knowledgeStatus(h);
    if (ctx.flags.json) return void ctx.ui.json({ agents: status });
    if (status.length === 0) return void ctx.ui.line(ctx.ui.dim("no agents yet: rfa agent new <name>"));
    for (const s of status) {
      ctx.ui.line(`${ctx.ui.bold(s.pack)}  ${s.files} file(s) from ${s.globs.length} glob(s)`);
      for (const g of s.globs) ctx.ui.line(`     ${ctx.ui.dim(g)}`);
      for (const c of s.clones) ctx.ui.line(`     ${c.name}  ${c.remote ?? ctx.ui.caution("no origin")}  ${short(c.head)}  ${c.committedAt ? `committed ${c.committedAt}` : ""}  ${c.documents} doc(s)`);
      for (const d of s.duplicates) ctx.ui.warn(`${s.pack}: ${d.name} exists ${d.paths.length} times`, d.paths.join(" · "));
    }
    if (status.some((s) => s.duplicates.length)) ctx.ui.note("a page in two places is the one-fact-one-file rule broken: remove the superseded copy");
  },
};

export const knowledgePin: CommandDef = {
  path: ["knowledge", "pin"],
  summary: "Record a clone's head as the eval corpus version",
  usage: "[<agent>] [--sha <sha>]",
  options: { sha: { type: "string" } },
  why: "The eval corpus is a PINNED sha (RFA-0.5 sect. 19.4): evals and parity read it, live answers read the working clone, so an upstream edit cannot be mistaken for a regression in the agent.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    let sha = a.values.sha as string | undefined;
    if (!sha) {
      const packs = a.positionals[0] ? [requirePack(h, a.positionals[0])] : listPacks(h.paths.agents);
      const clones = packs.flatMap((p) => packClones(p).filter((c) => c.head).map((c) => ({ pack: p.name, ...c })));
      if (clones.length !== 1) throw new CliError(2, clones.length === 0 ? "no clone to pin: attach one with rfa knowledge add, or pass --sha" : `${clones.length} clones: ${clones.map((c) => `${c.pack}/${c.name}`).join(", ")}`, "name the agent, or pass --sha");
      sha = clones[0].head!;
    }
    pinCorpus(h.paths.evalBaseline, sha);
    if (ctx.flags.json) return void ctx.ui.json({ corpus_version: sha, baseline: h.paths.evalBaseline });
    ctx.ui.done(`pinned corpus_version = ${sha}`, path.relative(h.root, h.paths.evalBaseline));
  },
};

// ---------------------------------------------------------------- evals

export const evalsRun: CommandDef = {
  path: ["evals", "run"],
  summary: "The reliability gate: replay and live cases at pass^4, diffed against the baseline",
  usage: "[--judged] [--update-baseline] [--room <alias|handle>]",
  options: { judged: { type: "boolean", default: false }, "update-baseline": { type: "boolean", default: false }, room: { type: "string" } },
  why: "One run is ~32 live trials and about two dollars, so budget one per day. A baseline captured while the stack was unhealthy is VACUOUS, since nothing can drop below zero: re-baseline after any incident. --judged adds the model judge on live trajectories (tier 3). The report lands in .rfa/reports/evals/latest.md. Exit 1 on a regression, 2 when there is nothing to run.",
  examples: ["rfa evals run", "rfa evals run --update-baseline", "rfa evals run --judged --room product"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    // The runner streams human verdicts and writes its own machine-readable
    // report; --json silently swallowed by a child that never saw it would be
    // a lie to the script that passed it.
    if (ctx.flags.json) throw new CliError(2, "evals run has no --json view: the runner streams its verdicts and writes the report itself", `read ${path.join(".rfa", "reports", "evals")}/<ts>.json after the run (latest.md beside it)`);
    const args: string[] = ["--dir", h.root];
    if (a.values.judged) args.push("--judged");
    if (a.values["update-baseline"]) args.push("--update-baseline");
    if (a.values.room) args.push("--room", String(a.values.room));
    return runForeground("evals/runner", args, { cwd: h.root, env: daemonEnv(ctx, h) });
  },
};

export interface CaseRow {
  id: string;
  kind: string;
  subject: string;
  where: string;
  failure_mode: string | null;
  origin: string | null;
  promoted_at: string | null;
}

export function listCases(h: HubDir): CaseRow[] {
  const roots = [h.paths.evalCases, ...listPacks(h.paths.agents).map((p) => path.join(p.dir, "evals", "cases"))];
  const rows: CaseRow[] = [];
  for (const root of roots.filter((r) => fs.existsSync(r))) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "case.yaml");
      if (!fs.existsSync(file)) continue;
      const def = YAML.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const range = def.origin_seq_range as { from?: number; to?: number } | undefined;
      rows.push({
        id: String(def.id ?? entry.name),
        kind: String(def.kind ?? "?"),
        subject: String(def.subject ?? def.subject_capability ?? "?"),
        where: path.relative(h.root, path.join(root, entry.name)),
        failure_mode: typeof def.failure_mode === "string" ? def.failure_mode : null,
        origin: def.origin_room ? `${def.origin_room} ${range?.from ?? "?"}..${range?.to ?? "?"}` : null,
        promoted_at: typeof def.promoted_at === "string" ? def.promoted_at : null,
      });
    }
  }
  return rows;
}

export const evalsLs: CommandDef = {
  path: ["evals", "ls"],
  summary: "The cases the gate would run, with the failure mode each exists to catch",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const rows = listCases(h);
    if (ctx.flags.json) return void ctx.ui.json({ cases: rows });
    if (rows.length === 0) return void ctx.ui.line(ctx.ui.dim(`no cases under ${path.relative(h.root, h.paths.evalCases)}/ or agents/*/evals/cases/: rfa evals promote cuts one from a room log`));
    ctx.ui.table(rows.map((r) => [r.id, r.kind, r.subject, r.failure_mode ?? ctx.ui.dim("-"), r.origin ?? ctx.ui.dim("-"), ctx.ui.dim(r.where)]));
  },
};

export const evalsPromote: CommandDef = {
  path: ["evals", "promote"],
  summary: "Cut a replay case out of a room log, with its provenance stamped",
  usage: "<room> (--conversation <id> | --task <id>) --id <case id> [--failure-mode <label>] [--out <dir>] [--log <file>]",
  options: { conversation: { type: "string" }, task: { type: "string" }, id: { type: "string" }, "failure-mode": { type: "string" }, out: { type: "string" }, log: { type: "string" } },
  why: "Real work becomes the dataset at zero annotation cost (RFA-0.4 sect. 8). The slice is the linked seq range plus ONE roster snapshot; the five provenance keys of sect. 20.2 are stamped now because this is the only moment they are known. The failure mode must be the words the findings ledger uses, or the case cannot be traced back to its reason.",
  examples: ['rfa evals promote product --conversation c_ab12cd34 --id pm-fee-wrong-file --failure-mode "retrieval-wrong-file"'],
  run: async (ctx, a) => {
    const h = ctx.maybe();
    const ref = a.positionals[0];
    const caseId = a.values.id as string | undefined;
    const conversation = a.values.conversation as string | undefined;
    const taskId = a.values.task as string | undefined;
    if (!ref || !caseId || (!conversation && !taskId)) throw new CliError(2, "rfa evals promote <room> (--conversation <id> | --task <id>) --id <case id>");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(caseId)) throw new CliError(2, `case id ${JSON.stringify(caseId)}: lowercase letters, digits, dots, hyphens and underscores`);
    let logFile = a.values.log as string | undefined;
    let room = ref;
    if (!logFile) {
      if (!h) throw new CliError(2, "no hub directory here: pass --log <room log> to slice a file directly", "rfa init, or --dir <hub directory>");
      room = requireRoom(h, ref).handle;
      logFile = path.join(h.paths.roomLogs, `${room}.ndjson`);
    }
    if (!fs.existsSync(logFile)) throw new CliError(2, `no log at ${logFile}`);
    const outRoot = (a.values.out as string | undefined) ?? h?.paths.evalCases;
    if (!outRoot) throw new CliError(2, "no hub directory here: pass --out <cases dir>");
    let res;
    try {
      res = promoteCase({ logFile, room, conversation, taskId, caseId, outRoot: path.resolve(outRoot), failureMode: a.values["failure-mode"] as string | undefined });
    } catch (err) {
      throw new CliError(1, (err as Error).message);
    }
    if (ctx.flags.json) return void ctx.ui.json({ case: caseId, dir: res.dir, events: res.events, seq_range: { from: res.seqFrom, to: res.seqTo }, origin_run_id: res.originRunId, notes: res.notes });
    ctx.ui.done(`case promoted: ${h ? path.relative(h.root, res.dir) : res.dir}`, `${res.events} events, seq ${res.seqFrom}..${res.seqTo}`);
    ctx.ui.note(`provenance: run ${res.originRunId ?? "UNKNOWN"}, ${room} seq ${res.seqFrom}..${res.seqTo}`);
    for (const n of res.notes) ctx.ui.note(n);
  },
};

export const evalsLabel: CommandDef = {
  path: ["evals", "label"],
  summary: "The labelling sitting: prepare a worksheet from the review queue, then apply it (the dashboard's Evals tab is the same sitting in place)",
  usage: "--prepare [--limit <n>] [--out <file>] | --apply <worksheet> [--out <cases dir>]   [--db <obs.db>]",
  options: { prepare: { type: "boolean", default: false }, apply: { type: "string" }, limit: { type: "string" }, out: { type: "string" }, db: { type: "string" } },
  why: "Labelling is the scarce resource (RFA-0.5 sect. 20.4): ONE pass over the same traces produces the binary label, the gold source and the promotion together. The worksheet has the fetching and formatting done so the sitting is only judgement (the full answer is read from the room log when it is at hand, so nobody judges obs.db's 300-char excerpt as if it were the answer); applying it writes the human feedback rows (no rubric hash: that is how a person's verdict is told from a model's) and cuts the promoted cases. An all-passing sitting prints the exact ledger line the spec requires, because an instrument that has finished and one that has gone blind look the same without it. The dashboard's Evals tab holds the same queue in memory and applies it through the same function.",
  examples: ["rfa evals label --prepare", "rfa evals label --apply .rfa/reports/labelling-2026-08-22.yaml"],
  run: async (ctx, a) => {
    const h = ctx.maybe();
    const obsDb = (a.values.db as string | undefined) ?? h?.paths.obsDb;
    if (!obsDb) throw new CliError(2, "no hub directory here: pass --db <obs.db>", "rfa init, or --dir <hub directory>");
    if (!fs.existsSync(obsDb)) throw new CliError(1, `no observability store at ${obsDb}`, "residents write it on their first answer");
    if (a.values.prepare) {
      const out = (a.values.out as string | undefined) ?? (h ? path.join(h.paths.reports, `labelling-${new Date().toISOString().slice(0, 10)}.yaml`) : undefined);
      if (!out) throw new CliError(2, "no hub directory here: pass --out <worksheet.yaml>");
      const r = prepareWorksheet({
        obsDb,
        out: path.resolve(out),
        limit: numberFlag(a.values.limit, "limit", { int: true, min: 1 }),
        rubric: h ? path.relative(h.root, h.paths.evalRubric) : "evals/rubric.md",
        roomLogFile: h ? (room) => path.join(h.paths.roomLogs, `${room}.ndjson`) : undefined,
      });
      if (ctx.flags.json) return void ctx.ui.json({ worksheet: r.out, traces: r.traces, already_labelled: r.alreadyLabelled });
      ctx.ui.done(`worksheet: ${h ? path.relative(h.root, r.out) : r.out}`, `${r.traces} unlabelled trace(s) from the review queue`);
      if (r.alreadyLabelled > 0) ctx.ui.note(`${r.alreadyLabelled} already carry a human label and were left out`);
      if (r.traces === 0) ctx.ui.note("nothing to label: the review queue is empty or fully labelled");
      else ctx.ui.note("fill label, gold_source, failure_mode and promote per trace, then: rfa evals label --apply <worksheet>");
      return;
    }
    const file = a.values.apply as string | undefined;
    if (!file) throw new CliError(2, "rfa evals label --prepare | --apply <worksheet>");
    if (!fs.existsSync(file)) throw new CliError(2, `no worksheet at ${file}`);
    const outRoot = (a.values.out as string | undefined) ?? h?.paths.evalCases;
    let r;
    try {
      r = applyWorksheet({
        obsDb,
        file,
        outRoot: outRoot ? path.resolve(outRoot) : path.resolve("evals", "cases"),
        roomLogFile: (room) => {
          if (!h) throw new Error("no hub directory, so no room log to slice (pass --dir)");
          return path.join(h.paths.roomLogs, `${room}.ndjson`);
        },
      });
    } catch (err) {
      throw new CliError(1, (err as Error).message);
    }
    if (ctx.flags.json) return void ctx.ui.json({ labelled: r.labelled, gold_sources: r.golds, promoted: r.promoted, failure_modes: [...new Set(r.failures)], ledger_line: r.ledgerLine, problems: r.problems });
    for (const p of r.problems) ctx.ui.warn(p);
    ctx.ui.done(`sitting applied: ${r.labelled} label(s), ${r.golds} gold source(s), ${r.promoted.length} case(s) promoted`);
    for (const p of r.promotedNotes) ctx.ui.note(`${p.caseId}: ${h ? path.relative(h.root, p.dir) : p.dir}`, p.notes.join("; "));
    if (r.failures.length > 0) ctx.ui.note(`failure modes recorded: ${[...new Set(r.failures)].join("; ")}`);
    if (r.ledgerLine) {
      ctx.ui.blank();
      ctx.ui.line("PASTE THIS INTO THE FINDINGS LEDGER (RFA-0.5 sect. 20.4 requires it for an all-passing review):");
      ctx.ui.line(`  ${r.ledgerLine}`);
      ctx.ui.note("an all-passing review with no such entry is an unaudited instrument: nothing distinguishes", "an instrument that has finished from one that has gone blind");
    }
  },
};

export const evalsFlag: CommandDef = {
  path: ["evals", "flag"],
  summary: "Flag an answer for the labelling sitting, by its run id, with why",
  usage: '<run id> ["<why>"] [--db <obs.db>]',
  options: { db: { type: "string" } },
  why: "Evals and parity flag their own failures; a person reading a wrong answer had no way into the review queue. This marks the run needs_review and writes a human feedback row at 0 with the reason, so the next sitting (rfa evals label --prepare, or the dashboard's Evals tab) lists the trace with the reason beside it. The run id is on every answer: rfa ask prints it, the ask box shows it, and `!` on the ask box's answer is this command.",
  examples: ['rfa evals flag run_4d713d020cd7 "cited the wrong plan"'],
  run: async (ctx, a) => {
    const h = ctx.maybe();
    const obsDb = (a.values.db as string | undefined) ?? h?.paths.obsDb;
    if (!obsDb) throw new CliError(2, "no hub directory here: pass --db <obs.db>", "rfa init, or --dir <hub directory>");
    if (!fs.existsSync(obsDb)) throw new CliError(1, `no observability store at ${obsDb}`, "residents write it on their first answer");
    const runId = a.positionals[0] ?? (await askLine(ctx, "Which run? (the run_… id on the answer)", 'rfa evals flag <run id> ["<why>"]', { placeholder: "run_4d713d020cd7" }));
    const note = a.positionals[1] ?? null;
    try {
      flagForReview({ obsDb, runId, note });
    } catch (err) {
      throw new CliError(1, (err as Error).message);
    }
    if (ctx.flags.json) return void ctx.ui.json({ run_id: runId, flagged: true, note });
    ctx.ui.done(`${runId} flagged for the sitting`, note ? `"${note}"` : "no reason given; the sitting can still name the failure mode");
    ctx.ui.note("rfa evals label --prepare lists it, and so does the dashboard's Evals tab");
  },
};

export const evalsParity: CommandDef = {
  path: ["evals", "parity"],
  summary: "Ask the parity questions of a live agent and check each answer for its facts and a citation",
  usage: "[--room <alias|handle>] [--capability <skill id>] [--fixtures <file>] [--capture] [--timeout <seconds>]",
  options: { room: { type: "string" }, capability: { type: "string" }, fixtures: { type: "string" }, capture: { type: "boolean", default: false }, timeout: { type: "string" } },
  why: "The gate for a brain or knowledge change: the same questions before and after, each answer checked for the facts it must mention and for a citation. Run it TWICE after a change; a single pass has hidden a real regression. Verdicts land as evaluator feedback on the answer's run, and a failure marks the run for review. Fixtures: evals/parity.json, an array of { question, must_mention[] } where an expectation may list alternatives with |.",
  examples: ["rfa evals parity", "rfa evals parity --capture   # record the current answers as the baseline text"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const fixturesFile = path.resolve((a.values.fixtures as string | undefined) ?? h.paths.evalParity);
    let fixtures;
    try {
      fixtures = loadFixtures(fixturesFile);
    } catch (err) {
      throw new CliError(2, (err as Error).message, `write ${path.relative(h.root, fixturesFile)} as [{ "question": "...", "must_mention": ["..."] }]`);
    }
    if (fixtures.length === 0) throw new CliError(2, `${path.relative(h.root, fixturesFile)} lists no questions`);
    const timeoutS = numberFlag(a.values.timeout, "timeout", { min: 1 });
    if (!(await ctx.healthz())) throw new CliError(3, `the hub at ${ctx.hubUrl()} is not answering`, "rfa up");
    const rec = requireRoom(h, a.values.room as string | undefined, true);
    const { me, ephemeral } = await speaker(ctx, h, rec);
    try {
      const roster = (await me.refreshRoster()) as { id: string; name: string; role: string; state: string; card_summary: { skill_ids: string[] } }[];
      const candidates = roster.filter((r) => r.id !== me.memberId && r.role === "participant" && r.state !== "offline");
      const offered = [...new Set(candidates.flatMap((r) => r.card_summary.skill_ids))];
      const capability = (a.values.capability as string | undefined) ?? (offered.length === 1 ? offered[0] : offered.find((s) => /answer/.test(s)));
      if (!capability) throw new CliError(offered.length ? 2 : 3, offered.length ? `${rec.alias} offers ${offered.length} capabilities: ${describeOffers(candidates, offered)}` : `nobody in ${rec.alias} is present to answer`, offered.length ? "pick one with --capability <id>" : "rfa status");
      const eligible = candidates.filter((r) => r.card_summary.skill_ids.includes(capability));
      const target = eligible.find((r) => r.state === "ready") ?? eligible[0];
      if (!target) throw new CliError(3, `nobody in ${rec.alias} offers ${capability}`);
      ctx.ui.step(`parity against ${target.name} (${capability}) in ${rec.alias}`, `${fixtures.length} question(s)`);
      const verdicts: ParityVerdict[] = await runParity({
        me,
        subjectId: target.id,
        fixtures,
        obsDb: h.paths.obsDb,
        capture: Boolean(a.values.capture),
        timeoutMs: timeoutS !== undefined ? timeoutS * 1000 : undefined,
        onVerdict: (v) => {
          ctx.ui.line(`${v.ok ? ctx.ui.good("PASS") : ctx.ui.bad("FAIL")}  ${(v.ms / 1000).toFixed(1).padStart(5)}s  ${v.question.slice(0, 70)}`);
          if (!v.ok) {
            ctx.ui.note(`kind=${v.kind} cited=${v.cited} missing=${JSON.stringify(v.missing)}`);
            ctx.ui.note(`got: ${v.excerpt}`);
          }
        },
      });
      if (a.values.capture) fs.writeFileSync(fixturesFile, JSON.stringify(fixtures, null, 2) + "\n");
      const failures = verdicts.filter((v) => !v.ok).length;
      if (ctx.flags.json) ctx.ui.json({ room: rec.handle, subject: target.name, capability, verdicts, captured: Boolean(a.values.capture) });
      else {
        if (a.values.capture) ctx.ui.done(`baseline captured for ${fixtures.length} question(s)`, path.relative(h.root, fixturesFile));
        if (failures) ctx.ui.fail(`${failures}/${verdicts.length} parity checks FAILED`, "a failed answer is marked for review: rfa evals label --prepare lists it");
        else ctx.ui.done(`parity: ${verdicts.length}/${verdicts.length} PASS`, "run it once more: a single pass has hidden a real regression before");
      }
      return failures ? 1 : 0;
    } finally {
      if (ephemeral) await me.leave().catch(() => {});
    }
  },
};

// ---------------------------------------------------------------- log verify

export const logVerify: CommandDef = {
  path: ["log", "verify"],
  summary: "Verify room logs' hash chains offline: every room, named rooms, or any file",
  usage: "[<alias|handle> ...] [--file <log.ndjson | directory>]",
  options: { file: { type: "string" } },
  why: "Wire sect. 13 says tamper evidence must be verifiable offline, and a verifier that boots the thing it audits is not offline: this reads files and nothing else, so it is safe against a live hub. The genesis link is sha256 of the handle taken from the FILENAME, never from inside the file. NOT-CHAINED is a third verdict on purpose: a log that predates the chain has nothing to check, and INTACT over zero links is a green light that means nothing. A torn final line is an ordinary crash, not a break. Exit 1 on any divergence.",
  examples: ["rfa log verify", "rfa log verify product", "rfa log verify --file ~/Backups/rfa/acme/2026-08-21/dirs/.rfa/data/rooms"],
  run: async (ctx, a) => {
    let files: string[];
    if (a.values.file) {
      try {
        files = expandLogTargets(path.resolve(String(a.values.file)));
      } catch (err) {
        throw new CliError(2, (err as Error).message);
      }
    } else {
      const h = ctx.hubdir();
      files = a.positionals.length
        ? a.positionals.map((ref) => path.join(h.paths.roomLogs, `${requireRoom(h, ref).handle}.ndjson`))
        : fs.existsSync(h.paths.roomLogs)
          ? expandLogTargets(h.paths.roomLogs)
          : [];
      const missing = files.filter((f) => !fs.existsSync(f));
      if (missing.length) throw new CliError(2, `no log for ${missing.map((f) => path.basename(f, ".ndjson")).join(", ")}`, "a room's log starts at its first event");
    }
    if (files.length === 0) throw new CliError(2, "no room logs to verify");
    const reports: LogReport[] = files.map(verifyLogFile);
    const broken = reports.filter((r) => r.verdict === "DIVERGED").length;
    const unchained = reports.filter((r) => r.verdict === "NOT-CHAINED").length;
    const badMid = reports.reduce((n, r) => n + r.badMid, 0);
    if (ctx.flags.json) ctx.ui.json({ scope: CHAIN_SCOPE_QUALIFIER, reports });
    else {
      for (const r of reports) for (const line of describeReport(r)) ctx.ui.line(line);
      ctx.ui.blank();
      ctx.ui.line(`${reports.length - broken - unchained}/${reports.length} log(s) verified intact` + (unchained ? `, ${unchained} carry no chain to verify` : "") + (broken ? `, ${broken} DIVERGED` : ""));
      ctx.ui.line(ctx.ui.dim(CHAIN_SCOPE_QUALIFIER));
    }
    return broken > 0 || badMid > 0 ? 1 : 0;
  },
};
