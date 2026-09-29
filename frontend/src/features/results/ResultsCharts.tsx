import type { DailyAsset, SignalEvaluation, Trade } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";

type SeriesId = "totalAsset" | "drawdown";
interface Point {
  date: string;
  index: number;
  value: number;
  x: number;
  y: number;
}

interface ResultsChartsProps {
  locale: Locale;
  dailyAssets: DailyAsset[];
  trades: Trade[];
  signals: SignalEvaluation[];
  vixSymbol?: string;
  vixThreshold?: string;
  assetSymbol?: string;
  visibleSeriesIds: string[];
  onSeriesChange(id: string, visible: boolean): void;
}

interface SeriesDefinition {
  id: SeriesId;
  color: string;
  labelKey: string;
}

interface ChartScale {
  minimum: number;
  maximum: number;
  y(value: number): number;
}

const SERIES: SeriesDefinition[] = [
  { id: "totalAsset", color: "#147d68", labelKey: "chart.totalAsset" },
  { id: "drawdown", color: "#a7373a", labelKey: "chart.drawdown" },
];

const CHART = {
  height: 320,
  left: 92,
  right: 26,
  top: 20,
  bottom: 54,
  width: 800,
};

function numericValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function seriesValue(asset: DailyAsset, seriesId: SeriesId): number | null {
  return numericValue(seriesId === "totalAsset" ? asset.totalAsset : asset.drawdown);
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

function xPosition(index: number, count: number): number {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  return CHART.left + (index / Math.max(count - 1, 1)) * plotWidth;
}

function yTicks(scale: ChartScale): number[] {
  return Array.from({ length: 5 }, (_, index) =>
    scale.maximum - ((scale.maximum - scale.minimum) * index) / 4,
  );
}

function dateTicks(assets: DailyAsset[]): Array<{ date: string; x: number }> {
  if (assets.length === 0) return [];
  const indexes = [...new Set([0, Math.floor((assets.length - 1) / 2), assets.length - 1])];
  return indexes.flatMap((index) => {
    const asset = assets[index];
    return asset ? [{ date: asset.date, x: xPosition(index, assets.length) }] : [];
  });
}

function localeTag(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : "zh-CN";
}

function formatAxisValue(
  value: number,
  locale: Locale,
  seriesId: SeriesId | "price" | "vix",
  currency?: string,
): string {
  if (seriesId === "drawdown") {
    return new Intl.NumberFormat(localeTag(locale), {
      maximumFractionDigits: 1,
      style: "percent",
    }).format(value);
  }
  if (currency) {
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

function axisTitle(
  locale: Locale,
  seriesId: SeriesId | "price" | "vix",
  currency?: string,
): string {
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

function ChartAxes({
  assets,
  locale,
  scale,
  seriesId,
  currency,
}: {
  assets: DailyAsset[];
  locale: Locale;
  scale: ChartScale;
  seriesId: SeriesId | "price" | "vix";
  currency?: string;
}) {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotBottom = CHART.height - CHART.bottom;
  const ticks = yTicks(scale);
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
      {dateTicks(assets).map(({ date, x }) => (
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

function linePoints(assets: DailyAsset[], seriesId: SeriesId, scale: ChartScale): Point[] {
  return assets.flatMap((asset, index) => {
    const value = seriesValue(asset, seriesId);
    return value === null ? [] : [{ date: asset.date, index, value, x: xPosition(index, assets.length), y: scale.y(value) }];
  });
}

function LineChart({
  locale,
  assets,
  trades,
  series,
}: {
  locale: Locale;
  assets: DailyAsset[];
  trades: Trade[];
  series: SeriesDefinition;
}) {
  const rawPoints = assets.flatMap((asset) => {
    const value = seriesValue(asset, series.id);
    return value === null ? [] : [value];
  });
  if (rawPoints.length === 0) {
    return <p className="chart-empty">{translate(locale, "chart.seriesUnavailable")}</p>;
  }
  const scale = chartScale(rawPoints, {
    maximumAtZero: series.id === "drawdown",
    minimumAtZero: series.id === "totalAsset",
  });
  const points = linePoints(assets, series.id, scale);
  const path = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const pointByDate = new Map(points.map((point) => [point.date, point]));
  const markers = series.id === "totalAsset"
    ? trades.flatMap((trade, index) => {
      const point = pointByDate.get(trade.date);
      return point ? [{ trade, point, index }] : [];
    })
    : [];
  const titleId = `chart-title-${series.id}`;
  const descriptionId = `chart-description-${series.id}`;
  return (
    <figure className={`chart-panel chart-${series.id}`}>
      <figcaption>{translate(locale, series.labelKey)}</figcaption>
      <svg className="result-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>{translate(locale, series.labelKey)}</title>
        <desc id={descriptionId}>{translate(locale, "chart.description", {
          start: points[0]?.date ?? "",
          end: points.at(-1)?.date ?? "",
          count: String(points.length),
        })}</desc>
        <ChartAxes assets={assets} locale={locale} scale={scale} seriesId={series.id} currency={assets[0]?.currency} />
        <polyline className="chart-series-line" points={path} fill="none" stroke={series.color} strokeWidth="2.5" />
        {markers.map(({ trade, point, index }) => (
          <circle className={`trade-marker trade-marker-${trade.side}`} key={`${trade.date}-${trade.side}-${index}`} cx={point.x} cy={point.y} r="4" aria-hidden="true">
            <title>{`${trade.date} ${translate(locale, `trade.side.${trade.side}`)}`}</title>
          </circle>
        ))}
      </svg>
    </figure>
  );
}

interface PriceBar {
  asset: DailyAsset;
  index: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function completePriceBars(assets: DailyAsset[]): PriceBar[] | null {
  const bars = assets.flatMap((asset, index) => {
    const open = numericValue(asset.simulationOpen);
    const high = numericValue(asset.simulationHigh);
    const low = numericValue(asset.simulationLow);
    const close = numericValue(asset.simulationPrice);
    return open === null || high === null || low === null || close === null
      ? []
      : [{ asset, index, open, high, low, close }];
  });
  return bars.length === assets.length && bars.length > 0 ? bars : null;
}

function PriceChart({
  locale,
  assets,
  trades,
  symbol,
}: {
  locale: Locale;
  assets: DailyAsset[];
  trades: Trade[];
  symbol?: string;
}) {
  const bars = completePriceBars(assets);
  const closePoints = assets.flatMap((asset, index) => {
    const close = numericValue(asset.simulationPrice);
    return close === null ? [] : [{ date: asset.date, index, value: close }];
  });
  if (closePoints.length === 0) {
    return <p className="chart-empty">{translate(locale, "chart.seriesUnavailable")}</p>;
  }
  const prices = bars
    ? bars.flatMap((bar) => [bar.low, bar.high])
    : closePoints.map((point) => point.value);
  const tradePrices = trades.map((trade) => Number(trade.price)).filter(Number.isFinite);
  const scale = chartScale([...prices, ...tradePrices]);
  const currency = assets[0]?.currency;
  const priceByDate = new Map(closePoints.map((point) => [point.date, point]));
  const titleId = "chart-title-price";
  const descriptionId = "chart-description-price";
  const candleWidth = Math.max(3, Math.min(12, (CHART.width - CHART.left - CHART.right) / assets.length * 0.55));
  return (
    <figure className="chart-panel chart-price">
      <figcaption>{symbol ? `${symbol} · ` : ""}{translate(locale, "chart.price")}{currency ? ` · ${currency}` : ""}</figcaption>
      <svg className="result-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>{axisTitle(locale, "price", currency)}</title>
        <desc id={descriptionId}>{translate(locale, "chart.description", {
          start: assets[0]?.date ?? "",
          end: assets.at(-1)?.date ?? "",
          count: String(closePoints.length),
        })}</desc>
        <ChartAxes assets={assets} locale={locale} scale={scale} seriesId="price" currency={currency} />
        {bars ? (
          bars.map((bar) => {
            const x = xPosition(bar.index, assets.length);
            const openY = scale.y(bar.open);
            const closeY = scale.y(bar.close);
            const bodyY = Math.min(openY, closeY);
            const bodyHeight = Math.max(Math.abs(closeY - openY), 1);
            const trend = bar.close >= bar.open ? "up" : "down";
            return (
              <g className={`candlestick candlestick-${trend}`} key={bar.asset.date}>
                <line className="candle-wick" x1={x} y1={scale.y(bar.high)} x2={x} y2={scale.y(bar.low)} />
                <rect className="candle-body" x={x - candleWidth / 2} y={bodyY} width={candleWidth} height={bodyHeight}>
                  <title>{`${bar.asset.date} O ${formatAxisValue(bar.open, locale, "price", currency)} H ${formatAxisValue(bar.high, locale, "price", currency)} L ${formatAxisValue(bar.low, locale, "price", currency)} C ${formatAxisValue(bar.close, locale, "price", currency)}`}</title>
                </rect>
              </g>
            );
          })
        ) : (
          <polyline
            className="chart-series-line price-close-line"
            points={closePoints.map((point) => `${xPosition(point.index, assets.length)},${scale.y(point.value)}`).join(" ")}
            fill="none"
            stroke="#276d9b"
            strokeWidth="2.5"
          />
        )}
        {trades.flatMap((trade, index) => {
          const point = priceByDate.get(trade.date);
          const value = numericValue(trade.price);
          if (!point || value === null) return [];
          const x = xPosition(point.index, assets.length);
          const y = scale.y(value);
          const direction = trade.side === "buy" ? 1 : -1;
          const points = `${x},${y + direction * 5} ${x - 5},${y - direction * 4} ${x + 5},${y - direction * 4}`;
          return (
            <polygon className={`price-trade-marker price-trade-marker-${trade.side}`} points={points} key={`${trade.date}-${trade.side}-${index}`}>
              <title>{`${trade.date} ${translate(locale, `trade.side.${trade.side}`)} ${formatAxisValue(value, locale, "price", currency)}`}</title>
            </polygon>
          );
        })}
      </svg>
      <div className="price-marker-legend" aria-label={translate(locale, "chart.tradeMarkers")}>
        <span><i className="trade-marker-buy" aria-hidden="true" />{translate(locale, "trade.side.buy")}</span>
        <span><i className="trade-marker-sell" aria-hidden="true" />{translate(locale, "trade.side.sell")}</span>
      </div>
    </figure>
  );
}

function VixChart({
  locale,
  assets,
  signals,
  symbol,
  thresholdValue,
}: {
  locale: Locale;
  assets: DailyAsset[];
  signals: SignalEvaluation[];
  symbol?: string;
  thresholdValue: number | null;
}) {
  const relevantSignals = signals.filter((signal) =>
    ["vix.buy", "vix.exit.low1", "vix.exit.low2", "bollinger.exit.vix"].includes(signal.signalId),
  );
  const valueByDate = new Map<string, number>();
  for (const signal of relevantSignals) {
    const value = numericValue(signal.observedValue);
    if (value !== null) valueByDate.set(signal.date, value);
  }
  const hasBuySignalObservations = relevantSignals.some((signal) =>
    signal.signalId === "vix.buy" && numericValue(signal.observedValue) !== null,
  );
  const points = assets.flatMap((asset, index) => {
    const value = valueByDate.get(asset.date);
    return value === undefined ? [] : [{ date: asset.date, index, value }];
  });
  if (points.length === 0) return null;
  const values = points.map((point) => point.value);
  const visibleThreshold = hasBuySignalObservations ? thresholdValue : null;
  if (visibleThreshold !== null) values.push(visibleThreshold);
  const scale = chartScale(values);
  const line = points.map((point) => `${xPosition(point.index, assets.length)},${scale.y(point.value)}`).join(" ");
  const thresholdY = visibleThreshold === null ? null : scale.y(visibleThreshold);
  const titleId = "chart-title-vix";
  const descriptionId = "chart-description-vix";
  return (
    <figure className="chart-panel chart-vix">
      <figcaption>{translate(locale, "chart.vix")}{symbol ? ` · ${symbol}` : ""}</figcaption>
      <svg className="result-chart" viewBox={`0 0 ${CHART.width} ${CHART.height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <title id={titleId}>{axisTitle(locale, "vix")}</title>
        <desc id={descriptionId}>{translate(locale, "chart.description", {
          start: points[0]?.date ?? "",
          end: points.at(-1)?.date ?? "",
          count: String(points.length),
        })}</desc>
        <ChartAxes assets={assets} locale={locale} scale={scale} seriesId="vix" />
        {thresholdY !== null && (
          <line className="chart-threshold-line" x1={CHART.left} y1={thresholdY} x2={CHART.width - CHART.right} y2={thresholdY}>
            <title>{translate(locale, "chart.threshold", { threshold: String(visibleThreshold) })}</title>
          </line>
        )}
        <polyline className="chart-series-line chart-vix-line" points={line} fill="none" stroke="#7656a6" strokeWidth="2.5" />
        {points.map((point) => (
          <circle
            className="vix-observation"
            key={point.date}
            cx={xPosition(point.index, assets.length)}
            cy={scale.y(point.value)}
            r="2"
          >
            <title>{`${point.date} ${formatAxisValue(point.value, locale, "vix")}`}</title>
          </circle>
        ))}
      </svg>
      {visibleThreshold !== null && <p className="chart-threshold-label">{translate(locale, "chart.threshold", { threshold: String(visibleThreshold) })}</p>}
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
  onSeriesChange,
}: ResultsChartsProps) {
  const visible = SERIES.filter((series) => visibleSeriesIds.includes(series.id));
  const currency = dailyAssets[0]?.currency;
  const parsedThreshold = numericValue(vixThreshold);
  return (
    <div className="charts-content">
      <div className="chart-legend" role="group" aria-label={translate(locale, "chart.legend")}>
        {SERIES.map((series) => {
          const selected = visibleSeriesIds.includes(series.id);
          return (
            <button
              className={`legend-toggle${selected ? " is-visible" : ""}`}
              type="button"
              key={series.id}
              aria-pressed={selected}
              onClick={() => onSeriesChange(series.id, !selected)}
            >
              <span className="legend-swatch" style={{ backgroundColor: series.color }} aria-hidden="true" />
              {translate(locale, series.labelKey)}{series.id === "totalAsset" && currency ? ` (${currency})` : series.id === "drawdown" ? " (%)" : ""}
            </button>
          );
        })}
      </div>
      <PriceChart locale={locale} assets={dailyAssets} trades={trades} symbol={assetSymbol} />
      <VixChart
        locale={locale}
        assets={dailyAssets}
        signals={signals}
        symbol={vixSymbol}
        thresholdValue={parsedThreshold}
      />
      {visible.length === 0 ? (
        <p className="chart-empty">{translate(locale, "chart.noVisibleSeries")}</p>
      ) : visible.map((series) => (
        <LineChart
          key={series.id}
          locale={locale}
          assets={dailyAssets}
          trades={trades}
          series={series}
        />
      ))}
    </div>
  );
}
