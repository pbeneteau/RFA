/**
 * The `prepare` script (npm lifecycle), replacing a bare `tsc`.
 *
 * Two failures a bare `tsc` produced, both measured live on 2026-08-30 while a
 * user followed README path 3 (`npm install -g git+ssh://...`):
 *
 *  1. Under Node 20 (fnm's default alias), typescript 7's binary is not usable
 *     and the user sees `sh: tsc: command not found` - nothing names the actual
 *     problem, which is the Node floor. npm's `engines` field does not stop an
 *     install: it warns and proceeds.
 *
 *  2. Under ANY Node, `npm install -g <git url>` runs this script in a cache
 *     clone whose devDependencies are NOT installed: the outer npm's `-g` leaks
 *     into the preparation step through `npm_config_*` environment, so the
 *     inner npm tries to reify the clone into the GLOBAL prefix (the debug log
 *     shows it retiring `lib/node_modules/agent-com`) and runs `prepare` before
 *     any dependency exists. `tsc` cannot be found because node_modules is not
 *     there yet. This is an npm behavior, not a typo, and it means a bare
 *     `prepare: "tsc"` breaks EVERY global git install of this package - path 3
 *     of RFA-0.7 sect. 6.3, the README's first line while the registry decision
 *     is unmade.
 *
 * So this script (plain CommonJS, zero dependencies, runs under old Node far
 * enough to print an error):
 *   - refuses Node < 22 with the message the user needed,
 *   - bootstraps devDependencies into the clone when tsc is absent (scripts
 *     ignored: the compile needs typescript only; the packed tarball's own
 *     install builds the native deps properly afterwards), with the leaked
 *     global/prefix config explicitly stripped so the bootstrap stays local,
 *   - runs the compiler by PATH-independent direct resolution.
 */
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.error(
    `agent-com needs Node >= 22 and this is ${process.versions.node}.\n` +
      `npm's engines warning does not stop an install, so this check does.\n` +
      `With fnm: \`fnm install 24 && fnm default 24\`, then reinstall.`,
  );
  process.exit(1);
}

const root = __dirname ? join(__dirname, "..") : process.cwd();
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsc)) {
  // The global-git-install case: prepare is running in a bare cache clone.
  console.error("prepare: no typescript in node_modules (a global git install runs prepare in a bare clone); bootstrapping devDependencies...");
  const env = { ...process.env };
  // The outer `npm install -g` leaks these; any of them would send THIS install
  // to the global prefix too, which is exactly the failure being fixed.
  delete env.npm_config_global;
  delete env.npm_config_prefix;
  delete env.npm_config_location;
  delete env.npm_config_save;
  execFileSync("npm", ["ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
}

execFileSync(process.execPath, [tsc], { cwd: root, stdio: "inherit" });
