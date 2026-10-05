import type { Catalog, ParameterDefinition } from "../../api/generated";

export interface SharedDraft {
  run: { symbol: string; startDate: string; endDate: string | null };
  contribution: { amount: string | null; day: number | null };
  currency?: string;
  analysis?: { riskFreeAnnualRatePct: string | null };
  execution?: { commission: string | null; slippagePct: string | null; spreadPct: string | null; fractionalShares: boolean; capitalGainsTaxEnabled: boolean };
}

import type { SharedFieldKey } from "./fieldKeys";

function getDefinition(catalog: Catalog, key: SharedFieldKey): ParameterDefinition {
  const definition = catalog.parameters?.find((item) => item.key === key);
  if (!definition) throw new Error(`Catalog is missing shared parameter ${key}`);
  return definition;
}

export function createDefaultSharedDraft(catalog: Catalog): SharedDraft {
  const defaultFor = (key: SharedFieldKey) => getDefinition(catalog, key).default;
  const symbol = defaultFor("run.symbol");
  const startDate = defaultFor("run.startDate");
  const endDate = defaultFor("run.endDate");
  const amount = defaultFor("contribution.amount");
  const day = defaultFor("contribution.day");
  const riskFreeRate = defaultFor("analysis.riskFreeAnnualRatePct");
  const decimalDefault = (key: SharedFieldKey) => {
    const value = defaultFor(key);
    return typeof value === "string" || typeof value === "number" ? String(value) : null;
  };
  const taxEnabled = defaultFor("execution.capitalGainsTaxEnabled");
  if (typeof taxEnabled !== "boolean") throw new Error("Catalog tax default must be boolean");
  const fractional = defaultFor("execution.fractionalShares");
  if (typeof fractional !== "boolean") throw new Error("Catalog fractional shares default must be boolean");
  if (typeof symbol !== "string" || typeof startDate !== "string" || typeof endDate !== "string") {
    throw new Error("Catalog shared symbol and dates must be strings");
  }
  return {
    run: { symbol, startDate, endDate },
    contribution: {
      amount: typeof amount === "string" || typeof amount === "number" ? String(amount) : null,
      day: typeof day === "number" ? day : null,
    },
    currency: catalog.symbolSuggestions?.find(item => item.symbol === symbol)?.currency,
    analysis: { riskFreeAnnualRatePct: typeof riskFreeRate === "number" || typeof riskFreeRate === "string" ? String(riskFreeRate) : null },
    execution: { commission: decimalDefault("execution.commission"), slippagePct: decimalDefault("execution.slippagePct"),
      spreadPct: decimalDefault("execution.spreadPct"), fractionalShares: fractional, capitalGainsTaxEnabled: taxEnabled },
  };
}
