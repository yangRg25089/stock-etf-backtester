import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import type { DailyAsset, SignalEvaluation, TechnicalIndicatorSeries, Trade } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { ChartCrosshair, ChartReadout, type ChartCursor, type CursorReading } from "./ChartCrosshair";
import { useChartInteraction, type ChartInteractionProps } from "./useChartInteraction";
import { tradeMarkerPoints } from "./chartTradeMarkers";
import { chartSegments, technicalChartLines, type TechnicalChartLine } from "./technicalIndicators";
import { isVolatilityObservation, type SavedVolatilitySeries } from "./model";
import { PRICE_COLOR, resultColor } from "./colors";
import {
  normalizeSeriesToBase100,
  normalizeValueToBase100,
  type ChartSeriesId,
  type SeriesSample,
  type NormalizedSeries,
} from "./chartModel";
import {
  MIN_CHART_VIEWPORT_SPAN,
  samplesInViewport,
  visibleIndexRange,
  type ChartViewport,
} from "./chartViewport";

type AxisSeriesId = ChartSeriesId | "rsi" | "index";

interface StrategyChartSeries {
  id: string;
  label: string;
  color: string;
  dailyAssets: DailyAsset[];
  trades?: Trade[];
}

interface ResultsChartsProps {
  busy?: boolean;
  locale: Locale;
  dailyAssets: DailyAsset[];
  trades: Trade[];
  signals: SignalEvaluation[];
  comparisonSeries?: StrategyChartSeries[];
  strategyOrder?: string[];
  totalAssetColor?: string;
  totalAssetLabel?: string;
  totalAssetResultId?: string;
  volatilitySeries?: SavedVolatilitySeries[];
  technicalIndicators?: TechnicalIndicatorSeries[];
  showFocusedAsset?: boolean;
  vixSymbol?: string;
  vixThreshold?: string;
  visibleSeriesIds: string[];
  onSeriesChange(id: string, visible: boolean): void;
}

interface SeriesDefinition {
  id: ChartSeriesId;
  color: string;
  labelKey: string;
  label?: string;
  resultId?: string;
}

function seriesIdentity(series: SeriesDefinition): string {
  return series.resultId ?? series.id;
}

interface IndicatorComparison { label: string; color: string; samples: SeriesSample[] }

type IndicatorSeriesDefinition = Omit<SeriesDefinition, "id"> & { id: "drawdown" | "vix" | "rsi" };

interface ChartPoint extends SeriesSample {
  x: number;
  y: number;
}

interface ChartScale {
  minimum: number;
  maximum: number;
  y(value: number): number;
}

const SERIES: SeriesDefinition[] = [
  { id: "price", color: PRICE_COLOR, labelKey: "chart.price" },
  { id: "totalAsset", color: resultColor(0), labelKey: "chart.totalAsset" },
  { id: "drawdown", color: "#a7373a", labelKey: "chart.drawdown" },
  { id: "vix", color: "#7656a6", labelKey: "chart.vix" },
];
const CHART = { height: 320, left: 92, right: 26, top: 20, bottom: 54, width: 800 };
const MAIN_WITHOUT_DATES = { ...CHART, height: 274, bottom: 8 };
const COMPACT_CHART = { ...CHART, height: 90, top: 8, bottom: 8 };

function numericValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function localeTag(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : "zh-CN";
}

