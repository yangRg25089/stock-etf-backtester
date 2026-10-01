import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefCallback } from "react";
import type { ChartCursor } from "./ChartCrosshair";
import { FULL_CHART_VIEWPORT, nearestChartIndex, panChartViewport, visibleIndexRange, wheelZoomFactor, zoomChartViewport, type ChartViewport } from "./chartViewport";

export interface ChartInteractionProps {
  onPointerDown(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerMove(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerUp(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerCancel(event: ReactPointerEvent<SVGSVGElement>): void;
  onPointerLeave(): void;
  onBlur(): void;
  onKeyDown(event: ReactKeyboardEvent<SVGSVGElement>): void;
}

interface PointerDragState {
  pointerId: number;
  startRatio: number;
  viewport: ChartViewport;
}

interface ChartGeometry {
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function useChartInteraction(count: number, baseGeometry: ChartGeometry, disabled = false) {
  const [viewport, setViewport] = useState<ChartViewport>(FULL_CHART_VIEWPORT);
  const [wheelZoomEnabled, setWheelZoomEnabled] = useState(false);
  const [cursor, setCursor] = useState<ChartCursor | null>(null);
  const dragState = useRef<PointerDragState | null>(null);
  const plotWidth = baseGeometry.width - baseGeometry.left - baseGeometry.right;
  const pointerPosition = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * baseGeometry.width;
    const svg = event.currentTarget;
    const svgY = ((event.clientY - bounds.top) / bounds.height) * svg.viewBox.baseVal.height;
    return {
      ratio: (svgX - baseGeometry.left) / plotWidth,
      y: svgY,
      plotTop: Number(svg.dataset.plotTop),
      plotBottom: Number(svg.dataset.plotBottom),
    };
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    if (event.button !== 0) return;
    const position = pointerPosition(event);
    if (position.ratio < 0 || position.ratio > 1 || position.y < position.plotTop || position.y > position.plotBottom) return;
    event.preventDefault();
    setCursor(null);
    dragState.current = { pointerId: event.pointerId, startRatio: position.ratio, viewport };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const activeDrag = dragState.current;
    const position = pointerPosition(event);
    if (!activeDrag) {
      const index = position.y < position.plotTop || position.y > position.plotBottom
        ? null : nearestChartIndex(count, viewport, position.ratio);
      setCursor(index === null ? null : {
        index, chartId: event.currentTarget.dataset.chartId ?? "overlay",
        yRatio: (position.y - position.plotTop) / (position.plotBottom - position.plotTop),
      });
      return;
    }
    if (activeDrag.pointerId !== event.pointerId) return;
    const pointerDelta = position.ratio - activeDrag.startRatio;
    const nextViewport = panChartViewport(activeDrag.viewport, pointerDelta);
    setViewport(nextViewport);
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onPointerCancel = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragState.current?.pointerId === event.pointerId) dragState.current = null;
  };
  const zoomAt = (factor: number, anchorRatio = 0.5) => {
    if (disabled) return;
    setCursor(null);
    setViewport((current) => zoomChartViewport(current, factor, anchorRatio));
  };
  const onWheel = useCallback((event: WheelEvent) => {
    if (disabled) return;
    const svg = event.target instanceof Element ? event.target.closest("svg.result-chart") : null;
    if (!(svg instanceof SVGSVGElement)) return;
    if (!event.ctrlKey && !event.metaKey && !wheelZoomEnabled) return;
    event.preventDefault();
    if (event.deltaY === 0) return;
    setCursor(null);
    const bounds = svg.getBoundingClientRect();
    const svgX = ((event.clientX - bounds.left) / bounds.width) * baseGeometry.width;
    const anchorRatio = (svgX - baseGeometry.left) / plotWidth;
    const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
    setViewport((current) => zoomChartViewport(current, factor, anchorRatio));
  }, [baseGeometry.left, baseGeometry.width, plotWidth, wheelZoomEnabled, disabled]);
  const attachedWheelContainer = useRef<{ element: HTMLDivElement; handler: (event: WheelEvent) => void } | null>(null);
  const chartContainerRef: RefCallback<HTMLDivElement> = useCallback((element) => {
    const attached = attachedWheelContainer.current;
    if (attached) {
      attached.element.removeEventListener("wheel", attached.handler);
      attachedWheelContainer.current = null;
    }
    if (element) {
      // React's delegated wheel listener can be passive; this native listener can cancel intentional zoom.
      element.addEventListener("wheel", onWheel, { passive: false });
      attachedWheelContainer.current = { element, handler: onWheel };
    }
  }, [onWheel]);
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
    setCursor(null);
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setViewport((current) => panChartViewport(current, 0.12));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setViewport((current) => panChartViewport(current, -0.12));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(0.8);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAt(1.25);
    } else if (event.key === "Home") {
      event.preventDefault();
      setViewport(FULL_CHART_VIEWPORT);
    }
  };
  const chartInteractionProps: ChartInteractionProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerLeave: () => setCursor(null),
    onBlur: () => setCursor(null),
    onKeyDown,
  };
  const resetRange = () => { setCursor(null); setViewport(FULL_CHART_VIEWPORT); };
  return {
    viewport, cursor, wheelZoomEnabled, chartContainerRef, chartInteractionProps, zoomAt, resetRange,
    toggleWheelZoom: () => setWheelZoomEnabled((enabled) => !enabled),
  };
}
