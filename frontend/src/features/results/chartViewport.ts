export interface ChartViewport {
  start: number;
  end: number;
}

export const FULL_CHART_VIEWPORT: ChartViewport = { start: 0, end: 1 };
export const MIN_CHART_VIEWPORT_SPAN = 0.02;

export function clampChartViewport(
  viewport: ChartViewport,
  minimumSpan = MIN_CHART_VIEWPORT_SPAN,
): ChartViewport {
  const requestedSpan = viewport.end - viewport.start;
  const span = Math.min(1, Math.max(minimumSpan, requestedSpan));
  const start = Math.min(1 - span, Math.max(0, viewport.start));
  return { start, end: start + span };
}

export function panChartViewport(
  viewport: ChartViewport,
  plotDeltaRatio: number,
): ChartViewport {
  const current = clampChartViewport(viewport);
  const shift = plotDeltaRatio * (current.end - current.start);
  return clampChartViewport({ start: current.start - shift, end: current.end - shift });
}

export function zoomChartViewport(
  viewport: ChartViewport,
  factor: number,
  anchorRatio = 0.5,
): ChartViewport {
  const current = clampChartViewport(viewport);
  const currentSpan = current.end - current.start;
  const nextSpan = Math.min(1, Math.max(MIN_CHART_VIEWPORT_SPAN, currentSpan * factor));
  const safeAnchorRatio = Math.min(1, Math.max(0, anchorRatio));
  const anchor = current.start + currentSpan * safeAnchorRatio;
  const nextStart = anchor - nextSpan * safeAnchorRatio;
  return clampChartViewport({ start: nextStart, end: nextStart + nextSpan });
}

export function pinchChartViewport(
  viewport: ChartViewport,
  startDistance: number,
  currentDistance: number,
  startCenterRatio: number,
  currentCenterRatio: number,
): ChartViewport {
  if (!Number.isFinite(startDistance) || !Number.isFinite(currentDistance)
    || startDistance <= 0 || currentDistance <= 0) return clampChartViewport(viewport);
  const current = clampChartViewport(viewport);
  const span = current.end - current.start;
  const startRatio = Math.min(1, Math.max(0, startCenterRatio));
  const currentRatio = Math.min(1, Math.max(0, currentCenterRatio));
  const anchorDate = current.start + span * startRatio;
  const nextSpan = Math.min(1, Math.max(MIN_CHART_VIEWPORT_SPAN, span * startDistance / currentDistance));
  const nextStart = anchorDate - nextSpan * currentRatio;
  return clampChartViewport({ start: nextStart, end: nextStart + nextSpan });
}

export function visibleIndexRange(
  count: number,
  viewport: ChartViewport,
): { start: number; end: number } {
  const maximumIndex = Math.max(0, count - 1);
  const current = clampChartViewport(viewport);
  return {
    start: current.start * maximumIndex,
    end: current.end * maximumIndex,
  };
}

export function nearestChartIndex(
  count: number,
  viewport: ChartViewport,
  plotRatio: number,
): number | null {
  if (count === 0 || !Number.isFinite(plotRatio) || plotRatio < 0 || plotRatio > 1) return null;
  const range = visibleIndexRange(count, viewport);
  const first = Math.ceil(range.start);
  const last = Math.floor(range.end);
  if (first > last) return null;
  return Math.min(last, Math.max(first, Math.round(range.start + (range.end - range.start) * plotRatio)));
}

export function samplesInViewport<T extends { index: number }>(
  samples: T[],
  viewport: ChartViewport,
  count: number,
): T[] {
  if (samples.length === 0) return [];
  const range = visibleIndexRange(count, viewport);
  const visible = samples.filter((sample) => sample.index >= range.start && sample.index <= range.end);
  const before = [...samples].reverse().find((sample) => sample.index < range.start);
  const after = samples.find((sample) => sample.index > range.end);
  return [before, ...visible, after].filter((sample): sample is T => sample !== undefined);
}
