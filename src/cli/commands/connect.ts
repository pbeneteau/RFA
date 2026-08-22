/**
 * Reach (RFA-0.7 sect. 3.6): other MCP hosts, other machines, other
 * organizations.
 *
 * `connect` puts this hub into an MCP host's config with its own bearer;
 * `peer add` hands an agent running elsewhere a bearer and the rooms it may
 * join; `hub expose` fronts the loopback listener with a tailnet name. In every
 * case the credential is minted here, hashed here, shown once, and admitted
 * into rooms by hash (bearer-implied admission, wire 4.3), so no secret ever
 * travels through a chat or a model's context.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listPacks } from "../../agentdef.js";
import { findRoom, roomsStore, tokensStore, writeManifest, type HubDir, type RoomRecord, type TokenRecord } from "../../hubdir.js";
import { packageFile } from "../../pkg.js";
import { CliError, type CliContext } from "../context.js";
import type { CommandDef } from "../router.js";
import { fmtAge } from "../ui.js";
import { mintToken } from "./creds.js";
import { setBearerList } from "./room.js";

/** The /mcp URL a client elsewhere uses: the public name when the hub is exposed, loopback otherwise. */
export function clientHubUrl(h: HubDir): { url: string; reachable: "public" | "loopback" | "remote" } {
  if ("url" in h.manifest.hub) return { url: h.manifest.hub.url, reachable: "remote" };
  if (h.manifest.hub.public_url) return { url: `${h.manifest.hub.public_url.replace(/\/$/, "")}/mcp`, reachable: "public" };
  return { url: `http://127.0.0.1:${h.manifest.hub.port}/mcp`, reachable: "loopback" };
}

/** `--room` values (aliases or handles), or every room the operator created except ops. */
function targetRooms(h: HubDir, refs: string[] | undefined): RoomRecord[] {
  const file = roomsStore(h).read();
  if (refs && refs.length) {
    return refs.map((r) => {
      const rec = findRoom(file, r);
      if (!rec) throw new CliError(2, `no room called ${r}`, "rfa room ls");
      return rec;
    });
  }
  return file.rooms.filter((r) => r.alias !== "ops");
}

async function admitInto(ctx: CliContext, h: HubDir, label: string, rooms: RoomRecord[]): Promise<void> {
  const tok = tokensStore(h).read().tokens.find((t) => t.label === label);
  if (!tok) throw new CliError(1, `bearer ${label} vanished between mint and admission`);
  for (const rec of rooms) {
    if (!rec.operator) throw new CliError(3, `no operator membership for ${rec.alias}`, `rfa room adopt ${rec.handle}`);
    await setBearerList(ctx, h, rec, (l) => [...l, tok.sha256]);
  }
  tokensStore(h).update((f) => {
    const t = f.tokens.find((x) => x.label === label);
    if (t) t.rooms = [...new Set([...(t.rooms ?? []), ...rooms.map((r) => r.handle)])];
  });
}

/** The skill id most likely wanted in a room: the first offer of the packs bound to it. */
function capabilityHint(h: HubDir, room: RoomRecord): string {
  const ids = listPacks(h.paths.agents)
    .filter((p) => (p.def.rooms ?? []).some((b) => b.room === room.handle))
    .flatMap((p) => (p.def.offers ?? []).map((o) => `\`${o.id}\`: ${o.description}`));
  return ids.length ? ids.join("; ") : "whatever skill ids the roster lists";
}

function renderTemplate(file: string, vars: Record<string, string>): string {
  return fs.readFileSync(file, "utf8").replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
}

/** Write the consult-room skill and the ask-room command into a project's .claude/. Exported for tests. */
export function writeProjectSkill(project: string, h: HubDir, room: RoomRecord): string[] {
  const vars = { ROOM_ALIAS: room.alias, ROOM_HANDLE: room.handle, CAPABILITY_HINT: capabilityHint(h, room) };
  const out: string[] = [];
  for (const [src, dest] of [
    [packageFile("templates", "skills", "consult-room", "SKILL.md"), path.join(project, ".claude", "skills", "consult-room", "SKILL.md")],
    [packageFile("templates", "commands", "ask-room.md"), path.join(project, ".claude", "commands", "ask-room.md")],
  ]) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, renderTemplate(src, vars));
    out.push(dest);
  }
  return out;
}

