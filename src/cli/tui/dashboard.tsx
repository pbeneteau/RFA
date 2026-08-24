/**
 * The dashboard (RFA-0.7 sect. 11.2): what `rfa` opens in a hub directory.
 *
 * One snapshot refreshed every two seconds, a tab per concern (status,
 * agents, rooms, approvals, the feed, the sitting, the board); single-key verbs
 * that do what the matching command does; a palette for everything else. The
 * conventions are the ones operators already have in their fingers from
 * lazygit and k9s: `?` for help, `:` for a command, j/k or arrows to move,
 * numbers for tabs, q to leave. Every verb here is a thin call into the same
 * code the command line runs, so the dashboard cannot drift from the CLI.
 *
 * The Evals tab is the labelling sitting of RFA-0.5 sect. 20.4 done in place:
 * the review queue `rfa evals label --prepare` would write, judged trace by
 * trace, applied through the same `applySitting` the command's `--apply` uses.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import { TextInput } from "@inkjs/ui";
import { applySitting, flagForReview, reviewQueue, type ApplyResult, type Trace } from "../../evals/label.js";
import type { HubDir, RoomRecord } from "../../hubdir.js";
import type { RfaTask } from "../../model.js";
import type { CliContext } from "../context.js";
import { supervisorCommand } from "../commands/agent.js";
import { downAll, upAll } from "../commands/procs.js";
import type { CommandDef } from "../router.js";
import { askInRoom, followFile, gateView, isOpenTask, offersIn, readBoard, recordedRooms, roomLogFile, snapshot, tailLines, taskAction, type AgentView, type AskOutcome, type Board, type CardView, type FeedLine, type GateView, type Member, type Offer, type RoomView, type Snapshot } from "./data.js";
import { Mark } from "./logo.js";
import { Palette, paletteItems } from "./palette.js";
import { ACCENT, BAD, fmtMs, fmtUsd, GOOD, MUTED, sparkline, WARN } from "./theme.js";
import { Choice, Dot, Empty, Gauge, Key, Keys, Panel, Spin, Table } from "./widgets.js";
import type { RunChild } from "./index.js";

const TABS = ["Overview", "Agents", "Rooms", "Approvals", "Feed", "Evals", "Tasks"] as const;
type Tab = (typeof TABS)[number];
type Overlay =
  | { kind: "palette"; query?: string }
  | { kind: "help" }
  | { kind: "ask"; room: RoomRecord }
  | { kind: "confirm"; text: string; label?: string; run: () => Promise<string> }
  | { kind: "reject"; card: CardView }
  | { kind: "field"; title: string; hint: string; initial: string; placeholder?: string; onSubmit: (value: string) => void }
  | { kind: "answer"; trace: Trace }
  | { kind: "applied"; result: ApplyResult }
  | { kind: "task"; room: RoomRecord; members: Member[] }
  | null;

interface Flash {
  text: string;
  tone: "good" | "bad" | "info";
  at: number;
}

export interface BoardState {
  board: Board | null;
  loaded: boolean;
  error: string | null;
  at: number;
}

// ---------------------------------------------------------------- the sitting's pure parts

/** What a human has decided about one trace so far; the three fields of the worksheet plus the promotion. */
export interface Verdict {
  label: "pass" | "fail" | null;
  gold_source: string | null;
  failure_mode: string | null;
  promote: boolean;
}

export const EMPTY_VERDICT: Verdict = { label: null, gold_source: null, failure_mode: null, promote: false };

/** The queue's verdict column: ✔ or ✖ (or · for none yet), then g for a gold source and c for a case to cut. */
export function verdictMark(v: Verdict | undefined): string {
  const x = v ?? EMPTY_VERDICT;
  return `${x.label === "pass" ? "✔" : x.label === "fail" ? "✖" : "·"}${x.gold_source ? " g" : ""}${x.promote ? " c" : ""}`;
}

export function describeVerdict(v: Verdict | undefined): string {
  const x = v ?? EMPTY_VERDICT;
  if (!x.label) return "none yet: p pass · f fail";
  const parts = [x.label === "fail" ? `fail${x.failure_mode ? `: ${x.failure_mode}` : " (no failure mode named)"}` : "pass"];
  if (x.gold_source) parts.push(`gold source ${x.gold_source}`);
  if (x.promote) parts.push("cut into a case");
  return parts.join(" · ");
}

/** The traces as `applySitting` will receive them: the queue with each verdict written onto its trace. */
export function judgedTraces(traces: Trace[], verdicts: Record<string, Verdict>): Trace[] {
  return traces.map((t) => ({ ...t, ...(verdicts[t.run_id] ?? {}) }));
}

/** What applying would write, said before it is written; null when nothing has been judged. */
export function sittingSummary(traces: Trace[], verdicts: Record<string, Verdict>): { labels: number; passes: number; fails: number; golds: number; cuts: number; text: string } | null {
  const judged = judgedTraces(traces, verdicts).filter((t) => t.label === "pass" || t.label === "fail");
  if (judged.length === 0) return null;
  const passes = judged.filter((t) => t.label === "pass").length;
  const golds = judged.filter((t) => t.gold_source).length;
  const cuts = judged.filter((t) => t.promote).length;
  const left = traces.length - judged.length;
  const text =
    `Apply the sitting: ${judged.length} label${judged.length === 1 ? "" : "s"} (${passes} pass, ${judged.length - passes} fail), ${golds} gold source${golds === 1 ? "" : "s"}, ${cuts} case${cuts === 1 ? "" : "s"} to cut. ` +
    `This writes human feedback rows to .rfa/data/obs.db (no rubric hash: a person judged these)${cuts ? " and cuts the cases under evals/cases/" : ""}.` +
    (left ? ` ${left} unjudged trace${left === 1 ? " is" : "s are"} left for a later sitting.` : "");
  return { labels: judged.length, passes, fails: judged.length - passes, golds, cuts, text };
}

export interface QueueState {
  traces: Trace[];
  alreadyLabelled: number;
  total: number;
  loaded: boolean;
  error: string | null;
}

