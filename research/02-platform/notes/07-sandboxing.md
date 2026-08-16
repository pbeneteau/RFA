# 07 - Sandboxing for agent tool/code execution

Dimension research for RFA (Rooms for Agents). Question: what sandbox tiers fit a personal,
local-first agent platform on one Mac (network egress allowlists, fs scoping, per-agent budgets),
and what exact config surfaces should RFA copy?

Date: 2026-08-16. All schemas below were copied from primary sources (linked at the bottom).

---

## What it is

Two families of sandboxing exist for agent execution, and they solve different problems:

1. **OS-level policy sandboxes (local-first)**: wrap a process with kernel-enforced filesystem
   and network rules on the machine you already have. No VM, no container, near-zero overhead.
   - Anthropic **sandbox-runtime (srt)**: macOS seatbelt (`sandbox-exec`) + Linux bubblewrap,
     with host-side HTTP/SOCKS5 proxies enforcing domain allowlists. This is the exact
     mechanism Claude Code's own sandboxed bash uses (Anthropic reports it cut permission
     prompts by 84% in internal testing).
   - **Deno permission flags**: V8-level capability system for JS/TS code only.
   - **firejail**: Linux desktop-app sandbox (namespaces + seccomp-bpf). Linux only.
   - **Docker / apple-container**: container or lightweight-VM isolation, with resource caps.
   - **gVisor (runsc)**: userspace application kernel between container and host. Linux only.

2. **Cloud sandbox services (remote microVMs/containers as an API)**: a `Sandbox.create()` +
   `run` + files SDK against someone else's fleet.
   - **E2B**: Firecracker microVMs, code-interpreter SDK, pause/resume persistence
     (memory + filesystem). Infra is open source (Apache 2.0) but is a Go + Nomad + Consul +
     KVM stack targeting GCP/AWS Linux fleets.
   - **Modal Sandboxes**: gVisor-isolated containers, richest network policy knobs
     (`block_network`, `outbound_cidr_allowlist`, `outbound_domain_allowlist`).
   - **Daytona**: containers (<90ms start) plus Linux/Windows VM and GPU classes; lifecycle
     automation (auto-stop, auto-archive, auto-delete).
   - **Vercel Sandbox**: Firecracker microVMs, persistent-by-default with auto filesystem
     snapshot on stop, SNI-based `networkPolicy` firewall, Drives for persistent storage.
   - **Cloudflare Sandbox SDK**: containers bound to Workers + Durable Objects; Workers Paid
     plan only.

The anchor inspiration (LangChain deep agents) treats all of these as **pluggable backends
behind one interface**: `SandboxBackendProtocol` requires a single `execute(command)` method;
every file operation (read/write/edit/ls/glob/grep) is derived from it by a `BaseSandbox` base
class. Shipped wrappers: `LangSmithSandbox`, `DaytonaSandbox`, `E2BSandbox`, `ModalSandbox`,
`RunloopSandbox`, `VercelSandbox`, `AgentCoreSandbox`, `OpenShellSandbox`. That interface shape
is the portable part; the providers are interchangeable behind it.

LangChain also names the two integration patterns explicitly:
- **Sandbox as tool** (recommended, what their docs use): agent runs on your machine, calls
  into the sandbox for execution. Keys stay outside, agent updates are instant, sandbox
  failures do not kill agent state, parallel sandboxes are easy.
- **Agent in sandbox**: agent process itself runs inside. Mirrors local dev, but secrets must
  live inside, image rebuilds slow iteration, and every tool runs at the same privilege as
  LLM-generated code.

For RFA the split is not either/or: locally, wrapping the whole `claude -p` process in srt is
cheap (no image rebuild problem, secrets stay on the same machine), and a separate
sandbox-as-tool tier handles untrusted generated code.

---

## Architecture (how it actually works)

### Anthropic sandbox-runtime (srt) - the key local-first system

- **macOS**: generates a Seatbelt profile per invocation and runs the command under
  `sandbox-exec`. The profile pins filesystem read/write paths (glob patterns `*`, `**`, `?`,
  `[abc]` supported) and allows network communication **only to specific localhost ports**
  where srt's proxies listen.
