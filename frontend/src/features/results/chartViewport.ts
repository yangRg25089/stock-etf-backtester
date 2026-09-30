export interface ChartViewport {
  start: number;
  end: number;
}

export const FULL_CHART_VIEWPORT: ChartViewport = { start: 0, end: 1 };
export const MIN_CHART_VIEWPORT_SPAN = 0.02;
const WHEEL_ZOOM_FACTOR_PER_160_PIXELS = 0.92;
const WHEEL_ZOOM_CALIBRATION_DELTA = 160;
const WHEEL_ZOOM_SENSITIVITY = Math.log(1 / WHEEL_ZOOM_FACTOR_PER_160_PIXELS)
  / WHEEL_ZOOM_CALIBRATION_DELTA;
const WHEEL_LINE_HEIGHT_PIXELS = 16;
const WHEEL_PAGE_HEIGHT_PIXELS = 320;

export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixelsPerUnit = deltaMode === 1
    ? WHEEL_LINE_HEIGHT_PIXELS
    : deltaMode === 2
      ? WHEEL_PAGE_HEIGHT_PIXELS
      : 1;
  return Math.exp(deltaY * pixelsPerUnit * WHEEL_ZOOM_SENSITIVITY);
}

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
