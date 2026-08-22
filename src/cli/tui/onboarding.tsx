/**
 * The onboarding (RFA-0.7 sect. 11.1): what `rfa` opens in a folder that is
 * not a hub directory yet. One question per screen, the reason for the question
 * beside it, back with escape, and then the provisioning as a live checklist
 * that ends in a real answer from a real agent, because the point of the first
 * minute is to reach first value, not to finish a form.
 *
 * Every answer has a flag, and `rfa init --yes` runs the same provisioning
 * with no screen at all: the onboarding is a way to fill InitAnswers, nothing
 * more, so it can never do something the headless path cannot.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { HubDir } from "../../hubdir.js";
import { packageVersion } from "../../pkg.js";
import type { CliContext } from "../context.js";
import { defaultAnswers, provision, type InitAnswers, type ProvisionResult, type Reporter } from "../commands/init.js";
import { nextFreePort, portFree } from "../preflight.js";
import { BUILTIN_SERVERS, builtinTool, nameProblem } from "../scaffold.js";
import { firstAsk, type AskOutcome } from "./data.js";
import { Wordmark } from "./logo.js";
import { ACCENT, BAD, fmtMs, fmtUsd, GOOD, MUTED, WARN } from "./theme.js";
import { Choice, Key, Keys, Panel, Spin } from "./widgets.js";

export interface OnboardingResult {
  code: number;
  openDashboard: boolean;
  hub: HubDir | null;
}

type Screen = "welcome" | "mode" | "name" | "port" | "remote" | "human" | "agent" | "agentName" | "knowledge" | "toolServer" | "room" | "roomHandle" | "start" | "provision" | "ask" | "done";

interface Line {
  kind: "done" | "step" | "warn" | "note";
  text: string;
  detail?: string;
}

const ORDER: Screen[] = ["welcome", "mode", "name", "port", "remote", "human", "agent", "agentName", "knowledge", "toolServer", "room", "roomHandle", "start", "provision", "ask", "done"];

/** Which screens apply, given the answers so far and whether the directory already exists. */
export function applicable(screen: Screen, a: InitAnswers, existing: boolean): boolean {
  switch (screen) {
    case "mode":
    case "name":
      return !existing;
    case "port":
      return !existing && a.mode === "hub";
    case "remote":
      return !existing && a.mode === "remote";
    case "agentName":
      return a.agentKind !== "none";
    case "knowledge":
      return a.agentKind === "answerer";
    case "toolServer":
      return a.agentKind === "tool";
    case "room":
      return a.agentKind !== "none" && a.mode === "hub";
    case "roomHandle":
      return a.agentKind !== "none" && a.mode === "remote";
    default:
      return true;
  }
}

export function nextScreen(from: Screen, a: InitAnswers, existing: boolean, dir: 1 | -1 = 1): Screen {
  let i = ORDER.indexOf(from) + dir;
  while (i > 0 && i < ORDER.length && !applicable(ORDER[i], a, existing)) i += dir;
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, i))];
}

