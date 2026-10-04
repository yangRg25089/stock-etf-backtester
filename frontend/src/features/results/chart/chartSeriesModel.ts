import type { DailyAsset, SignalEvaluation } from "../../../api/generated";
import { PRICE_COLOR, resultColor } from "../colors";
import { isVolatilityObservation } from "../model";
import { numericValue } from "../format";
import { normalizeSeriesToBase100, type ChartSeriesId, type SeriesSample, type NormalizedSeries } from "../chartModel";
import type { SeriesDefinition, StrategyChartSeries, NormalizedComparisonSeries } from "./chartTypes";

export const SERIES: SeriesDefinition[] = [
  { id: "price", color: PRICE_COLOR, labelKey: "chart.price" },
  { id: "totalAsset", color: resultColor(0), labelKey: "chart.totalAsset" },
  { id: "drawdown", color: "#a7373a", labelKey: "chart.drawdown" },
  { id: "vix", color: "#7656a6", labelKey: "chart.vix" },
];

export function seriesIdentity(series: SeriesDefinition): string {
  return series.resultId ?? series.id;
}

export function samplesForSeries(
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

/** Build from saved values once; controls, plots and readouts share the result. */
export function buildChartSeriesModel(
  assets: DailyAsset[],
  signals: SignalEvaluation[],
  comparisons: StrategyChartSeries[] = [],
  vixSymbol?: string,
) {
  const samplesById = new Map<ChartSeriesId, SeriesSample[]>(
    SERIES.map(({ id }) => [id, samplesForSeries(id, assets, signals, vixSymbol)]),
  );
  const normalizedById = new Map<ChartSeriesId, NormalizedSeries | null>(
    SERIES.filter(({ id }) => id === "price" || id === "totalAsset").map(({ id }) => [id,
      normalizeSeriesToBase100(id, samplesById.get(id) ?? []),
    ]),
  );
  const dateIndexes = new Map(assets.map((asset, index) => [asset.date, index]));
  let comparisonAvailable = false;
  const comparisonNormalized: NormalizedComparisonSeries[] = comparisons.flatMap(comparison => {
    const result = normalizeSeriesToBase100("totalAsset", samplesForSeries("totalAsset", comparison.dailyAssets, []));
    if (!result) return [];
    comparisonAvailable = true;
    const points = result.points.flatMap(point => {
      const index = dateIndexes.get(point.date);
      return index === undefined ? [] : [{ ...point, index }];
    });
    return points.length > 0 ? [{ ...comparison, result: { ...result, points } }] : [];
  });
  return { samplesById, normalizedById, comparisonAvailable, comparisonNormalized };
}
