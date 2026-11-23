export type ErrorCode =
  | "internal_error"
  | "usage_error"
  | "not_a_repository"
  | "tool_missing"
  | "slots_busy"
  | "slot_not_found"
  | "confirmation_required"
  | "prepare_failed"
  | "sync_failed"
  | "state_invalid";

/**
 * xcslot's own failures sit above 99 so they never collide with the wrapped command's exit code,
 * which is passed through unchanged (xcodebuild uses 64 to 78).
 */
export const exitCodes = {
  internal_error: 100,
  usage_error: 101,
  not_a_repository: 102,
  tool_missing: 103,
  slots_busy: 110,
  slot_not_found: 111,
  confirmation_required: 112,
  prepare_failed: 113,
  sync_failed: 114,
  state_invalid: 115,
} as const satisfies Record<ErrorCode, number>;

export const retryable = {
  internal_error: false,
  usage_error: false,
  not_a_repository: false,
  tool_missing: false,
  slots_busy: true,
  slot_not_found: false,
  confirmation_required: false,
  prepare_failed: false,
  sync_failed: true,
  state_invalid: false,
} as const satisfies Record<ErrorCode, boolean>;

export const errorCodes = Object.keys(exitCodes) as ErrorCode[];

export interface NextCommand {
  readonly command: string;
  readonly why: string;
}

export interface XcslotError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  readonly next?: readonly NextCommand[];
}

export function failure(
  code: ErrorCode,
  message: string,
  extra: Pick<XcslotError, "hint" | "details" | "next"> = {},
): XcslotError {
  return { code, message, retryable: retryable[code], ...extra };
}