const WHY: Record<Screen, { title: string; lines: string[] }> = {
  welcome: { title: "", lines: [] },
  mode: { title: "one folder, three parts", lines: ["The hub is the room server: agents and people talk through it, over MCP.", "The supervisor keeps your local agents running and restarts them when they die.", "agents/ holds one folder per agent; a markdown file is the whole definition.", "", "Hosting agents for a hub elsewhere needs that hub's URL and a bearer from its operator."] },
  name: { title: "the instance name", lines: ["It names the process titles, the backup folder and the service label.", "Lowercase letters, digits, dots and hyphens, like a hostname."] },
  port: { title: "where the hub listens", lines: ["Loopback only, until you expose it on purpose (rfa hub expose).", "Nothing here phones home."] },
  remote: { title: "a hub elsewhere", lines: ["Its operator ran `rfa peer add` for you and handed over a bearer.", "The bearer is your credential; it never travels through a model's context."] },
  human: { title: "your human principal", lines: ["The only thing that can approve an agent's action or lift a quarantine.", "Your key is minted once and shown once, at the end. The CLI keeps its own copy."] },
  agent: { title: "the first agent", lines: ["spec-expert answers about the RFA protocol from the spec shipped in this package; it works with nothing else, which is why it is the default.", "An answerer reads a folder of markdown you point it at.", "A tool user acts on requests, behind your approval, with an MCP server you name."] },
  agentName: { title: "its name", lines: ["Lowercase, no spaces; it is a folder under agents/ and the name the room sees.", "Reserved first words (human, console, system, hub, rfa) are refused here rather than at join."] },
  toolServer: { title: "what it acts through", lines: ["A tool user brings its own MCP server; the supervisor starts it beside the agent, with only the secrets the pack declares.", "The tool id is what pauses for your approval: every call to mcp__<server>__<tool> becomes a card you approve, edit or reject.", "", "One that works with nothing installed: command `npx -y @modelcontextprotocol/server-filesystem /tmp/scratch`, tool `write_file`."] },
  knowledge: { title: "what it answers from", lines: ["A folder of markdown. It is attached as a glob; nothing is copied.", "Leave it blank and fill agents/<name>/knowledge/ later, or `rfa knowledge add` a git repository."] },
  room: { title: "a room for it", lines: ["Rooms are the isolation unit: everyone in a room sees everything in it.", "You host this one. Agents join it with the bearer; there is no secret to paste."] },
  roomHandle: { title: "the room's handle", lines: ["The far hub's operator gives it to you with the bearer (r_ plus hex)."] },
  start: { title: "start now?", lines: ["rfa up starts the hub and the supervisor as daemons and leaves them running.", "rfa down stops them; rfa service install keeps them across reboots."] },
  provision: { title: "what is being written", lines: ["rfa.json is the manifest: commit it.", ".rfa/ is the runtime the tool owns, gitignored, 0700.", "Credentials rest as hashes; the plaintext stays in .rfa/secrets.json, 0600."] },
  ask: { title: "first value", lines: ["The asker joins the room as you, finds the agent by capability, and waits for the answer.", "Answers carry citations, cost and a run id, every time."] },
  done: { title: "", lines: [] },
};

