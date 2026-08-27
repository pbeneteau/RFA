/**
 * Credentials and configuration (RFA-0.7 sect. 2.4 and 3.5): humans, bearers,
 * secrets, the signing keys, and rfa.json through its schema. Every value is
 * shown once or prompted with echo off; nothing secret ever travels on argv.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tokenDigest } from "../../credentials.js";
import { manifestSchema, principalsStore, secretsStore, tokensStore, writeManifest, type Manifest, type TokenKind } from "../../hubdir.js";
import { principalRecordFor } from "../../principals.js";
import { generateSigningKey, signCard, verifyCard } from "../../signing.js";
import { CliError, type CliContext } from "../context.js";
import type { CommandDef } from "../router.js";
import { nameProblem } from "../scaffold.js";
import { fmtAge } from "../ui.js";

const mint = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

/** A value from a hidden prompt, stdin, or a named environment variable: never an argument. */
async function readSecretValue(ctx: CliContext, label: string, a: Record<string, unknown>): Promise<string> {
  if (a["from-env"]) {
    const v = ctx.env[String(a["from-env"])];
    if (!v) throw new CliError(2, `${String(a["from-env"])} is not set in this shell`);
    return v;
  }
  if (a.stdin || !ctx.interactive) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const v = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!v) throw new CliError(2, `no value on stdin for ${label}`, "pipe it: printf '%s' \"$VALUE\" | rfa secrets set NAME --stdin");
    return v;
  }
  const p = await import("@clack/prompts");
  const v = await p.password({ message: `Value for ${label}` });
  if (p.isCancel(v) || !v) throw new CliError(2, "nothing written");
  return v;
}

function showOnce(ctx: CliContext, what: string, value: string, note: string): void {
  const ui = ctx.ui;
  ui.blank();
  ui.line(`   ${what}, shown once:`);
  ui.blank();
  ui.line(`     ${ui.bold(value)}`);
  ui.blank();
  ui.note(note);
}

// ---------------------------------------------------------------- human

export const humanAdd: CommandDef = {
  path: ["human", "add"],
  summary: "Mint a human principal's key (hashed at rest, shown once)",
  usage: "<label>",
  why: "Only a human principal can approve an agent's action, lift a quarantine, supervise a room or unlock the console. The key is hashed into .rfa/principals.json; the person it is for keeps the plaintext. The first human's key is also kept in .rfa/secrets.json as RFA_HUMAN_KEY, because the CLI acts as that human.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const label = a.positionals[0];
    if (!label) throw new CliError(2, "a label is required: rfa human add <label>");
    const problem = nameProblem(label) ?? (/^[a-z0-9][a-z0-9.-]*$/.test(label) ? null : "lowercase letters, digits, dots and hyphens");
    if (problem) throw new CliError(2, problem);
    const store = principalsStore(h);
    if (store.read().principals.some((p) => p.label === label)) throw new CliError(2, `a principal labelled ${label} exists`, `rfa human rotate ${label} replaces its key`);
    const key = mint("hk");
    const rec = principalRecordFor(key, label);
    store.update((f) => {
      f.principals.push(rec);
    });
    const secrets = secretsStore(h);
    let operator = false;
    if (!secrets.read().RFA_HUMAN_KEY) {
      secrets.update((s) => {
        s.RFA_HUMAN_KEY = key;
      });
      operator = true;
    }
    ctx.ui.done(`human principal ${label}`, `${rec.id}; ${operator ? "this CLI now acts as them" : "hand them the key below"}`);
    if (ctx.flags.json) return void ctx.ui.json({ id: rec.id, label, key, operator });
    showOnce(ctx, `${label}'s human key`, key, "It unlocks the console and is the only thing that can approve. The hub reloads the file: it works on the next request.");
  },
};

export const humanLs: CommandDef = {
  path: ["human", "ls"],
  summary: "The human principals this hub recognizes",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const list = principalsStore(h).read().principals;
    const mine = ctx.humanKey();
    const { principalIdFor } = await import("../../principals.js");
    const myId = mine ? principalIdFor(mine) : null;
    if (ctx.flags.json) return void ctx.ui.json(list.map((p) => ({ ...p, operator: p.id === myId })));
    if (list.length === 0) return void ctx.ui.note("none: rfa human add <label>");
    ctx.ui.table(list.map((p) => [p.label, ctx.ui.dim(p.id), `created ${fmtAge(p.created_at)}`, p.id === myId ? ctx.ui.accent("this CLI") : ""]));
  },
};

