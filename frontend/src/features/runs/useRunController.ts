import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Catalog, Diagnostic, RunResponse } from "../../api/generated";
import {
  createIdempotencyKey, fetchRun, fetchLatestRun, subscribeToRunEvents,
  RunApiError, submitRun, validateDraft, stopRun, type RunProgressEvent,
} from "../../api/runs";
import {
  createInitialWorkspaceState, getRunAvailability, serializeDraftForApi, workspaceReducer,
  type BacktestDraft, type WorkspaceAction, type WorkspaceState,
} from "../strategies/model";
import { readDismissedRunId, rememberDismissedRun } from "./resultVisibility";
import { isTerminalRunStatus, readCachedRun, saveCachedRun } from "./runPersistence";

interface ValidationState {
  draft: BacktestDraft;
  response: Awaited<ReturnType<typeof validateDraft>> | null;
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
  const [runError, setRunError] = useState<RunApiError | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [browserSaveFailed, setBrowserSaveFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRequested = useRef(false);
  const activeRunId = useRef<string | null>(null);
  const activeRunController = useRef<AbortController | null>(null);
  const runSubmissionLocked = useRef(false);
  const submittedRunRef = useRef(false);
  const isLocked = useCallback(() => runSubmissionLocked.current, []);

  const dispatch = useCallback((action: WorkspaceAction) => {
    if (!catalog) return;
    if (runSubmissionLocked.current && action.type !== "run.update" && action.type !== "run.progress") return;
    setWorkspace((current) => current
      ? workspaceReducer(current, action, catalog)
      : current);
  }, [catalog, setWorkspace]);

  const persistRun = useCallback((response: RunResponse, signal: AbortSignal) => {
    void saveCachedRun(response).then(saved => {
      if (!signal.aborted && !saved) setBrowserSaveFailed(true);
    });
  }, []);

  useEffect(() => {
    if (!catalog) return;
    const controller = new AbortController();
    activeRunController.current = controller;

    const restoreLatestRun = async () => {
      try {
        const restore = (value: Awaited<ReturnType<typeof fetchLatestRun>>) => {
          if (!value || controller.signal.aborted || submittedRunRef.current || value.runId === readDismissedRunId()) return;
          setWorkspace((current) => {
            if (submittedRunRef.current) return current;
            const base = current ?? createInitialWorkspaceState(catalog);
            return workspaceReducer(base, { type: "run.update", value }, catalog);
          });
        };

        restore(await readCachedRun());
        if (controller.signal.aborted || submittedRunRef.current) return;
        let response = await fetchLatestRun(controller.signal);
        if (!response || submittedRunRef.current || response.runId === readDismissedRunId()) return;

        const restoreProgress = (value: RunProgressEvent) => {
          if (submittedRunRef.current) return;
          setWorkspace((current) => {
            if (submittedRunRef.current || !current) return current;
            return workspaceReducer(current, { type: "run.progress", value }, catalog);
          });
        };

        restore(response);
        if (isTerminalRunStatus(response.status)) { persistRun(response, controller.signal); return; }

        activeRunId.current = response.runId;
        runSubmissionLocked.current = true;
        setRunBusy(true);
        await subscribeToRunEvents(response.runId, restoreProgress, controller.signal);
        if (submittedRunRef.current) return;
        response = await fetchRun(response.runId, controller.signal);
        restore(response);
        persistRun(response, controller.signal);
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

    void restoreLatestRun();
    return () => {
      controller.abort();
      if (activeRunController.current === controller) activeRunController.current = null;
    };
  }, [catalog, persistRun, setWorkspace]);

  useEffect(() => () => {
    activeRunController.current?.abort();
  }, []);

  const currentValidation = workspace && validationState?.draft === workspace.draft
    ? validationState.response
    : null;
  const availability = { disabled: !catalog || !workspace, reasonKey: null };

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
      if (stopRequested.current) await stopRun(accepted.runId, controller.signal);
      rememberDismissedRun(null);
      dispatch({
        type: "run.update",
        value: accepted,
      });
      await subscribeToRunEvents(
        accepted.runId,
        (event) => dispatch({ type: "run.progress", value: event }),
        controller.signal,
      );
      const completed = await fetchRun(accepted.runId, controller.signal);
      dispatch({ type: "run.update", value: completed });
      persistRun(completed, controller.signal);
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
    if (!runBusy || stopRequested.current) return;
    stopRequested.current = true;
    setStopping(true);
    if (!activeRunId.current) return;
    try {
      const response = await stopRun(activeRunId.current);
      dispatch({ type: "run.update", value: response });
    } catch (error) {
      stopRequested.current = false;
      setStopping(false);
      setRunError(asRunApiError(error));
    }
  };

  const handleReset = () => {
    if (runBusy) return;
    submittedRunRef.current = true;
    rememberDismissedRun(workspace?.runResponse?.runId ?? null);
    dispatch({ type: "run.reset" });
    setRunError(null);
  };

  return {
    dispatch, currentValidation, runError, runBusy, browserSaveFailed, stopping,
    availability, handleRun, handleStop, handleReset, isLocked,
  };
}
