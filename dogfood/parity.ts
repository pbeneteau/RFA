/**
 * Answer-parity gate for pm-agent brain changes (spec RFA-0.4 section 14).
 *
 *   npx tsx dogfood/parity.ts --capture   ask the LIVE resident, write baseline answers
 *   npx tsx dogfood/parity.ts             ask again, check must_mention + citation parity
 *
 * Questions and expectations live in dogfood/state/parity.json (gitignored:
 * they contain the operator's product facts). Parity = every must_mention substring present
 * (case/space-insensitive) and a knowledge source cited; LLM wording may vary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RoomMember } from "../src/client.js";
import { ObsStore } from "../src/obs.js";
import { transportToken } from "../src/secrets.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const FIXTURES = path.join(ROOT, "dogfood", "state", "parity.json");

// Same reason as scripts/ask.ts: the gate must keep running against a hub that
// requires a transport credential.
{
  const tok = transportToken(path.join(ROOT, "data", "secrets.json"));
  if (tok && !process.env.RFA_TOKEN) process.env.RFA_TOKEN = tok;
}
const ROOM_MD = fs.readFileSync(path.join(ROOT, "dogfood", "ROOM.md"), "utf8");
const room = /Room: `(r_\w+)`/.exec(ROOM_MD)![1];
const secret = /Join secret: `([^`]+)`/.exec(ROOM_MD)![1];
const HUB = process.env.RFA_HUB_URL ?? "http://localhost:8790/mcp";

interface Fixture {
  question: string;
  must_mention: string[];
  baseline?: { text: string; ms: number };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s ]/g, "");

async function main() {
  const capture = process.argv.includes("--capture");
  const fixtures: Fixture[] = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  const obsPath = path.join(ROOT, "data", "obs.db");
  const obsStore = fs.existsSync(path.dirname(obsPath)) ? new ObsStore(obsPath) : null;
  const probe = await RoomMember.create({
    hubUrl: HUB, room, joinSecret: secret, name: "parity-probe",
    card: { name: "parity-probe", description: "answer-parity gate probe", skills: [{ id: "parity", description: "checks answer parity across brain changes" }] },
  });
  const pm = probe.roster.find((r) => r.card_summary.skill_ids.includes("answer-product-question"));
  if (!pm) throw new Error("no member with skill answer-product-question in the roster");

  let failures = 0;
  for (const f of fixtures) {
    const t0 = Date.now();
    const a = await probe.ask(pm.id, f.question, { timeoutMs: 120_000 });
    const ms = Date.now() - t0;
    const text = a.text;
    // Each expectation may list alternatives ("deadline|délai"): any one satisfies it.
    const missing = f.must_mention.filter((m) => !m.split("|").some((alt) => norm(text).includes(norm(alt))));
    const cited = /knowledge\/|\.md/.test(text) || JSON.stringify(a.parts).includes("sources");
    const ok = a.kind === "response" && missing.length === 0 && cited;
    console.log(`${ok ? "PASS" : "FAIL"}  ${(ms / 1000).toFixed(1)}s  ${f.question.slice(0, 60)}`);
    if (!ok) {
      failures++;
      console.log(`      kind=${a.kind} cited=${cited} missing=${JSON.stringify(missing)}`);
      console.log(`      got: ${text.slice(0, 200).replace(/\n/g, " ")}`);
    }
    // The flywheel's first turn: parity verdicts land as evaluator feedback on
    // the answer's run (the answer json part carries its engine run_id).
    const runId = (a.parts.find((p) => p.type === "json")?.value as { run_id?: string } | undefined)?.run_id;
    if (runId && obsStore) {
      obsStore.feedback({
        run_id: runId,
        key: "parity",
        score: ok ? 1 : 0,
        comment: ok ? null : `missing=${JSON.stringify(missing)} cited=${cited}`,
        source_type: "evaluator",
      });
      if (!ok) obsStore.markReview(runId, true);
    }
    if (capture) f.baseline = { text, ms };
  }
  await probe.leave();
  obsStore?.close();
  if (capture) {
    fs.writeFileSync(FIXTURES, JSON.stringify(fixtures, null, 2));
    console.log(`baseline captured for ${fixtures.length} questions -> ${FIXTURES}`);
  }
  if (failures > 0) {
    console.error(`${failures}/${fixtures.length} parity checks FAILED`);
    process.exit(1);
  }
  console.log(`parity: ${fixtures.length}/${fixtures.length} PASS`);
}

await main();
