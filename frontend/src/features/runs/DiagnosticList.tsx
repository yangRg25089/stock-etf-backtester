import type { Diagnostic } from "../../api/generated";
import { interpolate, translate, type Locale } from "../../i18n/messages";
import { marketDateRecovery } from "./dateRecovery";

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

export interface DiagnosticFieldAction {
  label: string;
  actionLabel?: string;
  activate(): void;
}

interface DiagnosticListProps {
  locale: Locale;
  diagnostics: Diagnostic[];
  fieldAction?(diagnostic: Diagnostic): DiagnosticFieldAction | null;
  fieldLabel?(diagnostic: Diagnostic): string | null;
}

export function DiagnosticList({ locale, diagnostics, fieldAction, fieldLabel }: DiagnosticListProps) {
  if (diagnostics.length === 0) return null;
  return (
    <ul className="diagnostic-list">
      {diagnostics.map((diagnostic, index) => {
        const action = fieldAction?.(diagnostic) ?? null;
        const label = fieldLabel?.(diagnostic);
        const recovery = marketDateRecovery(diagnostic);
        const actionLabel = action
          ? action.actionLabel ?? interpolate(translate(locale, "diagnostics.openField"), { field: action.label })
          : null;
        return (
          <li key={`${diagnostic.code}-${diagnostic.fieldPath ?? "run"}-${index}`}>
            <span className={`severity severity-${diagnostic.severity ?? "error"}`}>
              {translate(locale, `severity.${diagnostic.severity ?? "error"}`)}
            </span>
            <div>
              {label && <strong className="diagnostic-field-name">{label}</strong>}
              <span>{translate(locale, diagnostic.messageKey)}</span>
              {recovery && <small className="diagnostic-context">{translate(locale, "market.available_from", { symbol: recovery.symbol, date: recovery.availableFrom })}</small>}
              {diagnostic.messageKey === "diagnostics.calculation_failed" && (
                <CalculationContext
                  locale={locale}
                  details={isRecord(diagnostic.details) ? diagnostic.details : {}}
                />
              )}
              {action && actionLabel && (
                <button
                  className="diagnostic-field-link"
                  type="button"
                  aria-label={actionLabel}
                  title={actionLabel}
                  onClick={action.activate}
                >
                  <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                    <path d="M5 15 15 5M6 5h9v9" />
                  </svg>
                </button>
              )}
            </div>
          </li>
        );
      })}
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
