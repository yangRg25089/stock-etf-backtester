import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { DailyAsset, SignalEvaluation, Trade } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import {
  normalizeSeriesToBase100,
  normalizeValueToBase100,
  type ChartSeriesId,
  type SeriesSample,
} from "./chartModel";
import {
  FULL_CHART_VIEWPORT,
  MIN_CHART_VIEWPORT_SPAN,
  panChartViewport,
  samplesInViewport,
  visibleIndexRange,
  zoomChartViewport,
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
  assetSymbol?: string;
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

interface ChartInteractionProps {
  onPointerDown(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerUp(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerCancel(event: ReactPointerEvent<SVGSVGElement>): void;
  onWheel(event: ReactWheelEvent<SVGSVGElement>): void;
  onKeyDown(event: ReactKeyboardEvent<SVGSVGElement>): void;
}

interface PointerDragState {
  pointerId: number;
  lastRatio: number;
  viewport: ChartViewport;
}

const SERIES: SeriesDefinition[] = [
  { id: "price", color: "#276d9b", labelKey: "chart.price" },
  { id: "totalAsset", color: "#147d68", labelKey: "chart.totalAsset" },
  { id: "drawdown", color: "#a7373a", labelKey: "chart.drawdown" },
  { id: "vix", color: "#7656a6", labelKey: "chart.vix" },
];
const VIX_SIGNAL_IDS = new Set(["vix.buy", "vix.exit.low1", "vix.exit.low2", "bollinger.exit.vix"]);
const CHART = { height: 320, left: 92, right: 26, top: 20, bottom: 54, width: 800 };

function numericValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function localeTag(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : "zh-CN";
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
): ChartScale {
  const rawMinimum = Math.min(...values);
  const rawMaximum = Math.max(...values);
  const span = rawMaximum - rawMinimum;
  const padding = span === 0
    ? Math.max(Math.abs(rawMaximum) * 0.05, maximumAtZero ? 0.01 : 1)
    : span * 0.08;
  const minimum = minimumAtZero ? Math.min(rawMinimum, 0) : rawMinimum - padding;
  const maximum = maximumAtZero ? 0 : rawMaximum + padding;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
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
  const indexes = [...new Set([
    Math.round(range.start),
    Math.round((range.start + range.end) / 2),
    Math.round(range.end),
  ])];
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
}: {
  dates: string[];
  locale: Locale;
  scale: ChartScale;
  seriesId: AxisSeriesId;
  currency?: string;
  viewport: ChartViewport;
}) {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotBottom = CHART.height - CHART.bottom;
  const ticks = Array.from({ length: 5 }, (_, index) =>
    scale.maximum - ((scale.maximum - scale.minimum) * index) / 4,
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
          <line className="chart-gridline chart-gridline-vertical" x1={x} y1={CHART.top} x2={x} y2={plotBottom} />
          <text className="chart-tick-label chart-x-tick" x={x} y={plotBottom + 18} textAnchor="middle">
            {date}
          </text>
        </g>
      ))}
      <text className="chart-axis-title chart-y-axis-title" transform={`translate(20 ${CHART.height / 2}) rotate(-90)`} textAnchor="middle">
        {axisTitle(locale, seriesId, currency)}
      </text>
      <text className="chart-axis-title chart-x-axis-title" x={CHART.left + plotWidth / 2} y={CHART.height - 8} textAnchor="middle">
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
    return value === null ? [] : [{ date: asset.date, index, value }];
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
  assetSymbol: string | undefined,
): string {
  const label = seriesLabel(locale, series, currency);
  return series.id === "price" && assetSymbol ? `${assetSymbol} · ${label}` : label;
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

function TradeMarkers({
  trades,
  points,
  scale,
  locale,
  currency,
  seriesId,
}: {
  trades: Trade[];
  points: ChartPoint[];
  scale: ChartScale;
  locale: Locale;
  currency?: string;
  seriesId: "price" | "totalAsset";
}) {
  const pointByDate = new Map(points.map((point) => [point.date, point]));
  return (
    <g className={`chart-trade-markers chart-trade-markers-${seriesId}`}>
      {trades.flatMap((trade, index) => {
        const point = pointByDate.get(trade.date);
        const value = seriesId === "price" ? numericValue(trade.price) : point?.value ?? null;
        if (!point || value === null) return [];
        const y = scale.y(value);
        const label = `${trade.date} ${translate(locale, `trade.side.${trade.side}`)} ${formatAxisValue(value, locale, seriesId, currency)}`;
        if (seriesId === "price") {
          const direction = trade.side === "buy" ? 1 : -1;
          const markerPoints = `${point.x},${y + direction * 5} ${point.x - 5},${y - direction * 4} ${point.x + 5},${y - direction * 4}`;
          return (
            <polygon className={`price-trade-marker price-trade-marker-${trade.side}`} points={markerPoints} key={`${trade.date}-${trade.side}-${index}`}>
              <title>{label}</title>
            </polygon>
          );
        }
        return (
          <circle className={`trade-marker trade-marker-${trade.side}`} key={`${trade.date}-${trade.side}-${index}`} cx={point.x} cy={y} r="4" aria-hidden="true">
            <title>{label}</title>
          </circle>
        );
      })}
    </g>
  );
}

function LineChart({
  locale,
  assets,
  trades,
  series,
  samples,
  symbol,
  thresholdValue,
  hasBuySignalObservations,
  viewport,
  chartInteractionProps,
}: {
  locale: Locale;
  assets: DailyAsset[];
  trades: Trade[];
  series: SeriesDefinition;
  samples: SeriesSample[];
  symbol?: string;
  thresholdValue: number | null;
  hasBuySignalObservations: boolean;
  viewport: ChartViewport;
  chartInteractionProps: ChartInteractionProps;
}) {
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
  });
  const points = lineCoordinates(chartSamples, scale, assets.length, viewport);
  const titleId = `chart-title-${series.id}`;
  const descriptionId = `chart-description-${series.id}`;
  const figureClass = `chart-panel chart-${series.id}`;
  const symbolLabel = series.id === "price" ? symbol : series.id === "vix" ? symbol : undefined;
  const lastPoint = visibleSamples.at(-1);
  const lineLabel = lastPoint
    ? `${seriesLabel(locale, series, currency)} · ${lastPoint.date} · ${formatAxisValue(lastPoint.value, locale, series.id, currency)}`
    : `${seriesLabel(locale, series, currency)} · ${translate(locale, "chart.noSeriesInWindow")}`;
  const thresholdY = visibleThreshold === null ? null : scale.y(visibleThreshold);
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotClipId = `chart-plot-${series.id}`;
  return (
    <figure className={figureClass} data-window-start={viewport.start} data-window-end={viewport.end}>
      <figcaption>{symbolLabel ? `${symbolLabel} · ` : ""}{seriesLabel(locale, series, currency)}</figcaption>
      <svg
        {...chartInteractionProps}
        className="result-chart"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        aria-label={translate(locale, "chart.interactionHelp")}
        tabIndex={0}
      >
        <title id={titleId}>{seriesLabel(locale, series, currency)}</title>
        <desc id={descriptionId}>{translate(locale, "chart.description", {
          start: assets[Math.round(range.start)]?.date ?? "",
          end: assets[Math.round(range.end)]?.date ?? "",
          count: String(Math.max(1, Math.round(range.end) - Math.round(range.start) + 1)),
        })}</desc>
        <ChartAxes dates={assets.map((asset) => asset.date)} locale={locale} scale={scale} seriesId={series.id} currency={currency} viewport={viewport} />
        <defs>
          <clipPath id={plotClipId}>
            <rect x={CHART.left} y={CHART.top} width={plotWidth} height={plotHeight} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${plotClipId})`}>
          {thresholdY !== null && (
            <line className="chart-threshold-line" x1={CHART.left} y1={thresholdY} x2={CHART.width - CHART.right} y2={thresholdY}>
              <title>{translate(locale, "chart.threshold", { threshold: String(visibleThreshold) })}</title>
            </line>
          )}
          {points.length > 1 ? (
            <polyline
              className={`chart-series-line ${series.id === "price" ? "price-close-line" : ""} ${series.id === "vix" ? "chart-vix-line" : ""}`.trim()}
              points={points.map((point) => `${point.x},${point.y}`).join(" ")}
              fill="none"
              stroke={SERIES.find((item) => item.id === series.id)?.color}
              strokeWidth="2.5"
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
          {(series.id === "price" || series.id === "totalAsset") && (
            <TradeMarkers trades={trades} points={points} scale={scale} locale={locale} currency={currency} seriesId={series.id} />
          )}
          {series.id === "vix" && points.map((point) => (
            <circle className="vix-observation" key={point.date} cx={point.x} cy={point.y} r="2">
              <title>{`${point.date} ${formatAxisValue(point.value, locale, "vix")}`}</title>
            </circle>
          ))}
        </g>
      </svg>
      {series.id === "vix" && visibleThreshold !== null && (
        <p className="chart-threshold-label">{translate(locale, "chart.threshold", { threshold: String(visibleThreshold) })}</p>
      )}
      {series.id === "price" && trades.length > 0 && (
        <div className="price-marker-legend" aria-label={translate(locale, "chart.tradeMarkers")}>
          <span><i className="trade-marker-buy" aria-hidden="true" />{translate(locale, "trade.side.buy")}</span>
          <span><i className="trade-marker-sell" aria-hidden="true" />{translate(locale, "trade.side.sell")}</span>
        </div>
      )}
    </figure>
  );
}

function OverlayChart({
  locale,
  assets,
  trades,
  assetSymbol,
  series,
  samplesById,
  currency,
  thresholdValue,
  hasBuySignalObservations,
  viewport,
  chartInteractionProps,
}: {
  locale: Locale;
  assets: DailyAsset[];
  trades: Trade[];
  assetSymbol?: string;
  series: SeriesDefinition[];
  samplesById: Map<ChartSeriesId, SeriesSample[]>;
  currency?: string;
  thresholdValue: number | null;
  hasBuySignalObservations: boolean;
  viewport: ChartViewport;
  chartInteractionProps: ChartInteractionProps;
}) {
  const normalized = useMemo(() => series.flatMap((definition) => {
    const result = normalizeSeriesToBase100(definition.id, samplesById.get(definition.id) ?? []);
    return result ? [{ definition, result }] : [];
  }), [samplesById, series]);
  if (normalized.length === 0) {
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
  ];
  const scale = chartScale(values);
  const thresholdIndex = normalized.some(({ definition }) => definition.id === "vix") && hasBuySignalObservations && thresholdValue !== null
    ? normalizeValueToBase100("vix", thresholdValue, normalized.find(({ definition }) => definition.id === "vix")?.result.baseValue ?? 0)
    : null;
  const thresholdY = thresholdIndex === null ? null : scale.y(thresholdIndex);
  const titleId = "chart-title-overlay";
  const descriptionId = "chart-description-overlay";
  const priceSeries = normalized.find(({ definition }) => definition.id === "price");
  const priceSamples = samplesById.get("price") ?? [];
  const priceByDate = new Map(priceSamples.map((point) => [point.date, point]));
  const priceBaseline = priceSeries?.result.baseValue ?? null;
  const startDate = assets[Math.round(range.start)]?.date ?? "";
  const endDate = assets[Math.round(range.end)]?.date ?? "";
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotClipId = "chart-plot-overlay";
  return (
    <figure className="chart-panel chart-overlay" data-window-start={viewport.start} data-window-end={viewport.end}>
      <figcaption>
        {assetSymbol ? `${assetSymbol} · ` : ""}
        {translate(locale, "chart.overlayTitle")}
      </figcaption>
      <p className="chart-overlay-description">{translate(locale, "chart.overlayDescription")}</p>
      <svg
        {...chartInteractionProps}
        className="result-chart"
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        aria-label={translate(locale, "chart.interactionHelp")}
        tabIndex={0}
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
          {thresholdY !== null && (
            <line className="chart-threshold-line" x1={CHART.left} y1={thresholdY} x2={CHART.width - CHART.right} y2={thresholdY}>
              <title>{translate(locale, "chart.threshold", { threshold: String(thresholdValue) })}</title>
            </line>
          )}
          {visibleNormalized.map(({ definition, chartPoints, visiblePoints }) => {
            const points = chartPoints.map((point) => ({
            ...point,
            x: xPosition(point.index, dateCount, viewport),
            y: scale.y(point.indexValue),
          }));
          const lastPoint = visiblePoints.at(-1);
          const lastTitle = lastPoint
            ? `${overlaySeriesLabel(locale, definition, currency, assetSymbol)} · ${lastPoint.date} · ${formatAxisValue(lastPoint.value, locale, definition.id, currency)} · ${translate(locale, "chart.relativeIndexValue", { value: lastPoint.indexValue.toFixed(1) })}`
            : `${overlaySeriesLabel(locale, definition, currency, assetSymbol)} · ${translate(locale, "chart.noSeriesInWindow")}`;
          return (
            <g className={`overlay-series overlay-${definition.id}`} key={definition.id}>
              {points.length > 1 ? (
                <polyline className={`overlay-series-line overlay-${definition.id}`} points={points.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke={definition.color} strokeWidth="2.5" tabIndex={0} aria-label={lastTitle}>
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
          {priceBaseline !== null && priceBaseline > 0 && trades.flatMap((trade, index) => {
            const point = priceByDate.get(trade.date);
            const rawPrice = numericValue(trade.price);
            if (!point || rawPrice === null) return [];
            const value = normalizeValueToBase100("price", rawPrice, priceBaseline);
            if (value === null) return [];
            const x = xPosition(point.index, dateCount, viewport);
            const y = scale.y(value);
            const direction = trade.side === "buy" ? 1 : -1;
            const markerPoints = `${x},${y + direction * 5} ${x - 5},${y - direction * 4} ${x + 5},${y - direction * 4}`;
            return (
              <polygon className={`price-trade-marker price-trade-marker-${trade.side}`} points={markerPoints} key={`${trade.date}-${trade.side}-${index}`}>
                <title>{`${trade.date} ${translate(locale, `trade.side.${trade.side}`)} ${formatAxisValue(rawPrice, locale, "price", currency)}`}</title>
              </polygon>
            );
          })}
        </g>
      </svg>
      <div className="overlay-legend" role="list" aria-label={translate(locale, "chart.legend")}>
        {normalized.map(({ definition }) => (
          <span className="overlay-legend-item" role="listitem" key={definition.id}>
            <i className="overlay-legend-swatch" style={{ backgroundColor: definition.color }} aria-hidden="true" />
            {overlaySeriesLabel(locale, definition, currency, assetSymbol)}
          </span>
        ))}
      </div>
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
  assetSymbol,
  visibleSeriesIds,
  overlayMode = false,
  onSeriesChange,
  onOverlayModeChange = () => {},
}: ResultsChartsProps) {
  const [viewport, setViewport] = useState<ChartViewport>(FULL_CHART_VIEWPORT);
  const dragState = useRef<PointerDragState | null>(null);
  const samplesById = useMemo(
    () => new Map(SERIES.map(({ id }) => [id, samplesForSeries(id, dailyAssets, signals)])),
    [dailyAssets, signals],
  );
  const available = useMemo(
    () => SERIES.filter((series) => (samplesById.get(series.id)?.length ?? 0) > 0),
    [samplesById],
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
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const pointerPosition = (event: ReactPointerEvent<SVGSVGElement> | ReactWheelEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * CHART.width;
    const svgY = ((event.clientY - bounds.top) / bounds.height) * CHART.height;
    return { ratio: (svgX - CHART.left) / plotWidth, y: svgY };
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const position = pointerPosition(event);
    if (position.ratio < 0 || position.ratio > 1 || position.y < CHART.top || position.y > CHART.height - CHART.bottom) return;
    dragState.current = { pointerId: event.pointerId, lastRatio: position.ratio, viewport };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const activeDrag = dragState.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    const position = pointerPosition(event);
    const nextViewport = panChartViewport(activeDrag.viewport, position.ratio - activeDrag.lastRatio);
    activeDrag.lastRatio = position.ratio;
    activeDrag.viewport = nextViewport;
    setViewport(nextViewport);
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onPointerCancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragState.current?.pointerId === event.pointerId) dragState.current = null;
  };
  const zoomAt = (factor: number, anchorRatio = 0.5) => {
    setViewport((current) => zoomChartViewport(current, factor, anchorRatio));
  };
  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    if (event.deltaY === 0) return;
    zoomAt(event.deltaY < 0 ? 0.8 : 1.25, pointerPosition(event).ratio);
  };
  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setViewport((current) => panChartViewport(current, 0.12));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setViewport((current) => panChartViewport(current, -0.12));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(0.8);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAt(1.25);
    } else if (event.key === "Home") {
      event.preventDefault();
      setViewport(FULL_CHART_VIEWPORT);
    }
  };
  const chartInteractionProps: ChartInteractionProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onWheel,
    onKeyDown,
  };
  const range = visibleIndexRange(dailyAssets.length, viewport);
  const visibleStartDate = dailyAssets[Math.round(range.start)]?.date ?? "—";
  const visibleEndDate = dailyAssets[Math.round(range.end)]?.date ?? "—";
  const viewportSpan = viewport.end - viewport.start;
  return (
    <div className="charts-content">
      <div className="chart-controls">
        <div className="chart-legend" role="group" aria-label={translate(locale, "chart.legend")}>
          {SERIES.map((series) => {
            const isAvailable = available.includes(series);
            const isVisible = visibleSeriesIds.includes(series.id);
            return (
              <button
                className={`legend-toggle${isVisible ? " is-visible" : ""}`}
                type="button"
                key={series.id}
                aria-pressed={isVisible}
                disabled={!isAvailable}
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
        <span className="chart-range-label">
          {translate(locale, "chart.visibleRange", { start: visibleStartDate, end: visibleEndDate })}
        </span>
        <button type="button" aria-label={translate(locale, "chart.zoomOut")} disabled={viewportSpan >= 1} onClick={() => zoomAt(1.25)}>
          <span aria-hidden="true">−</span>
        </button>
        <button type="button" aria-label={translate(locale, "chart.zoomIn")} disabled={viewportSpan <= MIN_CHART_VIEWPORT_SPAN + 1e-6} onClick={() => zoomAt(0.8)}>
          <span aria-hidden="true">+</span>
        </button>
        <button type="button" aria-label={translate(locale, "chart.resetRange")} disabled={viewportSpan >= 1} onClick={() => setViewport(FULL_CHART_VIEWPORT)}>
          {translate(locale, "chart.resetRange")}
        </button>
      </div>
      {selected.length === 0 ? (
        <p className="chart-empty">{translate(locale, "chart.noVisibleSeries")}</p>
      ) : combinedOverlay ? (
        <OverlayChart
          locale={locale}
          assets={dailyAssets}
          trades={trades}
          assetSymbol={assetSymbol}
          series={selected}
          samplesById={samplesById}
          currency={currency}
          thresholdValue={thresholdValue}
          hasBuySignalObservations={hasBuySignalObservations}
          viewport={viewport}
          chartInteractionProps={chartInteractionProps}
        />
      ) : (
        <>
          {coreSeries.length > 0 && (
            <OverlayChart
              locale={locale}
              assets={dailyAssets}
              trades={trades}
              assetSymbol={assetSymbol}
              series={coreSeries}
              samplesById={samplesById}
              currency={currency}
              thresholdValue={thresholdValue}
              hasBuySignalObservations={hasBuySignalObservations}
              viewport={viewport}
              chartInteractionProps={chartInteractionProps}
            />
          )}
          {indicatorSeries.map((series) => (
            <LineChart
              key={series.id}
              locale={locale}
              assets={dailyAssets}
              trades={trades}
              series={series}
              samples={samplesById.get(series.id) ?? []}
              symbol={series.id === "vix" ? vixSymbol : undefined}
              thresholdValue={thresholdValue}
              hasBuySignalObservations={hasBuySignalObservations}
              viewport={viewport}
              chartInteractionProps={chartInteractionProps}
            />
          ))}
        </>
      )}
    </div>
  );
}
