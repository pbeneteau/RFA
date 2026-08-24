/**
 * The machine, checked before anything is written (RFA-0.7 sect. 13.2): the
 * Node this runs on, the native SQLite binding, git, the model CLIs and whether
 * they are logged in, and the optional tools some commands lean on. The
 * onboarding shows this as its first screen, `rfa doctor` as its first lines,
 * and `rfa init --yes` prints it before provisioning.
 *
 * Only `claude` (the Claude Agent SDK's login) or ANTHROPIC_API_KEY makes an
 * agent answer. Other model CLIs are reported because an operator asked
 * whether they are seen, and they are, with the honest note that rfa does not
 * run residents on them today.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { modelCredentialStatus, nativeBindingProblem } from "./preflight.js";

export interface EnvCheck {
  id: string;
  verdict: "ok" | "warn" | "fail" | "skip";
  text: string;
  fix?: string;
}

/** What the checks look at, injectable so a test can describe a machine. */
export interface Probe {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  home: string;
  cwd: string;
  which(cmd: string): string | null;
  exists(file: string): boolean;
  version(cmd: string, args?: string[]): string | null;
  writable(dir: string): boolean;
}

export function realProbe(env: NodeJS.ProcessEnv = process.env): Probe {
  const which = (cmd: string): string | null => {
    for (const dir of (env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue;
      const full = path.join(dir, cmd);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
    return null;
  };
  return {
    env,
    platform: process.platform,
    nodeVersion: process.version,
    home: os.homedir(),
    cwd: process.cwd(),
    which,
    exists: (f) => fs.existsSync(f),
    version: (cmd, args = ["--version"]) => {
      try {
        return execFileSync(cmd, args, { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"], env }).trim().split("\n")[0].slice(0, 60) || null;
      } catch {
        return null;
      }
    },
    writable: (dir) => {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const ok = (id: string, text: string): EnvCheck => ({ id, verdict: "ok", text });
const warn = (id: string, text: string, fix?: string): EnvCheck => ({ id, verdict: "warn", text, fix });
const fail = (id: string, text: string, fix?: string): EnvCheck => ({ id, verdict: "fail", text, fix });
const skip = (id: string, text: string): EnvCheck => ({ id, verdict: "skip", text });

export function checkEnvironment(p: Probe = realProbe()): EnvCheck[] {
  const out: EnvCheck[] = [];

  const major = Number(p.nodeVersion.replace(/^v/, "").split(".")[0]);
  out.push(major >= 22 ? ok("node", `node ${p.nodeVersion}`) : fail("node", `node ${p.nodeVersion} is below 22`, "Node 20 reached end of life in April 2026; install 22 or newer"));

  const binding = nativeBindingProblem();
  out.push(binding ? fail("sqlite", binding.message, binding.hint) : ok("sqlite", `better-sqlite3 opens a database under node ${p.nodeVersion}`));

  const git = p.which("git");
  out.push(git ? ok("git", `git ${p.version("git")?.replace(/^git version /, "") ?? ""}`.trim()) : warn("git", "git is not installed", "rfa knowledge add <agent> <git remote> needs it; a folder of markdown does not"));

  // The model credential: the one thing an agent cannot answer without.
  const claude = p.which("claude");
  const cred = modelCredentialStatus(p.env);
  if (cred.ok === true) out.push(ok("claude", `${claude ? `claude ${p.version("claude") ?? ""}`.trim() + ": " : ""}${cred.detail}`));
  else if (!claude && !p.env.ANTHROPIC_API_KEY) out.push(fail("claude", "no `claude` CLI on PATH and no ANTHROPIC_API_KEY: agents start, join and sit ready, but every answer is refused", "npm install -g @anthropic-ai/claude-code, then `claude` once to log in; or export ANTHROPIC_API_KEY"));
  else out.push(warn("claude", `claude is installed but ${cred.detail}`, "run `claude` once and log in; agents inherit the login from the shell that runs rfa up"));

  // Other model CLIs: seen, named, and not used, said plainly.
  const codex = p.which("codex");
  if (codex) {
    const loggedIn = p.exists(path.join(p.home, ".codex", "auth.json")) || Boolean(p.env.OPENAI_API_KEY);
    out.push(ok("codex", `codex ${p.version("codex") ?? ""}`.trim() + `: installed, ${loggedIn ? "logged in" : "not logged in"}; not used by rfa today (residents run on the Claude Agent SDK)`));
  } else out.push(skip("codex", "codex (OpenAI) not installed; optional, not used by rfa today"));
  const gemini = p.which("gemini");
  if (gemini) {
    const loggedIn = p.exists(path.join(p.home, ".gemini", "oauth_creds.json")) || Boolean(p.env.GEMINI_API_KEY);
    out.push(ok("gemini", `gemini ${p.version("gemini") ?? ""}`.trim() + `: installed, ${loggedIn ? "logged in" : "not logged in"}; not used by rfa today`));
  } else out.push(skip("gemini", "gemini (Google) not installed; optional, not used by rfa today"));

  const tailscale = p.which("tailscale");
  out.push(tailscale ? ok("tailscale", "tailscale is installed; rfa hub expose --tailscale can put the hub on your tailnet") : skip("tailscale", "tailscale not installed; optional, for rfa hub expose"));

  if (p.platform === "darwin") out.push(p.which("launchctl") ? ok("service", "launchd: rfa service install can keep the hub running across reboots") : skip("service", "no launchctl"));
  else if (p.platform === "linux") out.push(p.which("systemctl") ? ok("service", "systemd: rfa service install can keep the hub running across reboots") : skip("service", "no systemctl; rfa service install needs systemd"));
  else out.push(skip("service", `${p.platform}: no service manager support; rfa up runs the daemons by hand`));

  out.push(p.writable(p.cwd) ? ok("cwd", `${p.cwd} is writable`) : fail("cwd", `${p.cwd} is not writable`, "cd to a folder you own, or pass --dir"));
  return out;
}

/**
 * A ✖ that must stop provisioning. The missing model credential is a real ✖
 * (agents join, sit ready and refuse every answer) but not a blocker: the hub,
 * the rooms and the packs all work without it and `rfa init --yes` has always
 * proceeded past it, so the onboarding must not be stricter than the headless
 * truth. It once was, and a machine without `claude` dead-ended on the checks
 * screen with only "check again" and "quit" to press.
 */
export function blocksProvisioning(c: EnvCheck): boolean {
  return c.verdict === "fail" && c.id !== "claude";
}

export function environmentBlocks(checks: EnvCheck[]): boolean {
  return checks.some(blocksProvisioning);
}
