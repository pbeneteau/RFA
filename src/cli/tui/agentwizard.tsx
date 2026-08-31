/**
 * The agent walkthrough (RFA-0.7 sect. 13.7, amended 2026-08-30): what
 * `rfa agent new` opens on a terminal - bare, or with only a name, which used
 * to scaffold silently with defaults (dogfood F9) - and what `n` on the
 * dashboard runs.
 *
 * Describe-first: when a model credential exists, the first screen is one
 * free-text question ("what should it do, from what, for whom"), a bounded
 * model call (`src/cli/draftpack.ts`, in RFA-0.9 sect. 6's inventory) drafts
 * the whole pack, and the wizard lands on the review with every question
 * pre-answered - esc walks back into any screen to edit. Without a credential,
 * or on a blank description, it is the same question-per-screen walkthrough as
 * before. Nothing is written until the review's enter, through the same
 * `scaffoldPack` the one-line command uses, and creation ends with an offered
 * first ask instead of a silent success line when something is running to
 * answer it. The flags of `rfa agent new` stay the headless form of every
 * answer.
 *
 * The screens are exported: `rfa agent edit` asks the same questions over an
 * existing pack (agentedit.tsx), so a setting is asked the same way whether the
 * pack is being made or changed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { daemonState } from "../../daemon.js";
import type { HubDir, RoomRecord } from "../../hubdir.js";
import { isGitRemote, previewDirAttach } from "../../knowledge-sources.js";
import { MODE_SUMMARY, MODES, type AgentMode } from "../../posture.js";
import { addKnowledge } from "../agentmd.js";
import { attachKnowledge } from "../attach.js";
import { createRoomRecord } from "../commands/init.js";
import type { CliContext } from "../context.js";
import { draftAvailable, DraftError, draftRound, kindOffer, MAX_DRAFT_ROUNDS, type DraftQuestion, type PackDraft } from "../draftpack.js";
import { knowledgeRelativeToPack, nameProblem, PACK_KINDS, renderAgentMd, scaffoldPack, type PackKind, type ToolSpec } from "../scaffold.js";
import { loadSecrets } from "../../secrets.js";
import { execFile } from "node:child_process";
import { askInRoom, recordedRooms, type AskOutcome } from "./data.js";
import { Mark } from "./logo.js";
import { Field, ToolServerFields } from "./onboarding.js";
import { ACCENT, BAD, fmtMs, fmtUsd, GOOD, MUTED, WARN } from "./theme.js";
import { Choice, Keys, Panel, Spin } from "./widgets.js";

export interface WizardResult {
  code: number;
  created: string | null;
}

export type Step = "describe" | "name" | "kind" | "knowledge" | "server" | "mode" | "model" | "capability" | "budgets" | "room" | "review" | "create" | "ask" | "done";
const ORDER: Step[] = ["describe", "name", "kind", "knowledge", "server", "mode", "model", "capability", "budgets", "room", "review", "create", "ask", "done"];

export interface Draft {
  name: string;
  kind: PackKind;
  knowledge: { type: "folder" | "git" | "later"; value?: string; docs?: string } | null;
  tool: ToolSpec | null;
  mode: AgentMode;
  model: "haiku" | "sonnet" | "opus";
  offer: { id: string; description: string };
  budgets: { per_task_usd: number; per_day_usd: number; max_turns: number };
  /** A recorded room's handle, a room to create, or none. */
  room: { handle: string; alias: string } | { create: { alias: string; topic: string } } | null;
  /** The describe screen applies only when a model credential exists (checked once, before render). */
  draftable: boolean;
  /** A draft filled these answers in, so re-walking a screen must not reset them to kind defaults. */
  drafted: boolean;
  /** The drafted card description; null keeps the kind's sentence. */
  description: string | null;
  /** The drafted system prompt; null keeps the kind's template. */
  prompt: string | null;
}

export function defaultDraft(): Draft {
  return { name: "", kind: "answerer", knowledge: null, tool: null, mode: "ask", model: "haiku", offer: { id: "", description: "" }, budgets: { per_task_usd: 0.25, per_day_usd: 5, max_turns: 8 }, room: null, draftable: false, drafted: false, description: null, prompt: null };
}

/** The defaults that follow from the kind, applied when the kind is chosen. Offer ids are name-derived (dogfood F16: a shared id collides by construction). */
export function forKind(d: Draft, kind: PackKind): Draft {
  const offer = kindOffer(kind, d.name || "new-agent");
  // $5 a day: a pass^4 gate run over four cases costs about $1.60 on haiku, and the first live gate run stopped at a $3 ceiling halfway through.
  const budgets = kind === "tool" ? { per_task_usd: 1, per_day_usd: 5, max_turns: 20 } : { per_task_usd: 0.25, per_day_usd: 5, max_turns: 8 };
  return { ...d, kind, offer, budgets, model: kind === "tool" ? "sonnet" : "haiku", knowledge: kind === "answerer" ? d.knowledge : null, tool: kind === "tool" ? d.tool : null };
}

export function applicableStep(step: Step, d: Draft): boolean {
  if (step === "describe") return d.draftable;
  if (step === "knowledge") return d.kind === "answerer";
  if (step === "server" || step === "mode") return d.kind === "tool";
  return true;
}

export function nextStep(from: Step, d: Draft, dir: 1 | -1 = 1): Step {
  let i = ORDER.indexOf(from) + dir;
  while (i > 0 && i < ORDER.length && !applicableStep(ORDER[i], d)) i += dir;
  const step = ORDER[Math.max(0, Math.min(ORDER.length - 1, i))];
  // The clamp can land on ORDER[0] ("describe"), which is not always applicable;
  // an inapplicable landing stays where it was rather than showing a screen that
  // does not exist for this draft.
  return applicableStep(step, d) ? step : from;
}