export const humanRotate: CommandDef = {
  path: ["human", "rotate"],
  summary: "Replace a principal's key (the old one stops matching on the next request)",
  usage: "<label>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const label = a.positionals[0];
    if (!label) throw new CliError(2, "rfa human rotate <label>");
    const store = principalsStore(h);
    const old = store.read().principals.find((p) => p.label === label);
    if (!old) throw new CliError(2, `no principal labelled ${label}`, "rfa human ls");
    const key = mint("hk");
    const rec = principalRecordFor(key, label);
    store.update((f) => {
      f.principals = f.principals.filter((p) => p.label !== label).concat(rec);
    });
    const secrets = secretsStore(h);
    const { principalIdFor } = await import("../../principals.js");
    const mine = secrets.read().RFA_HUMAN_KEY;
    const wasMine = mine ? principalIdFor(mine) === old.id : false;
    if (wasMine) {
      secrets.update((s) => {
        s.RFA_HUMAN_KEY = key;
      });
    }
    ctx.ui.done(`rotated ${label}`, `${old.id} -> ${rec.id}${wasMine ? "; this CLI's own copy updated" : ""}`);
    if (ctx.flags.json) return void ctx.ui.json({ id: rec.id, label, key, operator: wasMine });
    showOnce(ctx, `${label}'s new human key`, key, "Console sessions opened with the old key keep working until they expire (12h); new unlocks need this one.");
  },
};

export const humanRemove: CommandDef = {
  path: ["human", "remove"],
  summary: "Remove a principal (never the last one, never this CLI's own without --force)",
  usage: "<label> [--force]",
  options: { force: { type: "boolean", default: false } },
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const label = a.positionals[0];
    if (!label) throw new CliError(2, "rfa human remove <label>");
    const store = principalsStore(h);
    const list = store.read().principals;
    const rec = list.find((p) => p.label === label);
    if (!rec) throw new CliError(2, `no principal labelled ${label}`);
    if (list.length === 1) throw new CliError(2, "refusing to remove the last human principal: nobody could approve anything", "add another first");
    const { principalIdFor } = await import("../../principals.js");
    const mine = ctx.humanKey();
    if (mine && principalIdFor(mine) === rec.id && !a.values.force) throw new CliError(2, `${label} is this CLI's own principal`, "--force removes it anyway; the CLI then cannot act as a human until rfa human add");
    store.update((f) => {
      f.principals = f.principals.filter((p) => p.label !== label);
    });
    ctx.ui.done(`removed ${label}`, `${rec.id} stops matching on the hub's next request`);
  },
};

// ---------------------------------------------------------------- token

export function parseExpiry(v: unknown): string | null {
  if (!v) return null;
  const m = /^(\d+)([dhm])$/.exec(String(v));
  if (!m) {
    const t = Date.parse(String(v));
    if (Number.isNaN(t)) throw new CliError(2, `--expires takes 90d, 12h, 30m or an ISO date, not ${String(v)}`);
    return new Date(t).toISOString();
  }
  const n = Number(m[1]);
  const ms = m[2] === "d" ? n * 86_400_000 : m[2] === "h" ? n * 3_600_000 : n * 60_000;
  return new Date(Date.now() + ms).toISOString();
}

/** Mint a bearer of a kind, hashed into tokens.json. Exported for `connect` and `peer`. Returns the plaintext, once. */
export function mintToken(ctx: CliContext, label: string, kind: TokenKind, expires: string | null, rooms: string[] = []): { token: string; id: string } {
  const h = ctx.hubdir();
  const store = tokensStore(h);
  if (store.read().tokens.some((t) => t.label === label)) throw new CliError(2, `a bearer labelled ${label} exists`, `rfa token revoke ${label} first, or pick another label`);
  const token = mint(kind === "operator" ? "tok" : kind === "client" ? "cli" : "peer");
  const sha256 = tokenDigest(token);
  const id = `tk_${sha256.slice(0, 12)}`;
  store.update((f) => {
    f.tokens.push({ id, label, kind, sha256, created_at: new Date().toISOString(), expires_at: expires, ...(rooms.length ? { rooms } : {}) });
  });
  return { token, id };
}

