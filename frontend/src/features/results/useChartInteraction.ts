import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { ChartCursor } from "./ChartCrosshair";
import { FULL_CHART_VIEWPORT, nearestChartIndex, panChartViewport, pinchChartViewport, visibleIndexRange, zoomChartViewport, type ChartViewport } from "./chartViewport";

export interface ChartInteractionProps {
  onPointerDown(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerUp(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerCancel(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerLeave(event: ReactPointerEvent<SVGSVGElement>): void;
  onBlur(): void;
  onKeyDown(event: ReactKeyboardEvent<SVGSVGElement>): void;
}

interface ChartGeometry {
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface PointerSample {
  pointerId: number;
  clientX: number;
  clientY: number;
  ratio: number;
  y: number;
  plotTop: number;
  plotBottom: number;
  chartId: string;
  svg: SVGSVGElement;
}

interface SingleTouchGesture {
  kind: "single";
  phase: "pending" | "pan" | "inspect";
  pointerId: number;
  startX: number;
  startY: number;
  startRatio: number;
  startPlotY: number;
  plotHeight: number;
  viewport: ChartViewport;
  verticalOffsetRatio: number;
  chartId: string;
}

interface PinchGesture {
  kind: "pinch";
  pointerIds: [number, number];
  startDistance: number;
  startCenterRatio: number;
  viewport: ChartViewport;
}

interface MouseGesture {
  pointerId: number;
  startX: number;
  startY: number;
  startRatio: number;
  startPlotY: number;
  plotHeight: number;
  viewport: ChartViewport;
  verticalOffsetRatio: number;
  chartId: string;
  dragging: boolean;
}

type TouchGesture = SingleTouchGesture | PinchGesture;

const TOUCH_MOVE_THRESHOLD = 7;
const LONG_PRESS_DELAY_MS = 1000;
const MAX_VERTICAL_OFFSET_RATIO = 4;

export function useChartInteraction(count: number, baseGeometry: ChartGeometry, disabled = false) {
  const [viewport, setViewport] = useState<ChartViewport>(FULL_CHART_VIEWPORT);
  const [verticalOffsetByChart, setVerticalOffsetByChart] = useState<Record<string, number>>({});
  const verticalOffsetsRef = useRef(verticalOffsetByChart);
  const [cursor, setCursor] = useState<ChartCursor | null>(null);
  const touchPointers = useRef(new Map<number, PointerSample>());
  const touchGesture = useRef<TouchGesture | null>(null);
  const mouseGesture = useRef<MouseGesture | null>(null);
  const longPressTimer = useRef<number | null>(null);

  const clearLongPressTimer = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const setVerticalOffset = (chartId: string, value: number) => {
    const bounded = Math.max(-MAX_VERTICAL_OFFSET_RATIO, Math.min(MAX_VERTICAL_OFFSET_RATIO, value));
    verticalOffsetsRef.current = { ...verticalOffsetsRef.current, [chartId]: bounded };
    setVerticalOffsetByChart(verticalOffsetsRef.current);
  };
  const sampleFromEvent = (event: ReactPointerEvent<SVGSVGElement>): PointerSample => {
    const svg = event.currentTarget;
    const bounds = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const svgX = ((event.clientX - bounds.left) / bounds.width) * viewBox.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * viewBox.height;
    return {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      ratio: (svgX - baseGeometry.left) / (baseGeometry.width - baseGeometry.left - baseGeometry.right),
      y,
      plotTop: Number(svg.dataset.plotTop),
      plotBottom: Number(svg.dataset.plotBottom),
      chartId: svg.dataset.chartId ?? "overlay",
      svg,
    };
  };
  const cursorFor = (sample: PointerSample, currentViewport = viewport): ChartCursor | null => {
    const index = nearestChartIndex(count, currentViewport, sample.ratio);
    if (index === null) return null;
    const plotHeight = sample.plotBottom - sample.plotTop;
    const yRatio = plotHeight > 0 ? (sample.y - sample.plotTop) / plotHeight : 0.5;
    return {
      index,
      chartId: sample.chartId,
      yRatio: Math.min(1, Math.max(0, yRatio)),
    };
  };
  const capturePointer = (sample: PointerSample) => {
    if (sample.svg.isConnected && !sample.svg.hasPointerCapture(sample.pointerId)) {
      sample.svg.setPointerCapture(sample.pointerId);
    }
  };
  const applyPan = (
    baseline: Pick<SingleTouchGesture, "startRatio" | "startPlotY" | "plotHeight" | "viewport" | "verticalOffsetRatio" | "chartId">,
    sample: PointerSample,
  ) => {
    setViewport(panChartViewport(baseline.viewport, sample.ratio - baseline.startRatio));
    const verticalDelta = sample.plotBottom > sample.plotTop
      ? (sample.y - baseline.startPlotY) / baseline.plotHeight
      : 0;
    setVerticalOffset(baseline.chartId, baseline.verticalOffsetRatio + verticalDelta);
  };
  const beginSingleTouch = (sample: PointerSample) => {
    const plotHeight = sample.plotBottom - sample.plotTop;
    const gesture: SingleTouchGesture = {
      kind: "single",
      phase: "pending",
      pointerId: sample.pointerId,
      startX: sample.clientX,
      startY: sample.clientY,
      startRatio: sample.ratio,
      startPlotY: sample.y,
      plotHeight,
      viewport,
      verticalOffsetRatio: verticalOffsetsRef.current[sample.chartId] ?? 0,
      chartId: sample.chartId,
    };
    touchGesture.current = gesture;
    clearLongPressTimer();
    longPressTimer.current = window.setTimeout(() => {
      const current = touchGesture.current;
      if (current?.kind !== "single" || current.phase !== "pending") return;
      current.phase = "inspect";
      const pointer = touchPointers.current.get(current.pointerId);
      if (pointer) {
        capturePointer(pointer);
        setCursor(cursorFor(pointer, current.viewport));
      }
    }, LONG_PRESS_DELAY_MS);
  };
  const beginPinch = (first: PointerSample, second: PointerSample) => {
    if (first.chartId !== second.chartId) return false;
    const startDistance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
    if (startDistance <= 0) return false;
    clearLongPressTimer();
    touchGesture.current = {
      kind: "pinch",
      pointerIds: [first.pointerId, second.pointerId],
      startDistance,
      startCenterRatio: (first.ratio + second.ratio) / 2,
      viewport,
    };
    setCursor(null);
    capturePointer(first);
    capturePointer(second);
    return true;
  };
  const startPendingTouchForRemainingPointer = () => {
    touchGesture.current = null;
    const remaining = touchPointers.current.values().next().value as PointerSample | undefined;
    if (remaining) beginSingleTouch(remaining);
  };

  useEffect(() => {
    if (disabled) {
      clearLongPressTimer();
      touchPointers.current.clear();
      touchGesture.current = null;
      mouseGesture.current = null;
      setCursor(null);
    }
    return clearLongPressTimer;
  }, [disabled]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return;
    const sample = sampleFromEvent(event);
    if (sample.ratio < 0 || sample.ratio > 1 || sample.y < sample.plotTop || sample.y > sample.plotBottom) return;

    if (event.pointerType === "touch") {
      if (touchPointers.current.size >= 2) return;
      touchPointers.current.set(sample.pointerId, sample);
      if (touchPointers.current.size === 1) {
        setCursor(null);
        beginSingleTouch(sample);
      } else {
        const [first, second] = touchPointers.current.values();
        if (!beginPinch(first, second)) touchPointers.current.delete(sample.pointerId);
      }
      return;
    }

    if (touchPointers.current.size > 0) return;
    mouseGesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRatio: sample.ratio,
      startPlotY: sample.y,
      plotHeight: sample.plotBottom - sample.plotTop,
      viewport,
      verticalOffsetRatio: verticalOffsetsRef.current[sample.chartId] ?? 0,
      chartId: sample.chartId,
      dragging: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const sample = sampleFromEvent(event);

    if (event.pointerType === "touch") {
      const previous = touchPointers.current.get(event.pointerId);
      if (!previous) return;
      touchPointers.current.set(event.pointerId, sample);
      const gesture = touchGesture.current;
      if (gesture?.kind === "pinch") {
        if (!gesture.pointerIds.includes(event.pointerId)) return;
        const first = touchPointers.current.get(gesture.pointerIds[0]);
        const second = touchPointers.current.get(gesture.pointerIds[1]);
        if (!first || !second) return;
        const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
        const centerRatio = (first.ratio + second.ratio) / 2;
        setViewport(pinchChartViewport(gesture.viewport, gesture.startDistance, distance, gesture.startCenterRatio, centerRatio));
        return;
      }
      if (gesture?.kind !== "single" || gesture.pointerId !== event.pointerId) return;
      if (gesture.phase === "pending") {
        if (Math.hypot(sample.clientX - gesture.startX, sample.clientY - gesture.startY) < TOUCH_MOVE_THRESHOLD) return;
        clearLongPressTimer();
        gesture.phase = "pan";
        setCursor(null);
        capturePointer(sample);
      }
      if (gesture.phase === "pan") applyPan(gesture, sample);
      else if (gesture.phase === "inspect") setCursor(cursorFor(sample, gesture.viewport));
      return;
    }

    const gesture = mouseGesture.current;
    if (gesture?.pointerId === event.pointerId) {
      if (!gesture.dragging && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) >= TOUCH_MOVE_THRESHOLD) {
        gesture.dragging = true;
        setCursor(null);
        capturePointer(sample);
      }
      if (gesture.dragging) applyPan(gesture, sample);
      return;
    }
    if (mouseGesture.current === null) {
      const outsidePlot = sample.y < sample.plotTop || sample.y > sample.plotBottom;
      setCursor(outsidePlot ? null : cursorFor(sample));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") {
      const gesture = touchGesture.current;
      const wasInspecting = gesture?.kind === "single" && gesture.phase === "inspect";
      touchPointers.current.delete(event.pointerId);
      if (gesture?.kind === "single" && gesture.pointerId === event.pointerId) clearLongPressTimer();
      if (touchPointers.current.size === 0) {
        touchGesture.current = null;
        clearLongPressTimer();
      } else if (gesture?.kind === "pinch" || (gesture?.kind === "single" && gesture.pointerId === event.pointerId)) {
        startPendingTouchForRemainingPointer();
      }
      if (!wasInspecting && touchPointers.current.size === 0 && gesture?.kind !== "single") setCursor(null);
      return;
    }
    if (mouseGesture.current?.pointerId === event.pointerId) mouseGesture.current = null;
  };

  const onPointerCancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") {
      touchPointers.current.delete(event.pointerId);
      clearLongPressTimer();
      touchGesture.current = null;
      touchPointers.current.clear();
      setCursor(null);
    } else if (mouseGesture.current?.pointerId === event.pointerId) {
      mouseGesture.current = null;
    }
  };

  const zoomAt = (factor: number, anchorRatio = 0.5) => {
    if (disabled) return;
    setCursor(null);
    setViewport(current => zoomChartViewport(current, factor, anchorRatio));
  };

  const resetRange = () => {
    clearLongPressTimer();
    touchPointers.current.clear();
    touchGesture.current = null;
    mouseGesture.current = null;
    setCursor(null);
    setViewport(FULL_CHART_VIEWPORT);
    verticalOffsetsRef.current = {};
    setVerticalOffsetByChart({});
  };

  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (disabled) return;
    if (event.key === "Escape") {
      setCursor(null);
      return;
    }
    if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const range = visibleIndexRange(count, viewport);
      const currentIndex = cursor?.index ?? nearestChartIndex(count, viewport, 0.5);
      if (currentIndex === null) return;
      const step = event.key === "ArrowLeft" ? -1 : 1;
      const index = Math.min(Math.floor(range.end), Math.max(Math.ceil(range.start), currentIndex + step));
      setCursor({ index, chartId: event.currentTarget.dataset.chartId ?? "overlay", yRatio: cursor?.yRatio ?? 0.5 });
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "+", "=", "-", "Home"].includes(event.key)) return;
    if (event.key === "Home") {
      event.preventDefault();
      resetRange();
      return;
    }
    setCursor(null);
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setViewport(current => panChartViewport(current, 0.12));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setViewport(current => panChartViewport(current, -0.12));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(0.8);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAt(1.25);
    }
  };

  const chartInteractionProps: ChartInteractionProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave: event => {
      if (event.pointerType !== "touch" && mouseGesture.current === null) setCursor(null);
    },
    onBlur: () => {
      setCursor(null);
    },
    onKeyDown,
  };

  return { viewport, verticalOffsetByChart, cursor, chartInteractionProps, zoomAt, resetRange };
}
