/**
 * Consolidation's cross-process guards (RFA-0.8 sect. 3 item 2), with an
 * injected model so the plumbing under test is the only thing under test.
 *
 * The pass is a read-process-write wrapped around two model calls: read the
 * watermark, spend money, write the watermark back. It was single-flight BY HOPE,
 * and two processes really do run it (the resident's timer, the standalone entry
 * point, `rfa agent reflect` against the same file), so two passes could read one
 * watermark, both pay, and both apply. Two guards, because they fail differently:
 * the named lock stops a second pass STARTING, the compare-and-set stops a pass
 * whose lock lapsed mid-flight from rewinding the watermark its successor moved.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { before, test } from "node:test";
import { AccountLedger } from "../src/account.js";
import { consolidate, type LlmFn } from "../src/consolidate.js";
import { loadHubDir, type HubDir } from "../src/hubdir.js";
import { EpisodeLog, FactStore } from "../src/memoryfs.js";
import { nodeArgsFor } from "../src/proc.js";
import { freePort } from "./hubproc.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "src", "cli", "main.ts");
const FACT = "The annual management fee on the premium envelope is 1.5 percent";

let dir: string;
let h: HubDir;
let dbPath: string;

/** Gate the extract pass so a test can hold a consolidation mid-flight. */
function fakeLlm(hold?: () => Promise<void>): LlmFn {
  return async (_cwd, system) => {
    if (hold) await hold();
    if (system.includes("reconcile")) return { text: JSON.stringify({ memory: [{ text: FACT, event: "ADD", importance: 0.9 }] }), cost: 0.002 };
    return { text: JSON.stringify({ facts: [FACT] }), cost: 0.001 };
  };
}

/** Long enough to clear the gate's 40-character minimum, or it never enters the window. */
const askerText = (i: number) => `Could you tell me what the annual management fees are on the premium envelope plan, question number ${i}?`;

function seedEpisodes(n: number): void {
  const log = new EpisodeLog(dbPath);
  for (let i = 0; i < n; i++) {
    log.recordInbound(
      {
        rfa: "0.1",
        message_id: `cons_${i}_00000`,
        seq: i + 1,
        ts: new Date(1755360000000 + i * 1000).toISOString(),
        room: "r_cons",
        from: { id: "m_asker", name: "asker", origin: "human" },
        kind: "chat",
        to: [],
        mentions: [],
        conversation_id: null,
        in_reply_to: null,
        reply_by: null,
        task: null,
        body: [{ type: "text", text: askerText(i) }],
        chunk: null,
        refusal: null,
        _meta: {},
        ext: {},
      },
      { ok: true },
      `<room-message>${askerText(i)}</room-message>`,
      askerText(i),
    );
  }
  log.close();
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-cons-"));
  const env = { ...process.env, RFA_DIR: "", NO_COLOR: "1" };
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "init", "--yes", "--no-start", "--agent", "none", "--name", "cons", "--port", String(await freePort()), "--human", "paul"], { cwd: dir, encoding: "utf8", env });
  execFileSync(process.execPath, [...nodeArgsFor(CLI), "agent", "new", "pm", "--kind", "answerer"], { cwd: dir, encoding: "utf8", env });
  h = loadHubDir(dir);
  dbPath = path.join(h.paths.agents, "pm", "state", "memory.db");
  seedEpisodes(4);
});

test("a second pass is refused while the first holds the pack, and it spends nothing", async () => {
  // The cap is raised on purpose. At the shipped cap the BACKGROUND lane limit is
  // 1 (max(1, cap - 2)) and the count is account-wide, so two background passes
  // cannot hold slots at once and the account layer refuses the second before the
  // single-flight name is ever consulted: at cap 3 the lease was an ACCIDENTAL
  // guard. What that accident does not cover is a pass slower than the lease TTL,
  // which nothing renews for a background pass, and that is the window the named
  // lock and the CAS close. Raising the cap here puts the named lock, not the
  // lane limit, under test.
  const ledger = new AccountLedger(h.paths.runsDb);
  ledger.setCap(4);
  ledger.close();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let secondResult: Awaited<ReturnType<typeof consolidate>> | null = null;

  // The first pass parks inside its extract call, i.e. exactly where a real pass
  // spends its time and money.
  const first = consolidate("pm", {
    hubdir: h,
    llm: fakeLlm(async () => {
      // While the first is parked, the second runs to completion.
      secondResult = await consolidate("pm", { hubdir: h, llm: fakeLlm() });
      release();
      await gate;
    }),
  });
  const firstResult = await first;

  assert.ok(secondResult, "the second pass returned");
  assert.match(secondResult!.deferred ?? "", /held by pid|another consolidation pass/, JSON.stringify(secondResult));
  assert.equal(secondResult!.cost_usd, 0, "a refused pass spends nothing");
  assert.equal(secondResult!.episodes, 0, "and consumes no episodes");
  assert.equal(firstResult.deferred, undefined, `the first pass ran: ${JSON.stringify(firstResult)}`);
  assert.equal(firstResult.added, 1, "and applied its fact");
  assert.equal(firstResult.watermark, 4, "and advanced the watermark to the last episode it read");

  // The name is released, so the next pass may take it.
  const log = new EpisodeLog(dbPath);
  assert.equal(log.getMeta("consolidation_watermark"), "4");
  log.close();
  const after = await consolidate("pm", { hubdir: h, llm: fakeLlm() });
  assert.equal(after.deferred, undefined, `the lock did not leak: ${JSON.stringify(after)}`);
  assert.equal(after.episodes, 0, "nothing new to consolidate");
});

