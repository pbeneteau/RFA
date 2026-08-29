/**
 * The network posture (RFA-0.9 sect. 4), amending v0.4 sect. 3.2.
 *
 * `sandbox.network` and `sandbox.allowed_domains` existed in the schema, were
 * published by v0.4 sect. 3.2 as `none | allowlist | open`, and were read by
 * NOTHING. This module is what reads them.
 *
 * Six measurements decide everything here, each recorded in RFA-0.9 sect. 2 and
 * re-established by `npm run egress-proof` (sect. 10.2):
 *
 *  E1  sandbox on, no `network` key, no callback:  denied, reason `(user denied)`
 *  E2  allowedDomains + strictAllowlist:           denied, `(host is not on the allow list)`
 *  E3  allowedDomains WITHOUT strictAllowlist:     denied, `(user denied)`
 *  E4  the allowed host:                           HTTP:200
 *  E10a no policy + an ALLOWING callback:          HTTP:200, and the callback saw
 *                                                  `SandboxNetworkAccess {"host":"example.com"}`
 *  E10b the same with a denying callback:          denied, `(user denied)`
 *
 * The consequence that shapes the whole section: with no network policy in force
 * the OS sandbox ASKS door one, and door one's answer decides it. So the
 * confinement a fenced pack had before this rung was not a policy at all - it
 * was door one's catch-all deny, reached by a tool name nobody had classified,
 * and one `interrupt_on` pattern or one pre-approval turned it into an allow.
 * `strictAllowlist: true` is exactly the switch that stops the runtime
 * consulting the callback ("strictAllowlist makes the allowlist deterministic
 * enforcement: never fall through to the callback", in the pinned runtime's own
 * source), which is why sect. 4.3 makes it mandatory and sect. 4.7 turns door
 * one's branch into a fail-closed BACKSTOP whose arrival is an alarm.
 */
import { declaredOfClass, fenceApplies } from "./toolclass.js";
import { interruptMatch } from "./bridge.js";

export type NetworkPosture = "none" | "allowlist" | "open";

/**
 * Sect. 4.1, stated before the semantics and carried by every rendering.
 *
 * A posture displayed without its scope is read as total, which is how a partial
 * control becomes a false one. One constant, because a sentence copied per
 * renderer is how the copies drift.
 */
export const NETWORK_SCOPE_NOTE =
  "the posture governs this pack's SANDBOXED COMMAND surface only (built-ins of class `command`, and any process they start). " +
  "It does NOT govern the pack's own MCP servers, the platform's injected `rfa` and `memory` tools, `WebFetch`/`WebSearch`, or the SDK's own model traffic (RFA-0.9 sect. 4.1)";

/** The synthetic tool name the OS sandbox routes an outbound host to when no policy is in force (E10). */
export const EGRESS_TOOL_NAME = "SandboxNetworkAccess";

/**
 * The establishment target (sect. 4.5). An RFC 2606 `.invalid` host: it cannot
 * resolve to a third party, so no resident boot depends on reaching anyone, and
 * a policy-driven refusal happens at the sandbox proxy before any resolution is
 * attempted.
 */
export const ESTABLISHMENT_HOST = "rfa-egress-establishment.invalid";

/** The two denial reasons sect. 4.3 exists to tell apart, in the runtime's own words. */
export const ALLOWLIST_DENY_REASON = "host is not on the allow list";
export const NO_APPROVER_DENY_REASON = "user denied";

export type DenialKind = "allowlist" | "no-approver" | "reached" | "unclear";

/**
 * Which of the two refusals happened, from the runtime's annotated stderr.
 *
 * This distinction IS the property: `(host is not on the allow list)` is a
 * policy deciding, `(user denied)` is whoever happened to answer the ask
 * deciding, and E10a measured that same configuration resolving as an ALLOW
 * under a callback that says yes. A boot that accepted the second would be
 * establishing a property of the deployment, not of the pack.
 */
export function classifyDenial(annotated: string, reached: boolean): DenialKind {
  if (reached) return "reached";
  if (annotated.includes(ALLOWLIST_DENY_REASON)) return "allowlist";
  if (annotated.includes(NO_APPROVER_DENY_REASON)) return "no-approver";
  return "unclear";
}

/** The subset of srt's `NetworkConfig` this platform sets. `strictAllowlist` is never optional (sect. 4.3). */
export interface EgressPolicy {
  allowedDomains: string[];
  deniedDomains: string[];
  strictAllowlist: true;
}

