import type { RunResponse } from "../../api/generated";
import { isActiveRunStatus } from "../../api/runStatus";
import { translate, type Locale } from "../../i18n/messages";
import type { RunAvailability } from "../strategies/model";
import { useWorkbenchShortcut } from "../../shared/ui/useWorkbenchShortcut";

interface RunActionsProps {
  locale: Locale;
  availability: RunAvailability;
  busy: boolean;
  canStop?: boolean;
  stopping: boolean;
  onStop(): void;
  run?: RunResponse | null;
  canReset: boolean;
  onReset(): void;
  onRun(): void;
}

export function RunActions({ locale, availability, busy, canStop = busy, stopping, onStop, run, canReset, onReset, onRun }: RunActionsProps) {
  useWorkbenchShortcut("Enter", !busy && !availability.disabled, onRun);
  const progress = busy && run && isActiveRunStatus(run.status)
    ? run.progress
    : null;
  const actionLabel = translate(locale, busy ? run && isActiveRunStatus(run.status) ? `status.${run.status}` : "run.submitting" : "run.submit");
  const label = progress
    ? `${actionLabel} · ${progress.completedStrategies}/${progress.totalStrategies}`
    : actionLabel;
  const reason = !busy && availability.reasonKey ? translate(locale, availability.reasonKey) : null;
  const announcement = busy ? label : run ? translate(locale, `status.${run.status}`) : "";

  return (
    <div className="execution-actions" role="group" aria-label={translate(locale, "run.actions")} title={reason ?? undefined}>
      <button
        className="button button-primary run-submit-button"
        type="button"
        aria-label={label}
        title={reason ?? `${label} · Ctrl/⌘ + Enter`}
        aria-keyshortcuts="Control+Enter Meta+Enter"
        aria-describedby={reason ? "run-disabled-reason" : undefined}
        aria-busy={busy}
        disabled={busy || availability.disabled}
        onClick={(event) => { if (event.detail < 2) onRun(); }}
      >
        {busy ? <span className="run-button-spinner" aria-hidden="true" /> : (
          <svg className="run-play-icon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
            <path d="M5 2.8c0-.7.8-1.1 1.4-.7l11 7.1a1 1 0 0 1 0 1.6l-11 7.1a.9.9 0 0 1-1.4-.7V2.8Z" />
          </svg>
        )}
      </button>
      <span className="run-stop-slot">{busy && canStop && <button type="button" className="button icon-only-button run-stop-button" disabled={stopping}
        onClick={onStop} aria-label={translate(locale, stopping ? "run.stopping" : "run.stop")}
        title={translate(locale, stopping ? "run.stopping" : "run.stop")}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1" /></svg>
      </button>}</span>
      <button
        className="button icon-only-button run-reset-button"
        type="button"
        aria-label={translate(locale, "run.reset")}
        title={translate(locale, "run.reset")}
        disabled={busy || !canReset}
        onClick={onReset}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d="M4 6a7 7 0 1 1-1 7M4 2v5h5" />
        </svg>
      </button>
      {reason && <span className="sr-only" id="run-disabled-reason">{reason}</span>}
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
