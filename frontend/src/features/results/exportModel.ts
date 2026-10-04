import type { ExportKind, StrategyRun } from "../../api/generated";
import { fetchCsvExport } from "../../api/exports";
import { isSuccessfulRunStatus } from "../../api/runStatus";

export function isExportAvailable(result: StrategyRun | null, kind: ExportKind): boolean {
  if (!result || !isSuccessfulRunStatus(result.status) || !result.metrics) return false;
  return kind !== "search-results" || (result.presetId === "grid_search" && result.searchResult !== null && result.searchResult !== undefined);
}

export function triggerFileDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
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
