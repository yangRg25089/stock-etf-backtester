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

export function hasScrollRoom(area: ScrollArea, delta: number): boolean {
  return delta > 0 ? area.scrollTop + area.clientHeight < area.scrollHeight
    : delta < 0 && area.scrollTop > 0;
}

export function wheelDeltaPixels(delta: number, mode: number, lineHeight: number, pageHeight: number): number {
  return delta * (mode === 1 ? lineHeight : mode === 2 ? pageHeight : 1);
}

function scrollParentWithRoom(area: HTMLElement, delta: number): HTMLElement | null {
  for (let parent = area.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (!/^(auto|scroll)$/.test(style.overflowY) && parent !== document.scrollingElement) continue;
    if (hasScrollRoom(parent, delta)) return parent;
    if (style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return null;
  }
  return null;
}

function passBoundaryScroll(event: WheelEvent) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const area = event.target instanceof Element ? event.target.closest<HTMLElement>(".comparison-table-scroll, .data-table-scroll, .strategy-card-list") : null;
  if (!area || !(event.currentTarget instanceof Element) || !event.currentTarget.contains(area)
    || area.scrollHeight <= area.clientHeight) return;
  const style = getComputedStyle(area);
  if (!/^(auto|scroll)$/.test(style.overflowY)) return;
  if (area.matches(".strategy-card-list") && style.overscrollBehaviorY !== "auto") return;
  const delta = wheelDeltaPixels(event.deltaY, event.deltaMode, parseFloat(style.lineHeight) || 16, area.clientHeight);
  if (!atScrollBoundary(area, delta)) return;
  const parent = scrollParentWithRoom(area, delta);
  if (!parent) return;
  // Cancel the native chain so a browser that also propagates does not scroll twice.
  event.preventDefault();
  parent.scrollTop += delta;
}

function attachTouchBoundary(area: HTMLElement): () => void {
  let previous: Touch | null = null;
  let start: Touch | null = null;
  let dragging = false;
  const clear = () => { previous = null; start = null; dragging = false; };
  const track = (event: TouchEvent) => {
    clear();
    if (event.touches.length !== 1 || area.scrollHeight <= area.clientHeight
      || getComputedStyle(area).overscrollBehaviorY !== "auto") return;
    previous = start = event.touches[0];
  };
  const pass = (event: TouchEvent) => {
    if (!previous || !start) return;
    if (event.touches.length !== 1 || event.touches[0].identifier !== previous.identifier) { clear(); return; }
    const touch = event.touches[0];
    const delta = previous.clientY - touch.clientY;
    const horizontal = touch.clientX - previous.clientX;
    previous = touch;
    if (event.defaultPrevented || !event.cancelable || Math.abs(horizontal) >= Math.abs(delta)
      || !atScrollBoundary(area, delta)) return;
    const parent = scrollParentWithRoom(area, delta);
    if (!parent) return;
    // Claim a boundary swipe before native scroll latching makes later events noncancelable.
    event.preventDefault();
    if (!dragging) {
      const verticalDistance = start.clientY - touch.clientY;
      if (Math.abs(verticalDistance) < 8 || Math.abs(touch.clientX - start.clientX) >= Math.abs(verticalDistance)) return;
      dragging = true;
    }
    parent.scrollTop += delta;
  };
  area.addEventListener("touchstart", track, { passive: true });
  area.addEventListener("touchmove", pass, { passive: false });
  area.addEventListener("touchend", clear);
  area.addEventListener("touchcancel", clear);
  return () => {
    area.removeEventListener("touchstart", track);
    area.removeEventListener("touchmove", pass);
    area.removeEventListener("touchend", clear);
    area.removeEventListener("touchcancel", clear);
  };
}

export function useScrollBoundary<T extends HTMLElement = HTMLDivElement>(): RefCallback<T> {
  const attached = useRef<T | null>(null);
  const detachTouch = useRef<(() => void) | null>(null);
  return useCallback(node => {
    detachTouch.current?.();
    detachTouch.current = null;
    attached.current?.removeEventListener("wheel", passBoundaryScroll);
    attached.current = node;
    node?.addEventListener("wheel", passBoundaryScroll, { passive: false });
    const list = node?.querySelector<HTMLElement>(".strategy-card-list");
    if (list) detachTouch.current = attachTouchBoundary(list);
  }, []);
}
