/**
 * The agent walkthrough (RFA-0.7 sect. 13.5): what `rfa agent new` opens on a
 * terminal when no name is given, and what `n` on the dashboard runs. One
 * question per screen with the reason beside it, every setting a pack has
 * (kind, what it reads or acts through, its mode, model, capability, budgets,
 * room), a review screen, then the same `scaffoldPack` the one-line command
 * uses. The flags of `rfa agent new` stay the headless form of every answer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { daemonState } from "../../daemon.js";
import type { HubDir } from "../../hubdir.js";
import { cloneNameFor, isGitRemote, syncClone } from "../../knowledge-sources.js";
import { MODE_SUMMARY, MODES, type AgentMode } from "../../posture.js";
import { addKnowledge } from "../agentmd.js";
import { createRoomRecord } from "../commands/init.js";
import type { CliContext } from "../context.js";
import { BUILTIN_SERVERS, nameProblem, PACK_KINDS, scaffoldPack, type PackKind, type ToolSpec } from "../scaffold.js";
import { recordedRooms } from "./data.js";
import { Mark } from "./logo.js";
import { Field, ToolServerFields } from "./onboarding.js";
import { ACCENT, BAD, GOOD, MUTED, WARN } from "./theme.js";
import { Choice, Keys, Panel, Spin } from "./widgets.js";

export interface WizardResult {
  code: number;
  created: string | null;
}

export type Step = "name" | "kind" | "knowledge" | "server" | "mode" | "model" | "capability" | "budgets" | "room" | "review" | "create" | "done";
const ORDER: Step[] = ["name", "kind", "knowledge", "server", "mode", "model", "capability", "budgets", "room", "review", "create", "done"];

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
}

export function defaultDraft(): Draft {
  return { name: "", kind: "answerer", knowledge: null, tool: null, mode: "ask", model: "haiku", offer: { id: "answer-question", description: "" }, budgets: { per_task_usd: 0.25, per_day_usd: 3, max_turns: 8 }, room: null };
}

/** The defaults that follow from the kind, applied when the kind is chosen. */
export function forKind(d: Draft, kind: PackKind): Draft {
  const offer = kind === "tool" ? { id: `${d.name}-action`, description: `Performs the ${d.name} action after a human approves it.` } : kind === "spec-expert" ? { id: "answer-protocol-question", description: "Answers a question about the RFA protocol from the specification, citing the section." } : { id: "answer-question", description: `Answers a question from the ${d.name} knowledge pack, citing its source.` };
  const budgets = kind === "tool" ? { per_task_usd: 1, per_day_usd: 5, max_turns: 20 } : { per_task_usd: 0.25, per_day_usd: 3, max_turns: 8 };
  return { ...d, kind, offer, budgets, model: kind === "tool" ? "sonnet" : "haiku", knowledge: kind === "answerer" ? d.knowledge : null, tool: kind === "tool" ? d.tool : null };
}

export function applicableStep(step: Step, d: Draft): boolean {
  if (step === "knowledge") return d.kind === "answerer";
  if (step === "server" || step === "mode") return d.kind === "tool";
  return true;
}

export function nextStep(from: Step, d: Draft, dir: 1 | -1 = 1): Step {
  let i = ORDER.indexOf(from) + dir;
  while (i > 0 && i < ORDER.length && !applicableStep(ORDER[i], d)) i += dir;
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, i))];
}