function claudeOnPath(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { encoding: "utf8", timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` })));
}

const mcpConfig = (url: string, token: string) => ({ mcpServers: { rfa: { url, headers: { Authorization: `Bearer ${token}` } } } });

export const connectClaude: CommandDef = {
  path: ["connect", "claude-code"],
  summary: "Register this hub in Claude Code with its own bearer; optionally write a consult-room skill into the current project",
  usage: "[--room <alias|handle> …] [--scope user|project|local] [--label <label>] [--skill] [--print]",
  options: { room: { type: "string", multiple: true }, scope: { type: "string" }, label: { type: "string" }, skill: { type: "boolean", default: false }, print: { type: "boolean", default: false } },
  why: "A session then joins a room with room_join {room} and nothing else: the bearer rides the transport from the MCP config, which is the path measured live on 2026-08-21 (a real host carries a static Authorization header). Each connection gets its OWN bearer, admitted into the rooms you name, so `rfa token revoke` takes one machine out without touching the rest. --skill writes .claude/skills/consult-room/SKILL.md and .claude/commands/ask-room.md into the current project with the room handle baked in.",
  examples: ["rfa connect claude-code", "rfa connect claude-code --room product --scope project --skill", "rfa connect claude-code --print"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const scope = String(a.values.scope ?? "user");
    if (!["user", "project", "local"].includes(scope)) throw new CliError(2, "--scope takes user, project or local");
    const rooms = targetRooms(h, a.values.room as unknown as string[] | undefined);
    if (rooms.length === 0) throw new CliError(3, "no room to admit the session into", "rfa room create <alias> first");
    const label = String(a.values.label ?? `claude-code@${os.hostname().split(".")[0].toLowerCase()}`);
    const { token, id } = mintToken(ctx, label, "client", null, rooms.map((r) => r.handle));
    await admitInto(ctx, h, label, rooms);
    const { url, reachable } = clientHubUrl(h);
    const command = ["mcp", "add", "--transport", "http", "-s", scope, "rfa", url, "--header", `Authorization: Bearer ${token}`];
    ctx.ui.done(`bearer ${label} minted and admitted into ${rooms.map((r) => r.alias).join(", ")}`, id);
    let registered = false;
    if (a.values.print) {
      ctx.ui.blank();
      ctx.ui.line("   claude " + command.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" "));
      ctx.ui.blank();
      ctx.ui.line("   " + JSON.stringify(mcpConfig(url, token)));
    } else {
      if (!claudeOnPath()) throw new CliError(3, "`claude` is not on PATH, so the MCP server was not registered", `run it yourself: claude ${command.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ")}`);
      if (ctx.interactive) {
        const p = await import("@clack/prompts");
        const ok = await p.confirm({ message: `Register \`rfa\` (${url}) in Claude Code's ${scope} config?`, initialValue: true });
        if (p.isCancel(ok) || !ok) throw new CliError(2, "not registered; the bearer is minted", `claude ${command.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ")}`);
      }
      const existing = await run("claude", ["mcp", "get", "rfa"]);
      if (existing.code === 0) await run("claude", ["mcp", "remove", "-s", scope, "rfa"]);
      const res = await run("claude", command);
      if (res.code !== 0) throw new CliError(1, `claude mcp add failed: ${res.out.trim().slice(-300)}`);
      registered = true;
      ctx.ui.done(`registered \`rfa\` in Claude Code (${scope} scope)`, `${url}; sessions can room_join ${rooms.map((r) => r.handle).join(", ")} with no secret`);
    }
    if (reachable === "loopback") ctx.ui.note("the hub is loopback-only: this works for sessions on this machine. For another machine, rfa hub expose --tailscale first.");
    let skillFiles: string[] = [];
    if (a.values.skill) {
      skillFiles = writeProjectSkill(process.cwd(), h, rooms[0]);
      ctx.ui.done(`wrote ${skillFiles.map((f) => path.relative(process.cwd(), f)).join(" and ")}`, `room ${rooms[0].alias} (${rooms[0].handle}); /ask-room "<question>" in a session`);
    }
    if (ctx.flags.json) ctx.ui.json({ label, id, token, url, rooms: rooms.map((r) => ({ alias: r.alias, handle: r.handle })), registered, scope, command: ["claude", ...command], config: mcpConfig(url, token), skill_files: skillFiles });
  },
};