/**
 * Door two's network half for one pack (sect. 4.2), and there is no shape of it
 * without `strictAllowlist: true`.
 *
 * `none` is `allowedDomains: []`, which E2's mechanism refuses every host with
 * the allow-list reason. It is NOT "omit the network key": that is E1/E10, the
 * ask path, whose outcome is decided by whoever answers.
 */
export function egressPolicy(def: { sandbox?: { network?: NetworkPosture; allowed_domains?: string[] } }): EgressPolicy {
  const posture = def.sandbox?.network ?? "none";
  return {
    allowedDomains: posture === "allowlist" ? [...(def.sandbox?.allowed_domains ?? [])] : [],
    deniedDomains: [],
    strictAllowlist: true,
  };
}

/** What a renderer needs to show the posture honestly, including when it governs nothing (sect. 4.2). */
export interface PostureView {
  posture: NetworkPosture;
  /** The pack has no sandboxed command surface, so the field governs nothing here. */
  inert: boolean;
  domains: string[];
  /** The command-class built-ins the posture actually governs. */
  governs: string[];
  scope: string;
  summary: string;
}

export function postureView(def: { tools?: { allow?: string[] }; sandbox?: { network?: NetworkPosture; allowed_domains?: string[] } }): PostureView {
  const posture = (def.sandbox?.network ?? "none") as NetworkPosture;
  const governs = declaredOfClass(def.tools?.allow, "command");
  /**
   * INERT is keyed on sect. 3.3's COVERAGE PREDICATE, not on the command
   * surface, and the difference is a real pack: sect. 4.2 says `none` is in
   * force "on a pack the predicate of 3.3 fences", and a guarded-only pack IS
   * fenced - `sandboxPolicy` hands its every run `allowedDomains: []` with
   * `strictAllowlist: true`, exactly as it hands a Bash pack. Rendering that as
   * "governs nothing" would be the reassuring-instrument defect this document
   * exists to remove, pointed the other way.
   *
   * `governs` stays the COMMAND list, because that is what the posture's
   * refusals are keyed on (sect. 4.4: `allowlist` on a pack with no command
   * built-in is refused), and because naming `Write` as something an egress
   * policy governs would be its own lie.
   */
  const inert = !fenceApplies(def);
  const domains = posture === "allowlist" ? [...(def.sandbox?.allowed_domains ?? [])] : [];
  const over = governs.length > 0 ? governs.join(", ") : "this pack's sandboxed command surface (it declares none today, and door two still carries the policy because sect. 3.3 fences it)";
  const summary = inert
    ? `network ${posture}: INERT on this pack, which sect. 3.3's coverage predicate does not fence (no built-in of class \`guarded\` or \`command\`), so door two is never established for it and there is nothing for the posture to govern (RFA-0.9 sect. 4.2)`
    : posture === "allowlist"
      ? `network allowlist over ${over}: ${domains.join(", ")} reachable, every other host refused deterministically at door two (strictAllowlist)`
      : `network none over ${over}: no sandboxed egress, enforced as an EMPTY allowlist with strictAllowlist, never as an ask`;
  return { posture, inert, domains, governs, scope: NETWORK_SCOPE_NOTE, summary };
}

/**
 * Sect. 4.2 and 4.4: every way a network declaration can be refused at
 * definition load, each naming what the value would require.
 *
 * The rule behind 4.4 is the one RFA-0.8 sect. 8.1 and RFA-0.9 sect. 3.2 already
 * apply elsewhere: a setting that cannot act MUST refuse rather than reassure.
 */
export function networkPostureFailures(def: {
  tools?: { allow?: string[] };
  sandbox?: { network?: NetworkPosture; allowed_domains?: string[] };
}): string[] {
  const sandbox = def.sandbox;
  if (!sandbox) return [];
  const posture = sandbox.network ?? "none";
  const domains = sandbox.allowed_domains;
  const commands = declaredOfClass(def.tools?.allow, "command");
  const out: string[] = [];
  if (posture === "open") out.push(NETWORK_OPEN_REFUSAL);
  if (posture === "allowlist") {
    if (!domains || domains.length === 0) {
      out.push(
        "`sandbox.network: allowlist` needs a non-empty `sandbox.allowed_domains` (RFA-0.9 sect. 4.2). " +
          "An allowlist with nothing on it is not `none`: it is a declaration that says a policy exists and names no host, and it MUST NOT be silently treated as `none`.",
      );
    }
    if (commands.length === 0) {
      out.push(
        "`sandbox.network: allowlist` has nothing to govern on this pack: it declares no built-in of class `command` (`Bash`), so it has no sandboxed command surface (RFA-0.9 sect. 4.4). " +
          `The posture governs ${NETWORK_SCOPE_NOTE.replace(/^the posture governs /, "")}. Declare \`Bash\`, or leave the posture at \`none\`.`,
      );
    }
  }
  if (domains !== undefined && posture !== "allowlist") {
    out.push(
      `\`sandbox.allowed_domains\` is set and \`sandbox.network\` is \`${posture}\`, so nothing reads it (RFA-0.9 sect. 4.2). ` +
        "It is meaningful only beside `network: allowlist`. Remove the key, or declare the posture that uses it.",
    );
  }
  return out;
}