export const tokenMint: CommandDef = {
  path: ["token", "mint"],
  summary: "Mint a transport bearer (hashed at rest, shown once)",
  usage: "<label> [--kind client|peer|operator] [--expires 90d]",
  options: { kind: { type: "string" }, expires: { type: "string" } },
  why: "A bearer is what reaches /mcp at all. `client` is for your own MCP hosts (rfa connect mints these for you), `peer` for an agent running elsewhere (rfa peer add), `operator` rotates the bearer every resident and this CLI use, which locks out every resident until the supervisor restarts them. Rooms admit a bearer separately: rfa room allow.",
  run: async (ctx, a) => {
    const label = a.positionals[0];
    if (!label) throw new CliError(2, "rfa token mint <label> [--kind client|peer|operator]");
    const kind = (a.values.kind as TokenKind | undefined) ?? "client";
    if (!["client", "peer", "operator"].includes(kind)) throw new CliError(2, `--kind takes client, peer or operator`);
    const expires = parseExpiry(a.values.expires);
    const h = ctx.hubdir();
    if (kind === "operator") {
      const store = tokensStore(h);
      store.update((f) => {
        f.tokens = f.tokens.filter((t) => t.kind !== "operator");
      });
    }
    const { token, id } = mintToken(ctx, label, kind, expires);
    if (kind === "operator") {
      secretsStore(h).update((s) => {
        s.RFA_TOKEN = token;
      });
      ctx.ui.done(`operator bearer rotated`, `${id}; residents pick it up when the supervisor restarts them (rfa restart)`);
    } else ctx.ui.done(`bearer ${label} (${kind})`, `${id}${expires ? `, expires ${expires}` : ""}`);
    if (ctx.flags.json) return void ctx.ui.json({ id, label, kind, token, expires_at: expires });
    if (kind !== "operator") showOnce(ctx, `the bearer for ${label}`, token, `It goes in an Authorization: Bearer header on every request to ${ctx.hubUrl()}. Allow it into a room: rfa room allow <alias> --token ${label}.`);
  },
};

export const tokenLs: CommandDef = {
  path: ["token", "ls"],
  summary: "The bearers this hub accepts",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const list = tokensStore(h).read().tokens;
    if (ctx.flags.json) return void ctx.ui.json(list);
    if (list.length === 0) return void ctx.ui.note("none: the hub runs UNAUTHENTICATED. rfa token mint operator");
    const now = Date.now();
    ctx.ui.table(list.map((t) => [t.label, t.kind, ctx.ui.dim(t.id), `created ${fmtAge(t.created_at)}`, t.expires_at ? (Date.parse(t.expires_at) < now ? ctx.ui.bad("expired") : `expires ${t.expires_at.slice(0, 10)}`) : "", t.rooms?.length ? ctx.ui.dim(`rooms ${t.rooms.join(",")}`) : ""]));
  },
};

export const tokenRevoke: CommandDef = {
  path: ["token", "revoke"],
  summary: "Revoke a bearer: the hub refuses it on the next request",
  usage: "<label>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const label = a.positionals[0];
    if (!label) throw new CliError(2, "rfa token revoke <label>");
    const store = tokensStore(h);
    const rec = store.read().tokens.find((t) => t.label === label);
    if (!rec) throw new CliError(2, `no bearer labelled ${label}`, "rfa token ls");
    if (rec.kind === "operator") throw new CliError(2, "the operator bearer is rotated, not revoked: rfa token mint <label> --kind operator");
    store.update((f) => {
      f.tokens = f.tokens.filter((t) => t.label !== label);
    });
    ctx.ui.done(`revoked ${label}`, `${rec.id}; its next request is refused. Its room admissions stay listed by hash and match nothing: rfa room disallow tidies them`);
  },
};

// ---------------------------------------------------------------- secrets

