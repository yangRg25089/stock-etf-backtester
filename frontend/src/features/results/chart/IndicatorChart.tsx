import { useId } from "react";
import type { DailyAsset } from "../../../api/generated";
import { translate, type Locale } from "../../../i18n/messages";
import { ChartCrosshair, type ChartCursor } from "../ChartCrosshair";
import type { ChartInteractionProps } from "../useChartInteraction";
import { chartSegments } from "../technicalIndicators";
import type { SeriesSample } from "../chartModel";
import { samplesInViewport, visibleIndexRange, type ChartViewport } from "../chartViewport";
import type { IndicatorSeriesDefinition, IndicatorComparison } from "./chartTypes";
import { CHART, COMPACT_CHART, chartScale, lineCoordinates, xPosition } from "./chartScale";
import { axisTitle, seriesLabel, formatAxisValue } from "./chartFormat";
import { ChartAxes } from "./ChartAxes";
import { HighlightArea } from "./ChartSeries";

export function IndicatorChart({
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
  const fillId = useId();
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
            {chartSegments(points).map((segment, index) => <HighlightArea key={`fill-${index}`} points={segment}
              color={series.color} gradientId={`${fillId}-${index}`} bottom={geometry.height - geometry.bottom} />)}
            {comparisons.flatMap((comparison, comparisonIndex) => chartSegments(lineCoordinates(
              samplesInViewport(comparison.samples, viewport, assets.length), scale, assets.length, viewport,
            )).map((segment, index) => <HighlightArea key={`comparison-fill-${comparisonIndex}-${index}`} points={segment}
              color={comparison.color} gradientId={`${fillId}-${comparisonIndex}-${index}-comparison`} bottom={geometry.height - geometry.bottom} />))}
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
