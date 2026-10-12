import { triggerFileDownload } from "../../shared/lib/fileDownload";
export { triggerFileDownload } from "../../shared/lib/fileDownload";
import type { ExportKind, StrategyRun } from "../../api/generated";
import { fetchCsvExport } from "../../api/exports";
import { isSuccessfulRunStatus } from "../../api/runStatus";

export function isExportAvailable(result: StrategyRun | null, kind: ExportKind): boolean {
  if (!result || !isSuccessfulRunStatus(result.status) || !result.metrics) return false;
  return kind !== "search-results" || (result.presetId === "grid_search" && result.searchResult !== null && result.searchResult !== undefined);
}

export async function performCsvExport(
  runId: string,
  focusedResultId: string,
  kind: ExportKind,
  signal?: AbortSignal,
): Promise<void> {
  const exported = await fetchCsvExport(runId, focusedResultId, kind, signal);
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  triggerFileDownload(exported.blob, exported.filename);
}
