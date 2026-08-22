/**
 * `rfa server <name>`: run a built-in MCP server over stdio. Hidden from the
 * group listing because a person never runs it: a pack declares
 * `mcp_servers: { linear: { builtin: "linear" } }` and the resident runs the
 * server through the tool's own entry. The command exists so a pack on a
 * machine where `rfa` is on PATH can also say `command: rfa, args: [server, linear]`.
 */
import { CliError } from "../context.js";
import type { CommandDef } from "../router.js";

export const server: CommandDef = {
  path: ["server"],
  summary: "Run a built-in MCP server over stdio (for packs that declare it)",
  usage: "<linear>",
  hidden: true,
  run: async (_ctx, a) => {
    const which = a.positionals[0];
    if (which !== "linear") throw new CliError(2, `rfa server takes one of: linear`);
    const { serveLinear } = await import("../../servers/linear.js");
    await serveLinear();
    // The server lives as long as stdin does.
    await new Promise<void>((resolve) => process.stdin.on("close", resolve));
  },
};
