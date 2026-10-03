import { useEffect, useRef, useState } from "react";
import type { Catalog, RunResponse, StrategyRun } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { triggerFileDownload } from "./exportModel";
import { renderResultReport } from "./reportImage";
import { buildResultReport, isResultReportAvailable } from "./reportModel";

interface ReportDownloadButtonProps {
  run: RunResponse | null;
  result: StrategyRun | null;
  parent?: StrategyRun | null;
  catalog?: Catalog | null;
  locale: Locale;
  busy?: boolean;
}

export function ReportDownloadButton({ run, result, parent, catalog, locale, busy = false }: ReportDownloadButtonProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setPending(false); setFailed(false);
    return () => controller.current?.abort();
  }, [run?.runId, result?.id, locale, busy]);
  const download = async () => {
    if (busy || pending) return;
    const report = buildResultReport(run, result, locale, catalog, parent);
    if (!report) return;
    const request = new AbortController();
    controller.current = request;
    setPending(true); setFailed(false);
    try {
      const blob = await renderResultReport(report, request.signal);
      if (!request.signal.aborted) triggerFileDownload(blob, report.filename);
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (!request.signal.aborted) setPending(false);
    }
  };
  return (
    <div className="report-download-control">
      <button type="button" className="button button-primary report-download-button" data-report-kind="png"
        disabled={busy || pending || !isResultReportAvailable(run, result, parent)} aria-busy={pending}
        aria-label={translate(locale, "report.download")} title={translate(locale, "report.download")}
        onClick={() => void download()}>
        {pending ? <span className="spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" /></svg>}
        {translate(locale, "report.filename")}
      </button>
      {failed && <p className="field-error report-download-error" role="alert">{translate(locale, "report.error")}</p>}
    </div>
  );
}
