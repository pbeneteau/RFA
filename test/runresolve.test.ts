/**
 * Wire 14 item 12 applied to this repository's own reliability gate: a subject's
 * self-report must not be an input to an automated decision.
 *
 * Two decisions were keyed on one - which run a score attaches to, and whether a
 * trial counts toward pass^k - and both are `... WHERE id = ?` or an
 * unconstrained INSERT underneath, so a wrong id was silently no rows.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import { corroborateRefusal, resolveRun, type RunLookup, type RunRecord } from "../src/evals/runresolve.js";
import { REPORTED_MARK, reported } from "../src/cli/ui.js";

const row = (id: string, status = "success", start = 100, end = 200): RunRecord => ({ id, name: "serve:pm-agent", group_id: "r_1", status, start_time: start, end_time: end });
const lookupOf = (rows: RunRecord[] | null): RunLookup => () => rows;
const ARGS = { agent: "pm-agent", from: 0, to: 1000 };

test("a claimed run id is accepted only when the store corroborates it", () => {
  const store = [row("run_real")];
  const good = resolveRun({ ...ARGS, claimed: "run_real", lookup: lookupOf(store) });
  assert.deepEqual(good, { ok: true, runId: "run_real", source: "corroborated" });
});

test("a claim the store does not know is NOT used as the key", () => {
  // The defect: `markReview("run_invented")` is an UPDATE matching no rows, and
  // `feedback` inserts an orphan. Both are silent, so a failing answer never
  // reaches the review queue.
  const store = [row("run_real")];
  const r = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf(store) });
  // One unambiguous run in the window: the store answers, and the claim loses.
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.runId, "run_real");
  assert.equal(r.ok && r.source, "resolved-by-window");
});

test("an ambiguous or empty window REFUSES rather than guessing, and says why", () => {
  const two = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf([row("a"), row("b")]) });
  assert.equal(two.ok, false);
  assert.match(two.ok === false ? two.reason : "", /2 runs for pm-agent/);
  assert.match(two.ok === false ? two.reason : "", /not among them/);
  const none = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf([]) });
  assert.equal(none.ok, false);
  assert.match(none.ok === false ? none.reason : "", /no run row/);
  // An unreadable store is not a licence to trust the claim.
  const dark = resolveRun({ ...ARGS, claimed: "run_invented", lookup: lookupOf(null) });
  assert.equal(dark.ok, false);
  assert.match(dark.ok === false ? dark.reason : "", /a claim is not a measurement/);
});

test("a refusal leaves pass^k alone only when the subject's own record backs it", () => {
  // It started and failed: corroborated, and the exclusion this was earned by
  // (a $3/day answerer hitting its ceiling mid-run) still holds.
  const failed = corroborateRefusal({ ...ARGS, lookup: lookupOf([row("a", "error")]) });
  assert.equal(failed.excluded, true);
  assert.match(failed.detail, /error/);

  // THE HOLE: it completed a turn and then declared a refusal. Its own record
  // contradicts the self-report, so the trial counts - otherwise a member lowers
  // the denominator of its own gate by declaring its state.
  const lying = corroborateRefusal({ ...ARGS, lookup: lookupOf([row("a", "success")]) });
  assert.equal(lying.excluded, false);
  assert.match(lying.detail, /CONTRADICTED/);
  assert.match(lying.detail, /14 item 12/);

  // Unreadable store: fail closed, the same direction the overlap metric takes.
  const dark = corroborateRefusal({ ...ARGS, lookup: lookupOf(null) });
  assert.equal(dark.excluded, false);
  assert.match(dark.detail, /could not be corroborated/);
});

test("for a LOCAL resident, no run row at all contradicts a declared refusal", () => {
  // Measured on this instance: the serve path writes an obs row with
  // status "error" on EVERY refusal path - budget stop, account stop, expired
  // credential, turn ceiling - BEFORE the refusal reaches the asker. So a
  // resident that genuinely could not answer leaves a row, and an absent one is
  // not what an honest refusal looks like.
  const localSubject = corroborateRefusal({ ...ARGS, lookup: lookupOf([]), everRecorded: () => true });
  assert.equal(localSubject.excluded, false, "a subject that records runs here and left none refused nothing");
  assert.match(localSubject.detail, /CONTRADICTED/);
  assert.match(localSubject.detail, /status `error`/);
});

test("for a subject hosted elsewhere, the same absence is UNCORROBORATED, not a lie", () => {
  // A member hosted elsewhere records nothing in this store, so nothing here can
  // check its refusal either way. Excluded - but the exclusion says it was never
  // checked, rather than presenting itself as corroboration.
  const remote = corroborateRefusal({ ...ARGS, lookup: lookupOf([]), everRecorded: () => false });
  assert.equal(remote.excluded, true);
  assert.match(remote.detail, /UNCORROBORATED/);
  assert.match(remote.detail, /hosted elsewhere/);

  // And with no discriminator available at all, the conservative reading holds
  // and still refuses to call itself corroborated.
  const unknown = corroborateRefusal({ ...ARGS, lookup: lookupOf([]) });
  assert.equal(unknown.excluded, true);
  assert.match(unknown.detail, /UNCORROBORATED/);
  assert.doesNotMatch(unknown.detail, /^corroborated/);
});

// ------------------------------------------- wire 14 item 12, the rendering half

test("every surface that prints a peer's own figures marks them as self-reported", () => {
  // "Implementations MUST render it as self-reported." The numbers in an
  // answer's json part are composed by the answering resident; the figures
  // beside them on the same screen are measured from runs.db and obs.db.
  // Printed identically, an operator cannot tell which is which.
  const read = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

  const talk = read("src/cli/commands/talk.ts");
  assert.match(talk, /\$\$\{meta\.cost_usd\} \(\$\{REPORTED_MARK\}\)/, "rfa ask prints the peer's cost marked");
  assert.match(talk, /\$\{meta\.run_id\} \(\$\{REPORTED_MARK\}\)/, "and its run id");
  assert.match(talk, /cost_usd_reported/, "the --json shape names it too, so a script cannot mistake it either");

  const dash = read("src/cli/tui/dashboard.tsx");
  assert.match(dash, /fmtUsd\(outcome\.cost_usd\)\} \(\{REPORTED_MARK\}\)/, "the dashboard's ask box marks the peer's cost");
  assert.match(dash, /outcome\.run_id\} \(\$\{REPORTED_MARK\}\)/);

  // The console cannot import from src/, so it repeats the string; this is what
  // stops the two drifting apart silently.
  const consoleHtml = read("console/index.html");
  assert.match(consoleHtml, /\$\$\{cost\} \(reported\)/, "the console marks it with the same word");
  assert.equal(REPORTED_MARK, "reported", "and the shared constant is that word, or the console has drifted");
});

test("the mark is one constant, not a convention three surfaces remember separately", () => {
  assert.equal(reported(0.0412), "0.0412 (reported)");
  assert.equal(reported("run_abc"), "run_abc (reported)");
  // A missing figure renders as nothing: marking an absence would be noise.
  assert.equal(reported(null), null);
  assert.equal(reported(undefined), null);
});
