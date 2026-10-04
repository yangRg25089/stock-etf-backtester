import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Catalog, Diagnostic, RunDateAdjustment, RunResponse } from "../../api/generated";
import { runDataContext } from "../../api/contractReader";
import { isActiveRunStatus } from "../../api/runStatus";
import {
  createIdempotencyKey, fetchRun, fetchActiveRun, subscribeToRunEvents,
  RunApiError, submitRun, validateDraft, stopRun, type RunProgressEvent,
} from "../../api/runs";
import {
  createInitialWorkspaceState, getRunAvailability, serializeDraftForApi, workspaceReducer,
  type BacktestDraft, type WorkspaceAction, type WorkspaceState,
} from "../strategies/model";
import { draftFromRun, workspaceForDraft } from "../strategies/draftReader";
import { restoreWorkspaceState, saveLastRunStrategy } from "../strategies/workspacePersistence";
import { packageDraft, type PackageFile } from "../files/packageModel";

interface ValidationState {
  draft: BacktestDraft;
  response: Awaited<ReturnType<typeof validateDraft>> | null;
  error?: RunApiError;
}

function asRunApiError(error: unknown): RunApiError {
  if (error instanceof RunApiError) return error;
  return new RunApiError("provider_request_failed", "api.errors.connection_failed", [{
    code: "provider_request_failed",
    messageKey: "api.errors.connection_failed",
    severity: "error",
  }]);
}

export function validationDiagnostics(
  response: Awaited<ReturnType<typeof validateDraft>>,
): Diagnostic[] {
  return [
    ...(response.diagnostics ?? []),
    ...(response.strategies ?? []).flatMap((strategy) => strategy.diagnostics ?? []),
  ];
}

