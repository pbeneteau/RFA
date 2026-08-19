/**
 * One way to start a hub in a test, and one way to stop it.
 *
 * Four test files used to spawn `npx -y tsx src/main.ts` by hand and then
 * `kill("SIGKILL")` the child they got back. That child is the npm wrapper, not
 * the hub, and SIGKILL is the one signal nothing can forward: the real hub kept
 * running, holding its port and its memory, every time a hub-spawning test file
 * finished. 119 of them were found alive on 2026-08-19, the oldest three days
 * old, holding 5.3 GB between them. The tests all passed the whole time, which
 * is why this is a helper and not a comment: four copies of a teardown is four
 * places for the same mistake, and the mistake is invisible from the test's
 * own point of view.
 *
 * `src/proc.ts` has the measurements and does the process work. This module adds
 * the two hub-specific parts: a free port, and readiness.
 */
import type { ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import * as url from "node:url";
import { spawnTsx, stopTree } from "../src/proc.js";

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const HUB_ENTRY = path.join(ROOT, "src", "main.ts");

export type TestHub = {
  proc: ChildProcess;
  port: number;
  /** `http://127.0.0.1:<port>` */
  base: string;
  /** `http://127.0.0.1:<port>/mcp` */
  mcp: string;
};

/** A port the OS just told us is free. Racy in principle, unraced in practice on a loopback test. */
export async function freePort(): Promise<number> {
  return new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

const started = new Set<TestHub>();

/**
 * Start a hub and wait until it serves.
 *
 * Readiness is an unauthenticated `GET /api/agents` answering 401. That proves
 * two things with one request: the listener is up, and workbench reads are gated
 * (the hub was once on every interface with tokenless reads, so this is worth
 * re-proving on every boot). `--data none` unless the caller passes its own
 * `--data`, because a test hub that writes to the real store would fight the
 * live hub for its lockfile.
 */
export async function startHub(args: string[] = [], opts: { port?: number } = {}): Promise<TestHub> {
  const port = opts.port ?? (await freePort());
  const full = args.includes("--data") ? args : [...args, "--data", "none"];
  const proc = spawnTsx(HUB_ENTRY, ["--http", String(port), ...full], { cwd: ROOT, stdio: "ignore" });
  const hub: TestHub = { proc, port, base: `http://127.0.0.1:${port}`, mcp: `http://127.0.0.1:${port}/mcp` };
  started.add(hub);
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error(`hub exited at boot with code ${proc.exitCode}`);
    try {
      const r = await fetch(`${hub.base}/api/agents`);
      if (r.status === 401) return hub;
      if (r.ok) throw new Error("workbench reads must require a session token");
    } catch (err) {
      if ((err as Error).message.includes("must require")) throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await stopHub(hub);
  throw new Error(`hub on :${port} did not become ready within 10s`);
}

/** Stop a hub and everything it spawned. Safe to call twice. */
export async function stopHub(hub: TestHub): Promise<void> {
  started.delete(hub);
  await stopTree(hub.proc, 2_500);
}

/** Stop every hub this module started. Use in an `after()` so one failure cannot leak the rest. */
export async function stopAllHubs(): Promise<void> {
  await Promise.all([...started].map((h) => stopHub(h)));
}

/**
 * Mint a session token from a hub started with `--human-key`.
 * Every workbench route needs one, so most tests want this immediately after boot.
 */
export async function sessionToken(hub: TestHub, humanKey: string): Promise<string> {
  const res = await fetch(`${hub.base}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ human_key: humanKey }),
  });
  if (!res.ok) throw new Error(`/auth refused with ${res.status}`);
  return ((await res.json()) as { session_token: string }).session_token;
}
