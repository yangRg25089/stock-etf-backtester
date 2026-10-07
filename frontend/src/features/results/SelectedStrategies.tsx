import { useEffect, useRef, type CSSProperties } from "react";
import type { RunResponse } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { resultColor } from "./colors";
import { resultDisplayName } from "./model";

interface SelectedStrategiesProps {
  run: RunResponse | null;
  ids: string[];
  focusedResultId: string | null;
  locale: Locale;
  busy?: boolean;
  onSelect(id: string): void;
}

export function SelectedStrategies({ run, ids, focusedResultId, locale, busy = false, onSelect }: SelectedStrategiesProps) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const revealFocused = () => {
      if (element.scrollWidth <= element.clientWidth) return;
      const focused = element.querySelector<HTMLElement>('[aria-current="true"]');
      if (!focused) return;
      const bounds = element.getBoundingClientRect(), target = focused.getBoundingClientRect();
      if (target.left < bounds.left) element.scrollLeft += target.left - bounds.left;
      else if (target.right > bounds.right) element.scrollLeft += target.right - bounds.right;
    };
    revealFocused();
    const observer = new ResizeObserver(revealFocused);
    observer.observe(element);
    return () => observer.disconnect();
  }, [focusedResultId, ids, locale]);
  const results = run?.result?.strategyRuns ?? [];
  const selected = results.filter(result => ids.includes(result.id));
  if (!selected.length) return null;
  return <div ref={strip} className="selected-strategies" role="group" tabIndex={0} aria-label={translate(locale, "results.selectDetails")}>
    {selected.map(result => <button type="button" key={result.id} className={`selected-strategy-chip${result.id === focusedResultId ? " is-focused" : ""}`}
      data-result-id={result.id} aria-current={result.id === focusedResultId ? "true" : undefined}
      aria-pressed={result.id === focusedResultId}
      aria-label={`${resultDisplayName(locale, result, results)} · ${translate(locale, "results.focusedDetails")}`}
      disabled={busy} onClick={() => { if (!busy) onSelect(result.id); }}
      style={{ "--result-color": resultColor(results.indexOf(result)) } as CSSProperties}
      title={resultDisplayName(locale, result, results)}>
      <span aria-hidden="true">✓</span><span className="selected-strategy-name">{resultDisplayName(locale, result, results)}</span>
      {result.id === focusedResultId && <span className="selected-strategy-detail-label">{translate(locale, "results.focusedDetails")}</span>}
    </button>)}
  </div>;
}
