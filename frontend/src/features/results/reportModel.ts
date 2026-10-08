import { compareDecimals, isNumericSearchValue } from "../../api/contractReader";
import type { Catalog, PeriodReturn, RunResponse, StrategyRun } from "../../api/generated";
import { searchOutcomes } from "../../api/searchResults";
import { isSuccessfulRunStatus } from "../../api/runStatus";
import { translate, type Locale } from "../../i18n/messages";
import { type IndexedSample } from "./chartModel";
import { PRICE_COLOR } from "./colors";
import { formatCurrency, formatMultiple, formatPercent } from "./format";
import { investedPrincipalValue, isCompletedResult, resultDisplayName } from "./model";
import { savedCandidate, savedEvaluationPhase, savedResultConfiguration } from "./savedConfiguration";
import { buildResultSelection } from "./buildResultSelection";
import { buildChartSeriesModel } from "./chart/chartSeriesModel";
import { reportStrategySections, reportExecutionLines } from "./reportConfiguration";
import { hasOnlyZeroCosts, TRADING_COST_FIELDS } from "./tradingCosts";

export interface ReportLine {
  id: string;
  label: string;
  color: string;
  points: IndexedSample[];
}

export interface ResultReport {
  filename: string;
  title: string;
  heading: string;
  symbol: string;
  period: string;
  funding: string;
  metrics: { key: string; label: string; value: string }[];
  sections: { title: string; lines: string[] }[];
  periodReturns: { title: string; annualTitle: string; yearTitle: string; monthly: PeriodReturn[]; annual: PeriodReturn[]; empty: string };
  lines: ReportLine[];
  drawdown: { date: string; index: number; value: number }[];
  chartTitle: string;
  chartAxis: string;
  drawdownTitle: string;
  drawdownColor: string;
  tradeSummary: string;
  notes: string[];
  dates: string[];
  resultId: string;
}

function objectValues(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function savedParent(run: RunResponse, result: StrategyRun, parent?: StrategyRun | null): StrategyRun | undefined {
  const results = run.result?.strategyRuns ?? [];
  if (!parent) return results.find(item => item.id === result.id);
  const saved = results.find(item => item.id === parent.id && item.presetId === "grid_search");
  const outcome = saved?.searchResult && searchOutcomes(saved.searchResult).find(item => item.id === result.id)?.outcome;
  return outcome && isSuccessfulRunStatus(outcome.status) ? saved : undefined;
}

export function isResultReportAvailable(run: RunResponse | null, result: StrategyRun | null, parent?: StrategyRun | null): boolean {
  if (!run || !result || run.snapshot.runId !== run.runId || run.result?.runId !== run.runId) return false;
  const owner = savedParent(run, result, parent);
  const saved = parent ? result : owner;
  return Boolean(owner && saved && isCompletedResult(saved) && saved.metrics && saved.dailyAssets?.length);
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 100) || "result";
}

export interface ReportChartSelection {
  selectedIds: string[];
  visibleSeriesIds: string[];
  orderedIds?: string[];
}