function preciseValue(value: number | null | undefined, locale: Locale, currency?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}${currency ? ` ${currency}` : ""}`;
}

function formatAxisValue(
  value: number,
  locale: Locale,
  seriesId: AxisSeriesId,
  currency?: string,
): string {
  if (seriesId === "drawdown") {
    return new Intl.NumberFormat(localeTag(locale), {
      maximumFractionDigits: 1,
      style: "percent",
    }).format(value);
  }
  if (seriesId === "index") {
    return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(value);
  }
  if (currency && (seriesId === "price" || seriesId === "totalAsset")) {
    try {
      return new Intl.NumberFormat(localeTag(locale), {
        currency,
        maximumFractionDigits: value < 10 ? 2 : 0,
        style: "currency",
      }).format(value);
    } catch {
      // A malformed currency must not prevent rendering a saved result.
    }
  }
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 2 }).format(value);
}

function axisTitle(locale: Locale, seriesId: AxisSeriesId, currency?: string): string {
  if (seriesId === "rsi") return translate(locale, "chart.rsiAxis");
  if (seriesId === "index") return translate(locale, "chart.overlayAxis");
  if (seriesId === "totalAsset" && !currency) return translate(locale, "chart.totalAssetAxisPlain");
  if (seriesId === "price" && !currency) return translate(locale, "chart.priceAxisPlain");
  const key = seriesId === "totalAsset"
    ? "chart.totalAssetAxis"
    : seriesId === "drawdown"
      ? "chart.drawdownAxis"
      : seriesId === "price"
        ? "chart.priceAxis"
        : "chart.vixAxis";
  return translate(locale, key, { currency: currency ?? "" });
}

function chartScale(
  values: number[],
  { maximumAtZero = false, fixedBounds }: { maximumAtZero?: boolean; fixedBounds?: [number, number] } = {},
  geometry = CHART,
): ChartScale {
  let rawMinimum = Infinity;
  let rawMaximum = -Infinity;
  for (const value of values) {
    rawMinimum = Math.min(rawMinimum, value);
    rawMaximum = Math.max(rawMaximum, value);
  }
  const span = rawMaximum - rawMinimum;
  const padding = span === 0
    ? Math.max(Math.abs(rawMaximum) * 0.05, maximumAtZero ? 0.01 : 1)
    : span * 0.08;
  const minimum = fixedBounds?.[0] ?? rawMinimum - padding;
  const maximum = fixedBounds?.[1] ?? (maximumAtZero ? 0 : rawMaximum + padding);
  const plotHeight = geometry.height - geometry.top - geometry.bottom;
  return {
    minimum,
    maximum,
    y: (value) => geometry.top + ((maximum - value) / (maximum - minimum)) * plotHeight,
  };
}

function xPosition(index: number, count: number, viewport: ChartViewport): number {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  if (count <= 1) return CHART.left + plotWidth / 2;
  const dateRatio = index / (count - 1);
  return CHART.left + ((dateRatio - viewport.start) / (viewport.end - viewport.start)) * plotWidth;
}

function dateTicks(dates: string[], viewport: ChartViewport): Array<{ date: string; x: number }> {
  if (dates.length === 0) return [];
  const range = visibleIndexRange(dates.length, viewport);
  const indexes = [...new Set(Array.from({ length: 7 }, (_, index) =>
    Math.round(range.start + (range.end - range.start) * index / 6),
  ))];
  return indexes.flatMap((index) => {
    const date = dates[index];
    if (!date) return [];
    const x = xPosition(index, dates.length, viewport);
    return [{ date, x: Math.min(CHART.width - CHART.right, Math.max(CHART.left, x)) }];
  });
}

function ChartAxes({
  dates,
  locale,
  scale,
  seriesId,
  currency,
  viewport,
  geometry,
}: {
  dates: string[];
  locale: Locale;
  scale: ChartScale;
  seriesId: AxisSeriesId;
  currency?: string;
  viewport: ChartViewport;
  geometry: typeof CHART;
}) {
  const plotBottom = geometry.height - geometry.bottom;
  const compact = geometry.height === COMPACT_CHART.height;
  const tickCount = compact ? 3 : 8;
  const ticks = Array.from({ length: tickCount }, (_, index) =>
    scale.maximum - ((scale.maximum - scale.minimum) * index) / (tickCount - 1),
  );
  return (
    <g className="chart-axes">
      {ticks.map((value, index) => {
        const y = scale.y(value);
        return (
          <g key={`y-${index}`}>
            <line className="chart-gridline" x1={CHART.left} y1={y} x2={CHART.width - CHART.right} y2={y} />
            <text className="chart-tick-label chart-y-tick" x={CHART.left - 10} y={y + 4} textAnchor="end">
              {formatAxisValue(value, locale, seriesId, currency)}
            </text>
          </g>
        );
      })}
      {dateTicks(dates, viewport).map(({ date, x }) => (
        <g key={`x-${date}`}>
          <line className="chart-gridline chart-gridline-vertical" x1={x} y1={geometry.top} x2={x} y2={plotBottom} />
        </g>
      ))}
      {!compact && <text className="chart-axis-title chart-y-axis-title" transform={`translate(20 ${(geometry.top + plotBottom) / 2}) rotate(-90)`} textAnchor="middle">
        {axisTitle(locale, seriesId, currency)}
      </text>}
    </g>
  );
}

function ChartDateAxis({ dates, locale, viewport, cursor }: {
  dates: string[];
  locale: Locale;
  viewport: ChartViewport;
  cursor: ChartCursor | null;
}) {
  const date = cursor ? dates[cursor.index] : undefined;
  const ticks = dateTicks(dates, viewport);
  const cursorX = cursor ? xPosition(cursor.index, dates.length, viewport) : 0;
  const dateX = Math.min(CHART.width - CHART.right - 43, Math.max(CHART.left + 43, cursorX));
  return (
    <div className="chart-date-axis-row" data-window-start={viewport.start} data-window-end={viewport.end}>
      <svg className="chart-date-axis" viewBox="0 0 800 44" role="img" aria-label={translate(locale, "chart.dateAxis")}>
        {ticks.map(({ date: tickDate, x }, index) => (
          <text key={tickDate} className="chart-tick-label chart-x-tick" data-tick-index={index} x={x} y="18"
            textAnchor={ticks.length > 1 && index === ticks.length - 1 ? "end" : "middle"}>{tickDate}</text>
        ))}
        {date && <g aria-hidden="true">
          <rect className="chart-cursor-tag" x={dateX - 43} y="2" width="86" height="19" rx="2" />
          <text className="chart-cursor-label chart-cursor-date" x={dateX} y="15" textAnchor="middle">{date}</text>
        </g>}
        <text className="chart-axis-title chart-x-axis-title" x={(CHART.left + CHART.width - CHART.right) / 2} y="36" textAnchor="middle">{translate(locale, "chart.dateAxis")}</text>
      </svg>
    </div>
  );
}

function samplesForSeries(
  seriesId: ChartSeriesId,
  assets: DailyAsset[],
  signals: SignalEvaluation[],
  vixSymbol?: string,
): SeriesSample[] {
  if (seriesId === "vix") {
    const valueByDate = new Map<string, number>();
    for (const signal of signals) {
      if (!isVolatilityObservation(signal, vixSymbol)) continue;
      const value = numericValue(signal.observedValue);
      if (value !== null) valueByDate.set(signal.date, value);
    }
    return assets.flatMap((asset, index) => {
      const value = valueByDate.get(asset.date);
      return value === undefined ? [] : [{ date: asset.date, index, value }];
    });
  }

  return assets.flatMap((asset, index) => {
    const rawValue = seriesId === "price"
      ? asset.simulationPrice
      : seriesId === "totalAsset"
        ? asset.totalAsset
        : asset.drawdown;
    const value = numericValue(rawValue);
    if (value === null) return [];
    const contributed = seriesId === "totalAsset" ? numericValue(asset.totalContributed) : null;
    return [{
      date: asset.date,
      index,
      value,
      ...(contributed === null ? {} : { contributed }),
    }];
  });
}

function seriesLabel(locale: Locale, series: SeriesDefinition | IndicatorSeriesDefinition, currency?: string): string {
  const units = series.id === "totalAsset" || series.id === "price"
    ? currency
    : series.id === "drawdown"
      ? "%"
      : null;
  return `${series.label ?? translate(locale, series.labelKey)}${units ? ` (${units})` : ""}`;
}

function useSeriesHighlight(visibleIds: ReadonlySet<string>) {
  const [state, setState] = useState({ hoveredId: null as string | null, focusedId: null as string | null, selectedId: null as string | null });
  const visible = (id: string | null) => id && visibleIds.has(id) ? id : null;
  const hoveredId = visible(state.hoveredId);
  const focusedId = visible(state.focusedId);
  const selectedId = visible(state.selectedId);
  useEffect(() => {
    setState(previous => previous.hoveredId === hoveredId && previous.focusedId === focusedId && previous.selectedId === selectedId
      ? previous : { hoveredId, focusedId, selectedId });
  }, [hoveredId, focusedId, selectedId]);
  function inspect(id: string | null, source: keyof typeof state, pointer = false) {
    setState(previous => source === "selectedId"
      ? { ...previous, selectedId: previous.selectedId === id ? null : id, focusedId: pointer ? null : previous.focusedId }
      : { ...previous, [source]: id });
  }
  return { highlightedId: hoveredId ?? focusedId ?? selectedId, selectedId, inspect };
}

function SeriesLegend({
  locale, entries, highlight,
}: {
  locale: Locale;
  entries: Array<{ id: string; label: string; color: string; seriesId?: string; resultId?: string }>;
  highlight: ReturnType<typeof useSeriesHighlight>;
}) {
  return (
    <div className="overlay-legend" role="group" aria-label={translate(locale, "chart.legend")}>
      {entries.map((definition) => (
        <button
          type="button"
          className={`overlay-legend-item${highlight.highlightedId === definition.id ? " is-highlighted" : ""}${highlight.selectedId === definition.id ? " is-selected" : ""}`}
          aria-pressed={highlight.selectedId === definition.id}
          style={{ "--series-color": definition.color } as CSSProperties}
          key={definition.id}
          data-series={definition.seriesId ?? definition.id}
          data-result-id={definition.resultId}
          onMouseEnter={() => highlight.inspect(definition.id, "hoveredId")}
          onMouseLeave={() => highlight.inspect(null, "hoveredId")}
          onFocus={() => highlight.inspect(definition.id, "focusedId")}
          onBlur={() => highlight.inspect(null, "focusedId")}
          onClick={event => highlight.inspect(definition.id, "selectedId", event.detail > 0)}
        >
          <i className="overlay-legend-swatch" style={{ backgroundColor: definition.color }} aria-hidden="true" />
          {definition.label}
          <span className="overlay-legend-selection" aria-hidden="true">{highlight.selectedId === definition.id ? "✓" : ""}</span>
        </button>
      ))}
    </div>
  );
}

function HighlightArea({ points, color, gradientId, bottom = CHART.height - CHART.bottom }: {
  points: Array<{ x: number; y: number }>;
  color: string;
  gradientId: string;
  bottom?: number;
}) {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) return null;
  const path = `M ${first.x},${bottom} L ${points.map((point) => `${point.x},${point.y}`).join(" L ")} L ${last.x},${bottom} Z`;
  return (
    <g aria-hidden="true" className="chart-highlight-fill">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="chart-highlight-area" d={path} fill={`url(#${gradientId})`} />
    </g>
  );
}

