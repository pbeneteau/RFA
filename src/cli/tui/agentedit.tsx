/**
 * The edit walkthrough (RFA-0.7 sect. 13.7): `rfa agent edit <name>` alone on a
 * terminal, and `e` on the dashboard's Agents tab. The settings a pack has are
 * listed with their current values; pick one, change it on the screen the
 * new-agent walkthrough asks it on, come back to the list; apply writes them
 * through `editPack`, the function behind the command's flags, so the two
 * cannot differ. Nothing touches the disk until apply, and apply writes once.
 */
import * as path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { loadPack, type AgentPack } from "../../agentdef.js";
import { daemonState } from "../../daemon.js";
import type { HubDir, RoomRecord } from "../../hubdir.js";
import type { AgentMode } from "../../posture.js";
import { currentSettings, type PackChanges } from "../agentmd.js";
import { applyPackEdit, editInEditor, type EditOutcome } from "../commands/agent.js";
import type { CliContext } from "../context.js";
import { BudgetFields, CapabilityFields, KnowledgeScreen, ModeChoice, ModelChoice, RoomScreen, WHY, WizardFrame, type Draft, type Screen } from "./agentwizard.js";
import { recordedRooms } from "./data.js";
import { Field } from "./onboarding.js";
import { ACCENT, BAD, GOOD, MUTED, WARN } from "./theme.js";
import { Choice, Spin } from "./widgets.js";

export interface EditDraft {
  description: string;
  model: string;
  offer: { id: string; description: string } | null;
  budgets: { per_task_usd: number; per_day_usd: number; max_turns: number };
  /** Null for a pack with no acting tool: there is nothing a mode would change. */
  mode: AgentMode | null;
  room: Draft["room"];
  /** An ADDITION to what it reads, or null for none; removal is an edit by hand. */
  knowledge: Draft["knowledge"];
}

export type Setting = "description" | "model" | "capability" | "budgets" | "mode" | "room" | "knowledge";
const SETTINGS: Setting[] = ["description", "model", "capability", "budgets", "mode", "room", "knowledge"];

const roomAlias = (r: Draft["room"]): string => (r ? ("create" in r ? `a new room, ${r.create.alias}` : r.alias) : "none");
const roomHandle = (r: Draft["room"]): string | null => (r && "handle" in r ? r.handle : null);

/** The pack as it is, in the draft's shape: what every screen is pre-filled with. */
export function draftFor(pack: AgentPack, rooms: { alias: string; handle: string }[]): EditDraft {
  const s = currentSettings(pack.def);
  const bound = s.room ? rooms.find((r) => r.handle === s.room) : undefined;
  return {
    description: s.description,
    model: s.model,
    offer: s.offer,
    budgets: { per_task_usd: s.budgets.per_task_usd ?? 0.25, per_day_usd: s.budgets.per_day_usd ?? 5, max_turns: s.budgets.max_turns ?? 8 },
    mode: s.mode === "read-only" ? null : s.mode,
    room: s.room ? { handle: s.room, alias: bound?.alias ?? s.room } : null,
    knowledge: null,
  };
}

export interface Diff {
  changes: PackChanges;
  /** One row per changed setting, in the words the review shows: "haiku → sonnet". */
  rows: [Setting, string][];
  newRoom: { alias: string; topic: string } | null;
  knowledge: { source: string; docs?: string } | null;
}

/** What differs between the pack and the draft, as the changes `editPack` takes and the rows the review shows. */
export function changesOf(base: EditDraft, d: EditDraft): Diff {
  const changes: PackChanges = {};
  const rows: [Setting, string][] = [];
  if (d.description !== base.description) {
    changes.description = d.description;
    rows.push(["description", d.description]);
  }
  if (d.model !== base.model) {
    changes.model = d.model;
    rows.push(["model", `${base.model} → ${d.model}`]);
  }
  if (d.offer && (d.offer.id !== base.offer?.id || d.offer.description !== base.offer?.description)) {
    changes.offer = d.offer;
    rows.push(["capability", `${base.offer?.id ?? "none"} → ${d.offer.id}: ${d.offer.description}`]);
  }
  const b = d.budgets;
  const o = base.budgets;
  if (b.per_task_usd !== o.per_task_usd || b.per_day_usd !== o.per_day_usd || b.max_turns !== o.max_turns) {
    changes.budgets = { ...b };
    rows.push(["budgets", `$${o.per_task_usd.toFixed(2)} · $${o.per_day_usd.toFixed(2)} · ${o.max_turns} turns → $${b.per_task_usd.toFixed(2)} per task · $${b.per_day_usd.toFixed(2)} per day · ${b.max_turns} turns`]);
  }
  if (d.mode && d.mode !== base.mode) {
    changes.mode = d.mode;
    rows.push(["mode", `${base.mode ?? "ask"} → ${d.mode}`]);
  }
  let newRoom: Diff["newRoom"] = null;
  if (d.room && "create" in d.room) {
    newRoom = d.room.create;
    rows.push(["room", `${roomAlias(base.room)} → ${roomAlias(d.room)}`]);
  } else if (d.room && "handle" in d.room && d.room.handle !== roomHandle(base.room)) {
    changes.room = d.room.handle;
    rows.push(["room", `${roomAlias(base.room)} → ${d.room.alias}`]);
  }
  let knowledge: Diff["knowledge"] = null;
  if (d.knowledge && d.knowledge.type !== "later" && d.knowledge.value) {
    knowledge = { source: d.knowledge.value, docs: d.knowledge.docs };
    rows.push(["knowledge", `+ ${d.knowledge.type === "git" ? "clone of " : ""}${d.knowledge.value}${d.knowledge.docs ? ` (${d.knowledge.docs})` : ""}`]);
  }
  return { changes, rows, newRoom, knowledge };
}

