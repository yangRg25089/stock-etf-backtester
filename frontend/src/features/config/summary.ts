import type { RunResponse } from "../../api/generated";
import type { SharedDraft } from "./defaults";

export function sharedSummaryEndDate(shared: SharedDraft, saved: RunResponse | null): string | null {
  if (shared.run.endMode === "fixed") return shared.run.endDate;
  if (shared.run.symbol.trim().toUpperCase() !== saved?.snapshot.config.shared.run.symbol.toUpperCase()) return null;
  return saved.snapshot.dataProvenance?.marketDataThrough
    ?? (saved.snapshot.config.shared.run.endMode === "fixed" ? saved.snapshot.config.shared.run.endDate : null);
}