/**
 * Sect. 4.2's third value, refused by name and permanently, in the manner
 * RFA-0.8 sect. 8.1 refuses `sandbox.isolation: container`.
 *
 * Two checkable grounds and no policy preference: the pinned runtime accepts a
 * bare `*` only in `deniedDomains` and says so in its own describe text, so
 * there is no allowlist entry meaning "any host"; and the one MEASURED route to
 * unconfined egress is E10a, omitting the policy and letting door one answer yes
 * to every host, which is exactly what sect. 4.3 forbids.
 *
 * This supersedes v0.4 sect. 3.2's `# open requires room_admin override`
 * comment, which named a wire-level room authority for a hub-local pack setting.
 */
export const NETWORK_OPEN_REFUSAL =
  "`sandbox.network: open` is refused by name and permanently (RFA-0.9 sect. 4.2). There is no allowlist entry meaning \"any host\": the pinned sandbox runtime accepts a bare `*` only in `deniedDomains`, never on the allow side. " +
  "The one measured route to unconfined egress is omitting the network policy and letting the canUseTool callback answer yes to every host (probe E10a), which is exactly the property sect. 4.3 forbids: a security outcome decided by whoever answers. " +
  "Reopening it needs an allowlist grammar that can express \"any host\". Name the hosts with `network: allowlist` instead.";

/**
 * Sect. 4.7: an `interrupt_on` rule matching `SandboxNetworkAccess` is refused at
 * definition load.
 *
 * A per-host human card on outbound traffic is a different feature; sect. 4.2
 * has no value meaning "ask"; and such a rule would convert the fail-closed
 * backstop into an approval path, which is E10a with extra steps.
 */
export function interruptOnEgressFailures(def: { interrupt_on?: Record<string, unknown> }): string[] {
  if (!def.interrupt_on) return [];
  const matched = interruptMatch(def.interrupt_on as never, EGRESS_TOOL_NAME);
  if (matched === null) return [];
  return [
    `an \`interrupt_on\` rule matches \`${EGRESS_TOOL_NAME}\`, the synthetic tool name the OS sandbox uses for an outbound host (RFA-0.9 sect. 4.7). ` +
      "It is refused: a per-host human card on outbound traffic is a different feature, `sandbox.network` has no value meaning \"ask\", and such a rule would turn a fail-closed backstop into an approval path - " +
      "probe E10a measured exactly that shape returning HTTP:200. Egress is decided at door two by the posture, deterministically, and door one only ever denies it.",
  ];
}

/**
 * Door one's refusal for the synthetic egress tool (sect. 4.7), naming the host.
 *
 * It never decides from the posture. Under sect. 4.3's mandatory
 * `strictAllowlist` this name cannot arrive at all on a run whose policy was
 * established, so its ARRIVAL is the alarm: it means the runtime stopped
 * honouring `strictAllowlist`, and the run fails loudly rather than proceeding
 * on a deny that happens to be correct.
 */
export function egressBackstopMessage(host: string, policyEstablished: boolean): string {
  const named = host && host.trim() ? host : "(the request named no host)";
  return (
    `outbound network access to ${named} is refused at door one (RFA-0.9 sect. 4.7). ` +
    (policyEstablished
      ? `This run established a network policy at door two with strictAllowlist, under which this decision is made deterministically and this callback is never consulted. ` +
        `Its arrival means the sandbox runtime stopped honouring strictAllowlist, so the run is being failed rather than continued on a refusal that happens to be correct.`
      : `This pack declares no sandboxed command surface, so nothing here is governed by a network posture and door one refuses by default.`)
  );
}
