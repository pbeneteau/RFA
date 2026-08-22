/**
 * The status tables rotted in BOTH directions, twice, and each time a session
 * either rebuilt shipped work or trusted an unshipped MUST: RFA-0.6 sect. 12
 * carried 10 wrong rows for two days (repaired 2026-08-19), and by 2026-08-21
 * the same disease had regrown in RFA-0.5's headers and ladder, four Appendix F
 * rows, and README's deviations note. The process fix is single-writer status
 * (wire requirements live in RFA-0.1 Appendix F, rung status in STATUS.md's
 * header, and nothing else states implementation status as fact); this test is
 * the mechanical half: it pins the load-bearing Appendix F rows to greppable
 * code anchors, so flipping the code without updating the row (or the reverse)
 * fails the suite instead of waiting for the next reviewer.
 *
 * Deliberately narrow: each probe is a string the feature cannot exist without
 * and prose cannot plausibly contain. When one fires, fix the ROW or the CODE,
 * never the probe alone.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

const wire = read("spec/RFA-0.1.md");
const appendixF = wire.slice(wire.indexOf("Appendix F"));
const store = read("src/store.ts");
const main = read("src/main.ts");
const hubTs = read("src/hub.ts");

/** The Appendix F row (one table line) whose first cell matches `section`. */
function row(section: string, hint: RegExp): string {
  const lines = appendixF.split("\n").filter((l) => l.startsWith(`| ${section} |`) && hint.test(l));
  assert.equal(lines.length, 1, `expected exactly one Appendix F row for section ${section} matching ${hint}`);
  return lines[0];
}

test("Appendix F rows agree with the code they describe", () => {
  const pins: { section: string; hint: RegExp; rowSays: RegExp; codeHas: boolean; because: string }[] = [
    {
      section: "4.3",
      hint: /admission records/,
      rowSays: /PARTIAL[\s\S]*Transport authentication SHIPPED/,
      codeHas: main.includes("mcpAuthorized"),
      because: "transport auth on /mcp is enforced ahead of the handler",
    },
    {
      section: "5.4",
      hint: /`since` clamp/,
      rowSays: /\*\*SHIPPED\*\*/,
      codeHas: store.includes("visibleSince"),
      because: "the since clamp exists and both read paths call it",
    },
    {
      section: "9.7",
      hint: /task_released/,
      rowSays: /PARTIAL[\s\S]*`task_released` is emitted/,
      codeHas: store.includes('"task_released"'),
      because: "task_released has a producer; admitted and redacted do not",
    },
    {
      section: "10.2",
      hint: /`description` on the task object/,
      rowSays: /\*\*SHIPPED\*\*/,
      codeHas: /description: args\.description/.test(store),
      because: "create stores the description on the task object",
    },
    {
      section: "10.3",
      hint: /Claim leases/,
      rowSays: /claim_token.*re-bind on `complete` and `update`/,
      codeHas: store.includes("completesWithToken") && store.includes("updatesWithToken"),
      because: "the claim fence is honored where the schema advertises it",
    },
    {
      section: "10.3",
      hint: /Claim leases/,
      rowSays: /`max_attempts`, which the schema advertised/,
      codeHas: /args\.max_attempts !== undefined \? \{ max_attempts: args\.max_attempts \}/.test(store),
      because: "create honors the max_attempts argument",
    },
    {
      section: "10.4",
      hint: /Verification authority/,
      rowSays: /\*\*SHIPPED\*\*/,
      codeHas: store.includes("verifier_home") && store.includes("samePrincipal"),
      because: "the verifier rule and its principal comparison exist",
    },
  ];
  for (const p of pins) {
    const r = row(p.section, p.hint);
    assert.ok(p.codeHas, `code anchor missing for ${p.section} (${p.because}); if removed on purpose, update the Appendix F row too`);
    assert.match(r, p.rowSays, `Appendix F row ${p.section} no longer says what the code does (${p.because})`);
  }
});

test("the LLM-facing surfaces advertise no credential path that does not exist", () => {
  // hub.ts:174's invite_token line sent every arriving stranger hunting for a
  // parameter no tool accepts (found 2026-08-21). The invite path is specified
  // in RFA-0.6; until a tool ACCEPTS invite_token, nothing may advertise it.
  const registersInvite = /invite_token:\s*z\./.test(hubTs);
  if (!registersInvite) {
    // Only what a model actually receives counts: the STRING content, never the
    // source comments around it (which legitimately name the token to say why
    // it is absent).
    const slice = hubTs.slice(hubTs.indexOf("instructions:"), hubTs.indexOf("instructions:") + 2000);
    const strings = [...slice.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(" ");
    assert.ok(!strings.includes("invite_token"), "hub instructions advertise invite_token but no tool accepts one");
  }
});

test("README and CLAUDE.md carry no hardcoded test or scenario counts (numbers there rot)", () => {
  // CLAUDE.md joined this pin on 2026-08-22: the status sweep fixed README,
  // STATUS and the specs but missed the count here, and a doc generator then
  // faithfully propagated the stale number into a PR. Whichever copy a sweep
  // forgets is the one that rots.
  for (const f of ["README.md", "CLAUDE.md"]) {
    const text = read(f);
    assert.ok(!/\b\d+ tests\b/.test(text), `${f} states a test count; the suite prints the live one`);
    assert.ok(!/across \d+ scenarios\b/.test(text), `${f} states an e2e scenario count; the report prints the live one`);
  }
});
