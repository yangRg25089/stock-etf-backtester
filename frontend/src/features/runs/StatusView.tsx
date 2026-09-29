import type { Diagnostic, RunResponse } from "../../api/generated";
import { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { isPartialSuccess } from "../strategies/model";

interface StatusViewProps {
  locale: Locale;
  run: RunResponse | null;
  error: RunApiError | null;
}

export function DiagnosticList({ locale, diagnostics }: { locale: Locale; diagnostics: Diagnostic[] }) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="diagnostic-list">
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code}-${diagnostic.fieldPath ?? "run"}-${index}`}>
          <span className={`severity severity-${diagnostic.severity ?? "error"}`}>
            {translate(locale, `severity.${diagnostic.severity ?? "error"}`)}
          </span>
          <span>{translate(locale, diagnostic.messageKey)}</span>
        </li>
      ))}
    </ul>
  );
}

export function StatusView({ locale, run, error }: StatusViewProps) {
  if (!run && !error) {
    return (
      <div className="empty-results" role="status" aria-live="polite">
        <span className="empty-mark" aria-hidden="true">⌁</span>
        <div>
          <strong>{translate(locale, "results.emptyTitle")}</strong>
          <p>{translate(locale, "results.emptyHelp")}</p>
        </div>
      </div>
    );
  }

  const resultRuns = run?.result?.strategyRuns ?? [];
  const diagnostics = [
    ...(error?.diagnostics ?? []),
    ...resultRuns.flatMap((strategyRun) => strategyRun.diagnostics ?? []),
  ];
  return (
    <div className="run-status-panel" aria-live="polite">
      {error && (
        <div className="catalog-error" role="alert">
          <div>
            <strong>{translate(locale, error.messageKey)}</strong>
          </div>
        </div>
      )}
      {run && (
        <>
          <div className="run-status-heading">
            <div>
              <span className="status-tag">{translate(locale, `status.${run.status}`)}</span>
              {isPartialSuccess(run) && (
                <span className="status-tag status-warning">{translate(locale, "run.partialSuccess")}</span>
              )}
              <p className="run-id">{run.runId}</p>
            </div>
            {run.progress && (
              <span className="progress-copy">
                {translate(locale, "run.progress", {
                  completed: String(run.progress.completedStrategies),
                  total: String(run.progress.totalStrategies),
                })}
              </span>
            )}
          </div>
          {resultRuns.length > 0 && (
            <ul className="run-strategy-statuses">
              {resultRuns.map((strategyRun) => (
                <li key={`${strategyRun.role}-${strategyRun.id}`}>
                  <span>{translate(locale, `presets.${strategyRun.presetId}.name`)}</span>
                  <code>{strategyRun.id}</code>
                  <span className="status-tag">{translate(locale, `status.${strategyRun.status}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <DiagnosticList locale={locale} diagnostics={diagnostics} />
    </div>
  );
}
