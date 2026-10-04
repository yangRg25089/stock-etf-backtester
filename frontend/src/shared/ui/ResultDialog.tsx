import { ModalShell } from "./ModalShell";
import { useId, useRef, type ReactNode } from "react";
import { translate, type Locale } from "../../i18n/messages";

/** Compact tools share native modal focus and scroll behavior. */
export function ResultDialog({ title, locale, onClose, children, className = "" }: {
  title: string;
  locale: Locale;
  onClose(): void;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <ModalShell dialogRef={dialogRef} className={`result-inspector-dialog ${className}`} labelledBy={titleId}
      onRequestClose={onClose} restoreFocus>
      <header className="result-inspector-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="button icon-only-button" onClick={onClose}
          aria-label={translate(locale, "app.close")} title={translate(locale, "app.close")}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="result-inspector-content">{children}</div>
    </ModalShell>
  );
}