export function Dashboard(props: { ctx: CliContext; hub: HubDir; commands: CommandDef[]; runChild: RunChild }): React.JSX.Element {
  const { ctx, hub: h } = props;
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const { columns, rows } = useWindowSize();
  const [tab, setTab] = useState<Tab>("Overview");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [sel, setSel] = useState({ agent: 0, room: 0, card: 0, trace: 0, task: 0 });
  const [feedRoom, setFeedRoom] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueueState>({ traces: [], alreadyLabelled: 0, total: 0, loaded: false, error: null });
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [gate, setGate] = useState<GateView | null>(null);
  const [taskRoom, setTaskRoom] = useState<string | null>(null);
  const [boardState, setBoardState] = useState<BoardState>({ board: null, loaded: false, error: null, at: 0 });
  const [allTasks, setAllTasks] = useState(false);
  const paused = useRef(false);
  const items = useMemo(() => paletteItems(props.commands), [props.commands]);
  const rooms = useMemo(() => recordedRooms(h), [h, snap?.at]);

  const say = useCallback((text: string, tone: Flash["tone"] = "info") => setFlash({ text, tone, at: Date.now() }), []);

  // The snapshot: every two seconds, never while the terminal belongs to someone else.
  const refresh = useCallback(async () => {
    if (paused.current) return;
    const s = await snapshot(ctx, h);
    setSnap(s);
  }, [ctx, h]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);
  // Ink clears the screen when the terminal gets narrower, not when it gets
  // shorter; a frame taller than the new window leaves its tail behind. Clear
  // it ourselves on any shrink and let the next render repaint from the top.
  const lastSize = useRef({ columns, rows });
  useEffect(() => {
    if (rows < lastSize.current.rows || columns < lastSize.current.columns) stdout.write("\x1b[2J\x1b[3J\x1b[H");
    lastSize.current = { columns, rows };
  }, [columns, rows, stdout]);

  // The review queue is read when the Evals tab opens and after a sitting is
  // applied, not on the two-second tick: rows that move under a hand that is
  // judging them is how a verdict lands on the wrong trace. R re-reads it.
  const loadQueue = useCallback(() => {
    if (!fs.existsSync(h.paths.obsDb)) {
      setQueue({ traces: [], alreadyLabelled: 0, total: 0, loaded: true, error: "no observability store yet: residents write .rfa/data/obs.db on their first answer" });
    } else {
      try {
        const known = recordedRooms(h);
        const alias = (room: string) => known.find((r) => r.handle === room)?.alias ?? room;
        const q = reviewQueue({ obsDb: h.paths.obsDb, roomLogFile: (room) => roomLogFile(h, room), tailHint: (room) => `rfa room tail ${alias(room)}` });
        setQueue({ ...q, loaded: true, error: null });
      } catch (err) {
        setQueue((prev) => ({ ...prev, loaded: true, error: (err as Error).message }));
      }
    }
    try {
      setGate(gateView(h));
    } catch {
      setGate(null);
    }
  }, [h]);
  useEffect(() => {
    if (tab === "Evals") loadQueue();
  }, [tab, loadQueue]);

  // The board: read when the Tasks tab opens or its room changes, then every
  // three seconds while the hub serves. With the hub down the read opens the
  // store in process, and a store held open at the moment `rfa up` starts the
  // hub would refuse it its lock; so, down, it is read once and on R only.
  const loadBoard = useCallback(
    async (rec: RoomRecord) => {
      if (paused.current) return;
      try {
        const b = await readBoard(ctx, h, rec);
        setBoardState({ board: b, loaded: true, error: null, at: Date.now() });
      } catch (err) {
        setBoardState((s) => ({ ...s, loaded: true, error: (err as Error).message }));
      }
    },
    [ctx, h],
  );
  const run = useCallback(
    async (argv: string[]) => {
      paused.current = true;
      setRecent((r) => [argv.slice(0, 2).join(" "), ...r.filter((x) => x !== argv.slice(0, 2).join(" "))].slice(0, 6));
      await suspendTerminal(async () => {
        await props.runChild(argv);
      });
      paused.current = false;
      void refresh();
    },
    [props, refresh, suspendTerminal],
  );

  const act = useCallback(
    async (label: string, fn: () => Promise<string | void>) => {
      try {
        const out = await fn();
        say(out ?? `${label}: done`, "good");
      } catch (err) {
        say(`${label}: ${(err as Error).message}`, "bad");
      }
      void refresh();
    },
    [refresh, say],
  );

  const setVerdict = useCallback((runId: string, v: Verdict | null) => {
    setVerdicts((all) => {
      const next = { ...all };
      if (v) next[runId] = v;
      else delete next[runId];
      return next;
    });
  }, []);

  const agents = snap?.status?.agents ?? [];
  const roomViews = snap?.status?.rooms ?? [];
  const cards = snap?.approvals ?? [];
  const agent = agents[Math.min(sel.agent, Math.max(0, agents.length - 1))];
  const roomView = roomViews[Math.min(sel.room, Math.max(0, roomViews.length - 1))];
  const card = cards[Math.min(sel.card, Math.max(0, cards.length - 1))];
  const traceIndex = Math.min(sel.trace, Math.max(0, queue.traces.length - 1));
  const trace = queue.traces[traceIndex];
  const aliasOf = (handle: string | null | undefined) => rooms.find((r) => r.handle === handle)?.alias ?? handle ?? "-";
  const defaultRoom = rooms.find((r) => r.alias !== "ops") ?? rooms[0] ?? null;
  const roomByHandle = (handle: string | undefined) => rooms.find((r) => r.handle === handle) ?? null;
  const toLabel = snap?.review?.queued ?? 0;
  const openTasks = roomViews.reduce((n, r) => n + (r.open_tasks ?? 0), 0);
  const taskRec = (taskRoom ? roomByHandle(taskRoom) : null) ?? defaultRoom;
  const shownTasks = (boardState.board?.tasks ?? []).filter((t) => allTasks || isOpenTask(t));
  const taskIndex = Math.min(sel.task, Math.max(0, shownTasks.length - 1));
  const task = shownTasks[taskIndex];
  const hubUp = Boolean(snap?.status?.hub.healthy);
  useEffect(() => {
    if (tab !== "Tasks" || !taskRec) return;
    void loadBoard(taskRec);
    if (!hubUp) return;
    const t = setInterval(() => void loadBoard(taskRec), 3000);
    return () => clearInterval(t);
  }, [tab, taskRec, hubUp, loadBoard]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return exit({ code: 0 });
      if (input === "q") return exit({ code: 0 });
      if (input === "?") return setOverlay({ kind: "help" });
      if (input === ":" || input === "/" || (key.ctrl && input === "k")) return setOverlay({ kind: "palette" });
      const n = Number(input);
      if (n >= 1 && n <= TABS.length) return setTab(TABS[n - 1]);
      if (key.tab) return setTab(TABS[(TABS.indexOf(tab) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]);
      if (input === "R") {
        if (tab === "Evals") loadQueue();
        if (tab === "Tasks" && taskRec) void loadBoard(taskRec);
        return void refresh();
      }
      if (input === "D") return void run(["doctor"]);
      if (input === "o") return void run(["console"]);
      if (input === "u") return void act("up", async () => {
        const r = await upAll(ctx);
        return `hub ${r.hub ? (r.hub.started ? "started" : "already up") : "-"} · supervisor ${r.supervisor ? (r.supervisor.started ? "started" : "already up") : "-"}`;
      });
      if (input === "d") return setOverlay({ kind: "confirm", label: "down", text: "Stop the hub and the supervisor? Residents stop with them.", run: async () => {
        const r = await downAll(ctx);
        return `supervisor ${r.supervisor} · hub ${r.hub}${r.strays.length ? ` · strays: ${r.strays.join(", ")}` : ""}`;
      } });
      if (input === "a") {
        const target = tab === "Rooms" ? roomByHandle(roomView?.handle) ?? defaultRoom : defaultRoom;
        if (!target) return say("no room yet: rfa room create <alias>", "bad");
        return setOverlay({ kind: "ask", room: target });
      }
      const down = key.downArrow || input === "j";
      const up = key.upArrow || input === "k";
      if (tab === "Agents") {
        if (down) setSel((s) => ({ ...s, agent: Math.min(agents.length - 1, s.agent + 1) }));
        if (up) setSel((s) => ({ ...s, agent: Math.max(0, s.agent - 1) }));
        if (!agent) {
          if (input === "n") void run(["agent", "new"]);
          return;
        }
        if (input === "s" || input === "x" || input === "r") {
          const action = input === "s" ? "start" : input === "x" ? "stop" : "restart";
          return void act(`${action} ${agent.name}`, async () => `${agent.name} ${await supervisorCommand(ctx, h, agent.name, action)}`);
        }
        if (input === "m") {
          if (agent.mode === "read-only") return say(`${agent.name} has no acting tool; a mode would change nothing`, "info");
          const order = ["ask", "plan", "bypass"] as const;
          const next = order[(Math.max(0, order.indexOf(agent.mode as (typeof order)[number])) + 1) % order.length];
          const apply = async () => {
            const { setAgentMode } = await import("../agentmd.js");
            const r = setAgentMode(path.join(h.paths.agents, agent.name, "agent.md"), next);
            return `${agent.name}: ${agent.mode} -> ${next}${r.before !== r.after ? " (the supervisor drains and respawns it)" : ""}`;
          };
          if (next === "bypass") return setOverlay({ kind: "confirm", label: `mode ${next}`, text: `${agent.name} in bypass mode calls its acting tools without asking anyone. Set it?`, run: apply });
          return void act(`mode ${next}`, apply);
        }
        if (input === "l") return void run(["logs", agent.name, "-f"]);
        if (input === "e") return void run(["agent", "edit", agent.name]);
        if (input === "v") return void run(["agent", "show", agent.name]);
        if (input === "n") return void run(["agent", "new"]);
      }
      if (tab === "Rooms") {
        if (down) setSel((s) => ({ ...s, room: Math.min(roomViews.length - 1, s.room + 1) }));
        if (up) setSel((s) => ({ ...s, room: Math.max(0, s.room - 1) }));
        if (!roomView) {
          if (input === "n") setOverlay({ kind: "palette", query: "room create" });
          return;
        }
        const ref = roomView.alias ?? roomView.handle;
        if (input === "t") {
          setFeedRoom(roomView.handle);
          return setTab("Feed");
        }
        if (input === "v") return void run(["room", "show", ref]);
        if (input === "i") return setOverlay({ kind: "palette", query: `room inject ${ref}` });
        if (input === "n") return setOverlay({ kind: "palette", query: "room create" });
      }
      if (tab === "Approvals") {
        if (down) setSel((s) => ({ ...s, card: Math.min(cards.length - 1, s.card + 1) }));
        if (up) setSel((s) => ({ ...s, card: Math.max(0, s.card - 1) }));
        if (!card) return;
        if (input === "y") {
          // Approving EXECUTES the agent's action; the CLI's approve confirms on
          // a terminal, and one mis-keyed y here must not out-privilege it. The
          // ask box keeps its direct y: the card is the whole of what it shows,
          // so the confirm would repeat the screen the operator is reading.
          return setOverlay({ kind: "confirm", label: `approve ${card.request_id}`, text: `Approve "${card.action}" (${card.tool_name}) from ${card.requester_name} in ${aliasOf(card.room)}? The agent then performs it.`, run: async () => {
            await ctx.workbench("/api/approvals/decide", { method: "POST", body: { room: card.room, request_id: card.request_id, verb: "approve" } });
            return `approved ${card.action} from ${card.requester_name}`;
          } });
        }
        if (input === "n") return setOverlay({ kind: "reject", card });
      }
      if (tab === "Feed") {
        if (input === "[" || input === "]") {
          const handles = roomViews.map((r) => r.handle);
          if (handles.length === 0) return;
          const i = Math.max(0, handles.indexOf(feedRoom ?? ""));
          setFeedRoom(handles[(i + (input === "]" ? 1 : handles.length - 1)) % handles.length]);
        }
      }
      if (tab === "Tasks") {
        if (down) setSel((s) => ({ ...s, task: Math.min(shownTasks.length - 1, s.task + 1) }));
        if (up) setSel((s) => ({ ...s, task: Math.max(0, s.task - 1) }));
        if (input === "[" || input === "]") {
          const handles = rooms.map((r) => r.handle);
          if (handles.length === 0) return;
          const i = Math.max(0, handles.indexOf(taskRec?.handle ?? ""));
          setTaskRoom(handles[(i + (input === "]" ? 1 : handles.length - 1)) % handles.length]);
          setSel((s) => ({ ...s, task: 0 }));
          setBoardState({ board: null, loaded: false, error: null, at: 0 });
          return;
        }
        if (input === "f") return setAllTasks((x) => !x);
        if (!taskRec) return say("no room yet: rfa room create <alias>", "bad");
        if (input === "n") return setOverlay({ kind: "task", room: taskRec, members: boardState.board?.members ?? [] });
        if (!task) return;
        const ref = taskRec.alias ?? taskRec.handle;
        if (input === "v") return void run(["task", "show", task.id, "--room", ref]);
        if (input === "x") {
          if (!isOpenTask(task)) return say(`${task.id} is already ${task.state}`, "info");
          return setOverlay({ kind: "confirm", label: `cancel ${task.id}`, text: `Cancel ${task.id}, "${task.title}"? Its owner, if any, learns it from the task event; nothing else is touched.`, run: async () => {
            await taskAction(ctx, h, taskRec, { action: "cancel", id: task.id });
            void loadBoard(taskRec);
            return `${task.id} cancelled`;
          } });
        }
        if (input === "y" || input === "r") {
          if (!task.verification.pending) return say(`${task.id} has no evidence waiting for a verdict${task.evidence_required ? "" : " (it does not require evidence)"}`, "info");
          if (input === "y") return void act(`accept ${task.id}`, async () => {
            const r = await taskAction(ctx, h, taskRec, { action: "verify", id: task.id, verdict: "accept" });
            void loadBoard(taskRec);
            return `${task.id} accepted: ${r.state}${r.blocks.length ? `; ${r.blocks.length} dependent task(s) unblocked` : ""}`;
          });
          return setOverlay({ kind: "field", title: `reject ${task.id}`, hint: "Why the evidence does not do; the owner reads it and reworks the task (it goes back to working, not to a terminal state). Blank rejects without a note.", initial: "", placeholder: "what is missing", onSubmit: (note) => void act(`reject ${task.id}`, async () => {
            const r = await taskAction(ctx, h, taskRec, { action: "verify", id: task.id, verdict: "reject", ...(note ? { note } : {}) });
            void loadBoard(taskRec);
            return `${task.id} sent back for rework: ${r.state}`;
          }) });
        }
      }
      if (tab === "Evals") {
        if (down) setSel((s) => ({ ...s, trace: Math.min(queue.traces.length - 1, s.trace + 1) }));
        if (up) setSel((s) => ({ ...s, trace: Math.max(0, s.trace - 1) }));
        if (input === "r") {
          return setOverlay({
            kind: "confirm",
            label: "evals run",
            text: "rfa evals run asks every live case four times and diffs the result against the baseline: about two dollars and several minutes, one run a day is the budget. Run it now?",
            run: async () => {
              await run(["evals", "run"]);
              loadQueue();
              return "the gate ran: its report is .rfa/reports/evals/latest.md";
            },
          });
        }
        if (key.return) {
          const summary = sittingSummary(queue.traces, verdicts);
          if (!summary) return say("nothing judged yet: p or f on a trace", "info");
          return setOverlay({
            kind: "confirm",
            label: "apply the sitting",
            text: summary.text,
            run: async () => {
              const result = applySitting({ obsDb: h.paths.obsDb, traces: judgedTraces(queue.traces, verdicts), outRoot: h.paths.evalCases, roomLogFile: (room) => roomLogFile(h, room) });
              setVerdicts({});
              setOverlay({ kind: "applied", result });
              loadQueue();
              return `sitting applied: ${result.labelled} label(s), ${result.golds} gold source(s), ${result.promoted.length} case(s) promoted`;
            },
          });
        }
        if (!trace) return;
        const v = verdicts[trace.run_id] ?? EMPTY_VERDICT;
        if (input === "p") return setVerdict(trace.run_id, { ...v, label: "pass" });
        if (input === "f") {
          return setOverlay({
            kind: "field",
            title: `${trace.agent} · fail`,
            hint: "The failure mode, in the words the findings ledger will use (retrieval-wrong-file, no-citation, ...). It names the case if this trace is cut into one. Blank keeps none.",
            initial: v.failure_mode ?? "",
            placeholder: "failure mode",
            onSubmit: (value) => setVerdict(trace.run_id, { ...v, label: "fail", failure_mode: value || null }),
          });
        }
        if (input === "g") {
          return setOverlay({
            kind: "field",
            title: `${trace.agent} · gold source`,
            hint: `The file#section that SHOULD have been cited${trace.cited.length ? `; it cited ${trace.cited.join(", ")}` : "; it cited nothing"}. Blank clears it.`,
            initial: v.gold_source ?? "",
            placeholder: "knowledge/handbook/fees.md#annual",
            onSubmit: (value) => setVerdict(trace.run_id, { ...v, gold_source: value || null }),
          });
        }
        if (input === "c") {
          if (!v.label) return say("label it first (p or f): a case is cut from a judged trace", "info");
          if (!trace.room || !trace.conversation) return say("cannot cut a case from this trace: it records no room or conversation", "bad");
          return setVerdict(trace.run_id, { ...v, promote: !v.promote });
        }
        if (input === "x") return setVerdict(trace.run_id, null);
        if (input === "v") return setOverlay({ kind: "answer", trace });
      }
    },
    { isActive: overlay === null },
  );

  const bodyHeight = Math.max(8, rows - 5);
  const status = snap?.status ?? null;
  const title = `${status?.name ?? h.manifest.name} · ${status?.mode ?? h.mode} · ${status?.hub_url ?? h.hubUrl}`;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box justifyContent="space-between" paddingX={1}>
        <Box gap={1}>
          <Mark />
          <Text bold>{title}</Text>
        </Box>
        <Box gap={2}>
          <Text>
            <Dot state={status?.hub.healthy ? "ready" : status?.hub.running ? "busy" : "offline"} /> <Text dimColor>hub</Text>
          </Text>
          <Text>
            <Dot state={status?.supervisor.running ? "ready" : "offline"} /> <Text dimColor>supervisor</Text>
          </Text>
          <Text dimColor>{snap ? new Date(snap.at).toLocaleTimeString() : "…"}</Text>
        </Box>
      </Box>
      <Box paddingX={1} gap={2}>
        {TABS.map((t, i) => (
          <Text key={t} color={t === tab ? ACCENT : undefined} bold={t === tab} inverse={t === tab}>
            {` ${i + 1} ${t}${t === "Approvals" && cards.length ? ` (${cards.length})` : t === "Evals" && toLabel ? ` (${toLabel})` : t === "Tasks" && openTasks ? ` (${openTasks})` : ""} `}
          </Text>
        ))}
      </Box>
      <Box height={bodyHeight} paddingX={1}>
        {overlay?.kind === "palette" ? (
          <Box width="100%" alignItems="flex-start">
            <Box width={Math.min(columns - 2, 96)}>
              <Palette items={items} initialQuery={overlay.query} recent={recent} onClose={() => setOverlay(null)} onRun={(argv) => {
                setOverlay(null);
                void run(argv);
              }} />
            </Box>
          </Box>
        ) : overlay?.kind === "help" ? (
          <Help onClose={() => setOverlay(null)} />
        ) : overlay?.kind === "ask" ? (
          <AskBox ctx={ctx} hub={h} room={overlay.room} onClose={() => setOverlay(null)} onDone={() => void refresh()} />
        ) : overlay?.kind === "confirm" ? (
          <Confirm text={overlay.text} onNo={() => setOverlay(null)} onYes={() => {
            const o = overlay;
            setOverlay(null);
            void act(o.label ?? "confirm", o.run);
          }} />
        ) : overlay?.kind === "reject" ? (
          <RejectBox card={overlay.card} onClose={() => setOverlay(null)} onSubmit={(reason) => {
            const c = overlay.card;
            setOverlay(null);
            void act(`reject ${c.request_id}`, async () => {
              await ctx.workbench("/api/approvals/decide", { method: "POST", body: { room: c.room, request_id: c.request_id, verb: "reject", ...(reason ? { params: { reason } } : {}) } });
              return `rejected ${c.action} from ${c.requester_name}`;
            });
          }} />
        ) : overlay?.kind === "field" ? (
          <LineField title={overlay.title} hint={overlay.hint} initial={overlay.initial} placeholder={overlay.placeholder} onClose={() => setOverlay(null)} onSubmit={(value) => {
            const o = overlay;
            setOverlay(null);
            o.onSubmit(value);
          }} />
        ) : overlay?.kind === "answer" ? (
          <AnswerView trace={overlay.trace} aliasOf={aliasOf} height={bodyHeight} onClose={() => setOverlay(null)} />
        ) : overlay?.kind === "applied" ? (
          <AppliedView result={overlay.result} hub={h} onClose={() => setOverlay(null)} />
        ) : overlay?.kind === "task" ? (
          <TaskBox ctx={ctx} hub={h} room={overlay.room} members={overlay.members} onClose={() => setOverlay(null)} onCreated={(t) => {
            setOverlay(null);
            say(`task ${t.id} created in ${overlay.room.alias}${t.owner ? ", assigned" : ""}`, "good");
            void loadBoard(overlay.room);
          }} />
        ) : tab === "Overview" ? (
          <Overview snap={snap} hub={h} aliasOf={aliasOf} columns={columns} />
        ) : tab === "Agents" ? (
          <AgentsTab agents={agents} selected={sel.agent} aliasOf={aliasOf} columns={columns} />
        ) : tab === "Rooms" ? (
          <RoomsTab rooms={roomViews} selected={sel.room} columns={columns} />
        ) : tab === "Approvals" ? (
          <ApprovalsTab cards={cards} selected={sel.card} aliasOf={aliasOf} columns={columns} />
        ) : tab === "Feed" ? (
          <FeedTab hub={h} handle={feedRoom ?? roomViews.find((r) => r.alias !== "ops")?.handle ?? roomViews[0]?.handle ?? null} aliasOf={aliasOf} height={bodyHeight - 3} />
        ) : tab === "Tasks" ? (
          <TasksTab state={boardState} tasks={shownTasks} selected={taskIndex} room={taskRec} allStates={allTasks} hubUp={hubUp} columns={columns} />
        ) : (
          <EvalsTab queue={queue} verdicts={verdicts} selected={traceIndex} gate={gate} aliasOf={aliasOf} columns={columns} height={bodyHeight} />
        )}
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Footer tab={tab} overlay={overlay} />
        {flash ? <Text color={flash.tone === "good" ? GOOD : flash.tone === "bad" ? BAD : ACCENT}>{flash.text}</Text> : snap?.error ? <Text color={BAD}>{snap.error}</Text> : null}
      </Box>
    </Box>
  );
}