export function useRunController(
  catalog: Catalog | null,
  workspace: WorkspaceState | null,
  setWorkspace: Dispatch<SetStateAction<WorkspaceState | null>>,
) {
  const [validationState, setValidationState] = useState<ValidationState | null>(null);
  const [validationRetry, setValidationRetry] = useState(0);
  const [runError, setRunError] = useState<RunApiError | null>(null);
  const [dateAdjustments, setDateAdjustments] = useState<RunDateAdjustment[]>([]);
  const [runBusy, setRunBusy] = useState(false);
  const [browserSaveFailed, setBrowserSaveFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRequested = useRef(false);
  const activeRunId = useRef<string | null>(null);
  const activeRunController = useRef<AbortController | null>(null);
  const runSubmissionLocked = useRef(false);
  const submittedRunRef = useRef(false);
  const isLocked = useCallback(() => runSubmissionLocked.current, []);

  const rememberRun = useCallback((value: RunResponse, fallbackCurrency?: string) => {
    if (!catalog) return;
    const stored = restoreWorkspaceState(catalog).state.draft.shared;
    const currency = fallbackCurrency ?? (stored.run.symbol === value.snapshot.config.shared.run.symbol ? stored.currency : undefined);
    const frozenDraft = draftFromRun(value, catalog, currency);
    const failedIds = value.result?.strategyRuns?.filter(row => row.role === "strategy" && row.status === "failed").map(row => row.id) ?? [];
    setBrowserSaveFailed(!frozenDraft || !saveLastRunStrategy(frozenDraft, catalog, undefined, failedIds));
  }, [catalog]);

  const preflightFailed = Boolean(validationState?.error || validationState?.response &&
    validationDiagnostics(validationState.response).some(item => item.severity === "error"));
  const dispatch = useCallback((action: WorkspaceAction) => {
    if (!catalog) return;
    if (runSubmissionLocked.current && action.type !== "run.update" && action.type !== "run.progress") return;
    // A successful dialog confirmation may recover a transient preflight error
    // even when its configuration has not changed.
    if (preflightFailed && (action.type === "shared.change" || action.type === "strategy.commit")) {
      setValidationRetry(value => value + 1);
    }
    setWorkspace((current) => current
      ? workspaceReducer(current, action, catalog)
      : current);
  }, [catalog, setWorkspace, preflightFailed]);

  useEffect(() => {
    if (!catalog) return;
    const controller = new AbortController();
    activeRunController.current = controller;

    const reconnectActiveRun = async () => {
      try {
        const restore = (value: Awaited<ReturnType<typeof fetchActiveRun>>) => {
          if (!value || controller.signal.aborted || submittedRunRef.current) return;
          rememberRun(value);
          setDateAdjustments(runDataContext(value.snapshot)?.dateAdjustments ?? []);
          setWorkspace((current) => {
            if (controller.signal.aborted || submittedRunRef.current) return current;
            const base = current ?? createInitialWorkspaceState(catalog);
            return workspaceReducer(base, { type: "run.update", value, applyResolvedDates: true }, catalog);
          });
        };

        if (controller.signal.aborted || submittedRunRef.current) return;
        let response = await fetchActiveRun(controller.signal);
        if (!response || submittedRunRef.current) return;

        const restoreProgress = (value: RunProgressEvent) => {
          if (submittedRunRef.current) return;
          setWorkspace((current) => {
            if (submittedRunRef.current || !current) return current;
            return workspaceReducer(current, { type: "run.progress", value }, catalog);
          });
        };

        restore(response);
        if (!isActiveRunStatus(response.status)) return;

        activeRunId.current = response.runId;
        runSubmissionLocked.current = true;
        setRunBusy(true);
        await subscribeToRunEvents(response.runId, restoreProgress, controller.signal);
        if (submittedRunRef.current) return;
        response = await fetchRun(response.runId, controller.signal);
        restore(response);
      } catch (error) {
        if (!controller.signal.aborted && !submittedRunRef.current) {
          setRunError(asRunApiError(error));
        }
      } finally {
        if (activeRunController.current === controller) {
          activeRunController.current = null;
          setRunBusy(false);
          runSubmissionLocked.current = false;
          activeRunId.current = null;
          setStopping(false);
        }
      }
    };

    void reconnectActiveRun();
    return () => {
      controller.abort();
      if (activeRunController.current === controller) activeRunController.current = null;
    };
  }, [catalog, setWorkspace, rememberRun]);

  useEffect(() => () => {
    activeRunController.current?.abort();
  }, []);

  // Dialog buffers are local: only confirmed workspace inputs enter preflight.
  const draft = workspace?.draft;
  useEffect(() => {
    if (!catalog || !draft || runBusy) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void validateDraft(serializeDraftForApi(draft), controller.signal).then(response => {
        if (!controller.signal.aborted) setValidationState({ draft, response });
      }).catch(error => {
        if (!controller.signal.aborted) setValidationState({ draft, response: null, error: asRunApiError(error) });
      });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [catalog, draft, runBusy, validationRetry]);

  const currentValidation = workspace && validationState?.draft === workspace.draft
    ? validationState.response
    : null;
  const availability = !workspace ? { disabled: true, reasonKey: "run.validationPending" }
    : validationState?.draft === workspace.draft && validationState.error
      ? { disabled: true, reasonKey: validationState.error.messageKey }
      : getRunAvailability(workspace, currentValidation);
  const canStop = runBusy && (!activeRunId.current
    || workspace?.runResponse?.runId !== activeRunId.current
    || isActiveRunStatus(workspace.runResponse.status));

  const requestStop = async (runId: string, controller: AbortController) => {
    const isCurrentRun = () => activeRunId.current === runId
      && activeRunController.current === controller && !controller.signal.aborted;
    try {
      const response = await stopRun(runId, controller.signal);
      if (!isCurrentRun()) return;
      setRunError(null);
      dispatch({ type: "run.update", value: response });
    } catch (error) {
      if (!isCurrentRun()) return;
      stopRequested.current = false;
      setStopping(false);
      setRunError(asRunApiError(error));
    }
  };

  const handleRun = async () => {
    if (!catalog || !workspace || runBusy || runSubmissionLocked.current) return;
    submittedRunRef.current = true;
    const submittedDraft = workspace.draft;
    const apiDraft = serializeDraftForApi(submittedDraft);
    const controller = new AbortController();
    activeRunController.current?.abort();
    activeRunController.current = controller;
    runSubmissionLocked.current = true;
    setRunBusy(true);
    stopRequested.current = false;
    setStopping(false);
    setRunError(null);
    setDateAdjustments([]);

    try {
      const validation = await validateDraft(apiDraft, controller.signal);
      setValidationState({ draft: submittedDraft, response: validation });
      const allowed = getRunAvailability({ draft: submittedDraft }, validation);
      if (allowed.disabled) {
        const diagnostics = validation.diagnostics ?? [];
        setRunError(new RunApiError(
          "invalid_parameter",
          diagnostics.length > 0 ? "api.errors.invalid_configuration" : allowed.reasonKey ?? "api.errors.invalid_configuration",
          diagnostics,
        ));
        return;
      }

      if (stopRequested.current) return;
      const accepted = await submitRun(
        apiDraft,
        createIdempotencyKey(),
        controller.signal,
      );
      activeRunId.current = accepted.runId;
      rememberRun(accepted, submittedDraft.shared.currency);
      setDateAdjustments(runDataContext(accepted.snapshot)?.dateAdjustments ?? []);
      dispatch({
        type: "run.update",
        value: accepted,
        applyResolvedDates: true,
      });
      // Keep observing the accepted job even when an early Stop request fails.
      if (stopRequested.current) void requestStop(accepted.runId, controller);
      await subscribeToRunEvents(
        accepted.runId,
        (event) => dispatch({ type: "run.progress", value: event }),
        controller.signal,
      );
      const completed = await fetchRun(accepted.runId, controller.signal);
      rememberRun(completed, submittedDraft.shared.currency);
      setDateAdjustments(runDataContext(completed.snapshot)?.dateAdjustments ?? []);
      dispatch({ type: "run.update", value: completed, applyResolvedDates: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      setRunError(asRunApiError(error));
    } finally {
      if (activeRunController.current === controller) activeRunController.current = null;
      runSubmissionLocked.current = false;
      setRunBusy(false);
      activeRunId.current = null;
      setStopping(false);
    }
  };

  const handleStop = async () => {
    if (!canStop || stopRequested.current) return;
    stopRequested.current = true;
    setStopping(true);
    const runId = activeRunId.current;
    const controller = activeRunController.current;
    if (!runId || !controller) return;
    await requestStop(runId, controller);
  };

  const handleReset = () => {
    if (runBusy) return;
    submittedRunRef.current = true;
    dispatch({ type: "run.reset" });
    setRunError(null);
    setDateAdjustments([]);
  };

  const handleImport = (file: PackageFile) => {
    if (!catalog || runSubmissionLocked.current || runBusy) return;
    submittedRunRef.current = true;
    activeRunController.current?.abort();
    const fresh = workspaceForDraft(packageDraft(file, catalog), catalog).state;
    setWorkspace(current => ({ ...(file.type === "backtest"
      ? workspaceReducer(fresh, { type: "run.update", value: file.result }, catalog) : fresh),
      importedBacktest: file.type === "backtest" ? file : null,
      resultRevision: (current?.resultRevision ?? 0) + 1,
    }));
    setValidationState(null);
    setRunError(null);
    setDateAdjustments([]);
  };

  return {
    dispatch, currentValidation, runError, runBusy, canStop, browserSaveFailed, stopping, dateAdjustments,
    availability, handleRun, handleStop, handleReset, handleImport, isLocked,
  };
}
