import type { ExportKind, StrategyRun, StrategyStatus } from "../../api/generated";
import { fetchCsvExport } from "../../api/exports";

const SUCCESS_STATUSES = new Set<StrategyStatus>(["completed", "completed_with_warning"]);

export function isExportAvailable(result: StrategyRun | null, kind: ExportKind): boolean {
  if (!result || !SUCCESS_STATUSES.has(result.status ?? "queued") || !result.metrics) return false;
  return kind !== "search-results" || (result.presetId === "grid_search" && result.searchResult !== null && result.searchResult !== undefined);
}

export function triggerCsvDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export async function performCsvExport(
  runId: string,
  focusedResultId: string,
  kind: ExportKind,
): Promise<void> {
  const exported = await fetchCsvExport(runId, focusedResultId, kind);
  triggerCsvDownload(exported.blob, exported.filename);
}