function Footer(props: { tab: Tab; overlay: Overlay }): React.JSX.Element {
  if (props.overlay) return <Keys items={[["esc", "back"]]} />;
  const common: [string, string][] = [[":", "command"], ["a", "ask"], ["?", "help"], ["q", "quit"]];
  const per: Record<Tab, [string, string][]> = {
    Overview: [["u", "up"], ["d", "down"], ["D", "doctor"], ["o", "console"]],
    Agents: [["r", "restart"], ["s", "start"], ["x", "stop"], ["m", "mode"], ["l", "logs"], ["e", "edit"], ["v", "show"], ["n", "new"]],
    Rooms: [["t", "tail"], ["v", "show"], ["i", "inject"], ["n", "new"]],
    Approvals: [["y", "approve"], ["n", "reject"]],
    Feed: [["[ ]", "room"]],
    Evals: [["p", "pass"], ["f", "fail"], ["g", "gold"], ["c", "cut a case"], ["x", "clear"], ["v", "answer"], ["enter", "apply"], ["r", "run the gate"]],
    Tasks: [["n", "new"], ["y", "accept"], ["r", "reject"], ["x", "cancel"], ["v", "show"], ["f", "all states"], ["[ ]", "room"]],
  };
  return <Keys items={[...per[props.tab], ...common]} />;
}

