import type { RunScope } from "../../api/generated";
import type { Locale } from "../../i18n/messages";
import { translate } from "../../i18n/messages";
import type { RunAvailability } from "../strategies/model";

interface RunControlsProps {
  locale: Locale;
  runScope: RunScope;
  availability: RunAvailability;
  busy: boolean;
  completedFeedback: boolean;
  onScopeChange(scope: RunScope): void;
  onRun(): void;
}

export function RunControls({
  locale,
  runScope,
  availability,
  busy,
  completedFeedback,
  onScopeChange,
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
        {completedFeedback && (
          <span className="run-complete-feedback" role="status">
            {translate(locale, "run.complete")}
          </span>
        )}
      </div>
      <div className="run-control-options">
        <label className="sr-only" htmlFor="run-scope-select">
          {translate(locale, "run.scopeLabel")}
        </label>
        <select
          id="run-scope-select"
          className="run-scope-select"
          value={runScope}
          onChange={(event) => onScopeChange(event.target.value as RunScope)}
          aria-describedby="run-scope-help"
        >
          {(["all_enabled", "active"] as const).map((scope) => (
            <option key={scope} value={scope}>{translate(locale, `run.scope.${scope}`)}</option>
          ))}
        </select>
        <span id="run-scope-help" className="sr-only">{translate(locale, "run.scopeHelp")}</span>
        {(busy || availability.reasonKey) && (
          <p className="run-reason" role={busy ? "status" : "note"}>
            {busy ? translate(locale, "run.inProgress") : translate(locale, availability.reasonKey ?? "run.ready")}
          </p>
        )}
      </div>
    </section>
  );
}
