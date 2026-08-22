/**
 * The handful of building blocks every screen is made of. A panel is a rounded
 * box whose title sits in the first line; the active one is painted in the
 * accent. Keys are shown the way lazygit shows them: the key, then its verb.
 */
import React, { useState } from "react";
import { Box, Text, useAnimation, useInput } from "ink";
import { ACCENT, GLYPH, MUTED, PRESENCE } from "./theme.js";

export function Panel(props: { title: string; active?: boolean; hint?: string; children?: React.ReactNode; width?: number | string; height?: number | string; flexGrow?: number; minHeight?: number }): React.JSX.Element {
  const color = props.active ? ACCENT : MUTED;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={props.width} height={props.height} flexGrow={props.flexGrow} minHeight={props.minHeight} overflow="hidden">
      <Box justifyContent="space-between">
        <Text color={color} bold={props.active}>
          {props.title}
        </Text>
        {props.hint ? <Text dimColor>{props.hint}</Text> : null}
      </Box>
      {props.children}
    </Box>
  );
}

export function Dot(props: { state: string; pulse?: boolean }): React.JSX.Element {
  const color = PRESENCE[props.state] ?? MUTED;
  const on = props.state !== "offline" && props.state !== "stopped";
  return <Text color={color}>{props.pulse ? GLYPH.half : on ? GLYPH.on : GLYPH.off}</Text>;
}

export function Key(props: { k: string; label: string }): React.JSX.Element {
  return (
    <Text>
      <Text color={ACCENT}>{props.k}</Text>
      <Text dimColor> {props.label}</Text>
    </Text>
  );
}

export function Keys(props: { items: [string, string][] }): React.JSX.Element {
  return (
    <Box gap={2} flexWrap="wrap">
      {props.items.map(([k, label]) => (
        <Key key={k + label} k={k} label={label} />
      ))}
    </Box>
  );
}

export function Spin(props: { label?: string; color?: string }): React.JSX.Element {
  const { frame } = useAnimation({ interval: 120 });
  return (
    <Text color={props.color ?? ACCENT}>
      {GLYPH.spinner[frame % GLYPH.spinner.length]}
      {props.label ? ` ${props.label}` : ""}
    </Text>
  );
}

/** Rows of cells laid out in fixed columns; the selected row is inverted. */
export function Table(props: { widths: number[]; rows: React.ReactNode[][]; selected?: number; header?: string[] }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.header ? (
        <Box>
          {props.header.map((h, i) => (
            <Box key={i} width={props.widths[i]} marginRight={1}>
              <Text dimColor>{h}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {props.rows.map((cells, r) => (
        <Box key={r}>
          <Text color={props.selected === r ? ACCENT : undefined}>{props.selected === r ? "▸ " : "  "}</Text>
          {cells.map((c, i) => (
            <Box key={i} width={props.widths[i]} marginRight={1} overflow="hidden">
              {typeof c === "string" ? (
                <Text wrap="truncate-end" inverse={props.selected === r && i === 0}>
                  {c}
                </Text>
              ) : (
                c
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function Empty(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Box paddingY={1}>
      <Text dimColor>{props.children}</Text>
    </Box>
  );
}

/** A one-line gauge: `label ████░░░░ 42%`. */
export function Gauge(props: { value: number; max: number; width?: number; color?: string }): React.JSX.Element {
  const w = props.width ?? 12;
  const filled = props.max > 0 ? Math.round(Math.min(1, props.value / props.max) * w) : 0;
  return (
    <Text>
      <Text color={props.color ?? ACCENT}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(w - filled)}</Text>
    </Text>
  );
}

/**
 * A list to choose from. Enter chooses what is highlighted, whether or not it
 * is the default: a library select that only fires on CHANGE left the
 * onboarding stuck on its own default, which is the common case.
 */
export function Choice(props: { options: { value: string; label: string; hint?: string }[]; initial?: string; onChoose: (value: string) => void; isActive?: boolean }): React.JSX.Element {
  const start = Math.max(0, props.options.findIndex((o) => o.value === props.initial));
  const [cursor, setCursor] = useState(start);
  useInput(
    (input, key) => {
      if (key.downArrow || input === "j" || (key.ctrl && input === "n")) setCursor((c) => Math.min(props.options.length - 1, c + 1));
      else if (key.upArrow || input === "k" || (key.ctrl && input === "p")) setCursor((c) => Math.max(0, c - 1));
      else if (key.return || input === " ") props.onChoose(props.options[cursor].value);
    },
    { isActive: props.isActive ?? true },
  );
  return (
    <Box flexDirection="column">
      {props.options.map((o, i) => (
        <Box key={o.value}>
          <Text color={i === cursor ? ACCENT : undefined}>{i === cursor ? "▸ " : "  "}</Text>
          <Text color={i === cursor ? ACCENT : undefined} bold={i === cursor}>
            {o.label}
          </Text>
          {o.hint ? <Text dimColor>  {o.hint}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
