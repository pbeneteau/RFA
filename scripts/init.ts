/**
 * Bring up a NEW environment: secrets, a human key, and the next three commands.
 *
 *   npm run init                      set up this checkout, print what to do next
 *   npm run init -- --agent my-agent  and scaffold the first agent pack
 *   npm run init -- --force           re-issue credentials into an existing data dir
 *
 * Why this exists. A fresh clone has no `data/`, no `dogfood/state/`, and no
 * `dogfood/ROOM.md`, because all three are gitignored (they hold secrets and
 * runtime state, which is correct). Six tools read `dogfood/ROOM.md`, so before
 * this script a new operator's first command died on an unhandled ENOENT stack
 * trace with no hint about what to create. That is a poor first five minutes for
 * something an organization is meant to self-host.
 *
 * What it deliberately does NOT do:
 *
 *   - It does not start anything. A script that launches a hub, a supervisor and
 *     an agent leaves an operator who has never seen the parts running four
 *     processes they cannot name. It prints the commands instead.
 *   - It does not create a room. The first resident does that (a pack with no
 *     `rooms:` binding creates one and publishes the join info), so there is one
 *     code path for room creation rather than two that can disagree.
 *   - It does not overwrite an existing credential without `--force`. Rotating a
 *     join secret silently would lock out every resident already holding it.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const has = (f: string) => process.argv.includes(`--${f}`);
const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const force = has("force");
const agentName = flag("agent");
// The port is part of an environment's identity, not a detail. A resident's hub URL
// defaults to localhost:8790, so a SECOND environment whose agents are not told
// otherwise points them at the FIRST environment's hub. Measured while testing this
// script: a fresh checkout's agent tried to join the live hub and was saved only by
// the transport credential answering 401. That is defence working, not a design.
const port = flag("port") ?? "8790";
const SECRETS = path.join(ROOT, "data", "secrets.json");
const HUMAN_KEY = path.join(ROOT, "dogfood", "state", "human-key.txt");

/** A credential, not a password: 32 bytes of CSPRNG, url-safe so it survives a shell and a header. */
const token = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

console.log("rfa: initialising this checkout\n");

// ---------------------------------------------------------------- secrets
fs.mkdirSync(path.dirname(SECRETS), { recursive: true });
let secrets: Record<string, string> = {};
const secretsExisted = fs.existsSync(SECRETS);
if (secretsExisted) {
  try {
    secrets = JSON.parse(fs.readFileSync(SECRETS, "utf8")) as Record<string, string>;
  } catch {
    console.error(`  ${path.relative(ROOT, SECRETS)} exists but is not readable JSON. Move it aside and re-run.`);
    process.exit(1);
  }
}

