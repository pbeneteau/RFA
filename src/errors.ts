/** RFA 0.1 error model (spec section 15). */

export type RfaErrorCode =
  | "unknown_room"
  | "unknown_member"
  | "not_a_member"
  | "unauthorized"
  | "join_denied"
  | "name_rebound"
  | "stale_epoch"
  | "muted"
  | "not_your_turn"
  | "held"
  | "rate_limited"
  | "payload_too_large"
  | "digest_changed"
  | "room_ended"
  | "task_conflict"
  | "bad_cursor"
  | "lease_expired"
  | "bad_request";

export class RfaError extends Error {
  constructor(
    public code: RfaErrorCode,
    message: string,
    public retryAfterS: number | null = null,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RfaError";
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retry_after_s: this.retryAfterS,
      data: this.data,
    };
  }
}
