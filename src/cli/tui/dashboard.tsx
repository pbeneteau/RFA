/**
 * The dashboard (RFA-0.7 sect. 11.2): what `rfa` opens in a hub directory.
 *
 * Five tabs over one snapshot refreshed every two seconds; single-key verbs
 * that do what the matching command does; a palette for everything else. The
 * conventions are the ones operators already have in their fingers from
 * lazygit and k9s: `?` for help, `:` for a command, j/k or arrows to move,
 * numbers for tabs, q to leave. Every verb here is a thin call into the same
 * code the command line runs, so the dashboard cannot drift from the CLI.
 */
import * as path from "node:path";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { TextInput } from "@inkjs/ui";
import type { HubDir, RoomRecord } from "../../hubdir.js";
import type { CliContext } from "../context.js";
import { supervisorCommand } from "../commands/agent.js";
import { downAll, upAll } from "../commands/procs.js";
import type { CommandDef } from "../router.js";
import { askInRoom, followFile, offersIn, recordedRooms, roomLogFile, snapshot, tailLines, type AgentView, type AskOutcome, type CardView, type FeedLine, type Offer, type RoomView, type Snapshot } from "./data.js";
import { Mark } from "./logo.js";
import { Palette, paletteItems } from "./palette.js";
import { ACCENT, BAD, fmtMs, fmtUsd, GOOD, MUTED, sparkline, WARN } from "./theme.js";
import { Choice, Dot, Empty, Gauge, Key, Keys, Panel, Spin, Table } from "./widgets.js";
import type { RunChild } from "./index.js";

const TABS = ["Overview", "Agents", "Rooms", "Approvals", "Feed"] as const;
type Tab = (typeof TABS)[number];
type Overlay = { kind: "palette"; query?: string } | { kind: "help" } | { kind: "ask"; room: RoomRecord } | { kind: "confirm"; text: string; run: () => Promise<string> } | { kind: "reject"; card: CardView } | null;

interface Flash {
  text: string;
  tone: "good" | "bad" | "info";
  at: number;
}

