# 01 - Remote reach: getting the hub and console off localhost safely

Dimension 01 of research wave 03 (the v0.5 agenda). Depth: DEEP.
Research date: **2026-08-17**. Researcher: subagent under the wave-03 orchestrator.
Grounding read first: [`STATUS.md`](../../../STATUS.md), [`spec/RFA-0.4-platform.md`](../../../spec/RFA-0.4-platform.md), [`research/02-platform/REPORT.md`](../../02-platform/REPORT.md).
Method: primary sources only for normative claims (specs, RFCs, official docs, source code, measured local state). Vendor blogs are labelled as such. Everything unverified is prefixed `UNVERIFIED:`.

---

## Verdict

### Headline

**The two approval cards did not expire because the hub was on localhost. They expired because a human-only approval card has a 10-minute default TTL that is then capped to the asker's patience, and nothing pushed it anywhere.** Reach is necessary and cheap; it is not sufficient. Fix the card lifecycle in the same turn as the reach, or you will ship a tunnel and still lose cards.

Second headline, and it is worse: **the hub is already off localhost.** Measured on Paul's machine, 2026-08-17 18:42 CEST:

```
$ lsof -nP -iTCP:8790 -sTCP:LISTEN
node    5916 paulbeneteau   28u  IPv6 0xe9ee8f259484447  0t0  TCP *:8790 (LISTEN)
$ netstat -an | grep 8790
tcp46      0      0  *.8790                 *.*                    LISTEN
```

`*:8790` on a `tcp46` socket. Every device on whatever Wi-Fi the laptop is joined to can already reach `/mcp` (no transport auth at all) and can already read `/api/approvals`, `/api/agents/<name>/definition`, `/api/runs`, `/api/runs?trace=`, `/api/summary` **without a token**. That contradicts the spec's own promise ("the hub keeps binding to localhost", [`spec/RFA-0.4-platform.md`](../../../spec/RFA-0.4-platform.md) section 9) and the MCP transport MUST/SHOULD pair. The remote-reach project therefore starts with a *reduction* of exposure, not an increase.

### Recommended architecture: "loopback hub, tailnet skin, chat verdict"

Four layers, each shippable alone, in this order. Names are specific on purpose.

| Layer | What | Why this and not the alternative |
|---|---|---|
| **L0. Close the door you already opened** (~1-2 h) | `server.listen(port, "127.0.0.1")`; `Origin` allowlist returning 403; session token required on **reads** too; constant-time `human_key` compare; `/auth` rate limit + lockout; audit event per auth attempt and per console decision | MCP 2026-07-28: Origin validation is a **MUST**, localhost binding a **SHOULD**. Today neither holds. This layer is free and is a prerequisite for every option below. |
| **L1. Reach = Tailscale tailnet + `tailscale serve`** (~30 min) | `tailscale serve --bg --https=443 http://127.0.0.1:8790`; Tailscale on the Mac and the iPhone; MagicDNS + tailnet HTTPS cert; ACL grant limited to Paul's own devices | `tailscale serve` proxies **only** `http://127.0.0.1` targets, so the hub can obey the localhost SHOULD *and* be reachable from the phone. WireGuard-grade crypto, no public listener, no third party terminating TLS, real HTTPS cert, and `Tailscale-User-Login` gives a free second identity factor. |
| **L2. MCP client auth = static bearer at the transport** (~1 h) | Per-agent bearer tokens in `data/secrets.json`; hub checks `Authorization` before the MCP handler; Claude Code side uses `--header "Authorization: Bearer …"` or `headersHelper` | MCP 2026-07-28 makes authorization **OPTIONAL**, and Claude Code supports header auth as a first-class path. Building an OAuth 2.1 AS for one operator is the definition of over-engineering, and the leading self-hostable AS (Keycloak) still cannot satisfy the RFC 8707 MUST. |
| **L3. Approval reach = parked cards + ntfy action buttons + Telegram verdict fallback** (~1 day) | (a) card TTL 12-24 h for human-only cards, expiry **parks** instead of rejecting, asker gets a `deferred` disposition; (b) on card creation POST to ntfy with two `http` action buttons pointing at the tailnet `/api/approvals/decide`; (c) fallback: Telegram bot polled outbound with an inline keyboard whose `callback_data` is a server-issued nonce | This is the layer that actually fixes the lost cards. The verdict-on-a-server-issued-id design is copied verbatim from Anthropic's own permission-relay contract, which is the best-specified answer in the industry to "a decision arrived over an untrusted transport". |

**Fallback if Tailscale is unacceptable** (corporate MDM objection, or Paul does not want a VPN client): **Claude Code Remote Control**. Zero inbound exposure (outbound HTTPS only, never opens inbound ports), works from the Claude iOS app, has mobile push specifically for "actions required", reconnects by itself after laptop sleep, and it can drive a local `/approve` slash command that talks to the hub on 127.0.0.1. Costs: a Pro/Max subscription (already held) and the session transcript is stored on Anthropic servers while connected.

### Recommendations table

| # | Recommendation | Verdict | Rationale | Effort |
|---|---|---|---|---|
| 1 | Bind the hub HTTP listener to `127.0.0.1`; add an `Origin` **and `Host`** allowlist (403 on mismatch) | **adopt** | MCP 2026-07-28 Streamable HTTP: Origin validation is a MUST, localhost binding a SHOULD. Measured: `*:8790` bound, a hostile `Origin` gets a 200 with the full tool list, and only the SDK's `application/json` content-type check (415 on `text/plain`) blocks the trivial cross-origin POST. DNS rebinding survives, which is why `Host` must be checked too. CVE-2025-49596 (CVSS 9.4, `UI:P`) is the same class. | spike (2 h) |
| 2 | Require the session token on every `/api/*` read, not just writes | **adopt** | `/api/approvals` leaks the room handle, topic, `request_id`, requester and a 200-char preview of the draft; `/api/agents/<n>/definition` leaks the full French Goodvest prompt; `/api/runs?trace=` leaks payloads. The "reads stay tokenless" decision was sound at localhost and is wrong the moment anything else can reach the port. | spike (1 h) |
| 3 | Constant-time `human_key` compare + `/auth` rate limit + lockout + audit | **adopt** | `hub.cfg.humanKeys.includes(b.human_key)` is a non-constant-time compare on an unrate-limited endpoint that mints 12 h supervisor-grade tokens. | spike (1 h) |
| 4 | Tailscale tailnet + `tailscale serve` as the reach mechanism | **adopt** | Only option that gives remote reach while the hub keeps binding to loopback (`serve` proxies only `http://127.0.0.1`). Free plan covers it. WireGuard crypto, NAT traversal, MagicDNS, TLS certs and ACLs already solved. | day |
| 5 | `Tailscale-User-Login` as a second factor, trusted only behind an explicit serve-only hop marker | **adapt** | Serve injects and strips the header, so it is trustworthy *from tailscaled*, but any other loopback proxy could forge it (clawpatrol#316). Trust it only when a per-boot shared secret header set by a thin serve-side hop is also present, or verify the peer via the Tailscale local API. Never as the sole credential. | spike |
| 6 | Tailscale **Funnel** for the hub or console | **reject** | Funnel is anonymous public internet, carries **no identity headers**, only ports 443/8443/10000, and non-configurable bandwidth limits. It would put an unauthenticated `/mcp` on the public internet. | - |
| 7 | Static bearer tokens at the MCP transport, per agent, via `headers`/`headersHelper` | **adopt** | Authorization is OPTIONAL in MCP 2026-07-28; Claude Code documents `--header "Authorization: Bearer …"` and a `headersHelper` that regenerates headers per connection with automatic retry on 401/403. Satisfies the real requirement (only my agents can call my hub) at zero infrastructure. | spike (1 h) |
| 8 | Build or self-host an OAuth 2.1 authorization server (Keycloak / Ory Hydra) to satisfy "T1 OAuth" | **reject** | Keycloak nightly 26.7.1 still does not implement RFC 8707: its own MCP page says "Keycloak cannot recognize `resource` parameter" and rates MCP 2025-06-18 and 2025-11-25 as "Partially Supported without Resource Indicators". A single-operator deployment gains nothing an audience-bound static token does not already give, and pays a Java service, a realm, and a second failure domain. | - |
| 9 | Re-scope the spec's "T1 OAuth" tier to "T1 = audience-bound bearer at the transport; T2 = OAuth 2.1 + RFC 9728 + RFC 8707 when a second organisation joins" | **adopt** | Keeps the spec honest: T1 as written cannot be satisfied by any lightweight IdP today, so it is dead text. Record CIMD (not DCR) as the target client-registration mechanism when T2 arrives, since DCR is now **deprecated**. | spike (spec edit) |
| 10 | Cloudflare Tunnel + Cloudflare Access | **adapt / defer** | Technically excellent: outbound-only UDP/TCP 7844, no inbound ports, a verifiable RS256 JWT in `Cf-Access-Jwt-Assertion` with `aud`/`iss`/`email`, service tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) for machine clients, and a real free tier. Deferred because it needs a domain on Cloudflare, puts a third party in the path of every request and every draft, and introduces a second credential system next to the room secrets. **This is the option to pick the day a colleague needs access.** | week |
| 11 | Hand-rolled WireGuard | **reject** | Correct and free, and the config is 12 lines, but you then own key distribution, NAT traversal (`PersistentKeepalive = 25`), DNS, and TLS certs. Tailscale is WireGuard with those four solved. Reject on effort, not on security. | - |
| 12 | ngrok-class tunnel | **reject** | Free plan: 1 GB/month, **20,000 HTTP requests/month**, 3 online endpoints, one auto-assigned `*.ngrok-free.app` domain, browser interstitial. `room_listen` long-polls; a standing room would burn the request quota. And it publishes a URL on the public internet in front of an endpoint whose only auth is what you add. | - |
| 13 | Small VPS with the hub behind TLS | **reject as primary, adapt as rendezvous** | Moves the Linear API key, the Goodvest knowledge pack, `agents/*/state/memory.db` and the hash-chained log onto a rented box you must patch. Contradicts the local-first constraint that carried both prior waves. Keep a 5 EUR VPS in the back pocket as a *pure* WireGuard/`ssh -R` rendezvous carrying no secrets, for the day a hostile NAT blocks Tailscale. | week |
| 14 | `ssh -R` / `ssh -L` port forwarding | **adopt as break-glass only** | One command, no new dependency, and by default the remote listener binds loopback only unless the server sets `GatewayPorts`. Good for "I need the console from my other laptop for ten minutes". Bad as the standing arrangement: no identity layer, and it needs a reachable SSH host. | spike |
| 15 | Human-only approval cards get a 12-24 h TTL, and expiry **parks** rather than rejects | **adopt** | This is the actual root cause. `src/bridge.ts` defaults `timeoutMs` to `10 * 60_000` and the hub sweeps expired cards to `reject`; STATUS records the card being additionally capped to `reply_by - 30s`. A human away from the desk cannot beat that, however good the tunnel is. | day |
| 16 | ntfy (self-hosted on the Mac, or ntfy.sh with a high-entropy topic) as the push channel, with two `http` action buttons | **adopt** | The only surveyed personal-scale push that can carry a real **action**: `Actions: http, Approve, <url>, method=POST, headers.Authorization=…, body=…`, up to three actions, and the iOS app does execute `http` actions. Self-hostable with token auth (`tk_` tokens) and per-topic ACLs. | day |
| 17 | Telegram bot with an inline keyboard as the fallback verdict path | **adopt** | The only option that needs **zero inbound exposure**: the hub long-polls `getUpdates` outbound. `callback_data` is 1-64 bytes, enough for `a:<short_id>:<nonce>`; `answerCallbackQuery` closes the loop; `from.id` is the identity to gate on. Accept the cost: Telegram's servers see the card preview. | day |
| 18 | Copy Claude Code's permission-relay rules verbatim for any chat-transport verdict | **adopt** | Best-specified answer to the injection question in the industry: verdicts are accepted only for a server-issued id, wrong-id verdicts are dropped silently, the local surface stays live and first answer wins, the preview is sanitised (direction-override and invisible characters neutralised, quote and angle-bracket lookalikes quoted, whitespace runs folded, elision with a counted marker), and `description`/`input_preview` are explicitly "untrusted". | spike |
| 19 | Email with signed action links | **reject** | A one-click `GET` approve link is a side effect on a safe method (RFC 9110 9.2.1) in a channel where scanners and prefetchers click links. A POST-confirm page fixes correctness and loses the one-tap property that was the entire point. |  - |
| 20 | Pushover | **adapt (alerting only)** | No action buttons: one 512-char supplementary URL and that is it. Emergency priority (`retry`/`expire` max 10,800 s/`callback`/`receipt`) is a genuinely good *nag* primitive for a card about to park. 10,000 messages/month free. Not a decision surface. | spike |
| 21 | PWA on the tailnet with Web Push | **defer** | iOS Web Push works only for a home-screen web app with a manifest and a user-gesture subscribe (iOS/iPadOS 16.4+), and notification `actions` are explicitly not Baseline with "Safari/iOS support notably limited". Strictly more work than "open the tailnet console URL in Safari" for strictly less capability. | week |
| 22 | Claude Code Remote Control as the no-exposure fallback reach path | **adopt (as fallback)** | "Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports on your machine." Mobile push for "actions required", automatic reconnect after laptop sleep, works from the Claude iOS app. Costs a subscription and stores the transcript at Anthropic while connected. | spike |
| 23 | Accept that laptop sleep is an outage for every laptop-hosted option | **adopt (as documented behaviour)** | Measured `pmset` on this machine: `sleep 1` on AC, `powernap 1`, `womp 1` (wake for network access, AC), `tcpkeepalive 1`. Nothing serves HTTP while asleep. Mitigations, in order of preference: park the card (rec. 15) so nothing is lost; `caffeinate -s` (AC-only assertion) under launchd during work hours; only then consider an always-on host. | spike |