export function Onboarding(props: { ctx: CliContext; target: string; existing: HubDir | null; flags: Record<string, string | boolean | undefined> }): React.JSX.Element {
  const { exit } = useApp();
  const existing = Boolean(props.existing);
  const [answers, setAnswers] = useState<InitAnswers | null>(null);
  const [screen, setScreen] = useState<Screen>("welcome");
  const [portTaken, setPortTaken] = useState<number | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [question, setQuestion] = useState<string>("");
  const [asking, setAsking] = useState(false);
  const [outcome, setOutcome] = useState<AskOutcome | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    void (async () => {
      const a = await defaultAnswers(props.ctx, props.flags, props.target, props.existing);
      setAnswers(a);
      if (a.mode === "hub" && !(await portFree(a.port))) setPortTaken(a.port);
    })();
  }, [props.ctx, props.flags, props.target, props.existing]);

  const go = (dir: 1 | -1) => {
    if (!answers) return;
    setScreen((s) => nextScreen(s, answers, existing, dir));
  };
  const set = (patch: Partial<InitAnswers>) => setAnswers((a) => (a ? { ...a, ...patch } : a));

  // Provisioning: once, when the screen is reached, reporting into the checklist.
  useEffect(() => {
    if (screen !== "provision" || !answers || started.current) return;
    started.current = true;
    const report: Reporter = {
      done: (text, detail) => setLines((l) => [...l, { kind: "done", text, detail }]),
      step: (text, detail) => setLines((l) => [...l, { kind: "step", text, detail }]),
      warn: (text, detail) => setLines((l) => [...l, { kind: "warn", text, detail }]),
      note: (...ns) => setLines((l) => [...l, ...ns.map((text) => ({ kind: "note" as const, text }))]),
      blank: () => {},
    };
    void (async () => {
      try {
        const r = await provision(props.ctx, props.target, answers, { report, force: Boolean(props.flags.force) });
        setResult(r);
        if (r.ready?.ready && r.agent && r.room) {
          setQuestion(r.agent.skillId === "answer-protocol-question" ? "How do presence leases work?" : "");
          setScreen("ask");
        } else setScreen("done");
      } catch (err) {
        const e = err as Error & { hint?: string };
        setFailure(e.hint ? `${e.message}\n${e.hint}` : e.message);
      }
    })();
  }, [screen, answers, props]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return exit({ code: 2, openDashboard: false, hub: null } satisfies OnboardingResult);
      if (screen === "welcome") {
        if (input === "q") return exit({ code: 0, openDashboard: false, hub: null } satisfies OnboardingResult);
        if (key.return || input === " ") return go(1);
      }
      if (screen === "done") {
        if (input === "q" || key.escape) return exit({ code: 0, openDashboard: false, hub: result?.h ?? null } satisfies OnboardingResult);
        if (key.return) return exit({ code: 0, openDashboard: true, hub: result?.h ?? null } satisfies OnboardingResult);
      }
      if (screen === "provision" && failure && (input === "q" || key.return || key.escape)) return exit({ code: 1, openDashboard: false, hub: null } satisfies OnboardingResult);
      if (screen === "ask" && !asking && outcome && (key.return || key.escape)) return setScreen("done");
      if (key.escape && screen !== "provision" && screen !== "ask" && screen !== "done") return go(-1);
    },
    { isActive: true },
  );

  if (!answers) return <Spin label="looking around" />;
  const why = WHY[screen];
  const version = packageVersion();

  const question_ = (label: string, body: React.ReactNode, footer?: [string, string][]) => (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Wordmark />
      </Box>
      <Box gap={2}>
        <Panel title={label} active width={54}>
          {body}
          <Box marginTop={1}>
            <Keys items={footer ?? [["enter", "next"], ["esc", "back"]]} />
          </Box>
        </Panel>
        <Panel title={why.title} width={50}>
          {why.lines.map((l, i) => (
            <Text key={i} dimColor={l !== ""} wrap="wrap">
              {l || " "}
            </Text>
          ))}
        </Panel>
      </Box>
    </Box>
  );

  switch (screen) {
    case "welcome":
      return (
        <Box flexDirection="column" paddingX={1}>
          <Wordmark reveal version={version} />
          <Box marginTop={1} flexDirection="column">
            <Text>One room. Agents from more than one place. One log you can verify. One human who can stop it.</Text>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>
                {existing ? `${props.target} is already a hub directory (${props.existing!.manifest.name}); re-running adds what is missing and rotates nothing.` : `${props.target} becomes a hub directory: a manifest, a folder per agent, a gitignored runtime the tool owns.`}
              </Text>
              <Text dimColor>Six questions, each with a default. About a minute to the first answer from a real agent.</Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Keys items={[["enter", "begin"], ["q", "not now"]]} />
          </Box>
        </Box>
      );
    case "mode":
      return question_(
        "Run a hub here, or host agents for a hub elsewhere?",
        <Choice
          initial={answers.mode}
          options={[
            { label: "Run a hub here", value: "hub", hint: "the server, the supervisor and the agents, in this folder" },
            { label: "Connect to a hub elsewhere", value: "remote", hint: "its URL and a bearer from its operator" },
          ]}
          onChoose={(v) => {
            set({ mode: v as "hub" | "remote" });
            setScreen(nextScreen("mode", { ...answers, mode: v as "hub" | "remote" }, existing));
          }}
        />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "name":
      return question_(
        "Name this hub",
        <Field key="name" value={answers.name} validate={(v) => (/^[a-z0-9][a-z0-9.-]{0,63}$/.test(v) ? null : "lowercase letters, digits, dots and hyphens; must start with a letter or digit")} onSubmit={(v) => {
          set({ name: v });
          go(1);
        }} />,
      );
    case "port":
      return question_(
        portTaken ? `Port (${portTaken} is taken)` : "Port",
        <Field key={`port-${answers.port}`} value={String(answers.port)} validate={(v) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? null : "a port number")} onSubmit={async (v) => {
          const p = Number(v);
          if (!(await portFree(p))) {
            setPortTaken(p);
            set({ port: await nextFreePort(p + 1) });
            return;
          }
          set({ port: p });
          go(1);
        }} />,
      );
    case "remote":
      return question_(
        "The hub's /mcp URL, then the bearer its operator gave you",
        <RemoteFields url={answers.hubUrl ?? "https://"} onSubmit={(url, tok) => {
          set({ hubUrl: url, remoteToken: tok });
          go(1);
        }} />,
      );
    case "human":
      return question_(
        "Your name",
        <Field key="human" value={answers.human} validate={(v) => nameProblem(v) ?? (/^[a-z0-9][a-z0-9.-]*$/.test(v) ? null : "lowercase letters, digits, dots and hyphens")} onSubmit={(v) => {
          set({ human: v });
          go(1);
        }} />,
      );
    case "agent":
      return question_(
        "Your first agent?",
        <Choice
          initial={answers.agentKind}
          options={[
            { label: "spec-expert", value: "spec-expert", hint: "answers about the RFA protocol; works out of the box" },
            { label: "an answerer", value: "answerer", hint: "answers from a folder of markdown" },
            { label: "a tool user", value: "tool", hint: "acts on requests, behind your approval" },
            { label: "none yet", value: "none" },
          ]}
          onChoose={(v) => {
            const kind = v as InitAnswers["agentKind"];
            const next = { ...answers, agentKind: kind, agentName: kind === "spec-expert" ? "spec-expert" : answers.agentName === "spec-expert" ? "" : answers.agentName };
            setAnswers(next);
            setScreen(nextScreen("agent", next, existing));
          }}
        />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "agentName":
      return question_(
        "Name it",
        <Field key="agentName" value={answers.agentName} validate={(v) => nameProblem(v)} onSubmit={(v) => {
          set({ agentName: v });
          go(1);
        }} />,
      );
    case "knowledge":
      return question_(
        "A folder of markdown it should answer from (blank to fill knowledge/ later)",
        <Field key="knowledge" value={answers.knowledge ?? ""} placeholder="./docs" allowEmpty validate={(v) => (!v || fs.existsSync(path.resolve(v)) ? null : `no such folder: ${v}`)} onSubmit={(v) => {
          set({ knowledge: v.trim() || undefined });
          go(1);
        }} />,
      );
    case "toolServer":
      return question_(
        "The MCP server it acts through",
        <ToolServerFields initial={answers.toolServer} onSubmit={(t) => {
          set({ toolServer: t });
          go(1);
        }} />,
        [["enter", "next"], ["esc", "back"]],
      );
    case "room":
      return question_(
        "A room for it",
        <Field key="room" value={answers.room} validate={(v) => (/^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? null : "an alias: lowercase letters, digits, hyphens")} onSubmit={(v) => {
          set({ room: v });
          go(1);
        }} />,
      );
    case "roomHandle":
      return question_(
        "The room handle its operator gave you",
        <Field key="roomHandle" value={answers.roomHandle ?? ""} placeholder="r_0123456789" validate={(v) => (/^r_[a-f0-9]+$/.test(v) ? null : "r_ plus hex")} onSubmit={(v) => {
          set({ roomHandle: v });
          go(1);
        }} />,
      );
    case "start":
      return question_(
        answers.mode === "hub" ? "Start the hub and the supervisor now?" : "Start the supervisor now?",
        <Choice
          initial={answers.start ? "yes" : "no"}
          options={[
            { label: "Yes, and ask the first question", value: "yes" },
            { label: "Not yet", value: "no", hint: "rfa up later" },
          ]}
          onChoose={(v) => {
            set({ start: v === "yes" });
            setScreen("provision");
          }}
        />,
        [["enter", "choose"], ["esc", "back"]],
      );
    case "provision":
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Wordmark />
          </Box>
          <Box gap={2}>
            <Panel title={failure ? "stopped" : result ? "written" : "writing"} active width={70}>
              {lines.map((l, i) => (
                <Box key={i} flexDirection="column">
                  <Text>
                    <Text color={l.kind === "done" ? GOOD : l.kind === "warn" ? WARN : l.kind === "note" ? MUTED : ACCENT}>{l.kind === "done" ? "✔" : l.kind === "warn" ? "!" : l.kind === "note" ? " " : "▸"}</Text>
                    <Text> {l.text}</Text>
                  </Text>
                  {l.detail ? <Text dimColor>    {l.detail}</Text> : null}
                </Box>
              ))}
              {!result && !failure ? (
                <Box marginTop={1}>
                  <Spin label={lines.length === 0 ? "starting" : "…"} />
                </Box>
              ) : null}
              {failure ? (
                <Box marginTop={1} flexDirection="column">
                  {failure.split("\n").map((l, i) => (
                    <Text key={i} color={i === 0 ? BAD : undefined} dimColor={i > 0} wrap="wrap">
                      {i === 0 ? `✖ ${l}` : `  ${l}`}
                    </Text>
                  ))}
                  <Text dimColor>what is listed above was written; rfa init again continues from there. enter leaves.</Text>
                </Box>
              ) : null}
            </Panel>
            <Panel title={why.title} width={44}>
              {why.lines.map((l, i) => (
                <Text key={i} dimColor wrap="wrap">
                  {l}
                </Text>
              ))}
            </Panel>
          </Box>
        </Box>
      );
    case "ask":
      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Wordmark />
          </Box>
          <Panel title={`${result?.agent?.name} is ready in ${answers.room}. Ask it something?`} active width={100}>
            {!asking && !outcome && !askError ? (
              <Box>
                <Text color={ACCENT}>? </Text>
                <TextInput defaultValue={question} placeholder="blank to skip" onSubmit={(v) => {
                  if (!v.trim() || !result?.room || !result.agent) return setScreen("done");
                  setAsking(true);
                  setQuestion(v.trim());
                  void firstAsk(props.ctx, result.room, result.agent.skillId, v.trim())
                    .then((o) => setOutcome(o))
                    .catch((err) => setAskError((err as Error).message))
                    .finally(() => setAsking(false));
                }} />
              </Box>
            ) : null}
            {asking ? (
              <Box flexDirection="column">
                <Text dimColor>"{question}"</Text>
                <Box marginTop={1}>
                  <Spin label={`${result?.agent?.name} is reading the spec`} />
                </Box>
              </Box>
            ) : null}
            {outcome ? (
              <Box flexDirection="column">
                <Text>
                  <Text color={outcome.kind === "response" ? GOOD : BAD}>{outcome.kind === "response" ? "✔" : "✖"}</Text>
                  <Text bold> {outcome.target} answered</Text>
                  <Text dimColor>
                    {" "}
                    {fmtMs(outcome.elapsed_ms)} · {fmtUsd(outcome.cost_usd)}
                    {outcome.run_id ? ` · ${outcome.run_id}` : ""}
                  </Text>
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {outcome.text.split("\n").slice(0, 18).map((l, i) => (
                    <Text key={i} wrap="wrap">
                      {l}
                    </Text>
                  ))}
                </Box>
                <Box marginTop={1}>
                  <Text color={GOOD}>That was your first answer: found by capability, cited, priced, logged in a chain you can verify. </Text>
                  <Key k="enter" label="continue" />
                </Box>
              </Box>
            ) : null}
            {askError ? (
              <Box flexDirection="column">
                <Text color={BAD}>✖ {askError}</Text>
                <Keys items={[["enter", "continue"]]} />
              </Box>
            ) : null}
          </Panel>
          <Box marginTop={1}>
            <Panel title={why.title} width={100}>
              {why.lines.map((l, i) => (
                <Text key={i} dimColor>
                  {l}
                </Text>
              ))}
            </Panel>
          </Box>
        </Box>
      );
    case "done":
      return <Done result={result} answers={answers} />;
  }
}