function lineCoordinates(
  points: SeriesSample[],
  scale: ChartScale,
  count: number,
  viewport: ChartViewport,
): ChartPoint[] {
  return points.map((point) => ({
    ...point,
    x: xPosition(point.index, count, viewport),
    y: scale.y(point.value),
  }));
}

function IndicatorChart({
  locale,
  assets,
  series,
  samples,
  symbol,
  thresholdValue,
  hasBuySignalObservations,
  viewport,
  chartInteractionProps,
  cursor,
  comparisons = [],
}: {
  locale: Locale;
  assets: DailyAsset[];
  series: IndicatorSeriesDefinition;
  samples: SeriesSample[];
  symbol?: string;
  thresholdValue: number | null;
  hasBuySignalObservations: boolean;
  viewport: ChartViewport;
  chartInteractionProps: ChartInteractionProps;
  cursor: ChartCursor | null;
  comparisons?: IndicatorComparison[];
}) {
  const geometry = COMPACT_CHART;
  if (samples.length === 0) return null;
  const range = visibleIndexRange(assets.length, viewport);
  const visibleSamples = samples.filter((point) => point.index >= range.start && point.index <= range.end);
  const chartSamples = samplesInViewport(samples, viewport, assets.length);
  const currency = assets[0]?.currency;
  const visibleThreshold = series.id === "vix" && hasBuySignalObservations ? thresholdValue : null;
  const values = chartSamples.map((point) => point.value);
  for (const comparison of comparisons) for (const point of samplesInViewport(comparison.samples, viewport, assets.length)) {
    values.push(point.value);
  }
  if (visibleThreshold !== null) values.push(visibleThreshold);
  const scale = chartScale(values, {
    maximumAtZero: series.id === "drawdown",
    fixedBounds: series.id === "rsi" ? [0, 100] : undefined,
  }, geometry);
  const points = lineCoordinates(chartSamples, scale, assets.length, viewport);
  const titleId = `chart-title-${series.id}`;
  const descriptionId = `chart-description-${series.id}`;
  const figureClass = `chart-panel chart-${series.id} is-compact`;
  const lastPoint = visibleSamples.at(-1);
  const lineLabel = lastPoint
    ? `${seriesLabel(locale, series, currency)} · ${lastPoint.date} · ${formatAxisValue(lastPoint.value, locale, series.id, currency)}`
    : `${seriesLabel(locale, series, currency)} · ${translate(locale, "chart.noSeriesInWindow")}`;
  const thresholdY = visibleThreshold === null ? null : scale.y(visibleThreshold);
  const plotHeight = geometry.height - geometry.top - geometry.bottom;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotClipId = `chart-plot-${series.id}`;
  const cursorDate = cursor ? assets[cursor.index]?.date : undefined;
  const cursorPoint = samples.find((point) => point.index === cursor?.index);
  const cursorY = cursor?.chartId === series.id ? geometry.top + cursor.yRatio * plotHeight : undefined;
  const cursorValue = cursor ? scale.maximum - cursor.yRatio * (scale.maximum - scale.minimum) : null;
  return (
    <figure className={figureClass} data-window-start={viewport.start} data-window-end={viewport.end}>
      <div className="chart-canvas">
        <svg
          {...chartInteractionProps}
          className="result-chart"
          viewBox={`0 0 ${CHART.width} ${geometry.height}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          aria-label={translate(locale, "chart.interactionHelp")}
          tabIndex={0}
          data-chart-id={series.id}
          data-plot-top={geometry.top}
          data-plot-bottom={geometry.height - geometry.bottom}
        >
          <title id={titleId}>{`${symbol ? `${symbol} · ` : ""}${axisTitle(locale, series.id)}`}</title>
          <desc id={descriptionId}>{translate(locale, "chart.description", {
            start: assets[Math.round(range.start)]?.date ?? "",
            end: assets[Math.round(range.end)]?.date ?? "",
            count: String(Math.max(1, Math.round(range.end) - Math.round(range.start) + 1)),
          })}</desc>
          <ChartAxes dates={assets.map((asset) => asset.date)} locale={locale} scale={scale} seriesId={series.id} currency={currency} viewport={viewport} geometry={geometry} />
          <defs>
            <clipPath id={plotClipId}>
              <rect x={CHART.left} y={geometry.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${plotClipId})`}>
            {comparisons.flatMap(comparison => {
              const line = lineCoordinates(samplesInViewport(comparison.samples, viewport, assets.length), scale, assets.length, viewport);
              return chartSegments(line).filter(segment => segment.length > 1).map((segment, index) => <polyline key={`${comparison.label}-${index}`} className="chart-series-line"
                points={segment.map(point => `${point.x},${point.y}`).join(" ")} fill="none" stroke={comparison.color}
                strokeWidth={1.2} vectorEffect="non-scaling-stroke" aria-label={comparison.label}><title>{comparison.label}</title></polyline>);
            })}
            {thresholdY !== null && (
              <line className="chart-threshold-line" x1={CHART.left} y1={thresholdY} x2={CHART.width - CHART.right} y2={thresholdY}>
                <title>{translate(locale, "chart.threshold", { threshold: String(visibleThreshold) })}</title>
              </line>
            )}
            {points.length > 1 ? (
              chartSegments(points).filter(segment => segment.length > 1).map((segment, index) => <polyline
                key={index}
                className={`chart-series-line${series.id === "vix" ? " chart-vix-line" : ""}`}
                points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
                fill="none"
                stroke={series.color}
                strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                tabIndex={0}
                aria-label={lineLabel}
              >
                <title>{lineLabel}</title>
              </polyline>)
            ) : points.length === 1 && series.id !== "vix" ? (
              <circle className="chart-series-point" cx={points[0]?.x} cy={points[0]?.y} r="3" tabIndex={0} aria-label={lineLabel}>
                <title>{lineLabel}</title>
              </circle>
            ) : null}
          </g>
          {cursor && <ChartCrosshair date={cursorDate} x={xPosition(cursor.index, assets.length, viewport)} y={cursorY}
            valueLabel={cursorValue === null ? undefined : formatAxisValue(cursorValue, locale, series.id)} geometry={geometry}
            points={cursorPoint ? [{ y: scale.y(cursorPoint.value), color: series.color }] : []} />}
        </svg>
      </div>
    </figure>
  );
}