function Help(props: { onClose: () => void }): React.JSX.Element {
  useInput(() => props.onClose());
  const rows: [string, string][] = [
    ["1-7, tab", "switch tabs"],
    ["j/k, ↑/↓", "move the selection"],
    [":  /  ctrl-k", "the command palette: every rfa command, searched"],
    ["a", "ask an agent (in the selected room on the Rooms tab)"],
    ["u / d", "start / stop the hub and the supervisor"],
    ["D / o", "rfa doctor / the console in the browser"],
    ["r s x", "restart / start / stop the selected agent"],
    ["m", "cycle the agent's mode: ask → plan → bypass (bypass is confirmed first)"],
    ["l e v n", "logs / edit / show / new agent"],
    ["t v i", "tail / show / inject into the selected room"],
    ["y n", "approve (confirmed first) / reject the selected card"],
    ["[ ]", "previous / next room in the feed"],
    ["p f g c x", "the sitting: pass / fail (and its failure mode) / gold source / cut a case / clear the verdict"],
    ["v enter r", "the whole answer / apply the sitting (confirmed) / run the gate (confirmed: it costs)"],
    ["n y r x f", "the board: a new task / accept its evidence / reject it with a note / cancel / every state, not only the open ones"],
    ["R", "refresh now (it refreshes every 2s anyway; the review queue only on R)"],
    ["q, ctrl-c", "leave the dashboard; nothing running is touched"],
  ];
  return (
    <Panel title="keys" active width="100%">
      {rows.map(([k, l]) => (
        <Box key={k}>
          <Box width={14}>
            <Text color={ACCENT}>{k}</Text>
          </Box>
          <Text>{l}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>every verb here runs the same code as its command; the palette shows the command line before running it</Text>
      </Box>
    </Panel>
  );
}

function Confirm(props: { text: string; onYes: () => void; onNo: () => void }): React.JSX.Element {
  useInput((input, key) => {
    if (input === "y" || input === "Y") props.onYes();
    else if (key.escape || input === "n" || input === "q") props.onNo();
  });
  return (
    <Panel title="confirm" active width="100%">
      <Text wrap="wrap">{props.text}</Text>
      <Box marginTop={1} gap={2}>
        <Key k="y" label="yes" />
        <Key k="n" label="no" />
      </Box>
    </Panel>
  );
}

function RejectBox(props: { card: CardView; onSubmit: (reason: string) => void; onClose: () => void }): React.JSX.Element {
  useInput((_i, key) => {
    if (key.escape) props.onClose();
  });
  return (
    <Panel title={`reject ${props.card.request_id}`} active width="100%">
      <Text>
        {props.card.action} <Text dimColor>({props.card.tool_name})</Text> from {props.card.requester_name}
      </Text>
      <Box marginTop={1}>
        <Text color={ACCENT}>reason: </Text>
        <TextInput placeholder="optional, one line; the requester reads it" onSubmit={(v) => props.onSubmit(v.trim())} />
      </Box>
    </Panel>
  );
}

/** One line asked in place, pre-filled with what was there: the failure mode, the gold source. */
function LineField(props: { title: string; hint: string; initial: string; placeholder?: string; onSubmit: (value: string) => void; onClose: () => void }): React.JSX.Element {
  useInput((_i, key) => {
    if (key.escape) props.onClose();
  });
  return (
    <Panel title={props.title} active width="100%">
      <Text dimColor wrap="wrap">
        {props.hint}
      </Text>
      <Box marginTop={1}>
        <Text color={ACCENT}>&gt; </Text>
        <TextInput defaultValue={props.initial} placeholder={props.placeholder} onSubmit={(v) => props.onSubmit(v.trim())} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>enter keeps it · esc changes nothing</Text>
      </Box>
    </Panel>
  );
}

/** A duration since an instant, with no 'ago': 'up 3m 29s', not 'up 3m 29s ago'. */
const since = (iso: string) => fmtMs(Math.max(0, Date.now() - Date.parse(iso)));

/** HH:MM today, MM-DD HH:MM otherwise: a queue is read within a day, its tail may not be. */
function fmtWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

// ---------------------------------------------------------------- tabs

function Overview(props: { snap: Snapshot | null; hub: HubDir; aliasOf: (h: string | null | undefined) => string; columns: number }): React.JSX.Element {
  // Two columns side by side when there is room, one under the other when there is not.
  const stacked = props.columns < 100;
  const half = stacked ? "100%" : "50%";
  const s = props.snap?.status ?? null;
  const sum = props.snap?.summary ?? null;
  const alerts = props.snap?.alerts ?? [];
  const recent = props.snap?.recent ?? [];
  const review = props.snap?.review ?? null;
  const acct = s?.supervisor.account ?? null;
  return (
    <Box width="100%" gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}>
      <Box flexDirection="column" width={half}>
        <Panel title="processes">
          <Box>
            <Box width={14}>
              <Text>
                <Dot state={s?.hub.healthy ? "ready" : s?.hub.running ? "busy" : "offline"} /> hub
              </Text>
            </Box>
            <Text dimColor>{s ? (s.hub.running ? `pid ${s.hub.pid} · ${s.hub.healthy ? "healthz ok" : "not answering"}${s.hub.started_at ? ` · up ${since(s.hub.started_at)}` : ""}` : s.hub.stale_pid_file ? "not running (stale pid file)" : "not running · press u") : "…"}</Text>
          </Box>
          <Box>
            <Box width={14}>
              <Text>
                <Dot state={s?.supervisor.running ? "ready" : "offline"} /> supervisor
              </Text>
            </Box>
            <Text dimColor>{s ? (s.supervisor.running ? `pid ${s.supervisor.pid} · ${acct ? `${acct.in_flight ?? 0}/${acct.cap ?? "?"} in flight` : ""}${acct?.paused_until ? ` · PAUSED until ${acct.paused_until}` : ""}` : "not running · press u") : "…"}</Text>
          </Box>
        </Panel>
        <Panel title={`agents (${s?.agents.length ?? 0})`} flexGrow={1}>
          {s && s.agents.length === 0 ? <Empty>no agents yet: press n on the Agents tab, it takes twenty seconds</Empty> : null}
          {(s?.agents ?? []).map((a) => (
            <Box key={a.name}>
              <Box width={16}>
                <Text wrap="truncate-end">
                  <Dot state={a.supervisor?.status ?? "stopped"} /> {a.name}
                </Text>
              </Box>
              <Box width={10}>
                <Text dimColor wrap="truncate-end">{props.aliasOf(a.room)}</Text>
              </Box>
              <Box width={8}>
                <Text dimColor wrap="truncate-end">{a.model}</Text>
              </Box>
              <Box width={8}>
                <Text>{fmtUsd(a.spend_today_usd)}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">{a.heartbeat_age_ms == null ? "no heartbeat" : `beat ${Math.round(a.heartbeat_age_ms / 1000)}s ago`}</Text>
            </Box>
          ))}
        </Panel>
      </Box>
      <Box flexDirection="column" width={half}>
        <Panel title={`rooms (${s?.rooms.length ?? 0})`}>
          {s && s.rooms.length === 0 ? <Empty>no room yet: rfa room create &lt;alias&gt;</Empty> : null}
          {(s?.rooms ?? []).filter((r) => !r.ended).slice(0, 6).map((r) => (
            <Box key={r.handle}>
              <Box width={12}>
                <Text bold={Boolean(r.alias)}>{r.alias ?? "-"}</Text>
              </Box>
              <Box width={14}>
                <Text dimColor>{r.handle}</Text>
              </Box>
              <Text>
                <Text color={(r.online ?? 0) > 0 ? GOOD : MUTED}>{r.online ?? 0}</Text>
                <Text dimColor>/{r.members ?? 0} online</Text>
                {r.open_tasks ? <Text color={WARN}>  {r.open_tasks} tasks</Text> : null}
                {r.pending_approvals ? <Text color={WARN}>  {r.pending_approvals} approvals</Text> : null}
              </Text>
            </Box>
          ))}
        </Panel>
        <Panel title="last 24 hours" hint={sum ? `${sum.runs} answers · ${fmtUsd(sum.cost_usd)}` : undefined}>
          {sum ? (
            <>
              <Text>
                <Text color={ACCENT}>{sparkline(props.snap?.perHour ?? [], 24)}</Text>
                <Text dimColor>  answers per hour</Text>
              </Text>
              <Box gap={2}>
                <Text>
                  <Text dimColor>errors </Text>
                  <Text color={sum.errors ? BAD : GOOD}>{sum.errors}</Text>
                  <Text dimColor> ({sum.error_pct.toFixed(0)}%)</Text>
                </Text>
                <Text>
                  <Text dimColor>avg </Text>
                  {fmtMs(sum.avg_latency_ms || 0)}
                </Text>
                {review ? (
                  <Text>
                    <Text dimColor>to label </Text>
                    <Text color={review.queued ? WARN : GOOD}>{review.queued}</Text>
                    <Text dimColor>{review.queued ? ` · press ${TABS.indexOf("Evals") + 1}` : review.labelled ? ` · ${review.labelled} labelled` : ""}</Text>
                  </Text>
                ) : null}
              </Box>
            </>
          ) : (
            <Empty>no answers recorded yet: press a to ask something</Empty>
          )}
          {alerts.map((a) => (
            <Text key={a} color={BAD}>
              ! {a}
            </Text>
          ))}
        </Panel>
        <Panel title="recent answers" flexGrow={1}>
          {recent.length === 0 ? <Empty>nothing yet</Empty> : null}
          {recent.slice(0, 5).map((r) => (
            <Box key={r.id} flexDirection="column">
              <Text>
                <Text color={r.error ? BAD : r.needs_review ? WARN : GOOD}>{r.error ? "✖" : r.needs_review ? "!" : "✔"}</Text>
                <Text bold> {r.agent}</Text>
                <Text dimColor> {fmtMs(r.ms)} · {fmtUsd(r.cost_usd)} · {since(new Date(r.when).toISOString())} ago</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {"  "}
                {r.question.replace(/\s+/g, " ")}
              </Text>
            </Box>
          ))}
        </Panel>
      </Box>
    </Box>
  );
}

function AgentsTab(props: { agents: AgentView[]; selected: number; aliasOf: (h: string | null | undefined) => string; columns: number }): React.JSX.Element {
  const a = props.agents[props.selected];
  const stacked = props.columns < 100;
  return (
    <Box width="100%" gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}>
      <Panel title="agents" active width={stacked ? "100%" : "60%"}>
        {props.agents.length === 0 ? <Empty>no agents yet: press n. An agent is a folder with one markdown file.</Empty> : null}
        <Table
          header={["name", "state", "mode", "room", "model", "today", "heartbeat"]}
          widths={[16, 11, 9, 10, 8, 8, 12]}
          available={Math.floor(props.columns * (stacked ? 1 : 0.6)) - 6}
          selected={props.selected}
          rows={props.agents.map((x) => [
            x.name,
            <Text key="s" color={x.supervisor?.status === "running" ? GOOD : x.supervisor?.status === "crash-looped" ? BAD : MUTED}>
              {x.supervisor?.status ?? "stopped"}
            </Text>,
            <Text key="m" color={x.mode === "bypass" ? BAD : x.mode === "read-only" ? MUTED : x.mode === "ask" ? undefined : WARN}>
              {x.mode}
            </Text>,
            props.aliasOf(x.room),
            x.model,
            fmtUsd(x.spend_today_usd),
            x.heartbeat_age_ms == null ? "-" : `${Math.round(x.heartbeat_age_ms / 1000)}s ago`,
          ])}
        />
      </Panel>
      <Panel title={a ? a.name : "agent"} width={stacked ? "100%" : "40%"}>
        {a ? (
          <>
            <Text>
              <Text dimColor>offers </Text>
              {a.offers.join(", ") || "-"}
            </Text>
            <Text>
              <Text dimColor>definition </Text>
              {a.definition}
            </Text>
            <Text>
              <Text dimColor>supervisor </Text>
              {a.supervisor ? `${a.supervisor.status}${a.supervisor.pid ? ` pid ${a.supervisor.pid}` : ""}${a.supervisor.restarts_in_window ? ` · ${a.supervisor.restarts_in_window} restarts in window` : ""}` : "not supervised"}
            </Text>
            <Text>
              <Text dimColor>started </Text>
              {a.supervisor?.started_at ? `${since(a.supervisor.started_at)} ago` : "-"}
            </Text>
            <Text>
              <Text dimColor>mode </Text>
              {a.mode}
            </Text>
            <Box marginTop={1}>
              <Text dimColor>r restart · s start · x stop · m mode · l logs · e edit · v show</Text>
            </Box>
          </>
        ) : (
          <Empty>select an agent</Empty>
        )}
      </Panel>
    </Box>
  );
}

function RoomsTab(props: { rooms: RoomView[]; selected: number; columns: number }): React.JSX.Element {
  const r = props.rooms[props.selected];
  const stacked = props.columns < 100;
  return (
    <Box width="100%" gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}>
      <Panel title="rooms" active width={stacked ? "100%" : "60%"}>
        {props.rooms.length === 0 ? <Empty>no room yet: press n</Empty> : null}
        <Table
          header={["alias", "handle", "online", "tasks", "approvals", ""]}
          widths={[12, 14, 10, 6, 10, 8]}
          available={Math.floor(props.columns * (stacked ? 1 : 0.6)) - 6}
          selected={props.selected}
          rows={props.rooms.map((x) => [
            x.alias ?? "-",
            x.handle,
            `${x.online ?? 0}/${x.members ?? 0}`,
            String(x.open_tasks ?? 0),
            String(x.pending_approvals ?? 0),
            <Text key="e" color={MUTED}>
              {x.ended ? "ended" : x.held ? `${x.held} held` : ""}
            </Text>,
          ])}
        />
      </Panel>
      <Panel title={r ? (r.alias ?? r.handle) : "room"} width={stacked ? "100%" : "40%"}>
        {r ? (
          <>
            <Text wrap="wrap">{r.topic}</Text>
            <Text>
              <Text dimColor>members </Text>
              {r.members ?? "?"} <Text dimColor>· humans </Text>
              {r.humans ?? 0} <Text dimColor>· guests </Text>
              {r.guests ?? 0}
            </Text>
            <Text>
              <Text dimColor>log </Text>
              {r.seq != null ? `${r.seq} events` : "-"}
            </Text>
            <Box marginTop={1}>
              <Text dimColor>t tail · a ask here · v show · i inject</Text>
            </Box>
          </>
        ) : (
          <Empty>select a room</Empty>
        )}
      </Panel>
    </Box>
  );
}