- **Linux**: bubblewrap (bind mounts mark dirs ro/rw; no glob support) + seccomp BPF; the
  sandboxed process's network namespace is removed entirely and traffic is routed
  "via the filesystem over a Unix domain socket" (socat bridge). Prebuilt `apply-seccomp`
  binaries (x64/arm64) block Unix socket creation at the syscall level.
- **Network mediation**: two host-side proxies outside the sandbox. An HTTP proxy validates
  HTTP/HTTPS against domain allow/deny lists; a SOCKS5 proxy handles other TCP (SSH,
  databases). Allow-only model: all network denied by default.
- **Filesystem model**: reads are deny-then-allow (everything readable by default, carve out
  `denyRead`, `allowRead` overrides). Writes are allow-only (nothing writable by default,
  `denyWrite` overrides `allowWrite`).
- **Defense-in-depth**: certain files are always write-blocked regardless of config: shell
  configs (`.bashrc`, `.zshrc`), `.gitconfig` and `.git/hooks/`, IDE dirs (`.vscode/`,
  `.idea/`), and `.claude/commands/`. This exists precisely because a sandboxed agent that can
  write your shell rc has escaped.
- **Known limitations** (from the README): on Linux, programs that ignore `HTTP_PROXY` env
  vars bypass filtering; on macOS the system DNS resolver is not fenced (custom DNS clients
  like dig are blocked instead); allowing a broad Unix socket like `/var/run/docker.sock`
  grants effective host access; overly broad write grants to `$PATH` or shell configs enable
  escalation.
- **Deps on macOS**: just ripgrep (Homebrew). Distributed as npm package
  `@anthropic-ai/sandbox-runtime`, usable as CLI (`srt "cmd"`) or as a TypeScript library
  (`SandboxManager`). This matters for RFA: it is TypeScript-native and embeddable in the
  RoomMember runtime.

### E2B

Firecracker microVM per sandbox (KVM). Control plane: API layer + orchestrator + `envd`
daemon inside the VM. Open source infra (Apache 2.0) deployable via Terraform on GCP (full)
or AWS (beta); self-hosting requires a Linux/KVM fleet with Nomad + Consul. SDK is the
polished part: `@e2b/code-interpreter` gives `runCode` with a persistent interpreter context,
`commands.run`, `files.*`. Persistence is the standout feature: `sandbox.pause()` snapshots
**memory and filesystem** (~4s per GiB RAM), `connect()` resumes in ~1s, paused sandboxes are
retained indefinitely. `lifecycle: { onTimeout: 'pause' }` turns timeouts into hibernation
instead of death.

### Modal Sandboxes

