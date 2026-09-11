import type { ErrorCode } from "@loom/core";

const map: Record<ErrorCode, number> = {
  validation: 400, invalid_token: 401, forbidden: 403,
  weave_not_found: 404, thread_not_found: 404,
  weave_archived: 409, thread_closed: 409, name_taken: 409,
  message_too_long: 413,
};

export function statusFor(code: ErrorCode): number { return map[code] ?? 500; }
