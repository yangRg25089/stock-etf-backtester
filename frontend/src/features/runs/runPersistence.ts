import type { RunResponse, StrategyStatus } from "../../api/generated";

const DATABASE_NAME = "backtester.runs.v1";
const STORE_NAME = "responses";
const LATEST_KEY = "latest";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCachedRun(value: unknown): value is RunResponse {
  if (!isRecord(value) || typeof value.runId !== "string" || !isTerminalRunStatus(value.status as StrategyStatus)) return false;
  if (!Array.isArray(value.selectedStrategyIds) || !value.selectedStrategyIds.every(id => typeof id === "string")) return false;
  if (!isRecord(value.snapshot) || !isRecord(value.snapshot.config)) return false;
  const config = value.snapshot.config;
  if (!isRecord(config.shared) || !isRecord(config.shared.run) || !Array.isArray(config.strategies)) return false;
  if (!config.strategies.every(strategy => isRecord(strategy) && typeof strategy.id === "string")) return false;
  if (value.result === null || value.result === undefined) return true;
  return isRecord(value.result) && Array.isArray(value.result.strategyRuns) && value.result.strategyRuns.every(result =>
    isRecord(result) && typeof result.id === "string" && typeof result.presetId === "string" && typeof result.status === "string"
    && [result.dailyAssets, result.trades, result.signals, result.diagnostics].every(items => items === undefined || items === null
      || (Array.isArray(items) && items.every(isRecord))));
}

export function isTerminalRunStatus(status: StrategyStatus): boolean {
  return status === "completed" || status === "completed_with_warning" ||
    status === "unavailable" || status === "failed" || status === "cancelled";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("Browser result storage is blocked")); };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) { database.close(); return; }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export async function readCachedRun(): Promise<RunResponse | null> {
  let database: IDBDatabase | undefined;
  try {
    const opened = await openDatabase();
    database = opened;
    const value: unknown = await new Promise((resolve, reject) => {
      const request = opened.transaction(STORE_NAME).objectStore(STORE_NAME).get(LATEST_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return isCachedRun(value) ? value : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

async function writeCachedRun(response: RunResponse): Promise<boolean> {
  let database: IDBDatabase | undefined;
  try {
    const opened = await openDatabase();
    database = opened;
    await new Promise<void>((resolve, reject) => {
      const transaction = opened.transaction(STORE_NAME, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore(STORE_NAME).put(response, LATEST_KEY);
    });
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

let pendingWrite = Promise.resolve(true);

export function saveCachedRun(response: RunResponse): Promise<boolean> {
  if (!isTerminalRunStatus(response.status)) return Promise.resolve(true);
  pendingWrite = pendingWrite.then(() => writeCachedRun(response));
  return pendingWrite;
}
