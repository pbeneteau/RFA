/**
 * `rfa doctor` (RFA-0.7 sect. 3.9): every check the findings ledger paid for,
 * each naming the finding it comes from, because a check with a story is
 * maintained and a check without one is deleted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentPack, CONCURRENCY_GATE_LABELS, concurrencyGateFailures, knowledgeFiles, loadPack, scanPacks, splitAgentMd, writeSurfaceDefFailures } from "../../agentdef.js";
import { matchDigest, parsePrincipalsFile, parseTokensFile } from "../../credentials.js";
import { daemonState } from "../../daemon.js";
import { readJsonFile, roomsStore, secretsStore, type HubDir } from "../../hubdir.js";
import { PrincipalSet } from "../../principals.js";
import { belongsTo, residentProcesses } from "../../procscan.js";
import { genesisFor, verifyChain } from "../../chain.js";
import { type CliContext } from "../context.js";
import { checkEnvironment, realProbe } from "../environment.js";
import { agentPosture, effectiveMode } from "../../posture.js";
import { postureView } from "../../egress.js";
import { fenceApplies } from "../../toolclass.js";
import { surfaceReport } from "../../surface.js";
import { deprecatedOffers } from "../../offers.js";
import { artifactDrift, artifactsStore } from "../../artifacts.js";
import { GUARDED_BUILTINS, guardedBuiltinsOf, sandboxAvailable, shadowingFailures, type SandboxCheck } from "../../writefence.js";
import { credentialAdvice, modelCredentialStatus, nativeBindingProblem, portFree } from "../preflight.js";
import type { CommandDef } from "../router.js";
import { fmtAge } from "../ui.js";

export interface Check {
  id: string;
  verdict: "ok" | "warn" | "fail" | "skip";
  text: string;
  fix?: string;
}

const ok = (id: string, text: string): Check => ({ id, verdict: "ok", text });
const warn = (id: string, text: string, fix?: string): Check => ({ id, verdict: "warn", text, fix });
const fail = (id: string, text: string, fix?: string): Check => ({ id, verdict: "fail", text, fix });
const skip = (id: string, text: string): Check => ({ id, verdict: "skip", text });

/**
 * The fields the two RFA-0.8 definition functions read, pulled out of a
 * frontmatter object the SCHEMA REFUSED, with a type guard per field.
 *
 * Needed because the interesting state for both checks below is a pack the
 * loader rejected: `parseAgentMd` throws on exactly the definitions that fail a
 * sect. 10 gate or door one's declaration half, so `loadPack` can never hand
 * doctor one. This normalizes the raw YAML and then asks the SHIPPED functions
 * (`concurrencyGateFailures`, `writeSurfaceDefFailures`) what is wrong with it;
 * nothing here re-decides anything.
 */
function refusedDeclaration(dir: string): { concurrency: number; candidates: number; tools?: { allow?: string[] }; mode?: string; interrupt_on?: AgentPack["def"]["interrupt_on"]; budgets?: { per_day_usd?: number }; sandbox?: { permission_mode?: string } } | null {
  let raw: unknown;
  try {
    raw = splitAgentMd(fs.readFileSync(path.join(dir, "agent.md"), "utf8")).raw;
  } catch {
    return null; // not even a frontmatter block: the pack check above already says so
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 1);
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const tools = obj(r.tools);
  const allow = Array.isArray(tools?.allow) ? (tools!.allow as unknown[]).filter((t): t is string => typeof t === "string") : undefined;
  const budgets = obj(r.budgets);
  const sandbox = obj(r.sandbox);
  return {
    concurrency: num(r.concurrency),
    candidates: num(r.candidates),
    ...(allow ? { tools: { allow } } : {}),
    ...(typeof r.mode === "string" ? { mode: r.mode } : {}),
    ...(obj(r.interrupt_on) ? { interrupt_on: obj(r.interrupt_on) as AgentPack["def"]["interrupt_on"] } : {}),
    ...(budgets ? { budgets: { per_day_usd: typeof budgets.per_day_usd === "number" ? budgets.per_day_usd : undefined } } : {}),
    ...(sandbox ? { sandbox: { permission_mode: typeof sandbox.permission_mode === "string" ? sandbox.permission_mode : undefined } } : {}),
  };
}

/**
 * Which of RFA-0.9 sect. 4.6's inert keys this pack's agent.md actually carries.
 *
 * Read from the FRONTMATTER rather than from the parsed definition, because
 * `network` has a schema default: a parsed `AgentDef` says `network: "none"` for
 * every pack, including the ones that never wrote the line. Only the raw object
 * can tell "the operator declared this" from "zod filled it in".
 */
export function inertNetworkKeys(dir: string): string[] {
  let raw: unknown;
  try {
    raw = splitAgentMd(fs.readFileSync(path.join(dir, "agent.md"), "utf8")).raw;
  } catch {
    return [];
  }
  const sandbox = raw && typeof raw === "object" ? (raw as Record<string, unknown>).sandbox : undefined;
  if (!sandbox || typeof sandbox !== "object" || Array.isArray(sandbox)) return [];
  return ["network", "allowed_domains"].filter((k) => k in (sandbox as Record<string, unknown>));
}

/** The definition hash the RUNNING resident recorded for itself, or null. */
function servedDefinition(dir: string): string | null {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state", "member.json"), "utf8")) as { definition_hash?: string };
    return state.definition_hash ?? null;
  } catch {
    return null;
  }
}

