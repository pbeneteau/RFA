/**
 * "Did you mean": an unknown command is matched fuzzily against every command
 * path, so `rfa restart-agent pm` and `rfa agnet restrt` both land on
 * `rfa agent restart`. Suggestions only; nothing runs on a guess.
 */
import fuzzysort from "fuzzysort";
import type { CommandDef } from "./router.js";

export function suggestCommands(words: string[], commands: CommandDef[], limit = 3): string[] {
  const query = words.join(" ").replace(/[-_]/g, " ").trim();
  if (!query) return [];
  const targets = commands.filter((c) => !c.hidden).map((c) => ({ id: c.path.join(" "), summary: c.summary }));
  // fuzzysort 4 scores in [0, 1] and a NEGATIVE threshold accepts every
  // candidate, so the old -5000 made these the limit's top 3, not matches:
  // "agnet restrt" suggested `rfa evals flag` (score 0.24). Measured on the
  // real command set: honest typos land at 0.32+, unrelated co-matches at or
  // under about 0.27.
  const hits = fuzzysort.go(query, targets, { keys: ["id", "summary"], limit, threshold: 0.3 });
  return hits.map((h) => h.obj.id);
}
