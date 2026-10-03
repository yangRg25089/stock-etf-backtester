import type { Catalog, ConditionGroup, ConditionLeaf, RunResponse, StrategyRun } from "../../api/generated";
import { translate, unitLabel, type Locale } from "../../i18n/messages";
import { normalizeSeriesToBase100, type IndexedSample } from "./chartModel";
import { PRICE_COLOR, resultColor } from "./colors";
import { formatCurrency, formatMultiple, formatPercent, formatPlainNumber } from "./format";
import { investedPrincipalValue, isCompletedResult, resultDisplayName } from "./model";

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
  lines: ReportLine[];
  drawdown: { date: string; index: number; value: number }[];
  chartTitle: string;
  chartAxis: string;
  drawdownTitle: string;
  tradeSummary: string;
  notes: string[];
  footer: string[];
  resultId: string;
}

function objectValues(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function savedParent(run: RunResponse, result: StrategyRun, parent?: StrategyRun | null): StrategyRun | undefined {
  const results = run.result?.strategyRuns ?? [];
  if (!parent) return results.find(item => item.id === result.id);
  const saved = results.find(item => item.id === parent.id && item.presetId === "grid_search");
  return saved?.searchResult?.candidates.some(candidate => candidate.candidateId === result.id
    && (candidate.status === "completed" || candidate.status === "completed_with_warning")) ? saved : undefined;
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

function parameterText(key: string, value: unknown, catalog: Catalog | null | undefined, locale: Locale, currency?: string | null): string {
  const parameter = catalog?.parameters?.find(item => item.key === key);
  const label = parameter ? translate(locale, parameter.translationKey) : key;
  let formatted: string;
  if (value === null && parameter?.nullable) formatted = translate(locale, "strategy.unlimited");
  else if (typeof value === "boolean") formatted = translate(locale, value ? "field.enabled" : "field.disabled");
  else if (parameter?.type === "ratio") formatted = formatPercent(String(value), locale);
  else if (parameter?.unit === "currency") formatted = `${formatCurrency(String(value), currency, locale)}${currency ? ` ${currency}` : ""}`;
  else if (["integer", "decimal", "percent_point"].includes(parameter?.type ?? "")) {
    const unit = unitLabel(locale, parameter?.unit);
    formatted = `${formatPlainNumber(String(value), locale)}${unit ? ` ${unit}` : ""}`;
  } else {
    const translated = translate(locale, `enum.${String(value)}`);
    formatted = translated === `enum.${String(value)}` ? typeof value === "object" ? JSON.stringify(value) : String(value) : translated;
  }
  return `${label}: ${formatted}`;
}

function conditionLines(node: ConditionLeaf | ConditionGroup | null | undefined, catalog: Catalog | null | undefined, locale: Locale,
  overrides: Record<string, unknown>, currency: string | null | undefined, depth = 0): string[] {
  if (!node) return [translate(locale, "field.disabled")];
  const indent = "  ".repeat(depth);
  const disabled = node.enabled === false ? ` · ${translate(locale, "field.disabled")}` : "";
  if ("kind" in node) {
    const nameKey = catalog?.conditions?.find(item => item.kind === node.kind)?.nameKey ?? `conditions.${node.kind}`;
    return [indent + translate(locale, nameKey) + disabled,
      ...Object.entries({ ...objectValues(node.params), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => Object.hasOwn(node.params ?? {}, key))) })
        .map(([key, value]) => `${indent}  ${parameterText(key, value, catalog, locale, currency)}`)];
  }
  const children = node.children ?? [];
  return children.length === 0 ? [indent + translate(locale, "field.disabled")]
    : [indent + (node.operator ?? "AND") + disabled,
      ...children.flatMap(child => conditionLines(child, catalog, locale, overrides, currency, depth + 1))];
}

function reportAssetLine(result: StrategyRun, label: string, color: string): ReportLine | null {
  const normalized = normalizeSeriesToBase100("totalAsset", (result.dailyAssets ?? []).map((row, index) => ({
    index, date: row.date, value: Number(row.totalAsset),
    contributed: row.totalContributed == null ? undefined : Number(row.totalContributed),
  })));
  return normalized ? { id: result.id, label, color, points: normalized.points } : null;
}