const printConfig = (host: string): CommandDef => ({
  path: ["connect", host],
  summary: host === "cursor" ? "A bearer and the MCP config to paste into Cursor" : "A bearer and a generic MCP config (url + Authorization header) for any host",
  usage: "[--room <alias|handle> …] [--label <label>]",
  options: { room: { type: "string", multiple: true }, label: { type: "string" } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const rooms = targetRooms(h, a.values.room as unknown as string[] | undefined);
    if (rooms.length === 0) throw new CliError(3, "no room to admit the client into", "rfa room create <alias> first");
    const label = String(a.values.label ?? `${host}@${os.hostname().split(".")[0].toLowerCase()}`);
    const { token, id } = mintToken(ctx, label, "client", null, rooms.map((r) => r.handle));
    await admitInto(ctx, h, label, rooms);
    const { url, reachable } = clientHubUrl(h);
    const config = mcpConfig(url, token);
    if (ctx.flags.json) return void ctx.ui.json({ label, id, token, url, rooms: rooms.map((r) => ({ alias: r.alias, handle: r.handle })), config });
    ctx.ui.done(`bearer ${label} minted and admitted into ${rooms.map((r) => r.alias).join(", ")}`, `${id}; shown once below`);
    ctx.ui.blank();
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    ctx.ui.blank();
    ctx.ui.note(host === "cursor" ? "paste into Cursor's MCP settings (mcp.json)" : "the shape every MCP host takes: a URL and an Authorization header", `rooms to join: ${rooms.map((r) => `${r.alias} = ${r.handle}`).join(", ")}; no join_secret`);
    if (reachable === "loopback") ctx.ui.note("the hub is loopback-only: for a host on another machine, rfa hub expose --tailscale first");
  },
});
export const connectCursor = printConfig("cursor");
export const connectMcp = printConfig("mcp");

// ---------------------------------------------------------------- peers

function credentialBlock(ctx: CliContext, h: HubDir, name: string, token: string | null, rooms: RoomRecord[]): void {
  const ui = ctx.ui;
  const { url, reachable } = clientHubUrl(h);
  ui.blank();
  ui.line(`   ${ui.bold(`what ${name} needs`)}`);
  ui.table(
    [
      ["hub", `${url}${reachable === "loopback" ? ui.caution("   (loopback: reachable from this machine only until rfa hub expose)") : ""}`],
      ["rooms", rooms.map((r) => `${r.handle}  ${ui.dim(r.alias)}`).join("\n")],
      ["credential", token ? ui.bold(token) : ui.dim("(shown once, at rfa peer add)")],
      ["how", `Authorization: Bearer <credential> on every request to ${url}; room_join {room, name, card} with NO join_secret`],
      ["guide", `rfa docs interop --path   ${ui.dim("(everything a stranger needs; verified by one)")}`],
      ["client", `python3 $(rfa docs client --path) --hub ${url} --room ${rooms[0]?.handle ?? "r_…"} --name ${name} --token <credential>`],
    ],
    { indent: 5 },
  );
  ui.blank();
  ui.note("its members are stamped home: local (an agent of your own organization running elsewhere).", "A guest of ANOTHER organization needs the admission record and a signed card of RFA-0.6 sect. 3: rfa peer add --home, gated on a named counterparty.");
}

