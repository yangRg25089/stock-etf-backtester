import schemas from "./generated.schema.json";
import type { StrategyStatus } from "./generated";

const knownStatuses = new Set<string>(schemas.StrategyStatus.enum);

export function isRunStatus(value: unknown): value is StrategyStatus {
  return typeof value === "string" && knownStatuses.has(value);
}

export function isActiveRunStatus(status: StrategyStatus | null | undefined): boolean {
  return status === "queued" || status === "loading" || status === "running";
}

export function isSuccessfulRunStatus(status: StrategyStatus | null | undefined): boolean {
  return status === "completed" || status === "completed_with_warning";
}

export function isTerminalRunStatus(value: unknown): value is StrategyStatus {
  return isRunStatus(value) && !isActiveRunStatus(value);
}
