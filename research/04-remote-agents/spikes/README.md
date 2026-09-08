# Spikes: committed measurements for RFA-0.6

RFA-0.6 sect. 13 item 2 is the reason this directory exists: **a number may enter
normative text only if a script here produces it.** Wave 04 measured three
stranger clients in a session scratchpad and the repository corroborated none of
it; two rows of the per-framework timeout table (sect. 12 item 6) still carry the
words *operator report, uncommitted*.

Every row below stamps its client version and its transport era, because a
timeout measured against a client version is a fact about that version only.

## `codex-cli-longpoll.ts` - how long a blocking `room_listen` a client tolerates

Answers one question: does this MCP client cancel the long poll the presence loop
is built on? The subject is the client, so the verdict is read from the client's
own event stream (`codex exec --json` brackets each tool call and carries its
`error`), never from the model's prose and never from the hub's span. The header
comment explains why both of those were rejected; one of them had already
produced a false failure by hand.

### Runbook

```
rfa peer add codex-spike --room main --expires 1d          # prints the bearer once
RFA_TOKEN=<peer bearer> npx tsx research/04-remote-agents/spikes/codex-cli-longpoll.ts \
  --hub http://127.0.0.1:8790/mcp --room r_xxxxxxxxxx
rfa peer revoke codex-spike                                 # when done
```

Flags: `--timeouts 25000,45000,60000` (the values to hold), `--repeat N`,
`--user-config` (use the operator's own `config.toml` instead of a hermetic run),
`--server <name>` (the MCP server name to pass to codex). Exits 1 if any poll was
cancelled, 2 if the spike could not run at all.

### Measured

| client | era | config | held 25s | held 45s | held 60s | measured |
|---|---|---|---|---|---|---|
| `codex-cli 0.153.4` | streamable HTTP, bearer | hermetic (`--ignore-user-config`) | yes | yes | yes | 2026-09-08 |
| `codex-cli 0.153.4` | streamable HTTP, bearer | operator's own `config.toml`, no `tool_timeout_sec` set | - | - | yes | 2026-09-08 |

**Reading.** The Codex CLI does not cancel a `room_listen` at any duration RFA
can ask for. It survived 60000ms, which is the hub's own ceiling on `timeout_ms`
(`src/hub.ts`), so the honest claim is **at least 60s** and NOT a measured limit:
establishing the real ceiling needs a deliberately slow MCP server, which is a
different spike. The default 25000ms poll in `src/client.ts` has 35 seconds of
headroom against the largest value this client was proven to hold.

**Where the row is published.** `INTEROP.md` sect. 4.7 is the counterparty-facing home of this
table (RFA-0.6 sect. 6.1 item 6), and it carries the Codex row stamped `measured`, which that
section now distinguishes from `operator report`. This directory holds the script and the reasoning;
that document holds what a stranger reads.

**What this does and does not say about the uncommitted row.** Sect. 12 item 6
reports an OpenAI **Agents SDK** client session timing out after a few seconds.
That is a different client from the Codex CLI, so this measurement does not
refute it; it adds a row beside it. The Codex CLI also exposes a per-server
`tool_timeout_sec` in `config.toml`, so where a client of this family does cancel
early, an operator has a knob rather than a wall.

**Cost.** Each row is one `codex exec` run per timeout value, a few thousand
tokens of the runner's own Codex quota, and the wall clock is the sum of the
timeouts. No RFA model credential is spent: nothing answers, the room stays
quiet, and staying quiet is what makes the poll run to term.

### Two traps this script exists to avoid

1. **A model in the loop is not the instrument.** The first hand run had the
   model mistype the membership token and report `not_a_member` at 45s as a
   failure. The script passes the arguments verbatim and reads the structured
   event, so a transcription error can no longer masquerade as a timeout.
2. **A hub span proves the hub held the poll, not that the client stayed.**
   `otel rfa.room_listen 60001.8ms` is written whether or not anybody was still
   listening. Client-side truth was the whole point.
