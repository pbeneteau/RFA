/**
 * The cold-start operator test (RFA-0.7 sect. 8): the mirror of RFA-0.6 sect.
 * 6.3's cold-start guest test, and the only honest measure of whether an
 * operator with nothing but the package can get an answer.
 *
 *   npm run coldstart              pack this checkout, install the tarball into a temp prefix,
 *                                  init an empty folder with it, ask one question, tear down
 *   npm run coldstart -- --keep    keep the prefix and the directory for inspection
 *
 * It installs exactly what `npm pack` produces, so the `files` list, the bins,
 * the built entries and the console page are tested by the only test that can
 * catch them. It needs a model credential (a logged-in `claude`, or
 * ANTHROPIC_API_KEY), so it runs like the eval gate, by hand and budgeted, and
 * not in `npm test`. Cost: one haiku answer.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const KEEP = process.argv.includes("--keep");
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, encoding: "utf8", timeout: opts.timeoutMs ?? 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    ),
  );
}

const t0 = Date.now();
const step = (s: string) => console.log(`${dim("▸")} ${s} ${dim(`${((Date.now() - t0) / 1000).toFixed(0)}s`)}`);

// 1. Pack this checkout: what an operator would download.
step("npm pack");
const packOut = execFileSync("npm", ["pack", "--json", "--silent"], { cwd: ROOT, encoding: "utf8" });
const tarball = path.join(ROOT, (JSON.parse(packOut) as { filename: string }[])[0].filename);
console.log(`  ${dim(tarball)} ${dim(`${(fs.statSync(tarball).size / 1024).toFixed(0)} KB`)}`);

// 2. Install it into a prefix that has never seen this repository.
const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-coldstart-prefix-"));
step(`npm install -g --prefix ${prefix}`);
const install = await run("npm", ["install", "-g", "--prefix", prefix, tarball], { cwd: os.tmpdir(), timeoutMs: 600_000 });
if (install.code !== 0) {
  console.error(red("install failed"), install.stderr.slice(-2000));
  process.exit(1);
}
const rfaBin = path.join(prefix, "bin", "rfa");
console.log(`  ${dim(rfaBin)}`);

// 3. An empty folder, one command, one answer.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-coldstart-"));
const port = await freePort();
const env = { ...process.env, RFA_DIR: "", NO_COLOR: "1" };
step(`rfa init --yes --ask in ${dir} (port ${port})`);
const init = await run(rfaBin, ["init", "--yes", "--name", "coldstart", "--port", String(port), "--human", "operator", "--agent", "spec-expert", "--room", "protocol", "--ask", "How do presence leases work? One paragraph, cite the section.", "--json"], { cwd: dir, env, timeoutMs: 400_000 });
let verdict = "";
let first: { kind: string; text: string; elapsed_s: number; cost_usd: number | null } | null = null;
try {
  if (init.code !== 0) throw new Error(`init exited ${init.code}: ${init.stderr.trim().slice(-1500)}`);
  const out = JSON.parse(init.stdout) as { started: boolean; ready: boolean | null; first_answer: typeof first; human_key: string | null };
  if (!out.started || !out.ready) throw new Error(`agent never became ready: ${JSON.stringify({ started: out.started, ready: out.ready })}\n${init.stderr.slice(-1500)}`);
  first = out.first_answer;
  if (!first || first.kind !== "response") throw new Error(`no answer: ${JSON.stringify(first)}`);
  if (!/7\.2|lease/i.test(first.text)) throw new Error(`the answer does not cite the lease section: ${first.text.slice(0, 200)}`);
  if (!out.human_key?.startsWith("hk_")) throw new Error("the human key was not shown once");
  verdict = `answered in ${first.elapsed_s}s${first.cost_usd != null ? `, $${first.cost_usd}` : ""}: ${first.text.slice(0, 120).replace(/\n/g, " ")}…`;
  // 4. The readers, against the live daemons.
  const st = await run(rfaBin, ["status", "--json"], { cwd: dir, env });
  const status = JSON.parse(st.stdout) as { hub: { healthy: boolean }; supervisor: { running: boolean }; agents: { name: string; supervisor: { status: string } | null }[] };
  if (!status.hub.healthy || !status.supervisor.running) throw new Error(`status disagrees: ${st.stdout}`);
  const doc = await run(rfaBin, ["doctor", "--json"], { cwd: dir, env });
  const fails = (JSON.parse(doc.stdout) as { id: string; verdict: string; text: string }[]).filter((c) => c.verdict === "fail");
  if (fails.length) throw new Error(`doctor fails: ${fails.map((f) => f.text).join("; ")}`);
} catch (err) {
  verdict = red(`FAIL: ${(err as Error).message}`);
} finally {
  // 5. Down, and nothing left behind.
  step("rfa down");
  const down = await run(rfaBin, ["down", "--json"], { cwd: dir, env });
  const strays = (JSON.parse(down.stdout || "{}") as { strays?: string[] }).strays ?? [];
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => "still up", () => "down");
  const clean = strays.length === 0 && health === "down";
  console.log(`  ${clean ? green("nothing left behind") : red(`strays: ${strays.join(", ")}; hub ${health}`)}`);
  if (!clean && !verdict.includes("FAIL")) verdict = red("FAIL: something survived rfa down");
  if (!KEEP) {
    fs.rmSync(prefix, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
  } else console.log(dim(`kept ${prefix}\n     ${dir}\n     ${tarball}`));
}
const ok = !verdict.includes("FAIL");
console.log(`\n${bold(ok ? green("COLD START PASS") : red("COLD START FAIL"))} ${dim(`in ${((Date.now() - t0) / 1000).toFixed(0)}s`)}\n  ${verdict}`);
process.exit(ok ? 0 : 1);