const WHY: Record<Step, { title: string; lines: string[] }> = {
  name: { title: "the name", lines: ["Lowercase, no spaces: it is the folder under agents/ and the name the room sees.", "Reserved first words (human, console, system, hub, rfa) are refused here rather than at join."] },
  kind: { title: "three kinds of pack", lines: ["An answerer reads markdown and answers with citations; it has no side effects.", "A tool user acts through an MCP server; every acting call pauses for a human unless you set its mode otherwise.", "A spec-expert answers about the RFA protocol from the spec shipped in this package; a demo, not a colleague."] },
  knowledge: { title: "what it answers from", lines: ["A folder is attached as a glob; nothing is copied.", "A git repository is cloned under the pack and tracked: provenance for free, fresh on every push, no credential at answer time.", "Later: fill agents/<name>/knowledge/ or run rfa knowledge add."] },
  server: { title: "what it acts through", lines: ["A built-in server ships in this package and starts beside the agent.", "Any MCP server works: a command and the tool id to gate.", "Secrets are names; the supervisor injects their values from .rfa/secrets.json."] },
  mode: { title: "how it acts", lines: ["ask pauses every acting tool on a card you decide.", "plan proposes and never acts: the answer is the plan.", "auto lets the SDK decide; so far it has approved everything, so treat it as bypass with a second opinion.", "bypass acts without asking; the room gate, budgets, hold and quarantine still apply."] },
  model: { title: "the model", lines: ["haiku: fast and cheap; enough to read knowledge and answer with citations.", "sonnet: composes and acts; the default for a tool user.", "opus: the most capable and the most expensive; for reasoning that keeps failing on sonnet.", "Budgets cap the spend whatever the model."] },
  capability: { title: "what it advertises", lines: ["Discovery is by capability, never by name: the id is what an asker matches on (rfa ask --capability).", "Make it a verb. Two agents may offer the same id; the asker picks."] },
  budgets: { title: "the ceilings", lines: ["per task: the most one answer may cost; the SDK stops the turn there.", "per day: the pack's daily total; answers are refused past it.", "max turns: how many model turns one answer may take before it is cut off."] },
  room: { title: "where it serves", lines: ["Rooms are the isolation unit: everyone in a room sees everything in it.", "A pack bound to a room joins it with the operator bearer; no secret to paste.", "One capability per room keeps rfa ask unambiguous."] },
  review: { title: "what will be written", lines: ["agents/<name>/agent.md: the whole definition, validated through the supervisor's own schema before it is written.", "A running supervisor picks the pack up within 30 seconds."] },
  create: { title: "", lines: [] },
  done: { title: "", lines: [] },
};

