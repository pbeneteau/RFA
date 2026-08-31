/**
 * The hub directory (RFA-0.7 sect. 2): the ONE module allowed to join a path
 * onto an operator's directory.
 *
 * Before this module every entrypoint resolved its paths from
 * `path.resolve(import.meta.dirname, "..")`, which made the repository checkout
 * the instance: `agents/`, `data/`, `dogfood/ROOM.md` and `deploy/gate.json`
 * lived beside `src/`, and the way an organization got a hub was `git clone`
 * plus four shell incantations. A hub directory is any folder holding
 * `rfa.json`; the tool finds it the way git finds a repository (walk up from
 * the working directory), or is told (`--dir`, `RFA_DIR`).
 *
 * Everything under the directory is named here, once, as an absolute path.
 * `test/hubdir.test.ts` greps `src/` for the old string joins so a path cannot
 * quietly grow back somewhere else.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as z from "zod";

/**
 * The effective account concurrency default (RFA-0.8 sect. 5 item 8), owned
 * HERE because the supervisor writes the ledger's cap from this manifest field
 * and that is what makes it effective. `src/account.ts` imports it; its own
 * `UNSUPERVISED_CAP` is a different fact about a different setup (no supervisor,
 * therefore no sweep either), not a second opinion about this one.
 */
export const EFFECTIVE_DEFAULT_CAP = 2;

/**
 * The hub's chosen `cross_home_reply_by_default_s` (wire section 8, 0.1.9).
 * Declared here so the manifest schema does not import the store (and with it
 * the whole hub) into every CLI path; `src/store.ts` carries the reasoning for
 * the number beside the value it defaults to.
 */
export const CROSS_HOME_REPLY_BY_DEFAULT_S = 600;

export const MANIFEST_FILE = "rfa.json";
export const MANIFEST_VERSION = 1;

// ---------------------------------------------------------------- manifest

const localHubSchema = z
  .object({
    /** This directory RUNS a hub on this port. Mutually exclusive with `url`. */
    port: z.number().int().min(1).max(65535),
    /** Loopback stays the default (v0.5 sect. 15.1): reach it through a proxy, not by widening this. */
    bind: z.string().min(1).default("127.0.0.1"),
    /** The public base URL in front of the loopback listener: console links, push links, the Origin allowlist. */
    public_url: z.url().nullable().default(null),
    /** Extra browser origins allowed to POST; `public_url`'s origin is added automatically. */
    allow_origins: z.array(z.url()).default([]),
    otel: z.boolean().default(true),
    /** The pre-delivery policy gate (spec 12.2), relative to the directory; null disables it. */
    gate: z.string().nullable().default("policies/gate.json"),
    require_signed_cards: z.boolean().default(false),
    /** kid -> public JWK map for card verification, relative to the directory. */
    trusted_keys: z.string().nullable().default(null),
    /** Notification-only push (v0.5 sect. 17.3). The URL is not a secret: it carries a title and a link, never a credential. */
    push_url: z.url().nullable().default(null),
    /**
     * The bounded default `reply_by` the hub stamps on a `request` crossing a
     * `home` boundary when the sender omits one (wire section 8 and Appendix B,
     * 0.1.9: `cross_home_reply_by_default_s`, a knob the wire spec names and
     * deliberately leaves unnumbered). 0 disables it. The reasoning behind 600
     * is in `DEFAULT_CONFIG` in `src/store.ts`, beside the value.
     */
    cross_home_reply_by_default_s: z.number().int().min(0).max(86_400).default(CROSS_HOME_REPLY_BY_DEFAULT_S),
  })
  .strict();

const remoteHubSchema = z
  .object({
    /** This directory hosts agents for a hub that runs ELSEWHERE: the far hub's /mcp URL. */
    url: z.url(),
  })
  .strict();

