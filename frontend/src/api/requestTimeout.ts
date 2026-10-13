export class RequestTimeoutError extends Error {}

/** Bound both response headers and JSON bodies, while preserving caller cancellation. */
export async function withRequestTimeout<T>(
  signal: AbortSignal | undefined,
  operation: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => {
    rejectDeadline(new DOMException("Aborted", "AbortError"));
    controller.abort();
  };
  const timer = setTimeout(() => {
    rejectDeadline(new RequestTimeoutError("HTTP request timed out"));
    controller.abort();
  }, 60000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([deadline, operation(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