export function AgentWizard(props: { ctx: CliContext; hub: HubDir }): React.JSX.Element {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const h = props.hub;
  const [step, setStep] = useState<Step>("name");
  const [d, setD] = useState<Draft>(defaultDraft);
  const [lines, setLines] = useState<{ ok: boolean; text: string; detail?: string }[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; skill: string; room: string | null } | null>(null);
  const started = useRef(false);
  const rooms = useMemo(() => recordedRooms(h).filter((r) => r.alias !== "ops"), [h]);

  const go = (dir: 1 | -1, draft = d) => setStep((s) => nextStep(s, draft, dir));
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return exit({ code: 2, created: null } satisfies WizardResult);
      if (step === "done" && (key.return || input === "q" || key.escape)) return exit({ code: 0, created: created?.name ?? null } satisfies WizardResult);
      if (step === "create" && failure && (key.return || input === "q" || key.escape)) return exit({ code: 1, created: null } satisfies WizardResult);
      if (step === "review" && key.return) return setStep("create");
      if (key.escape && step !== "create" && step !== "done") return go(-1);
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
        });
        say(true, `agents/${d.name}/agent.md`, `definition ${res.definitionHash.slice(7, 15)} · offers ${res.skillId}${roomHandle ? "" : " · not bound to a room yet"}`);
        if (d.knowledge?.type === "git" && d.knowledge.value) {
          const dir = path.join(res.dir, "knowledge", cloneNameFor(d.knowledge.value));
          const r = syncClone(dir, d.knowledge.value, { stdio: "pipe" });
          const docs = (d.knowledge.docs ?? "").replace(/^\/+|\/+$/g, "");
          const base = path.posix.join("knowledge", path.basename(dir), ...docs.split("/").filter(Boolean));
          addKnowledge(path.join(res.dir, "agent.md"), [`${base}/**/*.md`, `${base}/**/*.mdx`]);
          say(true, `cloned ${d.knowledge.value} at ${r.head.slice(0, 10)}`, `attached as ${base}/**; rfa knowledge sync pulls it`);
        }
        const sup = daemonState(h.paths.supervisorPid);
        say(true, sup.alive ? "the supervisor picks it up within 30 seconds" : "nothing is running: rfa up starts it", sup.alive ? "rfa status shows it joining" : undefined);
        setCreated({ name: d.name, skill: res.skillId, room: roomHandle });
        setStep("done");
      } catch (err) {
        setFailure((err as Error).message);
      }
    })();
  }, [step, d, h, props.ctx]);

  const why = WHY[step];
  const narrow = columns < 96;
  const leftWidth = narrow ? Math.max(40, columns - 2) : Math.min(64, Math.floor(columns * 0.56));
  const rightWidth = narrow ? Math.max(40, columns - 2) : Math.max(30, columns - leftWidth - 4);
  const screen = (label: string, body: React.ReactNode, footer?: [string, string][]) => (
    <Box flexDirection="column">
      <Box marginBottom={1} gap={1}>
        <Mark />
        <Text bold>new agent</Text>
        <Text dimColor>
          {" "}
          {ORDER.filter((s) => applicableStep(s, d) && !["create", "done"].includes(s)).indexOf(step) + 1}/{ORDER.filter((s) => applicableStep(s, d) && !["create", "done"].includes(s)).length} · {h.manifest.name}
        </Text>
      </Box>
      <Box gap={narrow ? 0 : 2} flexDirection={narrow ? "column" : "row"}>
        <Panel title={label} active width={leftWidth}>
          {body}
          <Box marginTop={1}>
            <Keys items={footer ?? [["enter", "next"], ["esc", "back"]]} />
          </Box>
        </Panel>
        {why.lines.length ? (
          <Panel title={why.title} width={rightWidth}>
            {why.lines.map((l, i) => (
              <Text key={i} dimColor wrap="wrap">
                {l}
              </Text>
            ))}
          </Panel>
        ) : null}
      </Box>
    </Box>
  );

  switch (step) {
    case "name":
      return screen(
        "Name the agent",
        <Field key="name" value={d.name} placeholder="pm-agent" validate={(v) => nameProblem(v) ?? (fs.existsSync(path.join(h.paths.agents, v, "agent.md")) ? `agents/${v} already exists` : null)} onSubmit={(v) => {
          const next = forKind({ ...d, name: v }, d.kind);
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
            const next = forKind(d, v as PackKind);
            setD(next);
            go(1, next);
          }}
        />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "knowledge":
      return <KnowledgeScreen d={d} screen={screen} onDone={(k) => {
        set({ knowledge: k });
        go(1, { ...d, knowledge: k });
      }} />;
    case "server":
      return screen(
        "The MCP server it acts through",
        <ToolServerFields initial={d.tool ?? undefined} onSubmit={(t) => {
          set({ tool: t });
          go(1, { ...d, tool: t });
        }} />,
        [["enter", "next"], ["esc", "back"]],
      );
    case "mode":
      return screen(
        "How does it act?",
        <Choice initial={d.mode} options={MODES.map((m) => ({ value: m, label: m, hint: MODE_SUMMARY[m] }))} onChoose={(v) => {
          set({ mode: v as AgentMode });
          go(1, { ...d, mode: v as AgentMode });
        }} />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "model":
      return screen(
        "Which model?",
        <Choice
          initial={d.model}
          options={[
            { value: "haiku", label: "haiku", hint: "fast, cheap; reads and answers" },
            { value: "sonnet", label: "sonnet", hint: "composes and acts" },
            { value: "opus", label: "opus", hint: "the most capable, the most expensive" },
          ]}
          onChoose={(v) => {
            set({ model: v as Draft["model"] });
            go(1, { ...d, model: v as Draft["model"] });
          }}
        />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "capability":
      return screen(
        "The capability it advertises",
        <TwoFields
          first={{ label: "id", value: d.offer.id, placeholder: "answer-question", validate: (v) => (/^[a-z][a-z0-9-]{1,63}$/.test(v) ? null : "lowercase letters, digits and hyphens; make it a verb") }}
          second={{ label: "description", value: d.offer.description, validate: (v) => (v.length >= 8 ? null : "a sentence an asker can match on") }}
          onSubmit={(id, description) => {
            set({ offer: { id, description } });
            go(1, { ...d, offer: { id, description } });
          }}
        />,
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
      return <RoomScreen rooms={rooms} d={d} screen={screen} onDone={(room) => {
        set({ room });
        go(1, { ...d, room });
      }} />;
    case "review":
      return screen(
        "Create it?",
        <Box flexDirection="column">
          {[
            ["name", d.name],
            ["kind", d.kind],
            ...(d.kind === "answerer" ? [["knowledge", d.knowledge?.type === "later" || !d.knowledge ? "later" : `${d.knowledge.type}: ${d.knowledge.value}${d.knowledge.docs ? ` (${d.knowledge.docs})` : ""}`]] : []),
            ...(d.kind === "tool" ? [["server", d.tool ? `${d.tool.server}${d.tool.builtin ? " (built in)" : ` = ${[d.tool.command, ...(d.tool.args ?? [])].join(" ")}`} · tool ${d.tool.tool}` : "-"], ["mode", d.mode]] : []),
            ["model", d.model],
            ["capability", `${d.offer.id}: ${d.offer.description}`],
            ["budgets", `$${d.budgets.per_task_usd.toFixed(2)} per task · $${d.budgets.per_day_usd.toFixed(2)} per day · ${d.budgets.max_turns} turns`],
            ["room", d.room ? ("create" in d.room ? `new: ${d.room.create.alias}` : d.room.alias) : "none yet (rfa agent bind later)"],
          ].map(([k, v]) => (
            <Box key={k}>
              <Box width={12}>
                <Text dimColor>{k}</Text>
              </Box>
              <Text wrap="wrap">{v}</Text>
            </Box>
          ))}
        </Box>,
        [["enter", "create"], ["esc", "back"]],
      );
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
    case "done":
      return screen(
        `${created?.name} is ready`,
        <Box flexDirection="column">
          {[
            ["rfa agent show " + (created?.name ?? ""), "everything the pack declares"],
            [created?.room ? `rfa ask --capability ${created.skill} "…"` : `rfa agent bind ${created?.name ?? ""} --room <alias>`, created?.room ? "ask it, from anywhere in this folder" : "bind it to a room so it serves"],
            ...(d.kind === "tool" ? [[`rfa agent mode ${created?.name ?? ""}`, "ask, plan, auto or bypass"]] : []),
            ...(d.tool?.envSecrets?.length ? [[`rfa secrets set ${d.tool.envSecrets[0]}`, `${d.tool.server} runs in dry-run mode until it has this`]] : []),
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

function KnowledgeScreen(props: { d: Draft; screen: (label: string, body: React.ReactNode, footer?: [string, string][]) => React.JSX.Element; onDone: (k: Draft["knowledge"]) => void }): React.JSX.Element {
  const [type, setType] = useState<"folder" | "git" | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  if (type === null) {
    return props.screen(
      "What does it answer from?",
      <Choice
        options={[
          { value: "folder", label: "a folder of markdown", hint: "attached as a glob, nothing copied" },
          { value: "git", label: "a git repository", hint: "cloned under the pack and tracked" },
          { value: "later", label: "later", hint: "fill knowledge/ or rfa knowledge add" },
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

function RoomScreen(props: { rooms: { alias: string; handle: string; topic: string }[]; d: Draft; screen: (label: string, body: React.ReactNode, footer?: [string, string][]) => React.JSX.Element; onDone: (room: Draft["room"]) => void }): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [alias, setAlias] = useState<string | null>(null);
  if (!creating) {
    return props.screen(
      "Which room does it serve in?",
      <Choice
        options={[
          ...props.rooms.map((r) => ({ value: r.handle, label: r.alias, hint: `${r.handle} · ${r.topic}` })),
          { value: "__new", label: "a new room", hint: "created now, you host it" },
          { value: "__none", label: "none yet", hint: "rfa agent bind later" },
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

function TwoFields(props: { first: { label: string; value: string; placeholder?: string; validate: (v: string) => string | null }; second: { label: string; value: string; placeholder?: string; validate: (v: string) => string | null }; onSubmit: (a: string, b: string) => void }): React.JSX.Element {
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

function BudgetFields(props: { initial: Draft["budgets"]; onSubmit: (b: Draft["budgets"]) => void }): React.JSX.Element {
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

function Labeled(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>{props.label}</Text>
      {props.children}
    </Box>
  );
}

export async function runAgentWizard(ctx: CliContext, h: HubDir): Promise<number> {
  const app = render(<AgentWizard ctx={ctx} hub={h} />, { exitOnCtrlC: false, patchConsole: true });
  const result = (await app.waitUntilExit()) as WizardResult | undefined;
  if (!result) return 2;
  if (result.created) ctx.ui.done(`agents/${result.created}/agent.md written`, `rfa agent show ${result.created}`);
  return result.code;
}

export { MUTED as _unused };
