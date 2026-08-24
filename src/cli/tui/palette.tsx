/**
 * The command palette: every `rfa` command, fuzzy-searched by name and
 * summary, run from a keystroke. It exists because the operator kept forgetting
 * the long forms; so besides running a command it always shows the exact
 * command line it is about to run, which is how the long forms get learned.
 *
 * A command whose usage starts with required arguments (`<name>`) asks for
 * them in place, one field per argument, before running.
 */
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import fuzzysort from "fuzzysort";
import type { CommandDef } from "../router.js";
import { ACCENT, MUTED } from "./theme.js";
import { Key } from "./widgets.js";

export interface PaletteItem {
  id: string;
  path: string[];
  summary: string;
  usage: string;
  /** The `<name>`-style tokens the command needs before it can run. */
  required: string[];
}

export function paletteItems(commands: CommandDef[]): PaletteItem[] {
  return commands
    .filter((c) => !c.hidden)
    .map((c) => ({ id: c.path.join(" "), path: c.path, summary: c.summary, usage: c.usage ?? "", required: requiredArgs(c.usage ?? "") }));
}

/** `<alias|handle> "<question>" [--room]` -> ["alias|handle", "question"]: the leading required tokens only. */
export function requiredArgs(usage: string): string[] {
  const out: string[] = [];
  for (const tok of usage.trim().split(/\s+/)) {
    if (!tok) continue;
    const m = /^"?<([^>]+)>"?$/.exec(tok);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

export function searchPalette(items: PaletteItem[], query: string, limit = 12): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  // fuzzysort 4 scores in [0, 1]; a negative threshold accepts everything (see src/cli/suggest.ts).
  const hits = fuzzysort.go(q, items, { keys: ["id", "summary"], limit: limit * 2, threshold: 0.3 }).map((r) => r.obj);
  // What the operator typed as a prefix of a command beats a scattered match of
  // the same letters, and among prefix matches the order is alphabetical, so
  // "agent re" lists restart before retire every time rather than by score.
  const prefix = hits.filter((h) => h.id.startsWith(q)).sort((a, b) => a.id.localeCompare(b.id));
  return [...prefix, ...hits.filter((h) => !prefix.includes(h))].slice(0, limit);
}

export function Palette(props: { items: PaletteItem[]; initialQuery?: string; onRun: (argv: string[]) => void; onClose: () => void; recent?: string[] }): React.JSX.Element {
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<PaletteItem | null>(null);
  const [args, setArgs] = useState<string[]>([]);
  const results = useMemo(() => {
    const found = searchPalette(props.items, query);
    if (query.trim() || !props.recent?.length) return found;
    // With no query, what was run last comes first: the operator's own habits are the best index.
    const recent = props.recent.map((id) => props.items.find((i) => i.id === id)).filter((x): x is PaletteItem => Boolean(x));
    return [...recent, ...found.filter((f) => !recent.includes(f))].slice(0, 12);
  }, [props.items, props.recent, query]);
  const selected = results[Math.min(cursor, Math.max(0, results.length - 1))];

  useInput(
    (input, key) => {
      if (key.escape) {
        if (chosen) {
          setChosen(null);
          setArgs([]);
        } else props.onClose();
        return;
      }
      if (chosen) return; // the argument field owns the keys
      if (key.upArrow || (key.ctrl && input === "p")) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || (key.ctrl && input === "n")) setCursor((c) => Math.min(results.length - 1, c + 1));
      else if (key.return && selected) {
        if (selected.required.length === 0) props.onRun(selected.path);
        else setChosen(selected);
      }
    },
    { isActive: true },
  );

  if (chosen) {
    const index = args.length;
    const label = chosen.required[index];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Text>
          <Text color={ACCENT} bold>
            rfa {chosen.id}
          </Text>
          <Text dimColor>  {chosen.usage}</Text>
        </Text>
        {args.map((a, i) => (
          <Text key={i}>
            <Text dimColor>{chosen.required[i]}: </Text>
            {a}
          </Text>
        ))}
        <Box>
          <Text color={ACCENT}>{label}: </Text>
          <TextInput
            key={index}
            placeholder={`the ${label}`}
            onSubmit={(v) => {
              const next = [...args, v.trim()];
              if (next.length < chosen.required.length) setArgs(next);
              else props.onRun([...chosen.path, ...next]);
            }}
          />
        </Box>
        <Box marginTop={1} gap={2}>
          <Key k="enter" label="next" />
          <Key k="esc" label="back" />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Box>
        <Text color={ACCENT}>: </Text>
        <TextInput placeholder="type a command or what you want to do" defaultValue={props.initialQuery} onChange={(v) => {
          setQuery(v);
          setCursor(0);
        }} />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {results.length === 0 ? <Text dimColor>nothing matches</Text> : null}
        {results.map((r, i) => (
          <Box key={r.id}>
            <Text color={i === cursor ? ACCENT : undefined}>{i === cursor ? "▸ " : "  "}</Text>
            <Box width={28}>
              <Text bold={i === cursor} color={i === cursor ? ACCENT : undefined} wrap="truncate-end">
                rfa {r.id}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {r.summary}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Box gap={2}>
          <Key k="enter" label="run" />
          <Key k="↑↓" label="move" />
          <Key k="esc" label="close" />
        </Box>
        {selected ? (
          <Text color={MUTED}>
            runs: rfa {selected.id}
            {selected.required.map((r) => ` <${r}>`).join("")}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