export const manifestSchema = z
  .object({
    rfa: z.literal(MANIFEST_VERSION),
    /** Names the instance: process titles, the backup folder, the service label. Same grammar as a wire `home`. */
    name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/, "lowercase letters, digits, dots and hyphens; must start with a letter or digit"),
    hub: z.union([localHubSchema, remoteHubSchema]),
    agents: z
      .object({
        dir: z.string().default("agents"),
        /**
         * The account layer's cap on model turns in flight (spec 18.6). The
         * default is `EFFECTIVE_DEFAULT_CAP` from `src/account.ts` rather than a
         * literal, so the effective default standardized by RFA-0.8 sect. 5
         * item 8 is written down exactly once.
         */
        max_inflight: z.number().int().min(1).default(EFFECTIVE_DEFAULT_CAP),
        /**
         * What a resident inherits from the supervisor's environment. `minimal`
         * is v0.4 sect. 6.3 as written (declared secrets plus what the model
         * provider's CLI needs); `inherit` is the pre-0.7 behaviour, kept as an
         * escape hatch for a provider setup the allowlist did not anticipate.
         */
        env: z.enum(["minimal", "inherit"]).default("minimal"),
      })
      .strict()
      .prefault({}),
    retention: z
      .object({
        obs_days: z.number().int().min(1).default(14),
        backup_keep: z.number().int().min(1).default(7),
        /** Outside the directory on purpose: a backup inside the thing backed up is not one. `<name>` expands to the instance name. */
        backup_dir: z.string().default("~/Backups/rfa/<name>"),
      })
      .strict()
      .prefault({}),
    paths: z
      .object({
        /** Where the tool keeps runtime state, relative to the directory. */
        runtime: z.string().default(".rfa"),
      })
      .strict()
      .prefault({}),
    /**
     * Operator gateway processes the supervisor runs beside the residents
     * (added 2026-08-31). A gateway is infrastructure a pack reaches as a
     * `url`-form MCP server but the OPERATOR owns: the measured case is a
     * read-only Postgres->MCP HTTP bridge, needed because the OS sandbox
     * refuses raw TCP outright, so no pack process can speak to a database
     * directly. Before this section the only options were a hand-rolled nohup
     * (dies on reboot, nothing restarts it) or a launchd/systemd unit per
     * gateway; the supervisor already restarts, drains and logs things, so it
     * runs these too.
     *
     * `command` + `args` spawn through src/proc.ts (own process group, tree
     * kill). `env_secrets` are NAMES resolved from `.rfa/secrets.json` at
     * spawn, the same contract packs get - values never sit in this file.
     * `cwd` is relative to the hub directory.
     */
    gateways: z
      .record(
        z.string().regex(/^[a-z0-9_-]+$/, "a gateway name: lowercase letters, digits, underscore, hyphen"),
        z
          .object({
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
            env: z.record(z.string(), z.string()).default({}),
            env_secrets: z.array(z.string()).default([]),
            cwd: z.string().optional(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;
export type LocalHubConfig = z.infer<typeof localHubSchema>;

/** The manifest a fresh `rfa init` writes, before the operator touches it. */
export function defaultManifest(opts: { name: string; port?: number; url?: string }): Manifest {
  const hub = opts.url ? { url: opts.url } : { port: opts.port ?? 8790 };
  return manifestSchema.parse({ rfa: MANIFEST_VERSION, name: opts.name, hub });
}

// ---------------------------------------------------------------- paths

export interface HubPaths {
  root: string;
  manifest: string;
  gitignore: string;
  /** Operator-authored, tracked. */
  agents: string;
  policies: string;
  gate: string | null;
  trustedKeys: string | null;
  evals: string;
  evalCases: string;
  evalBaseline: string;
  evalRubric: string;
  evalParity: string;
  peers: string;
  /** Tool-owned runtime, gitignored, 0700. */
  runtime: string;
  secrets: string;
  principals: string;
  tokens: string;
  rooms: string;
  /** The CLI's last ask per room (conversation, capability, target): what `rfa ask --reply` continues. */
  lastAsk: string;
  data: string;
  roomLogs: string;
  runsDb: string;
  obsDb: string;
  authLog: string;
  supervisor: string;
  supervisorState: string;
  supervisorCommands: string;
  opsRoom: string;
  opsDigest: string;
  judgeCount: string;
  logs: string;
  hubLog: string;
  supervisorLog: string;
  run: string;
  hubPid: string;
  supervisorPid: string;
  retired: string;
  reports: string;
  backups: string;
}

export interface HubDir {
  root: string;
  manifest: Manifest;
  paths: HubPaths;
  /** `hub`: this directory runs a hub. `remote`: it hosts agents for a hub elsewhere. */
  mode: "hub" | "remote";
  /** The /mcp URL a process in this directory talks to. */
  hubUrl: string;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function pathsFor(root: string, m: Manifest): HubPaths {
  const rel = (p: string) => path.resolve(root, expandHome(p));
  const runtime = rel(m.paths.runtime);
  const data = path.join(runtime, "data");
  const supervisor = path.join(runtime, "supervisor");
  const logs = path.join(runtime, "logs");
  const run = path.join(runtime, "run");
  const evals = rel("evals");
  const hub = m.hub;
  return {
    root,
    manifest: path.join(root, MANIFEST_FILE),
    gitignore: path.join(root, ".gitignore"),
    agents: rel(m.agents.dir),
    policies: rel("policies"),
    gate: "port" in hub && hub.gate ? rel(hub.gate) : null,
    trustedKeys: "port" in hub && hub.trusted_keys ? rel(hub.trusted_keys) : null,
    evals,
    evalCases: path.join(evals, "cases"),
    evalBaseline: path.join(evals, "baseline.json"),
    evalRubric: path.join(evals, "rubric.md"),
    evalParity: path.join(evals, "parity.json"),
    peers: rel("peers"),
    runtime,
    secrets: path.join(runtime, "secrets.json"),
    principals: path.join(runtime, "principals.json"),
    tokens: path.join(runtime, "tokens.json"),
    rooms: path.join(runtime, "rooms.json"),
    lastAsk: path.join(runtime, "last-ask.json"),
    data,
    roomLogs: path.join(data, "rooms"),
    runsDb: path.join(data, "runs.db"),
    obsDb: path.join(data, "obs.db"),
    authLog: path.join(data, "auth.log.ndjson"),
    supervisor,
    supervisorState: path.join(supervisor, "state.json"),
    supervisorCommands: path.join(supervisor, "commands.ndjson"),
    opsRoom: path.join(supervisor, "ops-room.json"),
    opsDigest: path.join(supervisor, "ops-digest.json"),
    judgeCount: path.join(supervisor, "judge-count.json"),
    logs,
    hubLog: path.join(logs, "hub.log"),
    supervisorLog: path.join(logs, "supervisor.log"),
    run,
    hubPid: path.join(run, "hub.pid"),
    supervisorPid: path.join(run, "supervisor.pid"),
    retired: path.join(runtime, "retired"),
    reports: path.join(runtime, "reports"),
    backups: rel(m.retention.backup_dir.replaceAll("<name>", m.name)),
  };
}

/** The /mcp URL a process in this directory talks to. Loopback for a local hub whatever it binds: children live on the same host. */
export function hubUrlFor(m: Manifest): string {
  return "url" in m.hub ? m.hub.url : `http://127.0.0.1:${m.hub.port}/mcp`;
}

// ---------------------------------------------------------------- resolution

export class HubDirError extends Error {
  constructor(
    readonly code: "not_found" | "invalid" | "legacy",
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "HubDirError";
  }
}

/** Walk up from `start` to the first directory holding `rfa.json`, the way git finds `.git`. */
export function findHubRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where the hub directory is: an explicit `--dir` (no walk-up: the operator said
 * THIS one), then `RFA_DIR` (what every child process is told), then the walk-up
 * from the working directory. Null when nothing names one.
 */
export function resolveHubRoot(opts: { dir?: string | null; env?: NodeJS.ProcessEnv; cwd?: string } = {}): string | null {
  if (opts.dir) return path.resolve(expandHome(opts.dir));
  const fromEnv = (opts.env ?? process.env).RFA_DIR;
  if (fromEnv) return path.resolve(expandHome(fromEnv));
  return findHubRoot(opts.cwd ?? process.cwd());
}

/** Load and validate a hub directory at `root`. Throws `HubDirError` with the fix named. */
export function loadHubDir(root: string): HubDir {
  const file = path.join(root, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    const legacy = detectLegacyLayout(root);
    if (legacy) {
      throw new HubDirError(
        "legacy",
        `${root} has the pre-0.7 layout (${legacy.found.join(", ")}) and no ${MANIFEST_FILE}`,
        "run `rfa migrate --dry-run` here to see the move, then `rfa migrate`",
      );
    }
    throw new HubDirError("not_found", `${root} is not a hub directory: no ${MANIFEST_FILE}`, "run `rfa init` there, or pass --dir / set RFA_DIR");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new HubDirError("invalid", `${file} is not valid JSON: ${(err as Error).message}`, "fix the file; `rfa config show` prints what the schema expects");
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HubDirError(
      "invalid",
      `${file} is invalid at ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      "fix the file; every key is documented in spec/RFA-0.7-cli.md Appendix A",
    );
  }
  const manifest = parsed.data;
  return { root, manifest, paths: pathsFor(root, manifest), mode: "url" in manifest.hub ? "remote" : "hub", hubUrl: hubUrlFor(manifest) };
}

/** The hub directory this process runs in, or a `HubDirError` naming the fix. */
export function requireHubDir(opts: { dir?: string | null; env?: NodeJS.ProcessEnv; cwd?: string } = {}): HubDir {
  const root = resolveHubRoot(opts);
  if (!root) {
    const cwd = opts.cwd ?? process.cwd();
    const legacy = detectLegacyLayout(cwd);
    if (legacy) {
      throw new HubDirError(
        "legacy",
        `${cwd} has the pre-0.7 layout (${legacy.found.join(", ")}) and no ${MANIFEST_FILE} here or above`,
        "run `rfa migrate --dry-run` here to see the move, then `rfa migrate`",
      );
    }
    throw new HubDirError("not_found", `no ${MANIFEST_FILE} in ${cwd} or any directory above it`, "run `rfa init` in the folder that should become the hub directory, or pass --dir / set RFA_DIR");
  }
  return loadHubDir(root);
}

/**
 * Like `requireHubDir` but null when nothing names one: for the hub process,
 * which can run bare (`--data`, flags) in tests and in a pre-0.7 checkout. An
 * explicit `--dir` or `RFA_DIR` still has to BE a hub directory: naming one that
 * is not is an error, not a fall-through to bare mode.
 */
export function maybeHubDir(opts: { dir?: string | null; env?: NodeJS.ProcessEnv; cwd?: string } = {}): HubDir | null {
  const root = resolveHubRoot(opts);
  return root ? loadHubDir(root) : null;
}

/** Create the tool-owned runtime tree: `.rfa` itself is 0700, because it holds the credential files. */
export function ensureRuntime(h: HubDir): void {
  fs.mkdirSync(h.paths.runtime, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(h.paths.runtime, 0o700);
  } catch {
    /* a filesystem without modes */
  }
  for (const dir of [h.paths.data, h.paths.roomLogs, h.paths.supervisor, h.paths.logs, h.paths.run, h.paths.retired, h.paths.reports]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Write the manifest, pretty-printed, through the schema so a bad value never lands on disk. */
export function writeManifest(root: string, manifest: Manifest): void {
  const parsed = manifestSchema.parse(manifest);
  writeJsonAtomic(path.join(root, MANIFEST_FILE), parsed, 0o644);
}

// ---------------------------------------------------------------- atomic JSON stores

/**
 * Temp file, fsync, rename, fsync the directory: the discipline the room store
 * already applies to its snapshots, because a torn credential file at the moment
 * of a crash is a file the hub refuses to load.
 */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
    const dfd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* directory fsync is best effort on filesystems that refuse it */
  }
}

/** Read a JSON file, or the fallback when it does not exist. A file that exists and does not parse (or validate) is an error, never silently the fallback. */
export function readJsonFile<T>(file: string, fallback: () => T, parse?: (raw: unknown) => T): T {
  if (!fs.existsSync(file)) return fallback();
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  return parse ? parse(raw) : (raw as T);
}

export class JsonStore<T> {
  constructor(
    readonly file: string,
    private readonly empty: () => T,
    private readonly mode = 0o600,
  ) {}

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  read(): T {
    return readJsonFile(this.file, this.empty);
  }

  write(value: T): void {
    writeJsonAtomic(this.file, value, this.mode);
  }

  /** Read, mutate, write. The callback may return a new value or mutate in place. */
  update(fn: (current: T) => T | void): T {
    const current = this.read();
    const next = fn(current);
    const value = next === undefined ? current : next;
    this.write(value);
    return value;
  }
}

// ---------------------------------------------------------------- the four runtime files (RFA-0.7 Appendix B)

export interface RoomRecord {
  /** CLI sugar, never on the wire: packs bind by handle. */
  alias: string;
  handle: string;
  topic: string;
  /** The legacy admission path, for a client that cannot send a header. */
  join_secret: string | null;
  /** The operator's own membership in the room, resumed for admin verbs. Null for a room adopted without one. */
  operator: { member_id: string; membership_token: string; name: string; role: "participant" | "observer" | "supervisor"; host: boolean } | null;
  /**
   * A participant membership the CLI records to SPEAK in a room whose operator
   * membership cannot (an adopted room's operator is a supervisor, and wire
   * 12.1 gives a supervisor no voice but inject): `rfa ask`, parity and the
   * dashboard resume it instead of joining ephemerally per question.
   */
  speaker?: { member_id: string; membership_token: string; name: string } | null;
  created_at: string;
}
export interface RoomsFile {
  version: 1;
  rooms: RoomRecord[];
}

export type TokenKind = "operator" | "client" | "peer";
export interface TokenRecord {
  id: string;
  label: string;
  kind: TokenKind;
  /** Hex SHA-256 of the bearer. The plaintext never rests here. */
  sha256: string;
  created_at: string;
  expires_at: string | null;
  /** Rooms this bearer was allowed into (informational; the room's own policy is what the hub enforces). */
  rooms?: string[];
}
export interface TokensFile {
  version: 1;
  tokens: TokenRecord[];
}

export interface PrincipalRecord {
  /** `hp_` plus 12 hex, derived from the key (src/principals.ts): safe in a log. */
  id: string;
  label: string;
  /** Hex SHA-256 of the human key. The plaintext never rests here. */
  key_sha256: string;
  created_at: string;
}
export interface PrincipalsFile {
  version: 1;
  principals: PrincipalRecord[];
}

/** NAME -> value. The supervisor injects only the names a pack declares (v0.4 sect. 6.3). */
export type SecretsFile = Record<string, string>;

export const roomsStore = (h: HubDir) => new JsonStore<RoomsFile>(h.paths.rooms, () => ({ version: 1, rooms: [] }));
export const tokensStore = (h: HubDir) => new JsonStore<TokensFile>(h.paths.tokens, () => ({ version: 1, tokens: [] }));
export const principalsStore = (h: HubDir) => new JsonStore<PrincipalsFile>(h.paths.principals, () => ({ version: 1, principals: [] }));
export const secretsStore = (h: HubDir) => new JsonStore<SecretsFile>(h.paths.secrets, () => ({}));

/** Find a room by alias or handle. */
export function findRoom(file: RoomsFile, ref: string): RoomRecord | undefined {
  return file.rooms.find((r) => r.alias === ref || r.handle === ref);
}

// ---------------------------------------------------------------- the pre-0.7 layout

export interface LegacyLayout {
  root: string;
  /** Which markers were present, for the error message and the dry run. */
  found: string[];
  data: string | null;
  agents: string | null;
  roomMd: string | null;
  humanKey: string | null;
  secrets: string | null;
  gate: string | null;
  evals: string | null;
  parity: string | null;
  dogfoodState: string | null;
}

/**
 * Recognize a repository checkout that was used as an instance before 0.7: the
 * shape `rfa migrate` moves. Requires at least one of the three markers that only
 * an instance has (`data/`, `dogfood/ROOM.md`, `dogfood/state/`); a bare `agents/`
 * is not enough, because a hub directory has one too.
 */
export function detectLegacyLayout(root: string): LegacyLayout | null {
  const at = (...p: string[]) => {
    const full = path.join(root, ...p);
    return fs.existsSync(full) ? full : null;
  };
  const data = at("data");
  const roomMd = at("dogfood", "ROOM.md");
  const dogfoodState = at("dogfood", "state");
  if (!data && !roomMd && !dogfoodState) return null;
  const found = [data && "data/", roomMd && "dogfood/ROOM.md", dogfoodState && "dogfood/state/", at("agents") && "agents/"].filter(Boolean) as string[];
  return {
    root,
    found,
    data,
    agents: at("agents"),
    roomMd,
    humanKey: at("dogfood", "state", "human-key.txt"),
    secrets: at("data", "secrets.json"),
    gate: at("deploy", "gate.json"),
    evals: at("evals"),
    parity: at("dogfood", "state", "parity.json"),
    dogfoodState,
  };
}
