import type {
  Catalog,
  DraftValidationResponse,
  RunResponse,
  StrategyPresetId,
  StrategyStatus,
  StrategyRules,
} from "../../api/generated";
import type { RunProgressEvent } from "../../api/runs";
import { createDefaultSharedDraft, type SharedDraft } from "../config/defaults";

export interface StrategyDraft {
  id: string;
  presetId: StrategyPresetId;
  instanceNumber?: number;
  params: Record<string, unknown>;
  rules?: StrategyRules | null;
}

export interface BacktestDraft {
  shared: SharedDraft & { data: Record<string, unknown> };
  strategies: StrategyDraft[];
}

export interface WorkspaceState {
  draft: BacktestDraft;
  activeStrategyId: string | null;
  runResponse: RunResponse | null;
  focusedResultId: string | null;
  selectedResultIds: string[];
  showChart: boolean;
  visibleSeriesIds: string[];
  nextCustomNumber: number;
}

export type WorkspaceAction =
  | { type: "strategy.select"; id: string }
  | { type: "strategy.add"; id: string; presetId: StrategyPresetId }
  | { type: "strategy.remove"; id: string }
  | { type: "strategy.commit"; value: StrategyDraft }
  | { type: "strategy.param"; id: string; key: string; value: unknown }
  | { type: "strategy.rules"; id: string; value: StrategyRules }
  | { type: "shared.change"; value: SharedDraft }
  | { type: "run.reset" }
  | { type: "run.update"; value: RunResponse }
  | { type: "run.progress"; value: RunProgressEvent }
  | { type: "result.focus"; id: string | null }
  | { type: "result.toggleSelection"; id: string }
  | { type: "display.chart"; value: boolean }
  | { type: "chart.series"; id: string; visible: boolean };

export interface RunAvailability {
  disabled: boolean;
  reasonKey: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
    );
  }
  return value;
}

function dataDefaults(catalog: Catalog): Record<string, unknown> {
  return Object.fromEntries(
    (catalog.parameters ?? [])
      .filter((definition) => definition.level === "shared" && definition.key.startsWith("data."))
      .map((definition) => [definition.key.slice("data.".length), cloneValue(definition.default)]),
  );
}

function uiBooleanDefault(catalog: Catalog, key: string, fallback: boolean): boolean {
  const value = catalog.parameters?.find((definition) => definition.key === key)?.default;
  return typeof value === "boolean" ? value : fallback;
}

export function createStrategyDraft(
  catalog: Catalog,
  presetId: StrategyPresetId,
  id: string,
): StrategyDraft {
  const preset = catalog.presets?.find((item) => item.id === presetId);
  if (!preset) throw new Error(`Catalog is missing preset ${presetId}`);
  const params = Object.fromEntries(
    Object.entries(asRecord(preset.defaultParams)).map(([key, value]) => [key, cloneValue(value)]),
  );
  for (const key of preset.parameterKeys) {
    if (Object.hasOwn(params, key)) continue;
    const definition = catalog.parameters?.find((item) => item.key === key);
    if (definition && definition.default !== undefined) {
      params[key] = cloneValue(definition.default);
    }
  }
  return { id, presetId, params, rules: structuredClone(preset.defaultRules) };
}

export function createInitialWorkspaceState(catalog: Catalog): WorkspaceState {
  const initialStrategy = createStrategyDraft(catalog, "vix_dca", "strategy-vix_dca-1");
  const shared = createDefaultSharedDraft(catalog);
  return {
    draft: {
      shared: { ...shared, data: dataDefaults(catalog) },
      strategies: [initialStrategy],
    },
    activeStrategyId: initialStrategy.id,
    runResponse: null,
    focusedResultId: null,
    selectedResultIds: [],
    showChart: uiBooleanDefault(catalog, "display.showChart", true),
    visibleSeriesIds: ["price", "totalAsset", "drawdown", "vix"],
    nextCustomNumber: 1,
  };
}

