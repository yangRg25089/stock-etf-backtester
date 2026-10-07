import { translate, type Locale } from "../../../i18n/messages";
import type { ChartCursor } from "../ChartCrosshair";
import type { ChartViewport } from "../chartViewport";
import type { AxisSeriesId, ChartScale } from "./chartTypes";
import { CHART, dateTicks, xPosition } from "./chartScale";
import { formatAxisValue, axisTitle } from "./chartFormat";

export function ChartAxes({
  dates,
  locale,
  scale,
  seriesId,
  currency,
  viewport,
  geometry,
  compact = false,
}: {
  dates: string[];
  locale: Locale;
  scale: ChartScale;
  seriesId: AxisSeriesId;
  currency?: string;
  viewport: ChartViewport;
  geometry: typeof CHART;
  compact?: boolean;
}) {
  const plotBottom = geometry.height - geometry.bottom;
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
      <text className="chart-axis-title chart-y-axis-title" transform={`translate(20 ${(geometry.top + plotBottom) / 2}) rotate(-90)`} textAnchor="middle">
        {axisTitle(locale, seriesId, currency, compact)}
      </text>
    </g>
  );
}

export function ChartDateAxis({ dates, locale, viewport, cursor, textScale = 1 }: {
  dates: string[];
  locale: Locale;
  viewport: ChartViewport;
  cursor: ChartCursor | null;
  textScale?: number;
}) {
  const date = cursor ? dates[cursor.index] : undefined;
  const ticks = dateTicks(dates, viewport);
  const cursorX = cursor ? xPosition(cursor.index, dates.length, viewport) : 0;
  const halfTag = 43 * textScale;
  const dateX = Math.min(CHART.width - CHART.right - halfTag, Math.max(CHART.left + halfTag, cursorX));
  return (
    <div className="chart-date-axis-row" data-window-start={viewport.start} data-window-end={viewport.end}>
      <svg className="chart-date-axis" viewBox={`0 0 800 ${44 * textScale}`} role="img" aria-label={translate(locale, "chart.dateAxis")}>
        {ticks.map(({ date: tickDate, x }, index) => (
          <text key={tickDate} className="chart-tick-label chart-x-tick" data-tick-index={index} x={x} y={18 * textScale}
            textAnchor={ticks.length > 1 && index === ticks.length - 1 ? "end" : "middle"}>{tickDate}</text>
        ))}
        {date && <g aria-hidden="true">
          <rect className="chart-cursor-tag" x={dateX - halfTag} y={2 * textScale} width={86 * textScale} height={19 * textScale} rx="2" />
          <text className="chart-cursor-label chart-cursor-date" x={dateX} y={15 * textScale} textAnchor="middle">{date}</text>
        </g>}
        <text className="chart-axis-title chart-x-axis-title" x={(CHART.left + CHART.width - CHART.right) / 2} y={36 * textScale} textAnchor="middle">{translate(locale, "chart.dateAxis")}</text>
      </svg>
    </div>
  );
}
