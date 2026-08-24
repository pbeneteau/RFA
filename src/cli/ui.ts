/**
 * How `rfa` speaks (RFA-0.7 sect. 5): past tense for what it did, one line of
 * cause and one of fix for what went wrong, the same object behind `--json` as
 * behind the human view, and nothing animated on a pipe.
 *
 * One accent, one danger color, a fixed set of symbols, one box (the init
 * banner) and no other box anywhere. Colors come from `util.styleText` and go
 * away under `NO_COLOR`, `--no-color`, `--json` or a non-TTY stdout.
 */
import { styleText } from "node:util";

export type Style = Parameters<typeof styleText>[0];

export interface UiOptions {
  color: boolean;
  json: boolean;
  quiet: boolean;
  tty: boolean;
}

export const SYMBOL = {
  ok: "✔",
  fail: "✖",
  warn: "!",
  step: "▸",
  spin: ["◐", "◓", "◑", "◒"],
  on: "●",
  off: "○",
  prompt: "◆",
} as const;

export class Ui {
  constructor(readonly opts: UiOptions) {}

  paint(style: Style, text: string): string {
    return this.opts.color ? styleText(style, text) : text;
  }
  dim(t: string): string {
    return this.paint("dim", t);
  }
  bold(t: string): string {
    return this.paint("bold", t);
  }
  /** The one accent (the console's blue). */
  accent(t: string): string {
    return this.paint("cyan", t);
  }
  good(t: string): string {
    return this.paint("green", t);
  }
  caution(t: string): string {
    return this.paint("yellow", t);
  }
  bad(t: string): string {
    return this.paint("red", t);
  }

  /** Presence as the console paints it: green ready, amber busy, dim away and offline. */
  presence(state: string): string {
    switch (state) {
      case "ready":
        return this.good(SYMBOL.on);
      case "busy":
        return this.caution(SYMBOL.on);
      case "away":
        return this.dim(SYMBOL.on);
      default:
        return this.dim(SYMBOL.off);
    }
  }

  /** Plain stdout, suppressed by --quiet and by --json (which owns stdout). */
  line(text = ""): void {
    if (this.opts.quiet || this.opts.json) return;
    process.stdout.write(text + "\n");
  }
  /** Something that was just done, in the past tense, with an optional dim detail. */
  done(what: string, detail?: string): void {
    this.line(` ${this.good(SYMBOL.ok)} ${what}${detail ? `  ${this.dim(detail)}` : ""}`);
  }
  step(what: string, detail?: string): void {
    this.line(` ${this.dim(SYMBOL.step)} ${what}${detail ? `  ${this.dim(detail)}` : ""}`);
  }
  warn(what: string, detail?: string): void {
    if (this.opts.json) return;
    process.stderr.write(` ${this.caution(SYMBOL.warn)} ${what}${detail ? `  ${this.dim(detail)}` : ""}\n`);
  }
  /** One line of cause, then one line of fix. Always on stderr, never suppressed by --quiet. */
  fail(cause: string, fix?: string): void {
    if (this.opts.json) return;
    process.stderr.write(` ${this.bad(SYMBOL.fail)} ${cause}\n`);
    if (fix) process.stderr.write(`   ${this.dim(fix)}\n`);
  }
  /** An indented explanation: the dim "why" under a step. */
  note(...lines: string[]): void {
    for (const l of lines) this.line(`     ${this.dim(l)}`);
  }
  blank(): void {
    this.line("");
  }

  /** Columns with a two-space gutter; numbers right-aligned when the column says so. */
  table(rows: string[][], opts: { align?: ("l" | "r")[]; indent?: number } = {}): void {
    if (rows.length === 0) return;
    const widths: number[] = [];
    for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))));
    const pad = " ".repeat(opts.indent ?? 2);
    for (const row of rows) {
      const cells = row.map((cell, i) => {
        const fill = " ".repeat(Math.max(0, widths[i] - visibleLength(cell)));
        return (opts.align?.[i] ?? "l") === "r" ? fill + cell : cell + fill;
      });
      this.line((pad + cells.join("  ")).replace(/\s+$/, ""));
    }
  }

  /** The one box: the init banner. */
  box(lines: string[]): void {
    const width = Math.max(...lines.map(visibleLength));
    const top = `   ┌${"─".repeat(width + 2)}┐`;
    const bottom = `   └${"─".repeat(width + 2)}┘`;
    this.line(this.dim(top));
    for (const l of lines) this.line(`${this.dim("   │")} ${l}${" ".repeat(width - visibleLength(l))} ${this.dim("│")}`);
    this.line(this.dim(bottom));
  }

  /** JSON on stdout, the same object the human view was rendered from. */
  json(value: unknown): void {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  }

  /**
   * A wait with elapsed seconds on a terminal; one line at start and one at
   * the end on a pipe, so a script's log stays readable.
   */
  spinner(text: string): Spinner {
    return new Spinner(this, text);
  }
}

export class Spinner {
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private text: string;

  constructor(
    private readonly ui: Ui,
    text: string,
  ) {
    this.text = text;
    if (ui.opts.quiet || ui.opts.json) return;
    if (ui.opts.tty) {
      this.timer = setInterval(() => this.draw(), 100);
      this.draw();
    } else {
      process.stdout.write(` ${SYMBOL.spin[0]} ${text}\n`);
    }
  }

  private elapsed(): string {
    return `${((Date.now() - this.startedAt) / 1000).toFixed(0)}s`;
  }

  private draw(): void {
    this.frame = (this.frame + 1) % SYMBOL.spin.length;
    process.stdout.write(`\r\x1b[2K ${this.ui.accent(SYMBOL.spin[this.frame])} ${this.text} ${this.ui.dim(this.elapsed())}`);
  }

  update(text: string): void {
    const changed = text !== this.text;
    this.text = text;
    // On a pipe every update is a printed line, and a poll re-affirming the same
    // wait (the ask's approval watch, every 3s) must not become a line per tick.
    if (changed && !this.timer && !this.ui.opts.tty && !this.ui.opts.quiet && !this.ui.opts.json) process.stdout.write(` ${SYMBOL.spin[0]} ${text}\n`);
  }

  /** Replace the spinner line with the result; never leave it above. */
  stop(result: { ok: boolean; text: string; detail?: string }): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stdout.write("\r\x1b[2K");
    }
    const detail = result.detail ? `  ${this.ui.dim(result.detail)}` : "";
    if (result.ok) this.ui.done(result.text, result.detail ? result.detail : undefined);
    else if (!this.ui.opts.json) process.stderr.write(` ${this.ui.bad(SYMBOL.fail)} ${result.text}${detail}\n`);
  }
}

/** Length without ANSI escapes, for column widths. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function fmtAge(isoOrMs: string | number | null | undefined, now = Date.now()): string {
  if (isoOrMs === null || isoOrMs === undefined) return "never";
  const t = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(t)) return "?";
  return `${fmtDuration(now - t)} ago`;
}