Containers virtualized with **gVisor** ("compute jobs at Modal are containerized and
virtualized using gVisor"). Best-in-class egress policy surface: `block_network=True` drops
everything; `outbound_cidr_allowlist` (any protocol) and `outbound_domain_allowlist`
(TLS/443 only, SNI-based) are additive allowlists; `inbound_cidr_allowlist` gates tunnels.
Lifetime: default 5 min, max 24h, `idle_timeout` for auto-termination. Filesystem snapshots
exist for state beyond 24h. Python-first; JS SDK exists but secondary.

### Daytona

Container default (<90ms start) with VM and GPU classes. Lifecycle automation is the notable
design: auto-stop after N idle minutes, auto-archive (stopped container filesystems move to
object storage), auto-delete, wall-clock TTL, ephemeral mode (auto-delete=0). Container
sandboxes preserve filesystem on stop but not memory; VMs pause/resume with memory. Default
org caps: 4 vCPU, 8GB RAM, 10GB disk. "Bring Your Own Compute" exists but targets Linux.

### Vercel Sandbox

Firecracker microVMs, ~ms start, root access, can even run Docker inside ("system-privileged
processes"). Persistent by default: on stop the SDK snapshots the filesystem and restores on
resume (`persistent: true`, `snapshotExpiration` default 30 days, `keepLastSnapshots`
retention policy). Network firewall (`NetworkPolicy`) is SNI-based like Modal's domain list:
base modes `allow-all` (default) / `deny-all` (blocks even DNS), plus `allow` domain rules
with wildcard semantics (`*.google.com` matches subdomains, not the parent) and
`subnets.allow` / `subnets.deny` CIDR lists for non-TLS traffic. Multi-agent isolation inside
one sandbox via Linux users/groups (`sandbox.createUser('alice')`). Default image
`vercel/sandbox/universal` ships Node LTS + Python 3.14 + coding agents.

### Cloudflare Sandbox SDK

Containers exposed through Workers, addressed like Durable Objects
(`getSandbox(env.Sandbox, userId)` gives a stable per-id environment). Nice API
(`exec`, `createCodeContext({language})`, `runCode`, `readFile`/`writeFile`, `watch`,
browser `terminal` over WebSocket) but execution is welded to the Workers platform and
requires the Workers Paid plan. Not local, not portable.

### Local building blocks beyond srt

- **Deno permissions**: opt-in capability flags at the runtime level with granular scoping:
  `--allow-read=./data`, `--allow-net=example.com` (host and `:port` scoping),
  `--allow-env=API_KEY`, `--allow-run=git`, plus `--deny-*` overrides
  (`--allow-read --deny-read=/etc`) and `--no-prompt` for non-interactive fail-closed
  behavior. Two documented escape hatches: `--allow-run` subprocesses inherit full OS
  privileges (not the Deno policy), and `--allow-ffi` executes native code past the
  JS-layer enforcement. `--allow-write` + `--allow-run` combined enable binary-replacement
  attacks. So: good for pure-TS untrusted code, useless as a general bash sandbox.
  (Node's own `--permission` model covers fs/child_process/worker but has no network
  scoping, so Deno is the stronger choice for this niche.)
- **Docker on macOS**: every container runs inside a shared Linux VM (Apple Virtualization
  framework), so container-to-host isolation is a VM boundary plus namespaces. Real resource
  budgets exist here and nowhere else on the Mac: `--cpus`, `--memory`, `--pids-limit`,
  `--network none`, read-only bind mounts.
- **apple/container**: Apple's open-source Swift tool (macOS 26, Apple silicon) runs each
  OCI container as its own lightweight VM (`container run --rm alpine echo hello`).
  Stronger per-container isolation than Docker Desktop's shared VM; still pre-1.0.
- **gVisor**: userspace Sentry kernel intercepts syscalls, Gofer process mediates file access
  over 9P, ships as OCI runtime `runsc` for Docker/K8s. Linux only; on a Mac it could only
  live inside the Docker VM, which Docker Desktop does not make practical. Relevant to RFA
  only as "what Modal uses".
- **firejail**: SUID sandbox for Linux desktop apps (namespaces, seccomp-bpf, per-app
  profiles). Linux only, desktop-app focus. No role on a Mac.

---

## Exact schemas and APIs (copied)

### srt settings JSON (the schema RFA should copy)

Network (allow-only; wildcards and `:port` suffixes supported; bracketed IPv6):

```json
{
  "network": {
    "allowedDomains": ["github.com", "*.example.com"],
    "deniedDomains": ["malicious.com"],
    "deniedDomainReasons": {"blocked.com": "reason text"},
    "allowLocalBinding": false,
    "allowUnixSockets": ["/var/run/docker.sock"],
    "allowAllUnixSockets": false,
    "tlsTerminate": {
      "excludeDomains": ["internal-mtls.example.net"],
      "extraCaCertPaths": ["/etc/ca-bundle.pem"]
    }
  }
}
```

Filesystem (reads deny-then-allow; writes allow-only):

```json
{
  "filesystem": {
    "denyRead": ["~/.ssh"],
    "allowRead": ["."],
    "allowWrite": [".", "src/", "/tmp"],
    "denyWrite": [".env", "config/production.json"]
  }
}
```

Other settings:

```json
{
  "ignoreViolations": {
    "*": ["/usr/bin"],
    "git push": ["/usr/bin/nc"]
  },
  "enableWeakerNestedSandbox": false,
  "enableWeakerNetworkIsolation": false,
  "allowAppleEvents": false,
  "mandatoryDenySearchDepth": 3
}
```

CLI and library usage:

```bash
npm install -g @anthropic-ai/sandbox-runtime
srt "curl anthropic.com"
srt --settings /path/to/srt-settings.json npm install
srt --debug curl https://example.com
```

```javascript
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'

const config = {
  network: { allowedDomains: ['example.com', 'api.github.com'], deniedDomains: [] },
  filesystem: { denyRead: ['~/.ssh'], allowWrite: ['.', '/tmp'], denyWrite: ['.env'] }
}

await SandboxManager.initialize(config)
const wrapped = await SandboxManager.wrapWithSandbox('curl https://example.com')
// execute wrapped command, then:
await SandboxManager.reset()
```

### E2B (@e2b/code-interpreter)

```javascript
import { Sandbox } from '@e2b/code-interpreter'

const sbx = await Sandbox.create()               // E2B_API_KEY required
const execution = await sbx.runCode('print("hello world")')  // persistent interpreter context
console.log(execution.logs)
const files = await sbx.files.list('/')
const result = await sbx.commands.run('echo "Hello from E2B Sandbox!"')  // result.stdout
```

Persistence and lifecycle:

```javascript
await sandbox.pause()                            // Running -> Paused; memory + filesystem saved
                                                 // ~4s per GiB RAM; keepMemory: false for fs-only
const same = await sandbox.connect()             // Paused -> Running, ~1s

const sandbox = await Sandbox.create({
  timeoutMs: 10 * 60 * 1000,                     // default timeout 5 minutes
  lifecycle: {
    onTimeout: 'pause',                          // defaults to 'kill'
    autoResume: false,
  },
})
const sbx2 = await Sandbox.connect(sandboxId, { timeoutMs: 60 * 1000 })
```

States: Running, Paused, Snapshotting, Killed. On connect, new expiry = max(current expiry,
now + timeout). Continuous runtime cap 24h (Pro) / 1h (Hobby), reset by a pause/resume cycle.

### Modal Sandboxes (Python; JS/Go SDKs mirror it)

```python
sb = modal.Sandbox.create(app=sb_app)            # timeout default 5 min, max 24h
p = sb.exec("python", "-c", "print('hello')", timeout=3)
print(p.stdout.read())                           # ContainerProcess: stdout, stdin, returncode, wait()
sb.detach()
```

Key create parameters: `app`, `image`, `timeout`, `idle_timeout`, `volumes`, `secrets`,
`command`, `name`, `readiness_probe` (`modal.Probe.with_tcp(8080)` or
`modal.Probe.with_exec("sh", "-c", "test -f /tmp/ready", interval_ms=250)`).

Network policy:

```python
# block_network=True drops all outbound traffic (mutually exclusive with allowlists)
# outbound_cidr_allowlist: only traffic to listed CIDR ranges (any protocol)
# outbound_domain_allowlist: only TLS traffic (port 443) to listed domain names
sb = modal.Sandbox.create(
    "python", "-m", "http.server", "8080",
    encrypted_ports=[8080],
    inbound_cidr_allowlist=["203.0.113.0/24"],
    app=app,
)
tunnel = sb.tunnels()[8080]
```

### Daytona (TypeScript SDK)

```typescript
import { Daytona } from '@daytona/sdk'
const daytona = new Daytona()
const sandbox = await daytona.create({ snapshot: 'daytona-small' })
await sandbox.process.executeCommand('curl http://example.com')
const response = await sandbox.process.codeRun('console.log("Hello")')
// lifecycle: create(), get(), list(), start(), stop(), pause(), resume(), archive()
// automation: auto-stop (idle minutes), auto-pause (VMs), auto-archive, auto-delete, TTL
```

### Vercel Sandbox (@vercel/sandbox)

```typescript
const sandbox = await Sandbox.create({
  name: 'my-sandbox',
  image: 'vercel/sandbox/node:26',               // default: vercel/sandbox/universal
  networkPolicy: 'deny-all',                     // default: 'allow-all'; blocks even DNS
  env: { NODE_ENV: 'production' },
  snapshotExpiration: 7 * 24 * 60 * 60 * 1000,   // default 30 days
});
const result = await sandbox.runCommand('node', ['--version']);
console.log(result.exitCode, await result.stdout());
const same = await Sandbox.get({ name: 'my-sandbox' });   // auto-resumes stopped sandboxes
```

Full `Sandbox.create()` surface: `name`, `source` (git {url, username, password, depth,
revision} | tarball {url} | snapshot {snapshotId}), `resources.vcpus` (2048MB RAM per vCPU,
default 2), `image`, `ports` (up to 15), `timeout` (ms, default 5 min), `networkPolicy`,
`env`, `mounts` (Drives keyed by path, "read-write" | "read-only"), `tags`, `persistent`
(default true), `snapshotExpiration`, `keepLastSnapshots` ({count 1-10, expiration,
deleteEvicted}), `onResume`, `signal`. NetworkPolicy: `allow-all` | `deny-all` | rules with
`allow` (SNI domain matching, wildcard segments) and `subnets.allow` / `subnets.deny` CIDRs;
encryption is not intercepted unless transform/forward rules are defined.

### Cloudflare Sandbox SDK

```typescript
const sandbox = getSandbox(env.Sandbox, userId);
const result = await sandbox.exec('python --version');     // { stdout, stderr, exitCode }
const ctx = await sandbox.createCodeContext({ language: 'python' });
const run = await sandbox.runCode('import pandas as pd', { context: ctx });
await sandbox.writeFile('/workspace/project/package.json', JSON.stringify({}));
```

### Deno permission flags

```bash
deno run --allow-read=./data --allow-net=api.github.com --allow-env=API_KEY \
         --deny-read=/etc --no-prompt script.ts
# --allow-run=git       only that executable; children inherit FULL OS privileges
# --allow-ffi           native code bypasses the JS-layer policy
# --frozen / --cached-only  prevent loading unapproved code
```

### deep agents sandbox backend protocol (the interface to copy)

```python
# SandboxBackendProtocol: the only method a provider must implement is execute(),
# which runs a shell command and returns its output.
# BaseSandbox derives read/write/edit/delete/ls/glob/grep from execute().
# ExecutionResult carries: output (combined stdout/stderr), exit_code, truncation notice.
# Shipped wrappers: LangSmithSandbox, DaytonaSandbox, E2BSandbox, ModalSandbox,
#                   RunloopSandbox, VercelSandbox, AgentCoreSandbox, OpenShellSandbox
```

### gVisor / Docker (context)

gVisor = Sentry (userspace Go kernel: syscalls, signals, memory, threads) + Gofer (file
access over 9P) + `runsc` OCI runtime; "reduced application compatibility and higher
per-syscall overhead" is the stated cost. Docker resource budgets per container:
`--cpus 2 --memory 2g --pids-limit 256 --network none -v "$dir":/work:ro`.

---

## What to adopt for RFA

1. **srt as the Tier-1 default sandbox, embedded as a library.** It is TypeScript
   (`@anthropic-ai/sandbox-runtime`), macOS-native (seatbelt), and the exact mechanism
   Claude Code itself uses. The RFA runtime should call
   `SandboxManager.initialize(config)` + `wrapWithSandbox(cmd)` around every shell/exec a
   resident agent performs. Zero containers, zero latency tax, one npm dependency plus
   ripgrep.

2. **Adopt the srt settings schema verbatim as the agent manifest's sandbox block.** Do not
   invent a new policy vocabulary. Per-agent file
   `data/agents/<agentId>/srt-settings.json` with `network.allowedDomains` (allow-only),
   `filesystem.denyRead` / `allowWrite` / `denyWrite`. The manifest fields then ARE the
   sandbox policy, and the hub can display them as part of the capability card
   (governance for free).

3. **Wrap the whole `claude -p` subprocess in srt for resident agents** (local
   agent-in-sandbox). LangChain's objections to agent-in-sandbox (image rebuilds, secrets
   shipped into a remote VM) do not apply on one Mac. Baseline policy per resident agent:
   `allowedDomains: ["api.anthropic.com", "statsig.anthropic.com", "sentry.io", <agent-specific APIs>]`,
   `allowRead: [<workspace>, "~/.claude"]`, `denyRead: ["~/.ssh", "~/.aws", "dogfood/state"]`,
   `allowWrite: [<workspace>, "/tmp"]`. Verify in a spike that the hub connection works
   under the policy: stdio MCP needs nothing; the HTTP hub on localhost:8790 must be
   reachable through srt's proxy (test `allowedDomains: ["localhost:8790"]` and
   `allowLocalBinding`), since the seatbelt profile only opens srt's own proxy ports.

