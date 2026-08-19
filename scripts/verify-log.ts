/**
 * Verify a room's hash chain, offline (wire sect. 13, rung v0.6.3b).
 *
 *   npm run verify-log -- data/rooms/r_9a25e48c0e.ndjson
 *   npm run verify-log -- data/rooms/r_9a25e48c0e.ndjson --json
 *   npm run verify-log -- data/rooms                       (every room log in a directory)
 *
 * Reads files and nothing else: no `RoomHub`, no network, no lock. Sect. 13 says
 * tamper evidence must be verifiable offline, and a verifier that boots the thing
 * it is auditing is not offline. It is also safe to point at a live `data/rooms`
 * while the hub is running, because it only ever opens files for reading.
 *
 * The genesis link is the hex SHA-256 of the room handle, and the handle is taken
 * from the FILENAME rather than from inside the file, on purpose: reading it from
 * the log's own contents would let a rewritten log choose the value its own genesis
 * is checked against.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CHAIN_SCOPE_QUALIFIER, genesisFor, verifyChain, type ChainResult } from "../src/chain.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const targets = args.filter((a) => !a.startsWith("--"));
if (targets.length === 0) {
  console.error("usage: npm run verify-log -- <room-log.ndjson | directory> [--json]");
  process.exit(2);
}

/** Expand a directory into its room logs, so `data/rooms` verifies a whole hub. */
function expand(target: string): string[] {
  if (!fs.existsSync(target)) {
    console.error(`no such path: ${target}`);
    process.exit(2);
  }
  if (!fs.statSync(target).isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith(".ndjson"))
    .sort()
    .map((f) => path.join(target, f));
}

type FileReport = ChainResult & { file: string; handle: string; torn: number };

/**
 * A torn final line is expected, not corruption: the log is append-only and a hub
 * killed mid-write leaves a partial last line. Reporting it as tampering would cry
 * wolf on the most ordinary crash there is, so it is counted separately and only
 * the readable prefix is verified. A torn line anywhere ELSE is a different thing
 * and is reported as unparseable.
 */
function readEvents(file: string): { events: Record<string, unknown>[]; torn: number; badMid: number } {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
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

const reports: FileReport[] = [];
let unparseableMid = 0;

for (const target of targets) {
  for (const file of expand(target)) {
    const handle = path.basename(file).replace(/\.ndjson$/, "");
    const { events, torn, badMid } = readEvents(file);
    unparseableMid += badMid;
    const res = verifyChain(events, { genesis: genesisFor(handle) });
    reports.push({ ...res, file, handle, torn });
  }
}

if (asJson) {
  console.log(JSON.stringify({ scope: CHAIN_SCOPE_QUALIFIER, reports }, null, 1));
} else {
  for (const r of reports) {
    // NOT-CHAINED is a third verdict on purpose. A log that predates the chain has
    // nothing to check, and printing "INTACT" over zero checked links is a green
    // light that means nothing, which is worse than no light at all.
    const verdict = !r.ok ? "DIVERGED" : r.unverifiable ? "NOT-CHAINED" : "INTACT";
    console.log(`${verdict.padEnd(12)} ${r.handle}  ${r.events} event(s), ${r.linksChecked} link(s) checked`);
    if (r.unverifiable) {
      console.log(`          nothing was verified here: this log carries no chain at all, so it is NOT CONTRADICTED rather than intact`);
    }
    if (r.unchainedPrefix > 0) {
      console.log(
        `          ${r.unchainedPrefix} leading event(s) carry no prev_hash and were skipped: ` +
          `they predate the chain (0.1.7), which is not a break`,
      );
    }
    if (r.genesisOk === true) console.log(`          genesis link matches sha256("${r.handle}")`);
    if (r.genesisOk === null && r.unchainedPrefix > 0) {
      console.log(`          genesis NOT checked: this room's chain starts mid-log, so there is nothing to compare`);
    }
    if (r.redactedLinks > 0) {
      console.log(`          ${r.redactedLinks} link(s) verified through content_hash (redacted events, wire 12.1)`);
    }
    if (r.torn > 0) {
      console.log(`          final line unparseable (torn append, the ordinary result of a kill mid-write); prefix verified`);
    }
    for (const d of r.divergences) {
      console.log(`          BREAK at seq ${d.seq} (${d.type})`);
      console.log(`                 expected ${d.expected}`);
      console.log(`                 found    ${d.found}`);
      console.log(`                 ${d.suspect}`);
    }
  }
  const broken = reports.filter((r) => !r.ok).length;
  const unverifiable = reports.filter((r) => r.ok && r.unverifiable).length;
  console.log(
    `\n${reports.length - broken - unverifiable}/${reports.length} log(s) verified intact` +
      (unverifiable > 0 ? `, ${unverifiable} carry no chain to verify` : "") +
      (broken > 0 ? `, ${broken} DIVERGED` : ""),
  );
  if (unparseableMid > 0) {
    console.log(`WARNING: ${unparseableMid} unparseable line(s) NOT at end of file: that is not a torn append`);
  }
  console.log(`\n${CHAIN_SCOPE_QUALIFIER}`);
}

// Exit 1 on any divergence so this can gate something; a torn final line alone is
// not a failure, because it is what an ordinary crash looks like.
process.exit(reports.some((r) => !r.ok) || unparseableMid > 0 ? 1 : 0);
