/** Shared editor fields, in display order; values and constraints come from catalog. */
export const SHARED_FIELD_KEYS = [
  "run.symbol", "run.startDate", "run.endDate", "contribution.amount", "contribution.day",
  "analysis.riskFreeAnnualRatePct",
  "execution.commission", "execution.slippagePct", "execution.spreadPct", "execution.fractionalShares", "execution.capitalGainsTaxEnabled",
] as const;

export type SharedFieldKey = (typeof SHARED_FIELD_KEYS)[number];