function ApprovalsTab(props: { cards: CardView[]; selected: number; aliasOf: (h: string | null | undefined) => string; columns: number }): React.JSX.Element {
  const c = props.cards[props.selected];
  const stacked = props.columns < 100;
  return (
    <Box width="100%" gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}>
      <Panel title="pending approvals" active width={stacked ? "100%" : "55%"}>
        {props.cards.length === 0 ? <Empty>nothing waits for you. A card appears here the moment an agent asks to act.</Empty> : null}
        <Table
          header={["id", "from", "action", "room", "expires"]}
          widths={[14, 14, 22, 10, 10]}
          available={Math.floor(props.columns * (stacked ? 1 : 0.55)) - 6}
          selected={props.selected}
          rows={props.cards.map((x) => [x.request_id, x.requester_name, x.action, props.aliasOf(x.room), x.expires_at ? `in ${fmtMs(Math.max(0, Date.parse(x.expires_at) - Date.now()))}` : "-"])}
        />
      </Panel>
      <Panel title={c ? c.request_id : "card"} width={stacked ? "100%" : "45%"}>
        {c ? (
          <>
            <Text>
              <Text bold>{c.action}</Text> <Text dimColor>({c.tool_name})</Text>
            </Text>
            <Text>
              <Text dimColor>from </Text>
              {c.requester_name} <Text dimColor>({c.requester_origin}, {c.requester_home})</Text>
            </Text>
            {c.message_preview ? (
              <Box marginTop={1}>
                <Text wrap="wrap" dimColor>
                  {c.message_preview}
                </Text>
              </Box>
            ) : null}
            <Box marginTop={1}>
              <Text dimColor>y approve (confirmed) · n reject (with a reason)</Text>
            </Box>
          </>
        ) : (
          <Empty>select a card</Empty>
        )}
      </Panel>
    </Box>
  );
}