function Field(props: { value: string; placeholder?: string; allowEmpty?: boolean; validate: (v: string) => string | null | undefined; onSubmit: (v: string) => void | Promise<void> }): React.JSX.Element {
  const [err, setErr] = useState<string | null>(null);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={ACCENT}>› </Text>
        <TextInput
          defaultValue={props.value}
          placeholder={props.placeholder}
          onSubmit={(v) => {
            const t = v.trim();
            if (!t && !props.allowEmpty) return setErr("a value is needed");
            const problem = t || !props.allowEmpty ? props.validate(t) : null;
            if (problem) return setErr(problem);
            setErr(null);
            void props.onSubmit(t);
          }}
        />
      </Box>
      {err ? <Text color={BAD}>{err}</Text> : null}
    </Box>
  );
}

function RemoteFields(props: { url: string; onSubmit: (url: string, token: string) => void }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (url === null) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={ACCENT}>url › </Text>
          <TextInput key="url" defaultValue={props.url} onSubmit={(v) => (/^https?:\/\/.+\/mcp\/?$/.test(v.trim()) ? setUrl(v.trim()) : setErr("an http(s) URL ending in /mcp"))} />
        </Box>
        {err ? <Text color={BAD}>{err}</Text> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>{url}</Text>
      <Box>
        <Text color={ACCENT}>bearer › </Text>
        <TextInput key="bearer" placeholder="paste it; it is stored in .rfa/secrets.json (0600)" onSubmit={(v) => (v.trim().length >= 16 ? props.onSubmit(url, v.trim()) : setErr("a bearer is at least 16 characters"))} />
      </Box>
      {err ? <Text color={BAD}>{err}</Text> : null}
    </Box>
  );
}

