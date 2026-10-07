import type { CSSProperties } from "react";
import type { RunResponse } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { resultColor } from "./colors";
import { resultDisplayName } from "./model";

export function SelectedStrategies({ run, ids, focusedResultId, locale }: { run: RunResponse | null; ids: string[]; focusedResultId: string | null; locale: Locale }) {
  const results = run?.result?.strategyRuns ?? [];
  const selected = results.filter(result => ids.includes(result.id));
  if (!selected.length) return null;
  return <div className="selected-strategies" role="status" aria-label={translate(locale, "chart.totalAsset")}>
    {selected.map(result => <span key={result.id} className={`selected-strategy-chip${result.id === focusedResultId ? " is-focused" : ""}`}
      data-result-id={result.id} aria-current={result.id === focusedResultId ? "true" : undefined}
      style={{ "--result-color": resultColor(results.indexOf(result)) } as CSSProperties}
      title={resultDisplayName(locale, result, results)}>
      <span aria-hidden="true">✓</span><span className="selected-strategy-name">{resultDisplayName(locale, result, results)}</span>
      {result.id === focusedResultId && <span className="selected-strategy-detail-label">{translate(locale, "results.tab.details")}</span>}
    </span>)}
  </div>;
}
