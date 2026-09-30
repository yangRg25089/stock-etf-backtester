import type { Locale } from "../../i18n/messages";
import { translate } from "../../i18n/messages";
import type { RunAvailability } from "../strategies/model";

interface RunControlsProps {
  locale: Locale;
  availability: RunAvailability;
  busy: boolean;
  completedFeedback: boolean;
  canReset: boolean;
  onReset(): void;
  onRun(): void;
}

export function RunControls({
  locale,
  availability,
  busy,
  completedFeedback,
  canReset,
  onReset,
  onRun,
}: RunControlsProps) {
  const disabled = busy || availability.disabled;
  return (
    <section className="run-controls" aria-label={translate(locale, "run.title")}>
      <div className="run-control-main">
        <button
          className="button button-primary run-submit-button"
          type="button"
          aria-label={translate(locale, busy ? "run.submitting" : completedFeedback ? "run.complete" : "run.submit")}
          title={translate(locale, busy ? "run.submitting" : completedFeedback ? "run.complete" : "run.submit")}
          aria-busy={busy}
          disabled={disabled}
          onClick={onRun}
        >
          {busy ? (
            <span className="run-button-spinner" aria-hidden="true" />
          ) : (
            completedFeedback ? (
              <svg className="run-complete-icon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                <path d="m3.5 10.5 4.1 4.1 9-9.2" />
              </svg>
            ) : (
              <svg className="run-play-icon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                <path d="M5 2.8c0-.7.8-1.1 1.4-.7l11 7.1a1 1 0 0 1 0 1.6l-11 7.1a.9.9 0 0 1-1.4-.7V2.8Z" />
              </svg>
            )
          )}
        </button>
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
        {completedFeedback && (
          <span className="run-complete-feedback" role="status">
            {translate(locale, "run.complete")}
          </span>
        )}
      </div>
      {(busy || availability.reasonKey) && (
          <p className="run-reason" role={busy ? "status" : "note"}>
            {busy ? translate(locale, "run.inProgress") : translate(locale, availability.reasonKey ?? "run.ready")}
          </p>
      )}
    </section>
  );
}
