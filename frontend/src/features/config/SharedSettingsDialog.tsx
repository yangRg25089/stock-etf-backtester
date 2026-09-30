import { useEffect, useRef, type RefObject } from "react";
import type { Catalog, Diagnostic } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import type { SharedDraft } from "./defaults";
import { SharedSettingsForm } from "./SharedSettingsForm";

interface SharedSettingsDialogProps {
  catalog: Catalog;
  value: SharedDraft;
  locale: Locale;
  errors?: Diagnostic[];
  resolvedLatestEndDate?: string | null;
  onChange(value: SharedDraft): void;
  onClose(): void;
  returnFocusRef: RefObject<HTMLButtonElement>;
}

export function SharedSettingsDialog({
  catalog,
  value,
  locale,
  errors = [],
  resolvedLatestEndDate = null,
  onChange,
  onClose,
  returnFocusRef,
}: SharedSettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    returnFocusRef.current?.focus();
    onClose();
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="shared-settings-dialog"
      aria-modal="true"
      aria-labelledby="shared-settings-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div className="shared-settings-dialog-shell">
        <header className="shared-settings-dialog-heading">
          <h2 id="shared-settings-dialog-title">{translate(locale, "section.sharedSettings")}</h2>
          <button
            className="button icon-only-button shared-settings-dialog-close"
            type="button"
            aria-label={translate(locale, "workbench.closeSettingsDialog")}
            title={translate(locale, "workbench.closeSettingsDialog")}
            onClick={closeDialog}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="shared-settings-dialog-content">
          <SharedSettingsForm
            catalog={catalog}
            value={value}
            locale={locale}
            errors={errors}
            resolvedLatestEndDate={resolvedLatestEndDate}
            onChange={onChange}
          />
        </div>
        <footer className="shared-settings-dialog-footer">
          <button className="button button-primary dialog-done" type="button" onClick={closeDialog}>
            {translate(locale, "workbench.settingsDone")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
