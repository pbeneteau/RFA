# Research waves

Each wave is a self-contained deep-research pass: a `REPORT.md` synthesis (the only file most readers need), plus the primary sources it was derived from (`papers/` or `notes/`; PDFs are gitignored, indexes are tracked).

| Wave | Date | Question | Outcome |
|---|---|---|---|
| [01-protocol](01-protocol/REPORT.md) | 2026-08-16 | What should an agent rooms/presence/discovery protocol be? (13-agent sweep, 70 papers) | RFA spec v0.1.x + the reference hub |
| [02-platform](02-platform/REPORT.md) | 2026-08-16 | How do we go from a protocol to a working agent platform: capable agents (tools, skills, memory), engine, sandboxes, observability, governance, evals, deployment? Anchored on LangChain deep agents + the 2026 platform landscape | RFA v0.4 platform spec |
| [03-reach-and-collaboration](03-reach-and-collaboration/REPORT.md) | 2026-08-17 | How does the platform become a tool trusted away from the desk: remote reach and approvals, channel adapters, multi-agent handoff, live knowledge, governance v2, the self-improving loop? (6-dimension sweep, each dimension adversarially verified) | RFA v0.5 agenda |
| [04-remote-agents](04-remote-agents/REPORT.md) | 2026-08-17 | With the audience being any organization, how do remote agents (hosted elsewhere, possibly by another org, on another framework, with tools the hub never sees) become first-class room members: cross-org identity, interop, remote tasks, hub deployment, hostile peers, product shape? (6-dimension sweep, each dimension adversarially verified, then a completeness pass) | RFA v0.6 remote-agent design |
| [05-concurrency](05-concurrency/REPORT.md) | 2026-08-25 | How does one agent, and a fleet of them, safely run many tasks at once when runs share an identity, a workspace, a memory store, SDK sessions and a task board? (6-dimension sweep, each dimension adversarially verified, two live SDK probes, 45 papers, then a completeness pass) | RFA v0.8 concurrency spec (accepted 2026-08-25) + the protocol 0.1.9 wire deltas |
| [06-agent-fabric](06-agent-fabric/REPORT.md) | 2026-08-29 | What does MuleSoft Agent Fabric (Salesforce, GA Oct 2025) share with RFA, where is it better, where is it not? | [RFA-0.9: egress and the declared surface](../spec/RFA-0.9-egress.md), accepted 2026-08-29. Single-session web survey, NOT a multi-agent sweep: read its method note before trusting it, and note that nothing normative in RFA-0.9 rests on it alone - it motivated the document and twelve live probes carry it |

A wave numbered here is normally a multi-agent sweep that produces a specification. Wave 06 is a landscape comparison and says so in its own first paragraph; it carries no adversarial verification pass.

Conventions for a new wave: `NN-slug/` with `REPORT.md` (evidence-linked, decision-oriented), `notes/` per-dimension research notes with source URLs, `papers/` for downloaded primary sources. Update this table and the repo docs that point at the latest wave.
