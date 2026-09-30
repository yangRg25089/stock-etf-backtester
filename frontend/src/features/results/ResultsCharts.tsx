import { useId, useMemo, useState } from "react";
import type { DailyAsset, SignalEvaluation, Trade } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import { ChartCrosshair, ChartReadout, type ChartCursor, type CursorReading } from "./ChartCrosshair";
import { useChartInteraction, type ChartInteractionProps } from "./useChartInteraction";
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

type AxisSeriesId = ChartSeriesId | "index";

interface ResultsChartsProps {
  locale: Locale;
  dailyAssets: DailyAsset[];
  trades: Trade[];
  signals: SignalEvaluation[];
  vixSymbol?: string;
  vixThreshold?: string;
  visibleSeriesIds: string[];
  overlayMode?: boolean;
  onSeriesChange(id: string, visible: boolean): void;
  onOverlayModeChange?(value: boolean): void;
}

interface SeriesDefinition {
  id: ChartSeriesId;
  color: string;
  labelKey: string;
}

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
  { id: "price", color: "#276d9b", labelKey: "chart.price" },
  { id: "totalAsset", color: "#147d68", labelKey: "chart.totalAsset" },
  { id: "drawdown", color: "#a7373a", labelKey: "chart.drawdown" },
  { id: "vix", color: "#7656a6", labelKey: "chart.vix" },
];
const VIX_SIGNAL_IDS = new Set(["vix.buy", "vix.exit.low1", "vix.exit.low2", "bollinger.exit.vix"]);
const CHART = { height: 320, left: 92, right: 26, top: 20, bottom: 54, width: 800 };
const COMPACT_CHART = { ...CHART, height: 180, bottom: 44 };

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
  {
    maximumAtZero = false,
    minimumAtZero = false,
  }: { maximumAtZero?: boolean; minimumAtZero?: boolean } = {},
  geometry = CHART,
): ChartScale {
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const span = rawMaximum - rawMinimum;
  const padding = span === 0
    ? Math.max(Math.abs(rawMaximum) * 0.05, maximumAtZero ? 0.01 : 1)
    : span * 0.08;
  const minimum = minimumAtZero ? Math.min(rawMinimum, 0) : rawMinimum - padding;
  const maximum = maximumAtZero ? 0 : rawMaximum + padding;
  const plotHeight = geometry.height - geometry.top - geometry.bottom;
  return {
    minimum,
    maximum,
    y: (value) => CHART.top + ((maximum - value) / (maximum - minimum)) * plotHeight,
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
  geometry = CHART,
}: {
  dates: string[];
  locale: Locale;
  scale: ChartScale;
  seriesId: AxisSeriesId;
  currency?: string;
  viewport: ChartViewport;
  geometry?: typeof CHART;
}) {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotBottom = geometry.height - geometry.bottom;
  const tickCount = geometry.height === COMPACT_CHART.height ? 4 : 8;
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
      {dateTicks(dates, viewport).map(({ date, x }, index) => (
        <g key={`x-${date}`}>
          <line className="chart-gridline chart-gridline-vertical" x1={x} y1={CHART.top} x2={x} y2={plotBottom} />
          <text className="chart-tick-label chart-x-tick" data-tick-index={index} x={x} y={plotBottom + 18} textAnchor="middle">
            {date}
          </text>
        </g>
      ))}
      <text className="chart-axis-title chart-y-axis-title" transform={`translate(20 ${geometry.height / 2}) rotate(-90)`} textAnchor="middle">
        {axisTitle(locale, seriesId, currency)}
      </text>
      <text className="chart-axis-title chart-x-axis-title" x={CHART.left + plotWidth / 2} y={geometry.height - 8} textAnchor="middle">
        {translate(locale, "chart.dateAxis")}
      </text>
    </g>
  );
}