/** A command line, the tool id, then the server's name with a default derived from the command. */
function ToolServerFields(props: { initial?: InitAnswers["toolServer"]; onSubmit: (t: NonNullable<InitAnswers["toolServer"]>) => void }): React.JSX.Element {
  const [kind, setKind] = useState<"builtin" | "custom" | null>(props.initial ? (props.initial.builtin ? "builtin" : "custom") : null);
  const [command, setCommand] = useState<string | null>(props.initial?.command ? [props.initial.command, ...(props.initial.args ?? [])].join(" ") : null);
  const [tool, setTool] = useState<string | null>(props.initial?.tool ?? null);
  const [err, setErr] = useState<string | null>(null);
  if (kind === null) {
    return (
      <Choice
        options={[
          ...Object.entries(BUILTIN_SERVERS).map(([name, b]) => ({ value: `builtin:${name}`, label: `${name}, built in`, hint: `${b.description}; needs ${b.envSecrets.join(", ")}` })),
          { value: "custom", label: "an MCP server I name", hint: "a command and the tool id to gate" },
        ]}
        onChoose={(v) => {
          if (v === "custom") return setKind("custom");
          props.onSubmit(builtinTool(v.slice("builtin:".length)));
        }}
      />
    );
  }
  const derived = (cmd: string) => {
    const pkg = cmd.split(/\s+/).find((t) => /[a-z]/.test(t) && !/^(npx|node|uvx|python3?|-y|--yes|rfa|server)$/.test(t) && !t.startsWith("-")) ?? "service";
    return pkg.replace(/^@[^/]+\//, "").replace(/^(mcp-server-|server-|mcp-)/, "").replace(/(-mcp-server|-server|-mcp)$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "service";
  };
  if (command === null) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={ACCENT}>command › </Text>
          <TextInput key="command" placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp/scratch" onSubmit={(v) => (v.trim() ? setCommand(v.trim()) : setErr("the command that starts the MCP server"))} />
        </Box>
        {err ? <Text color={BAD}>{err}</Text> : null}
      </Box>
    );
  }
  if (tool === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{command}</Text>
        <Box>
          <Text color={ACCENT}>tool id › </Text>
          <TextInput key="tool" placeholder="write_file" onSubmit={(v) => (/^[A-Za-z0-9_.-]+$/.test(v.trim()) ? setTool(v.trim()) : setErr("the tool's id as the server names it, letters, digits, _ . -"))} />
        </Box>
        {err ? <Text color={BAD}>{err}</Text> : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {command} · {tool}
      </Text>
      <Box>
        <Text color={ACCENT}>server name › </Text>
        <TextInput
          key="server"
          defaultValue={props.initial?.server ?? derived(command)}
          onSubmit={(v) => {
            const name = v.trim();
            if (!/^[a-z][a-z0-9-]*$/.test(name)) return setErr("lowercase letters, digits, hyphens; it becomes mcp__<name>__<tool>");
            const [cmd, ...args] = command.split(/\s+/);
            props.onSubmit({ server: name, command: cmd, args, tool });
          }}
        />
      </Box>
      {err ? <Text color={BAD}>{err}</Text> : null}
    </Box>
  );
}

