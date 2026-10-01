import { useEffect, useRef, useState } from "react";
import { RunApiError } from "../../api/runs";
import type { Diagnostic } from "../../api/generated";

// Validation belongs to the editor. It never changes the saved workspace or run.
export function useDialogValidation() {
  const [errors, setErrors] = useState<Diagnostic[]>([]);
  const [pending, setPending] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);

  const attemptClose = async (dialog: HTMLDialogElement | null,
    validate: (signal: AbortSignal) => Promise<Diagnostic[]>, commit: () => void) => {
    if (controllerRef.current) return;
    const invalid = dialog?.querySelector<HTMLInputElement>("input:invalid, select:invalid, textarea:invalid");
    invalid?.reportValidity();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    try {
      const diagnostics = await validate(controller.signal);
      if (controller.signal.aborted) return;
      setErrors(diagnostics);
      if (!diagnostics.some(item => item.severity === "error") && !invalid) commit();
      else window.requestAnimationFrame(() => dialog?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
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