/** Freezes saved values and current curve selection; never reads the live draft or viewport. */
export function buildResultReport(run: RunResponse | null, result: StrategyRun | null, locale: Locale, catalog?: Catalog | null,
  parent?: StrategyRun | null, chartSelection?: ReportChartSelection): ResultReport | null {
  if (!isResultReportAvailable(run, result, parent) || !run || !result) return null;
  const owner = savedParent(run, result, parent)!;
  result = parent ? result : owner;
  if (!result.metrics) return null;
  const results = run.result?.strategyRuns ?? [];
  const { strategy, candidate, overrides } = savedResultConfiguration(run, result, parent ? owner : null);
  const currency = result.metrics.currency ?? result.dailyAssets?.[0]?.currency;
  const shared = run.snapshot.config.shared;
  const rows = result.dailyAssets!;
  const period = `${rows[0].date} → ${rows[rows.length - 1].date}`;
  const phase = savedEvaluationPhase(result, parent ? owner : null);
  const title = resultDisplayName(locale, owner, results) + (candidate && phase !== "outOfSample" ? ` · #${candidate.sequence}` : "")
    + (phase ? ` · ${translate(locale, `search.phase.${phase}`)}` : "");
  const amount = `${formatCurrency(shared.contribution.amount, currency, locale)}${currency ? ` ${currency}` : ""}`;
  const funding = translate(locale, "report.funding", { amount, day: String(shared.contribution.day) });
  const metricValues = [
    ["endingEquity", formatCurrency(result.metrics.endingEquity, currency, locale)],
    ["totalContributed", formatCurrency(result.metrics.totalContributed, currency, locale)],
    ["actualInvested", formatCurrency(investedPrincipalValue(result.metrics), currency, locale)],
    ["netProfit", formatCurrency(result.metrics.netProfit, currency, locale)],
    ["returnOnContributions", formatPercent(result.metrics.returnOnContributions, locale)],
    ["capitalMultiple", formatMultiple(result.metrics.capitalMultiple, locale)],
    ["xirr", formatPercent(result.metrics.xirr, locale)],
    ["maximumDrawdown", formatPercent(result.metrics.maximumDrawdown, locale)],
  ];
  const sections = phase !== "outOfSample" ? reportStrategySections(strategy, overrides, catalog, locale, currency) : [];
  if (phase === "outOfSample") {
    for (const window of owner.searchResult?.walkForwardWindows ?? []) {
      const chosen = savedCandidate(owner.searchResult, window.selectedCandidateId ?? "");
      if (!chosen) continue;
      const chosenParams = objectValues(chosen.parameterValues);
      const chosenOverrides = Object.fromEntries((owner.searchResult?.dimensions ?? []).filter(item => Object.hasOwn(chosenParams, item.key)).map(item => [item.key, chosenParams[item.key]]));
      const windowSections = reportStrategySections(strategy, chosenOverrides, catalog, locale, currency);
      if (windowSections.length) sections.push({ title: `${translate(locale, "search.walkWindow")} ${window.sequence} · ${window.testPeriod.startDate} → ${window.testPeriod.endDate}`,
        lines: windowSections.flatMap(section => [section.title, ...section.lines]) });
    }
  }
  const execution = reportExecutionLines(shared.execution, catalog, locale, currency);
  if (execution.length) sections.push({ title: translate(locale, "parameterGroups.execution"), lines: execution });
  const costs = result.metrics.tradingCosts;
  if (costs && !hasOnlyZeroCosts(costs)) sections.push({
    title: translate(locale, "costs.heading"),
    lines: TRADING_COST_FIELDS.filter(key => !isNumericSearchValue(costs[key]) || compareDecimals(costs[key], 0) !== 0).map(key => `${translate(locale, `costs.${key}`)}: ${formatCurrency(costs[key], currency, locale)}${currency ? ` ${currency}` : ""}`),
  });
  const selectedIds = chartSelection?.selectedIds ?? [owner.id, ...results.filter(item => item.role === "benchmark").map(item => item.id)];
  const selection = buildResultSelection({ run, focusedResult: owner, candidateResult: parent ? result : null,
    selectedIds, orderedResults: chartSelection?.orderedIds?.map(id => results.find(item => item.id === id)).filter((item): item is StrategyRun => Boolean(item)) ?? results, locale });
  const model = buildChartSeriesModel(rows, [], selection.selectedComparisons);
  const asset = model.normalizedById.get("totalAsset");
  const price = model.normalizedById.get("price");
  const visible = chartSelection?.visibleSeriesIds ?? ["price", "totalAsset"];
  const assetVisible = visible.includes("totalAsset") && (selection.showFocusedAsset && asset || model.comparisonNormalized.length > 0);
  const lines: ReportLine[] = price && (visible.includes("price") || !assetVisible)
    ? [{ id: "price", label: translate(locale, "chart.price"), color: PRICE_COLOR, points: price.points }] : [];
  if (asset && selection.showFocusedAsset && visible.includes("totalAsset")) lines.push({ id: result.id,
    label: selection.totalAssetLabel, color: selection.totalAssetColor ?? PRICE_COLOR, points: asset.points });
  if (visible.includes("totalAsset")) for (const comparison of model.comparisonNormalized) lines.push({ id: comparison.id,
    label: comparison.label, color: comparison.color, points: comparison.result.points });
  const ranks = new Map(selection.strategyOrder.map((id, index) => [id, index]));
  lines.sort((a, b) => a.id === "price" ? -1 : b.id === "price" ? 1 : (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
  const notes = [translate(locale, "report.method")];
  if (chartSelection && (lines.filter(line => line.id !== "price").length !== 1 || !lines.some(line => line.id === result.id))) {
    notes.push(translate(locale, "report.chartScope"));
  }
  if (!lines.some(line => line.id !== "price")) notes.push(translate(locale, "report.noStrategies"));
  if (!costs) notes.push(translate(locale, "costs.notSaved"));
  if (!asset) notes.push(translate(locale, "report.principalMissing"));
  const diagnostics = [...(result.diagnostics ?? []), ...(result.metrics.diagnostics ?? [])];
  for (const diagnostic of diagnostics.filter(item => item.severity !== "info")) {
    const text = translate(locale, diagnostic.messageKey);
    if (!notes.includes(text)) notes.push(text);
  }
  const requested = `${result.evaluationPeriod?.startDate ?? shared.run.startDate} → ${result.evaluationPeriod?.endDate ?? shared.run.endDate}`;
  if (requested !== period) notes.push(translate(locale, "report.requestedPeriod", { period: requested }));
  const symbol = shared.run.symbol;
  const identity = parent ? result.id : owner.presetId;
  return {
    filename: `${[symbol, identity, rows[rows.length - 1].date, run.runId].map(safeFilenamePart).join("-")}.png`,
    title, heading: translate(locale, "report.heading"), symbol, period, funding,
    metrics: metricValues.map(([key, value]) => ({ key, label: translate(locale, `results.${key}`), value })),
    sections, lines,
    periodReturns: { title: translate(locale, "performance.monthly"), annualTitle: translate(locale, "performance.annual"),
      yearTitle: translate(locale, "performance.year"),
      monthly: (result.metrics.analysis?.monthlyReturns ?? []).map(row => ({ ...row })), annual: (result.metrics.analysis?.annualReturns ?? []).map(row => ({ ...row })),
      empty: translate(locale, "performance.periodsNotSaved") },
    drawdown: rows.flatMap((row, index) => row.drawdown == null || !Number.isFinite(Number(row.drawdown)) ? []
      : [{ date: row.date, index, value: Number(row.drawdown) * 100 }]),
    chartTitle: translate(locale, "chart.overlayTitle"), chartAxis: translate(locale, "chart.overlayAxis"),
    drawdownTitle: translate(locale, "chart.drawdown"), drawdownColor: selection.totalAssetColor ?? PRICE_COLOR,
    tradeSummary: `${translate(locale, "strategy.buy")} ${(result.trades ?? []).filter(item => item.side === "buy").length} · ${translate(locale, "strategy.sell")} ${(result.trades ?? []).filter(item => item.side === "sell").length}`,
    notes, resultId: result.id,
    dates: rows.map(row => row.date),
  };
}

/** Wraps by measured Unicode code points, including long unbroken identifiers and CJK. */
export function wrapReportText(text: string, maxWidth: number, measure: (text: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && measure(line + character) > maxWidth) { lines.push(line); line = ""; }
      line += character;
    }
    lines.push(line);
  }
  return lines;
}

export function reportBitmapSize(width: number, height: number): { width: number; height: number; scale: number } {
  const scale = Math.min(2, 16384 / Math.max(width, height), Math.sqrt(16_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}
