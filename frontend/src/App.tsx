import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogApiError, fetchCatalog } from "./api/catalog";
import type { Catalog, Diagnostic, StrategyPresetId, StrategyStatus } from "./api/generated";
import {
  createIdempotencyKey,
  fetchRun,
  RunApiError,
  submitRun,
  validateDraft,
} from "./api/runs";
import { SharedSettingsForm } from "./features/config/SharedSettingsForm";
import { RunControls } from "./features/runs/RunControls";
import { DiagnosticList, StatusView } from "./features/runs/StatusView";
import { ResultViewer } from "./features/results/ResultViewer";
import {
  createInitialWorkspaceState,
  getRunAvailability,
  serializeDraftForApi,
  workspaceReducer,
  type BacktestDraft,
  type WorkspaceAction,
  type WorkspaceState,
} from "./features/strategies/model";
import { StrategyWorkspace } from "./features/strategies/StrategyWorkspace";
import { translate, type Locale } from "./i18n/messages";
import { LocaleControl } from "./shared/ui/LocaleControl";

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; value: Catalog }
  | { status: "failed"; error: CatalogApiError };

interface ValidationState {
  draft: BacktestDraft;
  response: Awaited<ReturnType<typeof validateDraft>> | null;
  error: RunApiError | null;
}

function asRunApiError(error: unknown): RunApiError {
  if (error instanceof RunApiError) return error;
  return new RunApiError("provider_request_failed", "api.errors.connection_failed", [{
    code: "provider_request_failed",
    messageKey: "api.errors.connection_failed",
    severity: "error",
  }]);
}

function isTerminal(status: StrategyStatus): boolean {
  return status === "completed" || status === "completed_with_warning" ||
    status === "unavailable" || status === "failed";
}

function validationDiagnostics(
  response: Awaited<ReturnType<typeof validateDraft>>,
): Diagnostic[] {
  return [
    ...(response.diagnostics ?? []),
    ...(response.strategies ?? []).flatMap((strategy) => strategy.diagnostics ?? []),
  ];
}