function samplesForSeries(
  seriesId: ChartSeriesId,
  assets: DailyAsset[],
  signals: SignalEvaluation[],
): SeriesSample[] {
  if (seriesId === "vix") {
    const valueByDate = new Map<string, number>();
    for (const signal of signals) {
      if (!VIX_SIGNAL_IDS.has(signal.signalId)) continue;
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

function seriesLabel(locale: Locale, series: SeriesDefinition, currency?: string): string {
  const units = series.id === "totalAsset" || series.id === "price"
    ? currency
    : series.id === "drawdown"
      ? "%"
      : null;
  return `${translate(locale, series.labelKey)}${units ? ` (${units})` : ""}`;
}

function overlaySeriesLabel(
  locale: Locale,
  series: SeriesDefinition,
  currency: string | undefined,
): string {
  return seriesLabel(locale, series, currency);
}

function useSeriesHighlight() {
  const [hoveredId, setHoveredId] = useState<ChartSeriesId | null>(null);
  const [focusedId, setFocusedId] = useState<ChartSeriesId | null>(null);
  return { highlightedId: hoveredId ?? focusedId, setHoveredId, setFocusedId };
}

function SeriesLegend({
  locale, series, currency, highlight,
}: {
  locale: Locale;
  series: SeriesDefinition[];
  currency?: string;
  highlight: ReturnType<typeof useSeriesHighlight>;
}) {
  return (
    <div className="overlay-legend" role="list" aria-label={translate(locale, "chart.legend")}>
      {series.map((definition) => (
        <span
          className={`overlay-legend-item${highlight.highlightedId === definition.id ? " is-highlighted" : ""}`}
          role="listitem"
          tabIndex={0}
          key={definition.id}
          data-series={definition.id}
          onMouseEnter={() => highlight.setHoveredId(definition.id)}
          onMouseLeave={() => highlight.setHoveredId(null)}
          onFocus={() => highlight.setFocusedId(definition.id)}
          onBlur={() => highlight.setFocusedId(null)}
        >
          <i className="overlay-legend-swatch" style={{ backgroundColor: definition.color }} aria-hidden="true" />
          {overlaySeriesLabel(locale, definition, currency)}
        </span>
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

function LineChart({
  locale,
  assets,
  series,
  samples,
  symbol,
  thresholdValue,
  hasBuySignalObservations,
  viewport,
  chartInteractionProps,
  showCaption = true,
  compact = false,
  cursor,
}: {
  locale: Locale;
  assets: DailyAsset[];
  series: SeriesDefinition;
  samples: SeriesSample[];
  symbol?: string;
  thresholdValue: number | null;
  hasBuySignalObservations: boolean;
  viewport: ChartViewport;
  chartInteractionProps: ChartInteractionProps;
  showCaption?: boolean;
  compact?: boolean;
  cursor: ChartCursor | null;
}) {
  const geometry = compact ? COMPACT_CHART : CHART;
  const highlight = useSeriesHighlight();
  const gradientId = `chart-gradient-${useId()}`;
  if (samples.length === 0) return null;
  const range = visibleIndexRange(assets.length, viewport);
  const visibleSamples = samples.filter((point) => point.index >= range.start && point.index <= range.end);
  const chartSamples = samplesInViewport(samples, viewport, assets.length);
  const currency = assets[0]?.currency;
  const visibleThreshold = series.id === "vix" && hasBuySignalObservations ? thresholdValue : null;
  const values = chartSamples.map((point) => point.value);
  if (visibleThreshold !== null) values.push(visibleThreshold);
  const scale = chartScale(values, {
    maximumAtZero: series.id === "drawdown",
    minimumAtZero: series.id === "totalAsset",
  }, geometry);
  const points = lineCoordinates(chartSamples, scale, assets.length, viewport);
  const titleId = `chart-title-${series.id}`;
  const descriptionId = `chart-description-${series.id}`;
  const figureClass = `chart-panel chart-${series.id}${compact ? " is-compact" : ""}`;
  const symbolLabel = series.id === "price" ? symbol : series.id === "vix" ? symbol : undefined;
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
  const readings: CursorReading[] = [{
    label: translate(locale, series.labelKey),
    value: cursorPoint ? formatAxisValue(cursorPoint.value, locale, series.id) : "—",
    color: series.color,
  }];
  return (
    <figure className={figureClass} data-window-start={viewport.start} data-window-end={viewport.end}>
      <figcaption className={showCaption ? undefined : "sr-only"}>
        {symbolLabel ? `${symbolLabel} · ` : ""}{seriesLabel(locale, series, currency)}
      </figcaption>
      <div className="chart-canvas">
        <ChartReadout date={cursorDate} readings={readings} />
        <svg
          {...chartInteractionProps}
          className="result-chart"
          viewBox={`0 0 ${CHART.width} ${geometry.height}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          aria-label={translate(locale, "chart.interactionHelp")}
          tabIndex={0}
          data-chart-id={series.id}
        >
          <title id={titleId}>{seriesLabel(locale, series, currency)}</title>
          <desc id={descriptionId}>{translate(locale, "chart.description", {
            start: assets[Math.round(range.start)]?.date ?? "",
            end: assets[Math.round(range.end)]?.date ?? "",
            count: String(Math.max(1, Math.round(range.end) - Math.round(range.start) + 1)),
          })}</desc>
          <ChartAxes dates={assets.map((asset) => asset.date)} locale={locale} scale={scale} seriesId={series.id} currency={currency} viewport={viewport} geometry={geometry} />
          <defs>
            <clipPath id={plotClipId}>
              <rect x={CHART.left} y={CHART.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${plotClipId})`}>
            {highlight.highlightedId === series.id && (
              <HighlightArea points={points} color={series.color} gradientId={gradientId} bottom={geometry.height - geometry.bottom} />
            )}
            {thresholdY !== null && (
              <line className="chart-threshold-line" x1={CHART.left} y1={thresholdY} x2={CHART.width - CHART.right} y2={thresholdY}>
                <title>{translate(locale, "chart.threshold", { threshold: String(visibleThreshold) })}</title>
              </line>
            )}
            {points.length > 1 ? (
              <polyline
                className={`chart-series-line ${series.id === "price" ? "price-close-line" : ""} ${series.id === "vix" ? "chart-vix-line" : ""}${highlight.highlightedId === series.id ? " is-highlighted" : ""}`.trim()}
                points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                fill="none"
                stroke={SERIES.find((item) => item.id === series.id)?.color}
                strokeWidth={highlight.highlightedId === series.id ? 2.4 : 1.2}
                vectorEffect="non-scaling-stroke"
                tabIndex={0}
                aria-label={lineLabel}
              >
                <title>{lineLabel}</title>
              </polyline>
            ) : points.length === 1 ? (
              <circle className="chart-single-point" cx={points[0]?.x} cy={points[0]?.y} r="3" tabIndex={0} aria-label={lineLabel}>
                <title>{lineLabel}</title>
              </circle>
            ) : null}
            {series.id === "vix" && points.map((point) => (
              <circle className="vix-observation" key={point.date} cx={point.x} cy={point.y} r="2">
                <title>{`${point.date} ${formatAxisValue(point.value, locale, "vix")}`}</title>
              </circle>
            ))}
          </g>
          {cursor && <ChartCrosshair date={cursorDate} x={xPosition(cursor.index, assets.length, viewport)} y={cursorY}
            valueLabel={cursorValue === null ? undefined : formatAxisValue(cursorValue, locale, series.id)} geometry={geometry}
            points={cursorPoint ? [{ y: scale.y(cursorPoint.value), color: series.color }] : []} />}
        </svg>
      </div>
      <SeriesLegend locale={locale} series={[series]} currency={currency} highlight={highlight} />
      {series.id === "vix" && visibleThreshold !== null && (
        <p className="chart-threshold-label">{translate(locale, "chart.threshold", { threshold: String(visibleThreshold) })}</p>
      )}

    </figure>
  );
}

function OverlayChart({
  locale,
  assets,
  trades,
  series,
  samplesById,
  normalizedById,
  currency,
  viewport,
  chartInteractionProps,
  cursor,
}: {
  locale: Locale;
  assets: DailyAsset[];
  trades: Trade[];
  series: SeriesDefinition[];
  samplesById: Map<ChartSeriesId, SeriesSample[]>;
  normalizedById: Map<ChartSeriesId, NormalizedSeries | null>;
  currency?: string;
  viewport: ChartViewport;
  chartInteractionProps: ChartInteractionProps;
  cursor: ChartCursor | null;
}) {
  const highlight = useSeriesHighlight();
  const gradientId = `chart-gradient-${useId()}`;
  const normalized = series.flatMap((definition) => {
    const result = normalizedById.get(definition.id);
    return result ? [{ definition, result }] : [];
  });
  if (normalized.length === 0) {
    return (
      <p className="chart-empty">
        {translate(locale, "chart.noOverlaySeries")}
      </p>
    );
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
  ];
  const scale = chartScale(values);
  const titleId = "chart-title-overlay";
  const descriptionId = "chart-description-overlay";
  const priceSeries = normalized.find(({ definition }) => definition.id === "price");
  const markerSeries = priceSeries ?? normalized.find(({ definition }) => definition.id === "totalAsset");
  const markerByDate = new Map(markerSeries?.result.points.map((point) => [point.date, point]));
  const priceBaseline = priceSeries?.result.baseValue ?? null;
  const startDate = assets[Math.round(range.start)]?.date ?? "";
  const endDate = assets[Math.round(range.end)]?.date ?? "";
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotClipId = "chart-plot-overlay";
  const cursorDate = cursor ? assets[cursor.index]?.date : undefined;
  const cursorY = cursor?.chartId === "overlay" ? CHART.top + cursor.yRatio * plotHeight : undefined;
  const cursorValue = cursor ? scale.maximum - cursor.yRatio * (scale.maximum - scale.minimum) : null;
  const cursorPoints = normalized.flatMap(({ definition, result }) => {
    const point = result.points.find((sample) => sample.index === cursor?.index);
    return point ? [{ y: scale.y(point.indexValue), color: definition.color }] : [];
  });
  const readings: CursorReading[] = normalized.map(({ definition, result }) => {
    const point = result.points.find((sample) => sample.index === cursor?.index);
    const rawPoint = samplesById.get(definition.id)?.find((sample) => sample.index === cursor?.index);
    return {
      label: translate(locale, definition.labelKey),
      value: `${preciseValue(rawPoint?.value, locale, currency)} · ${translate(locale, "chart.relativeIndexValue", { value: point?.indexValue.toFixed(1) ?? "—" })}`,
      color: definition.color,
    };
  });
  readings.push({ label: translate(locale, "chart.principal"), value: preciseValue(cursor ? numericValue(assets[cursor.index]?.totalContributed) : null, locale, currency) });
  return (
    <figure className="chart-panel chart-overlay" data-window-start={viewport.start} data-window-end={viewport.end}>
      <figcaption>
        {translate(locale, "chart.overlayTitle")}
      </figcaption>
      <p className="chart-overlay-description sr-only">{translate(locale, "chart.overlayDescription")}</p>
      <div className="chart-canvas">
        <ChartReadout date={cursorDate} readings={readings} />
        <svg
          {...chartInteractionProps}
          className="result-chart"
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          aria-label={translate(locale, "chart.interactionHelp")}
          tabIndex={0}
          data-chart-id="overlay"
        >
          <title id={titleId}>{translate(locale, "chart.overlayTitle")}</title>
          <desc id={descriptionId}>{translate(locale, "chart.description", {
            start: startDate,
            end: endDate,
            count: String(Math.max(1, Math.round(range.end) - Math.round(range.start) + 1)),
          })}</desc>
          <ChartAxes dates={assets.map((asset) => asset.date)} locale={locale} scale={scale} seriesId="index" viewport={viewport} />
          <defs>
            <clipPath id={plotClipId}>
              <rect x={CHART.left} y={CHART.top} width={plotWidth} height={plotHeight} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${plotClipId})`}>
            {visibleNormalized.filter(({ definition }) => definition.id === highlight.highlightedId).map(({ definition, chartPoints }) => (
              <HighlightArea
                key={definition.id}
                points={chartPoints.map((point) => ({ x: xPosition(point.index, dateCount, viewport), y: scale.y(point.indexValue) }))}
                color={definition.color}
                gradientId={gradientId}
              />
            ))}
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
            {[...visibleNormalized].sort((left, right) => Number(left.definition.id === highlight.highlightedId) - Number(right.definition.id === highlight.highlightedId)).map(({ definition, chartPoints, visiblePoints }) => {
              const points = chartPoints.map((point) => ({
              ...point,
              x: xPosition(point.index, dateCount, viewport),
              y: scale.y(point.indexValue),
            }));
            const lastPoint = visiblePoints.at(-1);
            const lastTitle = lastPoint
              ? `${overlaySeriesLabel(locale, definition, currency)} · ${lastPoint.date} · ${formatAxisValue(lastPoint.value, locale, definition.id, currency)} · ${translate(locale, "chart.relativeIndexValue", { value: lastPoint.indexValue.toFixed(1) })}`
              : `${overlaySeriesLabel(locale, definition, currency)} · ${translate(locale, "chart.noSeriesInWindow")}`;
            return (
              <g className={`overlay-series overlay-${definition.id}`} key={definition.id}>
                {points.length > 1 ? (
                  <polyline className={`overlay-series-line overlay-${definition.id}${highlight.highlightedId === definition.id ? " is-highlighted" : ""}`} points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={definition.color} strokeWidth={highlight.highlightedId === definition.id ? 2.4 : 1.2} vectorEffect="non-scaling-stroke" tabIndex={0} aria-label={lastTitle}>
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
            {trades.flatMap((trade, index) => {
              const point = markerByDate.get(trade.date);
              const rawPrice = numericValue(trade.price);
              if (!point || rawPrice === null) return [];
              const value = priceBaseline === null
                ? point.indexValue
                : normalizeValueToBase100("price", rawPrice, priceBaseline);
              if (value === null) return [];
              const x = xPosition(point.index, dateCount, viewport);
              const y = scale.y(value);
              const direction = trade.side === "buy" ? 1 : -1;
              const markerPoints = `${x},${y + direction * 5} ${x - 5},${y - direction * 4} ${x + 5},${y - direction * 4}`;
              return (
                <polygon className={`price-trade-marker price-trade-marker-${trade.side}`} data-anchor-series={markerSeries?.definition.id} points={markerPoints} key={`${trade.date}-${trade.side}-${index}`}>
                  <title>{`${trade.date} ${translate(locale, `trade.side.${trade.side}`)} ${formatAxisValue(rawPrice, locale, "price", currency)}`}</title>
                </polygon>
              );
            })}
          </g>
          {cursor && <ChartCrosshair date={cursorDate} x={xPosition(cursor.index, dateCount, viewport)} y={cursorY}
            valueLabel={cursorValue === null ? undefined : formatAxisValue(cursorValue, locale, "index")} geometry={CHART} points={cursorPoints} />}
        </svg>
      </div>
      <SeriesLegend locale={locale} series={normalized.map(({ definition }) => definition)} currency={currency} highlight={highlight} />
    </figure>
  );
}

export function ResultsCharts({
  locale,
  dailyAssets,
  trades,
  signals = [],
  vixSymbol,
  vixThreshold,
  visibleSeriesIds,
  overlayMode = false,
  onSeriesChange,
  onOverlayModeChange = () => {},
}: ResultsChartsProps) {
  const { viewport, cursor, wheelZoomEnabled, chartContainerRef, chartInteractionProps, zoomAt, resetRange, toggleWheelZoom } = useChartInteraction(dailyAssets.length, CHART, COMPACT_CHART);
  const [expandedIndicators, setExpandedIndicators] = useState<Set<ChartSeriesId>>(() => new Set());
  const samplesById = useMemo(
    () => new Map(SERIES.map(({ id }) => [id, samplesForSeries(id, dailyAssets, signals)])),
    [dailyAssets, signals],
  );
  const normalizedById = useMemo(() => new Map<ChartSeriesId, NormalizedSeries | null>(
    SERIES.filter(({ id }) => id === "price" || id === "totalAsset").map(({ id }) => [id,
      normalizeSeriesToBase100(id, samplesById.get(id) ?? []),
    ]),
  ), [samplesById]);
  const available = useMemo(
    () => SERIES.filter((series) => series.id === "price" || series.id === "totalAsset"
      ? normalizedById.get(series.id) !== null
      : (samplesById.get(series.id)?.length ?? 0) > 0),
    [samplesById, normalizedById],
  );
  const selected = useMemo(
    () => available.filter((series) => visibleSeriesIds.includes(series.id)),
    [available, visibleSeriesIds],
  );
  const canOverlaySelection = selected.length >= 2 && selected.some(
    (series) => series.id === "drawdown" || series.id === "vix",
  );
  const combinedOverlay = overlayMode && canOverlaySelection;
  const coreSeries = selected.filter(
    (series) => series.id === "price" || series.id === "totalAsset",
  );
  const indicatorSeries = selected.filter(
    (series) => series.id === "drawdown" || series.id === "vix",
  );
  const currency = dailyAssets[0]?.currency;
  const thresholdValue = numericValue(vixThreshold);
  const hasBuySignalObservations = signals.some((signal) =>
    signal.signalId === "vix.buy" && numericValue(signal.observedValue) !== null,
  );
  const range = visibleIndexRange(dailyAssets.length, viewport);
  const visibleStartDate = dailyAssets[Math.round(range.start)]?.date ?? "—";
  const visibleEndDate = dailyAssets[Math.round(range.end)]?.date ?? "—";
  const viewportSpan = viewport.end - viewport.start;
  return (
    <div className={`charts-content${combinedOverlay ? " is-linked" : ""}`} ref={chartContainerRef}>
      <div className="chart-toolbar">
        <div className="chart-controls">
          <div className="chart-legend" role="group" aria-label={translate(locale, "chart.legend")}>
            {SERIES.map((series) => {
              const isAvailable = available.includes(series);
              const isVisible = visibleSeriesIds.includes(series.id) && isAvailable;
              const isLastCore = isVisible && coreSeries.length === 1 && coreSeries[0]?.id === series.id;
              return (
                <button
                  className={`legend-toggle${isVisible ? " is-visible" : ""}`}
                  type="button"
                  key={series.id}
                  aria-pressed={isVisible}
                  disabled={!isAvailable || isLastCore}
                  title={isLastCore ? translate(locale, "chart.keepCoreSeries") : undefined}
                  onClick={() => onSeriesChange(series.id, !isVisible)}
                >
                  <span className="legend-swatch" style={{ backgroundColor: series.color }} aria-hidden="true" />
                  {seriesLabel(locale, series, currency)}
                </button>
              );
            })}
          </div>
          <div className="chart-layout-controls" role="group" aria-label={translate(locale, "chart.layout")}>
            <button type="button" aria-pressed={!combinedOverlay} onClick={() => onOverlayModeChange(false)}>
              {translate(locale, "chart.layout.separate")}
            </button>
            <button
              type="button"
              aria-pressed={combinedOverlay}
              disabled={!canOverlaySelection}
              onClick={() => onOverlayModeChange(true)}
            >
              {translate(locale, "chart.layout.overlay")}
            </button>
          </div>
        </div>
        <div className="chart-range-controls" role="group" aria-label={translate(locale, "chart.rangeControls")}>
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
      ) : combinedOverlay ? (
        <div className="chart-linked-stack">
          {coreSeries.length > 0 && (
            <OverlayChart
              locale={locale}
              assets={dailyAssets}
              trades={trades}
              series={coreSeries}
              samplesById={samplesById}
              normalizedById={normalizedById}
              currency={currency}
              viewport={viewport}
              chartInteractionProps={chartInteractionProps}
              cursor={cursor}
            />
          )}
          {indicatorSeries.map((series) => (
            <LineChart
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
              compact
            />
          ))}
        </div>
      ) : (
        <>
          {coreSeries.length > 0 && (
            <OverlayChart
              locale={locale}
              assets={dailyAssets}
              trades={trades}
              series={coreSeries}
              samplesById={samplesById}
              normalizedById={normalizedById}
              currency={currency}
              viewport={viewport}
              chartInteractionProps={chartInteractionProps}
              cursor={cursor}
            />
          )}
          {indicatorSeries.map((series) => {
            const expanded = expandedIndicators.has(series.id);
            const title = series.id === "vix" && vixSymbol
              ? `${vixSymbol} · ${seriesLabel(locale, series, currency)}`
              : seriesLabel(locale, series, currency);
            return (
              <CollapsiblePanel
                id={`chart-aux-${series.id}`}
                className="chart-aux-panel"
                key={series.id}
                title={title}
                expanded={expanded}
                onExpandedChange={(nextExpanded) => setExpandedIndicators((current) => {
                  const next = new Set(current);
                  if (nextExpanded) next.add(series.id);
                  else next.delete(series.id);
                  return next;
                })}
              >
                <LineChart
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
                  showCaption={false}
                />
              </CollapsiblePanel>
            );
          })}
        </>
      )}
    </div>
  );
}
