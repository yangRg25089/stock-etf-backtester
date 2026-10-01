import type { SharedDraft } from "./defaults";

export function sharedSummaryEndDate(shared: SharedDraft): string | null {
  return shared.run.endDate;
}
