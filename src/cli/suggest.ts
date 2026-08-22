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
  const hits = fuzzysort.go(query, targets, { keys: ["id", "summary"], limit, threshold: -5000 });
  return hits.map((h) => h.obj.id);
}
