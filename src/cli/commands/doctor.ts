/**
 * `rfa doctor` (RFA-0.7 sect. 3.9): every check the findings ledger paid for,
 * each naming the finding it comes from, because a check with a story is
 * maintained and a check without one is deleted.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { listPacks, loadPack, knowledgeFiles } from "../../agentdef.js";
import { matchDigest, parsePrincipalsFile, parseTokensFile } from "../../credentials.js";
import { daemonState } from "../../daemon.js";
import { readJsonFile, roomsStore, secretsStore, type HubDir } from "../../hubdir.js";
import { PrincipalSet } from "../../principals.js";
import { residentProcesses } from "../../procscan.js";
import { genesisFor, verifyChain } from "../../chain.js";
import { type CliContext } from "../context.js";
import { credentialAdvice, modelCredentialStatus, portFree } from "../preflight.js";
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

export async function runChecks(ctx: CliContext, opts: { deep?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(major >= 22 ? ok("node", `node ${process.version}`) : fail("node", `node ${process.version} is below 22`, "Node 20 reached end of life in April 2026; install 22 or newer"));
  try {
    await import("better-sqlite3");
    checks.push(ok("sqlite", "better-sqlite3 loads (native binding present)"));
  } catch (err) {
    checks.push(fail("sqlite", `better-sqlite3 does not load: ${(err as Error).message.split("\n")[0]}`, "npm rebuild better-sqlite3, or reinstall the package for this node version"));
  }
  const cred = modelCredentialStatus(ctx.env);
  checks.push(cred.ok === true ? ok("model-credential", cred.detail) : cred.ok === false ? fail("model-credential", cred.detail, credentialAdvice(cred).join(" ")) : warn("model-credential", cred.detail, credentialAdvice(cred).join(" ")));

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
    if (!fs.existsSync(h.paths.gate)) checks.push(fail("gate", `policy gate ${path.relative(h.root, h.paths.gate)} is missing; the hub refuses to start without it`, "rfa init writes the default; or set hub.gate to null in rfa.json"));
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
  for (const entry of packs) {
    const dir = path.join(packsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "agent.md"))) {
      checks.push(skip(`pack-${entry.name}`, `agents/${entry.name}/ has no agent.md (retired or not a pack)`));
      continue;
    }
    try {
      const pack = loadPack(dir);
      const problems: string[] = [];
      if (!(pack.def.secrets ?? []).includes("RFA_TOKEN")) problems.push("does not declare RFA_TOKEN in secrets (it cannot reach an authenticated hub)");
      if ((pack.def.offers ?? []).length === 0) problems.push("offers nothing (a participant join is refused without a skill)");
      const binding = (pack.def.rooms ?? [])[0];
      if (!binding) problems.push("binds to no room (it loads but never serves)");
      else if (binding.room && rooms.length && !rooms.some((r) => r.handle === binding.room)) problems.push(`binds to ${binding.room}, which rooms.json does not list`);
      const files = knowledgeFiles(pack).length;
      if ((pack.def.knowledge ?? []).length > 0 && files === 0) problems.push("knowledge globs resolve to zero files");
      checks.push(problems.length ? warn(`pack-${pack.name}`, `${pack.name}: ${problems.join("; ")}`, "rfa agent show / rfa agent bind / rfa agent edit") : ok(`pack-${pack.name}`, `${pack.name}: valid, ${files} knowledge file${files === 1 ? "" : "s"}, room ${binding?.room ?? "-"}`));
    } catch (err) {
      checks.push(fail(`pack-${entry.name}`, `agents/${entry.name}/agent.md: ${(err as Error).message}`, "rfa agent validate " + entry.name));
    }
  }

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
        checks.push((m.policies?.join_bearer_sha256 ?? []).includes(digest) ? ok(`room-${r.alias}`, `room ${r.alias} admits the operator bearer`) : warn(`room-${r.alias}`, `room ${r.alias} (${r.handle}) does not list the operator bearer: residents need its join secret`, `rfa room allow ${r.alias} --token operator`));
      }
    }
  } catch {
    /* snapshots unreadable while the hub rewrites them: not a verdict */
  }

  // Strays and the supervisor's view.
  const names = new Set(listPacks(packsDir).map((p) => p.name));
  const residents = await residentProcesses();
  let supFile: { agents?: Record<string, { pid: number | null; status: string }>; account?: { paused_until?: string | null } } | null = null;
  try {
    supFile = JSON.parse(fs.readFileSync(h.paths.supervisorState, "utf8"));
  } catch {
    supFile = null;
  }
  const owned = new Set(Object.values(supFile?.agents ?? {}).map((a) => a.pid).filter((p): p is number => typeof p === "number"));
  for (const r of residents) {
    if (names.has(r.agent) && !owned.has(r.pid)) checks.push(fail("stray-resident", `a resident for ${r.agent} (pid ${r.pid}) is running that the supervisor does not own`, "two residents on one membership answer as one; stop it, or rfa agent retire if it is stale"));
  }
  for (const [name, a] of Object.entries(supFile?.agents ?? {})) {
    if (a.status === "crash-looped") checks.push(fail(`crash-${name}`, `${name} is crash-looping; the supervisor gave up until its definition changes`, `rfa logs ${name}`));
    const hb = path.join(packsDir, name, "state", "heartbeat");
    if (a.status === "running" && fs.existsSync(hb)) {
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
