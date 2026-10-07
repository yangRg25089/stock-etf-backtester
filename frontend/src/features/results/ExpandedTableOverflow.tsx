import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Keep the original semantic header and sorting controls aligned with its rows.
 * Horizontal overflow creates a scroll ancestor, so CSS sticky alone cannot
 * follow the outer result/page viewport. Translate only this saved header. */
export function ExpandedTableOverflow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const table = element.querySelector("table");
      const head = table?.tHead;
      if (!table || !head) return;
      const region = element.closest(".table-height-region, .performance-group");
      const controls = region?.querySelector<HTMLElement>(".table-height-controls, .performance-group-heading");
      const viewport = element.closest(".workbench-results");
      const viewportStyle = viewport ? getComputedStyle(viewport) : null;
      const outerTop = viewport && viewportStyle?.overflowY === "auto" ? viewport.getBoundingClientRect().top : 0;
      const rect = table.getBoundingClientRect();
      const desiredTop = Math.max(outerTop, controls?.getBoundingClientRect().bottom ?? outerTop);
      const offset = Math.max(0, Math.min(desiredTop - rect.top, rect.height - head.offsetHeight));
      element.style.setProperty("--table-header-offset", `${offset}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    update();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, []);
  return <div ref={ref} className="table-expanded-overflow">{children}</div>;
}