export const peerAdd: CommandDef = {
  path: ["peer", "add"],
  summary: "Admit an agent running elsewhere: a bearer of its own, the rooms it may join, the credential block to hand over",
  usage: "<name> [--room <alias|handle> …] [--expires 90d] [--home <org>]",
  options: { room: { type: "string", multiple: true }, expires: { type: "string" }, home: { type: "string" } },
  why: "The named counterparty today is the operator's own agents on other machines (a LangChain agent on a VPS, a colleague's Claude Code): accountable-local, unsupervisable by this hub. They get a per-peer bearer, admitted into rooms by hash, revocable alone. A guest of another organization (home other than local) is the admission record, the invite and the signed card of RFA-0.6 sect. 3, which stays gated on a counterparty the operator does not control; the flag exists so the command does not change shape when that lands.",
  examples: ["rfa peer add langchain-vps --room product --expires 90d"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = a.positionals[0];
    if (!name || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) throw new CliError(2, "rfa peer add <name>: lowercase letters, digits, dots, hyphens");
    const home = a.values.home as string | undefined;
    if (home && home !== "local") {
      throw new CliError(2, `a guest (home ${home}) needs the admission record, the invite and the signed card of RFA-0.6 sect. 3, which is gated on a counterparty the operator does not control (v0.5 sect. 22, rung 11)`, "for an agent of your own organization running elsewhere, omit --home");
    }
    const rooms = targetRooms(h, a.values.room as unknown as string[] | undefined);
    if (rooms.length === 0) throw new CliError(3, "no room to admit the peer into", "rfa room create <alias> first, or --room");
    const { parseExpiry } = await import("./creds.js");
    const expires = parseExpiry(a.values.expires);
    const { token, id } = mintToken(ctx, name, "peer", expires, rooms.map((r) => r.handle));
    await admitInto(ctx, h, name, rooms);
    ctx.ui.done(`peer ${name}`, `${id}${expires ? `, expires ${expires.slice(0, 10)}` : ""}; admitted into ${rooms.map((r) => r.alias).join(", ")}`);
    if (ctx.flags.json) return void ctx.ui.json({ name, id, token, expires_at: expires, hub: clientHubUrl(h), rooms: rooms.map((r) => ({ alias: r.alias, handle: r.handle })) });
    credentialBlock(ctx, h, name, token, rooms);
  },
};

function peersOf(h: HubDir): (TokenRecord & { aliases: string[] })[] {
  const rooms = roomsStore(h).read().rooms;
  return tokensStore(h)
    .read()
    .tokens.filter((t) => t.kind === "peer")
    .map((t) => ({ ...t, aliases: (t.rooms ?? []).map((handle) => rooms.find((r) => r.handle === handle)?.alias ?? handle) }));
}

export const peerLs: CommandDef = {
  path: ["peer", "ls"],
  summary: "Peers admitted to this hub",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const peers = peersOf(h);
    if (ctx.flags.json) return void ctx.ui.json(peers);
    if (peers.length === 0) return void ctx.ui.note("no peers: rfa peer add <name>");
    const now = Date.now();
    ctx.ui.table(peers.map((p) => [p.label, ctx.ui.dim(p.id), `rooms ${p.aliases.join(", ") || "-"}`, `added ${fmtAge(p.created_at)}`, p.expires_at ? (Date.parse(p.expires_at) < now ? ctx.ui.bad("expired") : `expires ${p.expires_at.slice(0, 10)}`) : ""]));
  },
};

export const peerShow: CommandDef = {
  path: ["peer", "show"],
  summary: "One peer and the block it was handed (minus the credential, shown once at add)",
  usage: "<name>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = a.positionals[0];
    const p = peersOf(h).find((x) => x.label === name);
    if (!name || !p) throw new CliError(2, `no peer called ${name ?? ""}`, "rfa peer ls");
    const rooms = roomsStore(h).read().rooms.filter((r) => (p.rooms ?? []).includes(r.handle));
    if (ctx.flags.json) return void ctx.ui.json({ ...p, hub: clientHubUrl(h), rooms: rooms.map((r) => ({ alias: r.alias, handle: r.handle })) });
    ctx.ui.line(`${ctx.ui.bold(p.label)}  ${ctx.ui.dim(p.id)}  added ${fmtAge(p.created_at)}${p.expires_at ? `, expires ${p.expires_at.slice(0, 10)}` : ""}`);
    credentialBlock(ctx, h, p.label, null, rooms);
  },
};

