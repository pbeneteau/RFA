/**
 * What this hub has written OUTSIDE its own directory, and what it was generated
 * from (RFA-0.9 sect. 8.2).
 *
 * `rfa connect --skill` writes a skill file and a command file into another
 * repository, at `process.cwd()`, carrying every bound pack's offer ids and
 * their full descriptions. Before this it recorded the destination nowhere, so
 * the artifact could go stale forever and nothing on this side even knew it
 * existed. CLAUDE.md's rule - a check comparing CONFIGURED against HAPPENING
 * must read the running system's own record - is what this file makes possible
 * for an artifact the hub cannot see.
 *
 * It stores the (pack name, definition hash) pairs the hint came from, not the
 * hint itself: the hash is what moves when a pack's offers change, and comparing
 * hashes says "this file is behind" without this module having to re-render the
 * template and diff strings.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { JsonStore, type HubDir } from "./hubdir.js";

export interface GeneratedArtifactRecord {
  /** Absolute paths, as written. A relative one would be meaningless: the destination is another repository. */
  files: string[];
  room: string;
  /** The packs the hint was generated FROM, with the definition hash each had at the time. */
  sources: { pack: string; definition_hash: string }[];
  /** Packs the tolerant scan skipped as broken: they were silently absent from the hint. */
  skipped: string[];
  written_at: string;
}

export interface ArtifactsFile {
  version: 1;
  artifacts: GeneratedArtifactRecord[];
}

export const artifactsStore = (h: HubDir): JsonStore<ArtifactsFile> =>
  new JsonStore<ArtifactsFile>(path.join(h.paths.runtime, "artifacts.json"), () => ({ version: 1, artifacts: [] }));

/** Record one `rfa connect --skill` write, replacing any earlier record of the same destination. */
export function recordGeneratedArtifacts(
  h: HubDir,
  rec: { room: string; files: string[]; sources: { pack: string; definition_hash: string }[]; skipped: string[] },
  now: () => Date = () => new Date(),
): void {
  artifactsStore(h).update((file) => {
    const written = new Set(rec.files);
    return {
      version: 1,
      artifacts: [
        ...file.artifacts.filter((a) => !a.files.some((f) => written.has(f))),
        { ...rec, written_at: now().toISOString() },
      ],
    };
  });
}

export interface ArtifactDrift {
  record: GeneratedArtifactRecord;
  /** Recorded destinations that are still on disk; a deleted one is not drift, it is gone. */
  present: string[];
  /** Packs whose definition has moved since the artifact was generated. */
  moved: { pack: string; then: string; now: string }[];
  /** Packs bound to the room now that the artifact never saw. */
  added: string[];
  /** Packs the artifact was generated from that no longer exist or no longer bind to the room. */
  removed: string[];
  /** Packs that were broken at generation time, so their offers were silently missing. */
  skipped: string[];
}

/**
 * Compare each recorded destination that STILL EXISTS against the live set
 * (sect. 8.2). A destination that has been deleted is not drift and is dropped
 * from the comparison: the operator removed the artifact, which is an answer.
 */
export function artifactDrift(
  records: readonly GeneratedArtifactRecord[],
  live: readonly { name: string; definitionHash: string; rooms: string[] }[],
): ArtifactDrift[] {
  const out: ArtifactDrift[] = [];
  for (const record of records) {
    const present = record.files.filter((f) => fs.existsSync(f));
    if (present.length === 0) continue;
    const bound = live.filter((p) => p.rooms.includes(record.room));
    const byName = new Map(bound.map((p) => [p.name, p.definitionHash]));
    const moved: ArtifactDrift["moved"] = [];
    const removed: string[] = [];
    for (const src of record.sources) {
      const now = byName.get(src.pack);
      if (now === undefined) removed.push(src.pack);
      else if (now !== src.definition_hash) moved.push({ pack: src.pack, then: src.definition_hash, now });
    }
    const seen = new Set(record.sources.map((s) => s.pack));
    const added = bound.map((p) => p.name).filter((n) => !seen.has(n));
    if (moved.length || added.length || removed.length || record.skipped.length) {
      out.push({ record, present, moved, added, removed, skipped: record.skipped });
    }
  }
  return out;
}
