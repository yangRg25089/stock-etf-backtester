import type { RunResponse } from "../../api/generated";
import { fetchRun, subscribeToRunEvents, type RunProgressEvent } from "../../api/runs";

export async function observeRun(
  runId: string,
  onEvent: (event: RunProgressEvent) => void,
  signal?: AbortSignal,
  canReadResult: () => boolean = () => true,
): Promise<RunResponse | null> {
  await subscribeToRunEvents(runId, onEvent, signal);
  if (!canReadResult()) return null;
  return fetchRun(runId, signal);
}
