import type { RunScope } from "../../api/generated";
import type { Locale } from "../../i18n/messages";
import { translate } from "../../i18n/messages";
import type { RunAvailability } from "../strategies/model";

interface RunControlsProps {
  locale: Locale;
  runScope: RunScope;
  availability: RunAvailability;
  busy: boolean;
  onScopeChange(scope: RunScope): void;
  onRun(): void;
}

export function RunControls({
  locale,
  runScope,
  availability,
  busy,
  onScopeChange,
  onRun,
}: RunControlsProps) {
  const disabled = busy || availability.disabled;
  return (
    <section className="run-controls" aria-labelledby="run-controls-heading">
      <div className="run-control-main">
        <div>
          <h2 id="run-controls-heading">{translate(locale, "run.title")}</h2>
          <p className="section-subhead">{translate(locale, "run.help")}</p>
        </div>
        <button
          className="button button-primary run-submit-button"
          type="button"
          aria-label={translate(locale, busy ? "run.submitting" : "run.submit")}
          title={translate(locale, busy ? "run.submitting" : "run.submit")}
          aria-busy={busy}
          disabled={disabled}
          onClick={onRun}
        >
          {busy ? (
            <span className="run-button-spinner" aria-hidden="true" />
          ) : (
            <svg className="run-play-icon" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
              <path d="M5 2.8c0-.7.8-1.1 1.4-.7l11 7.1a1 1 0 0 1 0 1.6l-11 7.1a.9.9 0 0 1-1.4-.7V2.8Z" />
            </svg>
          )}
        </button>
      </div>
      <div className="run-control-options">
        <div className="run-scope-option">
          <div className="segmented-control" role="group" aria-label={translate(locale, "run.scopeLabel")}>
            {(["active", "all_enabled"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                aria-pressed={runScope === scope}
                onClick={() => onScopeChange(scope)}
              >
                {translate(locale, `run.scope.${scope}`)}
              </button>
            ))}
          </div>
          <p className="field-hint">{translate(locale, "run.scopeHelp")}</p>
        </div>
        {(busy || availability.reasonKey) && (
          <p className="run-reason" role={busy ? "status" : "note"}>
            {busy ? translate(locale, "run.inProgress") : translate(locale, availability.reasonKey ?? "run.ready")}
          </p>
        )}
      </div>
    </section>
  );
}
