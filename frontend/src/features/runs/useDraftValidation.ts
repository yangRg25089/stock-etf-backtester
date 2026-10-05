import { useCallback, useEffect, useState } from "react";
import type { Catalog, Diagnostic } from "../../api/generated";
import { validateDraft, type RunApiError } from "../../api/runs";
import { serializeDraftForApi, type BacktestDraft } from "../strategies/model";
import { asRunApiError } from "./runErrors";

interface ValidationState {
  draft: BacktestDraft;
  response: Awaited<ReturnType<typeof validateDraft>> | null;
  error?: RunApiError;
}

export function validationDiagnostics(
  response: Awaited<ReturnType<typeof validateDraft>>,
): Diagnostic[] {
  return [
    ...(response.diagnostics ?? []),
    ...(response.strategies ?? []).flatMap((strategy) => strategy.diagnostics ?? []),
  ];
}

export function useDraftValidation(catalog: Catalog | null, draft: BacktestDraft | undefined, runBusy: boolean) {
  const [state, setState] = useState<ValidationState | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Dialog buffers are local: only confirmed workspace inputs enter preflight.
  useEffect(() => {
    if (!catalog || !draft || runBusy) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void validateDraft(serializeDraftForApi(draft), controller.signal).then(response => {
        if (!controller.signal.aborted) setState({ draft, response });
      }).catch(error => {
        if (!controller.signal.aborted) setState({ draft, response: null, error: asRunApiError(error) });
      });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [catalog, draft, runBusy, retryCount]);

  const retry = useCallback(() => setRetryCount(value => value + 1), []);
  const accept = useCallback((value: BacktestDraft, response: Awaited<ReturnType<typeof validateDraft>>) => {
    setState({ draft: value, response });
  }, []);
  const reset = useCallback(() => setState(null), []);

  return {
    currentValidation: draft && state?.draft === draft ? state.response : null,
    error: draft && state?.draft === draft ? state.error : undefined,
    failed: Boolean(state?.error || state?.response &&
      validationDiagnostics(state.response).some(item => item.severity === "error")),
    retry, accept, reset,
  };
}
