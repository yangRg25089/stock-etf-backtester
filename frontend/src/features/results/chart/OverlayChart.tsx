import { useId } from "react";
import type { DailyAsset, Trade } from "../../../api/generated";
import { translate, type Locale } from "../../../i18n/messages";
import { ChartCrosshair, ChartReadout, type ChartCursor, type CursorReading } from "../ChartCrosshair";
import type { ChartInteractionProps } from "../useChartInteraction";
import { tradeMarkerPoints } from "../chartTradeMarkers";
import { chartSegments, type TechnicalChartLine } from "../technicalIndicators";
import { normalizeValueToBase100, type ChartSeriesId, type NormalizedSeries, type SeriesSample } from "../chartModel";
import { samplesInViewport, visibleIndexRange, type ChartViewport } from "../chartViewport";
import { numericValue } from "../format";
import type { SeriesDefinition, NormalizedComparisonSeries, IndicatorComparison } from "./chartTypes";
import { CHART, MAIN_WITHOUT_DATES, chartScale, xPosition } from "./chartScale";
import { axisTitle, seriesLabel, formatAxisValue, preciseValue } from "./chartFormat";
import { seriesIdentity } from "./chartSeriesModel";
import { ChartAxes } from "./ChartAxes";
import { HighlightArea } from "./ChartSeries";
import { useSeriesHighlight } from "./useSeriesHighlight";

export function OverlayChart({
  locale,
  assets,
  trades,
  series,
  indicatorSeries,
  samplesById,
  normalizedById,
  comparisonNormalized,
  strategyOrder,
  currency,
  viewport,
  chartInteractionProps,
  cursor,
  volatilityComparisons,
  technicalLines,
  onTradeSelect,
}: {
  locale: Locale;
  assets: DailyAsset[];
  trades: Trade[];
  series: SeriesDefinition[];
  indicatorSeries: Array<SeriesDefinition & { id: "drawdown" | "vix" }>;
  samplesById: Map<ChartSeriesId, SeriesSample[]>;
  normalizedById: Map<ChartSeriesId, NormalizedSeries | null>;
  comparisonNormalized: NormalizedComparisonSeries[];
  strategyOrder: string[];
  currency?: string;
  viewport: ChartViewport;
  chartInteractionProps: ChartInteractionProps;
  cursor: ChartCursor | null;
  volatilityComparisons: IndicatorComparison[];
  technicalLines: TechnicalChartLine[];
  onTradeSelect?(resultId: string, index: number): void;
}) {
  const geometry = MAIN_WITHOUT_DATES;
  const gradientId = `chart-gradient-${useId()}`;
  const normalized = series.flatMap((definition) => {
    const result = normalizedById.get(definition.id);
    return result ? [{ definition, result }] : [];
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
      series: { id: seriesIdentity(definition), seriesId: definition.id, label: axisTitle(locale, definition.id, currency) },
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
    readings.push({ label: line.label, value: preciseValue(point?.value, locale, line.kind === "rsi" ? undefined : currency), color: line.color,
      ...(line.kind === "rsi" ? {} : { series: { id: line.id, label: line.label } }),
    });
  }
  const ranks = new Map(strategyOrder.map((id, index) => [id, index + 1]));
  const strategyReadings = tradeSeries.map(strategy => {
    const point = strategy.result.points.find(sample => sample.index === readingIndex);
    const asset = strategy.dailyAssets.find(asset => asset.date === readingDate);
    return {
      id: strategy.id, label: strategy.label, color: strategy.color, rank: ranks.get(strategy.id),
      seriesId: primaryAsset && strategy.id === seriesIdentity(primaryAsset.definition) ? "totalAsset" : strategy.id,
      readings: [
        { label: translate(locale, "chart.asset"), value: preciseValue(numericValue(asset?.totalAsset), locale, currency) },
        { label: translate(locale, "chart.principal"), value: preciseValue(numericValue(asset?.totalContributed), locale, currency) },
        { label: translate(locale, "chart.principalIndex"), value: point?.indexValue.toFixed(1) ?? "—" },
      ],
    };
  }).sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity));
  return (
    <figure className="chart-panel chart-overlay" data-window-start={viewport.start} data-window-end={viewport.end}>
      <p className="chart-overlay-description sr-only">{translate(locale, "chart.overlayDescription")}</p>
      <div className="chart-core-readout-row" role="group" aria-label={translate(locale, "chart.savedReadings")}>
        <ChartReadout date={readingDate} readings={readings} strategies={strategyReadings} inspection={highlight} />
      </div>
      <div className="chart-canvas">
        <svg
          {...chartInteractionProps}
          className="result-chart"
          viewBox={`0 0 ${CHART.width} ${geometry.height}`}
          role={onTradeSelect ? "group" : "img"}
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
            return tradeMarkerPoints(strategy.trades, points).map(({ trade, index, price, coordinates, x, y }) => (
              <g className={onTradeSelect ? "chart-trade-action" : undefined} key={`${strategy.id}-${trade.date}-${trade.side}-${index}`}
                role={onTradeSelect ? "button" : undefined} tabIndex={onTradeSelect ? 0 : undefined}
                aria-label={onTradeSelect ? `${strategy.label} · ${translate(locale, "trade.explain.open", { date: trade.date, side: translate(locale, `trade.side.${trade.side}`) })}` : undefined}
                onPointerDown={onTradeSelect ? event => event.stopPropagation() : undefined}
                onClick={onTradeSelect ? event => { event.stopPropagation(); event.currentTarget.focus(); onTradeSelect(strategy.id, index); } : undefined}
                onKeyDown={onTradeSelect ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); onTradeSelect(strategy.id, index); } } : undefined}>
                {onTradeSelect && <circle className="chart-trade-hit-area" cx={x} cy={y} r="12" />}
                <polygon className={`chart-trade-marker chart-trade-marker-${trade.side}`} data-anchor-series="totalAsset" data-result-id={strategy.id}
                  color={strategy.color} points={coordinates} vectorEffect="non-scaling-stroke">
                <title>{`${strategy.label} · ${trade.date} ${translate(locale, `trade.side.${trade.side}`)} ${formatAxisValue(price, locale, "price", trade.currency ?? currency)}`}</title>
                </polygon>
              </g>
            ));
          })}
          {cursor && <ChartCrosshair date={cursorDate} x={xPosition(cursor.index, dateCount, viewport)} y={cursorY}
            valueLabel={cursorValue === null ? undefined : formatAxisValue(cursorValue, locale, "index")} geometry={geometry} points={[...cursorPoints, ...comparisonCursorPoints, ...technicalCursorPoints]} />}
        </svg>
      </div>
    </figure>
  );
}