export const secretsSet: CommandDef = {
  path: ["secrets", "set"],
  summary: "Set a secret by name (prompted with echo off, from stdin, or from an environment variable)",
  usage: "<NAME> [--stdin | --from-env VAR]",
  options: { stdin: { type: "boolean", default: false }, "from-env": { type: "string" } },
  why: "Values live in .rfa/secrets.json, 0600, and nowhere else; packs declare NAMES and the supervisor injects only those. A value never travels on the command line: argv is readable in `ps` by every user on the machine, which is how a human key was once found sitting in a process list.",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = a.positionals[0];
    if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) throw new CliError(2, "a secret NAME is uppercase with underscores: rfa secrets set LINEAR_API_KEY");
    const value = await readSecretValue(ctx, name, a.values);
    const existed = name in secretsStore(h).read();
    secretsStore(h).update((s) => {
      s[name] = value;
    });
    ctx.ui.done(`${existed ? "updated" : "set"} ${name}`, `${value.length} characters; packs that declare it get it when the supervisor (re)starts them`);
  },
};

export const secretsLs: CommandDef = {
  path: ["secrets", "ls"],
  summary: "The secret names (never the values) and which packs declare them",
  run: async (ctx) => {
    const h = ctx.hubdir();
    const s = secretsStore(h).read();
    // TOLERANT and named. `listPacks` maps `loadPack` with no catch, so one bad
    // definition answered `rfa secrets ls` with a parse error instead of the
    // secrets. Named because the "declared by" column is the whole point of this
    // listing and a broken pack's declarations are unreadable: without the
    // warning, a secret only that pack needs reads as "declared by no pack",
    // which is an invitation to unset it.
    const { scanPacks, declaredSecretNames } = await import("../../agentdef.js");
    const { packs, broken } = scanPacks(h.paths.agents);
    const users = new Map<string, string[]>();
    for (const p of packs) for (const n of declaredSecretNames(p.def)) users.set(n, [...(users.get(n) ?? []), p.name]);
    const rows = Object.keys(s).sort().map((n) => ({ name: n, length: s[n].length, declared_by: users.get(n) ?? [] }));
    const missing = [...users.keys()].filter((n) => !(n in s));
    if (ctx.flags.json) return void ctx.ui.json({ secrets: rows, missing, broken_packs: broken });
    ctx.ui.table(rows.map((r) => [r.name, ctx.ui.dim(`${r.length} chars`), r.declared_by.length ? `used by ${r.declared_by.join(", ")}` : ctx.ui.dim("declared by no pack")]));
    for (const n of missing) ctx.ui.warn(`${n} is declared by ${users.get(n)!.join(", ")} and not set`, `rfa secrets set ${n}`);
    for (const b of broken) ctx.ui.warn(`agents/${b.name}/agent.md does not parse, so the secrets IT declares are missing from the column above: ${b.error}`, `rfa agent validate ${b.name}`);
  },
};

export const secretsUnset: CommandDef = {
  path: ["secrets", "unset"],
  summary: "Remove a secret",
  usage: "<NAME>",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const name = a.positionals[0];
    if (!name) throw new CliError(2, "rfa secrets unset <NAME>");
    if (name === "RFA_TOKEN" || name === "RFA_HUMAN_KEY") throw new CliError(2, `${name} is the CLI's own credential; rotate it instead`, name === "RFA_TOKEN" ? "rfa token mint <label> --kind operator" : "rfa human rotate <label>");
    const existed = name in secretsStore(h).read();
    secretsStore(h).update((s) => {
      delete s[name];
    });
    ctx.ui.done(existed ? `removed ${name}` : `${name} was not set`);
  },
};

// ---------------------------------------------------------------- config

function getPath(obj: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, keys: string[], value: unknown): void {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}
function coerce(v: string): unknown {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^[\[{]/.test(v)) {
    try {
      return JSON.parse(v);
    } catch {
      /* a string after all */
    }
  }
  return v;
}

export const configShow: CommandDef = {
  path: ["config", "show"],
  summary: "rfa.json with every default filled in",
  run: async (ctx) => {
    const h = ctx.hubdir();
    if (ctx.flags.json) return void ctx.ui.json(h.manifest);
    process.stdout.write(JSON.stringify(h.manifest, null, 2) + "\n");
  },
};

export const configGet: CommandDef = {
  path: ["config", "get"],
  summary: "One value, by dotted key",
  usage: "<key>  (hub.port, agents.env, retention.backup_dir …)",
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const key = a.positionals[0];
    if (!key) throw new CliError(2, "rfa config get <key>");
    const v = getPath(h.manifest, key.split("."));
    if (v === undefined) throw new CliError(2, `no such key: ${key}`, "rfa config show lists them");
    process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\n");
  },
};