4. **Adopt the deep agents backend interface for the execution tool**: one
   `execute(command) -> { output, exitCode, truncated }` method; derive file ops from it.
   Implement two backends now: `SrtLocalBackend` (Tier 1) and `DockerBackend` (Tier 2).
   E2B/Modal/Daytona/Vercel become optional drop-ins later with zero changes to agents.
   This is the "sandbox as tool" pattern for untrusted generated code.

5. **Adopt srt's always-blocked write list as an RFA invariant**, extended for RFA:
   `.bashrc`/`.zshrc`, `.gitconfig`, `.git/hooks/`, `.claude/commands/`, plus RFA-specific
   paths: `dogfood/knowledge/` (memory-ingestion defense already exists in the hub; the
   sandbox should enforce it too), agent manifests, and `data/` (hub-owned).

6. **Tiered design (recommendation)**:
   - **Tier 0 - MCP-only**: agent has no exec tool at all; only hub tools + declared MCP
     servers. For pure knowledge agents like the current pm-agent. No sandbox needed.
   - **Tier 1 - srt-wrapped exec (default)**: resident agents with bash/file tools, policy
     from the manifest as above. Covers 90% of daily work.
   - **Tier 1.5 - Deno for untrusted TS snippets**: run generated TypeScript via
     `deno run --no-prompt --allow-read=<scratch> --allow-net=<hosts>` as a cheap code
     interpreter (no --allow-run, no --allow-ffi, ever). Instant, no container pull.
   - **Tier 2 - disposable container per task**: `docker run --rm --network none --cpus 2
     --memory 2g --pids-limit 256 -v <scratch>:/work` behind the `execute()` backend, for
     arbitrary untrusted code (installing packages, running foreign repos). Migrate to
     apple/container when the Mac is on macOS 26 (per-container lightweight VM beats the
     shared Docker VM).
   - **Tier 3 - cloud burst (deferred)**: E2B (best persistence semantics) or Modal (best
     egress policy) behind the same backend interface, only if a small server or
     parallel-scale need materializes.