/**
 * Door one's DECLARATION half for one pack (RFA-0.8 sect. 9 item 1), or null
 * when the pack declares no write surface at all.
 *
 * Both halves are the fence's own exports, never a copy: the guarded set is
 * `guardedBuiltinsOf` and the verdict is `shadowingFailures`, the same call the
 * resident fails closed on at startup. A hand copy of shipped logic tests the
 * copy and nothing else - that exact defect was found in test/evalgate.test.ts
 * this week, and it is why this reads as two calls and no rule of its own.
 *
 * `allowedTools` is a parameter rather than something derived here for two
 * reasons: `runChecks` passes the resident's OWN computed set (`agentPosture`),
 * which is the one thing definition validation cannot see, and the shadowed
 * state - a guarded built-in that ended up pre-approved - is then a state a test
 * can construct instead of a comment claiming it cannot happen.
 */
export function fenceDeclarationCheck(pack: { name: string; def: AgentPack["def"] }, allowedTools: readonly string[]): Check | null {
  const guarded = guardedBuiltinsOf(pack.def);
  if (guarded.length === 0) return null;
  const failures = shadowingFailures({ guarded, allowedTools, permissionMode: pack.def.sandbox?.permission_mode });
  return failures.length === 0
    ? ok("fence-declaration-" + pack.name, `${pack.name} declares the write surface ${guarded.join(", ")}, and nothing in its declaration or its computed allowedTools switches door one off (out of allowedTools, permission mode ${pack.def.sandbox?.permission_mode ?? "default"}); the fall-through itself is unverified here, see the write-fence-callback check`)
    : fail(
        "fence-declaration-" + pack.name,
        `${pack.name} declares ${guarded.join(", ")} but ${failures.join("; ")}`,
        `a bare allowedTools entry or a shadowing permission mode switches door one off before canUseTool is consulted, and the resident refuses to boot on it; rfa agent edit ${pack.name}`,
      );
}

/**
 * The two-door write fence, as much of it as can be answered on THIS host
 * (RFA-0.8 sect. 9).
 *
 * The two doors are two different questions and only one of them has a local
 * answer, so they get two checks and only one of them can ever be green:
 *
 * - Door two, the OS sandbox, is ESTABLISHED here rather than asked about. That
 *   is sect. 9 item A6 and it is the whole point: inside an already-sandboxed
 *   macOS context `isSupportedPlatform()` is true and the dependency check
 *   reports zero errors while nothing can actually be sandboxed. `sandboxAvailable`
 *   wraps and RUNS one write inside a temp allow root and one outside it, so an
 *   `ok` here means a command was really fenced seconds ago, on this machine.
 * - Door one, the `canUseTool` fall-through for the guarded built-ins, CANNOT be
 *   established without a model call. So it reports the third state, unverified,
 *   and names what does prove it. A tick here would be an assertion that cannot
 *   fail, which is the defect this repository shipped in an eval on 2026-08-27
 *   and does not repeat in its health command.
 *
 * `establish` is injected only by the test that has to see the refusal.
 */
export async function writeFenceHostChecks(input: { writing: string[]; deep?: boolean; establish?: () => Promise<SandboxCheck> }): Promise<Check[]> {
  if (input.writing.length === 0 && !input.deep) {
    return [
      skip(
        "write-fence",
        `no pack declares ${GUARDED_BUILTINS.join(", ")} or Bash, so RFA-0.9 sect. 3.3's coverage predicate fences no run here yet and none needs door two (RFA-0.8 sect. 9); ` +
          `rfa doctor --deep establishes door two anyway, and npm run fence-proof proves both doors`,
      ),
    ];
  }
  const out: Check[] = [];
  const who = input.writing.length > 0 ? `, needed by ${input.writing.join(", ")}` : ", needed by no pack yet";
  // "writing" is the parameter's historical name; since RFA-0.9 sect. 3.3 the caller
  // passes every FENCED pack, which includes a command-only one that declares no
  // guarded built-in at all.
  const sb = await (input.establish ?? (() => sandboxAvailable()))();
  out.push(
    sb.ok
      ? ok("write-fence-sandbox", `door two ESTABLISHED on ${sb.platform}${who}: a sandboxed write landed inside a temp allow root and one outside it was refused${sb.detail === "established" ? "" : ` (${sb.detail})`}`)
      : fail(
          "write-fence-sandbox",
          `door two could NOT be established on ${sb.platform}${who}: ${sb.detail}`,
          input.writing.length > 0
            ? "a fenced pack refuses to serve rather than serve with one door (RFA-0.8 sect. 9 item 3), so those agents will not boot here; npm run fence-proof for the full picture. On macOS the usual cause is doctor itself running inside a sandbox: nested sandbox-exec is refused"
            : "nothing here is fenced yet, so nothing is broken now; a pack declaring Write, Edit, NotebookEdit or Bash on this host would refuse to boot",
        ),
  );
  out.push(
    skip(
      "write-fence-callback",
      "door one (the canUseTool fall-through for Write, Edit and NotebookEdit) is UNVERIFIED on this host: only a live model call can show a guarded built-in still reaching the callback, so doctor does not tick it. `npm run fence-proof` proves it on demand, and every writing resident re-proves it per guarded built-in at boot with a deny probe, treating bypassed and inconclusive alike as fatal (RFA-0.8 sect. 9 item 1)",
    ),
  );
  return out;
}

