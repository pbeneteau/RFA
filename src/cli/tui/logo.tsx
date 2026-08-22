/**
 * The wordmark, revealed left to right through its gradient. The reveal is the
 * dashboard's one piece of theatre and it is over in half a second; on the
 * dashboard header the mark is a single line and never animates again.
 */
import React from "react";
import { Box, Text, useAnimation } from "ink";
import { GRADIENT, gradientAt, TAGLINE, WORDMARK } from "./theme.js";

export function Wordmark(props: { reveal?: boolean; tagline?: string; version?: string }): React.JSX.Element {
  const width = WORDMARK[0].length;
  const { frame } = useAnimation({ interval: 18, isActive: Boolean(props.reveal) });
  // Columns appear in a sweep; a few columns ahead of the edge glow brighter.
  const edge = props.reveal ? Math.min(width + 6, frame) : width + 6;
  return (
    <Box flexDirection="column">
      {WORDMARK.map((row, r) => (
        <Text key={r}>
          {[...row].map((ch, c) => {
            if (c >= edge) return <Text key={c}> </Text>;
            const near = edge - c;
            const color = near <= 3 && props.reveal ? "#ffffff" : gradientAt(c / (width - 1));
            return (
              <Text key={c} color={color}>
                {ch}
              </Text>
            );
          })}
        </Text>
      ))}
      <Box marginTop={0}>
        <Text color={GRADIENT[1]}>{props.tagline ?? TAGLINE}</Text>
        {props.version ? <Text dimColor>  {props.version}</Text> : null}
      </Box>
    </Box>
  );
}

/** The inline mark for headers: `rfa` in the gradient, nothing else. */
export function Mark(): React.JSX.Element {
  const letters = ["r", "f", "a"];
  return (
    <Text bold>
      {letters.map((l, i) => (
        <Text key={l} color={gradientAt(i / (letters.length - 1))}>
          {l}
        </Text>
      ))}
    </Text>
  );
}