function App() {
  const [locale, setLocale] = useState<Locale>("ja");
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [validationState, setValidationState] = useState<ValidationState | null>(null);
  const [runError, setRunError] = useState<RunApiError | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const strategySequence = useRef(2);
  const activeRunController = useRef<AbortController | null>(null);

  const catalog = catalogState.status === "ready" ? catalogState.value : null;
  const draftForValidation = workspace?.draft ?? null;
  const dispatch = useCallback((action: WorkspaceAction) => {
    if (!catalog) return;
    setWorkspace((current) => current
      ? workspaceReducer(current, action, catalog)
      : current);
  }, [catalog]);

  useEffect(() => {
    document.documentElement.lang = locale === "ja" ? "ja" : "zh-Hans";
    document.title = translate(locale, "app.documentTitle");
  }, [locale]);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogState({ status: "loading" });
    fetchCatalog(controller.signal)
      .then((value) => setCatalogState({ status: "ready", value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const catalogError = error instanceof CatalogApiError
          ? error
          : new CatalogApiError("catalog.fetch_failed");
        setCatalogState({ status: "failed", error: catalogError });
      });
    return () => controller.abort();
  }, [retryCount]);

  useEffect(() => {
    if (!catalog) return;
    setWorkspace((current) => current ?? createInitialWorkspaceState(catalog));
  }, [catalog]);

  useEffect(() => {
    if (!catalog || !draftForValidation) return;
    const draft = draftForValidation;
    const controller = new AbortController();
    setValidationState({ draft, response: null, error: null });
    setRunError(null);
    validateDraft(serializeDraftForApi(draft), controller.signal)
      .then((response) => setValidationState({ draft, response, error: null }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setValidationState({ draft, response: null, error: asRunApiError(error) });
      });
    return () => controller.abort();
  }, [catalog, draftForValidation]);

  useEffect(() => () => activeRunController.current?.abort(), []);

  const currentValidation = workspace && validationState?.draft === workspace.draft
    ? validationState.response
    : null;
  let availability = workspace ? getRunAvailability(workspace, currentValidation) : {
    disabled: true,
    reasonKey: "run.validationPending",
  };
  if (workspace && validationState?.draft === workspace.draft && validationState.error) {
    availability = { disabled: true, reasonKey: "run.validationFailed" };
  }

  const handleAdd = (presetId: StrategyPresetId) => {
    const id = `strategy-${presetId}-${strategySequence.current}`;
    strategySequence.current += 1;
    dispatch({ type: "strategy.add", id, presetId });
  };

  const handleRun = async () => {
    if (!catalog || !workspace || runBusy) return;
    const submittedDraft = workspace.draft;
    const submittedScope = workspace.runScope;
    const submittedActiveId = workspace.activeStrategyId;
    const submittedEndMode = submittedDraft.shared.run.endMode;
    const apiDraft = serializeDraftForApi(submittedDraft);
    const controller = new AbortController();
    activeRunController.current?.abort();
    activeRunController.current = controller;
    setRunBusy(true);
    setRunError(null);

    try {
      const validation = await validateDraft(apiDraft, controller.signal);
      setValidationState({ draft: submittedDraft, response: validation, error: null });
      const submittedState: WorkspaceState = {
        ...workspace,
        draft: submittedDraft,
        runScope: submittedScope,
        activeStrategyId: submittedActiveId,
      };
      const allowed = getRunAvailability(submittedState, validation);
      if (allowed.disabled) {
        const activeDiagnostics = submittedScope === "active"
          ? validation.strategies?.find((item) => item.strategyId === submittedActiveId)?.diagnostics ?? []
          : [];
        const diagnostics = [...(validation.diagnostics ?? []), ...activeDiagnostics];
        if (diagnostics.length > 0) {
          setRunError(new RunApiError(
            "invalid_parameter",
            "api.errors.invalid_configuration",
            diagnostics,
          ));
        }
        return;
      }

      let response = await submitRun(
        apiDraft,
        submittedScope,
        submittedActiveId,
        createIdempotencyKey(),
        controller.signal,
      );
      dispatch({
        type: "run.update",
        value: response,
        requestedEndMode: submittedEndMode,
        requestedScope: submittedScope,
      });
      while (!isTerminal(response.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
        response = await fetchRun(response.runId, controller.signal);
        dispatch({ type: "run.update", value: response });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setRunError(asRunApiError(error));
    } finally {
      if (activeRunController.current === controller) activeRunController.current = null;
      setRunBusy(false);
    }
  };

  return (
    <div className="app-frame" lang={locale === "ja" ? "ja" : "zh-Hans"}>
      <a className="skip-link" href="#main-content">{translate(locale, "app.skipToMain")}</a>
      <header className="app-topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span className="brand-name">{translate(locale, "app.name")}</span>
        </div>
        <div className="topbar-right">
          <span className="local-tag">{translate(locale, "app.localOnly")}</span>
          <LocaleControl locale={locale} onChange={setLocale} />
        </div>
      </header>

      <main id="main-content" className="main-content">
        <div className="page-heading">
          <div>
            <h1>{translate(locale, "page.title")}</h1>
            <p className="section-subhead">{translate(locale, "page.subtitle")}</p>
          </div>
          <span className="status-tag" role="status">
            {translate(locale, workspace?.runResponse ? `status.${workspace.runResponse.status}` : "status.empty")}
          </span>
        </div>

        {catalogState.status === "loading" && (
          <div className="catalog-notice" role="status" aria-live="polite">
            <span className="loading-indicator" aria-hidden="true" />
            {translate(locale, "catalog.loading")}
          </div>
        )}

        {catalogState.status === "failed" && (
          <div className="catalog-error" role="alert">
            <div>
              <strong>{translate(locale, "catalog.unavailable")}</strong>
              <p>{translate(locale, catalogState.error.message)}</p>
            </div>
            <button className="button" type="button" onClick={() => setRetryCount((count) => count + 1)}>
              {translate(locale, "catalog.retry")}
            </button>
          </div>
        )}

        {catalog && workspace && (
          <>
            <SharedSettingsForm
              catalog={catalog}
              value={{
                run: workspace.draft.shared.run,
                contribution: workspace.draft.shared.contribution,
              }}
              locale={locale}
              errors={currentValidation?.diagnostics ?? []}
              resolvedLatestEndDate={
                workspace.runRequestedEndMode === "latest" &&
                workspace.runResponse?.snapshot.config.shared.run.endMode === "fixed"
                  ? workspace.runResponse.snapshot.config.shared.run.endDate
                  : null
              }
              onChange={(value) => dispatch({ type: "shared.change", value })}
            />

            <StrategyWorkspace
              catalog={catalog}
              locale={locale}
              state={workspace}
              validation={currentValidation}
              dispatch={dispatch}
              onAdd={handleAdd}
            />

            {currentValidation && validationDiagnostics(currentValidation).length > 0 && (
              <section className="validation-diagnostics" aria-labelledby="validation-diagnostics-heading">
                <h2 id="validation-diagnostics-heading">{translate(locale, "diagnostics.title")}</h2>
                <DiagnosticList locale={locale} diagnostics={validationDiagnostics(currentValidation)} />
              </section>
            )}
            {validationState?.draft === workspace.draft && validationState.error && (
              <p className="field-error" role="alert">{translate(locale, "run.validationFailed")}</p>
            )}

            <RunControls
              locale={locale}
              runScope={workspace.runScope}
              availability={availability}
              busy={runBusy}
              onScopeChange={(runScope) => dispatch({ type: "run.scope", value: runScope })}
              onRun={() => void handleRun()}
            />

            <section className="results" aria-labelledby="results-heading">
              <div className="results-heading">
                <div>
                  <h2 id="results-heading">{translate(locale, "section.results")}</h2>
                  <p className="section-subhead">{translate(locale, "section.resultsHelp")}</p>
                </div>
              </div>
              <StatusView locale={locale} run={workspace.runResponse} error={runError} />
              <ResultViewer locale={locale} state={workspace} dispatch={dispatch} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
