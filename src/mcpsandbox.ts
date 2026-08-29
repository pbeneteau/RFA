/**
 * Confining a pack's MCP servers at the `mcpServers` spawn seam (RFA-0.9
 * sect. 5.4, rung 8).
 *
 * THE FINDING. Probe E5 measured a stdio MCP server, spawned by the SDK for a
 * fenced query, reaching a host `strictAllowlist` denied to `Bash` in the same
 * run and writing a file outside `filesystem.allowWrite` that was still on disk
 * afterwards. `npm run egress-proof` reproduces it on every run. What confined
 * such a server was exactly two things: which of its tools the pack declared,
 * and which credentials the supervisor injects.
 *
 * THE SEAM. The SDK spawns those children, so confinement means wrapping the
 * spawn. It covers the `command` and `builtin` forms and **not** the `url` form,
 * whose process is not ours to wrap; that residual surface is named by
 * `src/surface.ts` and rendered by `rfa doctor` and `rfa agent show`, which are
 * the two sect. 5.2 binds, so its rendering stays true afterwards. (`rfa status`
 * renders the posture and `reach` built-ins, not a pack's surface, so it is
 * deliberately not in that list.)
 *
 * THE POLICY IS DECLARED, NEVER DERIVED (owner's decision, 2026-08-30). Sect.
 * 4.1 says the pack's `sandbox.network` governs its sandboxed COMMAND surface
 * and explicitly not its MCP servers, so reusing it here would make that scope
 * sentence false everywhere it is rendered. Each server declares its own, and a
 * `command` or `builtin` server that declares none is REFUSED at definition
 * load: this platform's doctrine is that a pack gets what it declares, and the
 * fail-closed direction is the one every other refusal in RFA-0.9 takes.
 *
 * ONE srt INSTANCE PER SERVER, and that is why there is a launcher rather than a
 * wrap in the resident. `SandboxManager` is a process-global singleton with one
 * configuration and one egress proxy; two servers with different allowlists
 * cannot both be enforced by it. So the resident spawns `src/mcplaunch.ts`,
 * which initializes srt with THAT server's policy in its own process, wraps the
 * real server command and execs it with stdio inherited - the SDK's pipe reaches
 * the real server untouched, and the launcher stays alive as its parent so the
 * proxy outlives nothing and nothing outlives the proxy.
 */
import * as path from "node:path";
import type { EgressPolicy } from "./egress.js";
import { NETWORK_OPEN_REFUSAL } from "./egress.js";

/** The `sandbox` block a `command` or `builtin` MCP server must declare. */
export interface McpServerSandbox {
  network: "none" | "allowlist" | "open";
  allowed_domains?: string[];
  /** Paths this server may write, relative to the pack directory (or absolute inside it). */
  allow_write?: string[];
}

/** What the launcher is handed, as JSON, on one environment variable. */
export interface McpSandboxPolicy {
  server: string;
  network: EgressPolicy;
  allowWrite: string[];
  cwd: string;
}

/** Which server forms this platform can wrap. The `url` form's process is not ours to spawn. */
export function isWrappableServer(def: unknown): boolean {
  return !!def && typeof def === "object" && ("command" in def || "builtin" in def);
}

/**
 * The policy for ONE server, resolved against the pack directory.
 *
 * `allow_write` paths resolve against the pack directory and must stay inside
 * it, for the same reason `sandbox.cwd` must (sect. 3.4b): a path this platform
 * hands to an OS sandbox as writable is a hole exactly as wide as the path, and
 * a relative one whose base nobody stated is how `cwd: "."` reached the hub root.
 */
export function mcpServerPolicy(packDir: string, name: string, sandbox: McpServerSandbox): McpSandboxPolicy {
  return {
    server: name,
    network: {
      allowedDomains: sandbox.network === "allowlist" ? [...(sandbox.allowed_domains ?? [])] : [],
      deniedDomains: [],
      // Sect. 4.3's rule applies wherever this platform establishes a network
      // policy, and this is one of those places: without it the outcome is
      // decided by whoever answers the ask, and there is no callback here at all.
      strictAllowlist: true,
    },
    allowWrite: (sandbox.allow_write ?? []).map((p) => path.resolve(packDir, p)),
    cwd: packDir,
  };
}