const NEEDS_RESTART = ["hub.port", "hub.bind", "hub.public_url", "hub.allow_origins", "hub.otel", "hub.gate", "hub.require_signed_cards", "hub.trusted_keys", "hub.push_url", "paths.runtime", "agents.dir", "agents.max_inflight", "agents.env"];

export const configSet: CommandDef = {
  path: ["config", "set"],
  summary: "Set a value, validated through the schema; says when a restart is needed",
  usage: "<key> <value>",
  examples: ["rfa config set hub.public_url https://rfa.acme.example", "rfa config set agents.env inherit", "rfa config set hub.allow_origins '[\"https://app.acme.example\"]'"],
  run: async (ctx, a) => {
    const h = ctx.hubdir();
    const [key, raw] = a.positionals;
    if (!key || raw === undefined) throw new CliError(2, "rfa config set <key> <value>");
    const next = JSON.parse(JSON.stringify(h.manifest)) as Record<string, unknown>;
    setPath(next, key.split("."), coerce(raw));
    const parsed = manifestSchema.safeParse(next);
    if (!parsed.success) {
      // The deepest issue: a union over the hub shapes reports "Invalid input (at
      // hub)" at the top while the useful sentence sits one level down.
      const flat = (issues: { path: PropertyKey[]; message: string; errors?: { path: PropertyKey[]; message: string }[][] }[]): { path: PropertyKey[]; message: string }[] =>
        issues.flatMap((i) => (i.errors?.length ? flat(i.errors.flat() as never) : [{ path: i.path, message: i.message }]));
      const issue = flat(parsed.error.issues as never).sort((x, y) => y.path.length - x.path.length)[0];
      throw new CliError(2, `${key}: ${issue.message}${issue.path.length ? ` (at ${issue.path.join(".")})` : ""}`);
    }
    writeManifest(h.root, parsed.data as Manifest);
    ctx.ui.done(`${key} = ${raw}`, NEEDS_RESTART.includes(key) ? "restart to apply: rfa restart" : "applies to the next command");
  },
};

// ---------------------------------------------------------------- key

export const keyNew: CommandDef = {
  path: ["key", "new"],
  summary: "Generate a signing key for the signing profile (EdDSA, or ES256)",
  usage: "[--alg es256] [--out <prefix>]",
  options: { alg: { type: "string" }, out: { type: "string" } },
  why: "Cards signed with a key a hub trusts verify at join and at rotation (wire 6.1); a strict hub (`hub.require_signed_cards`) refuses the rest. The private half is written 0600; the public half is what goes into policies/trusted-keys.json.",
  run: async (ctx, a) => {
    const alg = String(a.values.alg ?? "eddsa").toLowerCase() === "es256" ? "ES256" : "EdDSA";
    const key = generateSigningKey(alg);
    const prefix = a.values.out as string | undefined;
    if (!prefix) return void process.stdout.write(JSON.stringify(key, null, 2) + "\n");
    fs.writeFileSync(`${prefix}.key.json`, JSON.stringify(key, null, 2), { mode: 0o600 });
    fs.writeFileSync(`${prefix}.pub.json`, JSON.stringify({ [key.kid]: key.publicJwk }, null, 2));
    ctx.ui.done(`${path.basename(prefix)}.key.json (private, 0600) and ${path.basename(prefix)}.pub.json`, `kid ${key.kid}, ${alg}`);
    ctx.ui.note("the .pub.json is a kid -> public JWK map: merge it into policies/trusted-keys.json and set hub.trusted_keys");
  },
};

export const keySign: CommandDef = {
  path: ["key", "sign"],
  summary: "Sign an agent card with a key from `rfa key new`",
  usage: "<card.json> <key.json>",
  run: async (_ctx, a) => {
    const [cardPath, keyPath] = a.positionals;
    if (!cardPath || !keyPath) throw new CliError(2, "rfa key sign <card.json> <key.json> > card.signed.json");
    const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));
    const key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    const signed = signCard(card, key);
    const check = verifyCard(signed);
    process.stderr.write(`signed with kid ${key.kid} (${key.alg}); self-check verified=${check.verified}\n`);
    process.stdout.write(JSON.stringify(signed, null, 2) + "\n");
  },
};