function Done(props: { result: ProvisionResult | null; answers: InitAnswers }): React.JSX.Element {
  const r = props.result;
  const next = useMemo(() => {
    const rows: [string, string][] = [];
    if (!props.answers.start) rows.push(["rfa up", "start the hub and the supervisor"]);
    rows.push(["rfa", "this dashboard: status, agents, rooms, approvals, the live feed"]);
    if (r?.agent) rows.push(['rfa ask "…"', "ask by capability, from anywhere in this folder"]);
    if (props.answers.toolServer?.envSecrets?.length) rows.push([`rfa secrets set ${props.answers.toolServer.envSecrets[0]}`, `${props.answers.toolServer.server} runs in dry-run mode until it has this`]);
    rows.push(["rfa agent new <name>", "another agent (twenty seconds)"]);
    rows.push(["rfa connect claude-code", "let your Claude Code sessions ask this hub"]);
    rows.push(["rfa completion zsh --install", "tab completion, so the long commands complete themselves"]);
    return rows;
  }, [props.answers.start, props.answers.toolServer, r?.agent]);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Wordmark />
      </Box>
      <Panel title="your hub directory is ready" active width={100}>
        <Text>
          {r?.h.root} <Text dimColor>({r?.h.manifest.name}, {r?.h.mode}){props.answers.start ? "" : " · nothing is running yet"}</Text>
        </Text>
        <Box marginTop={1} flexDirection="column">
          {next.map(([c, d]) => (
            <Box key={c}>
              <Box width={32}>
                <Text color={ACCENT}>{c}</Text>
              </Box>
              <Text dimColor>{d}</Text>
            </Box>
          ))}
        </Box>
        {r?.minted.human ? (
          <Box marginTop={1} flexDirection="column">
            <Text>Your human key, shown once (rfa human rotate {props.answers.human} if you lose it):</Text>
            <Text bold color={WARN}>
              {"  "}
              {r.minted.human}
            </Text>
            <Text dimColor>It unlocks the console and is the only thing that can approve. This CLI keeps its own copy in .rfa/secrets.json.</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Keys items={[["enter", "open the dashboard"], ["q", "done"]]} />
        </Box>
      </Panel>
    </Box>
  );
}