### What NOT to do

1. **Do not put the hub on the public internet in any form** (Funnel, ngrok, a VPS with a public 443) while `/mcp` has no transport auth. 91.8% of dynamically audited internet-facing MCP servers had no OAuth; 687 tool instances exposed shell execution with no access control. Do not join that dataset.
2. **Do not build an authorization server.** The spec's "T1 OAuth" line is currently unsatisfiable by the lightweight IdPs anyway (Keycloak: no RFC 8707). Re-scope the tier instead.
3. **Do not use Dynamic Client Registration** if OAuth ever does happen. It is **deprecated** as of 2026-07-28 in favour of Client ID Metadata Documents.
4. **Do not trust `Tailscale-User-Login` (or any proxy identity header) as a sole credential**, and do not trust it merely because the peer is loopback.
5. **Do not treat a chat message as an instruction.** A verdict is a `{request_id, behavior}` tuple against an id the hub minted. Anything else is untrusted text and must never reach a decision path. Corollary: never let the approval *preview* text be echoed back into a model prompt unbounded.
6. **Do not use a GET link as the approve action.**
7. **Do not enable Tailscale **Funnel** "just for the ntfy webhook".** If a public POST endpoint is ever needed, it gets its own tiny HMAC-verified receiver, not the hub.
8. **Do not rely on the Tailscale free plan without checking the licence.** The Personal plan page states it "is only suitable for non-commercial use of Tailscale". This is a personal tool used for Goodvest work; if that reads as commercial, it is 8 USD/user/month on Standard. Budget for it rather than discovering it later.
9. **Do not build the PWA.** It is the most seductive and least valuable item on the list.
10. **Do not ship reach without shipping rec. 15.** A reachable console that still rejects cards after 10 minutes has not solved the reported problem.

---

## Evidence

### 0. Ground truth: what the hub exposes today (measured, 2026-08-17)

Source: [`src/main.ts`](../../../src/main.ts) lines 112-330, [`src/store.ts`](../../../src/store.ts) `pendingApprovals()` at line 1151, and live process inspection.

**The listener.** `src/main.ts`:

```js
server.listen(port, () => {
  console.error(
    `rfa-hub: Streamable HTTP MCP at http://localhost:${port}/mcp (data: ${dataArg}, dual-era); console at http://localhost:${port}/console`,
  );
});
```

No host argument. Node's documented behaviour: "If `host` is omitted, the server will accept connections on the unspecified IPv6 address (`::`) when IPv6 is available, or the unspecified IPv4 address (`0.0.0.0`) otherwise", and "listening to the unspecified IPv6 address (`::`) may cause the `net.Server` to also listen on the unspecified IPv4 address (`0.0.0.0`)" (https://nodejs.org/api/net.html#serverlisten). Confirmed live: `TCP *:8790 (LISTEN)` on a `tcp46` socket. The log line saying `http://localhost:8790` is misleading.

**The auth model.** Verbatim from `src/main.ts`:

```js
const sessions = new Map<string, number>(); // token -> expires (ms)
const SESSION_TTL_MS = 12 * 3600_000;

function authed(req: http.IncomingMessage): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || exp < Date.now()) return false;
  sessions.set(m[1], Date.now() + SESSION_TTL_MS); // sliding
  return true;
}
```

and the mint:

```js
if (req.method === "POST" && pathname === "/auth") {
  const b = await body(req);
  if (typeof b.human_key !== "string" || !hub.cfg.humanKeys.includes(b.human_key)) {
    return send(res, 401, { error: "invalid human_key" });
  }
  const token = "st_" + randomBytes(24).toString("base64url");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return send(res, 200, { session_token: token, ttl_s: SESSION_TTL_MS / 1000 });
}
```

Properties, for the record:
- Token entropy: 24 random bytes = **192 bits**, well above OWASP's "at least 64 bits of entropy" floor. Good.
- TTL: 12 h **sliding**, refreshed on every authenticated request, with **no absolute cap**. OWASP asks for both an idle timeout and an absolute timeout ("typical ranges span 4-8 hours"). A token used once an hour never dies.
- Storage: in-memory `Map`, so a hub restart is a global logout. That is a *feature* (free revocation-on-restart) and should be documented as one.
- No revocation endpoint, no rotation on privilege change, no binding to anything.
- `humanKeys.includes(...)` is a non-constant-time comparison, on an endpoint with no rate limit, that mints a supervisor-grade credential.
- The console keeps the token in `sessionStorage` under key `wb_token` (`console/index.html` lines 1034-1067) while the page runs under CSP `script-src 'unsafe-inline'`. Any injected script reads it.

**What is readable with no token at all.** Every route below is served before the `authed()` gate:

| Route | Leaks |
|---|---|
| `GET /api/agents` | agent names, descriptions, model, effort, `definition_hash`, room handles, offers, heartbeat age |
| `GET /api/agents/<name>/definition` | the entire `agent.md`: system prompt, French Goodvest document templates, knowledge globs, tool list |
| `GET /api/runs`, `GET /api/runs?trace=<id>` | run tree with inputs/outputs, cost, tokens |
| `GET /api/summary` | error rates, latency, feedback averages |
| `GET /api/approvals` | per pending card: `room`, `topic`, `request_id`, `requester`, `requester_name`, `action`, `allowed_decisions`, `expires_at`, `held`, and `message_preview` (first 200 chars of the draft) |
| `POST /mcp` | the whole MCP tool plane, no transport credential whatsoever |

Writes (`PUT definition`, `POST lifecycle`, `POST feedback`, `POST approvals/decide`) do require the Bearer token, so an attacker on the LAN today can read the drafts and the prompts but cannot approve. That is the only thing standing between "embarrassing" and "a Linear document written by a stranger".

