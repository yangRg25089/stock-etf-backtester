import { useState } from "react";
import type { ExportKind, StrategyRun } from "../../api/generated";
import { ExportApiError } from "../../api/exports";
import { translate, type Locale } from "../../i18n/messages";
import { DiagnosticList } from "../runs/StatusView";
import { isExportAvailable, performCsvExport } from "./exportModel";

const EXPORT_KINDS: ExportKind[] = ["summary", "daily-assets", "trades", "search-results"];

interface ExportControlsProps {
  locale: Locale;
  runId: string | null;
  result: StrategyRun | null;
}

export function ExportControls({ locale, runId, result }: ExportControlsProps) {
  const [pendingKind, setPendingKind] = useState<ExportKind | null>(null);
  const [error, setError] = useState<ExportApiError | null>(null);
  const resultId = result?.id ?? null;

  const handleExport = async (kind: ExportKind) => {
    if (!runId || !resultId || !isExportAvailable(result, kind) || pendingKind) return;
    setPendingKind(kind);
    setError(null);
    try {
      await performCsvExport(runId, resultId, kind);
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
        const disabled = !runId || !resultId || !isExportAvailable(result, kind) || pendingKind !== null;
        return (
          <button
            className="button button-small"
            type="button"
            key={kind}
            data-export-kind={kind}
            disabled={disabled}
            onClick={() => void handleExport(kind)}
            aria-label={`${translate(locale, "export.csvLabel")}: ${translate(locale, `export.kind.${kind}`)}`}
          >
            {pendingKind === kind ? translate(locale, "export.downloading") : translate(locale, `export.kind.${kind}`)}
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