7. **Per-agent budgets, realistically**: srt does not do CPU/memory. On a Mac the honest
   split is: wall-clock timeout + output truncation + max-concurrent-execs enforced by the
   RFA runtime at the `execute()` boundary (record all three in the existing OTel spans);
   hard CPU/RAM/pids caps only in Tier 2 via Docker flags. Token/cost budgets belong to the
   agent engine, not the sandbox.

## What to adapt

- **E2B's `lifecycle: { onTimeout: 'pause' }` semantics**: locally, adapt as
  "snapshot-on-stop": tar the Tier-2 scratch dir (or `docker commit`) when a task sandbox
  stops, restore on resume. Vercel proves persistent-by-default is a good default UX; full
  memory snapshots stay a cloud-only luxury.
- **Vercel's `networkPolicy: 'deny-all' | 'allow-all' | rules` naming**: adopt the
  three-mode UX in the manifest (`sandbox.network: "none" | "allowlist" | "open"`) but
  compile it down to srt fields; `"open"` should require a room_admin override.
- **Modal's additive CIDR + domain allowlists**: srt only speaks domains; for the rare
  non-TLS/IP case, adapt by routing through the Tier-2 container with its own network
  rather than extending srt.
- **Cloudflare's `getSandbox(ns, id)` addressing**: keep the idea of stable per-agent
  sandbox identity (one policy + one scratch dir per agent id), not the platform.