export const peerRevoke: CommandDef = {
  path: ["peer", "revoke"],
  summary: "Revoke a peer's bearer and its room admissions; its next request is refused",
  usage: "<name>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = a.positionals[0];
    const p = peersOf(h).find((x) => x.label === name);
    if (!name || !p) throw new CliError(2, `no peer called ${name ?? ""}`, "rfa peer ls");
    const rooms = roomsStore(h).read().rooms.filter((r) => (p.rooms ?? []).includes(r.handle));
    for (const rec of rooms) if (rec.operator) await setBearerList(ctx, h, rec, (l) => l.filter((x) => x !== p.sha256));
    tokensStore(h).update((f) => {
      f.tokens = f.tokens.filter((t) => t.id !== p.id);
    });
    ctx.ui.done(`revoked ${name}`, `${p.id}; removed from ${rooms.map((r) => r.alias).join(", ") || "no room"}`);
    ctx.ui.note("its memberships lapse offline at their lease; rfa room evict <alias> <member> takes them out of the roster now");
  },
};

// ---------------------------------------------------------------- expose

function tailscaleBinary(): string | null {
  for (const candidate of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore", timeout: 10_000 });
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

export const hubExpose: CommandDef = {
  path: ["hub", "expose"],
  summary: "Front the loopback hub with a tailnet name (tailscale serve) and record it as hub.public_url",
  usage: "--tailscale [--off] [--dry-run]",
  options: { tailscale: { type: "boolean", default: false }, off: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false } },
  why: "The listener stays on loopback (v0.5 sect. 15.1); a proxy that terminates identity forwards to it. `tailscale serve` proxies only http://127.0.0.1, which is why the hub can stay loopback-bound and still be reachable from a phone or another machine on the tailnet. The public name becomes hub.public_url, which allows the console's origin and points push links at it; the hub reads it at start, so rfa restart afterwards.",
  examples: ["rfa hub expose --tailscale", "rfa hub expose --tailscale --off"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    if (!a.values.tailscale) throw new CliError(2, "rfa hub expose --tailscale [--off]", "other proxies: put one in front of http://127.0.0.1:<port> that terminates TLS, then rfa config set hub.public_url https://<name>");
    if (!("port" in h.manifest.hub)) throw new CliError(3, "this directory runs no hub");
    const port = h.manifest.hub.port;
    const bin = tailscaleBinary();
    const serveArgs = a.values.off ? ["serve", "--https=443", "off"] : ["serve", "--bg", `--https=443`, `http://127.0.0.1:${port}`];
    if (a.values["dry-run"] || !bin) {
      if (!bin) ctx.ui.warn("no tailscale binary found (PATH or /Applications/Tailscale.app)");
      ctx.ui.line(`   tailscale ${serveArgs.join(" ")}`);
      ctx.ui.line(`   tailscale status --json    ${ctx.ui.dim("→ Self.DNSName is the public name")}`);
      ctx.ui.line(`   rfa config set hub.public_url https://<that name>`);
      ctx.ui.line(`   rfa restart`);
      return bin ? 0 : 3;
    }
    const res = await run(bin, serveArgs);
    if (res.code !== 0) throw new CliError(1, `tailscale serve failed: ${res.out.trim().slice(-300)}`);
    if (a.values.off) {
      const m = JSON.parse(JSON.stringify(h.manifest)) as typeof h.manifest;
      if ("port" in m.hub) m.hub.public_url = null;
      writeManifest(h.root, m);
      ctx.ui.done("tailscale serve off; hub.public_url cleared", "rfa restart to apply");
      return;
    }
    const status = await run(bin, ["status", "--json"]);
    const dns = (JSON.parse(status.out || "{}") as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "");
    if (!dns) throw new CliError(1, "tailscale serve is on, but the tailnet name could not be read from tailscale status --json", "rfa config set hub.public_url https://<your tailnet name>");
    const m = JSON.parse(JSON.stringify(h.manifest)) as typeof h.manifest;
    if ("port" in m.hub) m.hub.public_url = `https://${dns}`;
    writeManifest(h.root, m);
    ctx.ui.done(`serving https://${dns} -> http://127.0.0.1:${port}`, "hub.public_url set; rfa restart to apply (console origin, push links)");
    ctx.ui.note(`console: https://${dns}/console · /mcp for peers with a bearer: rfa peer add`);
  },
};
