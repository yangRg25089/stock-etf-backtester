import { useEffect, useRef, useState, type RefObject } from "react";
import type { Catalog } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import type { SharedDraft } from "./defaults";
import { SharedSettingsForm } from "./SharedSettingsForm";
import { fetchInstrument, validateDraft } from "../../api/runs";
import { DiagnosticList } from "../runs/DiagnosticList";
import { useDialogValidation } from "../../shared/ui/useDialogValidation";
import { parameterFieldId } from "../../shared/ui/parameterFieldId";

interface SharedSettingsDialogProps {
  catalog: Catalog;
  value: SharedDraft;
  locale: Locale;
  data: Record<string, unknown>;
  focusFieldKey?: string | null;
  onChange(value: SharedDraft): void;
  onClose(): void;
  onFieldFocusHandled?(): void;
  returnFocusRef: RefObject<HTMLButtonElement>;
}

export function SharedSettingsDialog({
  catalog,
  value,
  locale,
  data,
  focusFieldKey = null,
  onChange,
  onClose,
  onFieldFocusHandled,
  returnFocusRef,
}: SharedSettingsDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [buffer, setBuffer] = useState(() => structuredClone(value));
  const validation = useDialogValidation();
  const footerErrors = validation.errors.filter(item => !catalog.parameters?.some(parameter => item.fieldPath === parameter.key || item.fieldPath?.endsWith(`.${parameter.key}`)));
  const confirmedCurrency = useRef<string | undefined>(buffer.currency);
  const closeDialog = () => void validation.attemptClose(dialogRef.current, async signal => {
    const response = await validateDraft({ shared: { run: buffer.run, contribution: buffer.contribution, data }, strategies: [] }, signal);
    const errors = [...(response.diagnostics ?? [])];
    if (errors.some(item => item.severity === "error")) return errors;
    const metadata = await fetchInstrument(buffer.run.symbol, signal);
    if (!metadata.currency) return [...errors, ...(metadata.diagnostics ?? []), {
      code: "required_data_unavailable" as const, severity: "error" as const, messageKey: "data.currency_missing", fieldPath: "run.symbol",
    }];
    confirmedCurrency.current = metadata.currency;
    return errors;
  }, () => {
    onChange({ ...buffer, currency: confirmedCurrency.current ?? buffer.currency });
    if (dialogRef.current?.open) dialogRef.current.close();
    returnFocusRef.current?.focus();
    onClose();
  });

  useEffect(() => {
    if (buffer.currency || !buffer.run.symbol) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchInstrument(buffer.run.symbol, controller.signal).then(metadata => {
        if (!controller.signal.aborted && metadata.currency) setBuffer(current => ({ ...current, currency: metadata.currency ?? undefined }));
      }).catch(() => undefined);
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [buffer.run.symbol, buffer.currency]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    if (!focusFieldKey) return;
    const frame = window.requestAnimationFrame(() => {
      const fieldId = parameterFieldId(focusFieldKey);
      const target = document.getElementById(fieldId) ?? document.getElementById(`${fieldId}-0`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "center" });
      onFieldFocusHandled?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusFieldKey, onFieldFocusHandled]);

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
            disabled={validation.pending}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <fieldset className="shared-settings-dialog-content dialog-fields" disabled={validation.pending}>
          <SharedSettingsForm
            catalog={catalog}
            value={buffer}
            locale={locale}
            errors={validation.errors}
            currency={buffer.currency}
            onChange={next => { validation.clearErrors(); setBuffer(next); }}
          />
        </fieldset>
        <footer className="shared-settings-dialog-footer">
          {footerErrors.length > 0 && <div className="dialog-diagnostics" role="alert" tabIndex={0}><DiagnosticList diagnostics={footerErrors} locale={locale} /></div>}
          <button className="button button-primary dialog-done" type="button" disabled={validation.pending} aria-busy={validation.pending} onClick={closeDialog}>
            {validation.pending && <span className="run-button-spinner" aria-hidden="true" />}
            {translate(locale, "workbench.settingsDone")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
