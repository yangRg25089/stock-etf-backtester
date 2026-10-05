import { useEffect, useRef, useState } from "react";
import { RunApiError } from "../../api/runs";
import type { Diagnostic } from "../../api/generated";

type ValidationControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function nativeDiagnostic(input: ValidationControl, validity: ValidityState): Diagnostic {
  const key = input.dataset.parameterKey;
  const conditionId = input.closest<HTMLElement>(".condition-card")?.dataset.conditionId;
  const issue = validity.valueMissing ? "required"
    : validity.rangeOverflow || validity.rangeUnderflow ? "out_of_range" : "invalid_value";
  return {
    code: "invalid_parameter", severity: "error", messageKey: `diagnostics.configuration.${issue}`,
    fieldPath: key && (input.closest(".shared-settings-dialog") ? key : `params.${key}`),
    details: { parameterKey: key, ...(conditionId ? { conditionId } : {}) },
  };
}

function nativeError(dialog: HTMLDialogElement | null): Diagnostic | null {
  const active = dialog?.querySelector<ValidationControl>("input:invalid, select:invalid, textarea:invalid");
  if (active) {
    const error = nativeDiagnostic(active, active.validity);
    active.reportValidity();
    return error;
  }
  // Disabled condition fields retain their values and must remain valid too.
  for (const field of dialog?.querySelectorAll<ValidationControl>(
    ".condition-card input:disabled, .condition-card select:disabled, .condition-card textarea:disabled",
  ) ?? []) {
    const copy = field.cloneNode(true) as ValidationControl;
    copy.disabled = false;
    copy.value = field.value;
    if (!copy.validity.valid) return nativeDiagnostic(field, copy.validity);
  }
  return null;
}

// Validation belongs to the editor. It never changes the saved workspace or run.
export function useDialogValidation() {
  const [errors, setErrors] = useState<Diagnostic[]>([]);
  const [pending, setPending] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const focusDialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    if (pending || !errors.some(item => item.severity === "error")) return;
    const dialog = focusDialogRef.current;
    if (!dialog?.open) return;
    // Effects run after the fieldset has become enabled and errors are rendered.
    const target = dialog.querySelector<HTMLElement>("input:invalid, select:invalid, textarea:invalid")
      ?? dialog.querySelector<HTMLElement>('[aria-invalid="true"]:not(:disabled)')
      ?? dialog.querySelector<HTMLElement>(".dialog-diagnostics");
    target?.focus();
    const fields = dialog.querySelector(".dialog-fields");
    if (!fields) return;
    const observer = new ResizeObserver(() => {
      const active = document.activeElement;
      if (dialog.open && active instanceof HTMLElement && fields.contains(active)) {
        active.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
    observer.observe(fields);
    return () => observer.disconnect();
  }, [errors, pending]);

  const attemptClose = async (dialog: HTMLDialogElement | null,
    validate: (signal: AbortSignal) => Promise<Diagnostic[]>, commit: () => void) => {
    if (controllerRef.current) return;
    focusDialogRef.current = dialog;
    const localError = nativeError(dialog);
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    try {
      const diagnostics = await validate(controller.signal);
      if (controller.signal.aborted) return;
      const conditionId = (localError?.details as Record<string, unknown> | undefined)?.conditionId;
      const parameterKey = (localError?.details as Record<string, unknown> | undefined)?.parameterKey;
      const combined = localError && !diagnostics.some(item =>
        item.severity === "error" && (item.details as Record<string, unknown> | undefined)?.conditionId === conditionId &&
        (item.fieldPath === localError.fieldPath || (typeof parameterKey === "string" && item.fieldPath?.endsWith(`.${parameterKey}`))))
        ? [...diagnostics, localError] : diagnostics;
      setErrors(combined);
      if (!combined.some(item => item.severity === "error")) commit();
    } catch (error) {
      if (!controller.signal.aborted) setErrors(error instanceof RunApiError && error.diagnostics.length ? error.diagnostics : [{
        code: "provider_request_failed", severity: "error", messageKey: error instanceof RunApiError ? error.messageKey : "api.errors.connection_failed",
      }]);
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setPending(false);
      }
    }
  };
  return { errors, pending, attemptClose, clearErrors: () => setErrors([]) };
}