- **Deno's `--deny-*` override semantics**: srt already has deny-overrides; keep manifest
  semantics identical to srt so there is nothing to translate.

## What to reject and why

- **Self-hosted E2B infra / Firecracker**: KVM + Nomad + Consul + Terraform on Linux
  fleets. Absurd for one Mac; Firecracker does not run on macOS at all.
- **gVisor locally**: Linux-only; would have to live inside Docker's VM, which Docker
  Desktop does not support cleanly. Value only as Modal's internal tech.
- **firejail**: Linux desktop tool; no macOS story.
- **Cloudflare Sandbox SDK**: execution welded to Workers + Durable Objects, Workers Paid
  plan, contradicts local-first; nothing it offers that Tier 2 + backend interface lacks.
- **Daytona/Modal/Vercel as the primary runtime**: cloud dependency for daily personal
  work, per-org caps (Daytona: 4 vCPU/8GB default), and Modal is Python-first while RFA is
  TypeScript-first. All three remain acceptable Tier-3 drop-ins behind `execute()`.
- **Writing a custom seatbelt profile generator**: `sandbox-exec` is deprecated-but-working
  Apple API; srt already generates profiles and Anthropic maintains it. Do not own that
  layer.
- **Node's `--permission` as the TS-snippet sandbox**: no network scoping; Deno's
  per-host/per-port `--allow-net` is strictly better for Tier 1.5.
