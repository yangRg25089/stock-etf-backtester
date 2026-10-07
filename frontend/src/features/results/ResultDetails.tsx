import { useState } from "react";
import type { Catalog, Diagnostic, RunResponse, StrategyRun } from "../../api/generated";
import type { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { CollapsiblePanel } from "../../shared/ui/CollapsiblePanel";
import type { WorkspaceState } from "../strategies/model";
import { DiagnosticList, type DiagnosticFieldAction } from "../runs/DiagnosticList";
import { ExportControls } from "./ExportControls";
import { ReportDownloadButton } from "./ReportDownloadButton";
import { ResultComparison } from "./ResultSummary";
import { DEFAULT_COMPARISON_SORT, type ComparisonSort } from "./comparisonModel";

interface ResultDetailsProps {
  catalog?: Catalog | null;
  busy?: boolean;
  locale: Locale;
  run: RunResponse | null;
  focusedResult: StrategyRun | null;
  state: WorkspaceState;
  error: RunApiError | null;
  fieldAction?(diagnostic: Diagnostic): DiagnosticFieldAction | null;
  comparisonSort?: ComparisonSort;
  onComparisonSortChange?(sort: ComparisonSort): void;
  candidateResult?: StrategyRun | null;
  candidatePending?: boolean;
  onSelectStrategy(id: string): void;
}

export function ResultDetails({
  catalog,
  busy = false,
  locale,
  run,
  focusedResult,
  state,
  error,
  fieldAction,
  comparisonSort = DEFAULT_COMPARISON_SORT,
  onComparisonSortChange,
  candidateResult = null,
  candidatePending = false,
  onSelectStrategy,
}: ResultDetailsProps) {
  const displayedResult = candidateResult ?? focusedResult;
  const strategyRuns = run?.result?.strategyRuns ?? [];
  const seenDiagnostics = new Set<string>();
  const diagnostics = [
    ...(error?.diagnostics ?? []),
    ...strategyRuns.flatMap((result) => [...(result.diagnostics ?? []), ...(result.metrics?.diagnostics ?? [])]),
  ].filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.code, diagnostic.fieldPath ?? null, diagnostic.messageKey, diagnostic.details ?? null]);
    if (seenDiagnostics.has(key)) return false;
    seenDiagnostics.add(key);
    return true;
  });
  const [expanded, setExpanded] = useState(true);
  const headerActions = (
    <div className="result-context-actions">
      <ExportControls locale={locale} runId={run?.runId ?? null} result={displayedResult} searchResult={focusedResult}
        busy={busy || candidatePending} />
      <ReportDownloadButton locale={locale} run={run} result={displayedResult} catalog={catalog}
        parent={candidateResult ? focusedResult : null} busy={busy || candidatePending} />
    </div>
  );

  return (
    <CollapsiblePanel
      id="result-details"
      className="result-details"
      title={translate(locale, "results.details")}
      expanded={expanded}
      onExpandedChange={setExpanded}
      headerActions={headerActions}
      alwaysVisible={(!run || error || diagnostics.length > 0) ? (
        <>
          {error && !diagnostics.some((diagnostic) => diagnostic.messageKey === error.messageKey) && (
            <p className="field-error" role="alert">
              {translate(locale, error.messageKey)}
              {error.retryAfterSeconds != null && ` ${translate(locale, "api.errors.retry_after", { seconds: String(error.retryAfterSeconds) })}`}
            </p>
          )}
          {diagnostics.length > 0 && (
            <div role="alert"><DiagnosticList locale={locale} diagnostics={diagnostics} fieldAction={busy ? undefined : fieldAction} /></div>
          )}
          {!run && !error && (
            <div className="empty-results" role="status">
              <span className="empty-mark" aria-hidden="true">⌁</span>
              <div>
                <strong>{translate(locale, "results.emptyTitle")}</strong>
                <p>{translate(locale, "results.emptyHelp")}</p>
              </div>
            </div>
          )}
        </>
      ) : undefined}
    >
      {run && (
        <section id="result-panel-comparison" className="result-comparison-primary">
          <h4 className="sr-only" id="result-comparison-heading">
            {translate(locale, "results.comparisonTitle")}
          </h4>
          <ResultComparison
            busy={busy}
            locale={locale}
            strategyRuns={strategyRuns}
            selectedResultIds={state.selectedResultIds ?? []}
            sort={comparisonSort}
            onSortChange={onComparisonSortChange}
            onSelect={onSelectStrategy}
          />
        </section>
      )}
    </CollapsiblePanel>
  );
}