// RFA_JOIN_SECRET is what a resident presents to join a room it did not create.
// RFA_TOKEN is the transport credential for an authenticated /mcp (spec 4.2), and
// every local tool resolves it through transportToken() rather than the environment.
const wanted = ["RFA_JOIN_SECRET", "RFA_TOKEN"] as const;
const added: string[] = [];
for (const key of wanted) {
  if (secrets[key] && !force) continue;
  if (secrets[key] && force) console.log(`  rotating ${key} (--force)`);
  secrets[key] = token(key === "RFA_TOKEN" ? "tok" : "js");
  added.push(key);
}
// 0600 on the file itself, not just the directory: this is the one file in the repo
// that holds live credentials, and the supervisor injects only the names a pack declares.
fs.writeFileSync(SECRETS, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(SECRETS, 0o600);
console.log(
  added.length > 0
    ? `  ${secretsExisted ? "updated" : "created"} ${path.relative(ROOT, SECRETS)} (0600): ${added.join(", ")}`
    : `  ${path.relative(ROOT, SECRETS)} already has ${wanted.join(" and ")}; left alone (--force to rotate)`,
);

// ---------------------------------------------------------------- human key
fs.mkdirSync(path.dirname(HUMAN_KEY), { recursive: true });
if (fs.existsSync(HUMAN_KEY) && !force) {
  console.log(`  ${path.relative(ROOT, HUMAN_KEY)} already exists; left alone (--force to rotate)`);
} else {
  fs.writeFileSync(HUMAN_KEY, token("hk") + "\n", { mode: 0o600 });
  fs.chmodSync(HUMAN_KEY, 0o600);
  console.log(`  created ${path.relative(ROOT, HUMAN_KEY)} (0600)`);
}

// ---------------------------------------------------------------- first pack
if (agentName) {
  console.log(`\nrfa: scaffolding the first agent pack "${agentName}"`);
  try {
    // Delegated, never reimplemented: new-agent validates the result through the
    // same schema the supervisor uses, so a generated pack cannot be one the
    // platform then rejects. `--no-room` because no room exists yet, and a pack
    // with no binding is exactly what makes the first resident create one.
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", path.join(ROOT, "scripts", "new-agent.ts"), agentName, "--no-room"],
      { cwd: ROOT, encoding: "utf8" },
    );
    console.log(
      out
        .trim()
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  } catch (err) {
    console.error(`  scaffolding failed: ${(err as Error).message.split("\n")[0]}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- next steps
const packs = fs.existsSync(path.join(ROOT, "agents"))
  ? fs.readdirSync(path.join(ROOT, "agents")).filter((d) => fs.existsSync(path.join(ROOT, "agents", d, "agent.md")))
  : [];

console.log(`
rfa: ready. Three commands, in this order, in separate terminals:

  1. the hub
     RFA_HUMAN_KEYS="$(cat dogfood/state/human-key.txt)" \\
     RFA_MCP_TOKENS="$(node -e 'console.log(require("./data/secrets.json").RFA_TOKEN)')" \\
       npm run start -- --http ${port} --data ./data --otel --gate deploy/gate.json

  2. check it
     curl -s http://127.0.0.1:${port}/healthz        # {"ok":true}

  3. the agents  (all three variables matter; see the note below)
     RFA_HUB_URL=http://127.0.0.1:${port}/mcp \\
     RFA_TOKEN="$(node -e 'console.log(require("./data/secrets.json").RFA_TOKEN)')" \\
     RFA_JOIN_SECRET="$(node -e 'console.log(require("./data/secrets.json").RFA_JOIN_SECRET)')" \\
       npm run supervisor

RFA_HUB_URL is not optional even on the default port, and it is the one people get
wrong: a resident's hub URL defaults to localhost:8790, so an environment on any
other port silently points its agents at whatever is on 8790. When that is another
environment's hub, the only thing standing between you and agents joining the wrong
room is its transport credential returning 401.

The FIRST resident with no \`rooms:\` binding creates the room and writes its handle
and join secret to dogfood/ROOM.md, which is what \`npm run ask\` and the gates read.
Point later packs at that handle to put them in the same room.
`);

if (packs.length === 0) {
  console.log(`No agent packs yet. Create one first, or nothing will happen at step 3:
     npm run new-agent -- my-agent            # answers from knowledge
     npm run new-agent -- my-agent --kind tool # acts, behind a human approval gate
`);
} else {
  console.log(`Agent packs the supervisor will start: ${packs.join(", ")}`);
  const foreign = packs.filter((p) => ["pm-agent", "linear-scribe", "test-agent"].includes(p));
  if (foreign.length > 0) {
    console.log(`
NOTE: ${foreign.join(", ")} ship with this repository as the reference/dogfood packs.
They are somebody else's agents: their knowledge globs point at directories that do
not exist in a fresh clone, and their prompts describe another operator's product.
For a new environment, retire what you do not want before step 3:
     npm run retire-agent -- ${foreign[0]}`);
  }
}

console.log(`
A second, ISOLATED environment (a different tenant, or staging) is a separate
checkout with its own data dir and port, NOT another room in this one: the hub takes
an exclusive lock on its data dir, and \`data/secrets.json\`, the engine database and
the console are shared by every pack in a checkout. Same repo, different directory:

     git clone <this repo> ../rfa-<name> && cd ../rfa-<name> && npm install && npm run init
     npm run init -- --port 8791                    # its own port, printed into its own commands
`);
