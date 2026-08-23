/**
 * Attaching what an agent reads (RFA-0.5 sect. 19): a folder of markdown in
 * place, as a glob, or a git remote cloned under the pack and tracked. One
 * function behind `rfa knowledge add`, `rfa agent edit --knowledge` and both
 * walkthroughs, so a clone lands in one place under one name whichever door it
 * came through.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { HubDir } from "../hubdir.js";
import { CLONE_SUFFIX, cloneNameFor, countDocs, isGitRemote, syncClone } from "../knowledge-sources.js";
import { knowledgeRelativeToPack } from "./scaffold.js";

export interface Attachment {
  /** The globs to add to the pack's `knowledge:` block. */
  globs: string[];
  /** What was attached, for the report: an absolute path, or the clone's documents directory. */
  attached: string;
  clone?: { dir: string; head: string; created: boolean; fresh: boolean; docs: number; docsDir: string };
}

export class AttachError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AttachError";
  }
}

export function attachKnowledge(h: HubDir, pack: { name: string; dir: string }, source: string, opts: { docs?: string; cloneName?: string } = {}): Attachment {
  if (isGitRemote(source)) {
    const cloneName = opts.cloneName ? `${opts.cloneName.replace(new RegExp(`${CLONE_SUFFIX}$`), "")}${CLONE_SUFFIX}` : cloneNameFor(source);
    const dir = path.join(pack.dir, "knowledge", cloneName);
    let res: ReturnType<typeof syncClone>;
    try {
      res = syncClone(dir, source, { stdio: "pipe" });
    } catch (err) {
      throw new AttachError((err as Error).message.split("\n").find((l) => l.trim()) ?? "git clone failed", `this needs YOUR credentials for that host; clone it by hand into ${path.relative(h.root, dir)} and run the command again`);
    }
    const docs = (opts.docs ?? "").replace(/^\/+|\/+$/g, "");
    const docsDir = path.join(dir, docs);
    if (!fs.existsSync(docsDir)) throw new AttachError(`nothing attached: ${path.relative(h.root, docsDir)} does not exist`, "pass --docs <subdir> naming the directory that holds the documents");
    const base = path.posix.join("knowledge", cloneName, ...docs.split("/").filter(Boolean));
    return {
      globs: [`${base}/**/*.md`, `${base}/**/*.mdx`],
      attached: `${path.relative(h.root, docsDir)} (clone of ${source})`,
      clone: { dir, head: res.head, created: res.created, fresh: res.fresh, docs: countDocs(docsDir), docsDir },
    };
  }
  const abs = path.resolve(source);
  if (!fs.existsSync(abs)) throw new AttachError(`no such path: ${source}`);
  const rel = knowledgeRelativeToPack(h, pack.name, abs)!;
  return { globs: fs.statSync(abs).isDirectory() ? [`${rel}/**/*.md`, `${rel}/**/*.mdx`] : [rel], attached: abs };
}