export interface EditWizardResult {
  code: number;
  /** The walkthrough was left to open agent.md in $EDITOR. */
  editor?: boolean;
  changed?: string[];
}

export function AgentEdit(props: { ctx: CliContext; hub: HubDir; name: string }): React.JSX.Element {
  const { exit } = useApp();
  const h = props.hub;
  const pack = useMemo(() => loadPack(path.join(h.paths.agents, props.name)), [h, props.name]);
  const rooms = useMemo(() => recordedRooms(h).filter((r: RoomRecord) => r.alias !== "ops"), [h]);
  const base = useMemo(() => draftFor(pack, rooms), [pack, rooms]);
  const [d, setD] = useState<EditDraft>(base);
  const [at, setAt] = useState<Setting | "home" | "apply" | "done">("home");
  const [outcome, setOutcome] = useState<EditOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const started = useRef(false);
  const diff = useMemo(() => changesOf(base, d), [base, d]);
  const pending = diff.rows.length;

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return exit({ code: 2 } satisfies EditWizardResult);
      if (at === "done" && (key.return || input === "q" || key.escape)) return exit({ code: 0, changed: outcome?.changed ?? [] } satisfies EditWizardResult);
      if (at === "apply" && failure && (key.return || input === "q" || key.escape)) return exit({ code: 1 } satisfies EditWizardResult);
      if (key.escape && at === "home") return exit({ code: 0, changed: [] } satisfies EditWizardResult);
      if (key.escape && at !== "apply" && at !== "done") return setAt("home");
    },
    { isActive: true },
  );

  // Applying, once: the room and the clone first (they need to exist to be named), then one validated write of agent.md.
  useEffect(() => {
    if (at !== "apply" || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const r = await applyPackEdit(props.ctx, h, props.name, diff.changes, { newRoom: diff.newRoom, knowledge: diff.knowledge });
        setOutcome(r);
        setAt("done");
      } catch (err) {
        setFailure((err as Error).message);
      }
    })();
  }, [at, diff, h, props.ctx, props.name]);

  const set = (patch: Partial<EditDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setAt("home");
  };
  const why = at === "description" ? { title: "the card", lines: ["One sentence on the roster: what this agent does, for whoever reads the room.", "Discovery is by capability, so the sentence is for people; the id an asker matches on is the capability's."] } : at === "home" || at === "apply" || at === "done" ? undefined : WHY[at];
  const screen: Screen = (label, body, footer) => (
    <WizardFrame heading={`edit ${props.name}`} hubName={h.manifest.name} label={label} why={why} footer={footer}>
      {body}
    </WizardFrame>
  );
  const money = (b: EditDraft["budgets"]) => `$${b.per_task_usd.toFixed(2)} per task · $${b.per_day_usd.toFixed(2)} per day · ${b.max_turns} turns`;
  const arrow = (setting: Setting, now: string) => {
    const row = diff.rows.find((r) => r[0] === setting);
    return row ? `${now}  → ${row[1]}` : now;
  };

  switch (at) {
    case "home": {
      const sup = daemonState(h.paths.supervisorPid);
      const options = [
        { value: "description", label: "description", hint: arrow("description", base.description) },
        { value: "model", label: "model", hint: arrow("model", base.model) },
        { value: "capability", label: "capability", hint: arrow("capability", base.offer ? `${base.offer.id}: ${base.offer.description}` : "none (the card advertises nothing)") },
        { value: "budgets", label: "budgets", hint: arrow("budgets", money(base.budgets)) },
        ...(base.mode ? [{ value: "mode", label: "mode", hint: arrow("mode", base.mode) }] : []),
        { value: "room", label: "room", hint: arrow("room", base.room ? roomAlias(base.room) : "none yet") },
        { value: "knowledge", label: "knowledge", hint: arrow("knowledge", `${pack.def.knowledge?.length ?? 0} glob(s)`) },
        { value: "editor", label: "the prompt, and everything else", hint: "agent.md in $EDITOR" },
        ...(pending ? [{ value: "apply", label: `apply ${pending} change${pending === 1 ? "" : "s"}`, hint: sup.alive ? "the supervisor drains and respawns the resident" : "nothing is running; the next rfa up reads it" }] : []),
        { value: "leave", label: pending ? "leave without applying" : "leave", hint: "nothing is written" },
      ];
      return (
        <WizardFrame
          heading={`edit ${props.name}`}
          hubName={h.manifest.name}
          label={pending ? `What else? (${pending} pending)` : "What do you want to change?"}
          why={{ title: pack.name, lines: [`definition ${pack.definitionHash.slice(7, 15)} · ${base.mode ? `a tool user in ${base.mode} mode` : "read-only: no acting tool"}`, "Every change rotates the definition: a running supervisor drains the resident and respawns it on the new one, and the room sees the digest change.", "Pick a setting; esc returns here without it. Nothing is written until apply."] }}
          footer={[["enter", "choose"], ["esc", "leave"]]}
        >
          <Choice key={`home-${pending}`} initial={pending ? "apply" : "description"} options={options} onChoose={(v) => {
            if (v === "apply") return setAt("apply");
            if (v === "leave") return exit({ code: 0, changed: [] } satisfies EditWizardResult);
            if (v === "editor") return exit({ code: 0, editor: true } satisfies EditWizardResult);
            if (SETTINGS.includes(v as Setting)) setAt(v as Setting);
          }} />
        </WizardFrame>
      );
    }
    case "description":
      return screen(
        "The description on its card",
        <Field key="description" value={d.description} validate={(v) => (v.length >= 8 ? null : "a sentence: what it does, for whoever reads the roster")} onSubmit={(v) => set({ description: v })} />,
      );
    case "model":
      return screen("Which model?", <ModelChoice initial={d.model === "inherit" ? undefined : d.model} onChoose={(m) => set({ model: m })} />, [["enter", "choose"], ["esc", "back"]]);
    case "capability":
      return screen("The capability it advertises", <CapabilityFields offer={d.offer ?? { id: "", description: "" }} onSubmit={(offer) => set({ offer })} />);
    case "budgets":
      return screen("Budgets", <BudgetFields initial={d.budgets} onSubmit={(b) => set({ budgets: b })} />);
    case "mode":
      return screen("How does it act?", <ModeChoice initial={d.mode ?? "ask"} onChoose={(m) => set({ mode: m })} />, [["enter", "choose"], ["esc", "back"]]);
    case "room":
      return <RoomScreen rooms={rooms} screen={screen} current={d.room && "handle" in d.room ? d.room.handle : undefined} onDone={(room) => set({ room })} />;
    case "knowledge":
      return <KnowledgeScreen screen={screen} keep={`keep what it reads (${pack.def.knowledge?.length ?? 0} glob(s))`} onDone={(k) => set({ knowledge: k })} />;
    case "apply":
      return screen(
        failure ? "stopped" : "writing",
        <Box flexDirection="column">
          {failure ? <Text color={BAD}>✖ {failure}</Text> : <Spin label="agent.md, validated before it is written" />}
        </Box>,
        failure ? [["enter", "leave"]] : [],
      );
    case "done": {
      const r = outcome!;
      const sup = daemonState(h.paths.supervisorPid);
      return screen(
        r.before === r.after ? `${props.name} is unchanged` : `${props.name} edited`,
        <Box flexDirection="column">
          {diff.rows.map(([k, v]) => (
            <Box key={k}>
              <Box width={12}>
                <Text dimColor>{k}</Text>
              </Box>
              <Text wrap="wrap">{v}</Text>
            </Box>
          ))}
          {r.notes.map((n) => (
            <Text key={n} dimColor wrap="wrap">
              {n}
            </Text>
          ))}
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color={r.before === r.after ? MUTED : GOOD}>{r.before === r.after ? "·" : "✔"}</Text>
              <Text dimColor> definition {r.before.slice(7, 15)}{r.before === r.after ? "" : ` → ${r.after.slice(7, 15)}`}</Text>
            </Text>
            {r.before !== r.after ? <Text color={sup.alive ? WARN : MUTED}>{sup.alive ? "the supervisor drains the resident and respawns it on the new definition; the room sees the digest change" : "nothing is running: the next rfa up reads the new definition"}</Text> : null}
            <Text color={ACCENT}>rfa agent show {props.name}</Text>
          </Box>
        </Box>,
        [["enter", "done"]],
      );
    }
    default:
      return screen(String(at), <Text>…</Text>);
  }
}

export async function runAgentEdit(ctx: CliContext, h: HubDir, name: string): Promise<number> {
  const app = render(<AgentEdit ctx={ctx} hub={h} name={name} />, { exitOnCtrlC: false, patchConsole: true });
  const result = (await app.waitUntilExit()) as EditWizardResult | undefined;
  if (!result) return 2;
  if (result.editor) return editInEditor(ctx, name, path.join(h.paths.agents, name, "agent.md"));
  if (result.changed?.length) ctx.ui.done(`${name} edited: ${result.changed.join(", ")}`, `rfa agent show ${name}`);
  return result.code;
}
