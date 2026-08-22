/**
 * Where the TOOL's own files are: the console page, the specs, the interop
 * guide, the templates. Resolved from this module, so it is the repository root
 * under tsx and the installed package root when built, and never an instance
 * directory (those go through src/hubdir.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname ?? ".", "..");

export function packageFile(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}

export function packageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(packageFile("package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}
