import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Catalog, RunDateAdjustment, RunResponse } from "../../api/generated";
import { runDataContext } from "../../api/contractReader";
import { isActiveRunStatus } from "../../api/runStatus";
import {
  createIdempotencyKey, fetchActiveRun,
  RunApiError, submitRun, validateDraft, stopRun, type RunProgressEvent,
} from "../../api/runs";
import {
  createInitialWorkspaceState, getRunAvailability, serializeDraftForApi, workspaceReducer,
  type WorkspaceAction, type WorkspaceState,
} from "../strategies/model";
import { draftFromRun, workspaceForDraft } from "../strategies/draftReader";
import { restoreWorkspaceState, saveLastRunStrategy } from "../strategies/workspacePersistence";
import { packageDraft, type PackageFile } from "../files/packageModel";
import { observeRun } from "./observeRun";
import { asRunApiError } from "./runErrors";
import { useDraftValidation } from "./useDraftValidation";

export { validationDiagnostics } from "./useDraftValidation";

export function useRunController(
  catalog: Catalog | null,
  workspace: WorkspaceState | null,
  setWorkspace: Dispatch<SetStateAction<WorkspaceState | null>>,
) {
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
        const response = await fetchActiveRun(controller.signal);
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
        const completed = await observeRun(response.runId, restoreProgress, controller.signal,
          () => !submittedRunRef.current);
        restore(completed);
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

  const { currentValidation, error: validationError, failed: preflightFailed, retry: retryValidation,
    accept: acceptValidation, reset: resetValidation } = useDraftValidation(catalog, workspace?.draft, runBusy);
  const dispatch = useCallback((action: WorkspaceAction) => {
    if (!catalog) return;
    if (runSubmissionLocked.current && action.type !== "run.update" && action.type !== "run.progress") return;
    // A successful dialog confirmation may recover a transient preflight error
    // even when its configuration has not changed.
    if (preflightFailed && (action.type === "shared.change" || action.type === "strategy.commit")) {
      retryValidation();
    }
    setWorkspace((current) => current
      ? workspaceReducer(current, action, catalog)
      : current);
  }, [catalog, setWorkspace, preflightFailed, retryValidation]);

  const availability = !workspace ? { disabled: true, reasonKey: "run.validationPending" }
    : validationError
      ? { disabled: true, reasonKey: validationError.messageKey }
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
      acceptValidation(submittedDraft, validation);
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
      const completed = await observeRun(
        accepted.runId,
        (event) => dispatch({ type: "run.progress", value: event }),
        controller.signal,
      );
      if (completed) {
        rememberRun(completed, submittedDraft.shared.currency);
        setDateAdjustments(runDataContext(completed.snapshot)?.dateAdjustments ?? []);
        dispatch({ type: "run.update", value: completed, applyResolvedDates: true });
      }
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
    resetValidation();
    setRunError(null);
    setDateAdjustments([]);
  };

  return {
    dispatch, currentValidation, runError, runBusy, canStop, browserSaveFailed, stopping, dateAdjustments,
    availability, handleRun, handleStop, handleReset, handleImport, isLocked,
  };
}
