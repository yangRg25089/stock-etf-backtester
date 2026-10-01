import type { Catalog, ParameterDefinition } from "../../api/generated";

export interface SharedDraft {
  run: { symbol: string; startDate: string; endDate: string | null };
  contribution: { amount: string | null; day: number | null };
  currency?: string;
}

type SharedFieldKey = "run.symbol" | "run.startDate" | "run.endDate" | "contribution.amount" | "contribution.day";

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
  };
}
