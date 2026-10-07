import { visibleIndexRange, type ChartViewport } from "../chartViewport";
import type { SeriesSample } from "../chartModel";
import type { ChartPoint, ChartScale } from "./chartTypes";

export const CHART = { height: 320, left: 92, right: 26, top: 20, bottom: 54, width: 800 };

export const MAIN_WITHOUT_DATES = { ...CHART, height: 274, bottom: 8 };

export const COMPACT_CHART = { ...CHART, height: 90, top: 8, bottom: 8 };

/** Keep the horizontal date mapping while giving narrow plots readable height. */
export function responsiveChartGeometry(geometry: typeof CHART, renderedWidth: number, pixelHeight?: number): typeof CHART {
  if (pixelHeight !== undefined && Number.isFinite(renderedWidth) && renderedWidth >= 680) {
    const scale = CHART.width / renderedWidth;
    return { ...geometry, height: pixelHeight * scale, top: geometry.top * scale, bottom: geometry.bottom * scale };
  }
  if (!Number.isFinite(renderedWidth) || renderedWidth <= 0 || renderedWidth >= 680) return geometry;
  const scale = CHART.width / renderedWidth;
  return { ...geometry, height: (geometry.height === COMPACT_CHART.height ? 90 : 240) * scale,
    top: geometry.top * scale, bottom: geometry.bottom * scale };
}

export function chartScale(
  values: number[],
  { maximumAtZero = false, fixedBounds }: { maximumAtZero?: boolean; fixedBounds?: [number, number] } = {},
  geometry = CHART,
): ChartScale {
  let rawMinimum = Infinity;
  let rawMaximum = -Infinity;
  for (const value of values) {
    rawMinimum = Math.min(rawMinimum, value);
    rawMaximum = Math.max(rawMaximum, value);
  }
  const span = rawMaximum - rawMinimum;
  const padding = span === 0
    ? Math.max(Math.abs(rawMaximum) * 0.05, maximumAtZero ? 0.01 : 1)
    : span * 0.08;
  const minimum = fixedBounds?.[0] ?? rawMinimum - padding;
  const maximum = fixedBounds?.[1] ?? (maximumAtZero ? 0 : rawMaximum + padding);
  const plotHeight = geometry.height - geometry.top - geometry.bottom;
  return {
    minimum,
    maximum,
    y: (value) => geometry.top + ((maximum - value) / (maximum - minimum)) * plotHeight,
  };
}

export function xPosition(index: number, count: number, viewport: ChartViewport): number {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  if (count <= 1) return CHART.left + plotWidth / 2;
  const dateRatio = index / (count - 1);
  return CHART.left + ((dateRatio - viewport.start) / (viewport.end - viewport.start)) * plotWidth;
}

export function dateTicks(dates: string[], viewport: ChartViewport): Array<{ date: string; x: number }> {
  if (dates.length === 0) return [];
  const range = visibleIndexRange(dates.length, viewport);
  const indexes = [...new Set(Array.from({ length: 7 }, (_, index) =>
    Math.round(range.start + (range.end - range.start) * index / 6),
  ))];
  return indexes.flatMap((index) => {
    const date = dates[index];
    if (!date) return [];
    const x = xPosition(index, dates.length, viewport);
    return [{ date, x: Math.min(CHART.width - CHART.right, Math.max(CHART.left, x)) }];
  });
}

export function lineCoordinates(
  points: SeriesSample[],
  scale: ChartScale,
  count: number,
  viewport: ChartViewport,
): ChartPoint[] {
  return points.map((point) => ({
    ...point,
    x: xPosition(point.index, count, viewport),
    y: scale.y(point.value),
  }));
}
