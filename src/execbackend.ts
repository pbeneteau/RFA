/**
 * The exec-tool backend interface (RFA v0.4 spec section 6): ONE seam for
 * every sandbox tier, in deepagents' shape: execute(command) -> {output,
 * exitCode, truncated}. File ops derive from it; swapping tiers (or a cloud
 * provider later) never touches callers.
 *
 * - PlainBackend: no isolation (Tier 0 debugging and tests only; never the
 *   default for an exec-capable resident).
 * - SrtLocalBackend: Anthropic's sandbox-runtime (Seatbelt on macOS,
 *   bubblewrap on Linux) with the srt settings vocabulary verbatim. Spike
 *   findings (2026-08-16) apply: reaching the local hub needs
 *   network.allowLocalBinding=true, which opens ALL loopback ports; room join
 *   secrets at the hub are the mitigation. srt is a blast-radius reducer,
 *   not a hostile-code boundary: hostile code belongs in a Tier 2 container.
 */
import { exec } from "node:child_process";

export interface ExecResult {
  output: string;
  exitCode: number;
  truncated: boolean;
}

export interface ExecBackend {
  execute(command: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<ExecResult>;
}

const DEFAULTS = { timeoutMs: 60_000, maxOutputBytes: 64_000 };

function runShell(command: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = opts?.maxOutputBytes ?? DEFAULTS.maxOutputBytes;
  return new Promise((resolve) => {
    exec(command, { shell: "/bin/zsh", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
      const truncated = Buffer.byteLength(raw) > maxBytes;
      const output = truncated ? raw.slice(0, maxBytes) + "\n[output truncated]" : raw;
      const exitCode = err ? ((err as Error & { code?: number }).code ?? 1) : 0;
      resolve({ output, exitCode: typeof exitCode === "number" ? exitCode : 1, truncated });
    });
  });
}

/** Tier 0/debug: no isolation. */
export class PlainBackend implements ExecBackend {
  execute(command: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<ExecResult> {
    return runShell(command, opts);
  }
}

/** srt policy in the settings-JSON vocabulary (subset the backend consumes). */
export interface SrtPolicy {
  network?: {
    allowedDomains?: string[];
    deniedDomains?: string[];
    allowLocalBinding?: boolean;
  };
  filesystem?: {
    denyRead?: string[];
    allowRead?: string[];
    allowWrite?: string[];
    denyWrite?: string[];
  };
}

/** Tier 1: whole-command wrapping via @anthropic-ai/sandbox-runtime. */
export class SrtLocalBackend implements ExecBackend {
  private initialized = false;

  constructor(private policy: SrtPolicy) {}

  private async init(): Promise<void> {
    if (this.initialized) return;
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.initialize(this.policy as never);
    this.initialized = true;
    this.wrap = (cmd: string) => SandboxManager.wrapWithSandbox(cmd, "/bin/zsh");
  }

  private wrap: (cmd: string) => Promise<string> = async () => {
    throw new Error("not initialized");
  };

  async execute(command: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<ExecResult> {
    await this.init();
    const wrapped = await this.wrap(command);
    return runShell(wrapped, opts);
  }
}