export async function runChecks(ctx: CliContext, opts: { deep?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(...checkEnvironment(realProbe(ctx.env)));

  let h: HubDir;
  try {
    h = ctx.hubdir();
  } catch (err) {
    checks.push(fail("hub-directory", (err as Error).message, (err as { hint?: string }).hint));
    return checks;
  }
  checks.push(ok("hub-directory", `${h.root} (${h.manifest.name}, ${h.mode})`));

  // Permissions and the four files.
  const mode = (f: string) => (fs.existsSync(f) ? fs.statSync(f).mode & 0o777 : null);
  const rm = mode(h.paths.runtime);
  checks.push(rm === null ? warn("runtime-dir", ".rfa/ does not exist yet", "rfa init or rfa up creates it") : rm & 0o077 ? fail("runtime-dir", `.rfa/ is mode ${rm.toString(8)}; it holds the credential files`, `chmod 700 ${h.paths.runtime}`) : ok("runtime-dir", ".rfa/ is 0700"));
  for (const [name, file, parse] of [
    ["secrets", h.paths.secrets, (r: unknown) => r as Record<string, string>],
    ["principals", h.paths.principals, parsePrincipalsFile],
    ["tokens", h.paths.tokens, parseTokensFile],
    ["rooms", h.paths.rooms, (r: unknown) => r as { rooms: unknown[] }],
  ] as const) {
    const m = mode(file);
    if (m === null) {
      checks.push(name === "secrets" || name === "tokens" ? warn(`file-${name}`, `.rfa/${name}.json is missing`, name === "tokens" ? "without a bearer the hub runs UNAUTHENTICATED: rfa token mint operator" : "rfa init writes it") : skip(`file-${name}`, `.rfa/${name}.json not written yet`));
      continue;
    }
    try {
      readJsonFile(file, () => ({}) as never, parse as never);
      checks.push(m & 0o077 ? fail(`file-${name}`, `.rfa/${name}.json is mode ${m.toString(8)}`, `chmod 600 ${file}`) : ok(`file-${name}`, `.rfa/${name}.json parses, 0600`));
    } catch (err) {
      checks.push(fail(`file-${name}`, `.rfa/${name}.json does not parse: ${(err as Error).message}`, "the hub keeps its previous set until this is fixed; fix the file"));
    }
  }
  // The CLI's human key must be one of the principals, or every workbench read 401s.
  try {
    const secrets = secretsStore(h).read();
    const principals = PrincipalSet.fromRecords(readJsonFile(h.paths.principals, () => ({ version: 1 as const, principals: [] }), parsePrincipalsFile).principals);
    if (!secrets.RFA_HUMAN_KEY) checks.push(warn("human-key", "no RFA_HUMAN_KEY in secrets.json: this CLI cannot act as a human (status, approvals, room admin)", "rfa human add <label>"));
    else checks.push(principals.match(secrets.RFA_HUMAN_KEY) ? ok("human-key", `the CLI's human key is principal ${principals.match(secrets.RFA_HUMAN_KEY)}`) : fail("human-key", "RFA_HUMAN_KEY in secrets.json matches no principal", "rfa human add <label> (or rotate)"));
    const tokens = readJsonFile(h.paths.tokens, () => ({ version: 1 as const, tokens: [] }), parseTokensFile).tokens;
    if (!secrets.RFA_TOKEN) checks.push(h.mode === "hub" ? fail("operator-token", "no RFA_TOKEN in secrets.json: residents cannot reach the hub", "rfa token mint operator") : warn("operator-token", "no RFA_TOKEN: the far hub's bearer is missing", "rfa secrets set RFA_TOKEN"));
    else if (h.mode === "hub") checks.push(matchDigest(secrets.RFA_TOKEN, tokens) ? ok("operator-token", `RFA_TOKEN is an accepted bearer (${tokens.length} in tokens.json)`) : fail("operator-token", "RFA_TOKEN in secrets.json is not in tokens.json: every resident and this CLI will be refused with 401", "rfa token mint operator"));
    if (h.mode === "hub" && tokens.length === 0) checks.push(fail("tokens", "tokens.json is empty: /mcp runs UNAUTHENTICATED and anything that reaches the port can room_create", "rfa token mint operator"));
  } catch {
    /* reported above */
  }

  // The gate.
  if (h.paths.gate) {
    if (!fs.existsSync(h.paths.gate)) checks.push(fail("gate", `policy gate ${path.relative(h.root, h.paths.gate)} is missing; the hub refuses to start without it`, "rfa init --yes re-run writes the missing default (it rotates nothing); or set hub.gate to null in rfa.json"));
    else {
      try {
        const g = JSON.parse(fs.readFileSync(h.paths.gate, "utf8"));
        checks.push(Array.isArray(g) ? ok("gate", `policy gate: ${g.length} check${g.length === 1 ? "" : "s"}`) : fail("gate", "policy gate is not a JSON array of checks"));
      } catch (err) {
        checks.push(fail("gate", `policy gate does not parse: ${(err as Error).message}`, "a malformed gate must not mean no gate; fix the file"));
      }
    }
  }

  // The port and the processes.
  if ("port" in h.manifest.hub) {
    const port = h.manifest.hub.port;
    const healthy = await ctx.healthz();
    const free = await portFree(port);
    const hubState = daemonState(h.paths.hubPid);
    if (healthy) checks.push(ok("hub", `the hub answers on ${port}${hubState.record ? ` (pid ${hubState.record.pid})` : " (not started by rfa up)"}`));
    else if (!free) checks.push(fail("hub", `port ${port} is held by something that does not answer /healthz`, "another program, or a hub that is wedged: rfa logs hub; lsof -i :" + port));
    else checks.push(hubState.stale ? warn("hub", "the hub is not running and a stale pid file remains", "rfa up cleans it") : warn("hub", "the hub is not running", "rfa up"));
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(h.paths.data, ".hub.lock"), "utf8")) as { heartbeat?: number; pid?: number };
      const age = Date.now() - (lock.heartbeat ?? 0);
      if (healthy) checks.push(age < 60_000 ? ok("store-lock", `store lock heartbeat ${fmtAge(lock.heartbeat ?? 0)}`) : warn("store-lock", `the hub answers but its lock heartbeat is ${fmtAge(lock.heartbeat ?? 0)}`, "a second hub may have taken the store; rfa logs hub"));
      else if (age < 60_000) checks.push(fail("store-lock", `a live lock (pid ${lock.pid}) on the store while /healthz does not answer`, "a hub outside rfa's control is serving this store"));
    } catch {
      /* no lock: fine */
    }
  }
  const supState = daemonState(h.paths.supervisorPid);
  checks.push(supState.alive ? ok("supervisor", `supervisor running (pid ${supState.record!.pid})`) : supState.stale ? warn("supervisor", "the supervisor is not running and a stale pid file remains", "rfa up") : warn("supervisor", "the supervisor is not running", "rfa up"));

  // Packs.
  const packsDir = h.paths.agents;
  const packs = fs.existsSync(packsDir) ? fs.readdirSync(packsDir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
  const rooms = roomsStore(h).exists() ? roomsStore(h).read().rooms : [];
  if (packs.length === 0) checks.push(warn("packs", "no agent packs", "rfa agent new <name>"));
  const loadedPacks: AgentPack[] = [];
  const refusedPacks: { name: string; dir: string }[] = [];
  for (const entry of packs) {
    const dir = path.join(packsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "agent.md"))) {
      checks.push(skip(`pack-${entry.name}`, `agents/${entry.name}/ has no agent.md (retired or not a pack)`));
      continue;
    }
    try {
      const pack = loadPack(dir);
      loadedPacks.push(pack);
      const problems: string[] = [];
      if (!(pack.def.secrets ?? []).includes("RFA_TOKEN")) problems.push("does not declare RFA_TOKEN in secrets (it cannot reach an authenticated hub)");
      if ((pack.def.offers ?? []).length === 0) problems.push("offers nothing (a participant join is refused without a skill)");
      const binding = (pack.def.rooms ?? [])[0];
      if (!binding) problems.push("binds to no room (it loads but never serves)");
      else if (binding.room && rooms.length && !rooms.some((r) => r.handle === binding.room)) problems.push(`binds to ${binding.room}, which rooms.json does not list`);
      const files = knowledgeFiles(pack).length;
      if ((pack.def.knowledge ?? []).length > 0 && files === 0) problems.push("knowledge globs resolve to zero files");
      checks.push(problems.length ? warn(`pack-${pack.name}`, `${pack.name}: ${problems.join("; ")}`, "rfa agent show / rfa agent bind / rfa agent edit") : ok(`pack-${pack.name}`, `${pack.name}: valid, ${files} knowledge file${files === 1 ? "" : "s"}, room ${binding?.room ?? "-"}${effectiveMode(pack.def) === "read-only" ? "" : `, mode ${effectiveMode(pack.def)}`}`));
      if (effectiveMode(pack.def) === "bypass") checks.push(warn(`mode-${pack.name}`, `${pack.name} is in bypass mode: its acting tools run without a human`, `rfa agent mode ${pack.name} ask`));
    } catch (err) {
      refusedPacks.push({ name: entry.name, dir });
      checks.push(fail(`pack-${entry.name}`, `agents/${entry.name}/agent.md: ${(err as Error).message}`, "rfa agent validate " + entry.name));
    }
  }

  /**
   * The inert `sandbox.network` line (RFA-0.9 sect. 1.1 finding 1, sect. 4.6).
   *
   * READ FROM DISK, and it says so: the finding IS the file. `sandbox.network`
   * and `sandbox.allowed_domains` have no reader anywhere in the platform, and
   * `rfa agent new` wrote `network: none` into every pack it ever generated,
   * beside two settings that are read. A resident's `state/member.json` records
   * no posture, so there is nothing running to compare against and CLAUDE.md's
   * configured-versus-happening rule is answered by naming the source instead.
   */
  for (const pack of loadedPacks) {
    const view = postureView(pack.def);
    const carried = inertNetworkKeys(pack.dir);
    // A posture that governs something is reported with its scope, never alone.
    if (!view.inert) {
      checks.push(ok(`network-${pack.name}`, `${pack.name}: ${view.summary}. Scope: ${view.scope} (read from agent.md on disk: a resident's state/member.json records no posture)`));
      continue;
    }
    // Inert: the pack has no sandboxed command surface, so the field governs
    // nothing here (RFA-0.9 sect. 4.2). Still reported, because sect. 10.1 asks
    // for the posture PER PACK and "nothing is in force here" is the answer an
    // operator needs; it is a warning only where the operator actually wrote the
    // key, which is what every pre-rung-1 scaffold did.
    checks.push(
      carried.length === 0
        ? skip(`network-${pack.name}`, `${pack.name}: ${view.summary} (read from disk: a resident's state/member.json records no posture)`)
        : warn(
            `inert-network-${pack.name}`,
            `${pack.name}'s agent.md carries ${carried.map((k) => `sandbox.${k}`).join(" and ")} and ${view.summary} (read from disk, not from the running resident)`,
            `rfa agent edit ${pack.name} --drop-network removes the line through the same validated write every other edit uses; ` +
              `every pack rfa agent new wrote before RFA-0.9 rung 1 carries it, and a setting that reads as a control while governing nothing is what that rung exists to remove`,
          ),
    );
  }

  /**
   * RFA-0.9 sect. 10.1: every unconfined surface a pack holds, the reachable
   * tool count above the threshold, the `reach` built-ins, and the deprecated
   * offers. All FROM DISK, and each line says so, because a resident records
   * none of it and a check that read agent.md and presented it as what is being
   * served is exactly the defect CLAUDE.md's rule was written for.
   */
  for (const pack of loadedPacks) {
    const report = surfaceReport(pack.def);
    for (const u of report.surfaces) {
      const id = `surface-${u.kind}-${pack.name}`;
      // A `reach` built-in and an MCP server are things the operator chose and
      // must keep in view; the platform's own injected tools are always there,
      // so they are a note rather than a warning.
      checks.push(
        u.kind === "platform-tool" || u.kind === "mcp-confined"
          ? skip(id, `${pack.name} holds ${u.what} (from disk): ${u.why}`)
          : warn(id, `${pack.name} holds an UNCONFINED surface, ${u.what} (from disk): ${u.why}`, u.kind === "subagent" ? "npm run egress-proof establishes it on this host" : "this is a rendering, not a control: RFA-0.9 sect. 5 records that no door covers it"),
      );
    }
    if (report.toolWarning) checks.push(warn(`tool-count-${pack.name}`, `${pack.name}: ${report.toolWarning}`, "drop what the pack does not use, or accept the count deliberately"));
    for (const w of pack.warnings) if (!report.toolWarning || w !== report.toolWarning) checks.push(warn(`defwarn-${pack.name}`, `${pack.name}: ${w}`));
  }

  /** Sect. 8.1: every deprecated offer with its successor, and the locality caveat with it. */
  const deprecated = deprecatedOffers(loadedPacks);
  for (const d of deprecated) {
    checks.push(
      warn(
        `deprecated-offer-${d.pack}-${d.offer.id}`,
        `${d.pack}: ${d.note}`,
        d.offer.superseded_by
          ? `local selectors prefer ${d.offer.superseded_by}; a selector reading card_summary.skill_ids off the ROSTER cannot see the flag, so an asker in the room may still name the old id`
          : "name a superseded_by, or remove the offer once nothing asks for it",
      ),
    );
  }

  /**
   * Sect. 8.2: `rfa connect --skill` writes offer ids and their descriptions into
   * ANOTHER repository and recorded the destination nowhere. Now it records; this
   * compares each recorded destination that still exists against the live set.
   */
  const store = artifactsStore(h);
  if (store.exists()) {
    const live = loadedPacks.map((p) => ({ name: p.name, definitionHash: p.definitionHash, rooms: (p.def.rooms ?? []).map((r) => r.room ?? "") }));
    const drift = artifactDrift(store.read().artifacts, live);
    if (drift.length === 0) checks.push(ok("artifacts", `${store.read().artifacts.length} generated artifact record(s), none drifted from the packs they were generated from`));
    for (const d of drift) {
      const parts = [
        ...d.moved.map((m) => `${m.pack}'s definition moved ${m.then.slice(7, 15)} -> ${m.now.slice(7, 15)}`),
        ...d.added.map((a) => `${a} now binds to the room and is not in the file`),
        ...d.removed.map((r) => `${r} is in the file and no longer binds to the room`),
        ...d.skipped.map((sk) => `${sk} was BROKEN when the file was generated, so its offers were silently missing from it`),
      ];
      checks.push(warn(`artifact-drift-${path.basename(path.dirname(d.present[0]))}`, `${d.present.join(", ")} is behind the packs it was generated from: ${parts.join("; ")}`, `rfa connect claude-code --room ${d.record.room} --skill re-generates it in that project`));
    }
  }

  // The write fence's door-one declaration, per pack, against the resident's own
  // computed `allowedTools` rather than the empty list definition validation sees.
  //
  // For a pack that LOADED this cannot currently fail, and that is on purpose
  // rather than an oversight: `preApproved` strips every guarded built-in by
  // construction, and a shadowing `sandbox.permission_mode` is refused at parse.
  // So the green tick here is a TRIPWIRE on those two facts, not evidence about
  // this pack. The failing states are the refused pack below and the shadowed
  // `allowedTools` a unit test constructs directly.
  for (const pack of loadedPacks) {
    const check = fenceDeclarationCheck(pack, agentPosture(pack.def).allowedTools);
    if (check) checks.push(check);
  }
  for (const r of refusedPacks) {
    const raw = refusedDeclaration(r.dir);
    if (!raw) continue;
    const fence = writeSurfaceDefFailures(raw);
    if (fence.length > 0) {
      checks.push(fail("fence-declaration-" + r.name, `${r.name} cannot be fenced as written, which is why the loader refuses it: ${fence.join("; ")}`, `rfa agent edit ${r.name} (or drop sandbox.permission_mode back to default); until it parses, the supervisor keeps whatever resident is already running`));
    }
    // The same for the concurrency gates: a pack that fails one does not load, so
    // its gate report can only come from the declaration on disk.
    const gates = concurrencyGateFailures(raw);
    if (gates.length > 0) {
      checks.push(
        fail(
          "concurrency-" + r.name,
          `${r.name} declares concurrency ${raw.concurrency}${raw.candidates > 1 ? ` and candidates ${raw.candidates}` : ""} and fails ${gates.length === 1 ? "a gate" : `${gates.length} gates`} of RFA-0.8 sect. 10: ${gates.join("; ")}`,
          `each gate is a thing that is merely inefficient serially and becomes a correctness or a money problem at N: fix it, or rfa agent edit ${r.name} --concurrency 1`,
        ),
      );
    }
  }

  /**
   * The supervisor's own state file, read here rather than in the strays section
   * below because the account cap the next block needs is in it. It is the
   * supervisor's VIEW: a mirror of the ledger it wrote, and of what it believes
   * it started. Every reader below says which of those it is using and why.
   */
  let supFile: { agents?: Record<string, { pid: number | null; status: string; definition_hash?: string }>; invalid?: Record<string, string>; account?: { paused_until?: string | null; cap?: number } } | null = null;
  try {
    supFile = JSON.parse(fs.readFileSync(h.paths.supervisorState, "utf8"));
  } catch {
    supFile = null;
  }

  /**
   * The concurrency gates for a pack that DID load (RFA-0.8 sect. 10), plus the
   * one thing the gates say nothing about: the account cap, which bounds the
   * total across every resident regardless of what a pack declares.
   *
   * The cap IN FORCE is the one the supervisor wrote into the ledger at boot
   * (`configuredCap()` -> `AccountLedger.setCap`, RFA-0.8 sect. 5 item 8), not
   * `agents.max_inflight` on disk: the manifest value needs a restart to take
   * effect (`rfa config set` says so, and `creds.ts` NEEDS_RESTART lists that
   * key) and `RFA_ACCOUNT_MAX_INFLIGHT` in the supervisor's environment beats it
   * outright. Reading the manifest here made doctor contradict `rfa status` in
   * the same breath - status prints the ledger's `0/2 in flight` while this check
   * warned that the cap was 1 - and, worse, print a tick for a raise that had
   * not been applied. That is the disk-read-as-served defect the definition-drift
   * check below exists for, so it gets the same treatment: name both numbers.
   */
  /*
   * What the RUNNING supervisor could not load, from its own state file, which
   * is not the same question as what fails to parse on disk right now. The two
   * differ for a real window: the registry is re-scanned every 30 seconds, so a
   * pack fixed ten seconds ago still parses on disk while the supervisor has not
   * picked it up, and a pack broken ten seconds ago still looks supervised. Only
   * the supervisor's record says which packs are actually unsupervised, which is
   * the CLAUDE.md rule this file has already broken once today.
   */
  const supervisorInvalid = Object.entries(supFile?.invalid ?? {});
  if (supervisorInvalid.length > 0 && supState.alive) {
    for (const [dir, why] of supervisorInvalid) {
      const parsesNow = !scanPacks(h.paths.agents).broken.some((b) => b.name === dir);
      checks.push(
        warn(
          `unsupervised-${dir}`,
          parsesNow
            ? `the running supervisor last failed to load agents/${dir}/agent.md (${why}), and it parses on disk now: the registry is re-scanned every 30s, so it is still unsupervised until then`
            : `the running supervisor cannot load agents/${dir}/agent.md, so that pack is UNSUPERVISED: no start, no restart if it dies, no drain (${why})`,
          parsesNow ? "wait for the next scan, or rfa restart to apply it now" : `rfa agent validate ${dir}`,
        ),
      );
    }
  }
  const ledgerCap = typeof supFile?.account?.cap === "number" ? supFile.account.cap : null;
  const manifestCap = h.manifest.agents.max_inflight;
  const accountCap = ledgerCap ?? manifestCap;
  const capSource =
    ledgerCap === null
      ? `agents.max_inflight is ${manifestCap} on disk and no supervisor has recorded a cap, so nothing holds the account to it yet: rfa up applies it, and RFA_ACCOUNT_MAX_INFLIGHT in the supervisor's environment overrides it`
      : ledgerCap !== manifestCap
        ? `the ${supState.alive ? "running supervisor holds" : "last supervisor left"} the account cap at ${ledgerCap} while agents.max_inflight on disk is ${manifestCap}: the manifest edit is not live yet, and rfa restart is what applies it (or RFA_ACCOUNT_MAX_INFLIGHT is overriding it in the supervisor's environment)`
        : `the account cap in the ledger is ${ledgerCap}, matching agents.max_inflight`;
  for (const pack of loadedPacks) {
    const { concurrency, candidates } = pack.def;
    if (concurrency <= 1 && candidates <= 1) continue;
    const gates = concurrencyGateFailures(pack.def);
    const declared = `${concurrency} turn${concurrency === 1 ? "" : "s"} at once${candidates > 1 ? `, ${candidates} candidates per task` : ""}`;
    if (gates.length > 0) {
      // Unreachable while the loader enforces the gates, which is exactly why it
      // is asserted rather than assumed: this fires the day that stops being true.
      checks.push(fail("concurrency-" + pack.name, `${pack.name} runs ${declared} without passing sect. 10's gates: ${gates.join("; ")}`, `rfa agent edit ${pack.name} --concurrency 1`));
    } else if (accountCap < concurrency) {
      checks.push(
        warn(
          "concurrency-" + pack.name,
          `${pack.name} declares ${declared}, but the account cap in force is ${accountCap}, so the extra slot can never be used: ${capSource}`,
          `rfa config set agents.max_inflight ${concurrency} and rfa restart (each slot is a full claude CLI child process on this host), or rfa agent edit ${pack.name} --concurrency ${accountCap}`,
        ),
      );
    } else {
      checks.push(
        ok(
          "concurrency-" + pack.name,
          `${pack.name} runs ${declared}, past sect. 10's gates (${CONCURRENCY_GATE_LABELS.join(", ")}; posture ${effectiveMode(pack.def)}, per_day_usd ${pack.def.budgets?.per_day_usd ? `$${pack.def.budgets.per_day_usd.toFixed(2)}` : "declared"}), within the account cap of ${accountCap}: ${capSource}`,
        ),
      );
    }
  }

  // Door two, established on this host; door one, honestly unverified.
  // RFA-0.9 sect. 3.3: the predicate that decides whether door two is
  // established is `fenceApplies` (guarded OR command), not the write surface.
  // Keyed on the narrower one, this check printed "no run needs the fence" on a
  // hub whose fenced packs are command-only - the instrument disagreeing with
  // the resident that refuses to boot without it.
  checks.push(...(await writeFenceHostChecks({ writing: loadedPacks.filter((p) => fenceApplies(p.def)).map((p) => p.name), deep: opts.deep })));

  // Rooms allow the operator bearer (snapshots: reconnaissance only).
  try {
    const secrets = secretsStore(h).read();
    if (secrets.RFA_TOKEN && fs.existsSync(h.paths.roomLogs)) {
      const digest = (await import("../../credentials.js")).tokenDigest(secrets.RFA_TOKEN);
      for (const r of rooms) {
        const meta = path.join(h.paths.roomLogs, `${r.handle}.meta.json`);
        if (!fs.existsSync(meta)) continue;
        const m = JSON.parse(fs.readFileSync(meta, "utf8")) as { policies?: { join_bearer_sha256?: string[] }; ended?: boolean };
        if (m.ended) continue;
        checks.push((m.policies?.join_bearer_sha256 ?? []).includes(digest) ? ok(`room-${r.alias}`, `room ${r.alias} admits the operator bearer`) : warn(`room-${r.alias}`, `room ${r.alias} (${r.handle}) does not list the operator bearer: residents need its join secret`, r.operator ? `rfa room allow ${r.alias} --token operator` : `rfa room adopt ${r.alias} (no operator membership yet: adopting joins as supervisor and admits the bearer)`));
      }
    }
  } catch {
    /* snapshots unreadable while the hub rewrites them: not a verdict */
  }

  // Strays and the supervisor's view.
  /**
   * The pack names, from the scan above rather than from `listPacks`.
   *
   * `listPacks` maps `loadPack` with no catch, so ONE unparseable definition threw
   * out of the middle of `runChecks` and doctor printed a bare parse error instead
   * of its report - including the `pack-<name>` check that had already recorded
   * that exact failure two lines earlier. A health command must survive the
   * unhealthy state it exists to describe.
   */
  const names = new Set([...loadedPacks.map((p) => p.name), ...refusedPacks.map((r) => r.name)]);
  const residents = (await residentProcesses()).filter((p) => belongsTo(p, h.root));
  const owned = new Set(Object.values(supFile?.agents ?? {}).map((a) => a.pid).filter((p): p is number => typeof p === "number"));
  for (const r of residents) {
    if (names.has(r.agent) && !owned.has(r.pid)) checks.push(fail("stray-resident", `a resident for ${r.agent} (pid ${r.pid}) is running that the supervisor does not own`, "two residents on one membership answer as one; stop it, or rfa agent retire if it is stale"));
  }

  /**
   * DEFINITION DRIFT: the definition on disk against the one the RUNNING
   * resident is serving. Today's incident (2026-08-27) turned into a check.
   *
   * A pack was edited to `concurrency: 2`, the live resident kept serving the
   * previous definition, and the only place that said so was a boot line in a
   * log nobody was reading: `rfa status` shows a `def` column and it is the DISK
   * hash, so it moved the moment the file was saved and looked like the edit had
   * landed. This is CLAUDE.md's "long-lived processes serve old code" rule, and
   * an edited definition is the one case where the operator has every reason to
   * believe otherwise, because they just saved the file.
   *
   * The served hash comes from the resident's OWN `state/member.json`, not from
   * the supervisor's state file: the supervisor's copy is what it believes it
   * started, and a redeploy that failed halfway would have it claiming the new
   * hash while the old process serves on. When the two disagree, both are named.
   */
  for (const pack of loadedPacks) {
    const live = residents.filter((r) => r.agent === pack.name);
    if (live.length === 0) continue; // nothing is serving this pack: nothing can drift
    const served = servedDefinition(pack.dir);
    const supView = supFile?.agents?.[pack.name]?.definition_hash ?? null;
    const short = (hash: string | null) => (hash ? hash.replace(/^sha256:/, "").slice(0, 8) : "unknown");
    if (!served) {
      checks.push(skip(`definition-${pack.name}`, `${pack.name} is running (pid ${live.map((p) => p.pid).join(", ")}) but has recorded no definition hash yet, so what it serves cannot be compared with agents/${pack.name}/agent.md`));
    } else if (served !== pack.definitionHash) {
      checks.push(
        warn(
          `definition-${pack.name}`,
          `${pack.name} is SERVING definition ${short(served)} while agents/${pack.name}/agent.md is ${short(pack.definitionHash)}: restart owed` +
            (supView && supView !== served ? ` (and the supervisor believes it started ${short(supView)}, so its redeploy did not take)` : ""),
          `rfa agent restart ${pack.name}: long-lived processes serve old code, and an edit that is on disk is not in the resident until it restarts. The supervisor's reconcile pass picks a definition change up within 30 s, so a difference still here after that means it did not`,
        ),
      );
    } else {
      checks.push(ok(`definition-${pack.name}`, `${pack.name} serves the definition on disk (def ${short(served)})`));
    }
  }
  for (const [name, a] of Object.entries(supFile?.agents ?? {})) {
    // state.json is the supervisor's view, and a dead supervisor's view is
    // history: its crash budget lives in memory, so the next rfa up starts
    // every pack fresh (seen live: the old supervisor had given up on a pack
    // whose definition it could not parse, and the file said so for hours).
    if (a.status === "crash-looped") {
      checks.push(
        supState.alive
          ? fail(`crash-${name}`, `${name} is crash-looping; the supervisor gave up until its definition changes`, `rfa logs ${name}; rfa agent restart ${name} grants a fresh crash budget`)
          : skip(`crash-${name}`, `${name} was crash-looping when the supervisor last wrote its state; rfa up starts it with a fresh crash budget, then rfa logs ${name} if it dies again`),
      );
    }
    const hb = path.join(packsDir, name, "state", "heartbeat");
    if (supState.alive && a.status === "running" && fs.existsSync(hb)) {
      const age = Date.now() - Number(fs.readFileSync(hb, "utf8"));
      if (age > 240_000) checks.push(warn(`heartbeat-${name}`, `${name}'s heartbeat is ${fmtAge(Date.now() - age)}; the supervisor restarts it past the lease`, `rfa logs ${name}`));
    }
  }
  if (supFile?.account?.paused_until && Date.parse(supFile.account.paused_until) > Date.now()) checks.push(warn("account", `model pickup is paused account-wide until ${supFile.account.paused_until}`, "a provider rate limit or an operator pause; it lifts on its own"));

  // The outage that looks healthy: recent runs all unauthorized (the credential alert, no volume guard).
  if (fs.existsSync(h.paths.obsDb)) {
    try {
      const { ObsStore, evaluateAlerts } = await import("../../obs.js");
      const obs = new ObsStore(h.paths.obsDb);
      try {
        const alerts = evaluateAlerts(obs.summary(15 * 60_000));
        for (const al of alerts) checks.push(fail(`alert-${al.kind}`, `${al.kind}: ${al.message}`));
        if (alerts.length === 0) checks.push(ok("alerts", "no alert in the last 15 minutes (error rate, latency, feedback, credential)"));
      } finally {
        obs.close();
      }
    } catch (err) {
      checks.push(skip("alerts", `obs.db unreadable: ${(err as Error).message}`));
    }
  }

  // Backups and logs.
  if (fs.existsSync(h.paths.backups)) {
    const dated = fs.readdirSync(h.paths.backups).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    checks.push(dated.length ? ok("backups", `last backup ${dated.at(-1)} (${dated.length} kept in ${h.paths.backups})`) : warn("backups", `no dated backup in ${h.paths.backups}`, "the supervisor writes one nightly after 03:00; rfa backup now"));
  } else checks.push(warn("backups", "no backup has been written yet", "the supervisor writes one nightly after 03:00; rfa backup now forces one"));
  if (fs.existsSync(h.paths.roomLogs)) {
    const big = fs.readdirSync(h.paths.roomLogs).filter((f) => f.endsWith(".ndjson")).map((f) => ({ f, size: fs.statSync(path.join(h.paths.roomLogs, f)).size })).filter((x) => x.size > 50 * 1024 * 1024);
    for (const b of big) checks.push(warn("room-log-size", `${b.f} is ${(b.size / 1024 / 1024).toFixed(0)} MB; the hub holds every room log in memory`, "end the room or archive it (RFA-0.6 sect. 8.3)"));
  }
  if (opts.deep && fs.existsSync(h.paths.roomLogs)) {
    for (const f of fs.readdirSync(h.paths.roomLogs).filter((x) => x.endsWith(".ndjson"))) {
      const handle = f.replace(/\.ndjson$/, "");
      const events = fs.readFileSync(path.join(h.paths.roomLogs, f), "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
      const res = verifyChain(events, { genesis: genesisFor(handle) });
      checks.push(!res.ok ? fail(`chain-${handle}`, `${handle}: chain DIVERGED at seq ${res.divergences[0]?.seq}`) : res.unverifiable ? skip(`chain-${handle}`, `${handle}: carries no chain (predates 0.1.7)`) : ok(`chain-${handle}`, `${handle}: ${res.linksChecked} links intact`));
    }
  }
  return checks;
}

