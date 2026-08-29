/**
 * The MCP-server launcher (RFA-0.9 sect. 5.4, rung 8).
 *
 *   node --import tsx src/mcplaunch.ts -- <command> [args…]
 *
 * It exists so that each of a pack's MCP servers can have its OWN sandbox
 * policy. `SandboxManager` is a process-global singleton with one configuration
 * and one egress proxy, so a resident that wrapped every server itself could
 * enforce exactly one allowlist across all of them. This process initializes srt
 * with one server's policy, wraps that server's command, and execs it with
 * STDIO INHERITED, so the SDK's own pipe reaches the real server untouched and
 * this process is simply its parent for as long as it lives.
 *
 * It refuses to run rather than running the server unconfined. That is the same
 * choice RFA-0.8 sect. 9 item 3 makes for the write fence and for the same
 * reason: a sandbox that silently falls back to no sandbox and reports success
 * is the failure mode being avoided, and an MCP child is precisely the surface
 * probe E5 measured escaping.
 */
import { spawn } from "node:child_process";
import { MCP_SANDBOX_ENV, shellQuote, type McpSandboxPolicy } from "./mcpsandbox.js";

const die = (msg: string): never => {
  // stderr, never stdout: stdout IS the MCP transport and a stray byte on it
  // corrupts the framing the SDK is parsing.
  process.stderr.write(`rfa mcp launcher: ${msg}\n`);
  process.exit(1);
};

const raw = process.env[MCP_SANDBOX_ENV];
if (!raw) die(`${MCP_SANDBOX_ENV} is not set. This launcher never runs a server unconfined; the resident sets it from the server's own \`sandbox\` block (RFA-0.9 sect. 5.4)`);

let policy: McpSandboxPolicy;
try {
  policy = JSON.parse(raw!) as McpSandboxPolicy;
} catch (err) {
  die(`${MCP_SANDBOX_ENV} is not valid JSON: ${(err as Error).message}`);
  throw err;
}

const sep = process.argv.indexOf("--");
const command = sep >= 0 ? process.argv.slice(sep + 1) : [];
if (command.length === 0) die("no server command after `--`");

const srt = (await import("@anthropic-ai/sandbox-runtime")).SandboxManager as unknown as {
  isSupportedPlatform(): boolean;
  initialize(config: unknown): Promise<void>;
  waitForNetworkInitialization?(): Promise<boolean>;
  wrapWithSandboxArgv(
    command: string,
    shell?: string,
    customConfig?: unknown,
    signal?: unknown,
    cwd?: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
};

if (!srt.isSupportedPlatform()) {
  die(`the sandbox runtime does not support ${process.platform}, and server \`${policy.server}\` may not run unconfined (RFA-0.9 sect. 5.4)`);
}

try {
  await srt.initialize({ network: policy.network, filesystem: { allowWrite: policy.allowWrite, denyWrite: [] } });
  // The egress proxy is what carries the allowlist; a server started before it
  // is up would reach nothing at all and look like a broken server rather than
  // a confined one.
  if (srt.waitForNetworkInitialization && !(await srt.waitForNetworkInitialization())) {
    die(`the sandbox runtime's egress proxy did not come up, so server \`${policy.server}\` has no network policy in force`);
  }
} catch (err) {
  die(`the sandbox could not be established for server \`${policy.server}\`: ${(err as Error).message}`);
}

const wrapped = await srt.wrapWithSandboxArgv(command.map(shellQuote).join(" "), "/bin/sh", undefined, undefined, policy.cwd);
const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: policy.cwd, env: wrapped.env, stdio: "inherit" });

// The launcher is a shim: every signal it gets belongs to the server, and its
// exit code is the server's. A launcher that outlived its child would leave the
// SDK holding a pipe nobody is reading.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on("error", (err) => die(`server \`${policy.server}\` could not be spawned: ${err.message}`));