**Measured, not assumed** (probes against the live hub on 127.0.0.1:8790, 2026-08-17):

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8790/api/approvals
200
$ curl -s http://127.0.0.1:8790/api/agents | head -c 120
[ { "name": "linear-scribe", "description": "Drafts Goodvest Linear documents (expression de besoin, spec produit, spec design)…
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8790/api/summary
200
```

Tokenless reads confirmed, including the full `linear-scribe` description.

**Origin and content-type probes** (this answers what was going to be spike 10):

```
# A. text/plain + hostile Origin  ->  BLOCKED by the SDK's content-type check
$ curl -X POST http://127.0.0.1:8790/mcp -H 'Content-Type: text/plain' \
    -H 'Origin: https://evil.example' -H 'MCP-Protocol-Version: 2026-07-28' \
    -H 'Mcp-Method: tools/list' --data '<valid JSON-RPC tools/list>'
status=415
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unsupported Media Type: Content-Type must be application/json"},"id":null}

# B. application/json + hostile Origin  ->  200 with the full tool list
$ curl -X POST http://127.0.0.1:8790/mcp -H 'Content-Type: application/json' \
    -H 'Origin: https://evil.example' … --data '<valid JSON-RPC tools/list>'
status=200
{"result":{"tools":[{"name":"room_create", …

# C. the console page with a hostile Origin
status=200
```

Two conclusions, and they cut in opposite directions:

- **Good news, by accident:** the MCP SDK enforces `Content-Type: application/json`, which is *not* a CORS-simple content type. So a plain cross-origin `fetch` from a malicious page triggers a preflight, the hub returns no CORS headers, and the browser refuses. The trivial "a web page Paul visits calls his MCP server" attack is already closed, by the SDK rather than by us.
- **Bad news, as specified:** `Origin` is not validated at all, on `/mcp` or on `/console` or on `/api/*`. The vector that survives is **DNS rebinding**, where the attacker's own hostname resolves to `127.0.0.1`, making every request same-origin with a fully attacker-controlled content type. That is precisely the attack the MCP spec's Origin MUST names. It also means the mitigation should validate **both** `Origin` and `Host`: under rebinding the browser sends the attacker's hostname in `Host`, so a `Host` allowlist (`localhost:8790`, `127.0.0.1:8790`, `<node>.<tailnet>.ts.net`) is the more robust of the two controls and costs the same three lines.

**The card lifecycle, which is the actual bug.** [`src/bridge.ts`](../../../src/bridge.ts):

```js
const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
const requestId = `apr_${opts.runId ?? "run"}_${++approvalSeq}_${Date.now().toString(36)}`;
...
ext: {
  "io.github.pbeneteau/approval": {
    request_id: requestId,
    action: opts.toolName,
    allowed_decisions: opts.allowedDecisions ?? ["approve", "edit", "reject"],
    expires_at: new Date(Date.now() + timeoutMs).toISOString(),
  },
},
```

and the failure path:

```js
if (e.type === "system" && e.event === "approval_expired") {
  const refs = e.refs as { request_id?: string };
  if (refs.request_id === requestId) return { approved: false, reason: "approval expired unanswered" };
}
```

STATUS.md records the additional cap: "the bridge now caps the card expiry at the envelope's `reply_by` minus 30s (floor 60s): a card never outlives its audience", introduced because "the approval card (10 min) outlived the asker's patience (600s)". That fix was right for a human at the keyboard and is exactly wrong for a human on a train. The v0.4.2 sweep behaviour is "expires_at sweep-to-reject".

**Conclusion for the design:** two independent defects were conflated into one symptom. Reach fixes "I could not see the card". Only a lifecycle change fixes "the card was gone when I looked".

---

### 1. Network reach options

#### 1.1 Comparison table

| Option | What is exposed | Auth story | Laptop sleeps | Laptop changes network | Cost (2026) |
|---|---|---|---|---|---|
| **Tailscale tailnet + `serve`** | nothing on a public interface; a MagicDNS name reachable only by nodes in the tailnet; hub stays on 127.0.0.1 | device-level: WireGuard keys + tailnet ACL; plus `Tailscale-User-Login`/`-User-Name`/`-User-Profile-Pic` identity headers injected by Serve and stripped from inbound | node goes offline; nothing serves; reconnects on wake | transparent (WireGuard roaming + DERP relays); MagicDNS name unchanged | 0 USD on Personal (up to 6 users, unlimited user devices) but Personal is stated as non-commercial-use only; Standard 8 USD/user/mo |
| **Tailscale Funnel** | a **public**, anonymous HTTPS endpoint on `<node>.<tailnet>.ts.net`, ports 443/8443/10000 only | **none from the transport**: "Funnel traffic, which is publicly available, does not include identity headers". Whatever the app implements is all there is | same as above | same as above | 0 USD, plus non-configurable bandwidth limits |
| **WireGuard by hand** | one UDP port on whichever side is the "server"; if that is the laptop behind NAT, you need a rendezvous | static public-key peering; `AllowedIPs` is the authorisation model | tunnel dies; `PersistentKeepalive = 25` re-establishes on wake | roaming works (endpoint rediscovered from the latest authenticated packet) but only if one side has a stable endpoint | 0 USD + a rendezvous host if both ends are behind NAT (~5 EUR/mo) |
| **Cloudflare Tunnel (+ Access)** | a hostname on your Cloudflare zone; `cloudflared` dials **out** on UDP/TCP **7844** (QUIC default, HTTP/2 fallback); no inbound ports | Access in front: browser SSO -> `CF_Authorization` cookie + `Cf-Access-Jwt-Assertion` RS256 JWT (`aud`, `iss`, `email`, `exp`, `iat`) verified against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; machine clients use service tokens `CF-Access-Client-Id` / `CF-Access-Client-Secret` with policy action **Service Auth** | tunnel drops; origin unreachable; Cloudflare serves its own error | transparent (outbound reconnect) | Tunnel free; Zero Trust free tier covers a small number of seats (UNVERIFIED: the widely reported figure is 50 users; I could not load Cloudflare's own plan page to confirm). Needs a domain on Cloudflare |
| **ngrok-class** | a public `*.ngrok-free.app` URL, random per restart on free | whatever you implement, plus optional paid traffic-policy OAuth | tunnel drops, URL is lost | reconnects with a **new random URL** on free | free tier: 1 GB/mo, 20,000 HTTP req/mo, 5,000 TCP conn/mo, 4,000 req/min rate cap, 3 online endpoints, 1 agent-assigned domain, TLS endpoints "not available", browser interstitial |
| **VPS + hub behind TLS** | a public 443 on a rented box; the hub and all its data now live there | yours to build; Caddy/nginx + your own tokens | irrelevant (the VPS does not sleep) - the *point* of this option | irrelevant | 4-6 EUR/mo + patching + moving the Linear key and Goodvest knowledge off the laptop |
| **`ssh -R` to a VPS** | a port on the VPS, **loopback-bound by default** unless the server enables `GatewayPorts` | SSH keys; then whatever the app does | forward dies; needs `autossh`/`ServerAliveInterval` to re-dial | re-dials on new network | 4-6 EUR/mo for the VPS |
| **`ssh -L` from the remote device** | nothing new; the remote device pulls the port to itself | SSH keys | forward dies | re-dial | 0 USD if the laptop is SSH-reachable, which it usually is not |

#### 1.2 Tailscale: the load-bearing verbatim

`tailscale serve`, from https://tailscale.com/docs/reference/tailscale-cli/serve:
- syntax `tailscale serve [flags] <target>`
- flags `--bg`, `--https=<port>` (default mode), `--http=<port>`, `--tcp=<port>`, `--tls-terminated-tcp=<port>`, `--set-path=<path>`
- **"only `http://127.0.0.1` is supported for proxies"** - this single sentence is why Tailscale wins here: the hub can satisfy the MCP localhost SHOULD and still be reachable from the phone
- subcommands `status`, `reset`; disable by appending `off` to the original command
- example `tailscale serve localhost:3000`

Identity headers, from https://tailscale.com/docs/features/tailscale-serve:
- `Tailscale-User-Login` - "Filled with the requester's login name (for example, `alice@example.com`)"
- `Tailscale-User-Name` - "Filled with the requester's display name (for example, `Alice Architect`)"
- `Tailscale-User-Profile-Pic` - profile picture URL if the IdP provides one
- "These headers are stripped from incoming requests to prevent spoofing and are not populated for traffic from tagged devices."
- **"Serve traffic includes identity headers when serving traffic from your tailnet using Tailscale Serve. Funnel traffic, which is publicly available, does not include identity headers."**
- Serve requires HTTPS certificates enabled in the tailnet; the interactive CLI enables them if needed.

Funnel, from https://tailscale.com/docs/features/tailscale-funnel:
- "lets you route traffic from the broader internet to a local service running on a device in your Tailscale network" and share it "for anyone to access - even if they don't use Tailscale"
- **"Funnel can only listen on ports `443`, `8443`, and `10000`."**
- prerequisites: Tailscale v1.38.3+, MagicDNS enabled, HTTPS certificates enabled, and a policy-file node attribute:
  ```json
  "nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]
  ```
- "Funnel can only use DNS names in your tailnet's domain (`tailnet-name.ts.net`)"
- "Funnel only works over TLS-encrypted connections"
- **"Traffic sent over a Funnel is subject to non-configurable bandwidth limits"**
- same port cannot serve both Serve and Funnel simultaneously
- macOS: Funnel port sharing requires the App Store or Standalone system-extension variant; file/directory sharing requires the open-source variant
- Let's Encrypt rate limits can lock you out for ~34 hours if you churn certificates

Pricing, from https://tailscale.com/pricing:
- **Personal**: 0 USD "Free forever", "Unlimited user devices", "Up to 6 users", "Up to 3 ACL groups", "Up to 50 tagged resources to start", "1,000 mins per month for ephemeral resources", "Access nearly all of Tailscale's features". And: **"This is a free plan and is only suitable for non-commercial use of Tailscale."**
- **Standard** 8 USD/user/month; **Premium** 18 USD/user/month; Enterprise custom.

ACL/grant shape for restricting who reaches port 8790, from https://tailscale.com/kb/1337/acl-syntax (the detailed grants reference lives at `/docs/reference/syntax/grants`):

```json
{
  "action": "accept",
  "src": ["group:engineering"],
  "proto": "tcp",
  "dst": ["example-host-1:8443"]
}
```

```json
"tagOwners": {
  "tag:webserver": ["group:engineering"],
  "tag:secure-server": ["group:security-admins", "president@example.com"],
  "tag:corp": ["autogroup:member"]
}
```

The identity-header caveat, from https://github.com/denoland/clawpatrol/issues/316 ("Do not trust `Tailscale-User-Login` from arbitrary loopback proxies"): the described flaw is a gate that "trusts `Tailscale-User-Login` whenever the immediate peer is loopback", assuming public clients cannot reach localhost. That assumption breaks when a local reverse proxy (nginx, Caddy, `cloudflared`) forwards public traffic without stripping the header, letting an attacker forge an identity. Recommended mitigations, verbatim in substance: restrict header trust to listeners/paths exclusively serving Tailscale connections; require an additional shared secret or proxy-auth header that only the trusted Serve hop sets; make trusted identity headers opt-in; verify the peer through Tailscale's local API/whois rather than relying on the header alone.

**Design consequence for RFA:** trust `Tailscale-User-Login` only when a per-boot secret header, injected by a thin serve-side hop we control, is also present, and treat the pair as a *second* factor beside the session token, never a replacement.

#### 1.3 WireGuard by hand

From https://www.wireguard.com/quickstart/: config is `[Interface]` (`PrivateKey`, `ListenPort`, `Address`) and `[Peer]` (`PublicKey`, `AllowedIPs`, `Endpoint`, `PersistentKeepalive`). "WireGuard tries to be as silent as possible when not being used; it is not a chatty protocol." For a peer behind NAT the documented fix is persistent keepalives at **25 seconds**, which "keeps NAT mappings and firewall state tables active", set to 0 to disable. Roaming is inherent: the peer endpoint is learned from the most recent correctly authenticated packet, so a laptop changing networks is fine *as long as at least one side has a stable, reachable endpoint*. For a laptop-to-phone pair with both behind CGNAT, that stable side does not exist, which is precisely the problem Tailscale's DERP relays solve for free. Verdict: reject on effort.

#### 1.4 SSH port forwarding

From https://man.openbsd.org/ssh:
- `-L` forwards a local port to a host:port on the remote side; the local bind follows `GatewayPorts`; `bind_address` of `localhost` restricts the listener to local use, empty or `*` binds all interfaces.
- `-R` forwards a remote port to the local side, and **"By default, TCP listening sockets on the server bind to the loopback interface only"**, overridable only if the server's `GatewayPorts` is enabled.
- `-N` "do not execute a remote command", "useful for just forwarding ports"; `-f` backgrounds before command execution and implies `-n`; with `ExitOnForwardFailure=yes` a `-f` client "will wait for all remote port forwards to be successfully established before placing itself in the background".

So the break-glass one-liner from a remote machine that can reach the laptop's SSH (rare) is `ssh -N -L 8790:127.0.0.1:8790 mac`, and the standing form from the laptop to a VPS is `ssh -N -R 8790:127.0.0.1:8790 vps` with `ExitOnForwardFailure=yes` and `ServerAliveInterval`, wrapped in `autossh`. Loopback-by-default on `-R` is a real safety property: the VPS-side port is not public unless you also enable `GatewayPorts`, so you would then add a local reverse proxy with TLS and auth. At that point you have hand-built Cloudflare Tunnel with worse ergonomics.

#### 1.5 Cloudflare Tunnel and Access

From https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/: "A lightweight daemon in your infrastructure (`cloudflared`) creates outbound-only connections to Cloudflare's global network"; "Cloudflare Tunnel provides you with a secure way to connect your resources to Cloudflare without a publicly routable IP address"; you can "configure your firewall to allow only these outbound connections and block all inbound traffic".

Ports: Cloudflare's tunnel-with-firewall documentation specifies outbound **7844** on both TCP and UDP, QUIC by default with HTTP/2 fallback if UDP 7844 is blocked. (I could not load the canonical page directly - the URL has moved twice - so treat the port number as high-confidence-but-secondhand: multiple mirrors of Cloudflare's own docs state it identically. `UNVERIFIED:` the exact regional IP allowlists.)

Access JWT verification, from https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/:
- the JWT arrives in the **`Cf-Access-Jwt-Assertion`** header (recommended) and, for browsers, also as the `CF_Authorization` cookie
- signing keys at `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs`
- claims to check: `aud` (the application's AUD tag), `iss` (your team domain), `email`, `exp`, `iat`
- validation: extract, fetch JWKS, match `kid` against `public_certs`, verify RS256, then check `iss` and `aud`
- Cloudflare ships a Node/Express example using `jose`
- full identity via `POST` of the cookie to `https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity`
- the `CF_Authorization` cookie is paired with a binding cookie; a request with a valid `CF_Authorization` but no binding cookie is rejected at Cloudflare's edge, which is the anti-cookie-theft control

Service tokens, from https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/:
- headers `CF-Access-Client-Id: <CLIENT_ID>` and `CF-Access-Client-Secret: <CLIENT_SECRET>`
- single-header alternative: `Authorization: {"cf-access-client-id": "<CLIENT_ID>", "cf-access-client-secret": "<CLIENT_SECRET>"}`
- duration chosen at creation (documented example `8760h` = one year)
- **"set the policy action to Service Auth; otherwise, Access will prompt for an identity provider login"**

This is a genuinely well-built stack, and the `Cf-Access-Jwt-Assertion` shape is the right thing to copy if RFA ever needs a real remote identity claim. It loses today on three counts: a domain must be on Cloudflare, every request and every draft transits a third party, and the browser-SSO/service-token split means two credential systems for one operator.

#### 1.6 The failure mode every laptop option shares: sleep

Measured on this machine (`pmset -g custom`, 2026-08-17):

```
AC Power:
 powernap             1
 hibernatemode        3
 womp                 1
 tcpkeepalive         1
 sleep                1
 displaysleep         60
 disksleep            10
Battery Power:
 powernap             1
 womp                 0
 tcpkeepalive         1
 sleep                1
```

`womp 1` on AC means the Mac can be woken by network access; `tcpkeepalive 1` and `powernap 1` mean it periodically wakes for network maintenance. Neither serves HTTP: a sleeping Mac does not run the Node event loop. So Tailscale, Funnel, ngrok, WireGuard and `ssh -R` all have the same outage window, and STATUS already documents the observed shape of it: "The machine slept; at wake the supervisor detected the stale heartbeat and restarted pm-agent cleanly."

Mitigations, primary source `man caffeinate` (Darwin, /usr/bin/caffeinate):
- `-s` "Create an assertion to prevent the system from sleeping. **This assertion is valid only when system is running on AC power.**"
- `-i` prevents idle sleep; `-m` prevents disk idle sleep; `-d` prevents display sleep
- `-t <seconds>` bounds the assertion; `-w <pid>` releases it when that process exits
- if a utility is given, the assertion lasts for that utility's execution: `caffeinate -i make`

The clean pattern: `caffeinate -s -w $(pgrep -f 'rfa-hub')`-style wrapping under the existing launchd plist, only while on AC, ideally only during declared work hours. But the honest engineering answer is rec. 15: make the card survive the outage instead of trying to eliminate the outage.

---

### 2. The identity upgrade the spec defers as "T1 OAuth"

#### 2.1 What the spec currently says

[`spec/RFA-0.1.md`](../../../spec/RFA-0.1.md) section 8, tier table:

> | T1 | OAuth 2.1 client credentials at the MCP transport layer; RFC 8693 token exchange for on-behalf-of | SHOULD implement | Enterprise, cross-team |

and section 4.2:

> Agent principals MUST NOT be able to produce `origin: "human"`. Human consoles authenticate as human principals; hubs stamp accordingly. Reference binding (0.1.5): the hub is provisioned out-of-band with **human keys**; a join presenting a matching `human_key` becomes a human principal, a wrong key fails loudly with `join_denied` (never a silent downgrade), and no key means `origin: "agent"`. Possession of a provisioned key IS the principal class; message text never is.

That second paragraph is the good design and it survives contact with 2026. The T1 line does not: it names client credentials + RFC 8693, whereas the actual 2026 MCP requirement is a resource-server posture (RFC 9728 + RFC 8707) with CIMD-based client registration, and RFC 8693 appears nowhere in the current spec.

#### 2.2 Which MCP revision requires what (verbatim)

Revision history, from https://modelcontextprotocol.io/specification/versioning: identifiers are `YYYY-MM-DD` marking "the last date backwards incompatible changes were made"; revisions are Draft / Current / Final; **"The current protocol version is 2026-07-28."** Named earlier revisions in the current docs: `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`.

**2025-06-18** introduced the resource-server model: MCP servers are OAuth 2.0 Resource Servers, clients MUST implement RFC 8707 resource indicators, servers MUST implement RFC 9728 Protected Resource Metadata and MUST validate that tokens were issued for them, plus a dedicated security-best-practices page.

**2026-07-28** (current), from https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization, verbatim:

> Authorization is **OPTIONAL** for MCP implementations. When supported:
> * Implementations using an HTTP-based transport **SHOULD** conform to this specification.
> * Implementations using an STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment.
> * Implementations using alternative transports **MUST** follow established security best practices for their protocol.

Overview requirements, verbatim:

> 1. Authorization servers **MUST** implement OAuth 2.1 with appropriate security measures for both confidential and public clients.
> 2. Authorization servers and MCP clients **SHOULD** support OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00).
> 3. Authorization servers and MCP clients **MAY** support the OAuth 2.0 Dynamic Client Registration Protocol (RFC7591). Note that Dynamic Client Registration is deprecated and retained for backwards compatibility with authorization servers that do not support Client ID Metadata Documents.
> 4. MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC9728). MCP clients **MUST** use OAuth 2.0 Protected Resource Metadata for authorization server discovery.
> 5. MCP authorization servers **MUST** provide at least one of the following discovery mechanisms: OAuth 2.0 Authorization Server Metadata (RFC8414); OpenID Connect Discovery 1.0.

Normative base specs listed: OAuth 2.1 draft **`draft-ietf-oauth-v2-1-13`**, RFC 6750, RFC 8414, RFC 7591, RFC 8707, RFC 9728, **RFC 9207** (issuer identification), `draft-ietf-oauth-client-id-metadata-document-00`, OIDC Discovery 1.0, OIDC Dynamic Client Registration 1.0.

The 401 challenge shape, verbatim:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource",
                         scope="files:read"
```

Insufficient-scope shape, verbatim:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope",
                         scope="files:write",
                         resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource",
                         error_description="File write permission required for this operation"
```

Resource parameter, verbatim: clients "**MUST** be included in both authorization requests and token requests", "**MUST** identify the MCP server that the client intends to use the token with", "**MUST** use the canonical URI of the MCP server as defined in RFC 8707 Section 2", and "MCP clients **MUST** send this parameter regardless of whether authorization servers support it". Valid canonical URIs include `https://mcp.example.com:8443` and `https://mcp.example.com/server/mcp`; invalid ones include a bare host or anything with a fragment.

Token usage, verbatim: `Authorization: Bearer <access-token>` on **every** HTTP request; "Access tokens **MUST NOT** be included in the URI query string"; servers "**MUST** validate that access tokens were issued specifically for them as the intended audience"; "MCP servers **MUST NOT** accept or transit any other tokens"; and if the server calls upstream APIs it "**MUST NOT** pass through the token it received from the MCP client".

Error codes: 401 for authorization required/invalid token, 403 for invalid scopes, 400 for malformed.

From https://modelcontextprotocol.io/specification/2026-07-28/changelog, deprecation item 4, verbatim:

> Deprecate the OAuth 2.0 Dynamic Client Registration Protocol (RFC7591) as a client registration mechanism in favor of Client ID Metadata Documents (PR #2858). It remains available for backwards compatibility with authorization servers that do not support Client ID Metadata Documents.

Also relevant from that changelog: protocol-level sessions and the `Mcp-Session-Id` header are **removed**; `initialize` is removed and every request carries `_meta.io.modelcontextprotocol/protocolVersion`; `Mcp-Method` and `Mcp-Name` headers become required; `Last-Event-ID` resumability is removed.

#### 2.3 Client ID Metadata Documents (the thing that replaces DCR)

From https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration, verbatim highlights:

Selection priority for a client supporting all options:
> 1. Use pre-registered client information for the server if the client has it available
> 2. Use Client ID Metadata Documents if the Authorization Server indicates that it supports them (via `client_id_metadata_document_supported` in OAuth Authorization Server Metadata)
> 3. Use Dynamic Client Registration as a fallback if the Authorization Server supports it (via `registration_endpoint` in OAuth Authorization Server Metadata)
> 4. Prompt the user to enter the client information if no other option is available

Client requirements:
> * Clients **MUST** host their metadata document at an HTTPS URL following RFC requirements
> * The `client_id` URL **MUST** use the "https" scheme and contain a path component, e.g. `https://example.com/client.json`
> * The metadata document **MUST** include at least the following properties: `client_id`, `client_name`, `redirect_uris`
> * Clients **MUST** ensure the `client_id` value in the metadata matches the document URL exactly

Example document, verbatim:

```json
{
  "client_id": "https://app.example.com/oauth/client-metadata.json",
  "client_name": "Example MCP Client",
  "client_uri": "https://app.example.com",
  "logo_uri": "https://app.example.com/logo.png",
  "redirect_uris": [
    "http://127.0.0.1:3000/callback",
    "http://localhost:3000/callback"
  ],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

AS advertisement, verbatim:

```json
{
  "client_id_metadata_document_supported": true
}
```

DCR warning box, verbatim: "Dynamic Client Registration is deprecated. New implementations should use Client ID Metadata Documents instead."

Security note relevant to a local console: "Client ID Metadata Documents cannot prevent `localhost` URL impersonation by themselves"; authorization servers "SHOULD display additional warnings for `localhost`-only redirect URIs".

#### 2.4 Can a lightweight IdP satisfy this for one operator? Answered: no, and it does not matter

**Keycloak** - the only self-hostable AS with an *official* MCP integration page (https://www.keycloak.org/securing-apps/mcp-authz-server, documenting nightly **26.7.1**):
- **RFC 8707: not supported.** "Keycloak cannot recognize `resource` parameter."
- MCP version support matrix: `2025-03-26` fully supported; `2025-06-18` and `2025-11-25` "Partially Supported without Resource Indicators for OAuth 2.0".
- Workaround it documents: create optional client scopes (`mcp:tools`, `mcp:prompts`, `mcp:resources`) and attach **audience mappers** with `Included Custom Audience` set to the MCP server URL, so the `aud` claim is right even though `resource` is ignored.
- CIMD is supported as an **experimental** feature, enabled with `--features=cimd`, for MCP `2025-11-25`.
- Corroborating issue trail: keycloak/keycloak#14355 (the RFC 8707 feature request), #41526 ("MCP requirement - Token Audience Binding by RFC 8707 resource parameter"), PR #35711.

So the single most credible self-hosted AS cannot satisfy the client-side MUST that MCP places on the resource parameter, and the fix is a hand-configured audience mapper, which is exactly the "workaround" the Keycloak issue says supporting RFC 8707 would remove. Running Keycloak buys a JVM, a realm, a database, and an audience mapper you configured by hand: strictly worse than a token whose audience you control because you minted it.

**Tailscale identity headers** as the IdP: they authenticate a *human at a browser*, not an MCP client, and they are a proxy header with the caveats in 1.2. Good as a second factor for the console. Not an OAuth AS.

**Cloudflare Access** as the IdP: gives a verifiable RS256 JWT with `aud`/`iss`/`email` for browsers and service tokens for machines. This is the closest thing to a drop-in "lightweight IdP" that produces a real, checkable assertion. It is still not an MCP authorization server: it does not implement RFC 9728 protected-resource metadata on your behalf, does not honour RFC 8707 `resource`, and does not issue tokens an MCP client would discover. It is edge authentication, not MCP authorization.

**GitHub OAuth app**: no RFC 9728, no RFC 8707, no CIMD, no DCR. It can authenticate a human in a browser; it cannot be the AS an MCP client discovers.

**Ory Hydra / other self-hosted**: `UNVERIFIED:` I did not confirm Hydra's RFC 8707 status in this pass. Even if it supports it, the verdict does not change: the cost is a second always-on service on the same laptop, and the benefit at one operator is zero.

#### 2.5 What actually satisfies the requirement, because the requirement is not "be OAuth-compliant"

The real requirement is: *only my agents and my browser can call my hub, and the hub can tell which principal is calling.* MCP 2026-07-28 says authorization is OPTIONAL, so a non-OAuth scheme is conformant. And Claude Code, the client Paul actually uses, supports header auth as a documented first-class path.

From https://code.claude.com/docs/en/mcp, verbatim:

```bash
# Basic syntax
claude mcp add --transport http <name> <url>

# Example with Bearer token
claude mcp add --transport http secure-api https://api.example.com/mcp \
  --header "Authorization: Bearer your-token"
```

`--transport` and `--header` also accept `-t` and `-H`. In JSON config, `type` accepts `streamable-http` as an alias for `http`; an entry with a `url` and no `type` is a configuration error.

For rotating tokens, verbatim:

> If your MCP server uses an authentication scheme other than OAuth, such as Kerberos, short-lived tokens, or an internal SSO, use `headersHelper` to generate request headers at connection time. Claude Code runs the command and merges its output into the connection headers.

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "https://mcp.internal.example.com",
      "headersHelper": "/opt/bin/get-mcp-auth-headers.sh"
    }
  }
}
```

Requirements, verbatim: "The command must write a JSON object of string key-value pairs to stdout"; "The command runs in a shell with a 10-second timeout, from the session's current working directory"; "Dynamic headers override any static `headers` with the same name"; "The helper runs fresh on each connection, at session start and on reconnect. There is no caching"; and critically:

> If a tool call returns `401 Unauthorized` or `403 Forbidden`, Claude Code automatically re-runs the helper, reconnects with the fresh headers, and retries the call once.

Env vars set for the helper: `CLAUDE_CODE_MCP_SERVER_NAME`, `CLAUDE_CODE_MCP_SERVER_URL`, `CLAUDE_PLUGIN_ROOT`. Security note, verbatim: "`headersHelper` executes arbitrary shell commands."

Claude Code's OAuth side, for completeness: it discovers RFC 9728 protected-resource metadata at `/.well-known/oauth-protected-resource` first, then falls back to RFC 8414 at `/.well-known/oauth-authorization-server`; `oauth.authServerMetadataUrl` overrides discovery; `oauth.scopes` pins scopes; client secrets are stored in the macOS keychain. So if RFA ever *does* grow an AS, Claude Code is ready for it. It just does not need one today.

**Proposed spec re-scope (rec. 9):**

- **T1 (SHOULD, personal/single-operator): audience-bound bearer at the transport.** The hub mints per-principal tokens with a recorded `audience` = its own canonical URI, checks them before dispatching any MCP method, rejects with `401` and a `WWW-Authenticate: Bearer` challenge, and records the principal on every event. No AS, no discovery, no DCR.
- **T2 (SHOULD, multi-party): full MCP 2026-07-28 authorization.** RFC 9728 protected-resource metadata served by the hub, an external OAuth 2.1 AS, RFC 8707 audience validation, RFC 9207 `iss` validation, and **Client ID Metadata Documents** (not DCR) as the registration mechanism.
- Delete the RFC 8693 token-exchange mention or move it to T3; nothing in the current MCP spec asks for it.

---

### 3. Hardening the existing session-token model for exposure

Baseline recap from section 0: 192-bit token, 12 h sliding, in-memory, no absolute cap, no revocation, no binding, tokenless reads, unrate-limited mint with a non-constant-time compare.

#### 3.1 The normative floor (OWASP Session Management Cheat Sheet, verbatim substance)

From https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html:
- entropy: "at least `64 bits` of entropy"; with 64 bits and 100,000 concurrent sessions, ~585 years at 10,000 guesses/second. RFA's 192 bits is fine.
- content: "session IDs must be meaningless and random"; never embed data in the token.
- cookie attributes if you ever move off Bearer: `Secure`, `HttpOnly`, `SameSite=Strict` (preferred) or `Lax` as "defense in depth against CSRF", never relying on browser defaults; plus the `__Host-` prefix, "which enforces `Secure`, removes `Domain` attributes, and mandates `Path=/`".
- three timeouts, not one: **idle** (2-5 min high-value, 15-30 min lower-risk), **absolute** ("typical ranges span 4-8 hours"), and **renewal** (periodic mid-session regeneration of the id).
- regenerate "after any privilege level change", especially at authentication, to prevent fixation.
- binding to client properties (IP, User-Agent, device fingerprint) is recommended *with* the explicit caveat that "a skilled attacker can bypass these controls" via NAT, shared proxies, or UA spoofing.
- audit: log creation, renewal, destruction and critical operations, and "log a salted-hash of the session ID instead of the session ID itself".

#### 3.2 The concrete change list for `src/main.ts`

1. **Bind loopback.** `server.listen(port, process.env.RFA_BIND ?? "127.0.0.1", …)`. Reach comes from `tailscale serve`, which only proxies `http://127.0.0.1` anyway. Keep an explicit `--bind 0.0.0.0` escape hatch that prints a loud warning, so the choice is deliberate and visible in the log.
2. **Origin allowlist, 403 on mismatch.** MCP 2026-07-28 Streamable HTTP, verbatim:
   > 1. Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks.
   >    * If the `Origin` header is present and invalid, servers **MUST** respond with HTTP 403 Forbidden. The HTTP response body **MAY** comprise a JSON-RPC *error response* that has no `id`.
   > 2. When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0).
   > 3. Servers **SHOULD** implement proper authentication for all connections.
   >
   > Without these protections, attackers could use DNS rebinding to interact with local MCP servers from remote websites.

   Allowlist: `http://localhost:<port>`, `http://127.0.0.1:<port>`, and `https://<node>.<tailnet>.ts.net`. Absent Origin (a CLI/agent client) is allowed and covered by the bearer token instead. **Validate `Host` with the same allowlist**: measured probes (section 0) show the surviving vector is DNS rebinding, where `Origin` becomes the attacker's own domain and only `Host` still carries the attacker's hostname. Two checks, one allowlist, three lines.
3. **Token required on reads.** Flip the default: `/api/*` requires `authed()`; carve out nothing. If a read-only observer surface is wanted later, mint a scoped read-only token rather than leaving the routes open. This is the single highest-value line-count-to-risk change on the list.
4. **Constant-time key compare + throttle + lockout.** `crypto.timingSafeEqual` over equal-length buffers (hash both sides first so lengths match), a token bucket per source address (5 attempts/minute, then exponential backoff), and a hard lockout with an audited system event after N failures. The `human_key` is the crown jewel: it is what makes `origin: "human"` possible, which is what makes an approval sound under spec 4.2.
5. **Two timeouts plus rotation.** Keep the 12 h sliding idle window but add an absolute cap (`issued_at + 12h`, no extension) and rotate the token id on every privilege-relevant event (first successful `/auth`, and any `approvals/decide`). Return the new token in a response header so the console swaps it transparently.
6. **Explicit revocation.** `POST /auth/revoke` (all sessions, or the presenting one) plus a persisted `revoked_before` timestamp so a restart-free logout is possible. Today the only revocation is a hub restart, which also kills the rooms.
7. **Bind the token to something.** Ranked by value for this deployment:
   - **(best, nearly free) tailnet identity as a second factor.** Store the `Tailscale-User-Login` seen at mint time in the session record and require the same value on every subsequent request, trusting the header only when the serve-hop marker is present (see 1.2). A stolen token is then useless off the tailnet.
   - **(good) mTLS client certificate**, terminated by a thin local hop, with the certificate fingerprint stored in the session record. iOS can install a client-cert configuration profile. This is the strongest binding available without new protocol work.
   - **(standards-blessed, overkill here) DPoP (RFC 9449)**, sender-constrained proofs bound to a client key pair. `UNVERIFIED:` I did not read RFC 9449 directly in this pass; do not implement from this line. Cited only to record that the standards-track answer exists and that it is a poor fit for a browser console with no OAuth stack.
   - **(explicitly rejected) IP pinning.** OWASP's own caveat plus the fact that a roaming laptop and phone change addresses constantly.
8. **CSRF.** Bearer-in-header is already immune to classic form CSRF, and there is no cookie to abuse. Keep it that way: do **not** move the workbench token into a cookie for convenience. Two follow-ons: tighten the console CSP (it is currently `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:`) by adding `frame-ancestors 'none'` and `form-action 'none'`, and get the token out of `sessionStorage` if the inline-script CSP stays (an injected script reads `wb_token` today).
9. **Rate-limit the decision endpoint too.** `POST /api/approvals/decide` should be idempotent per `request_id` and refuse a second decision for the same card, so a replayed action-button tap cannot flip a verdict.
10. **Audit every one of the above.** The hub already hash-chains events over JCS-SHA256 (`src/jcs.ts`, spec 0.1.7). Route auth attempts, token mints, rotations, revocations, and remote decisions into the same chain, recording a salted hash of the token and the transport the decision arrived on (`console` / `ntfy` / `telegram` / `cli`). Provenance of a decision is now a security property, not a nicety: an approval that wrote to Linear must be attributable to a channel.

---

### 4. The mobile/remote approval channel

#### 4.1 The constraint nobody else has solved for you: the decision arrives over a transport you do not trust

Anthropic shipped the best-specified answer to this exact problem, and it is directly copyable. From https://code.claude.com/docs/en/channels-reference, "Relay permission prompts", verbatim:

Capability declaration:

```ts
capabilities: {
  experimental: {
    'claude/channel': {},
    'claude/channel/permission': {},  // opt in to permission relay
  },
  tools: {},
},
```

Outbound request is `notifications/claude/channel/permission_request` with four string params:

| Field | Description (verbatim) |
|---|---|
| `request_id` | "Five lowercase letters drawn from `a`-`z` without `l`, so it never reads as a `1` or `I` when typed on a phone. Include it in your outgoing prompt so it can be echoed in the reply. **Claude Code only accepts a verdict that carries an ID it issued.** The local terminal dialog doesn't display this ID, so your outbound handler is the only way to learn it." |
| `tool_name` | "Name of the tool Claude wants to use, for example `Bash` or `Write`." |
| `description` | "Human-readable summary of what this specific tool call does, never the command itself. … when the model gives no description, the field is the constant `Run shell command` and carries zero command detail." |
| `input_preview` | "The tool's arguments as JSON-shaped display text, keyed per top-level field. … Your server decides what to show." |

Sanitisation, verbatim:

> Clients on Claude Code v2.1.211 or later sanitize both fields before relaying them: they neutralize direction-override and invisible characters and quote and angle-bracket lookalikes, fold whitespace runs to a single space, and relay text whole up to 3,500 code points, applied per top-level field for `input_preview`, which also keeps the JSON's own structural quotes. A longer value keeps its start and end visible around a counted `⋯ N code points elided ⋯` marker, so the end of a long command still reaches the approver. **Treat both fields as untrusted unless you control the client fleet.**

Verdict, verbatim: "`notifications/claude/channel/permission` with two fields: `request_id` echoing the ID above, and `behavior` set to `'allow'` or `'deny'`. Allow lets the tool call proceed; deny rejects it, the same as answering No in the local dialog. **Neither verdict affects future calls.**"

Reference parser, verbatim:

```ts
// matches "y abcde", "yes abcde", "n abcde", "no abcde"
// [a-km-z] is the ID alphabet Claude Code uses (lowercase, skips 'l')
// /i tolerates phone autocorrect; lowercase the capture before sending
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
```

Sender gating, verbatim:

> An ungated channel is a prompt injection vector. Anyone who can reach your endpoint can put text in front of Claude. … Gate on the sender's identity, not the chat or room identity: `message.from.id` in the example, not `message.chat.id`. In group chats, these differ, and gating on the room would let anyone in an allowlisted group inject messages into the session.

> Only declare the capability if your channel authenticates the sender, because **anyone who can reply through your channel can approve or deny tool use in your session**.

Failure semantics, verbatim: "**Different format**: your inbound handler's regex fails to match, so text like `approve it` or `yes` without an ID falls through as a normal message to Claude. **Right format, wrong ID**: your server emits a verdict, but Claude Code finds no open request with that ID and drops it silently." And: "Both stay live: you can answer in the terminal or on your phone, and Claude Code applies whichever answer arrives first and closes the other."

**Six rules RFA should adopt verbatim:**
1. Verdicts are accepted only against a server-issued id. Mint a short, phone-typable, unambiguous id (RFA's `apr_<run>_<n>_<b36>` is fine for the log and unusable on a phone: add a five-character display alias).
2. A verdict is `{request_id, behavior}`. Nothing else from the transport is executable. Never parse intent out of free text.
3. Wrong-id verdicts are dropped silently. Never confirm or deny the existence of an id to the transport.
4. The console stays live throughout. First decision wins, the other is closed. RFA already has this shape: the decision is an intervention event and `requestApproval` returns on the first matching one.
5. Sanitise the preview before it leaves the machine: neutralise direction-override and invisible characters, fold whitespace, cap length with a counted elision marker that preserves head and tail.
6. Gate on sender identity, never room identity.

#### 4.2 Channel-by-channel comparison

| Channel | Carries an ACTION? | Identity / authenticity | Injection risk | Offline / expiry | Inbound exposure needed |
|---|---|---|---|---|---|
| **ntfy** (self-hosted or ntfy.sh) | **Yes**: up to 3 actions, types `view` / `broadcast` / `http` / `copy`; the `http` action does a real HTTP request with `method`, `url`, `headers`, `body` | Server-side: `tk_`-prefixed 32-char access tokens or Basic auth, per-topic ACLs (`read-write`/`read-only`/`write-only`/`deny`), `auth-default-access: deny-all`. Client-side authenticity of a tap = whatever credential you put in the action's `headers` | Moderate: the action body is composed by *your* server, so the phone cannot inject content; the risk is a leaked topic name letting someone else publish *decoy* cards. Mitigate with `auth-default-access: deny-all` and a high-entropy topic | Messages cached and "kept until 12 hours after delivery"; iOS delivery without `upstream-base-url` "can take hours" | **None for the notification** (hub POSTs out). The `http` action needs the decision endpoint reachable from the phone: on the tailnet that is satisfied without any public exposure |
| **Telegram bot** | **Yes**: `InlineKeyboardMarkup` with `callback_data` (1-64 bytes) per button; `answerCallbackQuery` acknowledges | `CallbackQuery.from` is a Telegram `User`: gate on `from.id`. Webhook mode adds `secret_token` (1-256 chars of `A-Z a-z 0-9 _ -`) echoed in the `X-Telegram-Bot-Api-Secret-Token` header. Poll mode (`getUpdates`) needs no secret because there is no inbound | Low **if** you follow 4.1: `callback_data` is server-issued and echoed back, so bind a nonce and validate it. High if you ever parse free text | Telegram queues messages; a button on an old message still fires, so the hub must reject verdicts for closed cards | **Zero** in `getUpdates` long-poll mode. This is the only actionable channel with no inbound surface at all |
| **Pushover** | **No.** One `url` (max 512 chars) + `url_title` (max 100). No action buttons | App-token + user-key, both server-side | Very low (no inbound path) | Emergency priority 2 with `retry` (min 30 s) / `expire` (max 10,800 s = 3 h) / `callback` / `receipt`: a genuine repeat-until-acknowledged nag | None. Also no decision surface |
| **Apple Push via a shortcut** | Partially. Apple's own APNs needs a paid developer account and an app. The practical route is a third-party actionable-notification app (Pushcut and similar) whose notification buttons run a Shortcut or hit a URL | Whatever the third-party app provides | Depends entirely on that app | Depends | `UNVERIFIED:` I did not verify any specific vendor's current API in this pass. Treat as a strictly worse ntfy with a closed vendor |
| **Email with signed action links** | Only as a `GET`, which is the problem | An HMAC over `{request_id, decision, exp}` is genuinely verifiable | The link is the credential and it sits in a mailbox with scanners, prefetchers and forwarding rules. RFC 9110 9.2.1: safe methods are "only for information retrieval and should not cause changes to server state", and automated prefetching is an explicitly contemplated behaviour | Email is durable, which cuts both ways: a stale approve link is a loaded gun | None, if the endpoint is on the tailnet; but then the link does not work off-tailnet, removing the one advantage email had |
| **PWA on the tailnet + Web Push** | In principle yes, via service-worker `showNotification` actions. In practice on iOS: no | VAPID + the tailnet TLS cert | Low | Standard Web Push queueing | iOS requires a home-screen web app with a manifest (`display: standalone` or `fullscreen`) on iOS/iPadOS **16.4+**, and the subscribe call must be "in response to direct user interaction". `Notification.actions` is "not Baseline", "Safari/iOS support is notably limited", and actions only work for persistent service-worker notifications (`TypeError` from the `Notification()` constructor) |
| **Claude Code Remote Control** | **Yes**, for Claude Code's *own* permission prompts and for driving a session that can then call the hub on localhost | claude.ai account credentials, "multiple short-lived credentials, each scoped to a single purpose and expiring independently"; Trusted Devices adds Face ID/passkey step-up on Team/Enterprise | Low: it is a first-party surface | `dialogExpiry` (default 5 min for forwarded dialogs other than permission prompts and `AskUserQuestion`, which stay open until answered); server mode gives up after ~10 min of network loss, interactive mode retries indefinitely | **Zero**: "Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports on your machine" |

#### 4.3 ntfy: the load-bearing verbatim

From https://docs.ntfy.sh/publish/:
- "You can add **up to three user actions** to notifications"
- action types: `view` (open a website/app), `broadcast` (Android intent), `http` (send an HTTP request), `copy` (clipboard)
- short header format: `<action1>, <label1>, paramN=... [; <action2>, <label2>, ...]` (semicolons separate actions, commas separate key/value pairs); JSON body format uses an `actions` array of objects with `action`, `label`, and type-specific fields
- `http` action fields:

| Field | Required | Type | Default | Example |
|---|---|---|---|---|
| `action` | yes | string | - | `http` |
| `label` | yes | string | - | `Close door` |
| `url` | yes | string | - | `https://api.example.com/` |
| `method` | no | GET/POST/PUT | `POST` | `PUT` |
| `headers` | no | map | - | `Authorization: Bearer token` |
| `body` | no | string | empty | `{"action":"close"}` |
| `clear` | no | boolean | `false` | `true` |

- priorities: `max`/`urgent` (5), `high` (4), `default` (3), `low` (2), `min` (1)
- max message size **4,096 bytes**; max attachment 15 MB; 100 MB total per visitor; attachments expire after 3 hours; "Cache retention: Messages kept until 12 hours after delivery"

From https://docs.ntfy.sh/config/:
- auth: `auth-file` (SQLite) or `database-url` (Postgres); roles `user` and `admin`; `auth-default-access` one of `read-write`, `read-only`, `write-only`, `deny-all`; declarative `auth-users`, `auth-access`, `auth-tokens`; the `ntfy access` command manages ACLs with `read-write`/`read-only`/`write-only`/`deny` and `*` wildcards
- tokens are `tk_`-prefixed, 32 characters, and "Access tokens grant users **full access to the user account**" aside from password change and account deletion. Consequence: an ntfy token in a notification action is not a scoped capability; keep the *decision* credential separate from the *ntfy* credential.
- iOS instant delivery from a self-hosted server:
  ```yaml
  upstream-base-url: "https://ntfy.sh"
  upstream-access-token: "..."  # optional
  ```
  "When configured, ntfy forwards `poll_request` messages to the upstream server containing the message ID. … The request includes only the message ID (in the `X-Poll-ID` header) and the SHA256 checksum of the topic URL." Without it, "notifications will still eventually get to your device, but delivery can take hours, depending on the state of the phone."
- rate limiting knobs: `visitor-request-limit-burst` (default 60), `visitor-request-limit-replenish` (default 5s), `visitor-message-daily-limit`, `visitor-attachment-total-size-limit` (100M), `visitor-attachment-daily-bandwidth-limit` (500M), `visitor-email-limit-burst` (16), `visitor-email-limit-replenish` (1h), `visitor-topic-creation-limit-burst` (100), `visitor-prefix-bits-ipv4` (32), `visitor-prefix-bits-ipv6` (64), `behind-proxy`, `proxy-forwarded-header` (default `X-Forwarded-For`), `proxy-trusted-hosts`

iOS caveats, from https://github.com/binwiederhier/ntfy-ios (docs/TECHNICAL_LIMITATIONS.md) and the linked issues:
- no foreground services on iOS; delivery leans on Firebase/APNs plus background tasks, and Apple runs background tasks "NOT when you schedule / request them" (a 15-minute refresh ran **once in a whole day** in the maintainer's testing)
- a fully self-hosted iOS path would require the operator to run Firebase and build their own app; the supported route is relaying poll requests to ntfy.sh
- known bug (binwiederhier/ntfy#1728): the iOS app accepts `clear: true` on an `http` action but never removes the delivered notification, because `ActionExecutor.swift` dispatches via `URLSession.shared.dataTask` and never calls `UNUserNotificationCenter.current().removeDeliveredNotifications()`. Practical effect: **after tapping Approve on iOS you get no visual confirmation and the notification stays on the lock screen.** Design around it: have the hub publish a *second* message ("card `abcde` approved, document created") so the human sees the outcome. Do not rely on the tap for feedback.

**Concrete card publish (ready to implement).** Hub side, on card creation:

```
POST https://ntfy.<host>/rfa-approvals
Authorization: Bearer tk_<ntfy token>
Title: Approve: save_document (linear-scribe)
Priority: high
Tags: warning
Actions: http, Approve, https://<mac>.<tailnet>.ts.net/api/approvals/decide, method=POST, headers.Authorization=Bearer <one-shot card token>, headers.Content-Type=application/json, body={"room":"r_9a25e48c0e","request_id":"apr_...","verb":"approve"}; http, Reject, https://<mac>.<tailnet>.ts.net/api/approvals/decide, method=POST, headers.Authorization=Bearer <one-shot card token>, headers.Content-Type=application/json, body={"room":"r_9a25e48c0e","request_id":"apr_...","verb":"reject"}; view, Open console, https://<mac>.<tailnet>.ts.net/console#r_9a25e48c0e

<sanitised 200-char preview>  (card abcde, expires 2026-08-18T09:12Z)
```

Notes that matter: the `one-shot card token` is **not** the 12 h session token. It is a per-card, single-use, card-scoped credential with the card's own expiry, so a notification sitting on a lock screen is not a standing grant to the whole workbench. `/api/approvals/decide` must be idempotent per `request_id`. The third `view` action is the escape hatch for "I want to read the whole draft first" and for `edit`, which cannot be expressed in a notification button.

#### 4.4 Telegram: the load-bearing verbatim

From https://core.telegram.org/bots/api:
- `InlineKeyboardMarkup`: `inline_keyboard` is an "Array of Array of InlineKeyboardButton" (rows)
- `InlineKeyboardButton`: `text` (1-64 characters), `url`, **`callback_data` (1-64 bytes)**, `web_app`, `login_url`, `switch_inline_query`, `copy_text`, `callback_game`, `pay`
- `CallbackQuery`: `id`, **`from` (User)**, `chat_instance`, `message`, `inline_message_id`, `game_short_name`, `data` ("up to 64 bytes")
- `answerCallbackQuery`: `callback_query_id` (required), `text` (0-200 chars), `show_alert`, `url`, `cache_time`
- `setWebhook`: `url`, `certificate`, `ip_address`, `max_connections` (1-100, default 40), `allowed_updates`, `drop_pending_updates`, **`secret_token`** (1-256 chars, `A-Z a-z 0-9 _ -`): "If specified, the request will contain a header `X-Telegram-Bot-Api-Secret-Token` with the secret token as content."

`callback_data` budget: 64 bytes fits `a:<5-char alias>:<32-hex nonce>` = 40 bytes with room to spare. Use `getUpdates` long polling, not `setWebhook`: polling is outbound-only, so no port, no TLS cert, no public URL, and the `secret_token` mechanism becomes unnecessary. Accept a verdict only when all four hold: `from.id` is in the allowlist, the alias maps to an open card, the nonce matches the one minted with the card, and the card has not already been decided. Then `answerCallbackQuery` with `show_alert` to confirm, and edit the message to strike the keyboard so the button cannot be re-tapped.

The cost to accept, stated plainly: **Telegram's servers see the card title and preview.** For a French Linear draft about Goodvest product work that is a real, if modest, third-party disclosure. Mitigate by sending only `tool_name` + card alias + a one-line neutral summary over Telegram, with the full preview available only in the tailnet console.

#### 4.5 What Claude Code's own remote stack gives for free

From https://code.claude.com/docs/en/remote-control:
- "Remote Control connects claude.ai/code or the Claude app for iOS and Android to a Claude Code session running on your machine."
- **"Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports on your machine. When you start Remote Control, it registers with the Anthropic API and polls for work."**
- "All traffic travels through the Anthropic API over TLS … The connection uses multiple short-lived credentials, each scoped to a single purpose and expiring independently."
- "if your laptop sleeps or your network drops, Claude Code reconnects automatically when your machine comes back online. Claude Code queues status updates from subagents and workflows while the connection is rebuilding and delivers them once it recovers."
- "While Remote Control is connected, the session transcript, including your messages, Claude's responses, and tool activity, is stored on Anthropic servers." Turn off entirely with `disableRemoteControl`. "Organizations with compliance requirements such as Zero Data Retention can't enable Remote Control."
- Requirements: Pro/Max/Team/Enterprise (API keys not supported); `/login` through claude.ai; **not** available when `ANTHROPIC_BASE_URL` points somewhere other than `api.anthropic.com`; `DISABLE_TELEMETRY` / `DO_NOT_TRACK` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_GROWTHBOOK` each disable it; the project folder must be trusted.
- Modes: `claude remote-control` (server mode, prints a session URL, spacebar shows a QR code, `--capacity` default 32, `--spawn same-dir|worktree|session`), `claude --remote-control` / `--rc` (interactive plus remote), `/remote-control` from inside a session, and `/rc` in VS Code.
- Mobile push, verbatim: "run `/config` and enable **Push when Claude decides** for proactive notifications, **Push when actions required** for permission prompts and questions, or both." Presence suppression: "Claude Code skips mobile push notifications while you are typing in or focused on the connected terminal. As of v2.1.181, you can set `CLAUDE_CLIENT_PRESENCE_FILE` to a marker file path to extend this to any time you are at the machine."
- Nudges it already implements: a **"Still working"** notification with a "Check in from your phone" link on long turns, and an **"Approve tool calls from your phone"** notification "after you answer several permission prompts in a session".
- Expiry, verbatim: "Claude Code keeps permission prompts and `AskUserQuestion` questions open until you answer them. When Claude Code forwards another kind of dialog to the remote session … it waits five minutes by default, then closes the dialog and continues with the dialog's no-action default. Set `dialogExpiry` to adjust or disable the deadline."
- Network-loss behaviour: server mode "gives up after roughly 10 minutes and the `claude remote-control` process exits"; interactive mode "retries for as long as the outage lasts".

**Two lessons RFA should steal directly.** (1) "Keep permission prompts open until you answer them" is the correct default, and it is the opposite of RFA's current sweep-to-reject. (2) A presence marker file is a clean way to avoid notifying a human who is already at the keyboard: reuse `CLAUDE_CLIENT_PRESENCE_FILE` semantics, or the console's own long-poll liveness, to suppress the push when the console is open.

Channels (research preview) are the other half: an MCP server declaring `capabilities.experimental['claude/channel']` pushes `notifications/claude/channel` events with `content` and `meta` into a live session, arriving as `<channel source="…" key="value">body</channel>`. Telegram, Discord and iMessage plugins ship in the preview; a custom channel needs `--dangerously-load-development-channels`. Note the delivery honesty, verbatim: "Claude Code doesn't acknowledge notifications. The `await` on `mcp.notification()` resolves when the message is written to the transport, not when Claude has processed it. If the session hasn't loaded your server as a channel, or the organization policy blocks it, Claude Code drops the events silently."

Relevance boundary, stated so a future reader does not over-claim: RFA residents run under the **Agent SDK** with a `canUseTool` bridge, not as interactive Claude Code sessions, so `claude/channel/permission` relay does **not** apply to `linear-scribe` approvals. What transfers is the *contract*, not the plumbing. What transfers as plumbing is Remote Control, because it reaches the *machine*, from which localhost is reachable.

#### 4.6 The card-lifecycle change (rec. 15), spelled out

Today: `timeoutMs ?? 10 * 60_000`, capped to `reply_by - 30s` (floor 60s), swept to `reject`, and `requestApproval` returns `{approved: false, reason: "approval expired unanswered"}`.

Proposed:

1. **Two clocks, not one.** `asker_deadline` (the envelope's `reply_by`, which governs what the asker is told) and `human_deadline` (12-24 h, or none, which governs the card). Stop deriving the second from the first.
2. **Expiry parks, it does not reject.** New card status `parked`. At `asker_deadline`, the resident answers the asker with an explicit deferred disposition ("drafted, awaiting human approval, card `abcde`") instead of a rejection, and the run is journaled as `awaiting_human`. The engine already has durable runs, memoized steps and replay (`src/engine.ts`), so resuming on a late decision is a resume, not a re-run.
3. **The parked card keeps its inbox row and its notification.** Re-notify on a schedule that respects presence: nothing while the console is open, a `high` ntfy push at creation, a Pushover priority-2 nag only if the card is about to cross `human_deadline`.
4. **`reject` becomes a decision a human makes, never a thing a clock does.** A clock-driven rejection is indistinguishable in the log from a considered refusal, which is a provenance bug in a hash-chained audit trail.
5. **On wake, replay.** The supervisor already detects stale heartbeats at wake; have it also re-push every parked card so a night of sleep produces one morning notification per open card rather than silence.

---

### 5. What an exposed hub adds to the threat model, and the minimum defensible posture

#### 5.1 The population you would be joining

"Exposed by Design: A Dynamic Security Assessment of Internet-Facing MCP Servers at Scale", https://arxiv.org/html/2608.00150, measurements across four runs in **July 2026** (July 15, 18, 21, 24):
- **640** unique production MCP servers confirmed; **414** dynamically audited
- **91.8%** of audited servers lacked OAuth authentication (380 of 414)
- **"687 tool instances across confirmed servers expose shell execution capabilities without access controls whatsoever"**
- 68 reportable vulnerabilities: Tool Poisoning (MCP01) 47 servers, Command Injection (MCP06) 38, SSRF (MCP04) 29, Authentication Deficiencies (MCP08) 380, Prompt Injection (MCP03) 22
- churn: between runs 3 and 4 (72 hours) **41.6%** of previously confirmed servers disappeared (193 of 464)
- recommendations: "MCP SDK implementations enforce OAuth 2.1 as the default for HTTP transport" and "server registries surface authentication posture as a first-class metadata field"

Census scale (vendor research, Censys, https://censys.com/blog/mcp-servers-on-the-internet/): **12,520** MCP services on **8,758** unique IPs across 56 countries and 425 autonomous systems as of **2026-04-28**, updated to "over 21,000" by 2026-05-06, with the note "At a minimum, the servers discussed throughout this blog were accessible without authentication" and that they only enumerated, never executed.

The class of bug that hits a *local* server specifically: **CVE-2025-49596**, MCP Inspector, https://nvd.nist.gov/vuln/detail/CVE-2025-49596. Verbatim: "Versions of MCP Inspector below 0.14.1 are vulnerable to remote code execution due to lack of authentication between the Inspector client and proxy, allowing unauthenticated requests to launch MCP commands over stdio." CVSS v4.0 **9.4 CRITICAL**, `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:P/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H`, CWE-306 (Missing Authentication for Critical Function), published 2025-06-13, fixed in 0.14.1, credited to Rémy Marot (Tenable). Note `UI:P` in the vector: user interaction is *passive*, which is the signature of a browser-mediated attack on a local listener. (`UNVERIFIED:` neither NVD nor the GHSA advisory names DNS rebinding or 0.0.0.0 as the vector; the widely reported mechanism is a malicious web page reaching the local proxy. The MCP spec's own Origin-validation MUST exists for exactly this class, which is sufficient grounding for the mitigation regardless.)

#### 5.2 The delta: localhost versus exposed

| | Localhost-only (intended) | LAN-exposed (actual, today) | Tailnet-exposed (proposed) | Public (rejected) |
|---|---|---|---|---|
| Who can reach `/mcp` | processes on this Mac, plus any web page Paul visits (no Origin check) | + every device on the current Wi-Fi | + Paul's own devices only, gated by tailnet ACL | + the entire internet and its scanners |
| Who can read pending drafts | same | same | same | same |
| Who can approve | holder of a `human_key` or a live session token | same | same | same |
| Credential theft surface | local malware; XSS in the console reading `sessionStorage` | + passive network capture on a hostile LAN (plain HTTP) | WireGuard-encrypted; no plaintext on the wire | + credential stuffing, token brute force |
| Blast radius if breached | Linear API key (writes to the real Goodvest workspace), Goodvest knowledge pack, `agents/*/state/memory.db` facts, the hash-chained log, the agent prompts | same | same | same |
| New failure modes | - | café Wi-Fi is a hostile LAN | tailnet ACL misconfiguration; a compromised second device on the tailnet | scanners, tool poisoning, resource abuse, DoS |

The honest framing: **the blast radius does not change with exposure; the number of principals who can reach it does.** The assets are a Linear API key with write access to a real company workspace, a Goodvest product knowledge pack, consolidated memory facts, and a set of prompts encoding internal document templates. None of that is catastrophic-if-leaked, and all of it is embarrassing-if-leaked, and one of it (the Linear key) can produce a real, attributable side effect in a company system.

Three new *kinds* of risk that exposure genuinely adds, beyond "more attackers":

1. **Approval forgery becomes a remote goal.** Today an attacker who wanted a Linear document written would need the `human_key` or a session token. Exposure makes that a remotely attackable objective rather than a theoretical one. Everything in section 3 exists to keep that ratio unchanged.
2. **The approval channel becomes an injection surface.** A card preview is attacker-influenceable text (the brief came from somewhere) that now travels through a chat transport and back. Section 4.1's rules are the mitigation, and they are non-negotiable: verdict-on-server-issued-id, sanitised preview, gate on sender.
3. **Provenance stops being self-evident.** At localhost, `origin: "human"` means "someone at this keyboard". Remotely, it means "someone who presented a credential over a network". The hash-chained log must therefore record *which channel* a decision arrived on, or the audit trail silently loses the distinction between a considered click in the console and a lock-screen tap while walking.

#### 5.3 Minimum defensible posture (the checklist)

For a personal tool holding a Linear API key and product knowledge, the floor is:

1. Hub binds `127.0.0.1`. Reach is a proxy's job, never the app's.
2. `Origin` validated, 403 on mismatch (MCP MUST).
3. Every `/api/*` route, read and write, requires a credential.
4. `/mcp` requires a per-principal bearer token, checked before dispatch.
5. Reach layer provides transport encryption and device-level authorisation (tailnet), so no credential ever crosses a hostile LAN in plaintext.
6. Session tokens: idle **and** absolute timeout, rotation at privilege change, an explicit revoke, and binding to the tailnet identity.
7. `human_key`: constant-time compare, rate limit, lockout, audited failures.
8. Remote decisions: single-use per-card credential, idempotent decide endpoint, verdict-on-server-issued-id, sanitised preview, sender allowlist.
9. Every auth event and every decision, with its channel, in the existing hash chain.
10. Secrets keep the `0600` posture and stay on the laptop. This is the line that rejects the VPS.
11. Backups keep running (already do, nightly to `~/Backups/rfa-agent-com/<date>`), because the realistic incident is still "I broke it", not "someone attacked it".

Notably absent from that list: OAuth, an IdP, a WAF, mTLS, and rate limiting on the model calls. Each is defensible; none is the floor.

---

## Open questions and spikes

| # | Open question | Cheapest experiment to settle it | What would change my mind |
|---|---|---|---|
| 1 | Does `tailscale serve` on this Mac actually reach the hub from the iPhone with the hub bound to `127.0.0.1`, including the long-poll `room_listen` and the console's SSE-ish stream? | 30 min: `server.listen(port,"127.0.0.1")`, `tailscale serve --bg --https=443 http://127.0.0.1:8790`, open `https://<node>.<tailnet>.ts.net/console#r_9a25e48c0e` on the phone, watch a live room and click one intervention. Record whether the identity headers arrive. | If Serve buffers or drops long-poll responses, the console needs a different transport (short poll or WebSocket) before this layer lands. |
| 2 | Is the Tailscale **Personal** plan licence-compatible with a personal tool used for Goodvest work? | 10 min: read the Personal plan terms; if ambiguous, ask Tailscale sales in writing. Budget 8 USD/user/month as the fallback. | A clear "personal use includes work-adjacent personal tooling" makes this free. Ambiguity means pay. |
| 3 | Can the `Tailscale-User-Login` header be trusted safely as a second factor, given clawpatrol#316? | 2 h: write the thin serve-only hop that injects a per-boot secret header, then try to forge `Tailscale-User-Login` from another loopback client and from another tailnet device; assert both fail. | If the Tailscale local API (`whois` on the peer address) is easy to call from Node, prefer it and drop the header entirely. |
| 4 | Does the ntfy iOS `http` action reliably fire against a tailnet HTTPS URL with a custom `Authorization` header, and how long does it take when the phone is idle? | Half a day: self-host ntfy on the Mac with `upstream-base-url: "https://ntfy.sh"`, publish one card, leave the phone locked for an hour, then tap Approve and check the hub log. Measure end-to-end latency and confirm the known no-visual-feedback bug. | If the tap does not reach the tailnet (VPN off, or URLSession bypassing the tunnel), the ntfy layer degrades to notification-only and Telegram becomes the primary verdict path. |
| 5 | Is the Telegram round trip acceptable given that Telegram sees the card preview? | 2 h: implement the poll-mode bot with a neutral one-line summary (tool name + alias only), approve one dry-run card end to end, and inspect exactly what left the machine. | If the neutral summary is too thin to decide on, Telegram is a *nag with a link*, not a decision surface, and the console on the tailnet is the only real approval UI. |
| 6 | How long can a card actually be parked before the resident's resume path breaks? | Half a day: park a card for 24 h with the resident restarted twice in between, then approve it and assert the Linear write completes with the original merged input. This exercises `src/engine.ts` replay plus the sidekick rejoin. | If the Agent SDK session cannot be resumed after that long, parking needs to re-draft rather than resume, which changes the UX contract (the human approves a *fresh* draft). |
| 7 | Does a bearer check in front of `/mcp` break the dual-era handler or the in-process resident clients? | 2 h: add the check, run `npm test` (85), `npm run e2e`, `e2e:full`, and the parity gate. | Nothing; this is a compatibility question, not a design one. |
| 8 | What is the right presence signal for "do not push, he is at the console"? | 1 h: reuse the console's long-poll liveness as the suppressor, or copy `CLAUDE_CLIENT_PRESENCE_FILE` semantics with a screen-lock listener. | If lock-state detection is fiddly on macOS, fall back to "a console long-poll seen in the last 60 s". |
| 9 | Should Remote Control be the primary rather than the fallback? | 1 h: run `claude --rc` in the project, enable "Push when actions required", then from the iOS app run `/ask-pm` and a hub decide call, and time it. | If the phone experience is genuinely good, this is a zero-exposure primary and the whole tailnet layer becomes optional. The blocker to check is whether driving a session is acceptable friction for a one-tap approval, and whether storing the transcript at Anthropic is acceptable for Goodvest content. |
| 10 | ~~Does the hub's MCP handler accept a `text/plain` POST (the CORS-simple-request case)?~~ **ANSWERED 2026-08-17: no, the SDK returns 415.** Remaining question: does a `Host` + `Origin` allowlist break any real client (Claude Code over the tailnet name, the in-process resident clients, the console)? | 1 h: add the allowlist, then run `npm test`, `npm run e2e`, `e2e:full`, the parity gate, and one real Claude Code `/mcp` connect over the tailnet hostname. | If a client sends no `Host` we recognise, the allowlist must be configurable rather than hardcoded, which is a config question, not a design one. |
| 11 | Is `caffeinate -s` under launchd worth it, or does parking make it unnecessary? | 1 day of observation: park cards for a week and count how many were decided before the laptop next woke. | If parked cards are always answered at the next wake anyway, skip `caffeinate` entirely and keep the battery. |
| 12 | `UNVERIFIED:` Cloudflare Zero Trust free-tier seat limit, and whether Cloudflare Access can front an MCP endpoint without breaking non-browser clients | 1 h: read Cloudflare's own plan page and the Access + service-token docs, then try one `curl` with `CF-Access-Client-Id`/`-Secret` against a test tunnel. | Only matters if a second person ever needs access; not on the v0.5 path. |
