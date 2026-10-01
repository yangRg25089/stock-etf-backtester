import type { MetricSummary, StrategyRun } from "../../api/generated";
import type { Locale } from "../../i18n/messages";
import { investedPrincipalValue, isCompletedResult, resultDisplayName } from "./model";

type MetricColumn = keyof Pick<MetricSummary, "actualInvested" | "totalContributed" | "endingEquity" | "netProfit" | "returnOnContributions" | "capitalMultiple" | "xirr" | "maximumDrawdown">;
export type ComparisonSortKey = "strategy" | MetricColumn;
export interface ComparisonSort { key: ComparisonSortKey; direction: "ascending" | "descending" }
const COLUMN_KEYS: ComparisonSortKey[] = [
  "strategy", "actualInvested", "totalContributed", "endingEquity", "netProfit", "returnOnContributions", "capitalMultiple", "xirr", "maximumDrawdown",
];
export const COMPARISON_COLUMNS = COLUMN_KEYS.map(key => ({ key, labelKey: `results.${key}` }));
export const DEFAULT_COMPARISON_SORT: ComparisonSort = { key: "returnOnContributions", direction: "descending" };

function columnValue(result: StrategyRun, key: MetricColumn): number | null {
  if (!isCompletedResult(result) || !result.metrics) return null;
  const raw = key === "actualInvested" ? investedPrincipalValue(result.metrics) : result.metrics[key];
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function sortedComparisons(results: StrategyRun[], sort: ComparisonSort, locale: Locale): StrategyRun[] {
  const collator = new Intl.Collator(locale === "ja" ? "ja-JP" : "zh-CN", { numeric: true });
  return results.map((result, index) => ({ result, index })).sort((left, right) => {
    let comparison: number;
    if (sort.key === "strategy") {
      comparison = collator.compare(resultDisplayName(locale, left.result, results), resultDisplayName(locale, right.result, results));
    } else {
      const a = columnValue(left.result, sort.key);
      const b = columnValue(right.result, sort.key);
      if (a === null || b === null) return a === b ? left.index - right.index : a === null ? 1 : -1;
      comparison = a - b;
    }
    return (sort.direction === "ascending" ? comparison : -comparison) || left.index - right.index;
  }).map(({ result }) => result);
}
