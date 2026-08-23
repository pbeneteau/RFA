/**
 * `entryFor`: a sibling entry by the caller's own extension, so the supervisor
 * spawns `resident.ts` under tsx and `resident.js` when built (RFA-0.7 sect. 6.2).
 */
import { strict as assert } from "node:assert";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { entryFor, nodeArgsFor } from "../src/proc.js";

test("entryFor resolves beside the caller with the caller's extension", () => {
  const ts = pathToFileURL("/repo/src/supervisor.ts").href;
  const js = pathToFileURL("/repo/dist/supervisor.js").href;
  assert.equal(entryFor(ts, "resident"), path.join("/repo/src", "resident.ts"));
  assert.equal(entryFor(js, "resident"), path.join("/repo/dist", "resident.js"));
  assert.equal(entryFor(js, "main"), path.join("/repo/dist", "main.js"));
});

test("the supervisor's own entry resolves to the resident beside it in this checkout", () => {
  const here = entryFor(pathToFileURL(path.resolve(import.meta.dirname, "..", "src", "supervisor.ts")).href, "resident");
  assert.equal(path.basename(here), "resident.ts");
  assert.equal(path.basename(path.dirname(here)), "src");
});

test("a .ts entry runs through tsx by ABSOLUTE path, so the working directory does not decide whether it boots", () => {
  const args = nodeArgsFor("/repo/src/resident.ts");
  assert.equal(args[0], "--import");
  assert.ok(path.isAbsolute(args[1]), `tsx loader must be absolute, got ${args[1]}`);
  assert.ok(/node_modules\/tsx\//.test(args[1]), "resolved from the tool's own dependencies");
  assert.equal(args[2], "/repo/src/resident.ts");
  assert.deepEqual(nodeArgsFor("/pkg/dist/resident.js"), ["/pkg/dist/resident.js"], "a built entry needs no loader");
});

test("procscan: only a node process whose script IS resident.ts/.js with --agent counts; a shell mentioning both strings does not", async () => {
  const { parseResidentProcesses } = await import("../src/procscan.js");
  const table = [
    "  501 1 /usr/local/bin/node --import /x/node_modules/tsx/dist/loader.mjs /repo/src/resident.ts --agent spec-expert",
    "  502 1 node /pkg/dist/resident.js --agent pm",
    `  503 1 zsh -c rfa init --agent spec-expert; pgrep -fl "resident.ts --agent"`,
    "  504 1 node /repo/src/supervisor.ts --dir /h",
    "  505 1 grep resident.ts --agent spec-expert",
    "  506 1 node --import /x/tsx/loader.mjs /repo/src/resident.ts",
  ].join("\n");
  const found = parseResidentProcesses(table);
  assert.deepEqual(found.map((p) => [p.pid, p.agent]), [[501, "spec-expert"], [502, "pm"]]);
});

test("a resident carries its hub directory on argv, and belongs only to that directory", async () => {
  const { belongsTo, parseResidentProcesses } = await import("../src/procscan.js");
  const ps = [
    "101 1 /opt/homebrew/bin/node --import /x/tsx/loader.mjs /x/src/resident.ts --agent spec-expert --dir /Users/me/Dev/rfa-test",
    "102 1 /opt/homebrew/bin/node /x/dist/resident.js --agent spec-expert",
  ].join("\n");
  const [withDir, without] = parseResidentProcesses(ps);
  assert.equal(withDir.dir, "/Users/me/Dev/rfa-test");
  assert.equal(without.dir, null);
  assert.ok(belongsTo(withDir, "/Users/me/Dev/rfa-test"));
  assert.ok(!belongsTo(withDir, "/tmp/other-hub"), "the same agent name in another directory is not this supervisor's orphan");
  assert.ok(belongsTo(without, "/tmp/other-hub"), "a resident that cannot say still counts, conservatively");
});