export const WHY: Record<Step, { title: string; lines: string[] }> = {
  describe: { title: "describe-first", lines: ["A model call drafts the whole pack: kind, name, tools, knowledge, budgets, capability, prompt. When your description leaves a load-bearing choice open, it asks up to three short follow-ups first (three rounds at most).", "A few cents per round; the running total is shown while it drafts, on the review, and even when a draft fails - the money is spent either way.", "Every question is then pre-answered and editable, and NOTHING is written until you approve the review.", "The draft is validated through the same schema as a hand-written pack: it is never trusted because a model wrote it.", "Blank skips straight to the questions. This screen only appears when a model credential exists."] },
  name: { title: "the name", lines: ["Lowercase, no spaces: it is the folder under agents/ and the name the room sees.", "Reserved first words (human, console, system, hub, rfa) are refused here rather than at join."] },
  kind: { title: "three kinds of pack", lines: ["An answerer reads markdown and answers with citations; it has no side effects.", "A tool user acts through an MCP server; every acting call pauses for a human unless you set its mode otherwise.", "A spec-expert answers about the RFA protocol from the spec shipped in this package; a demo, not a colleague."] },
  knowledge: { title: "what it answers from", lines: ["A folder is attached as a glob; nothing is copied.", "A git repository is cloned under the pack and tracked: provenance for free, fresh on every push, no credential at answer time.", "Later: fill agents/<name>/knowledge/ or run rfa knowledge add."] },
  server: { title: "what it acts through", lines: ["A built-in server ships in this package and starts beside the agent, with its own secrets and sandbox.", "Any MCP server works: a command and the tool id to gate; you then name its secrets and the hosts its own sandbox may reach (RFA-0.9: this platform spawns it, so the definition says what its sandbox permits).", "Secrets are NAMES; the supervisor injects their values from .rfa/secrets.json. The review checks each name against what is actually set."] },
  mode: { title: "how it acts", lines: ["ask pauses every acting tool on a card you decide.", "plan proposes and never acts: the answer is the plan.", "bypass acts without asking; the room gate, budgets, hold and quarantine still apply."] },
  model: { title: "the model", lines: ["haiku: fast and cheap; enough to read knowledge and answer with citations.", "sonnet: composes and acts; the default for a tool user.", "opus: the most capable and the most expensive; for reasoning that keeps failing on sonnet.", "Budgets cap the spend whatever the model."] },
  capability: { title: "what it advertises", lines: ["Discovery is by capability, never by name: the id is what an asker matches on (rfa ask --capability).", "Make it a verb. Two agents may offer the same id; the asker picks."] },
  budgets: { title: "the ceilings", lines: ["per task: the most one answer may cost; the SDK stops the turn there.", "per day: the pack's daily total; answers are refused past it.", "max turns: how many model turns one answer may take before it is cut off."] },
  room: { title: "where it serves", lines: ["Rooms are the isolation unit: everyone in a room sees everything in it.", "A pack bound to a room joins it with the operator bearer; no secret to paste.", "One capability per room keeps rfa ask unambiguous."] },
  review: { title: "what will be written", lines: ["agents/<name>/agent.md: the whole definition, validated through the supervisor's own schema before it is written.", "The measured lines above the summary are what IS, not what is proposed: the knowledge folder's real match count, each secret checked against .rfa/secrets.json, the server's npm package resolved.", "A running supervisor picks the pack up within 30 seconds."] },
  create: { title: "", lines: [] },
  ask: { title: "first value", lines: ["The asker joins the room as you, finds the agent by capability, and waits for the answer.", "Answers carry citations, cost and a run id, every time.", "Blank skips; rfa ask does the same thing later, from anywhere in this folder."] },
  done: { title: "", lines: [] },
};

/** The shape every walkthrough screen has: the heading line, the question with its keys, the reason beside it when the terminal is wide enough. */
export function WizardFrame(props: { heading: string; counter?: string; hubName: string; label: string; why?: { title: string; lines: string[] }; footer?: [string, string][]; children: React.ReactNode }): React.JSX.Element {
  const { columns } = useWindowSize();
  const narrow = columns < 96;
  const leftWidth = narrow ? Math.max(40, columns - 2) : Math.min(64, Math.floor(columns * 0.56));
  const rightWidth = narrow ? Math.max(40, columns - 2) : Math.max(30, columns - leftWidth - 4);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} gap={1}>
        <Mark />
        <Text bold>{props.heading}</Text>
        <Text dimColor>
          {" "}
          {props.counter ? `${props.counter} · ` : ""}
          {props.hubName}
        </Text>
      </Box>
      <Box gap={narrow ? 0 : 2} flexDirection={narrow ? "column" : "row"}>
        <Panel title={props.label} active width={leftWidth}>
          {props.children}
          <Box marginTop={1}>
            <Keys items={props.footer ?? [["enter", "next"], ["esc", "back"]]} />
          </Box>
        </Panel>
        {props.why && props.why.lines.length ? (
          <Panel title={props.why.title} width={rightWidth}>
            {props.why.lines.map((l, i) => (
              <Text key={i} dimColor wrap="wrap">
                {l}
              </Text>
            ))}
          </Panel>
        ) : null}
      </Box>
    </Box>
  );
}

export type Screen = (label: string, body: React.ReactNode, footer?: [string, string][]) => React.JSX.Element;

