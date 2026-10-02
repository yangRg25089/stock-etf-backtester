import type { DailyAsset, StrategyRun, TechnicalIndicatorSeries } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import type { SeriesSample } from "./chartModel";

export interface TechnicalChartLine {
  id: string;
  kind: TechnicalIndicatorSeries["kind"];
  label: string;
  color: string;
  dashed: boolean;
  samples: SeriesSample[];
}

function seriesHash(value: string): number {
  return [...value].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0);
}

export function savedTechnicalIndicators(results: StrategyRun[]): TechnicalIndicatorSeries[] {
  const series = new Map<string, TechnicalIndicatorSeries>();
  for (const result of results) for (const indicator of result.technicalIndicators ?? []) {
    const key = JSON.stringify([indicator.kind, indicator.period, indicator.deviations ?? null, indicator.samples ?? []]);
    if (!series.has(key)) series.set(key, indicator);
  }
  return [...series.values()];
}

export function chartSegments<T extends { index: number }>(points: T[]): T[][] {
  const segments: T[][] = [];
  for (const point of points) {
    const last = segments.at(-1);
    const previous = last?.at(-1);
    if (last && previous && previous.index + 1 === point.index) last.push(point);
    else segments.push([point]);
  }
  return segments;
}

export function technicalChartLines(series: TechnicalIndicatorSeries[], assets: DailyAsset[], locale: Locale): TechnicalChartLine[] {
  const dates = new Map(assets.map((asset, index) => [asset.date, index]));
  const colors = ["#b06a16", "#385cbe", "#147c91", "#a7373a", "#147d68", "#7656a6"];
  const labels = new Map<string, number>();
  return series.flatMap(indicator => {
    const base = indicator.kind === "bollinger" ? `BOLL(${indicator.period}, ${indicator.deviations}σ)`
      : `${indicator.kind.toUpperCase()}${indicator.period}`;
    const count = (labels.get(base) ?? 0) + 1;
    labels.set(base, count);
    const label = count > 1 ? `${base} · ${count}` : base;
    const hash = seriesHash(`${indicator.kind}:${indicator.period}:${indicator.deviations ?? ""}`);
    const identity = seriesHash(JSON.stringify(indicator.samples ?? [])).toString(36);
    const components: Array<"value" | "lower" | "upper"> = indicator.kind === "bollinger" ? ["value", "lower", "upper"] : ["value"];
    return components.map(component => ({
      id: `technical-${indicator.kind}-${indicator.period}-${indicator.deviations ?? ""}-${component}-${identity}`,
      kind: indicator.kind,
      label: indicator.kind === "bollinger" ? `${label} · ${translate(locale, `chart.band.${component}`)}` : label,
      color: colors[hash % colors.length],
      dashed: component !== "value" || indicator.kind === "ma",
      samples: (indicator.samples ?? []).flatMap(sample => {
        const index = dates.get(sample.date);
        const raw = sample[component];
        const value = raw === null || raw === undefined || raw === "" ? null : Number(raw);
        return index === undefined || value === null || !Number.isFinite(value) ? [] : [{ date: sample.date, index, value }];
      }),
    }));
  });
}
