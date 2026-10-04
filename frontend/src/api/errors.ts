import type { APIError, APIErrorResponse } from "./generated";
import { matchesContract } from "./contractReader";

/** Read the common wire envelope; callers retain transport-specific error classes. */
export function readApiError(payload: unknown): APIError | null {
  return matchesContract("APIErrorResponse", payload)
    ? (payload as APIErrorResponse).error : null;
}

export function fallbackApiError(status: number | null): APIError {
  const messageKey = status === null ? "api.errors.connection_failed" : "api.errors.invalid_request";
  return { code: "provider_request_failed", messageKey, diagnostics: [{
    code: "provider_request_failed", messageKey, severity: "error",
  }] };
}