function OverlayChart({
  locale,
  assets,
  trades,
  series,
  indicatorSeries,
  samplesById,
  normalizedById,
  comparisonSeries,
  strategyOrder,
  currency,
  viewport,
  chartInteractionProps,
  cursor,
  volatilityComparisons,
  technicalLines,
}: {
  locale: Locale;
  assets: DailyAsset[];
  trades: Trade[];
  series: SeriesDefinition[];
  indicatorSeries: Array<SeriesDefinition & { id: "drawdown" | "vix" }>;
  samplesById: Map<ChartSeriesId, SeriesSample[]>;
  normalizedById: Map<ChartSeriesId, NormalizedSeries | null>;
  comparisonSeries: StrategyChartSeries[];
  strategyOrder: string[];
  currency?: string;
  viewport: ChartViewport;
  chartInteractionProps: ChartInteractionProps;
  cursor: ChartCursor | null;
  volatilityComparisons: IndicatorComparison[];
  technicalLines: TechnicalChartLine[];
}) {
  const geometry = MAIN_WITHOUT_DATES;
  const gradientId = `chart-gradient-${useId()}`;
  const normalized = series.flatMap((definition) => {
    const result = normalizedById.get(definition.id);
    return result ? [{ definition, result }] : [];
  });
  const focusedDateIndexes = new Map(assets.map((asset, index) => [asset.date, index]));
  const comparisonNormalized = comparisonSeries.flatMap((comparison) => {
    const result = normalizeSeriesToBase100(
      "totalAsset",
      samplesForSeries("totalAsset", comparison.dailyAssets, []),
    );
    if (!result) return [];
    const points = result.points.flatMap((point) => {
      const index = focusedDateIndexes.get(point.date);
      return index === undefined ? [] : [{ ...point, index }];
    });
    return points.length > 0 ? [{ ...comparison, result: { ...result, points } }] : [];
  });
  const priceBaseline = normalizedById.get("price")?.baseValue;
  const technicalNormalized = technicalLines.filter(line => line.kind !== "rsi").map(line => ({ ...line,
    points: line.samples.flatMap(point => {
      const value = normalizeValueToBase100("price", point.value, priceBaseline ?? 0);
      return value === null ? [] : [{ ...point, indexValue: value }];
    }),
  }));
  const visibleIdentities = new Set([...normalized.map(({ definition }) => seriesIdentity(definition)), ...comparisonNormalized.map(comparison => comparison.id), ...technicalNormalized.map(line => line.id)]);
  const highlight = useSeriesHighlight(visibleIdentities);
  const highlightedId = highlight.highlightedId;
  if (normalized.length === 0 && comparisonNormalized.length === 0) {
    return <p className="chart-empty">{translate(locale, "chart.noOverlaySeries")}</p>;
  }

  const dateCount = assets.length;
  const range = visibleIndexRange(dateCount, viewport);
  const visibleNormalized = normalized.map(({ definition, result }) => ({
    definition,
    result,
    chartPoints: samplesInViewport(result.points, viewport, dateCount),
    visiblePoints: result.points.filter((point) => point.index >= range.start && point.index <= range.end),
  }));
  const values = [
    100,
    ...visibleNormalized.flatMap(({ chartPoints }) => chartPoints.map((point) => point.indexValue)),
    ...comparisonNormalized.flatMap(({ result }) => samplesInViewport(result.points, viewport, dateCount).map((point) => point.indexValue)),
    ...technicalNormalized.flatMap(line => samplesInViewport(line.points, viewport, dateCount).map(point => point.indexValue)),
  ];
  const scale = chartScale(values, {}, geometry);
  const titleId = "chart-title-overlay";
  const descriptionId = "chart-description-overlay";
  const primaryAsset = normalized.find(({ definition }) => definition.id === "totalAsset");
  const tradeSeries = [
    ...(primaryAsset ? [{ id: seriesIdentity(primaryAsset.definition), label: primaryAsset.definition.label ?? translate(locale, primaryAsset.definition.labelKey),
      color: primaryAsset.definition.color, result: primaryAsset.result, trades, dailyAssets: assets }] : []),
    ...comparisonNormalized.map(comparison => ({ ...comparison, trades: comparison.trades ?? [] })),
  ];
  const startDate = assets[Math.round(range.start)]?.date ?? "";
  const endDate = assets[Math.round(range.end)]?.date ?? "";
  const plotHeight = geometry.height - geometry.top - geometry.bottom;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotClipId = "chart-plot-overlay";
  const cursorDate = cursor ? assets[cursor.index]?.date : undefined;
  const readingIndex = cursor?.index ?? Math.floor(range.end);
  const readingDate = assets[readingIndex]?.date;
  const cursorY = cursor?.chartId === "overlay" ? CHART.top + cursor.yRatio * plotHeight : undefined;
  const cursorValue = cursor ? scale.maximum - cursor.yRatio * (scale.maximum - scale.minimum) : null;
  const cursorPoints = normalized.flatMap(({ definition, result }) => {
    const point = result.points.find((sample) => sample.index === cursor?.index);
    return point ? [{ y: scale.y(point.indexValue), color: definition.color }] : [];
  });
  const comparisonCursorPoints = comparisonNormalized.flatMap(({ color, result }) => {
    const point = result.points.find((sample) => sample.index === cursor?.index);
    return point ? [{ y: scale.y(point.indexValue), color }] : [];
  });
  const technicalCursorPoints = technicalNormalized.flatMap(line => {
    const point = line.points.find(sample => sample.index === cursor?.index);
    return point ? [{ y: scale.y(point.indexValue), color: line.color }] : [];
  });
  const readings: CursorReading[] = normalized.filter(({ definition }) => definition.id === "price").map(({ definition, result }) => {
    const point = result.points.find((sample) => sample.index === readingIndex);
    const rawPoint = samplesById.get(definition.id)?.find((sample) => sample.index === readingIndex);
    return {
      label: definition.label ?? translate(locale, definition.labelKey),
      value: `${preciseValue(rawPoint?.value, locale, currency)} · ${translate(locale, "chart.relativeIndexValue", { value: point?.indexValue.toFixed(1) ?? "—" })}`,
      color: definition.color,
    };
  });
  for (const definition of indicatorSeries) {
    const point = samplesById.get(definition.id)?.find((sample) => sample.index === readingIndex);
    readings.push({ label: definition.label ?? translate(locale, definition.labelKey), value: point ? formatAxisValue(point.value, locale, definition.id) : "—", color: definition.color });
  }
  for (const comparison of volatilityComparisons) {
    const point = comparison.samples.find(sample => sample.index === readingIndex);
    readings.push({ label: comparison.label, value: point ? formatAxisValue(point.value, locale, "vix") : "—", color: comparison.color });
  }
  for (const line of technicalLines) {
    const point = line.samples.find(sample => sample.index === readingIndex);
    readings.push({ label: line.label, value: preciseValue(point?.value, locale, line.kind === "rsi" ? undefined : currency), color: line.color });
  }
  const ranks = new Map(strategyOrder.map((id, index) => [id, index + 1]));
  const strategyReadings = tradeSeries.map(strategy => {
    const point = strategy.result.points.find(sample => sample.index === readingIndex);
    const asset = strategy.dailyAssets.find(asset => asset.date === readingDate);
    return {
      id: strategy.id, label: strategy.label, color: strategy.color, rank: ranks.get(strategy.id),
      readings: [
        { label: translate(locale, "chart.asset"), value: preciseValue(numericValue(asset?.totalAsset), locale, currency) },
        { label: translate(locale, "chart.principal"), value: preciseValue(numericValue(asset?.totalContributed), locale, currency) },
        { label: translate(locale, "chart.principalIndex"), value: point?.indexValue.toFixed(1) ?? "—" },
      ],
    };
  }).sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity));
  return (
    <figure className="chart-panel chart-overlay" data-window-start={viewport.start} data-window-end={viewport.end}>
      <figcaption className="core-chart-heading">
        <span>{translate(locale, "chart.overlayTitle")}</span>
        <SeriesLegend locale={locale} entries={[
          ...normalized.map(({ definition }) => ({ ...definition, id: seriesIdentity(definition), seriesId: definition.id,
            label: definition.label ?? axisTitle(locale, definition.id, currency) })),
          ...comparisonNormalized.map(comparison => ({ ...comparison, resultId: comparison.id })),
          ...technicalNormalized,
        ]} highlight={highlight} />
      </figcaption>
      <p className="chart-overlay-description sr-only">{translate(locale, "chart.overlayDescription")}</p>
      <div className="chart-core-readout-row" tabIndex={0} role="group" aria-label={translate(locale, "chart.savedReadings")}
        style={{ "--chart-readout-lines": Math.min(strategyReadings.length, 4) } as CSSProperties}>
        <ChartReadout date={readingDate} readings={readings} strategies={strategyReadings} />
      </div>
      <div className="chart-canvas">
        <svg
          {...chartInteractionProps}
          className="result-chart"
          viewBox={`0 0 ${CHART.width} ${geometry.height}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          aria-label={translate(locale, "chart.interactionHelp")}
          tabIndex={0}
          data-chart-id="overlay"
          data-plot-top={geometry.top}
          data-plot-bottom={geometry.height - geometry.bottom}
        >
          <title id={titleId}>{translate(locale, "chart.overlayTitle")}</title>
          <desc id={descriptionId}>{translate(locale, "chart.description", {
            start: startDate,
            end: endDate,
            count: String(Math.max(1, Math.round(range.end) - Math.round(range.start) + 1)),
          })}</desc>
          <ChartAxes dates={assets.map((asset) => asset.date)} locale={locale} scale={scale} seriesId="index" viewport={viewport} geometry={geometry} />
          <defs>
            <clipPath id={plotClipId}>
              <rect x={CHART.left} y={CHART.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${plotClipId})`}>
            {visibleNormalized.filter(({ definition }) => seriesIdentity(definition) === highlightedId).map(({ definition, chartPoints }) => (
              <HighlightArea
                key={definition.id}
                points={chartPoints.map((point) => ({ x: xPosition(point.index, dateCount, viewport), y: scale.y(point.indexValue) }))}
                color={definition.color}
                gradientId={gradientId}
              />
            ))}
            {comparisonNormalized.filter(comparison => comparison.id === highlightedId).map(comparison => (
              <HighlightArea key={comparison.id}
                points={samplesInViewport(comparison.result.points, viewport, dateCount).map(point => ({ x: xPosition(point.index, dateCount, viewport), y: scale.y(point.indexValue) }))}
                color={comparison.color} gradientId={gradientId} />
            ))}
            {technicalNormalized.filter(line => line.id === highlightedId).flatMap(line => chartSegments(samplesInViewport(line.points, viewport, dateCount)).map((segment, index) => (
              <HighlightArea key={`${line.id}-${index}`} points={segment.map(point => ({ x: xPosition(point.index, dateCount, viewport), y: scale.y(point.indexValue) }))}
                color={line.color} gradientId={`${gradientId}-${index}`} />
            )))}
            <line
              className="chart-baseline-line"
              data-baseline="100"
              x1={CHART.left}
              y1={scale.y(100)}
              x2={CHART.width - CHART.right}
              y2={scale.y(100)}
            />
            <text
              className="chart-baseline-label"
              x={CHART.width - CHART.right - 4}
              y={scale.y(100) - 5}
              textAnchor="end"
            >
              {translate(locale, "chart.baseReference")}
            </text>
            {[...visibleNormalized].sort((left, right) => Number(seriesIdentity(left.definition) === highlightedId) - Number(seriesIdentity(right.definition) === highlightedId)).map(({ definition, chartPoints, visiblePoints }) => {
              const points = chartPoints.map((point) => ({
              ...point,
              x: xPosition(point.index, dateCount, viewport),
              y: scale.y(point.indexValue),
            }));
            const lastPoint = visiblePoints.at(-1);
            const lastTitle = lastPoint
              ? `${seriesLabel(locale, definition, currency)} · ${lastPoint.date} · ${formatAxisValue(lastPoint.value, locale, definition.id, currency)} · ${translate(locale, "chart.relativeIndexValue", { value: lastPoint.indexValue.toFixed(1) })}`
              : `${seriesLabel(locale, definition, currency)} · ${translate(locale, "chart.noSeriesInWindow")}`;
            return (
              <g className={`overlay-series overlay-${definition.id}`} key={definition.id}>
                {points.length > 1 ? (
                  <polyline className={`overlay-series-line overlay-${definition.id}${highlightedId === seriesIdentity(definition) ? " is-highlighted" : ""}`} points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={definition.color} strokeWidth={highlightedId === seriesIdentity(definition) ? 2.4 : 1.2} vectorEffect="non-scaling-stroke" tabIndex={0} aria-label={lastTitle}>
                    <title>{lastTitle}</title>
                  </polyline>
                ) : (
                  points.length === 1 && <circle className="overlay-single-point" cx={points[0]?.x} cy={points[0]?.y} r="3" fill={definition.color} tabIndex={0} aria-label={lastTitle}>
                    <title>{lastTitle}</title>
                  </circle>
                )}
              </g>
            );
            })}
            {[...comparisonNormalized].sort((left, right) => Number(left.id === highlightedId) - Number(right.id === highlightedId)).map((comparison) => {
              const chartPoints = samplesInViewport(comparison.result.points, viewport, dateCount);
              const points = chartPoints.map((point) => ({
                ...point,
                x: xPosition(point.index, dateCount, viewport),
                y: scale.y(point.indexValue),
              }));
              const lastPoint = points.at(-1);
              return (
                <g className="comparison-overlay-series" data-result-id={comparison.id} key={comparison.id}>
                  {points.length > 1 && (
                    <polyline
                      className={`comparison-overlay-series-line${highlightedId === comparison.id ? " is-highlighted" : ""}`}
                      points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                      fill="none"
                      stroke={comparison.color}
                      strokeWidth={highlightedId === comparison.id ? 2.4 : 1.2}
                      vectorEffect="non-scaling-stroke"
                      aria-label={comparison.label}
                    >
                      <title>{lastPoint ? `${comparison.label} · ${lastPoint.date} · ${lastPoint.indexValue.toFixed(1)}` : comparison.label}</title>
                    </polyline>
                  )}
                </g>
              );
            })}
            {technicalNormalized.flatMap(line => chartSegments(samplesInViewport(line.points, viewport, dateCount)).filter(segment => segment.length > 1).map((segment, index) => (
              <polyline key={`${line.id}-${index}`} className="chart-technical-line" data-kind={line.kind} data-baseline={priceBaseline}
                points={segment.map(point => `${xPosition(point.index, dateCount, viewport)},${scale.y(point.indexValue)}`).join(" ")}
                fill="none" stroke={line.color} strokeDasharray={line.dashed ? "5 3" : undefined}
                strokeWidth={highlightedId === line.id ? 2.4 : 1.1} vectorEffect="non-scaling-stroke" aria-label={line.label}>
                <title>{line.label}</title>
              </polyline>
            )))}
          </g>
          {/* Keep edge triangles complete while limiting their anchors to the visible window. */}
          {tradeSeries.filter(strategy => strategy.id === highlightedId).flatMap(strategy => {
            const points = strategy.result.points.filter(point => point.index >= range.start && point.index <= range.end)
              .map(point => ({ date: point.date, x: xPosition(point.index, dateCount, viewport), y: scale.y(point.indexValue) }));
            return tradeMarkerPoints(strategy.trades, points).map(({ trade, index, price, coordinates }) => (
              <polygon className={`chart-trade-marker chart-trade-marker-${trade.side}`} data-anchor-series="totalAsset" data-result-id={strategy.id}
                color={strategy.color} points={coordinates} vectorEffect="non-scaling-stroke" key={`${strategy.id}-${trade.date}-${trade.side}-${index}`}>
                <title>{`${strategy.label} · ${trade.date} ${translate(locale, `trade.side.${trade.side}`)} ${formatAxisValue(price, locale, "price", trade.currency ?? currency)}`}</title>
              </polygon>
            ));
          })}
          {cursor && <ChartCrosshair date={cursorDate} x={xPosition(cursor.index, dateCount, viewport)} y={cursorY}
            valueLabel={cursorValue === null ? undefined : formatAxisValue(cursorValue, locale, "index")} geometry={geometry} points={[...cursorPoints, ...comparisonCursorPoints, ...technicalCursorPoints]} />}
        </svg>
      </div>
    </figure>
  );
}

