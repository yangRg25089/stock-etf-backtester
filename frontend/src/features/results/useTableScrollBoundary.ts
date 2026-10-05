import { useCallback, useRef, type RefCallback } from "react";

interface ScrollArea {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function atScrollBoundary(area: ScrollArea, delta: number): boolean {
  return delta > 0 ? area.scrollTop + area.clientHeight >= area.scrollHeight - 1
    : delta < 0 && area.scrollTop <= 1;
}

export function wheelDeltaPixels(delta: number, mode: number, lineHeight: number, pageHeight: number): number {
  return delta * (mode === 1 ? lineHeight : mode === 2 ? pageHeight : 1);
}

function scrollParentWithRoom(table: HTMLElement, delta: number): HTMLElement | null {
  for (let parent = table.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/^(auto|scroll)$/.test(style.overflowY) && parent !== document.scrollingElement) continue;
    if (!atScrollBoundary(parent, delta)) return parent;
    if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return null;
  }
  return null;
}

function passBoundaryScroll(event: WheelEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const table = event.target instanceof Element ? event.target.closest<HTMLElement>(".comparison-table-scroll, .data-table-scroll") : null;
  if (!table || !(event.currentTarget instanceof Element) || !event.currentTarget.contains(table)
    || table.scrollHeight <= table.clientHeight) return;
  const style = getComputedStyle(table);
  if (!/^(auto|scroll)$/.test(style.overflowY)) return;
  const delta = wheelDeltaPixels(event.deltaY, event.deltaMode, parseFloat(style.lineHeight) || 16, table.clientHeight);
  if (!atScrollBoundary(table, delta)) return;
  const parent = scrollParentWithRoom(table, delta);
  if (!parent) return;
  // Cancel the native chain so a browser that also propagates does not scroll twice.
  event.preventDefault();
  parent.scrollTop += delta;
}

export function useTableScrollBoundary(): RefCallback<HTMLDivElement> {
  const attached = useRef<HTMLDivElement | null>(null);
  return useCallback(node => {
    attached.current?.removeEventListener("wheel", passBoundaryScroll);
    attached.current = node;
    node?.addEventListener("wheel", passBoundaryScroll, { passive: false });
  }, []);
}
