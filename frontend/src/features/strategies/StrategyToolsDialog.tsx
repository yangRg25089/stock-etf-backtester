import { useState } from "react";
import { translate, type Locale } from "../../i18n/messages";
import { ResultDialog } from "../../shared/ui/ResultDialog";

export function StrategyToolsDialog({ name, locale, busy, canDuplicate, onDuplicate, onReset, onClose }: {
  name: string; locale: Locale; busy: boolean; canDuplicate: boolean;
  onDuplicate(): void; onReset(): void; onClose(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  return <ResultDialog className="strategy-tools-dialog" title={confirming ? translate(locale, "strategy.resetQuestion") : name} locale={locale} onClose={onClose}>
    <div className="strategy-tools-actions">
      {confirming ? <>
        <button className="button" type="button" onClick={onClose}>{translate(locale, "files.cancel")}</button>
        <button className="button button-primary" type="button" disabled={busy}
          onClick={() => { if (!busy) { onReset(); onClose(); } }}>{translate(locale, "strategy.reset")}</button>
      </> : <>
        <button className="button" type="button" disabled={busy || !canDuplicate} title={translate(locale, "strategy.duplicateHint")}
          onClick={() => { if (!busy && canDuplicate) { onDuplicate(); onClose(); } }}>{translate(locale, "strategy.duplicate")}</button>
        <button className="button" type="button" disabled={busy} onClick={() => setConfirming(true)}>{translate(locale, "strategy.reset")}</button>
      </>}
    </div>
    {!confirming && !canDuplicate && <p className="field-hint">{translate(locale, "strategy.duplicateHint")}</p>}
  </ResultDialog>;
}
