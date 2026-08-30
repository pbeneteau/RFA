/**
 * The `prepare` script (npm lifecycle), replacing a bare `tsc`.
 *
 * Why not a bare `tsc`, measured live on 2026-08-30 while the first real user
 * followed README path 3 (`npm install -g git+ssh://...`):
 *
 *  1. Under Node 20 (fnm's default alias) the failure reads `sh: tsc: command
 *     not found` and nothing names the actual problem, the Node floor. npm's
 *     `engines` field warns and proceeds; it stops nobody.
 *
 *  2. Under ANY Node, `npm install -g <git url>` runs prepare in a cache clone
 *     whose devDependencies are not installed: the outer npm's `-g` leaks into
 *     the preparation through `npm_config_*` env (its debug log shows the inner
 *     npm retiring `lib/node_modules/agent-com` mid-preparation), so `tsc`
 *     does not exist where prepare runs. Path 3 of RFA-0.7 sect. 6.3 - the
 *     README's first line while the registry decision is unmade - had NEVER
 *     worked; coldstart tests path 4 (the tarball) and could not see it.
 *
 *  3. Bootstrapping devDependencies from inside prepare loses a RACE: the inner
 *     npm is still reifying the clone's node_modules while prepare runs, and
 *     both `npm ci` (ENOTEMPTY on its wipe) and `npm install` (ENOTEMPTY on
 *     hono/dist, then json-schema-to-ts/lib) collided with it. Both measured.
 *     So the fallback writes NOTHING under the clone's node_modules: it fetches
 *     the typescript tarball alone into a private temp directory (`npm pack`
 *     reifies nothing) and emits with `--noCheck`, which transpiles without
 *     resolving the absent dependencies' types. Emit is identical to full tsc;
 *     type checking is the gates' job and every other flow still runs it: when
 *     node_modules/typescript exists (a checkout install, npm pack, CI), this
 *     script runs the full type-checked compile exactly as before.
 */
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(
    `agent-com needs Node >= 22 and this is ${process.versions.node}.\n` +
      `npm's engines warning does not stop an install, so this check does.\n` +
      `With fnm: \`fnm install 24 && fnm default 24\`, then reinstall.`,
  );
  process.exit(1);
}

const root = join(__dirname, "..");
const localTsc = join(root, "node_modules", "typescript", "bin", "tsc");

if (existsSync(localTsc)) {
  // The ordinary flows: full, type-checked.
  execFileSync(process.execPath, [localTsc, "-p", root], { cwd: root, stdio: "inherit" });
} else {
  console.error("prepare: bare clone (a global git install); fetching typescript alone and emitting with --noCheck...");
  const range = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.typescript;
  const tmp = mkdtempSync(join(tmpdir(), "agent-com-prepare-"));
  const env = { ...process.env };
  // The outer `npm install -g` leaks these; any of them could redirect or
  // globalize what should be a private, local fetch.
  delete env.npm_config_global;
  delete env.npm_config_prefix;
  delete env.npm_config_location;
  delete env.npm_config_save;
  const pack = (spec, dest) => {
    execFileSync("npm", ["pack", spec, "--pack-destination", dest, "--no-audit", "--no-fund"], {
      cwd: dest,
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`prepare: npm pack produced no tarball for ${spec}`);
    execFileSync("tar", ["-xzf", join(dest, tgz), "-C", dest], { stdio: "inherit" });
    return join(dest, "package");
  };
  const ts = pack(`typescript@${range}`, tmp);
  // TypeScript 7 is the native compiler: `bin/tsc` is a shim over a per-platform
  // binary shipped as an optionalDependency, which `npm pack` does not bring.
  // Fetch the matching one and place it where the shim's require() resolves it.
  const version = JSON.parse(readFileSync(join(ts, "package.json"), "utf8")).version;
  const native = `@typescript/typescript-${process.platform}-${process.arch}`;
  const nativeTmp = mkdtempSync(join(tmpdir(), "agent-com-prepare-native-"));
  const nativePkg = pack(`${native}@${version}`, nativeTmp);
  require("node:fs").mkdirSync(join(ts, "node_modules", "@typescript"), { recursive: true });
  require("node:fs").renameSync(nativePkg, join(ts, "node_modules", ...native.split("/")));
  // tsconfig's `"types": ["node"]` is a resolution ERROR without @types/node,
  // and --noCheck does not suppress config errors. The disposable clone gets a
  // derived tsconfig with the types list emptied; `files` does not pack it.
  const { writeFileSync } = require("node:fs");
  const cfg = join(root, "tsconfig.prepare.json");
  writeFileSync(cfg, JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { types: [], noCheck: true } }));
  execFileSync(process.execPath, [join(ts, "bin", "tsc"), "-p", cfg], { cwd: root, stdio: "inherit" });
}
