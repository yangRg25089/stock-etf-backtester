import type { Diagnostic, RunResponse } from "../../api/generated";
import { RunApiError } from "../../api/runs";
import { translate, type Locale } from "../../i18n/messages";
import { isPartialSuccess } from "../strategies/model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CALCULATION_STAGES = new Set([
  "queue",
  "monthly_dca",
  "lump_sum",
  "strategy",
  "execution",
]);

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
          <div>
            <span>{translate(locale, diagnostic.messageKey)}</span>
            {diagnostic.messageKey === "diagnostics.calculation_failed" && (
              <CalculationContext
                locale={locale}
                details={isRecord(diagnostic.details) ? diagnostic.details : {}}
              />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function CalculationContext({
  locale,
  details,
}: {
  locale: Locale;
  details: Record<string, unknown>;
}) {
  const stage = typeof details.stage === "string" && CALCULATION_STAGES.has(details.stage)
    ? translate(locale, `diagnostics.stage.${details.stage}`)
    : null;
  const runId = typeof details.runId === "string" ? details.runId : null;
  const strategyId = typeof details.strategyId === "string" ? details.strategyId : null;
  const context = [
    stage,
    strategyId ? translate(locale, "diagnostics.strategyId", { strategyId }) : null,
    runId ? translate(locale, "diagnostics.runId", { runId }) : null,
  ].filter((item): item is string => item !== null);
  if (context.length === 0) return null;
  return (
    <small className="diagnostic-context">{context.join(" · ")}</small>
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
  const expandStrategyDetails = Boolean(
    error ||
    diagnostics.length > 0 ||
    run?.status !== "completed" ||
    resultRuns.some((strategyRun) => strategyRun.status !== "completed"),
  );
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
            <details className="run-strategy-details" key={run?.runId ?? "no-run"} open={expandStrategyDetails}>
              <summary>{translate(locale, "run.resultDetails", { count: String(resultRuns.length) })}</summary>
              <ul className="run-strategy-statuses">
                {resultRuns.map((strategyRun) => (
                  <li key={`${strategyRun.role}-${strategyRun.id}`}>
                    <span>{translate(locale, `presets.${strategyRun.presetId}.name`)}</span>
                    <code>{strategyRun.id}</code>
                    <span className="status-tag">{translate(locale, `status.${strategyRun.status}`)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <DiagnosticList locale={locale} diagnostics={diagnostics} />
    </div>
  );
}
