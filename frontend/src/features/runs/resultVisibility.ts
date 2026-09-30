const DISMISSED_RUN_KEY = "backtester.dismissedRunId";

export function readDismissedRunId(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_RUN_KEY);
  } catch {
    // Result reset still works for this session if the browser blocks storage.
    return null;
  }
}

export function rememberDismissedRun(runId: string | null): void {
  try {
    if (runId) window.localStorage.setItem(DISMISSED_RUN_KEY, runId);
    else window.localStorage.removeItem(DISMISSED_RUN_KEY);
  } catch {
    // Storage availability must not block reset or submission.
  }
}