/** Reads only the saved run/candidate. No live draft, visibility or viewport state enters a report. */
export function buildResultReport(run: RunResponse | null, result: StrategyRun | null, locale: Locale, catalog?: Catalog | null,
  parent?: StrategyRun | null): ResultReport | null {
  if (!isResultReportAvailable(run, result, parent) || !run || !result) return null;
  const owner = savedParent(run, result, parent)!;
  result = parent ? result : owner;
  if (!result.metrics) return null;
  const results = run.result?.strategyRuns ?? [];
  const strategy = run.snapshot.config.strategies?.find(item => item.id === owner.id);
  const search = owner.searchResult;
  const candidate = search?.candidates.find(item => item.candidateId === (parent ? result.id : search.rankedCandidateIds[0]));
  const candidateValues = objectValues(candidate?.parameterValues);
  const overrides = Object.fromEntries((search?.dimensions ?? [])
    .filter(item => Object.hasOwn(candidateValues, item.key)).map(item => [item.key, candidateValues[item.key]]));
  const parameters = { ...objectValues(strategy?.params), ...overrides };
  const currency = result.metrics.currency ?? result.dailyAssets?.[0]?.currency;
  const shared = run.snapshot.config.shared;
  const rows = result.dailyAssets!;
  const period = `${rows[0].date} → ${rows[rows.length - 1].date}`;
  const title = resultDisplayName(locale, owner, results) + (candidate ? ` · #${candidate.sequence}` : "");
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
  const limits = Object.entries(parameters).filter(([key]) => key.startsWith("accumulation.") && key !== "accumulation.conditionLogic");
  const sections = strategy ? [
    { title: translate(locale, "parameterGroups.buy_limits"), lines: limits.map(([key, value]) => parameterText(key, value, catalog, locale, currency)) },
    { title: translate(locale, "strategy.buy"), lines: strategy.rules ? conditionLines(strategy.rules.buy, catalog, locale, overrides, currency)
      : Object.entries(parameters).filter(([key]) => !key.startsWith("accumulation.")).map(([key, value]) => parameterText(key, value, catalog, locale, currency)) },
    { title: translate(locale, "strategy.sell"), lines: conditionLines(strategy.rules?.sell, catalog, locale, overrides, currency) },
  ].filter(section => section.lines.length) : [];
  const price = normalizeSeriesToBase100("price", rows.map((row, index) => ({ date: row.date, index, value: Number(row.simulationPrice) })));
  const lines: ReportLine[] = price ? [{ id: "price", label: translate(locale, "chart.price"), color: PRICE_COLOR, points: price.points }] : [];
  const asset = reportAssetLine(result, title, resultColor(results.findIndex(item => item.id === owner.id)));
  if (asset) lines.push(asset);
  for (const baseline of results.filter(item => item.role === "benchmark" && item.id !== owner.id && isCompletedResult(item))) {
    const line = reportAssetLine(baseline, resultDisplayName(locale, baseline, results), resultColor(results.indexOf(baseline)));
    if (line) lines.push(line);
  }
  const notes = [translate(locale, "report.method")];
  if (!asset) notes.push(translate(locale, "report.principalMissing"));
  const diagnostics = [...(result.diagnostics ?? []), ...(result.metrics.diagnostics ?? [])];
  for (const diagnostic of diagnostics.filter(item => item.severity !== "info")) {
    const text = translate(locale, diagnostic.messageKey);
    if (!notes.includes(text)) notes.push(text);
  }
  const requested = `${shared.run.startDate} → ${shared.run.endDate}`;
  if (requested !== period) notes.push(translate(locale, "report.requestedPeriod", { period: requested }));
  const symbol = shared.run.symbol;
  const identity = parent ? result.id : owner.presetId;
  return {
    filename: `${[symbol, identity, rows[rows.length - 1].date, run.runId].map(safeFilenamePart).join("-")}.png`,
    title, heading: translate(locale, "report.heading"), symbol, period, funding,
    metrics: metricValues.map(([key, value]) => ({ key, label: translate(locale, `results.${key}`), value })),
    sections, lines,
    drawdown: rows.flatMap((row, index) => row.drawdown == null || !Number.isFinite(Number(row.drawdown)) ? []
      : [{ date: row.date, index, value: Number(row.drawdown) * 100 }]),
    chartTitle: translate(locale, "chart.overlayTitle"), chartAxis: translate(locale, "chart.overlayAxis"),
    drawdownTitle: translate(locale, "chart.drawdown"),
    tradeSummary: `${translate(locale, "strategy.buy")} ${(result.trades ?? []).filter(item => item.side === "buy").length} · ${translate(locale, "strategy.sell")} ${(result.trades ?? []).filter(item => item.side === "sell").length}`,
    notes, resultId: result.id,
    footer: [
      `Run: ${run.runId} · ${result.id}`,
      `${run.snapshot.engineVersion} · ${run.snapshot.catalogVersion}`,
      `Data: ${run.snapshot.dataFingerprint}`,
      ...(run.snapshot.createdAt ? [translate(locale, "report.savedAt", { date: run.snapshot.createdAt })] : []),
    ],
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
