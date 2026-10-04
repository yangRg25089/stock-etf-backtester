import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { translate } from "../../i18n/messages";
import { useChartInteraction } from "./useChartInteraction";
import { technicalChartLines } from "./technicalIndicators";
import { isVolatilityObservation } from "./model";
import { numericValue } from "./format";
import { visibleIndexRange } from "./chartViewport";
import type { ResultsChartsProps, SeriesDefinition } from "./chart/chartTypes";
import { CHART } from "./chart/chartScale";
import { ChartControls } from "./chart/ChartControls";
import { SERIES, samplesForSeries, buildChartSeriesModel } from "./chart/chartSeriesModel";
import { ChartDateAxis } from "./chart/ChartAxes";
import { IndicatorChart } from "./chart/IndicatorChart";
import { OverlayChart } from "./chart/OverlayChart";

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
  onTradeSelect,
}: ResultsChartsProps) {
  const [hiddenTechnicalKinds, setHiddenTechnicalKinds] = useState<string[]>([]);
  const interaction = useChartInteraction(dailyAssets.length, CHART, busy);
  const { viewport, cursor, wheelZoomEnabled, chartContainerRef, chartInteractionProps } = interaction;
  const rootElement = useRef<HTMLDivElement | null>(null);
  const containerRef = useCallback((element: HTMLDivElement | null) => {
    chartContainerRef(element);
    rootElement.current = element;
  }, [chartContainerRef]);
  const volatilityComparisons = volatilitySeries.slice(1).map((source, index) => ({
    label: source.symbol.replace(/^\^/, ""), color: ["#b06a16", "#385cbe"][index % 2],
    samples: samplesForSeries("vix", dailyAssets, source.signals, source.symbol),
  }));
  const { samplesById, normalizedById, comparisonAvailable, comparisonNormalized } = useMemo(
    () => buildChartSeriesModel(dailyAssets, signals, comparisonSeries, vixSymbol),
    [dailyAssets, signals, comparisonSeries, vixSymbol],
  );
  const available = useMemo(
    () => SERIES.filter((series) => series.id === "totalAsset"
      ? (showFocusedAsset && normalizedById.get(series.id) !== null) || comparisonAvailable
      : series.id === "price"
        ? normalizedById.get(series.id) !== null
      : (samplesById.get(series.id)?.length ?? 0) > 0),
    [samplesById, normalizedById, showFocusedAsset, comparisonAvailable],
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
  const visibleComparisons = selected.some(series => series.id === "totalAsset") ? comparisonNormalized : [];
  return (
    <div className={`charts-content${wheelZoomEnabled ? " is-wheel-zoom-active" : ""}`} ref={containerRef}>
      <ChartControls locale={locale} currency={currency} busy={busy} available={available} selected={selected}
        savedLines={savedLines} hiddenTechnicalKinds={hiddenTechnicalKinds} priceVisible={priceVisible}
        visibleStartDate={visibleStartDate} visibleEndDate={visibleEndDate} onSeriesChange={onSeriesChange} interaction={interaction}
        onTechnicalToggle={(kind, visible) => setHiddenTechnicalKinds(current => visible ? [...current, kind] : current.filter(item => item !== kind))} />
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
              comparisonNormalized={visibleComparisons}
              strategyOrder={strategyOrder}
              currency={currency}
              viewport={viewport}
              chartInteractionProps={chartInteractionProps}
              cursor={cursor}
              volatilityComparisons={indicatorSeries.some(series => series.id === "vix") ? volatilityComparisons : []}
              technicalLines={technicalLines}
              onTradeSelect={busy ? undefined : onTradeSelect}
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
