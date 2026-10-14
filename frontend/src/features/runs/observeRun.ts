import type { RunResponse } from "../../api/generated";
import { fetchRun, subscribeToRunEvents, type RunProgressEvent } from "../../api/runs";
import { isTerminalRunStatus } from "../../api/runStatus";
import { isTransientRunError, waitForRunRecovery } from "./runErrors";

export async function observeRun(
  runId: string,
  onEvent: (event: RunProgressEvent) => void,
  signal?: AbortSignal,
  canReadResult: () => boolean = () => true,
  onRecoveredSnapshot?: (value: RunResponse) => void,
): Promise<RunResponse | null> {
  for (let recoveries = 0; ; recoveries++) {
    try {
      await subscribeToRunEvents(runId, onEvent, signal);
      if (!canReadResult()) return null;
      return await fetchRun(runId, signal);
    } catch (error) {
      if (!isTransientRunError(error) || recoveries >= 3) throw error;
      if (!canReadResult()) return null;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (error.retryAfterSeconds) {
        await waitForRunRecovery(signal, error.retryAfterSeconds * 1000);
        if (!canReadResult()) return null;
      }
      let retryAfterSeconds = 0;
      try {
        const snapshot = await fetchRun(runId, signal);
        if (!canReadResult()) return null;
        if (isTerminalRunStatus(snapshot.status)) return snapshot;
        onRecoveredSnapshot?.(snapshot);
      } catch (readError) {
        if (!isTransientRunError(readError)) throw readError;
        retryAfterSeconds = readError.retryAfterSeconds ?? 0;
      }
      await waitForRunRecovery(signal, Math.max(500, retryAfterSeconds * 1000));
    }
  }
}

/** Preserve the accepted job and Stop control during a sustained connection outage. */
export async function observeRunUntilTerminal(
  runId: string,
  onEvent: (event: RunProgressEvent) => void,
  signal: AbortSignal,
  canReadResult: () => boolean,
  onRecoveredSnapshot: (value: RunResponse) => void,
  onConnectionError: (error: unknown) => void,
): Promise<RunResponse | null> {
  while (canReadResult() && !signal.aborted) {
    try {
      return await observeRun(runId, onEvent, signal, canReadResult, onRecoveredSnapshot);
    } catch (error) {
      if (!isTransientRunError(error)) throw error;
      onConnectionError(error);
      await waitForRunRecovery(signal, Math.max(30000, (error.retryAfterSeconds ?? 0) * 1000));
    }
  }
  return null;
}
