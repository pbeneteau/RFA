/**
 * Checks that decide whether an answer is possible at all, shared by `rfa init`
 * and `rfa doctor`.
 *
 * The model-credential check moved here from the old `scripts/init.ts`
 * verbatim in spirit: its three verdicts (set in this shell, logged in, cannot
 * verify) and its wording were tuned by measurement on 2026-08-21, when a
 * credential-less machine came up green everywhere and the first ask died. The
 * strong warning is reserved for a CONFIRMED absence; "could not verify" must
 * not read as "not logged in", because on a logged-in machine with an older CLI
 * that would be a false alarm.
 */
import { execFileSync } from "node:child_process";
import * as net from "node:net";

export interface CredentialStatus {
  /** true: an answer is possible; false: confirmed absent; null: could not verify. */
  ok: boolean | null;
  detail: string;
}

export function modelCredentialStatus(env: NodeJS.ProcessEnv = process.env): CredentialStatus {
  if (env.ANTHROPIC_API_KEY) {
    return {
      ok: true,
      // Shell-local, unlike a `claude` login: green HERE proves nothing about the
      // shell that runs the supervisor, and residents inherit the SUPERVISOR's.
      detail: "ANTHROPIC_API_KEY is set in this shell; the shell that runs `rfa up` must export it too",
    };
  }
  // `claude auth status` exits NON-ZERO when not logged in, with the JSON verdict
  // on stdout either way, so the throw path is a normal answer, not a failure.
  let out: string;
  try {
    out = execFileSync("claude", ["auth", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, killSignal: "SIGKILL", env });
  } catch (err) {
    out = String((err as { stdout?: unknown }).stdout ?? "");
  }
  try {
    const parsed = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
    if (parsed.loggedIn === true) return { ok: true, detail: `\`claude\` is logged in (${parsed.authMethod ?? "method unknown"})` };
    if (parsed.loggedIn === false) return { ok: false, detail: "`claude auth status` reports not logged in" };
    return { ok: null, detail: "could not verify (unrecognized `claude auth status` output)" };
  } catch {
    return { ok: null, detail: "could not verify (no `claude` CLI on PATH, or it did not answer)" };
  }
}

/** The sentences init and doctor print under each verdict. */
export function credentialAdvice(status: CredentialStatus): string[] {
  if (status.ok === true) return [];
  if (status.ok === false) {
    return [
      "Agents will start, join their room and sit ready, but every answer will be refused",
      "(unauthorized: cannot authenticate to the model provider). In the shell that runs `rfa up`:",
      "    claude /login                        # once, on this machine",
      "    export ANTHROPIC_API_KEY=sk-ant-...  # or an API key; residents inherit it",
    ];
  }
  return ["If agents later refuse with \"unauthorized: cannot authenticate to the model provider\", this is why:", "run `claude /login` on this machine, or export ANTHROPIC_API_KEY in the shell that runs `rfa up`."];
}

/** Is this TCP port free on loopback? */
export function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** The first free port at or above `from`. */
export async function nextFreePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p++) if (await portFree(p)) return p;
  return from;
}
