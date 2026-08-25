# 02-workspace-isolation: Filesystem and OS isolation techniques for parallel runs, with costs

Wave 05, dimension 02. Written 2026-08-25.
Premise: RFA residents share one pack directory per agent (the SDK session's cwd), with git-cloned knowledge under it, and the wave asks how runs that may write can execute in parallel without corrupting that shared tree. Repo read at commit 50f538d.
Method: primary sources (kernel docs, git docs, man pages, four papers downloaded and read as PDFs, one measurement run on this machine 2026-08-25). All web sources fetched 2026-08-25.

---

## Verdict

**The ladder's rung 4 is unenforceable as written and rung 5 names the wrong mechanism. Rung 4 says the per-run scratch dir is "enforced by routing Write/Edit through canUseTool with a path guard", but the repo's own hard-won rule is that harness built-ins never reach `canUseTool` (src/posture.ts:38-47, src/resident.ts:608-617, and CLAUDE.md's three-doors rule): a pack that declares Write gets it in the SDK base set and the pre-allowed list, and the callback is never consulted. The enforcement primitive that does work at OS level on BOTH platforms is already a dependency of this repo and is wired to nothing: `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux) sits in package.json:38 and src/execbackend.ts:66-77 as `SrtLocalBackend`, and no file imports it. Rung 5 says "copy-on-write workspace per run (git worktree, since knowledge is already git)", but a git worktree materializes only tracked files, and nearly everything a run touches in a pack is deliberately untracked: knowledge clones, `agents/*/state/`, `.rfa/` are all gitignored by the hub template (src/cli/commands/init.ts:46, src/migrate.ts:210). A worktree of the hub repo is therefore an almost empty shell, and a run that instead mutates a knowledge clone in place breaks the next `git pull --ff-only` sync (src/knowledge-sources.ts:93). The cheap, cross-platform, correct-by-construction workspace copy is a filesystem CoW clone of the pack directory (`cp -c` on APFS, `cp --reflink` on btrfs/XFS, plain copy fallback on ext4), measured at 1.45 s for a 9,721-file / 457 MB tree on this machine, with knowledge clones mounted or declared read-only and merge-back running through git only for the tracked subset. Containers and microVMs are a per-run tax of roughly 0.5 s (warm Linux Docker) to 1.9 s (macOS Docker Desktop) and belong to the untrusted-code tier, not to workspace isolation; gVisor is disqualified for agent workloads (syscall-heavy is its measured worst case, 2.8x to 216x slower, and it is Linux-only).**

## Recommendations

| # | Recommendation | Verdict | Effort | Spec impact |
|---|---|---|---|---|
| 1 | Enforce the per-run scratch write boundary at OS level: wire the already-vendored sandbox-runtime around the resident's session (allowWrite: the run's scratch dir plus `/memories` mediation; denyWrite: pack dir, knowledge clones, `.rfa/`), instead of a `canUseTool` path guard | DECIDED (rung 4's stated mechanism cannot work; see section 5) | days | RFA-0.4 sect 3.12 gains a fourth door: the OS sandbox as the write fence; `sandbox.isolation` stops being schema-only |
| 2 | Rung 5's per-run workspace is a CoW clone of the pack dir, not a git worktree: `cp -c -R` on APFS, `cp -r --reflink=auto` on Linux, plain copy as ext4 fallback; knowledge clones are excluded and exposed read-only | DECIDED (worktrees materialize none of the pack's untracked state; measured clone cost is 1-9 s for large trees, section 2-3) | days | RFA-0.4 sect 6: define the run workspace as a clone with an explicit read-only knowledge view |
| 3 | Knowledge clones are read-only inputs to every run, on every rung: a run must never write inside `knowledge/*-clone/` because sync is `git pull --ff-only` and a dirty or diverged clone wedges it | DECIDED | hours (deny-path in rec 1's policy) | RFA-0.4 knowledge section: one sentence, "runs MUST NOT write under knowledge clones" |
| 4 | Merge-back is git only for git-tracked output: run writes land in the clone, a publish step `git add`s the tracked subset on a per-run branch and merges; untracked outputs move by atomic rename into their destination. Never rsync a live pack dir | DECIDED (git merge has first-class crash state, MERGE_HEAD plus `git merge --abort`; rsync is per-file atomic at best, section 6) | days | RFA-0.4 sect 6 run-completion contract |
| 5 | Any last-writer-wins path (memory files, scratch promotion) must keep the losing write as a named conflict file, Syncthing-style, never silently discard it | DECIDED (industry floor: Syncthing renames the loser `.sync-conflict-<date>-<time>-<modifiedBy>` with deterministic tie-breaking) | hours | RFA-0.4 memory section: conflict-file naming rule |
| 6 | Crash recovery contract: scratch/clone dirs are keyed by runId and prunable by a sweeper (the `git worktree prune` model); a half-finished publish is detectable (MERGE_HEAD present, or a `.publish-<runId>.tmp` left behind) and is rolled back, never resumed blind | DECIDED | days | RFA-0.4 sect 6: workspace lifecycle states |
| 7 | Containers for runs: PARKED, trigger "a pack executes code from outside the org's trust boundary (remote-supplied tasks running arbitrary Bash, or evals over untrusted repos)". Per-run cost is 0.55 s warm on Linux SSD and 1.5-1.9 s on macOS Docker Desktop plus a 2.69x virtualization tax; Apple's `container` (one lightweight VM per container, macOS 15+) is the macOS path when triggered | PARKED | - | RFA-0.4 sect 6 Tier 2 stays deferred, now with a named trigger and measured costs |
| 8 | gVisor as the run sandbox | REJECTED (Linux-only; measured 2.8x-216x penalties land exactly on agent workloads: syscalls, small file opens, process churn. Reopen only if RFA ever hosts hostile multi-tenant code on Linux and Firecracker is unavailable) | - | None |
| 9 | Firecracker microVMs per run | REJECTED for workspace isolation, noted for a future Linux-only hostile tier (needs KVM, so Linux hosts only; boots <125 ms which beats Docker, but the fleet is macOS and Linux and the snapshot-restore identity hazards are real). Reopen with rec 7's trigger on Linux-only deployments | - | None |
| 10 | overlayfs as the cross-platform workspace mechanism | REJECTED as baseline (Linux-only; unprivileged mounts need kernel 5.11+ with userxattr; measured sequential-write collapse to 0.006-0.010x of volume speed under copy-up). Fine as an internal detail of rec 7's Linux containers | - | None |
| 11 | Nesting rule: never assume an inner sandbox works inside an outer one; detect and refuse loudly instead of degrading silently (Bazel silently falls back to its weakest sandbox inside Docker; sandbox-exec cannot run inside an already-sandboxed process) | DECIDED (applies the moment rec 1 lands and an operator runs the hub itself inside Docker) | hours | RFA-0.6 containment note |
| 12 | A FUSE view filesystem for instant workspace assembly | REJECTED (Bazel archived sandboxfs on 2026-06-19, last release April 2020; symlink forests and clones won in practice) | - | None |

---

## 1. What RFA's workspace actually is (repo ground truth, commit 50f538d)

- The pack directory is the SDK session cwd (src/resident.ts:590), chosen deliberately so MCP roots never expose the hub root (comment at src/resident.ts:584-589, found live 2026-08-23).
- Knowledge sources are shallow git clones (`--depth 50`) at `agents/<pack>/knowledge/<name>-clone/` (src/knowledge-sources.ts:6-9, 89), synced by `git pull --ff-only` (src/knowledge-sources.ts:93). A run that commits, dirties, or rewrites inside a clone breaks the next sync: ff-only pull fails on divergence, and untracked droppings shadow upstream files.
- The hub directory template gitignores `.rfa/`, `agents/*/state/`, and knowledge clones (src/cli/commands/init.ts:46 default `.rfa/\nagents/*/state/\n`; src/migrate.ts:210 writes the fuller template). So the mutable surfaces of a pack are, by design, exactly the parts git does not track.
- The pack schema already reserves `sandbox.isolation: none | worktree | container` (src/agentdef.ts:111, spec RFA-0.4 line 70) but nothing reads it: the only hits are the schema, a scaffold comment, and a doc string. It is schema-only today.
- The OS sandbox exists as an unwired backend: `@anthropic-ai/sandbox-runtime` ^0.0.73 (package.json:38), `SrtLocalBackend` with a filesystem allowWrite/denyWrite policy vocabulary (src/execbackend.ts:52-77). Grep on 2026-08-25: no file outside execbackend.ts imports any of it. The file's own header records the 2026-08-16 spike findings: `allowLocalBinding=true` opens all loopback ports, and "srt is a blast-radius reducer, not a hostile-code boundary".

## 2. Git worktrees: semantics, cost, and why rung 5 misfires

Semantics (git-scm.com/docs/git-worktree, fetched 2026-08-25): worktrees share the object database and all refs except per-worktree `HEAD`, `index`, `refs/bisect`, `refs/worktree`, `refs/rewritten`. `add` refuses to check out a branch already checked out in another worktree unless forced, which is exactly the per-run-branch discipline rung 5 wants and it comes free. Crash cleanup is first-class: a worktree directory deleted without `git worktree remove` leaves admin files that `git worktree prune` or `gc.worktreePruneExpire` collect, and `git worktree lock` protects trees on removable media. This prune model is worth copying for scratch dirs (rec 6) even though the worktree itself is not the right tool here.

Submodules: the docs' own BUGS section says "Multiple checkout in general is still experimental, and the support for submodules is incomplete. It is NOT recommended to make multiple checkouts of a superproject." Worktrees containing submodules cannot be moved and need `--force` to remove. RFA's knowledge clones are NOT submodules, they are gitignored nested repos, which lands on the other horn: a fresh worktree simply does not contain them at all.

That is the decisive point. A worktree checkout materializes tracked files only. In an RFA pack the tracked files are the definition, prompt, and any versioned docs; the knowledge clones, state, and runtime dirs are untracked by design (section 1). Practitioner guidance for worktree-per-agent flows (augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution, fetched 2026-08-25) confirms the dominant cost is re-materializing untracked state (`.env`, `node_modules`), with bootstrap scripts, prewarmed worktree pools, and copy hooks existing precisely because of it; its own suggested fallback for heavy state is APFS `cp -c`. Worktree creation itself is "seconds (checkout only)".

Verdict for RFA: worktrees are a fine merge-back discipline (branch per run, conflicts explicit at integration) but a wrong workspace-materialization mechanism for packs whose bulk is untracked. Use the clone (section 3) for the bytes and git for the tracked subset's history.

## 3. Copy-on-write clones: APFS and Linux reflink, with measured costs

APFS (macOS): `cp -c` calls clonefile(2); "Subsequent writes to either the original or cloned file are private to the file being modified (copy-on-write)" and for directories "the directory hierarchy is cloned as if each item was cloned individually. However, the use of clonefile(2) to clone directory hierarchies is strongly discouraged. Use copyfile(3) instead" (man clonefile, macOS 25.5.0, read 2026-08-25; the per-file behavior and the kernel-panic risk of directory clonefile are also covered at mjtsai.com/blog/2026/05/14/apfs-folder-clones/, fetched 2026-08-25). So a tree clone is O(file count), not O(1) and not O(bytes).

Measured on this machine (2026-08-25, APFS, M-series, warm cache): `cp -c -R` of `node_modules` (9,721 files, 457 MB) took 1.45 s; a plain `cp -R` of the same tree took 3.71 s. Roughly 6,700 files/s cloned, near-zero extra space, and divergence is lazy per file. Extrapolated, a 100k-file pack workspace clones in roughly 15 s, which argues for excluding knowledge clones from the per-run copy (they are read-only inputs anyway, rec 3) so the cloned surface stays in the low thousands of files and well under a second.

Linux reflink: btrfs and XFS support `cp --reflink` sharing extents with independent metadata (btrfs.readthedocs.io/en/latest/Reflink.html); ext4 does not, so the portable invocation is `--reflink=auto` with a real-copy fallback. Measured tree-copy number in the wild: `cp -r --reflink=always` of 1.7 GB across 116,000 files took 8.49 s on loopback XFS, and a 4-way parallel implementation cut it to 3.28 s (tunbury.org/2025/07/15/reflink-copy/, fetched 2026-08-25): metadata traversal dominates, bytes are free.

The deeper cost model ("How to Not Copy Files", USENIX ;login: Fall 2020, Zhan et al., read from papers/how-to-not-copy-files-login20.pdf): all production CoW clones sit on a granularity trade-off; after a clone-then-small-write workload, XFS grep time nearly doubles after six clone rounds and btrfs read performance degrades about 20% (50% after 17 rounds), so repeated clone-modify cycles slowly shred locality (pp. 14-15). Its container-cloning table (Table 2, p. 15) is the cleanest published cost spread for exactly RFA's shape: cloning an Ubuntu LXC container via rsync-onto-ext4 takes 19.514 s, versus 0.396 s as a btrfs subvolume clone and 0.478 s as a ZFS clone. CoW clones beat directory copies by up to two orders of magnitude, and nothing beats them but a research filesystem (BetrFS, 0.118 s).

RFA consequence: per-run pack workspaces via CoW clone cost well under a second on both macOS (APFS is the default filesystem) and Linux-with-btrfs/XFS, and degrade gracefully to a plain copy on ext4. This is rung 5's mechanism, with git kept for merge-back only (rec 2, 4).

## 4. overlayfs and bind mounts (Linux only)

overlayfs gives a writable upper over a read-only lower with near-native access after open ("future operations on the file are barely noticed"), requires workdir empty and on the same filesystem as upperdir, and copy-up is metadata-plus-data per first write (docs.kernel.org/filesystems/overlayfs.html, fetched 2026-08-25). Unprivileged (user-namespace) mounts require kernel 5.11+ with the `userxattr` option (containerd PR 5076: "The 'userxattr' option is needed for mounting overlayfs inside a user namespace with kernel >= 5.11", fetched 2026-08-25). It does not exist on macOS, which alone disqualifies it as RFA's baseline (hubs run on both, CLAUDE.md audience rule).

Measured copy-up cost is not hypothetical: the 2026 three-tier Docker study (papers/docker-startup-three-tier.pdf, arXiv:2602.15214, read in full) found OverlayFS sequential 256 MB writes collapse to 0.006-0.010x of volume-mount speed on Azure SSD/HDD because every write triggers copy-up converting sequential to random I/O, while metadata operations (500-file creation) run 1.3-4.8x FASTER on OverlayFS than volume mounts (Tables 4, sect 4.3, 5.2). An agent run that writes large artifacts inside an overlay pays two orders of magnitude on the write path.

Bind-mount footgun for the exact pack shape: a read-only bind mount is not recursive by default, so a mount under a read-only tree stays writable; Kubernetes only added `recursiveReadOnly` (via `mount_setattr` with `AT_RECURSIVE`, kernel 5.12+) in v1.30, April 2024, alpha (kubernetes.io/blog/2024/04/23/recursive-read-only-mounts/, fetched 2026-08-25). A pack dir mounted read-only with knowledge or scratch mounted inside it is precisely this shape.

## 5. Sandboxes: the write fence that actually works on both OSes

Why rung 4's mechanism fails: `canUseTool` is consulted for MCP tools; harness built-ins never reach it. This is not a research claim, it is the repo's own three-mechanism doctrine, written down after live incidents (src/posture.ts:38-47: "canUseTool is not consulted for harness-internal tools, so a fence that relies on the callback is not a fence for them at all"; src/resident.ts:608-617; CLAUDE.md). A pack that declares Write/Edit puts them in `posture.builtins` and `posture.allowedTools` (src/posture.ts:49-51, 89-107), so the SDK executes them without any per-path check. A scratch-dir boundary "enforced by routing Write/Edit through canUseTool" therefore enforces nothing for exactly the packs it exists for.

What works instead, per platform:

- Linux primitive: bubblewrap assembles a fresh tmpfs root from bind mounts inside an unprivileged user namespace, supports `--ro-bind`, tears down when the last process exits, and is what Flatpak builds on (github.com/containers/bubblewrap, fetched 2026-08-25). Linux-only. The kernel primitives are cheap: namespace creation measured at ~8 ms, under 1.5% of container startup (docker-startup-three-tier.pdf sect 4.2.1), so a per-run bubblewrap wrapper costs milliseconds, not the ~550 ms of a Docker container.
- macOS primitive: `sandbox-exec`/Seatbelt profiles. Deprecated by Apple with no committed replacement, yet it is what Bazel's darwin-sandbox uses (bazel.build/docs/sandboxing) and what Nix rides on Darwin, where the sandbox is off by default (`sandbox = false` on macOS vs `true` on Linux, nix.dev/manual/nix/2.23/command-ref/conf-file.html, fetched 2026-08-25). The macOS/Linux isolation asymmetry RFA faces is the same one every build tool lives with.
- The cross-platform wrapper that is ALREADY IN THIS REPO: Anthropic's sandbox-runtime uses dynamically generated Seatbelt profiles on macOS and bubblewrap plus a socat proxy with seccomp on Linux; write access is deny-by-default allow-list, network is deny-by-default domain allow-list (github.com/anthropic-experimental/sandbox-runtime, fetched 2026-08-25). RFA vendors it (package.json:38) with a typed policy (src/execbackend.ts:52-64) and uses it nowhere. Rec 1 is mostly wiring, not building. Two limits carry over from the repo's own spike notes: `allowLocalBinding=true` opens all loopback ports (mitigated by room join secrets), and srt is a blast-radius reducer, not a hostile-code boundary (src/execbackend.ts:9-15).

Nesting is the trap to write down now (rec 11): Bazel documents that linux-sandbox cannot run inside an unprivileged Docker container and sandbox-exec cannot run inside an already-sandboxed process, and that it then "automatically falls back to using processwrapper-sandbox", silently weakening isolation (bazel.build/docs/sandboxing, fetched 2026-08-25). An RFA hub run inside Docker would silently lose rec 1's fence the same way unless the resident detects the failure and refuses loudly.

Negative result on the exotic alternative: Bazel's sandboxfs, the FUSE approach to instant arbitrary workspace views, was archived 2026-06-19 with its last release 0.2.0 on 2020-04-20 (github.com/bazelbuild/sandboxfs, fetched 2026-08-25). Symlink forests and clones won. RFA should not build a view filesystem (rec 12).

## 6. Containers and microVMs: measured startup and overhead

Linux containers (docker-startup-three-tier.pdf, arXiv:2602.15214v1, single-author preprint, February 2026, read in full; treat as indicative, n=50 per cell with CIs): warm-start latency is 554-568 ms on Azure Premium SSD across images from 5 MB to 155 MB (only 2.5% variation: runtime overhead dominates, image size is irrelevant), 1157-1334 ms on HDD (2.04x), 1528-1859 ms on macOS Docker Desktop. Docker Desktop's hypervisor tax is 2.69x startup and 9.5x higher CPU-throttling variance, making macOS Docker both the slowest and the least predictable tier. Note: the wave scout attributed "runc 350 ms vs gVisor 656 ms" to this paper; those numbers are NOT in it, and the claim should be dropped.

gVisor (papers/gvisor-true-cost-hotcloud19.pdf, HotCloud 2019, read in full): syscalls at least 2.2x slower than runc; `gettimeofday` native 0.22 us, runc 0.29 us, gVisor Sentry-on-KVM 0.63 us (2.8x native), via Gofer 45.5 us; ptrace mode 42-232x slower (pp. 2-3, Fig 3). Opening/closing a file on an external tmpfs is 216x slower (518 us vs 2.04 us native, Fig 6); reading small files 11x slower; container create/destroy 1.117 s (KVM) vs 1.014 s for runc (sect 3.1). Agent runs are exactly the worst case: Bash spawning, many small file opens, module imports (Python imports measured 2-4x slower, sect 3.6). gVisor's platforms (systrap, KVM) are Linux kernel features; no macOS support exists (gvisor.dev/docs/architecture_guide/platforms/, fetched 2026-08-25). REJECTED (rec 8).

Firecracker (papers/firecracker-nsdi20.pdf, NSDI 2020, read pp. 419-420): "it offers memory overhead of less than 5MB per container, boots to application code in less than 125ms, and allows creation of up to 150 MicroVMs per second per host" (p. 420); Firecracker keeps KVM and replaces QEMU, so it requires KVM, hence Linux hosts. Snapshot restore maps the memory file MAP_PRIVATE with on-demand paging; the official docs publish no restore-latency number and carry a hard warning that resuming one snapshot into multiple VMs duplicates entropy, tokens, and identifiers unless VMGenID-style reseeding is handled (firecracker snapshot-support.md, fetched 2026-08-25). For RFA that identity hazard maps directly onto agent identity: two VMs resumed from one snapshot would share nonces and any cached credential state.

macOS microVM path: Apple's `container` runs one lightweight VM per container on Virtualization.framework with a minimal init (vminitd); boot "comparable to containers running in a shared VM", requires macOS 15 minimum with real limitations before macOS 26 (no container-to-container networking on 15; freed guest memory not reclaimed by the host) (github.com/apple/container technical-overview, fetched 2026-08-25). Viable when rec 7 triggers, immature today.

Cross-check (papers/blending-containers-vee20.pdf, VEE 2020, read pp. 1-2): despite moving functionality out of the host kernel, both gVisor and Firecracker execute MORE host kernel code than native Linux, and "neither gVisor nor Firecracker are best of all workloads; Firecracker has high network latency while gVisor is slower for memory management and network streaming". There is no free strong-isolation tier; pick per threat model, which for RFA means rec 7's trigger, not a default.

Cost ladder, one line each (per-run setup on the workspace axis):
namespaces/bubblewrap ~8 ms; APFS/btrfs CoW clone of a small pack ~0.1-1.5 s (file-count bound); XFS reflink of a huge tree ~8.5 s; warm Docker on Linux SSD ~0.55 s; warm Docker on macOS ~1.5-1.9 s; Firecracker boot <125 ms (Linux/KVM only); gVisor adds 2.8x-216x on syscall/file paths after start.

## 7. Merge-back and crash recovery

Git merge-back is the only strategy in this survey with first-class interrupted-state semantics: an in-progress merge is marked by MERGE_HEAD, conflicting paths hold three staged versions, and `git merge --abort` "attempts to reconstruct the pre-merge state", with the documented caveat that it can fail when the merge started over uncommitted changes, so the publish step must start from a clean tree (git-scm.com/docs/git-merge, fetched 2026-08-25). That caveat is the crash-recovery rule for rec 4: commit the run's output on its branch first, merge second; a crash mid-merge is then always abortable and the workspace clone is disposable by construction.

rsync merge-back is per-file atomic at best (temp file plus rename), has no multi-file transaction, and leaves temp droppings after a crash; there is no equivalent of MERGE_HEAD to even detect a half-merge. A half-rsynced pack dir is silently inconsistent. Rejected as the mechanism for shared-tree publication (rec 4); rsync remains fine for one-way export to a destination nothing else writes.

Patch queues (format-patch/am or stgit-style) are a niche middle: they give explicit, sequenced, reviewable deltas and idempotent re-application, at the price of failing on any context drift. For RFA they are the natural shape for REMOTE runs proposing changes across trust boundaries (the diff is the interop artifact), not for local merge-back where a branch is cheaper.

Last-writer-wins: the production floor is that the loser is never silently discarded. Syncthing renames the losing file `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`, older mtime loses, ties broken by device ID comparison, and conflict files propagate so every replica sees the same resolution (docs.syncthing.net/users/syncing.html, fetched 2026-08-25). Any RFA LWW path, and the /memories store is the obvious one, must meet that floor (rec 5).

Prior art for the whole rung-5 shape: Dagger's container-use gives each agent a fresh container plus its own git branch, work is inspected with `git log --patch` and integrated with an ordinary merge, making conflicts explicit and sequential at integration time (dagger.io/blog/agent-container-use/, fetched 2026-08-25). That validates the ladder's merge-at-completion discipline while showing the container part is separable: the git-branch-per-run half stands alone, which is exactly what rec 2 plus rec 4 keep.

Crash recovery summary (rec 6): (a) workspace clones and scratch dirs are keyed by runId and swept by a pruner, copying git's worktree-prune model of "deleted dir leaves only admin state, collected later"; (b) publication is either a git merge (abortable, MERGE_HEAD-detectable) or an atomic rename (crash leaves only a `.tmp` to delete); (c) after any crash the invariant is "the shared tree is either pre-publish or post-publish, never between", and the run is retried from its still-intact clone or discarded whole.

## 8. Where each mechanism runs

| Mechanism | macOS | Linux | Per-run setup cost (measured) |
|---|---|---|---|
| git worktree | yes | yes | seconds, checkout only; untracked state extra (sect 2) |
| APFS clonefile / cp -c | yes | no | 1.45 s per 9,721 files / 457 MB (this machine, 2026-08-25) |
| btrfs/XFS reflink | no | yes (not ext4) | 8.49 s per 116k files / 1.7 GB (XFS loopback) |
| overlayfs | no | yes (userxattr needs 5.11+) | mount is fast; writes pay copy-up (0.006-0.010x volume speed) |
| bind mounts (recursive ro) | no (different mount model) | yes (mount_setattr, 5.12+) | ms |
| bubblewrap | no | yes | ~ms (namespace creation ~8 ms) |
| sandbox-exec / Seatbelt | yes (deprecated, universal in practice) | no | ~ms |
| sandbox-runtime (srt) | yes (Seatbelt) | yes (bubblewrap) | ~ms; already in package.json |
| Docker containers | via VM (2.69x tax) | yes | 0.55 s warm SSD Linux; 1.5-1.9 s macOS DD |
| Apple container (VM per container) | yes, macOS 15+/26 | no | "comparable to shared-VM containers", unbenchmarked |
| gVisor | no | yes | 1.117 s create/destroy + heavy runtime tax |
| Firecracker | no | yes (KVM) | <125 ms boot, <5 MiB overhead |

The only rows green in both columns at millisecond cost are srt and plain git; the only sub-second whole-tree copy on both is a CoW clone with per-OS invocation. That pair (srt fence + CoW clone + git merge-back) is the cross-platform floor, and it is why recs 1, 2, 4 fit together.

## What this dimension could not verify

Firecracker snapshot-restore latency has no number in the official docs (they explicitly defer to memory size and device count), so the scout's "~28 ms production restore" stays UNVERIFIED and was not used. The scout's "runc 350 ms vs gVisor 656 ms cold start" attributed to arXiv:2602.15214 is not in that paper and was dropped. The Eclectic Light APFS primer returned HTTP 403 on 2026-08-25; APFS clone semantics were verified against the local clonefile(2) man page and the mjtsai post instead. The claim that Codex and Claude Code use Seatbelt/bubblewrap specifically was not independently verified beyond Anthropic's own sandbox-runtime README and was kept out of the load-bearing chain. Nix's Darwin sandbox mechanism (profile-based) is asserted by community sources; the 2.23 manual page verified only the defaults (off on Darwin, on on Linux), so the note claims no more than that. The docker-startup study is a single-author arXiv preprint, not peer-reviewed; its numbers are used with that caveat and only where consistent with the peer-reviewed HotCloud/NSDI papers. Whether the Claude Agent SDK would consult canUseTool for a built-in Write that is absent from allowedTools was not tested live in this dimension; the note relies on the repo's own documented incident findings (src/posture.ts:38-47), and a 30-minute live probe would settle it and is worth doing before rec 1's design review.

## Sources

- git worktree docs, https://git-scm.com/docs/git-worktree (fetched 2026-08-25)
- git merge docs, https://git-scm.com/docs/git-merge (fetched 2026-08-25)
- clonefile(2) man page, macOS 25.5.0 (read locally 2026-08-25)
- Michael Tsai, APFS Folder Clones, https://mjtsai.com/blog/2026/05/14/apfs-folder-clones/ (fetched 2026-08-25)
- Tunbury, Reflink Copy, https://www.tunbury.org/2025/07/15/reflink-copy/ (fetched 2026-08-25)
- btrfs Reflink docs, https://btrfs.readthedocs.io/en/latest/Reflink.html
- Zhan et al., How to Not Copy Files, USENIX ;login: Fall 2020 (papers/how-to-not-copy-files-login20.pdf)
- Linux overlayfs docs, https://docs.kernel.org/filesystems/overlayfs.html (fetched 2026-08-25)
- containerd PR 5076 (userxattr, kernel 5.11), https://github.com/containerd/containerd/pull/5076 (fetched 2026-08-25)
- Agache et al., Firecracker, NSDI 2020 (papers/firecracker-nsdi20.pdf)
- Firecracker snapshot support docs, https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md (fetched 2026-08-25)
- Young et al., The True Cost of Containing, HotCloud 2019 (papers/gvisor-true-cost-hotcloud19.pdf)
- Anjali et al., Blending Containers and Virtual Machines, VEE 2020 (papers/blending-containers-vee20.pdf)
- Khan, Decomposing Docker Container Startup Performance, arXiv:2602.15214 (papers/docker-startup-three-tier.pdf)
- gVisor performance and platform guides, https://gvisor.dev/docs/architecture_guide/performance/ and /platforms/ (fetched 2026-08-25)
- Bazel sandboxing docs, https://bazel.build/docs/sandboxing (fetched 2026-08-25)
- bazelbuild/sandboxfs (archived 2026-06-19), https://github.com/bazelbuild/sandboxfs (fetched 2026-08-25)
- Nix manual 2.23, sandbox setting, https://nix.dev/manual/nix/2.23/command-ref/conf-file.html (fetched 2026-08-25)
- containers/bubblewrap, https://github.com/containers/bubblewrap (fetched 2026-08-25)
- anthropic-experimental/sandbox-runtime, https://github.com/anthropic-experimental/sandbox-runtime (fetched 2026-08-25)
- apple/container technical overview, https://github.com/apple/container/blob/main/docs/technical-overview.md (fetched 2026-08-25)
- Kubernetes recursive read-only mounts, https://kubernetes.io/blog/2024/04/23/recursive-read-only-mounts/ (fetched 2026-08-25)
- Syncthing syncing docs, https://docs.syncthing.net/users/syncing.html (fetched 2026-08-25)
- Dagger container-use, https://dagger.io/blog/agent-container-use/ (fetched 2026-08-25)
- Augment Code, Git Worktrees for Parallel AI Agent Execution, https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution (fetched 2026-08-25)
- Local measurement 2026-08-25: cp -c -R vs cp -R of node_modules (9,721 files, 457 MB) on this repo's APFS volume: 1.45 s vs 3.71 s
