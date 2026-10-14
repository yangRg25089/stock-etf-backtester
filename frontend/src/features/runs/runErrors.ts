import { RunApiError } from "../../api/runs";

export function asRunApiError(error: unknown): RunApiError {
  if (error instanceof RunApiError) return error;
  return new RunApiError("provider_request_failed", "api.errors.connection_failed", [{
    code: "provider_request_failed",
    messageKey: "api.errors.connection_failed",
    severity: "error",
  }]);
}

export function isTransientRunError(error: unknown): error is RunApiError {
  if (!(error instanceof RunApiError) || error.code === "invalid_response") return false;
  if (error.status === null) return error.code === "provider_request_failed";
  return error.status === 429 || error.status >= 500;
}

export function waitForRunRecovery(signal?: AbortSignal, delay = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delay);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
