import { RunApiError } from "../../api/runs";

export function asRunApiError(error: unknown): RunApiError {
  if (error instanceof RunApiError) return error;
  return new RunApiError("provider_request_failed", "api.errors.connection_failed", [{
    code: "provider_request_failed",
    messageKey: "api.errors.connection_failed",
    severity: "error",
  }]);
}
