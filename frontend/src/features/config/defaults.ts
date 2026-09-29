import type { Catalog, EndMode, ParameterDefinition } from "../../api/generated";

export interface SharedDraft {
  run: {
    symbol: string;
    startDate: string;
    endDate: string | null;
    endMode: EndMode;
  };
  contribution: {
    amount: string | null;
    day: number | null;
  };
}

type SharedFieldKey =
  | "run.symbol"
  | "run.startDate"
  | "run.endDate"
  | "run.endMode"
  | "contribution.amount"
  | "contribution.day";

function getDefinition(catalog: Catalog, key: SharedFieldKey): ParameterDefinition {
  const definition = catalog.parameters?.find((item) => item.key === key);
  if (!definition) throw new Error(`Catalog is missing shared parameter ${key}`);
  return definition;
}

export function createDefaultSharedDraft(catalog: Catalog): SharedDraft {
  const defaultFor = (key: SharedFieldKey) => getDefinition(catalog, key).default;
  const endMode = defaultFor("run.endMode");
  if (endMode !== "latest" && endMode !== "fixed") {
    throw new Error("Catalog has an unsupported default run.endMode");
  }
  const symbol = defaultFor("run.symbol");
  const startDate = defaultFor("run.startDate");
  const endDate = defaultFor("run.endDate");
  const amount = defaultFor("contribution.amount");
  const day = defaultFor("contribution.day");
  if (typeof symbol !== "string" || typeof startDate !== "string") {
    throw new Error("Catalog shared symbol and start date defaults must be strings");
  }
  return {
    run: {
      symbol,
      startDate,
      endDate: typeof endDate === "string" ? endDate : null,
      endMode: endMode as EndMode,
    },
    contribution: {
      amount: typeof amount === "string" || typeof amount === "number" ? String(amount) : null,
      day: typeof day === "number" ? day : null,
    },
  };
}
