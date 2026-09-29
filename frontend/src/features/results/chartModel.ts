export type ChartSeriesId = "price" | "totalAsset" | "drawdown" | "vix";

export interface SeriesSample {
  date: string;
  index: number;
  value: number;
}

export interface IndexedSample extends SeriesSample {
  indexValue: number;
}

export interface NormalizedSeries {
  baseDate: string;
  baseValue: number;
  points: IndexedSample[];
}

export function normalizeValueToBase100(
  seriesId: ChartSeriesId,
  value: number,
  baseline: number,
): number | null {
  if (!Number.isFinite(value)) return null;
  if (seriesId === "drawdown") return (1 + value) * 100;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;
  return (value / baseline) * 100;
}

export function normalizeSeriesToBase100(
  seriesId: ChartSeriesId,
  points: SeriesSample[],
): NormalizedSeries | null {
  const baselinePoint = seriesId === "drawdown"
    ? points[0]
    : points.find((point) => point.value > 0);
  if (!baselinePoint) return null;

  const samples = points
    .filter((point) => point.index >= baselinePoint.index)
    .flatMap((point) => {
      const indexValue = normalizeValueToBase100(seriesId, point.value, baselinePoint.value);
      return indexValue === null
        ? []
        : [{ ...point, indexValue }];
    });

  if (samples.length === 0) return null;
  return {
    baseDate: baselinePoint.date,
    baseValue: baselinePoint.value,
    points: samples,
  };
}
