/**
 * Conversation-level debugger for RFA room logs (the JADE Sniffer lesson).
 *
 *   npm run tail -- data/rooms/r_abc123.ndjson          pretty-print a room log
 *   npm run tail -- data/rooms/r_abc123.ndjson --follow keep watching for new events
 */
import * as fs from "node:fs";

const file = process.argv[2];
const follow = process.argv.includes("--follow");
if (!file || !fs.existsSync(file)) {
  console.error("usage: npm run tail -- data/rooms/<room>.ndjson [--follow]");
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color: Record<string, (s: string) => string> = {
  message: (s) => `\x1b[36m${s}\x1b[0m`,
  presence: (s) => `\x1b[33m${s}\x1b[0m`,
  roster: (s) => `\x1b[35m${s}\x1b[0m`,
  system: (s) => `\x1b[31m${s}\x1b[0m`,
  intervention: (s) => `\x1b[41m${s}\x1b[0m`,
};

function summarize(e: any): string {
  switch (e.type) {
    case "message": {
      const env = e.envelope;
      const text = env.body?.find((p: any) => p.type === "text")?.text ?? "";
      const target = env.mentions?.length ? ` -> ${env.mentions.join(",")}` : "";
      const conv = env.conversation_id ? dim(` [${env.conversation_id}]`) : "";
      const chunk = env.chunk ? dim(` (chunk ${env.chunk.index}${env.chunk.final ? " final" : ""})`) : "";
      const refusal = env.refusal ? ` REFUSE:${env.refusal.reason}` : "";
      return `${bold(env.from.name)} ${env.kind}${refusal}${target}${conv}${chunk} "${text.slice(0, 80)}"`;
    }
    case "presence":
      return `${bold(e.member.name)} is ${e.member.state}${e.member.detail ? ` (${e.member.detail})` : ""}`;
    case "roster":
      return `${e.reason} (epoch ${e.epoch}): ${e.members.map((m: any) => `${m.name}:${m.state}`).join(", ")}`;
    case "system":
      return `${e.event} ${dim(JSON.stringify(e.refs))}`;
    case "intervention":
      return `${e.verb} by ${e.actor} on ${e.target ?? "-"}`;
    default:
      return JSON.stringify(e);
  }
}

let offset = 0;
function drain(): void {
  const content = fs.readFileSync(file, "utf8");
  const fresh = content.slice(offset);
  offset = content.length;
  for (const line of fresh.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    const paint = color[e.type] ?? ((s: string) => s);
    console.log(`${dim(String(e.seq).padStart(5))} ${dim(e.ts)} ${paint(e.type.padEnd(12))} ${summarize(e)}`);
  }
}

drain();
if (follow) {
  fs.watchFile(file, { interval: 500 }, drain);
}
