/**
 * The environment a child of the tool inherits (v0.4 sect. 6.3, as written).
 *
 * v0.4 sect. 6.3 specified that the injected environment REPLACES the
 * supervisor's, and RFA-0.6 sect. 8.8 recorded that `{...process.env, ...picked}`
 * was shipped instead. The allowlist is what a process needs to find its
 * binaries and its model credential and nothing the operator's shell happened to
 * export. The model provider's variables are kept by prefix because the Agent
 * SDK's `claude` child reads a family of them (API key, base URL, Bedrock and
 * Vertex selection) and a list that names each one rots.
 *
 * Measured on the first live run of v0.7 (2026-08-22): a resident spawned with
 * this allowlist had 31 variables, booted, joined its room and answered; the
 * supervisor's own shell had over a hundred.
 */
const EXACT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);
const PREFIXES = ["LC_", "XDG_", "ANTHROPIC_", "CLAUDE_", "AWS_", "GOOGLE_", "GCLOUD_", "CLOUD_ML_", "VERTEX_", "OTEL_", "DISABLE_"];

export function minimalEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (EXACT.has(k) || PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
