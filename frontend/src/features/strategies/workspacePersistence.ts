import type { Catalog, StrategyPresetId, StrategyRules } from "../../api/generated";
import { createInitialWorkspaceState, createStrategyDraft, type BacktestDraft, type WorkspaceState } from "./model";

const STORAGE_KEY = "backtester.workspace.v1";
type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserStorage(): BrowserStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

function validRules(value: unknown, catalog: Catalog): value is StrategyRules {
  if (!isRecord(value)) return false;
  const pending = [value.buy, value.sell].filter(node => node !== null && node !== undefined).map(node => ({ node, depth: 1 }));
  let count = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || !isRecord(entry.node) || typeof entry.node.id !== "string") return false;
    const { node, depth } = entry;
    if (++count > (catalog.conditionLimits?.maxNodes ?? 0) || depth > (catalog.conditionLimits?.maxDepth ?? 0)) return false;
    if (node.enabled !== undefined && typeof node.enabled !== "boolean") return false;
    if ("kind" in node) {
      if (!catalog.conditions?.some(item => item.kind === node.kind) || (node.params !== undefined && !isRecord(node.params))) return false;
    } else {
      if (node.operator !== undefined && node.operator !== "AND" && node.operator !== "OR") return false;
      if (node.children !== undefined && !Array.isArray(node.children)) return false;
      for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
    }
  }
  return true;
}

function restoreDraft(value: unknown, defaults: BacktestDraft, catalog: Catalog): BacktestDraft | null {
  if (!isRecord(value) || !isRecord(value.shared) || !Array.isArray(value.strategies)) return null;
  const { shared } = value;
  if (!isRecord(shared.run) || !isRecord(shared.contribution)) return null;
  const { run, contribution } = shared;
  if (typeof run.symbol !== "string" || typeof run.startDate !== "string" || (run.endDate !== null && typeof run.endDate !== "string")) return null;
  if (contribution.amount !== null && typeof contribution.amount !== "string" && typeof contribution.amount !== "number") return null;
  if (contribution.day !== null && typeof contribution.day !== "number") return null;
  const strategies: BacktestDraft["strategies"] = [];
  for (const item of value.strategies) {
    if (!isRecord(item) || typeof item.id !== "string" || !isRecord(item.params)) return null;
    const preset = catalog.presets?.find(preset => preset.id === item.presetId);
    if (!preset || strategies.some(strategy => strategy.id === item.id)) return null;
    const strategy = createStrategyDraft(catalog, preset.id as StrategyPresetId, item.id);
    const allowedKeys = new Set(preset.parameterKeys);
    strategy.params = { ...strategy.params, ...Object.fromEntries(Object.entries(item.params).filter(([key]) => allowedKeys.has(key))) };
    if (typeof item.instanceNumber === "number") strategy.instanceNumber = item.instanceNumber;
    if (validRules(item.rules, catalog)) strategy.rules = structuredClone(item.rules);
    strategies.push(strategy);
  }
  const storedData = isRecord(shared.data) ? shared.data : {};
  return {
    shared: {
      run: { symbol: run.symbol, startDate: run.startDate, endDate: run.endDate },
      contribution: { amount: contribution.amount === null ? null : String(contribution.amount), day: contribution.day },
      currency: typeof shared.currency === "string" ? shared.currency : defaults.shared.currency,
      data: { ...defaults.shared.data, ...Object.fromEntries(Object.entries(storedData).filter(([key]) => Object.hasOwn(defaults.shared.data, key))) },
    },
    strategies,
  };
}

export function restoreWorkspaceState(catalog: Catalog, storage = browserStorage()): { state: WorkspaceState; nextStrategySequence: number } {
  const initial = { state: createInitialWorkspaceState(catalog), nextStrategySequence: 2 };
  try {
    const serialized = storage?.getItem(STORAGE_KEY);
    if (!serialized) return initial;
    const saved: unknown = JSON.parse(serialized);
    if (!isRecord(saved) || saved.version !== 1) return initial;
    const draft = restoreDraft(saved.draft, initial.state.draft, catalog);
    if (!draft) return initial;
    const sequenceFromIds = Math.max(1, ...draft.strategies.map(strategy => Number(/-(\d+)$/.exec(strategy.id)?.[1] ?? 0))) + 1;
    const customNumber = Math.max(0, ...draft.strategies.map(strategy => strategy.instanceNumber ?? 0)) + 1;
    return {
      state: { ...initial.state, draft,
        activeStrategyId: draft.strategies.some(strategy => strategy.id === saved.activeStrategyId) ? String(saved.activeStrategyId) : draft.strategies[0]?.id ?? null,
        nextCustomNumber: Math.max(customNumber, typeof saved.nextCustomNumber === "number" && Number.isSafeInteger(saved.nextCustomNumber) ? saved.nextCustomNumber : 1),
      },
      nextStrategySequence: Math.max(sequenceFromIds, typeof saved.nextStrategySequence === "number" && Number.isSafeInteger(saved.nextStrategySequence) ? saved.nextStrategySequence : 2),
    };
  } catch {
    return initial;
  }
}

export function saveWorkspaceDraft(state: Pick<WorkspaceState, "draft" | "activeStrategyId" | "nextCustomNumber">, nextStrategySequence: number, storage = browserStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, draft: state.draft, activeStrategyId: state.activeStrategyId,
      nextCustomNumber: state.nextCustomNumber, nextStrategySequence }));
    return true;
  } catch {
    return false;
  }
}