export function AgentWizard(props: { ctx: CliContext; hub: HubDir; initialName?: string; draftable?: boolean }): React.JSX.Element {
  const { exit } = useApp();
  const h = props.hub;
  const draftable = Boolean(props.draftable);
  const [step, setStep] = useState<Step>(draftable ? "describe" : "name");
  const [d, setD] = useState<Draft>(() => ({ ...defaultDraft(), name: props.initialName ?? "", draftable }));
  const [lines, setLines] = useState<{ ok: boolean; text: string; detail?: string }[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; skill: string; room: string | null; dir: string } | null>(null);
  const [draftMeta, setDraftMeta] = useState<{ cost: number; model: string; rounds: number; reasoning: string; notes: string[] } | null>(null);
  const [previewAt, setPreviewAt] = useState(0);
  /**
   * MEASURED facts for the review (2026-08-31): what IS, beside what is
   * proposed - the knowledge folder's real match count under the default
   * globs, whether each secret NAME exists in .rfa/secrets.json, and whether
   * a custom server's npm package actually resolves (async, arrives when npm
   * answers; nothing blocks the review on the network).
   */
  const [npmFact, setNpmFact] = useState<string | null>(null);
  const measured = useMemo(() => {
    if (step !== "review") return [];
    const facts: { ok: boolean; text: string }[] = [];
    if (d.kind === "answerer" && d.knowledge?.type === "folder" && d.knowledge.value) {
      const p = previewDirAttach(d.knowledge.value);
      const skipped = p.skipped.slice(0, 3).map((x) => `${x.count} ${x.ext}`).join(", ");
      facts.push({ ok: p.matched > 0, text: `knowledge: ${p.matched} file(s) match the md globs${skipped ? ` · not matched: ${skipped}${p.skipped.length > 3 ? ", …" : ""}` : ""}${p.matched === 0 ? " - the agent would answer from NOTHING" : ""}` });
    }
    if (d.kind === "tool" && d.tool?.envSecrets?.length) {
      const have = new Set(Object.keys(loadSecrets(h.paths.secrets)));
      for (const name of d.tool.envSecrets) {
        facts.push(have.has(name) ? { ok: true, text: `secret ${name}: in .rfa/secrets.json` } : { ok: false, text: `secret ${name}: NOT set - rfa secrets set ${name} (the server runs without it until then)` });
      }
    }
    return facts;
  }, [step, d, h]);
  useEffect(() => {
    if (step !== "review" || d.kind !== "tool" || !d.tool || d.tool.builtin) return void setNpmFact(null);
    const pkg = [...(d.tool.args ?? []), d.tool.command ?? ""].find((t) => /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(t) && !/^(npx|node|uvx|python3?|-y|--yes)$/.test(t));
    if (!pkg) return void setNpmFact(null);
    setNpmFact(`npm: resolving ${pkg}…`);
    execFile("npm", ["view", pkg, "version"], { timeout: 8_000 }, (err, stdout) => {
      setNpmFact(err ? `npm: ${pkg} did NOT resolve (private, misspelled, or not a package)` : `npm: ${pkg}@${stdout.trim()} resolves${(d.tool?.args ?? []).some((a) => /@(latest|\^|~)?$/.test(pkg) || a.includes("@latest")) ? " - pin the version: @latest drifts under a restart" : ""}`);
    });
  }, [step, d]);
  const started = useRef(false);
  const rooms = useMemo(() => recordedRooms(h).filter((r) => r.alias !== "ops"), [h]);
  const taken = useMemo(() => (fs.existsSync(h.paths.agents) ? fs.readdirSync(h.paths.agents, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []), [h]);
  const [askRoom, setAskRoom] = useState<RoomRecord | null>(null);

  const go = (dir: 1 | -1, draft = d) => setStep((s) => nextStep(s, draft, dir));
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  /** A draft landed: every question pre-answered, straight to the review (or to the one question a draft cannot answer, a tool user's server). */
  const onDrafted = (p: PackDraft, cost: number, model: string, rounds = 1) => {
    const notes = [...p.notes];
    let room = d.room;
    if (!room && rooms[0]) {
      room = { handle: rooms[0].handle, alias: rooms[0].alias };
      notes.push(`bound to ${rooms[0].alias}, the first recorded room; the room screen changes it`);
    }
    if (p.kind === "tool") notes.push("a drafted tool user starts in ask mode: every acting call pauses for you (the mode screen changes it)");
    setDraftMeta({ cost, model, rounds, reasoning: p.reasoning, notes });
    const next: Draft = {
      ...d,
      drafted: true,
      name: p.name,
      kind: p.kind,
      description: p.description,
      prompt: p.prompt,
      model: p.model,
      offer: p.offer,
      budgets: p.budgets,
      knowledge: p.knowledge ? { type: "folder", value: p.knowledge } : null,
      tool: null,
      mode: "ask",
      room,
    };
    setD(next);
    setStep(p.kind === "tool" ? "server" : "review");
  };

  useInput(
    (input, key) => {
      // A written pack is a fact whatever key ends the session: reporting
      // created: null for a creation that happened made the caller print
      // nothing and the operator delete by hand what they thought never existed.
      if (key.ctrl && input === "c") return exit({ code: 2, created: created?.name ?? null } satisfies WizardResult);
      if (step === "done" && (key.return || input === "q" || key.escape)) return exit({ code: 0, created: created?.name ?? null } satisfies WizardResult);
      if (step === "create" && failure && (key.return || input === "q" || key.escape)) return exit({ code: 1, created: null } satisfies WizardResult);
      if (step === "review" && key.return) return setStep("create");
      if (step === "review" && (input === "j" || input === "k")) return setPreviewAt((o) => Math.max(0, o + (input === "j" ? 3 : -3)));
      if (key.escape && step !== "create" && step !== "ask" && step !== "done") return go(-1);
    },
    { isActive: true },
  );

  // Creation, once: the same scaffold the one-line command runs, then the knowledge attachment and the room.
  useEffect(() => {
    if (step !== "create" || started.current) return;
    started.current = true;
    void (async () => {
      const say = (ok: boolean, text: string, detail?: string) => setLines((l) => [...l, { ok, text, detail }]);
      try {
        let roomHandle: string | null = null;
        if (d.room && "create" in d.room) {
          const rec = await createRoomRecord(props.ctx, h, d.room.create.alias, d.room.create.topic);
          roomHandle = rec.handle;
          say(true, `room ${d.room.create.alias}  ${rec.handle}`, "you host it; the pack joins it with the bearer");
        } else if (d.room && "handle" in d.room) roomHandle = d.room.handle;
        const res = scaffoldPack(h, {
          name: d.name,
          kind: d.kind,
          room: roomHandle,
          model: d.model,
          knowledge: d.knowledge?.type === "folder" ? d.knowledge.value : undefined,
          tool: d.tool ?? undefined,
          mode: d.kind === "tool" ? d.mode : undefined,
          offer: d.offer,
          budgets: d.budgets,
          description: d.description ?? undefined,
          prompt: d.prompt ?? undefined,
        });
        say(true, `agents/${d.name}/agent.md`, `definition ${res.definitionHash.slice(7, 15)} · offers ${res.skillId}${roomHandle ? "" : " · not bound to a room yet"}`);
        if (d.knowledge?.type === "git" && d.knowledge.value) {
          const att = attachKnowledge(h, { name: d.name, dir: res.dir }, d.knowledge.value, { docs: d.knowledge.docs });
          addKnowledge(path.join(res.dir, "agent.md"), att.globs);
          say(true, `cloned ${d.knowledge.value} at ${att.clone?.head.slice(0, 10) ?? "?"}`, `${att.clone?.docs ?? 0} document(s), attached as ${att.globs[0].replace(/\/\*\*\/\*\.md$/, "")}/**; rfa knowledge sync pulls it`);
        }
        const sup = daemonState(h.paths.supervisorPid);
        say(true, sup.alive ? "the supervisor picks it up within 30 seconds" : "nothing is running: rfa up starts it", sup.alive ? "rfa status shows it joining" : undefined);
        setCreated({ name: d.name, skill: res.skillId, room: roomHandle, dir: res.dir });
        // First value instead of a silent success line: offer an ask when
        // something is actually running to answer it; otherwise the done screen
        // says what to start.
        const rec = roomHandle ? (recordedRooms(h).find((r) => r.handle === roomHandle) ?? null) : null;
        const askable = rec && sup.alive && (await props.ctx.healthz());
        if (askable) setAskRoom(rec);
        setStep(askable ? "ask" : "done");
      } catch (err) {
        setFailure((err as Error).message);
      }
    })();
  }, [step, d, h, props.ctx]);

  const asked = ORDER.filter((s) => applicableStep(s, d) && !["describe", "create", "ask", "done"].includes(s));
  const screen: Screen = (label, body, footer) => (
    <WizardFrame heading="new agent" counter={asked.includes(step) ? `${asked.indexOf(step) + 1}/${asked.length}` : undefined} hubName={h.manifest.name} label={label} why={WHY[step]} footer={footer}>
      {body}
    </WizardFrame>
  );

  switch (step) {
    case "describe":
      return <DescribeScreen screen={screen} hubRoot={h.root} fixedName={props.initialName} taken={taken} onSkip={() => setStep("name")} onDrafted={onDrafted} />;
    case "name":
      return screen(
        "Name the agent",
        <Field key="name" value={d.name} placeholder="pm-agent" validate={(v) => nameProblem(v) ?? (fs.existsSync(path.join(h.paths.agents, v, "agent.md")) ? `agents/${v} already exists` : null)} onSubmit={(v) => {
          // A rename over a DRAFTED pack keeps the drafted answers; only the
          // plain walkthrough re-derives the kind's defaults from the name.
          const renamed = { ...d, name: v };
          const next = d.drafted ? renamed : forKind(renamed, d.kind);
          setD(next);
          go(1, next);
        }} />,
      );
    case "kind":
      return screen(
        "What kind of agent?",
        <Choice
          initial={d.kind}
          options={PACK_KINDS.map((k) => ({ value: k, label: k === "tool" ? "a tool user" : k === "answerer" ? "an answerer" : "spec-expert", hint: k === "tool" ? "acts through an MCP server, behind your approval" : k === "answerer" ? "answers from markdown, with citations" : "answers about the RFA protocol; a demo" }))}
          onChoose={(v) => {
            // Re-confirming the same kind keeps every drafted or customized
            // answer; a different kind resets to its defaults, drafted prompt
            // and description included, because they were composed for the old one.
            if (v === d.kind) return go(1);
            const next: Draft = { ...forKind(d, v as PackKind), drafted: false, description: null, prompt: null };
            setD(next);
            go(1, next);
          }}
        />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "knowledge":
      return <KnowledgeScreen screen={screen} onDone={(k) => {
        set({ knowledge: k });
        go(1, { ...d, knowledge: k });
      }} />;
    case "server":
      return <ServerScreen screen={screen} initial={d.tool ?? undefined} onDone={(t) => {
        set({ tool: t });
        // The server is the one question a draft cannot answer for a tool
        // user; with the rest pre-answered, the review is next.
        if (d.drafted) return setStep("review");
        go(1, { ...d, tool: t });
      }} />;
    case "mode":
      return screen(
        "How does it act?",
        <ModeChoice initial={d.mode} onChoose={(m) => {
          set({ mode: m });
          go(1, { ...d, mode: m });
        }} />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "model":
      return screen(
        "Which model?",
        <ModelChoice initial={d.model} onChoose={(m) => {
          set({ model: m as Draft["model"] });
          go(1, { ...d, model: m as Draft["model"] });
        }} />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "capability":
      return screen(
        "The capability it advertises",
        <CapabilityFields offer={d.offer} onSubmit={(offer) => {
          set({ offer });
          go(1, { ...d, offer });
        }} />,
      );
    case "budgets":
      return screen(
        "Budgets",
        <BudgetFields initial={d.budgets} onSubmit={(b) => {
          set({ budgets: b });
          go(1, { ...d, budgets: b });
        }} />,
      );
    case "room":
      return <RoomScreen rooms={rooms} screen={screen} allowNone onDone={(room) => {
        set({ room });
        go(1, { ...d, room });
      }} />;
    case "review": {
      // The COMPLETE proposed agent.md, rendered exactly as the create step
      // will write it (a new room's handle does not exist yet, so its binding
      // previews as the commented block). j/k scroll it; esc walks back into
      // any pre-answered screen to edit.
      let preview: string[];
      try {
        preview = renderAgentMd({
          name: d.name,
          kind: d.kind,
          room: d.room && "handle" in d.room ? d.room.handle : null,
          model: d.model,
          knowledge: d.knowledge?.type === "folder" && d.knowledge.value ? knowledgeRelativeToPack(h, d.name, d.knowledge.value) : undefined,
          tool: d.tool ?? undefined,
          mode: d.kind === "tool" ? d.mode : undefined,
          offer: d.offer,
          budgets: d.budgets,
          description: d.description ?? undefined,
          prompt: d.prompt ?? undefined,
        }).split("\n");
      } catch (err) {
        preview = [`the preview could not render: ${(err as Error).message}`];
      }
      const WINDOW = 16;
      const at = Math.min(previewAt, Math.max(0, preview.length - WINDOW));
      return (
        <WizardFrame
          heading="new agent"
          counter={`${asked.indexOf("review") + 1}/${asked.length}`}
          hubName={h.manifest.name}
          label="Create it?"
          why={{ title: `agents/${d.name}/agent.md · ${at + 1}–${Math.min(at + WINDOW, preview.length)} of ${preview.length}`, lines: preview.slice(at, at + WINDOW) }}
          footer={[["enter", "create"], ["esc", "back to edit"], ["j/k", "the file"]]}
        >
          <Box flexDirection="column">
            {draftMeta ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text>
                  <Text color={ACCENT}>drafted</Text>
                  <Text dimColor> by {draftMeta.model} · {fmtUsd(draftMeta.cost)}{draftMeta.rounds > 1 ? ` · ${draftMeta.rounds} rounds` : ""}{draftMeta.reasoning ? ` · ${draftMeta.reasoning}` : ""}</Text>
                </Text>
                {draftMeta.notes.map((n) => (
                  <Text key={n} color={WARN} wrap="wrap">
                    ! {n}
                  </Text>
                ))}
              </Box>
            ) : null}
            {measured.length || npmFact ? (
              <Box flexDirection="column" marginBottom={1}>
                {measured.map((f) => (
                  <Text key={f.text} color={f.ok ? GOOD : WARN} wrap="wrap">
                    {f.ok ? "✔" : "!"} {f.text}
                  </Text>
                ))}
                {npmFact ? (
                  <Text color={/did NOT/.test(npmFact) ? WARN : MUTED} wrap="wrap">
                    {npmFact}
                  </Text>
                ) : null}
              </Box>
            ) : null}
            {[
              ["name", d.name],
              ["kind", d.kind],
              ...(d.description ? [["description", d.description]] : []),
              ...(d.kind === "answerer" ? [["knowledge", d.knowledge?.type === "later" || !d.knowledge ? "later" : `${d.knowledge.type}: ${d.knowledge.value}${d.knowledge.docs ? ` (${d.knowledge.docs})` : ""}`]] : []),
              ...(d.kind === "tool" ? [["server", d.tool ? `${d.tool.server}${d.tool.builtin ? " (built in)" : ` = ${[d.tool.command, ...(d.tool.args ?? [])].join(" ")}`} · tool ${d.tool.tool}` : "-"], ["mode", d.mode]] : []),
              ["model", d.model],
              ["capability", `${d.offer.id}: ${d.offer.description}`],
              ["budgets", `$${d.budgets.per_task_usd.toFixed(2)} per task · $${d.budgets.per_day_usd.toFixed(2)} per day · ${d.budgets.max_turns} turns`],
              ["room", d.room ? ("create" in d.room ? `new: ${d.room.create.alias}` : d.room.alias) : "none yet (rfa agent bind later)"],
              ["prompt", d.prompt ? `drafted from your description (${d.prompt.split("\n").length} lines, in the panel)` : "the kind's template"],
            ].map(([k, v]) => (
              <Box key={k}>
                <Box width={12}>
                  <Text dimColor>{k}</Text>
                </Box>
                <Text wrap="wrap">{v}</Text>
              </Box>
            ))}
          </Box>
        </WizardFrame>
      );
    }
    case "create":
      return screen(
        failure ? "stopped" : "writing",
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Box key={i} flexDirection="column">
              <Text>
                <Text color={l.ok ? GOOD : WARN}>{l.ok ? "✔" : "!"}</Text> {l.text}
              </Text>
              {l.detail ? <Text dimColor>    {l.detail}</Text> : null}
            </Box>
          ))}
          {!failure && !created ? <Spin label="…" /> : null}
          {failure ? <Text color={BAD}>✖ {failure}</Text> : null}
        </Box>,
        failure ? [["enter", "leave"]] : [],
      );
    case "ask":
      if (!created || !askRoom) return screen("…", <Spin label="…" />, []);
      return <AskScreen ctx={props.ctx} h={h} room={askRoom} agent={created.name} skill={created.skill} dir={created.dir} screen={screen} onDone={() => setStep("done")} />;
    case "done":
      return screen(
        `${created?.name} is ready`,
        <Box flexDirection="column">
          {[
            ["rfa agent show " + (created?.name ?? ""), "everything the pack declares"],
            [created?.room ? `rfa ask --capability ${created.skill} "…"` : `rfa agent bind ${created?.name ?? ""} --room <alias>`, created?.room ? "ask it, from anywhere in this folder" : "bind it to a room so it serves"],
            ...(d.kind === "tool" ? [[`rfa agent mode ${created?.name ?? ""}`, "ask, plan or bypass"]] : []),
            ...(d.tool?.envSecrets?.length ? [[`rfa secrets set ${d.tool.envSecrets[0]}`, `${d.tool.server} runs in dry-run mode until it has this`]] : []),
            [`rfa agent edit ${created?.name ?? ""}`, "change any of this later, on the same screens"],
            ["rfa", "the dashboard"],
          ].map(([c, w]) => (
            <Box key={c}>
              <Box width={44}>
                <Text color={ACCENT} wrap="truncate-end">
                  {c}
                </Text>
              </Box>
              <Text dimColor>{w}</Text>
            </Box>
          ))}
        </Box>,
        [["enter", "done"]],
      );
  }
}

