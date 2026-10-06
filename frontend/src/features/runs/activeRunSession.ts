type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const ACTIVE_RUN_SESSION_KEY = "stock-etf-backtester.active-run-id.v1";

function browserSessionStorage(): SessionStorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function readActiveRunId(storage?: SessionStorageLike): string | null {
  try {
    return (storage ?? browserSessionStorage())?.getItem(ACTIVE_RUN_SESSION_KEY) || null;
  } catch {
    return null;
  }
}

export function saveActiveRunId(runId: string, storage?: SessionStorageLike): void {
  if (!runId) return;
  try {
    (storage ?? browserSessionStorage())?.setItem(ACTIVE_RUN_SESSION_KEY, runId);
  } catch {
    // The current page can still observe a run when session storage is unavailable.
  }
}

export function clearActiveRunId(expectedRunId?: string, storage?: SessionStorageLike): void {
  try {
    const target = storage ?? browserSessionStorage();
    if (!target) return;
    if (expectedRunId !== undefined && target.getItem(ACTIVE_RUN_SESSION_KEY) !== expectedRunId) {
      return;
    }
    target.removeItem(ACTIVE_RUN_SESSION_KEY);
  } catch {
    // Storage can be blocked by the browser; there is no persistent value to clear then.
  }
}