- **Trusting srt as a hard security boundary for hostile code**: Anthropic ships it as a
  research preview with documented bypass classes (proxy-ignoring programs on Linux, DNS
  not fenced on macOS, Unix socket grants). It is the right prompt-injection blast-radius
  reducer (Tier 1), not the right hostile-code container (that is Tier 2).

## Sources

- https://github.com/anthropic-experimental/sandbox-runtime (srt README: config schema, CLI, library API, limitations)
- https://www.anthropic.com/engineering/claude-code-sandboxing (design rationale, 84% fewer prompts, proxy architecture)
- https://docs.e2b.dev/ and https://docs.e2b.dev/quickstart (SDK shape)
- https://docs.e2b.dev/sandbox/persistence (pause/resume API, lifecycle onTimeout)
- https://github.com/e2b-dev/infra (Firecracker, Nomad/Consul, self-hosting, Apache 2.0)
- https://modal.com/docs/guide/sandbox (Sandbox.create params, exec, probes)
- https://modal.com/docs/guide/sandbox-networking (block_network, cidr/domain allowlists, tunnels)
- https://modal.com/docs/guide/security (gVisor statement)
- https://www.daytona.io/docs/en/getting-started/ (TS SDK, runtime classes, lifecycle automation)
- https://vercel.com/docs/vercel-sandbox and https://vercel.com/docs/sandbox/sdk-reference (create params, NetworkPolicy, persistence)
- https://developers.cloudflare.com/sandbox/ (SDK API, Workers/DO architecture)
- https://docs.deno.com/runtime/fundamentals/security/ (permission flags, deny overrides, bypass caveats)
- https://gvisor.dev/docs/ (Sentry/Gofer/runsc architecture)
- https://firejail.wordpress.com/ (namespaces + seccomp, Linux-only scope)
- https://github.com/apple/container (lightweight VM per container, macOS 26, Apple silicon)
- https://docs.langchain.com/oss/python/deepagents/sandboxes (SandboxBackendProtocol, execute(), wrapper class names)
- https://www.langchain.com/blog/the-two-patterns-by-which-agents-connect-sandboxes (agent-in-sandbox vs sandbox-as-tool tradeoffs)
