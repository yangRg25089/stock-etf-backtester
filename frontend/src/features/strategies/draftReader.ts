import type { Catalog, ConditionGroup, ConditionLeaf, ParameterDefinition, RunResponse, StrategyRules } from "../../api/generated";
import { isBoundedJson, isNumericSearchValue, isRecord, matchesContract, runDataContext, validExecutionSettings } from "../../api/contractReader";
import { createInitialWorkspaceState, createStrategyDraft, strategyInstanceLimit, type BacktestDraft, type WorkspaceState } from "./model";

function parameterShape(value: unknown, definition: ParameterDefinition): boolean {
  if (value === null) return definition.nullable === true;
  const numeric = isNumericSearchValue;
  switch (definition.type) {
    case "boolean": return typeof value === "boolean";
    case "integer": return numeric(value) && Number.isSafeInteger(Number(value));
    case "decimal": case "ratio": case "percent_point": return numeric(value);
    case "number_list": return Array.isArray(value) && value.length <= 10_000 && value.every(numeric);
    case "enum_list": return Array.isArray(value) && value.length <= 32 && value.every(item => definition.allowedValues?.includes(item));
    case "enum": return definition.allowedValues?.includes(value) ?? false;
    case "symbol": return typeof value === "string" && value.length <= 64 && (!definition.pattern || new RegExp(definition.pattern).test(value));
    case "date": return matchesContract("RunSettings", { symbol: "TEST", startDate: value, endDate: value });
  }
}

function readParams(value: unknown, keys: string[], catalog: Catalog, recoverFailed = false): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const definitions = new Map(catalog.parameters?.map(item => [item.key, item]));
  for (const [key, item] of Object.entries(value)) {
    const definition = definitions.get(key);
    if (!keys.includes(key) || !definition) return null;
    const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value);
    const safeError = recoverFailed && (scalar(item) || (Array.isArray(item) && item.length <= 10_000 && item.every(scalar)));
    if (!safeError && !parameterShape(item, definition)) return null;
  }
  return structuredClone(value);
}

