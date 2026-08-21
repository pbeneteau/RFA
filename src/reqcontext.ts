/**
 * Per-request transport context, carried on AsyncLocalStorage from the HTTP
 * layer down into the store without touching tool arguments.
 *
 * Why not an argument: tool args are CLIENT-supplied and zod-validated, so a
 * transport fact riding them would be either stripped (unknown key) or
 * forgeable (declared key). The transport bearer's identity is a fact the
 * HTTP layer established; only the HTTP layer may assert it, exactly like the
 * server-stamped `origin`.
 *
 * On stdio and in-process transports nothing sets this, so `bearerSha256()`
 * is undefined there and every bearer-gated path stays closed: a bearer that
 * was never presented can never admit anyone.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<{ bearerSha256: string }>();

/** Run `fn` with the authenticated bearer's SHA-256 (hex) in scope. */
export function withBearer<T>(bearerSha256: string, fn: () => T): T {
  return als.run({ bearerSha256 }, fn);
}

/** The SHA-256 (hex) of the bearer this request authenticated with, if any. */
export function bearerSha256(): string | undefined {
  return als.getStore()?.bearerSha256;
}
