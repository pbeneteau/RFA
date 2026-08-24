/**
 * What every command needs (RFA-0.7 sect. 6.1): the hub directory, resolved
 * once and lazily; the credentials the CLI acts with (the operator bearer, the
 * operator's human key); a workbench session; and the exit-code vocabulary.
 *
 * Exit codes: 0 done, 1 failed, 2 usage, 3 precondition (not a hub directory,
 * hub not running, not authenticated), so a script can tell "you ran it wrong"
 * from "it is not up".
 */
import { HubDirError, requireHubDir, secretsStore, type HubDir } from "../hubdir.js";
import { transportToken } from "../secrets.js";
import type { Ui } from "./ui.js";

export class CliError extends Error {
  constructor(
    readonly exitCode: 1 | 2 | 3,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * A numeric flag parsed strictly: `--timeout abc` must be a usage error at the
 * door, because downstream it becomes NaN arithmetic that LOOKS like behaviour
 * (an ask with `--timeout abc` "timed out" instantly: the deadline was NaN, and
 * `Date.now() < NaN` is false on the first check).
 */
export function numberFlag(v: unknown, flag: string, opts: { int?: boolean; min?: number; max?: number } = {}): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  const ok = Number.isFinite(n) && (!opts.int || Number.isInteger(n)) && (opts.min === undefined || n >= opts.min) && (opts.max === undefined || n <= opts.max);
  if (ok) return n;
  const range = opts.min !== undefined && opts.max !== undefined ? ` from ${opts.min} to ${opts.max}` : opts.min !== undefined ? ` of at least ${opts.min}` : opts.max !== undefined ? ` of at most ${opts.max}` : "";
  throw new CliError(2, `--${flag} takes a ${opts.int ? "whole number" : "number"}${range}, not ${JSON.stringify(String(v))}`);
}

export interface GlobalFlags {
  dir?: string;
  json: boolean;
  yes: boolean;
  quiet: boolean;
  debug: boolean;
}

export class CliContext {
  private resolved: HubDir | null | undefined;
  private sessionToken: string | null = null;

  constructor(
    readonly flags: GlobalFlags,
    readonly ui: Ui,
    readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Interactive means a terminal on both ends and nobody said --yes or --json. */
  get interactive(): boolean {
    return this.ui.opts.tty && !this.flags.yes && !this.flags.json;
  }

  /** The hub directory, or exit 3 with the fix named. */
  hubdir(): HubDir {
    if (this.resolved) return this.resolved;
    try {
      this.resolved = requireHubDir({ dir: this.flags.dir, env: this.env });
      return this.resolved;
    } catch (err) {
      if (err instanceof HubDirError) throw new CliError(3, err.message, err.hint);
      throw err;
    }
  }

  /** The hub directory if one is named or found, null otherwise; an invalid one still throws. */
  maybe(): HubDir | null {
    try {
      return this.hubdir();
    } catch (err) {
      if (err instanceof CliError && /not a hub directory|no rfa\.json/.test(err.message)) return null;
      throw err;
    }
  }

  /** Drop the cached directory (after `init` or `migrate` created one). */
  reset(): void {
    this.resolved = undefined;
  }

  secrets(): Record<string, string> {
    return secretsStore(this.hubdir()).read();
  }

  /** The operator bearer, from the environment or the secrets file (never captured at import: src/client.ts reads it per call). */
  operatorToken(): string | null {
    return transportToken(this.hubdir().paths.secrets);
  }

  /** The operator's own human key: what makes this CLI a human principal. */
  humanKey(): string | null {
    return this.env.RFA_HUMAN_KEY?.trim() || this.secrets().RFA_HUMAN_KEY?.trim() || null;
  }

  /** Every hub call this process makes carries the operator bearer. */
  armTransport(): void {
    const tok = this.operatorToken();
    if (tok && !this.env.RFA_TOKEN) this.env.RFA_TOKEN = tok;
  }

  hubUrl(): string {
    return this.env.RFA_HUB_URL ?? this.hubdir().hubUrl;
  }

  /** Base URL of the hub's HTTP listener (the workbench lives beside /mcp). */
  hubBase(): string {
    return this.hubUrl().replace(/\/mcp\/?$/, "");
  }

  /** `GET /healthz` says 200: the hub serves. */
  async healthz(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`${this.hubBase()}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** A workbench session minted from the operator's human key (POST /auth), cached for the process. */
  async session(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    const key = this.humanKey();
    if (!key) throw new CliError(3, "no human key for this CLI: RFA_HUMAN_KEY is neither in the environment nor in .rfa/secrets.json", "rfa human add <label> mints one and keeps the operator's copy there");
    const res = await fetch(`${this.hubBase()}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ human_key: key }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new CliError(3, `the hub refused this human key (POST /auth returned ${res.status})`, "the key in .rfa/secrets.json must be one of the principals in .rfa/principals.json; rfa doctor checks that");
    const body = (await res.json()) as { session_token: string };
    this.sessionToken = body.session_token;
    return this.sessionToken;
  }

  /** A workbench read or write with the session token. */
  async workbench<T = unknown>(route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.session();
    const res = await fetch(`${this.hubBase()}${route}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const detail = typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 120);
      throw new CliError(1, `${init.method ?? "GET"} ${route} returned ${res.status}: ${detail}`);
    }
    return parsed as T;
  }
}