// ---------------------------------------------------------------- describe-first

/**
 * The intake (RFA-0.7 sect. 13.7; made CONVERSATIONAL 2026-08-31): one free-text
 * question, then a model call that returns either the whole pack or one-to-three
 * follow-up questions when the description underdetermines it - which sources,
 * acting or answering, which credential. Answers feed the next round; at most
 * MAX_DRAFT_ROUNDS calls, the last one forced to conclude. The cost accumulates
 * across rounds and is rendered on every path, the failed one included (a
 * failed draft still spent the money). Blank skips to the plain walkthrough; so
 * does a failed draft, loudly. The call site with its RFA-0.9 sect. 6
 * declarations is `src/cli/draftpack.ts`.
 */
export function DescribeScreen(props: { screen: Screen; hubRoot: string; fixedName?: string; taken: string[]; onSkip: () => void; onDrafted: (p: PackDraft, cost: number, model: string, rounds: number) => void }): React.JSX.Element {
  const [phase, setPhase] = useState<"input" | "drafting" | "questions" | "failed">("input");
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [pending, setPending] = useState<DraftQuestion[]>([]);
  const [asked, setAsked] = useState(0);
  const [round, setRound] = useState(0);
  const [spent, setSpent] = useState(0);
  useInput(
    (_, key) => {
      if (key.return) props.onSkip();
    },
    { isActive: phase === "failed" },
  );

  const run = (desc: string, transcript: { question: string; answer: string }[], nextRound: number, costSoFar: number) => {
    setPhase("drafting");
    setRound(nextRound);
    void draftRound({
      description: desc,
      answers: transcript,
      fixedName: props.fixedName,
      taken: props.taken,
      hubRoot: props.hubRoot,
      finalRound: nextRound >= MAX_DRAFT_ROUNDS,
    })
      .then((r) => {
        const total = costSoFar + r.cost_usd;
        setSpent(total);
        if (r.draft) return props.onDrafted(r.draft, total, r.model, nextRound);
        setPending(r.questions);
        setAsked(0);
        setPhase("questions");
      })
      .catch((err) => {
        setSpent(costSoFar + (err instanceof DraftError ? err.cost_usd : 0));
        setError((err as Error).message);
        setPhase("failed");
      });
  };

  if (phase === "drafting") {
    return props.screen(
      round > 1 ? `Drafting, round ${round} of ${MAX_DRAFT_ROUNDS}` : "Drafting the pack",
      <Spin label={`${round > 1 ? "your answers feed the next draft" : "one model call composes the whole proposal"}${spent > 0 ? ` · ${fmtUsd(spent)} spent so far` : ""}`} />,
      [],
    );
  }
  if (phase === "questions") {
    const q = pending[asked];
    return props.screen(
      `The draft needs to know (${asked + 1}/${pending.length})`,
      <Box flexDirection="column">
        {answers.slice(-3).map((a) => (
          <Text key={a.question} dimColor wrap="wrap">
            {a.question} → {a.answer}
          </Text>
        ))}
        <Text wrap="wrap">{q.question}</Text>
        {q.why ? (
          <Text dimColor wrap="wrap">
            {q.why}
          </Text>
        ) : null}
        <Field
          key={`q-${round}-${asked}`}
          value=""
          placeholder={q.placeholder ?? "one line"}
          allowEmpty
          validate={() => null}
          onSubmit={(v) => {
            // Blank means "you decide": recorded as such, so the model stops
            // asking rather than re-asking what the operator declined to answer.
            const a = [...answers, { question: q.question, answer: v || "(no preference - you decide)" }];
            setAnswers(a);
            if (asked + 1 < pending.length) return setAsked(asked + 1);
            run(description, a, round + 1, spent);
          }}
        />
      </Box>,
      [["enter", "answer"], ["blank enter", "you decide"]],
    );
  }
  if (phase === "failed") {
    return props.screen(
      "The draft failed",
      <Box flexDirection="column">
        <Text color={BAD} wrap="wrap">
          ✖ {error}
        </Text>
        {spent > 0 ? <Text dimColor>{fmtUsd(spent)} was spent on the failed draft{round > 1 ? ` (${round} rounds)` : ""}.</Text> : null}
        <Text dimColor wrap="wrap">
          The walkthrough asks everything the draft would have filled in.
        </Text>
      </Box>,
      [["enter", "answer the questions instead"]],
    );
  }
  return props.screen(
    "Describe the agent: what should it do, from what, for whom?",
    <Box flexDirection="column">
      {props.fixedName ? <Text dimColor>name: {props.fixedName}</Text> : null}
      <Field
        key="describe"
        value=""
        placeholder="answers billing questions from ./docs/handbook, for the support team"
        allowEmpty
        validate={() => null}
        onSubmit={(v) => {
          if (!v) return props.onSkip();
          setDescription(v);
          run(v, [], 1, 0);
        }}
      />
    </Box>,
    [["enter", "draft it"], ["blank enter", "just the questions"]],
  );
}