export function ResultsCharts({
  busy = false,
  locale,
  dailyAssets,
  trades,
  signals = [],
  comparisonSeries = [],
  strategyOrder = [],
  totalAssetColor,
  totalAssetLabel,
  totalAssetResultId,
  volatilitySeries = [],
  technicalIndicators = [],
  showFocusedAsset = true,
  vixSymbol,
  vixThreshold,
  visibleSeriesIds,
  onSeriesChange,
}: ResultsChartsProps) {
  const [hiddenTechnicalKinds, setHiddenTechnicalKinds] = useState<string[]>([]);
  const { viewport, cursor, wheelZoomEnabled, chartContainerRef, chartInteractionProps, zoomAt, resetRange, toggleWheelZoom } = useChartInteraction(dailyAssets.length, CHART, busy);
  const rootElement = useRef<HTMLDivElement | null>(null);
  const containerRef = useCallback((element: HTMLDivElement | null) => {
    chartContainerRef(element);
    rootElement.current = element;
  }, [chartContainerRef]);
  const volatilityComparisons = volatilitySeries.slice(1).map((source, index) => ({
    label: source.symbol.replace(/^\^/, ""), color: ["#b06a16", "#385cbe"][index % 2],
    samples: samplesForSeries("vix", dailyAssets, source.signals, source.symbol),
  }));
  const samplesById = useMemo(
    () => new Map(SERIES.map(({ id }) => [id, samplesForSeries(id, dailyAssets, signals, vixSymbol)])),
    [dailyAssets, signals, vixSymbol],
  );
  const normalizedById = useMemo(() => new Map<ChartSeriesId, NormalizedSeries | null>(
    SERIES.filter(({ id }) => id === "price" || id === "totalAsset").map(({ id }) => [id,
      normalizeSeriesToBase100(id, samplesById.get(id) ?? []),
    ]),
  ), [samplesById]);
  const available = useMemo(
    () => SERIES.filter((series) => series.id === "totalAsset"
      ? (showFocusedAsset && normalizedById.get(series.id) !== null) || comparisonSeries.some(comparison =>
        normalizeSeriesToBase100("totalAsset", samplesForSeries("totalAsset", comparison.dailyAssets, [])) !== null)
      : series.id === "price"
        ? normalizedById.get(series.id) !== null
      : (samplesById.get(series.id)?.length ?? 0) > 0),
    [samplesById, normalizedById, showFocusedAsset, comparisonSeries],
  );
  const hasVisibleCore = available.some(series =>
    (series.id === "price" || series.id === "totalAsset") && visibleSeriesIds.includes(series.id));
  const selected = useMemo(
    () => available.filter((series) => visibleSeriesIds.includes(series.id) || (!hasVisibleCore && series.id === "price")),
    [available, visibleSeriesIds, hasVisibleCore],
  );
  const coreSeries = selected.filter(
    (series) => series.id === "price" || (series.id === "totalAsset" && showFocusedAsset),
  ).map((series) => series.id === "totalAsset"
    ? { ...series, color: totalAssetColor ?? series.color, label: totalAssetLabel, resultId: totalAssetResultId }
    : series);
  const indicatorSeries = selected.filter(
    (series): series is SeriesDefinition & { id: "drawdown" | "vix" } => series.id === "drawdown" || series.id === "vix",
  ).map(series => series.id === "vix" ? { ...series, label: (vixSymbol ?? "^VIX").replace(/^\^/, "") } : series);
  const savedLines = useMemo(() => technicalChartLines(technicalIndicators, dailyAssets, locale), [technicalIndicators, dailyAssets, locale]);
  const technicalKinds = [...new Set(savedLines.map(line => line.kind))];
  const priceVisible = coreSeries.some(series => series.id === "price");
  const technicalLines = savedLines.filter(line => !hiddenTechnicalKinds.includes(line.kind) && (line.kind === "rsi" || priceVisible));
  const rsiLines = technicalLines.filter(line => line.kind === "rsi");
  useEffect(() => {
    const element = rootElement.current;
    const svg = element?.querySelector("svg.result-chart");
    if (!element || !svg) return;
    const updateScale = (width: number) => {
      if (width > 0) element.style.setProperty("--chart-text-scale", String(CHART.width / width));
    };
    updateScale(svg.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => updateScale(entries[0]?.contentRect.width ?? 0));
    observer.observe(svg);
    return () => observer.disconnect();
  }, [dailyAssets.length, selected.length]);
  const currency = dailyAssets[0]?.currency;
  const thresholdValue = numericValue(vixThreshold);
  const hasBuySignalObservations = signals.some((signal) =>
    (signal.signalId === "vix.buy" || signal.signalId.startsWith("vix.buy:"))
      && isVolatilityObservation(signal, vixSymbol) && numericValue(signal.observedValue) !== null,
  );
  const range = visibleIndexRange(dailyAssets.length, viewport);
  const visibleStartDate = dailyAssets[Math.round(range.start)]?.date ?? "—";
  const visibleEndDate = dailyAssets[Math.round(range.end)]?.date ?? "—";
  const viewportSpan = viewport.end - viewport.start;
  const visibleComparisons = selected.some(series => series.id === "totalAsset") ? comparisonSeries : [];
  return (
    <div className={`charts-content${wheelZoomEnabled ? " is-wheel-zoom-active" : ""}`} ref={containerRef}>
      <div className="chart-toolbar">
        <div className="chart-controls">
          <div className="chart-legend" role="group" aria-label={translate(locale, "chart.legend")}>
            {SERIES.map((series) => {
              const isAvailable = available.includes(series);
              const isVisible = selected.includes(series) && isAvailable;
              const isLastCore = isVisible && (series.id === "price" || series.id === "totalAsset")
                && selected.filter(item => item.id === "price" || item.id === "totalAsset").length === 1;
              const alternativeCore = available.find(item => item.id !== series.id && (item.id === "price" || item.id === "totalAsset"));
              const cannotHide = isLastCore && !alternativeCore;
              return (
                <button
                  className={`legend-toggle${isVisible ? " is-visible" : ""}`}
                  type="button"
                  key={series.id}
                  data-series={series.id}
                  aria-pressed={isVisible}
                  disabled={busy || !isAvailable || cannotHide}
                  title={cannotHide ? translate(locale, "chart.keepCoreSeries") : undefined}
                  onClick={() => {
                    if (isLastCore && alternativeCore) onSeriesChange(alternativeCore.id, true);
                    onSeriesChange(series.id, !isVisible);
                  }}
                >
                  <span className="legend-swatch" style={{ backgroundColor: series.color }} aria-hidden="true" />
                  <span className="legend-check" aria-hidden="true">{isVisible ? "✓" : "−"}</span>
                  {seriesLabel(locale, series, currency)}
                </button>
              );
            })}
            {technicalKinds.map(kind => {
              const visible = !hiddenTechnicalKinds.includes(kind) && (kind === "rsi" || priceVisible);
              const label = kind === "bollinger" ? "BOLL" : kind.toUpperCase();
              return <button className={`legend-toggle${visible ? " is-visible" : ""}`} type="button" key={kind}
                data-series={kind} aria-pressed={visible} disabled={busy}
                onClick={() => {
                  if (!visible && kind !== "rsi" && !priceVisible) onSeriesChange("price", true);
                  setHiddenTechnicalKinds(current => visible ? [...current, kind] : current.filter(item => item !== kind));
                }}>
                <span className="legend-swatch" style={{ backgroundColor: savedLines.find(line => line.kind === kind)?.color }} aria-hidden="true" />
                <span className="legend-check" aria-hidden="true">{visible ? "✓" : "−"}</span>{label}
              </button>;
            })}
          </div>
        </div>
        <div className="chart-range-controls" role="group" aria-label={translate(locale, "chart.rangeControls")}>
          {wheelZoomEnabled && (
            <span className="chart-wheel-zoom-status" role="status">
              {translate(locale, "chart.wheelZoomActive")}
            </span>
          )}
          <span className="chart-range-label sr-only">
            {translate(locale, "chart.visibleRange", { start: visibleStartDate, end: visibleEndDate })}
          </span>
          <button
            className="icon-only-button chart-wheel-zoom-toggle"
            type="button"
            aria-label={translate(locale, wheelZoomEnabled ? "chart.disableWheelZoom" : "chart.enableWheelZoom")}
            title={translate(locale, wheelZoomEnabled ? "chart.disableWheelZoom" : "chart.enableWheelZoom")}
            aria-pressed={wheelZoomEnabled}
            onClick={toggleWheelZoom}
          >
            <span aria-hidden="true">
              <svg viewBox="0 0 20 20" focusable="false">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="m13 13 4 4" />
              </svg>
            </span>
          </button>
          <button type="button" aria-label={translate(locale, "chart.zoomOut")} title={translate(locale, "chart.zoomOut")} disabled={viewportSpan >= 1} onClick={() => zoomAt(1.25)}>
            <span aria-hidden="true">−</span>
          </button>
          <button type="button" aria-label={translate(locale, "chart.zoomIn")} title={translate(locale, "chart.zoomIn")} disabled={viewportSpan <= MIN_CHART_VIEWPORT_SPAN + 1e-6} onClick={() => zoomAt(0.8)}>
            <span aria-hidden="true">+</span>
          </button>
          <button className="icon-only-button chart-range-reset" type="button" aria-label={translate(locale, "chart.resetRange")} title={translate(locale, "chart.resetRange")} disabled={viewportSpan >= 1} onClick={resetRange}>
            <span aria-hidden="true">↺</span>
          </button>
        </div>
      </div>
      {(samplesById.get("totalAsset")?.length ?? 0) > 0 && normalizedById.get("totalAsset") === null && (
        <p className="chart-data-note" role="status">{translate(locale, "chart.contributionValueUnavailable")}</p>
      )}
      {selected.length === 0 ? (
        <p className="chart-empty">{translate(locale, "chart.noVisibleSeries")}</p>
      ) : (
        <div className="chart-linked-stack">
          {(coreSeries.length > 0 || visibleComparisons.length > 0) && (
            <OverlayChart
              locale={locale}
              assets={dailyAssets}
              trades={trades}
              series={coreSeries}
              indicatorSeries={indicatorSeries}
              samplesById={samplesById}
              normalizedById={normalizedById}
              comparisonSeries={visibleComparisons}
              strategyOrder={strategyOrder}
              currency={currency}
              viewport={viewport}
              chartInteractionProps={chartInteractionProps}
              cursor={cursor}
              volatilityComparisons={indicatorSeries.some(series => series.id === "vix") ? volatilityComparisons : []}
              technicalLines={technicalLines}
            />
          )}
          {indicatorSeries.map((series) => (
            <IndicatorChart
              key={series.id}
              locale={locale}
              assets={dailyAssets}
              series={series}
              samples={samplesById.get(series.id) ?? []}
              symbol={series.id === "vix" ? vixSymbol : undefined}
              thresholdValue={thresholdValue}
              hasBuySignalObservations={hasBuySignalObservations}
              viewport={viewport}
              chartInteractionProps={chartInteractionProps}
              cursor={cursor}
              comparisons={series.id === "vix" ? volatilityComparisons : []}
            />
          ))}
          {rsiLines[0] && <IndicatorChart locale={locale} assets={dailyAssets}
            series={{ id: "rsi", color: rsiLines[0].color, labelKey: "chart.rsiAxis", label: rsiLines[0].label }}
            samples={rsiLines[0].samples} comparisons={rsiLines.slice(1)} thresholdValue={null} hasBuySignalObservations={false}
            viewport={viewport} chartInteractionProps={chartInteractionProps} cursor={cursor} />}
          <ChartDateAxis dates={dailyAssets.map((asset) => asset.date)} locale={locale} viewport={viewport} cursor={cursor} />
        </div>
      )}
    </div>
  );
}
