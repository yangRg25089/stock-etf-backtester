import { useState } from "react";
import type { ExportKind, StrategyRun } from "../../api/generated";
import { ExportApiError } from "../../api/exports";
import { translate, type Locale } from "../../i18n/messages";
import { DiagnosticList } from "../runs/DiagnosticList";
import { isExportAvailable, performCsvExport } from "./exportModel";

const EXPORT_KINDS: ExportKind[] = ["summary", "daily-assets", "trades", "search-results"];

interface ExportControlsProps {
  locale: Locale;
  runId: string | null;
  result: StrategyRun | null;
  searchResult?: StrategyRun | null;
}

export function ExportControls({ locale, runId, result, searchResult }: ExportControlsProps) {
  const [pendingKind, setPendingKind] = useState<ExportKind | null>(null);
  const [error, setError] = useState<ExportApiError | null>(null);
  const targetFor = (kind: ExportKind) => kind === "search-results" ? searchResult ?? result : result;

  const handleExport = async (kind: ExportKind) => {
    const target = targetFor(kind);
    if (!runId || !target || !isExportAvailable(target, kind) || pendingKind) return;
    setPendingKind(kind);
    setError(null);
    try {
      await performCsvExport(runId, target.id, kind);
    } catch (caught) {
      if (caught instanceof ExportApiError) {
        setError(caught);
      } else {
        setError(new ExportApiError("provider_request_failed", "api.errors.connection_failed", [{
          code: "provider_request_failed",
          severity: "error",
          messageKey: "api.errors.connection_failed",
        }]));
      }
    } finally {
      setPendingKind(null);
    }
  };

  return (
    <div className="export-controls" role="group" aria-label={translate(locale, "export.csvLabel")}>
      {EXPORT_KINDS.map((kind) => {
        const target = targetFor(kind);
        const disabled = !runId || !target || !isExportAvailable(target, kind) || pendingKind !== null;
        const label = `${translate(locale, "export.csvLabel")}: ${translate(locale, `export.kind.${kind}`)}`;
        return (
          <button
            className="button button-small"
            type="button"
            key={kind}
            data-export-kind={kind}
            disabled={disabled}
            onClick={() => void handleExport(kind)}
            aria-label={label}
            title={label}
          >
            <svg className="export-download-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" />
            </svg>
            {pendingKind === kind ? translate(locale, "export.downloading") : `${translate(locale, `export.kind.${kind}`)}.csv`}
          </button>
        );
      })}
      {error && (
        <div className="export-error" role="alert">
          <strong>{translate(locale, error.messageKey || "export.error")}</strong>
          <DiagnosticList locale={locale} diagnostics={error.diagnostics} />
        </div>
      )}
    </div>
  );
}