/**
 * Every way an `mcp_servers` entry's sandbox declaration can be refused at
 * definition load, each naming what it would require.
 *
 * The refusal for a MISSING block is the load-bearing one: it is what makes this
 * rung a control rather than an option, and it will refuse packs that work
 * today. That is the intended direction of failure, the same one Appendix B item
 * 5 records for the class table, and `rfa doctor` names the exact block to add.
 */
export function mcpSandboxFailures(
  packDir: string,
  def: { mcp_servers?: Record<string, unknown> },
): string[] {
  const out: string[] = [];
  for (const [name, raw] of Object.entries(def.mcp_servers ?? {})) {
    const server = raw as { sandbox?: McpServerSandbox; url?: string };
    const wrappable = isWrappableServer(raw);
    if (!wrappable) {
      if (server.sandbox) {
        out.push(
          `mcp_servers.${name} is the \`url\` form and declares a \`sandbox\` block. That process is not ours to spawn, so nothing here could enforce it ` +
            `(RFA-0.9 sect. 5.4). Remove the block; the surface stays unconfined and is named as residual by \`rfa doctor\` and \`rfa agent show\``,
        );
      }
      continue;
    }
    if (!server.sandbox) {
      out.push(
        `mcp_servers.${name} is spawned by this platform and declares no \`sandbox\` block, so it would run OUTSIDE the query's OS sandbox: probe E5 measured such a child reaching a host ` +
          `strictAllowlist denied to Bash in the same run and writing a file outside filesystem.allowWrite that was still there afterwards (RFA-0.9 sect. 5.1). ` +
          `Declare what it may reach and where it may write, for example:\n` +
          `      sandbox:\n        network: allowlist          # or \`none\` for a server that needs no egress\n        allowed_domains: [api.example.com]\n        allow_write: ["state/drafts"]   # pack-relative, and inside the pack`,
      );
      continue;
    }
    const s = server.sandbox;
    if (s.network === "open") out.push(`mcp_servers.${name}.sandbox.network: ${NETWORK_OPEN_REFUSAL}`);
    if (s.network === "allowlist" && (s.allowed_domains ?? []).length === 0) {
      out.push(
        `mcp_servers.${name}.sandbox.network is \`allowlist\` with no \`allowed_domains\`. An allowlist with nothing on it is not \`none\`: it is a declaration that says a policy exists ` +
          `and names no host, and it MUST NOT be silently treated as \`none\` (RFA-0.9 sect. 4.2, applied to the server's own policy)`,
      );
    }
    if (s.allowed_domains !== undefined && s.network !== "allowlist") {
      out.push(`mcp_servers.${name}.sandbox.allowed_domains is set and its network is \`${s.network}\`, so nothing reads it. It is meaningful only beside \`network: allowlist\``);
    }
    for (const p of s.allow_write ?? []) {
      const abs = path.resolve(packDir, p);
      const rel = path.relative(packDir, abs);
      if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
        out.push(
          `mcp_servers.${name}.sandbox.allow_write ${JSON.stringify(p)} resolves to ${abs}, outside this pack's own directory (${packDir}). ` +
            `A path handed to an OS sandbox as writable is a hole exactly as wide as the path; keep it inside the pack (RFA-0.9 sect. 5.4, the rule sect. 3.4b applies to sandbox.cwd)`,
        );
      }
    }
  }
  return out;
}

/** The environment variable the launcher reads its policy from. */
export const MCP_SANDBOX_ENV = "RFA_MCP_SANDBOX";

/** POSIX single-quote quoting: the launcher hands srt a shell STRING, and an argument may contain anything. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
