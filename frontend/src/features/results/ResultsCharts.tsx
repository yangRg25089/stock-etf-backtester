import type { DailyAsset, Trade } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";

type SeriesId = "totalAsset" | "drawdown";
interface ChartPoint {
  date: string;
  index: number;
  x: number;
  y: number;
}

interface ResultsChartsProps {
  locale: Locale;
  dailyAssets: DailyAsset[];
  trades: Trade[];
  visibleSeriesIds: string[];
  onSeriesChange(id: string, visible: boolean): void;
}

const SERIES: Array<{ id: SeriesId; color: string; labelKey: string }> = [
  { id: "totalAsset", color: "#147d68", labelKey: "chart.totalAsset" },
  { id: "drawdown", color: "#a7373a", labelKey: "chart.drawdown" },
];

function valueFor(asset: DailyAsset, seriesId: SeriesId): number | null {
  const raw = seriesId === "totalAsset" ? asset.totalAsset : asset.drawdown;
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function chartPoints(assets: DailyAsset[], seriesId: SeriesId): ChartPoint[] {
  const values = assets.flatMap((asset, index) => {
    const value = valueFor(asset, seriesId);
    return value === null ? [] : [{ date: asset.date, index, value }];
  });
  if (values.length === 0) return [];
  const rawMin = Math.min(...values.map((point) => point.value));
  const rawMax = Math.max(...values.map((point) => point.value));
  const span = rawMax - rawMin;
  const padding = span === 0 ? Math.max(Math.abs(rawMax) * 0.05, 1) : span * 0.05;
  const min = rawMin - padding;
  const max = rawMax + padding;
  const plotWidth = 672;
  const plotHeight = 180;
  return values.map((point) => ({
    date: point.date,
    index: point.index,
    x: 24 + (point.index / Math.max(assets.length - 1, 1)) * plotWidth,
    y: 16 + ((max - point.value) / (max - min)) * plotHeight,
  }));
}

function ChartPanel({
  locale,
  dailyAssets,
  trades,
  series,
}: {
  locale: Locale;
  dailyAssets: DailyAsset[];
  trades: Trade[];
  series: (typeof SERIES)[number];
}) {
  const points = chartPoints(dailyAssets, series.id);
  if (points.length === 0) {
    return <p className="chart-empty">{translate(locale, "chart.seriesUnavailable")}</p>;
  }
  const path = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const byDate = new Map(points.map((point) => [point.date, point]));
  const tradeMarkers = series.id === "totalAsset"
    ? trades.flatMap((trade, index) => {
      const point = byDate.get(trade.date);
      return point ? [{ trade, point, index }] : [];
    })
    : [];
  const titleId = `chart-title-${series.id}`;
  const descriptionId = `chart-description-${series.id}`;
  const firstDate = points[0]?.date ?? "";
  const lastDate = points[points.length - 1]?.date ?? "";
  return (
    <figure className={`chart-panel chart-${series.id}`}>
      <figcaption>{translate(locale, series.labelKey)}</figcaption>
      <svg
        className="result-chart"
        viewBox="0 0 720 220"
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>{translate(locale, series.labelKey)}</title>
        <desc id={descriptionId}>
          {translate(locale, "chart.description", {
            start: firstDate,
            end: lastDate,
            count: String(points.length),
          })}
        </desc>
        <line className="chart-gridline" x1="24" y1="206" x2="696" y2="206" />
        <polyline points={path} fill="none" stroke={series.color} strokeWidth="2.5" />
        {tradeMarkers.map(({ trade, point, index }) => (
          <circle
            className={`trade-marker trade-marker-${trade.side}`}
            key={`${trade.date}-${trade.side}-${index}`}
            cx={point.x}
            cy={point.y}
            r="4"
            aria-hidden="true"
          >
            <title>{`${trade.date} ${translate(locale, `trade.side.${trade.side}`)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="chart-date-range" aria-hidden="true">
        <span>{firstDate}</span><span>{lastDate}</span>
      </div>
    </figure>
  );
}

export function ResultsCharts({
  locale,
  dailyAssets,
  trades,
  visibleSeriesIds,
  onSeriesChange,
}: ResultsChartsProps) {
  const visible = SERIES.filter((series) => visibleSeriesIds.includes(series.id));
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
              {translate(locale, series.labelKey)}
            </button>
          );
        })}
      </div>
      {visible.length === 0 ? (
        <p className="chart-empty">{translate(locale, "chart.noVisibleSeries")}</p>
      ) : visible.map((series) => (
        <ChartPanel
          key={series.id}
          locale={locale}
          dailyAssets={dailyAssets}
          trades={trades}
          series={series}
        />
      ))}
    </div>
  );
}
