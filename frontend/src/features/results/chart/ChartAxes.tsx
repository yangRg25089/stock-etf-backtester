import { translate, type Locale } from "../../../i18n/messages";
import type { ChartCursor } from "../ChartCrosshair";
import type { ChartViewport } from "../chartViewport";
import type { AxisSeriesId, ChartScale } from "./chartTypes";
import { CHART, COMPACT_CHART, dateTicks, xPosition } from "./chartScale";
import { formatAxisValue, axisTitle } from "./chartFormat";

export function ChartAxes({
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

export function ChartDateAxis({ dates, locale, viewport, cursor }: {
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