function validRules(value: unknown, catalog: Catalog, recoverFailed = false): value is StrategyRules {
  if (!matchesContract("StrategyRules", value) || !isRecord(value)) return false;
  const seen = new Set<string>();
  let count = 0;
  for (const side of ["buy", "sell"] as const) {
    const kinds = new Set<string>();
    const pending = value[side] ? [{ node: value[side] as ConditionLeaf | ConditionGroup, depth: 1 }] : [];
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++count > (catalog.conditionLimits?.maxNodes ?? 96) || depth > (catalog.conditionLimits?.maxDepth ?? 8) || seen.has(node.id)) return false;
      seen.add(node.id);
      if ("kind" in node) {
        const definition = catalog.conditions?.find(item => item.kind === node.kind);
        if (!definition || (!recoverFailed && kinds.has(node.kind)) || !readParams(node.params ?? {}, side === "buy" ? definition.buyParameterKeys : definition.sellParameterKeys, catalog, recoverFailed)) return false;
        kinds.add(node.kind);
      } else {
        for (const child of node.children ?? []) pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return true;
}

/** Check structure/catalog membership; business validation remains at the shared API. */
export function readDraft(value: unknown, catalog: Catalog, failedIds: ReadonlySet<string> = new Set()): BacktestDraft | null {
  const totalLimit = catalog.strategyLimits?.maxTotalInstances;
  if (!isBoundedJson(value) || !isRecord(value) || !isRecord(value.shared) || !Array.isArray(value.strategies)
    || !value.strategies.length || totalLimit === undefined || value.strategies.length > totalLimit) return null;
  if (Object.keys(value).some(key => !["shared", "strategies"].includes(key))) return null;
  const defaults = createInitialWorkspaceState(catalog).draft;
  const { shared } = value;
  if (!isRecord(shared.run) || !isRecord(shared.contribution) || !isRecord(shared.data ?? {}) || !isRecord(shared.analysis ?? {}) || !isRecord(shared.execution ?? {})) return null;
  if (Object.keys(shared).some(key => !["run", "contribution", "data", "analysis", "execution", "currency"].includes(key))) return null;
  const contribution = { ...shared.contribution, amount: String(shared.contribution.amount ?? "") };
  const data = { ...defaults.shared.data, ...shared.data as Record<string, unknown> };
  const analysis = { ...defaults.shared.analysis, ...shared.analysis as Record<string, unknown> };
  const execution = { ...defaults.shared.execution, ...shared.execution as Record<string, unknown> };
  const contractShared = { run: shared.run, contribution, data, analysis, execution };
  if (!matchesContract("SharedSettings", contractShared) || (typeof shared.currency !== "undefined"
    && (typeof shared.currency !== "string" || !/^[A-Z]{3}$/.test(shared.currency)))) return null;
  const executionDraft = { commission: String(execution.commission), slippagePct: String(execution.slippagePct), spreadPct: String(execution.spreadPct), fractionalShares: execution.fractionalShares === true, capitalGainsTaxEnabled: execution.capitalGainsTaxEnabled === true };
  if (!validExecutionSettings(executionDraft)) return null;
  const strategies: BacktestDraft["strategies"] = [];
  const counts = new Map<string, number>();
  for (const item of value.strategies) {
    if (!matchesContract("FrozenStrategyInstance", item) || !isRecord(item) || typeof item.id !== "string") return null;
    if (item.enabled === false || strategies.some(strategy => strategy.id === item.id)) return null;
    const preset = catalog.presets?.find(preset => preset.id === item.presetId);
    if (!preset) return null;
    const count = (counts.get(preset.id) ?? 0) + 1;
    const perPresetLimit = strategyInstanceLimit(catalog);
    if (perPresetLimit === undefined || count > perPresetLimit) return null;
    counts.set(preset.id, count);
    const recoverFailed = failedIds.has(item.id);
    const params = readParams(item.params ?? {}, preset.parameterKeys, catalog, recoverFailed);
    if (!params || (item.rules != null && !validRules(item.rules, catalog, recoverFailed))) return null;
    const strategy = createStrategyDraft(catalog, preset.id, item.id);
    strategy.params = { ...strategy.params, ...params };
    if (typeof item.instanceNumber === "number") {
      if (!Number.isSafeInteger(item.instanceNumber) || item.instanceNumber < 1 || item.instanceNumber > 1_000_000) return null;
      strategy.instanceNumber = item.instanceNumber;
    } else strategy.instanceNumber = count;
    if (item.rules !== undefined) strategy.rules = structuredClone(item.rules as StrategyRules | null);
    strategies.push(strategy);
  }
  const run = shared.run;
  return { shared: {
    run: { symbol: String(run.symbol), startDate: String(run.startDate), endDate: String(run.endDate) },
    contribution: { amount: contribution.amount, day: Number(shared.contribution.day) }, data,
    analysis: { riskFreeAnnualRatePct: String(analysis.riskFreeAnnualRatePct) },
    execution: executionDraft,
    currency: typeof shared.currency === "string" ? shared.currency : catalog.symbolSuggestions?.find(item => item.symbol === run.symbol)?.currency,
  }, strategies };
}

export function workspaceForDraft(draft: BacktestDraft, catalog: Catalog): { state: WorkspaceState; nextStrategySequence: number } {
  const nextStrategySequence = Math.max(1, ...draft.strategies.map(strategy => {
    const sequence = Number(/-(\d+)$/.exec(strategy.id)?.[1] ?? 0);
    return Number.isSafeInteger(sequence) && sequence < 1_000_000 ? sequence : 0;
  })) + 1;
  const nextInstanceNumberByPreset = Object.fromEntries((catalog.presets ?? []).map(preset => {
    const instances = draft.strategies.filter(strategy => strategy.presetId === preset.id);
    const next = Math.max(0, ...instances.map((strategy, index) => strategy.instanceNumber ?? index + 1)) + 1;
    return [preset.id, instances.length ? next : 1];
  }));
  return { state: { ...createInitialWorkspaceState(catalog), draft,
    activeStrategyId: draft.strategies[0]?.id ?? null,
    nextInstanceNumberByPreset,
  }, nextStrategySequence };
}

/** Restore inputs from the saved run, using only its verified data resolution. */
export function draftFromRun(run: RunResponse, catalog: Catalog, fallbackCurrency?: string): BacktestDraft | null {
  const config = run.snapshot.config;
  const currency = run.result?.strategyRuns?.find(row => row.metrics?.currency)?.metrics?.currency ?? fallbackCurrency;
  const failedIds = new Set(run.result?.strategyRuns?.filter(row => row.role === "strategy" && row.status === "failed").map(row => row.id));
  return readDraft({ ...config, shared: { ...config.shared,
    run: runDataContext(run.snapshot)?.effectiveRun ?? config.shared.run,
    ...(currency ? { currency } : {}),
  } }, catalog, failedIds);
}
