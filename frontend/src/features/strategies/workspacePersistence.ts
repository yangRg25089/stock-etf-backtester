import type { Catalog } from "../../api/generated";
import { isIsoDateTime } from "../../api/contractReader";
import { isRecord } from "../../shared/lib/record";
import { createInitialWorkspaceState, type BacktestDraft } from "./model";
import { readDraft, workspaceForDraft } from "./draftReader";
import { compatibleCatalogVersion } from "./catalogCompatibility";

export const LAST_RUN_STRATEGY_KEY = "stock-etf-backtester.last-run-strategy.v1";
type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): BrowserStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function failureIds(value: unknown, draft: unknown): Set<string> | null {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== "string")
    || new Set(value).size !== value.length || !isRecord(draft) || !Array.isArray(draft.strategies)) return null;
  const ids = new Set(draft.strategies.filter(isRecord).map(item => item.id));
  return value.every(id => ids.has(id)) ? new Set(value as string[]) : null;
}

export function restoreWorkspaceState(catalog: Catalog, storage = browserStorage()) {
  const initial = { state: createInitialWorkspaceState(catalog), nextStrategySequence: 2 };
  try {
    const serialized = storage?.getItem(LAST_RUN_STRATEGY_KEY);
    if (!serialized || serialized.length > 1_000_000) return initial;
    const saved: unknown = JSON.parse(serialized);
    if (!isRecord(saved) || saved.schemaVersion !== 1 || !compatibleCatalogVersion(saved.catalogVersion, catalog.version)
      || !isIsoDateTime(saved.savedAt)) return initial;
    const failedIds = failureIds(saved.failedStrategyIds, saved.draft);
    const draft = failedIds && readDraft(saved.draft, catalog, failedIds);
    return draft ? workspaceForDraft(draft, catalog) : initial;
  } catch { return initial; }
}

/** Save accepted inputs and their verified date resolution; never edits or imports. */
export function saveLastRunStrategy(draft: BacktestDraft, catalog: Catalog, storage = browserStorage(), failedStrategyIds: readonly string[] = []): boolean {
  try {
    const ids = failureIds(failedStrategyIds, draft);
    if (!storage || !ids || !readDraft(draft, catalog, ids)) return false;
    storage.setItem(LAST_RUN_STRATEGY_KEY, JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version,
      savedAt: new Date().toISOString(), draft, ...(ids.size ? { failedStrategyIds: [...ids] } : {}) }));
    return true;
  } catch { return false; }
}