test("a pass whose watermark moved under it leaves the watermark alone", async () => {
  seedEpisodes(3);
  const log = new EpisodeLog(dbPath);
  const before = log.getMeta("consolidation_watermark");
  log.close();

  // Mid-flight, something else advances the watermark: a pass whose single-flight
  // name lapsed while it was running, which is the case the CAS exists for.
  const res = await consolidate("pm", {
    hubdir: h,
    llm: fakeLlm(async () => {
      const other = new EpisodeLog(dbPath);
      other.setMeta("consolidation_watermark", "999");
      other.close();
    }),
  });
  assert.match(res.deferred ?? "", /watermark moved/, JSON.stringify(res));
  const after = new EpisodeLog(dbPath);
  assert.equal(after.getMeta("consolidation_watermark"), "999", "the other pass's watermark stands; this pass did not rewind it");
  assert.notEqual(before, "999");
  after.close();
});

test("compare-and-set on the watermark: only the writer holding the expected value wins", () => {
  const log = new EpisodeLog(dbPath);
  try {
    log.setMeta("cas_probe", "10");
    assert.equal(log.casMeta("cas_probe", "10", "11"), true, "the holder of the expected value wins");
    assert.equal(log.casMeta("cas_probe", "10", "12"), false, "a stale expectation loses");
    assert.equal(log.getMeta("cas_probe"), "11", "and changes nothing");
    assert.equal(log.casMeta("cas_absent", null, "1"), true, "absent is an expectation too");
    assert.equal(log.casMeta("cas_absent", null, "2"), false, "and it holds only once");
  } finally {
    log.close();
  }
});

test("the account slot is released when the single-flight name is refused, not held", async () => {
  const ledger = new AccountLedger(h.paths.runsDb);
  try {
    // Somebody else holds the name; the pass must refuse AND leave no lease behind,
    // or a refused background pass would occupy a slot for its whole TTL.
    const held = ledger.takeSingleFlight("consolidate:pm", { holder: "a test" });
    assert.ok(held.ok);
    const before = ledger.leases().length;
    const res = await consolidate("pm", { hubdir: h, llm: fakeLlm() });
    assert.match(res.deferred ?? "", /held by pid/, JSON.stringify(res));
    assert.equal(ledger.leases().length, before, "the refused pass holds no account lease");
    ledger.releaseSingleFlight("consolidate:pm", held.token!);
  } finally {
    ledger.close();
  }
});

test("gate-skipped facts are counted in the pass result, so a skip is visible rather than silent", async () => {
  // The CAS test above left the watermark at 999 on purpose; put it back on the
  // real last episode so this pass has a batch to read.
  const reset = new EpisodeLog(dbPath);
  reset.setMeta("consolidation_watermark", String(reset.count()));
  reset.close();
  seedEpisodes(2);
  // A "fact" that is the asker's own words verbatim: the gate refuses it at the
  // fact door, and the pass reports the skip instead of swallowing it.
  const parrot: LlmFn = async (_cwd, system) => {
    // The asker's own words, back verbatim: the exact worm-persistence move the
    // fact-door gate exists to refuse.
    const text = askerText(0);
    if (system.includes("reconcile")) return { text: JSON.stringify({ memory: [{ text, event: "ADD", importance: 0.5 }] }), cost: 0.001 };
    return { text: JSON.stringify({ facts: [text] }), cost: 0.001 };
  };
  const res = await consolidate("pm", { hubdir: h, llm: parrot });
  assert.equal(res.deferred, undefined, JSON.stringify(res));
  assert.equal(res.skipped, 1, "the item was skipped");
  assert.equal(res.gate_skipped, 1, "and the pass says the GATE is why");
  const facts = new FactStore(dbPath);
  const [skip] = facts.gateSkips(1);
  assert.ok(skip, "the skip is durable");
  assert.ok((skip.similarity ?? 0) > 0, `with its similarity score: ${skip.similarity}`);
  assert.ok(skip.episode_ids.length > 0, "and the episodes behind it");
  facts.close();
});
