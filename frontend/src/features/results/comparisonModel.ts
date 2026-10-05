import type { MetricSummary, StrategyRun } from "../../api/generated";
import { compareDecimals, isNumericSearchValue } from "../../api/contractReader";
import type { Locale } from "../../i18n/messages";
import { investedPrincipalValue, isCompletedResult, resultDisplayName } from "./model";
import { languageTag } from "./format";

type MetricColumn = keyof Pick<MetricSummary, "actualInvested" | "endingEquity" | "netProfit" | "returnOnContributions" | "capitalMultiple" | "xirr" | "maximumDrawdown">;
export type ComparisonSortKey = "strategy" | "capitalGainsTax" | MetricColumn;
export interface ComparisonSort { key: ComparisonSortKey; direction: "ascending" | "descending" }
const COLUMN_KEYS: ComparisonSortKey[] = [
  "strategy", "actualInvested", "endingEquity", "netProfit", "returnOnContributions", "capitalMultiple", "xirr", "maximumDrawdown", "capitalGainsTax",
];
export const COMPARISON_COLUMNS = COLUMN_KEYS.map(key => ({ key, labelKey: `results.${key}` }));
export const DEFAULT_COMPARISON_SORT: ComparisonSort = { key: "returnOnContributions", direction: "descending" };

function columnValue(result: StrategyRun, key: MetricColumn | "capitalGainsTax"): string | number | null {
  if (!isCompletedResult(result) || !result.metrics) return null;
  const raw: unknown = key === "actualInvested" ? investedPrincipalValue(result.metrics) : key === "capitalGainsTax" ? result.metrics.tradingCosts?.capitalGainsTax : result.metrics[key];
  return isNumericSearchValue(raw) ? raw : null;
}

export function sortedComparisons(results: StrategyRun[], sort: ComparisonSort, locale: Locale): StrategyRun[] {
  const collator = new Intl.Collator(languageTag(locale), { numeric: true });
  return results.map((result, index) => ({ result, index })).sort((left, right) => {
    let comparison: number;
    if (sort.key === "strategy") {
      comparison = collator.compare(resultDisplayName(locale, left.result, results), resultDisplayName(locale, right.result, results));
    } else {
      const a = columnValue(left.result, sort.key);
      const b = columnValue(right.result, sort.key);
      if (a === null || b === null) return a === b ? left.index - right.index : a === null ? 1 : -1;
      comparison = compareDecimals(a, b);
    }
    return (sort.direction === "ascending" ? comparison : -comparison) || left.index - right.index;
  }).map(({ result }) => result);
}
