import { compareDecimals, isNumericSearchValue } from "../../api/contractReader";

export type ReturnTone = "positive" | "negative" | "neutral" | "missing";
export type ReturnKind = "return" | "drawdown";
export type ReturnValue = string | number | null | undefined;

export function returnTone(value: ReturnValue, kind: ReturnKind = "return"): ReturnTone {
  if (!isNumericSearchValue(value)) return "missing";
  const direction = compareDecimals(value, 0);
  if (direction === 0) return "neutral";
  return kind === "drawdown" || direction < 0 ? "negative" : "positive";
}
