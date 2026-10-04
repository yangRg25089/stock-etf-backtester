import type { MouseEvent, Ref } from "react";
import { interpolate, translate, type Locale } from "../../i18n/messages";
import type { StrategyDraft } from "./model";
import { formatStrategySummary } from "./strategySummary";

export function StrategyCard({ strategy, name, active, busy, hasError, summaryId, locale,
  buttonRef, onOpen, onRemove, onTools }: {
  strategy: StrategyDraft; name: string; active: boolean; busy: boolean; hasError: boolean;
  summaryId: string; locale: Locale; buttonRef: Ref<HTMLButtonElement>;
  onOpen(event: MouseEvent<HTMLButtonElement>): void; onRemove(): void; onTools(): void;
}) {
  return (
    <article
      className={`strategy-card strategy-nav-card${active ? " is-active" : ""}`}
    >
      <button
        ref={buttonRef}
        className="strategy-card-open"
        type="button"
        disabled={busy}
        aria-label={interpolate(translate(locale, "strategy.edit"), { name })}
        aria-describedby={summaryId}
        aria-haspopup="dialog"
        aria-controls={`strategy-dialog-${strategy.id}`}
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
      >
        <span className="strategy-card-name">{name}</span>
        <span className="strategy-card-summary" id={summaryId}>
          {formatStrategySummary(locale, strategy.presetId, strategy.params, strategy.rules)}
        </span>
      </button>
      <div className="strategy-card-actions">
        {hasError && <span className="strategy-nav-error">{translate(locale, "strategy.hasErrors")}</span>}
        <button
          className="icon-button strategy-remove"
          type="button"
          disabled={busy}
          aria-label={interpolate(translate(locale, "strategy.remove"), { name })}
          title={interpolate(translate(locale, "strategy.remove"), { name })}
          onClick={onRemove}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" />
          </svg>
        </button>
        <button className="icon-button strategy-more" type="button" disabled={busy} aria-haspopup="dialog"
          aria-label={translate(locale, "strategy.more", { name })} title={translate(locale, "strategy.more", { name })}
          onClick={onTools}><span aria-hidden="true">⋯</span></button>
      </div>
    </article>
  );
}
