import type { RunResponse, StrategyRun } from "../../api/generated";
import type { WorkspaceState } from "../strategies/model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "string") {
    return numericStringMatches(left, right);
  }
  if (typeof right === "number" && typeof left === "string") {
    return numericStringMatches(right, left);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined).sort();
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && equalValue(left[key], right[key]),
    );
  }
  return false;
}

function numericStringMatches(value: number, candidate: string): boolean {
  if (candidate.trim() === "") return false;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && value === parsed;
}

export function findFocusedResult(
  run: Pick<RunResponse, "result"> | null,
  focusedResultId: string | null,
): StrategyRun | null {
  if (!run || !focusedResultId) return null;
  return (run.result?.strategyRuns ?? []).find((result) => result.id === focusedResultId) ?? null;
}

export function isRunSnapshotStale(state: WorkspaceState): boolean {
  const run = state.runResponse;
  const frozen = run?.snapshot?.config;
  if (!run || !frozen) return false;

  const currentShared = state.draft.shared;
  const frozenShared = frozen.shared;
  const latestWasRequested = state.runRequestedEndMode === "latest" &&
    currentShared.run.endMode === "latest";
  if (latestWasRequested) {
    if (
      currentShared.run.symbol !== frozenShared.run.symbol ||
      currentShared.run.startDate !== frozenShared.run.startDate ||
      !equalValue(currentShared.contribution, frozenShared.contribution) ||
      !equalValue(currentShared.data, frozenShared.data)
    ) return true;
  } else if (
    !equalValue(currentShared.run, frozenShared.run) ||
    !equalValue(currentShared.contribution, frozenShared.contribution) ||
    !equalValue(currentShared.data, frozenShared.data)
  ) {
    return true;
  }

  const currentById = new Map(state.draft.strategies.map((strategy) => [strategy.id, strategy]));
  const frozenById = new Map((frozen.strategies ?? []).map((strategy) => [strategy.id, strategy]));
  for (const strategyId of run.selectedStrategyIds) {
    const current = currentById.get(strategyId);
    const saved = frozenById.get(strategyId);
    if (
      !current || !saved ||
      current.presetId !== saved.presetId ||
      current.enabled !== saved.enabled ||
      !equalValue(current.params, saved.params)
    ) return true;
  }

  if (state.runRequestedScope === "all_enabled") {
    const currentlyEnabled = state.draft.strategies
      .filter((strategy) => strategy.enabled)
      .map((strategy) => strategy.id)
      .sort();
    if (!equalValue(currentlyEnabled, [...run.selectedStrategyIds].sort())) return true;
  }
  return false;
}
