/**
 * Verify a room's hash chain, offline (wire sect. 13, rung v0.6.3b).
 *
 * Reads files and nothing else: no `RoomHub`, no network, no lock. Sect. 13 says
 * tamper evidence must be verifiable offline, and a verifier that boots the thing
 * it is auditing is not offline. It is also safe to point at a live room log
 * directory while the hub is running, because it only ever opens files for
 * reading.
 *
 * The genesis link is the hex SHA-256 of the room handle, and the handle is taken
 * from the FILENAME rather than from inside the file, on purpose: reading it from
 * the log's own contents would let a rewritten log choose the value its own genesis
 * is checked against.
 *
 * Was scripts/verify-log.ts; now `rfa log verify`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { genesisFor, verifyChain, type ChainResult } from "./chain.js";

export type LogReport = ChainResult & { file: string; handle: string; torn: number; badMid: number; verdict: "INTACT" | "NOT-CHAINED" | "DIVERGED" };

/**
 * A torn final line is expected, not corruption: the log is append-only and a hub
 * killed mid-write leaves a partial last line. Reporting it as tampering would cry
 * wolf on the most ordinary crash there is, so it is counted separately and only
 * the readable prefix is verified. A torn line anywhere ELSE is a different thing
 * and is reported as unparseable.
 */
function readEvents(file: string): { events: Record<string, unknown>[]; torn: number; badMid: number } {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const events: Record<string, unknown>[] = [];
  let torn = 0;
  let badMid = 0;
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]) as Record<string, unknown>);
    } catch {
      if (i === lines.length - 1) torn++;
      else badMid++;
    }
  }
  return { events, torn, badMid };
}

export function verifyLogFile(file: string): LogReport {
  const handle = path.basename(file).replace(/\.ndjson$/, "");
  const { events, torn, badMid } = readEvents(file);
  const res = verifyChain(events, { genesis: genesisFor(handle) });
  // NOT-CHAINED is a third verdict on purpose. A log that predates the chain has
  // nothing to check, and printing "INTACT" over zero checked links is a green
  // light that means nothing, which is worse than no light at all.
  const verdict = !res.ok ? "DIVERGED" : res.unverifiable ? "NOT-CHAINED" : "INTACT";
  return { ...res, file, handle, torn, badMid, verdict };
}

/** Expand a directory into its room logs, so a whole hub verifies in one call. */
export function expandLogTargets(target: string): string[] {
  if (!fs.existsSync(target)) throw new Error(`no such path: ${target}`);
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith(".ndjson"))
    .sort()
    .map((f) => path.join(target, f));
}

/** The human rendering of one report, line by line. */
export function describeReport(r: LogReport): string[] {
  const out = [`${r.verdict.padEnd(12)} ${r.handle}  ${r.events} event(s), ${r.linksChecked} link(s) checked`];
  const sub = (s: string) => out.push(`          ${s}`);
  if (r.unverifiable) sub("nothing was verified here: this log carries no chain at all, so it is NOT CONTRADICTED rather than intact");
  if (r.unchainedPrefix > 0) sub(`${r.unchainedPrefix} leading event(s) carry no prev_hash and were skipped: they predate the chain (0.1.7), which is not a break`);
  if (r.genesisOk === true) sub(`genesis link matches sha256("${r.handle}")`);
  if (r.genesisOk === null && r.unchainedPrefix > 0) sub("genesis NOT checked: this room's chain starts mid-log, so there is nothing to compare");
  if (r.redactedLinks > 0) sub(`${r.redactedLinks} link(s) verified through content_hash (redacted events, wire 12.1)`);
  if (r.torn > 0) sub("final line unparseable (torn append, the ordinary result of a kill mid-write); prefix verified");
  if (r.badMid > 0) sub(`WARNING: ${r.badMid} unparseable line(s) NOT at end of file: that is not a torn append`);
  for (const d of r.divergences) {
    sub(`BREAK at seq ${d.seq} (${d.type})`);
    sub(`       expected ${d.expected}`);
    sub(`       found    ${d.found}`);
    sub(`       ${d.suspect}`);
  }
  return out;
}