function FeedTab(props: { hub: HubDir; handle: string | null; aliasOf: (h: string | null | undefined) => string; height: number }): React.JSX.Element {
  const [lines, setLines] = useState<FeedLine[]>([]);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!props.handle) return;
    const file = roomLogFile(props.hub, props.handle);
    setLines(tailLines(file, 400));
    const stop = followFile(file, (more) => {
      setLines((l) => [...l, ...more].slice(-400));
      setPulse(Date.now());
    });
    return stop;
  }, [props.hub, props.handle]);
  const shown = lines.slice(-Math.max(1, props.height));
  const live = Date.now() - pulse < 1500;
  const colorOf = (l: FeedLine) => (l.type === "message" ? (l.kind === "response" ? GOOD : l.kind === "request" ? ACCENT : undefined) : l.type === "system" ? BAD : l.type === "intervention" ? WARN : MUTED);
  return (
    <Panel title={`feed · ${props.aliasOf(props.handle)}`} hint={live ? "● live" : "following"} active width="100%">
      {!props.handle ? <Empty>no room to follow</Empty> : null}
      {props.handle && shown.length === 0 ? <Empty>the log is empty so far</Empty> : null}
      {shown.map((l) => (
        <Box key={`${l.seq}-${l.ts}`}>
          <Box width={6}>
            <Text dimColor>{l.seq}</Text>
          </Box>
          <Box width={9}>
            <Text dimColor>{l.ts.slice(11, 19)}</Text>
          </Box>
          <Box width={16}>
            <Text color={colorOf(l)} wrap="truncate-end">
              {l.who}
            </Text>
          </Box>
          <Text wrap="truncate-end" color={l.type === "message" ? undefined : MUTED}>
            {l.text}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}

// ---------------------------------------------------------------- tasks

const STATE_COLOR: Record<string, string | undefined> = { submitted: ACCENT, working: WARN, input_required: WARN, completed: GOOD, failed: BAD, rejected: BAD, cancelled: MUTED };

/** A deadline as the board reads it: "in 12m", "2h late", or "-". */
export function fmtDeadline(iso: string | null, now = Date.now()): string {
  if (!iso) return "-";
  const delta = Date.parse(iso) - now;
  return delta >= 0 ? `in ${fmtMs(delta)}` : `${fmtMs(-delta)} late`;
}

/** The one word the board shows for a task's evidence: what it still needs, or what it got. */
export function evidenceWord(t: RfaTask): string {
  if (t.verification.pending) return "to verify";
  if (t.verification.verdict === "accept") return "accepted";
  if (t.verification.verdict === "reject") return `sent back${t.verification.rejections ? ` ×${t.verification.rejections}` : ""}`;
  return t.evidence_required ? "required" : "-";
}

/**
 * The board of one room (RFA-0.7 sect. 13.11): what `rfa task ls` lists, with
 * the selected task in full beside it. Every verb is the `room_task` call the
 * task commands make, from the same operator membership.
 */
export function TasksTab(props: { state: BoardState; tasks: RfaTask[]; selected: number; room: RoomRecord | null; allStates: boolean; hubUp: boolean; columns: number }): React.JSX.Element {
  const stacked = props.columns < 100;
  const t = props.tasks[props.selected];
  const members = props.state.board?.members ?? [];
  const nameOf = (id: string | null) => (id ? (members.find((m) => m.id === id)?.name ?? id) : "-");
  const total = props.state.board?.tasks.length ?? 0;
  const open = (props.state.board?.tasks ?? []).filter(isOpenTask).length;
  const hint = props.state.loaded && !props.state.error ? `${open} open${props.allStates ? ` · ${total} in all` : total > open ? ` · f shows ${total - open} done` : ""}${props.hubUp ? "" : " · hub down: read once, R rereads"}` : undefined;
  return (
    <Box width="100%" gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}>
      <Panel title={`tasks · ${props.room ? props.room.alias : "no room"}`} hint={hint} active width={stacked ? "100%" : "58%"}>
        {!props.room ? <Empty>no room yet: rfa room create &lt;alias&gt;</Empty> : null}
        {props.room && !props.state.loaded ? <Spin label="reading the board" /> : null}
        {props.state.loaded && props.state.error ? <Empty>{props.state.error}</Empty> : null}
        {props.state.loaded && !props.state.error && props.tasks.length === 0 ? (
          <Empty>
            {props.allStates || total === 0 ? `no tasks in ${props.room?.alias ?? "this room"} yet: n puts one on the board, an assigned resident wakes and does it` : `no open tasks in ${props.room?.alias ?? "this room"}: f shows the ${total} done, n puts one on the board`}
          </Empty>
        ) : null}
        {props.tasks.length > 0 ? (
          <Table
            header={["id", "state", "owner", "evidence", "by", "title"]}
            widths={[6, 15, 14, 10, 11, 30]}
            available={Math.floor(props.columns * (stacked ? 1 : 0.58)) - 6}
            selected={props.selected}
            rows={props.tasks.map((x) => [
              x.id,
              <Text key="s" color={STATE_COLOR[x.state]} wrap="truncate-end">
                {x.state}
                {x.blocked_by.length ? ` (blocked)` : ""}
              </Text>,
              nameOf(x.owner),
              <Text key="e" color={x.verification.pending ? WARN : undefined} wrap="truncate-end">
                {evidenceWord(x)}
              </Text>,
              fmtDeadline(x.reply_by),
              x.title,
            ])}
          />
        ) : null}
      </Panel>
      <Panel title={t ? `${t.id} · ${t.state}` : "task"} width={stacked ? "100%" : "42%"}>
        {t ? (
          <>
            <Text bold wrap="wrap">
              {t.title}
            </Text>
            {t.description ? (
              <Text dimColor wrap="wrap">
                {t.description}
              </Text>
            ) : null}
            <Box marginTop={1} flexDirection="column">
              <Text wrap="truncate-end">
                <Text dimColor>owner </Text>
                {nameOf(t.owner)}
                <Text dimColor> · created by </Text>
                {nameOf(t.created_by)}
                {t.attempt ? <Text dimColor> · attempt {t.attempt}{t.max_attempts ? `/${t.max_attempts}` : ""}</Text> : null}
              </Text>
              <Text wrap="truncate-end">
                <Text dimColor>reply by </Text>
                {t.reply_by ? `${t.reply_by.slice(0, 16).replace("T", " ")} (${fmtDeadline(t.reply_by)})` : "-"}
                {t.lease_expires ? <Text dimColor> · lease to {t.lease_expires.slice(11, 19)}</Text> : null}
              </Text>
              {t.blocked_by.length || t.blocks.length ? (
                <Text wrap="truncate-end">
                  <Text dimColor>blocked by </Text>
                  {t.blocked_by.join(", ") || "-"}
                  <Text dimColor> · blocks </Text>
                  {t.blocks.join(", ") || "-"}
                </Text>
              ) : null}
              <Text wrap="wrap">
                <Text dimColor>evidence </Text>
                {t.evidence ? t.evidence.summary : t.evidence_required ? "required, none yet" : "not required"}
              </Text>
              {t.evidence?.artifacts?.length ? (
                <Text dimColor wrap="truncate-end">
                  {"  "}
                  {t.evidence.artifacts.join(", ")}
                </Text>
              ) : null}
              <Text wrap="wrap">
                <Text dimColor>verification </Text>
                {t.verification.pending ? <Text color={WARN}>waiting for a verdict: y accept · r reject</Text> : t.verification.verdict ? `${t.verification.verdict}ed by ${nameOf(t.verification.verifier)}${t.verification.note ? `: ${t.verification.note}` : ""}` : "-"}
              </Text>
              {t.note ? (
                <Text wrap="wrap">
                  <Text dimColor>note </Text>
                  {t.note}
                </Text>
              ) : null}
              <Text dimColor wrap="truncate-end">
                created {t.created_at.slice(0, 16).replace("T", " ")} · updated {t.updated_at.slice(0, 16).replace("T", " ")}
              </Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>{isOpenTask(t) ? "x cancel · v show as JSON" : "v show as JSON"}</Text>
            </Box>
          </>
        ) : (
          <Empty>{props.tasks.length ? "select a task" : "a task is shared work state beside the chat: who owns it, what blocks it, the evidence it ends with"}</Empty>
        )}
      </Panel>
    </Box>
  );
}

/** A task put on the board from the dashboard: the title, who does it, whether it ends in evidence; the same `room_task create` as `rfa task create`. */
function TaskBox(props: { ctx: CliContext; hub: HubDir; room: RoomRecord; members: Member[]; onClose: () => void; onCreated: (t: RfaTask) => void }): React.JSX.Element {
  const [title, setTitle] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  useInput((_i, key) => {
    if (key.escape && !creating) props.onClose();
  });
  const candidates = props.members.filter((m) => m.id !== props.room.operator?.member_id && m.state !== "offline");
  const create = async (evidence: boolean) => {
    setCreating(true);
    try {
      const t = await taskAction(props.ctx, props.hub, props.room, { action: "create", title, ...(owner ? { owner } : {}), ...(evidence ? { evidence_required: true } : {}) });
      props.onCreated(t);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };
  return (
    <Panel title={`new task · ${props.room.alias}`} active width="100%">
      {title === null ? (
        <>
          <Text dimColor>What needs doing, in one line. Enter puts it on the board; blank cancels.</Text>
          <Box marginTop={1}>
            <Text color={ACCENT}>title </Text>
            <TextInput placeholder="draft the release note for 0.7" onSubmit={(v) => (v.trim() ? setTitle(v.trim()) : props.onClose())} />
          </Box>
        </>
      ) : owner === undefined ? (
        <>
          <Text dimColor wrap="wrap">
            "{title}" · Who does it? An assigned resident wakes and does it; an unassigned task waits on the board for anyone to claim.
          </Text>
          <Box marginTop={1}>
            <Choice
              options={[
                { value: "", label: "nobody yet", hint: "stays on the board for anyone to claim" },
                ...candidates.map((m) => ({ value: m.id, label: m.name, hint: `${m.origin} · ${m.state}` })),
              ]}
              onChoose={(v) => setOwner(v || null)}
            />
          </Box>
        </>
      ) : creating ? (
        <Spin label="putting it on the board" />
      ) : (
        <>
          <Text dimColor wrap="wrap">
            "{title}" · {owner ? `assigned to ${candidates.find((m) => m.id === owner)?.name ?? owner}` : "unassigned"} · Does it end in evidence a DIFFERENT member must accept (wire 10.4)?
          </Text>
          <Box marginTop={1}>
            <Choice
              options={[
                { value: "no", label: "no", hint: "done when its owner says so" },
                { value: "yes", label: "yes, evidence required", hint: "the owner completes it with a summary; you accept or reject it here" },
              ]}
              onChoose={(v) => void create(v === "yes")}
            />
          </Box>
          {error ? <Text color={BAD}>✖ {error}</Text> : null}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- evals

/**
 * The labelling sitting in place (RFA-0.5 sect. 20.4): the review queue on the
 * left, the selected trace and the gate on the right. The queue is what
 * `rfa evals label --prepare` writes; enter applies the verdicts through the
 * same function `--apply` runs.
 */
export function EvalsTab(props: { queue: QueueState; verdicts: Record<string, Verdict>; selected: number; gate: GateView | null; aliasOf: (h: string | null | undefined) => string; columns: number; height: number }): React.JSX.Element {
  const stacked = props.columns < 100;
  const q = props.queue;
  const t = q.traces[props.selected];
  const v = t ? props.verdicts[t.run_id] : undefined;
  const judged = Object.values(props.verdicts).filter((x) => x.label).length;
  const answerLines = Math.max(3, Math.min(10, props.height - 18));
  const lines = t ? t.answer.split("\n") : [];
  const g = props.gate;
  const hint = q.loaded && !q.error ? `${q.total > q.traces.length ? `newest ${q.traces.length} of ${q.total}` : `${q.total} to label`}${q.alreadyLabelled ? ` · ${q.alreadyLabelled} labelled` : ""}` : undefined;
  const lastColor = (c: GateView["cases"][number]) => (!c.last ? MUTED : c.last.blocked ? MUTED : c.last.score === 1 ? GOOD : c.last.score > 0 ? WARN : BAD);
  return (
    <Box width="100%" gap={stacked ? 0 : 1} flexDirection={stacked ? "column" : "row"}>
      <Panel title={`review queue${q.loaded && !q.error ? ` (${q.total})` : ""}`} hint={hint} active width={stacked ? "100%" : "55%"}>
        {!q.loaded ? <Spin label="reading the review queue" /> : null}
        {q.loaded && q.error ? <Empty>{q.error}</Empty> : null}
        {q.loaded && !q.error && q.traces.length === 0 ? (
          <Box flexDirection="column" paddingY={1}>
            <Text dimColor>nothing to label: the review queue is empty</Text>
            <Text dimColor>no needs_review, no feedback at or below zero{q.alreadyLabelled ? `; ${q.alreadyLabelled} already carry a human label` : ""}</Text>
          </Box>
        ) : null}
        {q.traces.length > 0 ? (
          <Table
            header={["when", "agent", "flagged", "verdict", "question"]}
            widths={[6, 12, 14, 9, 20]}
            available={Math.floor(props.columns * (stacked ? 1 : 0.55)) - 6}
            selected={props.selected}
            rows={q.traces.map((x) => {
              const m = props.verdicts[x.run_id];
              return [
                fmtWhen(x.when),
                x.agent,
                x.flagged_because.replace(/^eval:/, ""),
                <Text key="v" color={m?.label === "pass" ? GOOD : m?.label === "fail" ? BAD : MUTED} wrap="truncate-end">
                  {verdictMark(m)}
                </Text>,
                x.question.replace(/\s+/g, " "),
              ];
            })}
          />
        ) : null}
        {q.traces.length > 0 ? (
          <Box marginTop={1}>
            <Text dimColor>{judged ? `${judged} judged · enter applies the sitting` : "p pass · f fail · g gold source · c cut a case · v the whole answer"}</Text>
          </Box>
        ) : null}
      </Panel>
      <Box flexDirection="column" width={stacked ? "100%" : "45%"}>
        <Panel title={t ? `${t.agent} · ${t.run_id}` : "trace"} flexGrow={1}>
          {t ? (
            <>
              <Text wrap="truncate-end">
                <Text dimColor>Q </Text>
                {t.question.replace(/\s+/g, " ")}
              </Text>
              <Box flexDirection="column" marginTop={1}>
                {lines.slice(0, answerLines).map((l, i) => (
                  <Text key={i} wrap="truncate-end">
                    {l}
                  </Text>
                ))}
                {lines.length > answerLines ? <Text dimColor>… {lines.length - answerLines} more lines: v shows the whole answer</Text> : null}
              </Box>
              {t.answer_truncated ? (
                <Text color={WARN} wrap="wrap">
                  {t.answer_truncated}
                </Text>
              ) : null}
              <Box marginTop={1} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text dimColor>cited </Text>
                  {t.cited.join(", ") || "nothing"}
                </Text>
                <Text wrap="truncate-end">
                  <Text dimColor>flagged </Text>
                  {t.flagged_because}
                </Text>
                <Text wrap="truncate-end">
                  <Text dimColor>room </Text>
                  {props.aliasOf(t.room)}
                  <Text dimColor> · conversation </Text>
                  {t.conversation ?? "-"}
                  <Text dimColor> · </Text>
                  {since(t.when)} ago
                </Text>
                <Text wrap="truncate-end">
                  <Text dimColor>verdict </Text>
                  <Text color={v?.label === "pass" ? GOOD : v?.label === "fail" ? BAD : undefined}>{describeVerdict(v)}</Text>
                </Text>
              </Box>
            </>
          ) : (
            <Empty>{q.traces.length ? "select a trace" : "a trace lands here when an answer is flagged: a failed eval or parity check, or a negative feedback row"}</Empty>
          )}
        </Panel>
        <Panel title="the gate" hint={g?.lastRun ? `last run ${since(new Date(g.lastRun.at).toISOString())} ago${g.lastRun.judged ? " · judged" : ""}` : "no run yet"}>
          {g && g.cases.length === 0 ? <Empty>no cases yet: a judged trace cut with c becomes one, or rfa evals promote</Empty> : null}
          {g && g.cases.length > 0 ? (
            <Table
              header={["case", "kind", `base pass^${g.gate.k}`, "last run"]}
              widths={[24, 7, 12, 16]}
              available={Math.floor(props.columns * (stacked ? 1 : 0.45)) - 6}
              rows={g.cases.slice(0, 8).map((c) => [
                c.id,
                c.kind,
                c.baseline == null ? "-" : c.baseline.toFixed(2),
                <Text key="l" color={lastColor(c)} wrap="truncate-end">
                  {!c.last ? "-" : c.last.blocked ? "BLOCKED" : `${c.last.trials.map((ok) => (ok ? "✔" : "✖")).join("")}${c.last.refused ? ` ${c.last.refused} refused` : ""}`}
                </Text>,
              ])}
            />
          ) : null}
          {g && g.cases.length > 8 ? <Text dimColor>… {g.cases.length - 8} more: rfa evals ls</Text> : null}
          <Box marginTop={1}>
            <Text dimColor>r runs the gate (pass^{g?.gate.k ?? 4}, band {g?.gate.band ?? 0.15}; about $2){g?.corpusVersion ? ` · corpus ${g.corpusVersion.slice(0, 12)}` : ""}</Text>
          </Box>
        </Panel>
      </Box>
    </Box>
  );
}

/** The whole answer, scrolled with j/k: what the trace panel could not fit. */
function AnswerView(props: { trace: Trace; aliasOf: (h: string | null | undefined) => string; height: number; onClose: () => void }): React.JSX.Element {
  const [scroll, setScroll] = useState(0);
  const lines = props.trace.answer.split("\n");
  const shown = Math.max(3, props.height - 8);
  useInput((input, key) => {
    if (key.escape || input === "q" || input === "v" || key.return) return props.onClose();
    if (key.downArrow || input === "j") setScroll((s) => Math.min(Math.max(0, lines.length - shown), s + 1));
    if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
    if (input === "G") setScroll(Math.max(0, lines.length - shown));
    if (input === "g") setScroll(0);
  });
  return (
    <Panel title={`${props.trace.agent} · ${props.trace.run_id} · the whole answer`} hint={`${lines.length} lines`} active width="100%">
      <Text dimColor wrap="truncate-end">
        Q {props.trace.question.replace(/\s+/g, " ")}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {lines.slice(scroll, scroll + shown).map((l, i) => (
          <Text key={scroll + i} wrap="wrap">
            {l}
          </Text>
        ))}
      </Box>
      {props.trace.answer_truncated ? (
        <Text color={WARN} wrap="wrap">
          {props.trace.answer_truncated}
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{lines.length > shown ? "j/k scroll · g/G top/bottom · " : ""}esc closes · cited {props.trace.cited.join(", ") || "nothing"}</Text>
      </Box>
    </Panel>
  );
}

/** What the sitting wrote, in the words `rfa evals label --apply` prints, including the ledger line an all-passing review owes. */
function AppliedView(props: { result: ApplyResult; hub: HubDir; onClose: () => void }): React.JSX.Element {
  useInput(() => props.onClose());
  const r = props.result;
  return (
    <Panel title="sitting applied" active width="100%">
      <Text>
        <Text color={GOOD}>✔</Text> {r.labelled} label(s), {r.golds} gold source(s), {r.promoted.length} case(s) promoted
        <Text dimColor> · human feedback rows in .rfa/data/obs.db, no rubric hash: a person judged these</Text>
      </Text>
      {r.failures.length ? (
        <Text>
          <Text dimColor>failure modes recorded </Text>
          {[...new Set(r.failures)].join("; ")}
        </Text>
      ) : null}
      {r.promotedNotes.map((p) => (
        <Box key={p.caseId} flexDirection="column">
          <Text>
            {"  "}
            {p.caseId} <Text dimColor>{path.relative(props.hub.root, p.dir)}</Text>
          </Text>
          {p.notes.map((n) => (
            <Text key={n} dimColor wrap="wrap">
              {"    "}
              {n}
            </Text>
          ))}
        </Box>
      ))}
      {r.problems.map((p) => (
        <Text key={p} color={BAD} wrap="wrap">
          ! {p}
        </Text>
      ))}
      {r.ledgerLine ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={WARN}>PASTE THIS INTO THE FINDINGS LEDGER (RFA-0.5 sect. 20.4 requires it for an all-passing review):</Text>
          <Text bold>
            {"  "}
            {r.ledgerLine}
          </Text>
          <Text dimColor wrap="wrap">
            an all-passing review with no such entry is an unaudited instrument: nothing distinguishes an instrument that has finished from one that has gone blind
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>any key returns to the queue</Text>
      </Box>
    </Panel>
  );
}

// ---------------------------------------------------------------- ask

function AskBox(props: { ctx: CliContext; hub: HubDir; room: RoomRecord; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const [stage, setStage] = useState<"question" | "capability" | "asking" | "answer">("question");
  const [question, setQuestion] = useState("");
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AskOutcome | null>(null);
  const [scroll, setScroll] = useState(0);
  const [pending, setPending] = useState<CardView | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<string | null>(null);
  const t0 = useRef(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (stage !== "asking") return;
    const t = setInterval(() => setTick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [stage]);
  // While an answer is awaited, a card from this room is the thing the agent is
  // waiting for, and it is decided here, without leaving the ask.
  useEffect(() => {
    if (stage !== "asking" || !props.ctx.humanKey()) return;
    const poll = () =>
      void props.ctx
        .workbench<CardView[]>("/api/approvals")
        .then((cards) => setPending(cards.find((c) => c.status === "pending" && c.room === props.room.handle) ?? null))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [stage, props.ctx, props.room.handle]);
  const decide = async (verb: "approve" | "reject") => {
    if (!pending || deciding) return;
    setDeciding(`${verb}…`);
    try {
      await props.ctx.workbench("/api/approvals/decide", { method: "POST", body: { room: pending.room, request_id: pending.request_id, verb } });
      setDeciding(`${verb}d ${pending.action}`);
      setPending(null);
    } catch (err) {
      setDeciding(`${verb} failed: ${(err as Error).message}`);
    }
  };

  const askWith = async (capability: string, q: string) => {
    setStage("asking");
    t0.current = Date.now();
    try {
      const out = await askInRoom(props.ctx, props.hub, props.room, capability, q);
      setOutcome(out);
      setStage("answer");
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
      setStage("answer");
    }
  };

  const submitQuestion = useCallback(
    async (q: string) => {
      if (!q.trim()) return props.onClose();
      setQuestion(q.trim());
      setStage("capability");
      try {
        const found = await offersIn(props.ctx, props.hub, props.room);
        setOffers(found);
        if (found.length === 1) {
          setQuestion(q.trim());
          await askWith(found[0].capability, q.trim());
        }
      } catch (err) {
        setError((err as Error).message);
        setStage("answer");
      }
    },
    [props],
  );

  useInput(
    (input, key) => {
      if (key.escape || (stage === "answer" && (input === "q" || key.return))) return props.onClose();
      if (stage === "asking" && pending && !deciding) {
        if (input === "y") return void decide("approve");
        if (input === "n") return void decide("reject");
      }
      if (stage === "answer") {
        if (key.downArrow || input === "j") setScroll((s) => s + 1);
        if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
        // The flywheel's human entry: a wrong answer goes to the sitting from
        // here, by the same function as `rfa evals flag`.
        if (input === "!" && outcome?.run_id && !flagged) {
          try {
            flagForReview({ obsDb: props.hub.paths.obsDb, runId: outcome.run_id, note: "flagged from the ask box" });
            setFlagged(`flagged for the sitting: the Evals tab (6) lists ${outcome.run_id}`);
            props.onDone();
          } catch (err) {
            setFlagged(`could not flag it: ${(err as Error).message}`);
          }
        }
      }
    },
    { isActive: stage !== "question" },
  );

  const answerLines = (outcome?.text ?? error ?? "").split("\n");
  return (
    <Panel title={`ask · ${props.room.alias}`} active width="100%">
      {stage === "question" ? (
        <>
          <Text dimColor>Discovery is by capability: the room's roster says who can answer what. Enter sends, blank cancels.</Text>
          <Box marginTop={1}>
            <Text color={ACCENT}>? </Text>
            <TextInput placeholder="your question" onSubmit={(v) => void submitQuestion(v)} />
          </Box>
        </>
      ) : null}
      {stage === "capability" ? (
        offers === null ? (
          <Spin label="reading the roster" />
        ) : offers.length === 0 ? (
          <Text color={BAD}>nobody in {props.room.alias} is present to answer. rfa status shows whether the agents are up.</Text>
        ) : (
          <>
            <Text dimColor>{offers.length} capabilities are offered; pick the one that fits the question:</Text>
            <Choice options={offers.map((o) => ({ label: o.capability, value: o.capability, hint: o.members.join(", ") }))} onChoose={(v) => void askWith(v, question)} />
          </>
        )
      ) : null}
      {stage === "asking" ? (
        <Box flexDirection="column">
          <Text dimColor>"{question}"</Text>
          <Box marginTop={1}>
            <Spin label={`waiting for an answer · ${fmtMs(Date.now() - t0.current)}`} />
          </Box>
          {pending ? (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={WARN} paddingX={1}>
              <Text color={WARN}>
                {pending.requester_name} is waiting for YOUR decision: <Text bold>{pending.action}</Text> <Text dimColor>({pending.tool_name})</Text>
              </Text>
              {pending.message_preview ? (
                <Text dimColor wrap="truncate-end">
                  {pending.message_preview.replace(/\s+/g, " ").slice(0, 300)}
                </Text>
              ) : null}
              <Box marginTop={1} gap={2}>
                <Key k="y" label="approve" />
                <Key k="n" label="reject" />
                <Text dimColor>{deciding ?? ""}</Text>
              </Box>
            </Box>
          ) : (
            <Text dimColor>{deciding ?? (tick % 2 ? "a tool user pauses on a card before it acts; it would appear here" : "an answer usually takes 10 to 30 seconds")}</Text>
          )}
        </Box>
      ) : null}
      {stage === "answer" ? (
        <Box flexDirection="column">
          {outcome ? (
            <Text>
              <Text color={outcome.kind === "response" ? GOOD : BAD}>{outcome.kind === "response" ? "✔" : "✖"}</Text>
              <Text bold> {outcome.target}</Text>
              <Text dimColor>
                {" "}
                {outcome.capability} · {fmtMs(outcome.elapsed_ms)} · {fmtUsd(outcome.cost_usd)}
                {outcome.run_id ? ` · ${outcome.run_id}` : ""}
                {outcome.refusal ? ` · refused: ${outcome.refusal}` : ""}
              </Text>
            </Text>
          ) : (
            <Text color={BAD}>✖ {error}</Text>
          )}
          <Box flexDirection="column" marginTop={1}>
            {answerLines.slice(scroll, scroll + 14).map((l, i) => (
              <Text key={i} wrap="wrap">
                {l}
              </Text>
            ))}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              {answerLines.length > 14 ? "j/k scroll · " : ""}enter or esc closes{outcome?.run_id && !flagged ? " · ! flags it for the labelling sitting if it was wrong" : ""}
            </Text>
            {flagged ? <Text color={WARN}>{flagged}</Text> : null}
          </Box>
        </Box>
      ) : null}
      <Gauge value={0} max={1} width={0} />
    </Panel>
  );
}