export function Dashboard(props: { ctx: CliContext; hub: HubDir; commands: CommandDef[]; runChild: RunChild }): React.JSX.Element {
  const { ctx, hub: h } = props;
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const [tab, setTab] = useState<Tab>("Overview");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [sel, setSel] = useState({ agent: 0, room: 0, card: 0 });
  const [feedRoom, setFeedRoom] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
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

  const agents = snap?.status?.agents ?? [];
  const roomViews = snap?.status?.rooms ?? [];
  const cards = snap?.approvals ?? [];
  const agent = agents[Math.min(sel.agent, Math.max(0, agents.length - 1))];
  const roomView = roomViews[Math.min(sel.room, Math.max(0, roomViews.length - 1))];
  const card = cards[Math.min(sel.card, Math.max(0, cards.length - 1))];
  const aliasOf = (handle: string | null | undefined) => rooms.find((r) => r.handle === handle)?.alias ?? handle ?? "-";
  const defaultRoom = rooms.find((r) => r.alias !== "ops") ?? rooms[0] ?? null;
  const roomByHandle = (handle: string | undefined) => rooms.find((r) => r.handle === handle) ?? null;

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return exit({ code: 0 });
      if (input === "q") return exit({ code: 0 });
      if (input === "?") return setOverlay({ kind: "help" });
      if (input === ":" || input === "/" || (key.ctrl && input === "k")) return setOverlay({ kind: "palette" });
      const n = Number(input);
      if (n >= 1 && n <= TABS.length) return setTab(TABS[n - 1]);
      if (key.tab) return setTab(TABS[(TABS.indexOf(tab) + (key.shift ? TABS.length - 1 : 1)) % TABS.length]);
      if (input === "R") return void refresh();
      if (input === "D") return void run(["doctor"]);
      if (input === "o") return void run(["console"]);
      if (input === "u") return void act("up", async () => {
        const r = await upAll(ctx);
        return `hub ${r.hub ? (r.hub.started ? "started" : "already up") : "-"} · supervisor ${r.supervisor ? (r.supervisor.started ? "started" : "already up") : "-"}`;
      });
      if (input === "d") return setOverlay({ kind: "confirm", text: "Stop the hub and the supervisor? Residents stop with them.", run: async () => {
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
          if (input === "n") setOverlay({ kind: "palette", query: "agent new" });
          return;
        }
        if (input === "s" || input === "x" || input === "r") {
          const action = input === "s" ? "start" : input === "x" ? "stop" : "restart";
          return void act(`${action} ${agent.name}`, async () => `${agent.name} ${await supervisorCommand(ctx, h, agent.name, action)}`);
        }
        if (input === "m") {
          if (agent.mode === "read-only") return say(`${agent.name} has no acting tool; a mode would change nothing`, "info");
          const order = ["ask", "plan", "auto", "bypass"] as const;
          const next = order[(Math.max(0, order.indexOf(agent.mode as (typeof order)[number])) + 1) % order.length];
          const apply = async () => {
            const { setAgentMode } = await import("../agentmd.js");
            const r = setAgentMode(path.join(h.paths.agents, agent.name, "agent.md"), next);
            return `${agent.name}: ${agent.mode} -> ${next}${r.before !== r.after ? " (the supervisor drains and respawns it)" : ""}`;
          };
          if (next === "bypass") return setOverlay({ kind: "confirm", text: `${agent.name} in bypass mode calls its acting tools without asking anyone. Set it?`, run: apply });
          return void act(`mode ${next}`, apply);
        }
        if (input === "l") return void run(["logs", agent.name, "-f"]);
        if (input === "e") return void run(["agent", "edit", agent.name]);
        if (input === "v") return void run(["agent", "show", agent.name]);
        if (input === "n") return setOverlay({ kind: "palette", query: "agent new" });
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
        if (input === "y") return void act(`approve ${card.request_id}`, async () => {
          await ctx.workbench("/api/approvals/decide", { method: "POST", body: { room: card.room, request_id: card.request_id, verb: "approve" } });
          return `approved ${card.action} from ${card.requester_name}`;
        });
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
            {` ${i + 1} ${t}${t === "Approvals" && cards.length ? ` (${cards.length})` : ""} `}
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
            void act("down", o.run);
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
        ) : tab === "Overview" ? (
          <Overview snap={snap} hub={h} aliasOf={aliasOf} />
        ) : tab === "Agents" ? (
          <AgentsTab agents={agents} selected={sel.agent} aliasOf={aliasOf} />
        ) : tab === "Rooms" ? (
          <RoomsTab rooms={roomViews} selected={sel.room} />
        ) : tab === "Approvals" ? (
          <ApprovalsTab cards={cards} selected={sel.card} aliasOf={aliasOf} />
        ) : (
          <FeedTab hub={h} handle={feedRoom ?? roomViews.find((r) => r.alias !== "ops")?.handle ?? roomViews[0]?.handle ?? null} aliasOf={aliasOf} height={bodyHeight - 3} />
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
  };
  return <Keys items={[...per[props.tab], ...common]} />;
}

function Help(props: { onClose: () => void }): React.JSX.Element {
  useInput(() => props.onClose());
  const rows: [string, string][] = [
    ["1-5, tab", "switch tabs"],
    ["j/k, ↑/↓", "move the selection"],
    [":  /  ctrl-k", "the command palette: every rfa command, searched"],
    ["a", "ask an agent (in the selected room on the Rooms tab)"],
    ["u / d", "start / stop the hub and the supervisor"],
    ["D / o", "rfa doctor / the console in the browser"],
    ["r s x", "restart / start / stop the selected agent"],
    ["m", "cycle the agent's mode: ask → plan → auto → bypass (bypass is confirmed first)"],
    ["l e v n", "logs / edit / show / new agent"],
    ["t v i", "tail / show / inject into the selected room"],
    ["y n", "approve / reject the selected card"],
    ["[ ]", "previous / next room in the feed"],
    ["R", "refresh now (it refreshes every 2s anyway)"],
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
      <Text>{props.text}</Text>
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

/** A duration since an instant, with no 'ago': 'up 3m 29s', not 'up 3m 29s ago'. */
const since = (iso: string) => fmtMs(Math.max(0, Date.now() - Date.parse(iso)));

// ---------------------------------------------------------------- tabs

function Overview(props: { snap: Snapshot | null; hub: HubDir; aliasOf: (h: string | null | undefined) => string }): React.JSX.Element {
  const s = props.snap?.status ?? null;
  const sum = props.snap?.summary ?? null;
  const alerts = props.snap?.alerts ?? [];
  const recent = props.snap?.recent ?? [];
  const acct = s?.supervisor.account ?? null;
  return (
    <Box width="100%" gap={1}>
      <Box flexDirection="column" width="50%">
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
      <Box flexDirection="column" width="50%">
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

function AgentsTab(props: { agents: AgentView[]; selected: number; aliasOf: (h: string | null | undefined) => string }): React.JSX.Element {
  const a = props.agents[props.selected];
  return (
    <Box width="100%" gap={1}>
      <Panel title="agents" active width="60%">
        {props.agents.length === 0 ? <Empty>no agents yet: press n. An agent is a folder with one markdown file.</Empty> : null}
        <Table
          header={["name", "state", "mode", "room", "model", "today", "heartbeat"]}
          widths={[16, 11, 9, 10, 8, 8, 12]}
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
      <Panel title={a ? a.name : "agent"} width="40%">
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

function RoomsTab(props: { rooms: RoomView[]; selected: number }): React.JSX.Element {
  const r = props.rooms[props.selected];
  return (
    <Box width="100%" gap={1}>
      <Panel title="rooms" active width="60%">
        {props.rooms.length === 0 ? <Empty>no room yet: press n</Empty> : null}
        <Table
          header={["alias", "handle", "online", "tasks", "approvals", ""]}
          widths={[12, 14, 10, 6, 10, 8]}
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
      <Panel title={r ? (r.alias ?? r.handle) : "room"} width="40%">
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

function ApprovalsTab(props: { cards: CardView[]; selected: number; aliasOf: (h: string | null | undefined) => string }): React.JSX.Element {
  const c = props.cards[props.selected];
  return (
    <Box width="100%" gap={1}>
      <Panel title="pending approvals" active width="55%">
        {props.cards.length === 0 ? <Empty>nothing waits for you. A card appears here the moment an agent asks to act.</Empty> : null}
        <Table
          header={["id", "from", "action", "room", "expires"]}
          widths={[14, 14, 22, 10, 10]}
          selected={props.selected}
          rows={props.cards.map((x) => [x.request_id, x.requester_name, x.action, props.aliasOf(x.room), x.expires_at ? `in ${fmtMs(Math.max(0, Date.parse(x.expires_at) - Date.now()))}` : "-"])}
        />
      </Panel>
      <Panel title={c ? c.request_id : "card"} width="45%">
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
              <Text dimColor>y approve · n reject (with a reason)</Text>
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

  const ask = useCallback(
    async (capability: string) => {
      setStage("asking");
      t0.current = Date.now();
      try {
        const out = await askInRoom(props.ctx, props.hub, props.room, capability, question);
        setOutcome(out);
        setStage("answer");
        props.onDone();
      } catch (err) {
        setError((err as Error).message);
        setStage("answer");
      }
    },
    [props, question],
  );

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
  void ask;

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
          <Box marginTop={1}>
            <Text dimColor>
              {answerLines.length > 14 ? "j/k scroll · " : ""}enter or esc closes{outcome?.run_id ? " · rfa evals label --prepare lists it if it was wrong" : ""}
            </Text>
          </Box>
        </Box>
      ) : null}
      <Gauge value={0} max={1} width={0} />
    </Panel>
  );
}