/**
 * The server step, ADAPTIVE (2026-08-31): a builtin brings its own secrets and
 * sandbox; a custom command gets two more questions the static screen never
 * asked - the secret NAMES the server needs, and the hosts its own sandbox may
 * reach (RFA-0.9 sect. 5.4: this platform spawns the server, so the definition
 * must say what its sandbox permits; the old placeholder api.example.com
 * shipped a policy the scaffold invented).
 */
export function ServerScreen(props: { screen: Screen; initial?: ToolSpec; onDone: (t: ToolSpec) => void }): React.JSX.Element {
  const [spec, setSpec] = useState<ToolSpec | null>(null);
  const [secrets, setSecrets] = useState<string[] | null>(null);
  if (spec === null) {
    return props.screen(
      "The MCP server it acts through",
      <ToolServerFields initial={props.initial} onSubmit={(t) => {
        // A builtin ships its secrets and sandbox; nothing more to ask.
        if (t.builtin) return props.onDone(t);
        setSpec(t);
      }} />,
      [["enter", "next"], ["esc", "back"]],
    );
  }
  if (secrets === null) {
    return props.screen(
      "Secret NAMES the server needs (comma-separated, blank for none)",
      <Field
        key="srv-secrets"
        value={(props.initial?.envSecrets ?? []).join(", ")}
        placeholder="SERVICE_API_KEY"
        allowEmpty
        validate={(v) => (v.split(",").every((x) => !x.trim() || /^[A-Z][A-Z0-9_]*$/.test(x.trim())) ? null : "UPPER_SNAKE names; values go in rfa secrets set, never here")}
        onSubmit={(v) => setSecrets(v.split(",").map((x) => x.trim()).filter(Boolean))}
      />,
      [["enter", "next"], ["esc", "back"]],
    );
  }
  return props.screen(
    "Hosts the server's sandbox may reach (comma-separated, blank for none)",
    <Field
      key="srv-domains"
      value={(props.initial?.sandbox?.allowedDomains ?? []).join(", ")}
      placeholder="api.service.com"
      allowEmpty
      validate={(v) => (v.split(",").every((x) => !x.trim() || /^[a-z0-9.*-]+$/i.test(x.trim())) ? null : "host names, like api.service.com")}
      onSubmit={(v) => {
        const domains = v.split(",").map((x) => x.trim()).filter(Boolean);
        props.onDone({ ...spec, envSecrets: secrets, sandbox: { network: domains.length ? "allowlist" : "none", allowedDomains: domains, allowWrite: ["state/drafts"] } });
      }}
    />,
    [["enter", "next"], ["esc", "back"]],
  );
}