export const doctor: CommandDef = {
  path: ["doctor"],
  summary: "Every check the findings ledger paid for, with the fix named",
  usage: "[--deep]",
  options: { deep: { type: "boolean", default: false } },
  why: "A system that looks healthy while unable to work is the shape four incidents took here: an expired model credential behind three ready agents, a supervisor that died and left residents unsupervised, an #ops channel that 401'd for a day, an alert triad blind to a 100% failure rate. Each check names its scar. --deep verifies every room log's hash chain as well.",
  run: async (ctx, a) => {
    const checks = await runChecks(ctx, { deep: Boolean(a.values.deep) });
    if (ctx.flags.json) ctx.ui.json(checks);
    else {
      const ui = ctx.ui;
      for (const c of checks) {
        const sym = c.verdict === "ok" ? ui.good("✔") : c.verdict === "warn" ? ui.caution("!") : c.verdict === "fail" ? ui.bad("✖") : ui.dim("·");
        ui.line(` ${sym} ${c.text}`);
        if (c.fix && c.verdict !== "ok") ui.note(`→ ${c.fix}`);
      }
      const fails = checks.filter((c) => c.verdict === "fail").length;
      const warns = checks.filter((c) => c.verdict === "warn").length;
      ui.blank();
      ui.line(fails ? ui.bad(`${fails} problem${fails === 1 ? "" : "s"}`) + (warns ? ui.dim(`, ${warns} warning${warns === 1 ? "" : "s"}`) : "") : warns ? ui.caution(`${warns} warning${warns === 1 ? "" : "s"}`) + ui.dim(", nothing broken") : ui.good("nothing wrong that doctor can see"));
    }
    if (checks.some((c) => c.verdict === "fail")) return 1;
  },
};
