# Wave 06 sources

All accessed 2026-08-29. Every Agent Fabric claim in the report traces to one of these. Vendor material is labelled as such: none of it is independently verified.

## Vendor: documentation

| Source | URL | What it gave |
|---|---|---|
| MuleSoft Agent Fabric Deep Dive (Salesforce Architects; Aggarwal, Gonzalez, Colunga, Kumar) | https://architect.salesforce.com/docs/architect/fundamentals/guide/mulesoft-agent-fabric-deep-dive.html | The primary technical source. Four pillars, YAML-first model, broker card/spec split, CH2 compilation, Object Store for HITL, the full policy list, the two-gateway requirement, today-versus-roadmap observability, the 20-25 tool ceiling, hierarchy guidance |
| Agent Fabric Overview | https://docs.mulesoft.com/general/agent-fabric-overview | MCP Bridge / MCP Connector / A2A Connector / AI Connectors, agent network definition, Omni Gateway naming |
| Agent Fabric Release Notes | https://docs.mulesoft.com/release-notes/agent-fabric/agent-fabric-release-notes | Dated shipping record: 2025-10-03 initial GA, 2026-01-23 MCP by URL, 2026-01-30 scanners, 2026-02-09 Visualizer search, 2026-02-17 GoDaddy ANS, 2026-04-29 Canada/Japan clouds, 2026-07-14 Agent Network 2.0 + Agent Script + A2A 1.0, 2026-08-06 naming, 2026-08-24 undeploy |
| Building Agent Networks for Agent Fabric | https://docs.mulesoft.com/agent-network/latest/af-agent-networks | agent-network.yaml registry/context sections, `.agent` files, nodes/triggers/edges, LLM providers supported |

## Vendor: blogs

| Source | URL | What it gave |
|---|---|---|
| Trusted Agent Identity: Identity Propagation (Trivedi, 2026-03-11) | https://blogs.mulesoft.com/dev-guides/identity-propogation-mulesoft-agent-fabric/ | The whole identity section: RFC 8693 OBO and In-Task Authorization Code, claim transformations, IdP support matrix, Flex Gateway 1.11.4+, the YAML `authentication:` blocks |
| MuleSoft Agent Fabric and GoDaddy ANS (Hiremath, 2026-02-19) | https://blogs.mulesoft.com/news/mulesoft-agent-fabric-godaddy-ans-for-agent-discovery-and-verification/ | ANS verified identity, per-version certificates, transparency log, scanner configuration flow |
| Guided Determinism in Agent Broker Using Agent Script (Xu) | https://blogs.mulesoft.com/news/guided-determinism-in-agent-broker/ | Agent Script node types, probabilistic versus deterministic split, visual canvas |
| Salesforce launch announcement (2025-09-25) | https://www.salesforce.com/news/stories/mulesoft-agent-fabric-announcement/ | Announcement date, component availability split |
| Evaluation framework for MuleSoft Vibes | https://blogs.mulesoft.com/dev-guides/mulesoft-vibes-evaluation-framework/ | Establishes that the published eval framework targets Vibes, their coding agent, not customer agents in Agent Fabric |

## Trade press and analysts

| Source | URL | What it gave |
|---|---|---|
| InfoWorld, "Agent Fabric adds new ways to keep AI agents in line" | https://www.infoworld.com/article/4159228/mulesoft-agent-fabric-adds-new-ways-to-keep-ai-agents-in-line.html | Timeline of additions; Bickley (Info-Tech) on switching costs and exit path; Kramer (KramerERP) and Wettemann (Valoir) on deterministic controls; LLM Governance GA |
| Techzine, "MuleSoft agent fabric brings governance to AI orchestration" | https://www.techzine.eu/blogs/devops/136458/mulesoft-agent-fabric-brings-governance-to-ai-orchestration/ | 8-10 actions per agent guidance; roadmap admission on HR/AD role management |
| Prowesssoft, "Agent Fabric Challenges" | https://www.prowesssoft.com/mulesoft-agent-fabric-challenges/ | Third-party production report (adapters failing on undocumented rate limits); also the uncorroborated "regression testing" claim flagged as uncertain in the report |
| Pricing surveys (Integrate.io, Redress Compliance, TrustRadius) | various | Whole-platform TCO shape only. No Agent Fabric line-item price is public |

## Internal, for the RFA side of the comparison

`spec/RFA-0.1.md` (wire 0.1.9), `spec/RFA-0.4-platform.md`, `spec/RFA-0.6-remote.md` sect. 12, `spec/RFA-0.8-concurrency.md`, `STATUS.md` (2026-08-28), `CLAUDE.md`, `research/01-protocol/REPORT.md` (the A2A assessment), `research/04-remote-agents/REPORT.md` (the A2A facade rejection), `reports/direction-review-2026-08-21.md` (gitignored; the inert-fields finding and the thesis-B verdict).

## Not obtained

- No Anypoint tenant, so nothing was run.
- `blogs.mulesoft.com` and `mulesoft.com` return 403 to plain fetches; those pages were read through a browser.
- The A2A 1.0 specification itself was not re-read this session; the A2A characterisation leans on wave 01 and wave 04, both of which read it at source.