/**
 * Joined, honestly: the resident's own state/member.json names the room it
 * serves and its heartbeat says it is alive now. Both are the running system's
 * record, never the file the operator edited.
 */
async function waitForResident(dir: string, room: string, deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "state", "member.json"), "utf8")) as { room?: string };
      const hb = Number(fs.readFileSync(path.join(dir, "state", "heartbeat"), "utf8"));
      if (m.room === room && Date.now() - hb < 90_000) return true;
    } catch {
      /* not joined yet */
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** The offered first ask: creation ends at a working answer, not a folder. Blank skips. */
function AskScreen(props: { ctx: CliContext; h: HubDir; room: RoomRecord; agent: string; skill: string; dir: string; screen: Screen; onDone: () => void }): React.JSX.Element {
  const [phase, setPhase] = useState<"input" | "waiting" | "asking" | "answered" | "failed">("input");
  const [question, setQuestion] = useState("");
  const [outcome, setOutcome] = useState<AskOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alias = props.room.alias ?? props.room.handle;
  useInput(
    (_, key) => {
      if (key.return || key.escape) props.onDone();
    },
    { isActive: phase === "answered" || phase === "failed" },
  );
  const submit = (v: string) => {
    if (!v) return props.onDone();
    setQuestion(v);
    setPhase("waiting");
    void (async () => {
      try {
        if (!(await waitForResident(props.dir, props.room.handle, 90_000))) {
          throw new Error(`${props.agent} has not joined after 90 seconds; rfa status says why. Ask later: rfa ask --capability ${props.skill} "…"`);
        }
        setPhase("asking");
        let o: AskOutcome;
        try {
          o = await askInRoom(props.ctx, props.h, props.room, props.skill, v, { timeoutMs: 180_000 });
        } catch (err) {
          // member.json lands a beat before the card is on the roster the asker
          // reads; one settle-and-retry covers the gap, anything else is real.
          if (!/offers/.test((err as Error).message)) throw err;
          await new Promise((r) => setTimeout(r, 4000));
          o = await askInRoom(props.ctx, props.h, props.room, props.skill, v, { timeoutMs: 180_000 });
        }
        setOutcome(o);
        setPhase("answered");
      } catch (err) {
        setError((err as Error).message);
        setPhase("failed");
      }
    })();
  };
  if (phase === "input") {
    return props.screen(
      `${props.agent} is joining ${alias}. Ask it something?`,
      <Field key="ask" value="" placeholder="blank to skip" allowEmpty validate={() => null} onSubmit={submit} />,
      [["enter", "ask"], ["blank enter", "skip"]],
    );
  }
  if (phase === "waiting" || phase === "asking") {
    return props.screen(
      "The first answer",
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">
          "{question}"
        </Text>
        <Box marginTop={1}>
          <Spin label={phase === "waiting" ? `waiting for ${props.agent} to join ${alias} (the supervisor picks it up within 30s)` : `${props.agent} is answering`} />
        </Box>
      </Box>,
      [],
    );
  }
  if (phase === "failed") {
    return props.screen(
      "The ask did not land",
      <Text color={BAD} wrap="wrap">
        ✖ {error}
      </Text>,
      [["enter", "continue"]],
    );
  }
  const o = outcome!;
  const answerLines = o.text.split("\n");
  return props.screen(
    `${o.target} ${o.kind === "response" ? "answered" : "refused"}`,
    <Box flexDirection="column">
      <Text dimColor>
        {fmtMs(o.elapsed_ms)} · {fmtUsd(o.cost_usd)}
        {o.run_id ? ` · ${o.run_id}` : ""}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {answerLines.slice(0, 14).map((l, i) => (
          <Text key={i} wrap="wrap">
            {l}
          </Text>
        ))}
        {answerLines.length > 14 ? <Text color={MUTED}>… the rest is in the room: rfa room tail {alias}</Text> : null}
      </Box>
    </Box>,
    [["enter", "continue"]],
  );
}

// ---------------------------------------------------------------- the screens, shared with rfa agent edit

export function ModelChoice(props: { initial?: string; onChoose: (model: string) => void }): React.JSX.Element {
  return (
    <Choice
      initial={props.initial}
      options={[
        { value: "haiku", label: "haiku", hint: "fast, cheap; reads and answers" },
        { value: "sonnet", label: "sonnet", hint: "composes and acts" },
        { value: "opus", label: "opus", hint: "the most capable, the most expensive" },
      ]}
      onChoose={props.onChoose}
    />
  );
}

export function ModeChoice(props: { initial?: AgentMode; onChoose: (mode: AgentMode) => void }): React.JSX.Element {
  return <Choice initial={props.initial} options={MODES.map((m) => ({ value: m, label: m, hint: MODE_SUMMARY[m] }))} onChoose={(v) => props.onChoose(v as AgentMode)} />;
}

export function CapabilityFields(props: { offer: { id: string; description: string }; onSubmit: (offer: { id: string; description: string }) => void }): React.JSX.Element {
  return (
    <TwoFields
      first={{ label: "id", value: props.offer.id, placeholder: "answer-question", validate: (v) => (/^[a-z][a-z0-9-]{1,63}$/.test(v) ? null : "lowercase letters, digits and hyphens; make it a verb") }}
      second={{ label: "description", value: props.offer.description, validate: (v) => (v.length >= 8 ? null : "a sentence an asker can match on") }}
      onSubmit={(id, description) => props.onSubmit({ id, description })}
    />
  );
}

/**
 * What an answerer reads: a folder, a git repository, or later. With `keep`
 * set (the edit walkthrough) the first choice keeps what the pack reads today.
 */
export function KnowledgeScreen(props: { screen: Screen; keep?: string; onDone: (k: Draft["knowledge"]) => void }): React.JSX.Element {
  const [type, setType] = useState<"folder" | "git" | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  if (type === null) {
    return props.screen(
      props.keep ? "Add to what it reads?" : "What does it answer from?",
      <Choice
        initial={props.keep ? "later" : undefined}
        options={[
          ...(props.keep ? [{ value: "later", label: props.keep, hint: "nothing added" }] : []),
          { value: "folder", label: "a folder of markdown", hint: "attached as a glob, nothing copied" },
          { value: "git", label: "a git repository", hint: "cloned under the pack and tracked" },
          ...(props.keep ? [] : [{ value: "later", label: "later", hint: "fill knowledge/ or rfa knowledge add" }]),
        ]}
        onChoose={(v) => (v === "later" ? props.onDone({ type: "later" }) : setType(v as "folder" | "git"))}
      />,
      [["enter", "choose"], ["esc", "back"]],
    );
  }
  if (type === "folder") {
    return props.screen("The folder", <Field key="folder" value="" placeholder="./docs" validate={(v) => (fs.existsSync(path.resolve(v)) ? null : `no such folder: ${v}`)} onSubmit={(v) => props.onDone({ type: "folder", value: path.resolve(v) })} />);
  }
  if (remote === null) {
    return props.screen("The git remote", <Field key="remote" value="" placeholder="git@host:org/handbook.git" validate={(v) => (isGitRemote(v) ? null : "a git URL (git@…, https://…, file://…)")} onSubmit={(v) => setRemote(v)} />);
  }
  return props.screen(
    "The folder inside it that holds the documents (blank for the root)",
    <Field key="docs" value="" placeholder="src/content/docs" allowEmpty validate={() => null} onSubmit={(v) => props.onDone({ type: "git", value: remote, docs: v || undefined })} />,
  );
}

/** Which room: a recorded one (the current binding marked, when there is one), a new one, or none when the caller allows it. */
export function RoomScreen(props: { rooms: { alias: string; handle: string; topic: string }[]; screen: Screen; current?: string; allowNone?: boolean; onDone: (room: Draft["room"]) => void }): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [alias, setAlias] = useState<string | null>(null);
  if (!creating) {
    return props.screen(
      "Which room does it serve in?",
      <Choice
        initial={props.current}
        options={[
          ...props.rooms.map((r) => ({ value: r.handle, label: r.alias, hint: `${r.handle === props.current ? "bound today · " : ""}${r.handle} · ${r.topic}` })),
          { value: "__new", label: "a new room", hint: "created now, you host it" },
          ...(props.allowNone ? [{ value: "__none", label: "none yet", hint: "rfa agent bind later" }] : []),
        ]}
        onChoose={(v) => {
          if (v === "__new") return setCreating(true);
          if (v === "__none") return props.onDone(null);
          const r = props.rooms.find((x) => x.handle === v)!;
          props.onDone({ handle: r.handle, alias: r.alias });
        }}
      />,
      [["enter", "choose"], ["esc", "back"]],
    );
  }
  if (alias === null) {
    return props.screen("The new room's alias", <Field key="alias" value="" placeholder="product" validate={(v) => (/^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? (props.rooms.some((r) => r.alias === v) ? "taken" : null) : "lowercase letters, digits, hyphens")} onSubmit={(v) => setAlias(v)} />);
  }
  return props.screen("Its topic", <Field key="topic" value="" placeholder="questions and work for the product team" validate={(v) => (v.length >= 3 ? null : "a few words")} onSubmit={(v) => props.onDone({ create: { alias, topic: v } })} />);
}

