/**
 * The dashboard's visual vocabulary (RFA-0.7 sect. 11). One accent (the
 * console's blue), the presence colors the console already uses, and exactly
 * one flourish: the wordmark's gradient. Everything else is the terminal's own
 * palette so the dashboard sits naturally in whatever theme the operator runs.
 */

export const ACCENT = "#5fd7ff";
export const MUTED = "#8a8a8a";
export const GOOD = "#5fff87";
export const WARN = "#ffd75f";
export const BAD = "#ff5f5f";

/** cyan → violet → pink, left to right across the wordmark. */
export const GRADIENT = ["#7df9ff", "#8b7dff", "#ff7dd4"] as const;

export const PRESENCE: Record<string, string> = {
  ready: GOOD,
  busy: WARN,
  away: MUTED,
  offline: "#585858",
  running: GOOD,
  restarting: WARN,
  stopped: "#585858",
  "crash-looped": BAD,
};

export const GLYPH = {
  on: "●",
  off: "○",
  half: "◐",
  ok: "✔",
  fail: "✖",
  warn: "!",
  arrow: "▸",
  spinner: ["◐", "◓", "◑", "◒"],
  bars: "▁▂▃▄▅▆▇█",
} as const;

/**
 * The wordmark: figlet's "ANSI Shadow" glyphs for R, F and A, which is the
 * font Claude Code and Gemini CLI made the terminal's default for a name.
 */
export const WORDMARK = [
  "██████╗ ███████╗ █████╗ ",
  "██╔══██╗██╔════╝██╔══██╗",
  "██████╔╝█████╗  ███████║",
  "██╔══██╗██╔══╝  ██╔══██║",
  "██║  ██║██║     ██║  ██║",
  "╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝",
] as const;

export const TAGLINE = "Rooms for Agents";

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

export function lerpHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** The gradient color at position t in [0, 1]. */
export function gradientAt(t: number, stops: readonly string[] = GRADIENT): string {
  const clamped = Math.max(0, Math.min(1, t));
  const span = (stops.length - 1) * clamped;
  const i = Math.min(stops.length - 2, Math.floor(span));
  return lerpHex(stops[i], stops[i + 1], span - i);
}

/** A sparkline from numbers, one block character per value, scaled to the max. */
export function sparkline(values: number[], width = values.length): string {
  if (values.length === 0) return "";
  const tail = values.slice(-width);
  const max = Math.max(...tail, 1);
  return tail.map((v) => GLYPH.bars[Math.min(7, Math.round((v / max) * 7))]).join("");
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "-";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}
