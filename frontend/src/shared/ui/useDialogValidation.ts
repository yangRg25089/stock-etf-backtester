import { useEffect, useRef, useState } from "react";
import { RunApiError } from "../../api/runs";
import type { Diagnostic } from "../../api/generated";

function nativeDiagnostic(input: HTMLInputElement): Diagnostic {
  const key = input.dataset.parameterKey;
  const conditionId = input.closest<HTMLElement>(".condition-card")?.dataset.conditionId;
  const issue = input.validity.valueMissing ? "required"
    : input.validity.rangeOverflow || input.validity.rangeUnderflow ? "out_of_range" : "invalid_value";
  return {
    code: "invalid_parameter", severity: "error", messageKey: `diagnostics.configuration.${issue}`,
    fieldPath: key && (input.closest(".shared-settings-dialog") ? key : `params.${key}`),
    ...(conditionId ? { details: { conditionId } } : {}),
  };
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
  }, [errors, pending]);

  const attemptClose = async (dialog: HTMLDialogElement | null,
    validate: (signal: AbortSignal) => Promise<Diagnostic[]>, commit: () => void) => {
    if (controllerRef.current) return;
    focusDialogRef.current = dialog;
    const invalid = dialog?.querySelector<HTMLInputElement>("input:invalid, select:invalid, textarea:invalid");
    invalid?.reportValidity();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    try {
      const diagnostics = await validate(controller.signal);
      if (controller.signal.aborted) return;
      const localError = invalid ? nativeDiagnostic(invalid) : null;
      const conditionId = (localError?.details as Record<string, unknown> | undefined)?.conditionId;
      const combined = localError && !diagnostics.some(item =>
        item.severity === "error" && (item.details as Record<string, unknown> | undefined)?.conditionId === conditionId &&
        (item.fieldPath === localError.fieldPath || (invalid?.dataset.parameterKey && item.fieldPath?.endsWith(`.${invalid.dataset.parameterKey}`))))
        ? [...diagnostics, localError] : diagnostics;
      setErrors(combined);
      if (!combined.some(item => item.severity === "error")) commit();
    } catch (error) {
      if (!controller.signal.aborted) setErrors(error instanceof RunApiError && error.diagnostics.length ? error.diagnostics : [{
        code: "provider_request_failed", severity: "error", messageKey: "api.errors.connection_failed",
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