export function TwoFields(props: { first: { label: string; value: string; placeholder?: string; validate: (v: string) => string | null }; second: { label: string; value: string; placeholder?: string; validate: (v: string) => string | null }; onSubmit: (a: string, b: string) => void }): React.JSX.Element {
  const [a, setA] = useState<string | null>(null);
  if (a === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{props.first.label}</Text>
        <Field key="first" value={props.first.value} placeholder={props.first.placeholder} validate={props.first.validate} onSubmit={(v) => setA(v)} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {props.first.label}: {a}
      </Text>
      <Text dimColor>{props.second.label}</Text>
      <Field key="second" value={props.second.value} placeholder={props.second.placeholder} validate={props.second.validate} onSubmit={(v) => props.onSubmit(a, v)} />
    </Box>
  );
}

export function BudgetFields(props: { initial: Draft["budgets"]; onSubmit: (b: Draft["budgets"]) => void }): React.JSX.Element {
  const [task, setTask] = useState<number | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const money = (v: string) => (/^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0 ? null : "dollars, like 0.25");
  if (task === null) return <Labeled label="per task, in dollars"><Field key="task" value={props.initial.per_task_usd.toFixed(2)} validate={money} onSubmit={(v) => setTask(Number(v))} /></Labeled>;
  if (day === null) return <Labeled label={`per task $${task.toFixed(2)} · per day, in dollars`}><Field key="day" value={props.initial.per_day_usd.toFixed(2)} validate={(v) => money(v) ?? (Number(v) >= task ? null : "at least the per-task ceiling")} onSubmit={(v) => setDay(Number(v))} /></Labeled>;
  return (
    <Labeled label={`per task $${task.toFixed(2)} · per day $${day.toFixed(2)} · max turns per answer`}>
      <Field key="turns" value={String(props.initial.max_turns)} validate={(v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 200 ? null : "1 to 200")} onSubmit={(v) => props.onSubmit({ per_task_usd: task, per_day_usd: day, max_turns: Number(v) })} />
    </Labeled>
  );
}

export function Labeled(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>{props.label}</Text>
      {props.children}
    </Box>
  );
}

export async function runAgentWizard(ctx: CliContext, h: HubDir, opts: { name?: string } = {}): Promise<number> {
  // The credential check runs once, before render: the describe screen exists
  // only when a draft is possible at all (no credential = the plain walkthrough).
  const draftable = draftAvailable(ctx.env);
  const app = render(<AgentWizard ctx={ctx} hub={h} initialName={opts.name} draftable={draftable} />, { exitOnCtrlC: false, patchConsole: true });
  const result = (await app.waitUntilExit()) as WizardResult | undefined;
  if (!result) return 2;
  if (result.created) ctx.ui.done(`agents/${result.created}/agent.md written`, `rfa agent show ${result.created}`);
  return result.code;
}