export function strategyInstanceLimit(catalog: Catalog, presetId: StrategyPresetId): number | undefined {
  return presetId === "composite_dca"
    ? catalog.strategyLimits?.maxCustomInstances
    : catalog.strategyLimits?.maxFixedInstances;
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
  catalog?: Catalog,
): WorkspaceState {
  switch (action.type) {
    case "strategy.select":
      return state.draft.strategies.some((strategy) => strategy.id === action.id)
        ? { ...state, activeStrategyId: action.id }
        : state;
    case "strategy.add": {
      if (!catalog) return state;
      const count = state.draft.strategies.filter(item => item.presetId === action.presetId).length;
      const custom = action.presetId === "composite_dca";
      const maximum = strategyInstanceLimit(catalog, action.presetId);
      if (maximum === undefined || count >= maximum || state.draft.strategies.some(item => item.id === action.id)) return state;
      const strategy = createStrategyDraft(catalog, action.presetId, action.id);
      if (custom) strategy.instanceNumber = state.nextCustomNumber;
      return { ...state, draft: { ...state.draft, strategies: [...state.draft.strategies, strategy] },
        activeStrategyId: strategy.id, nextCustomNumber: state.nextCustomNumber + (custom ? 1 : 0) };
    }
    case "strategy.remove": {
      const strategies = state.draft.strategies.filter((strategy) => strategy.id !== action.id);
      const activeStrategyId = state.activeStrategyId === action.id
        ? strategies[0]?.id ?? null
        : state.activeStrategyId;
      if (strategies.length === state.draft.strategies.length) return state;
      return { ...state, draft: { ...state.draft, strategies }, activeStrategyId };
    }
    case "strategy.commit":
      return { ...state, draft: { ...state.draft, strategies: state.draft.strategies.map(item =>
        item.id === action.value.id ? action.value : item) } };
    case "strategy.param":
      return {
        ...state,
        draft: {
          ...state.draft,
          strategies: state.draft.strategies.map((strategy) =>
            strategy.id === action.id
              ? { ...strategy, params: { ...strategy.params, [action.key]: action.value } }
              : strategy,
          ),
        },
      };
    case "strategy.rules":
      return {
        ...state,
        draft: {
          ...state.draft,
          strategies: state.draft.strategies.map(strategy => strategy.id === action.id
            ? { ...strategy, rules: structuredClone(action.value) }
            : strategy),
        },
      };
    case "shared.change":
      return {
        ...state,
        draft: {
          ...state.draft,
          shared: { ...action.value, data: state.draft.shared.data },
        },
      };
    case "run.reset":
      return {
        ...state,
        runResponse: null,
        focusedResultId: null,
        selectedResultIds: [],
      };
    case "run.update": {
      const savedResults = action.value.result?.strategyRuns ?? [];
      const sameRun = state.runResponse?.runId === action.value.runId;
      const focusIsAvailable = state.focusedResultId !== null &&
        savedResults.some((result) => result.id === state.focusedResultId);
      const focusedResultId = sameRun && focusIsAvailable
        ? state.focusedResultId
        : action.value.selectedStrategyIds[0] ?? savedResults[0]?.id ?? null;
      const availableIds = new Set(savedResults.map((result) => result.id));
      const selectedResultIds = sameRun
        ? state.selectedResultIds.filter((id) => availableIds.has(id))
        : [];
      return {
        ...state,
        runResponse: action.value,
        focusedResultId,
        selectedResultIds,
        ...(!sameRun ? {
          showChart: catalog ? uiBooleanDefault(catalog, "display.showChart", true) : true,
          visibleSeriesIds: ["price", "totalAsset", "drawdown", "vix"],
        } : {}),
      };
    }
    case "run.progress": {
      const current = state.runResponse;
      if (!current || current.runId !== action.value.runId) return state;
      const strategyRuns = current.result?.strategyRuns?.map((strategyRun) => ({
        ...strategyRun,
        status: action.value.strategyStatuses[strategyRun.id] ?? strategyRun.status,
        ...(action.value.strategySummaries?.[strategyRun.id] ?? {}),
      }));
      return {
        ...state,
        runResponse: {
          ...current,
          status: action.value.status,
          progress: action.value.progress,
          result: current.result
            ? {
                ...current.result,
                status: action.value.status,
                ...(strategyRuns ? { strategyRuns } : {}),
              }
            : current.result,
        },
      };
    }
    case "result.focus":
      return { ...state, focusedResultId: action.id };
    case "result.toggleSelection": {
      const selected = state.selectedResultIds.includes(action.id);
      return {
        ...state,
        selectedResultIds: selected
          ? state.selectedResultIds.filter((id) => id !== action.id)
          : [...state.selectedResultIds, action.id],
      };
    }
    case "display.chart":
      return { ...state, showChart: action.value };
    case "chart.series":
      return {
        ...state,
        visibleSeriesIds: action.visible
          ? state.visibleSeriesIds.includes(action.id)
            ? state.visibleSeriesIds
            : [...state.visibleSeriesIds, action.id]
          : state.visibleSeriesIds.filter((seriesId) => seriesId !== action.id),
      };
  }
}

function hasBlockingDiagnostic(diagnostics: DraftValidationResponse["diagnostics"]): boolean {
  return (diagnostics ?? []).some((diagnostic) => diagnostic.severity !== "info" && diagnostic.severity !== "warning");
}

export function getRunAvailability(
  state: Pick<WorkspaceState, "draft">,
  validation: DraftValidationResponse | null,
): RunAvailability {
  if (!validation) return { disabled: true, reasonKey: "run.validationPending" };
  if (hasBlockingDiagnostic(validation.diagnostics)) {
    return { disabled: true, reasonKey: "run.sharedInvalid" };
  }

  return state.draft.strategies.length > 0
    ? { disabled: false, reasonKey: null }
    : { disabled: true, reasonKey: "run.noStrategies" };
}

export function serializeDraftForApi(draft: BacktestDraft): Record<string, unknown> {
  const run = draft.shared.run;
  return {
    shared: {
      run: {
        ...run,
        endDate: run.endDate,
      },
      contribution: { ...draft.shared.contribution },
      data: { ...draft.shared.data },
    },
    strategies: draft.strategies.map((strategy) => ({
      ...strategy,
      params: { ...strategy.params },
      rules: structuredClone(strategy.rules),
    })),
  };
}

const SUCCESS_STATUSES = new Set<StrategyStatus>(["completed", "completed_with_warning"]);
const FAILURE_STATUSES = new Set<StrategyStatus>(["unavailable", "failed", "cancelled"]);
const TERMINAL_STATUSES = new Set<StrategyStatus>([
  "completed",
  "completed_with_warning",
  "unavailable",
  "failed",
  "cancelled",
]);

export function isPartialSuccess(run: RunResponse | null): boolean {
  const outcomes = run?.result?.strategyRuns ?? [];
  const statuses = outcomes.map((item) => item.status);
  if (
    outcomes.length === 0 ||
    statuses.some((status) => status === undefined) ||
    !statuses.every((status) => status !== undefined && TERMINAL_STATUSES.has(status))
  ) {
    return false;
  }
  return statuses.some((status) => status !== undefined && SUCCESS_STATUSES.has(status)) &&
    statuses.some((status) => status !== undefined && FAILURE_STATUSES.has(status));
}
