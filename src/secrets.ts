/**
 * The solo-operator secrets story (RFA v0.4 spec section 6.3): secret VALUES
 * live in exactly one gitignored place (data/secrets.json, 0600); packs
 * declare NAMES; the supervisor resolves names at spawn and injects ONLY
 * those into the resident's environment. agents/ stays committable, no
 * resident ever sees the operator's full secret set, and srt policies
 * denyRead the file.
 */
import * as fs from "node:fs";

export function loadSecrets(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const mode = fs.statSync(file).mode & 0o777;
  if (mode & 0o077) {
    console.error(`secrets: ${file} is group/world readable (mode ${mode.toString(8)}); run chmod 600`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Resolve declared names against the store; missing names are reported, never invented. */
export function pickSecrets(
  all: Record<string, string>,
  names: string[],
): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (name in all) env[name] = all[name];
    else missing.push(name);
  }
  return { env, missing };
}

/**
 * The transport credential for a hub that requires one (spec 4.2), resolved for
 * LOCAL tools (the ask CLI, the parity gate, the eval harness). Residents get it
 * injected by the supervisor from their declared `secrets`, so they never call
 * this. Reads the environment first so a one-off run can override, then the
 * secrets file, so `npm run ask` keeps working on an authenticated hub without
 * the operator exporting anything.
 */
export function transportToken(secretsFile: string): string | null {
  const fromEnv = process.env.RFA_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return loadSecrets(secretsFile).RFA_TOKEN?.trim() || null;
  } catch {
    return null;
  }
}
