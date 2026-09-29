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
        <button className="button button-primary" type="button" disabled={disabled} onClick={onRun}>
          {busy ? translate(locale, "run.submitting") : translate(locale, "run.submit")}
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
