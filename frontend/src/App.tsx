import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogApiError, fetchCatalog } from "./api/catalog";
import type { Catalog, Diagnostic, StrategyPresetId, StrategyStatus } from "./api/generated";
import {
  createIdempotencyKey,
  fetchRun,
  fetchLatestRun,
  subscribeToRunEvents,
  RunApiError,
  submitRun,
  validateDraft,
  stopRun,
} from "./api/runs";
import type { RunProgressEvent } from "./api/runs";
import { sharedSummaryEndDate } from "./features/config/summary";
import { SharedSettingsDialog } from "./features/config/SharedSettingsDialog";
import { SHARED_FIELD_KEYS } from "./features/config/SharedSettingsForm";
import { RunActions } from "./features/runs/RunActions";
import { readDismissedRunId, rememberDismissedRun } from "./features/runs/resultVisibility";
import { DiagnosticList, type DiagnosticFieldAction } from "./features/runs/DiagnosticList";
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
import {
  StrategyNavigator,
  type StrategyFieldNavigation,
} from "./features/strategies/StrategyWorkspace";
import { interpolate, translate, type Locale } from "./i18n/messages";
import { LocaleControl } from "./shared/ui/LocaleControl";
import { WorkbenchDivider } from "./shared/ui/WorkbenchDivider";

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
    status === "unavailable" || status === "failed" || status === "cancelled";
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
  const [stopping, setStopping] = useState(false);
  const stopRequested = useRef(false);
  const activeRunId = useRef<string | null>(null);
  const [configCollapsed, setConfigCollapsed] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches,
  );
  const [sharedSettingsDialogOpen, setSharedSettingsDialogOpen] = useState(false);
  const [sharedSettingsFocusKey, setSharedSettingsFocusKey] = useState<string | null>(null);
  const [strategyFieldNavigation, setStrategyFieldNavigation] = useState<StrategyFieldNavigation | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"config" | "results">("results");
  const sharedSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const strategySequence = useRef(2);
  const activeRunController = useRef<AbortController | null>(null);
  const runSubmissionLocked = useRef(false);
  const submittedRunRef = useRef(false);

  const catalog = catalogState.status === "ready" ? catalogState.value : null;
  const dispatch = useCallback((action: WorkspaceAction) => {
    if (!catalog) return;
    if (runSubmissionLocked.current && action.type !== "run.update" && action.type !== "run.progress") return;
    setWorkspace((current) => current
      ? workspaceReducer(current, action, catalog)
      : current);
  }, [catalog]);

  useEffect(() => {
    document.documentElement.lang = locale === "ja" ? "ja" : "zh-Hans";
    document.title = translate(locale, "app.documentTitle");
  }, [locale]);

  useEffect(() => {
    const responsive = window.matchMedia("(max-width: 1279px)");
    const syncConfigVisibility = (event: MediaQueryListEvent) => setConfigCollapsed(event.matches);
    responsive.addEventListener("change", syncConfigVisibility);
    return () => responsive.removeEventListener("change", syncConfigVisibility);
  }, []);

  useEffect(() => {
    const desktopView = window.matchMedia("(min-width: 768px)");
    const resetMobilePanel = (event: MediaQueryListEvent) => {
      if (event.matches) setMobilePanel("results");
    };
    desktopView.addEventListener("change", resetMobilePanel);
    return () => desktopView.removeEventListener("change", resetMobilePanel);
  }, []);

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
    if (!catalog) return;
    const controller = new AbortController();
    activeRunController.current = controller;

    const restoreLatestRun = async () => {
      try {
        let response = await fetchLatestRun(controller.signal);
        if (!response || submittedRunRef.current || response.runId === readDismissedRunId()) return;

        const restore = (value: Awaited<ReturnType<typeof fetchLatestRun>>) => {
          if (!value || submittedRunRef.current) return;
          setWorkspace((current) => {
            if (submittedRunRef.current) return current;
            const base = current ?? createInitialWorkspaceState(catalog);
            return workspaceReducer(base, { type: "run.update", value }, catalog);
          });
        };

        const restoreProgress = (value: RunProgressEvent) => {
          if (submittedRunRef.current) return;
          setWorkspace((current) => {
            if (submittedRunRef.current || !current) return current;
            return workspaceReducer(current, { type: "run.progress", value }, catalog);
          });
        };

        restore(response);
        if (isTerminal(response.status)) return;

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

    void restoreLatestRun();
    return () => {
      controller.abort();
      if (activeRunController.current === controller) activeRunController.current = null;
    };
  }, [catalog]);

  useEffect(() => () => {
    activeRunController.current?.abort();
  }, []);

  const currentValidation = workspace && validationState?.draft === workspace.draft
    ? validationState.response
    : null;
  const availability = { disabled: !catalog || !workspace, reasonKey: null };

  const handleAdd = (presetId: StrategyPresetId) => {
    if (runSubmissionLocked.current) return;
    const id = `strategy-${presetId}-${strategySequence.current}`;
    strategySequence.current += 1;
    dispatch({ type: "strategy.add", id, presetId });
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

    try {
      const validation = await validateDraft(apiDraft, controller.signal);
      setValidationState({ draft: submittedDraft, response: validation, error: null });
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

  const handleSharedSettingsClosed = useCallback(() => {
    setSharedSettingsDialogOpen(false);
    setSharedSettingsFocusKey(null);
  }, []);

  const handleSharedFieldFocusHandled = useCallback(() => {
    setSharedSettingsFocusKey(null);
  }, []);

  const handleStrategyFieldNavigationHandled = useCallback(() => {
    setStrategyFieldNavigation(null);
  }, []);

  const fieldActionForDiagnostic = useCallback((diagnostic: Diagnostic): DiagnosticFieldAction | null => {
    const fieldPath = diagnostic.fieldPath;
    if (!fieldPath || !catalog || !workspace) return null;

    const sharedKey = SHARED_FIELD_KEYS.find((key) => key === fieldPath);
    if (sharedKey) {
      const definition = catalog.parameters?.find((item) => item.key === sharedKey);
      if (!definition) return null;
      return {
        label: translate(locale, definition.translationKey),
        activate: () => {
          if (runSubmissionLocked.current) return;
          setSharedSettingsFocusKey(sharedKey);
          setSharedSettingsDialogOpen(true);
        },
      };
    }

    const ruleMatch = /^strategies\[(\d+)\]\.rules\.(buy|sell)((?:\.children\[\d+\])*)\.params\.([A-Za-z][A-Za-z0-9_.-]*)$/.exec(fieldPath);
    const match = /^strategies\[(\d+)\]\.params\.([A-Za-z][A-Za-z0-9_.-]*?)(?:\[(\d+)\])?$/.exec(fieldPath);
    if (!match && !ruleMatch) return null;
    const strategy = workspace.draft.strategies[Number(ruleMatch?.[1] ?? match?.[1])];
    const parameterKey = ruleMatch?.[4] ?? match?.[2];
    if (!parameterKey) return null;
    const fieldIndex = !ruleMatch && match?.[3] !== undefined ? Number(match[3]) : undefined;
    if (!strategy) return null;
    const preset = catalog.presets?.find((item) => item.id === strategy.presetId);
    const definition = catalog.parameters?.find((item) => item.key === parameterKey);
    if ((!ruleMatch && !preset?.parameterKeys.includes(parameterKey)) || !definition) return null;
    let conditionId: string | undefined;
    if (ruleMatch) {
      let node = strategy.rules?.[ruleMatch[2] as "buy" | "sell"];
      for (const child of ruleMatch[3].matchAll(/children\[(\d+)\]/g)) {
        node = node && !("kind" in node) ? node.children?.[Number(child[1])] : undefined;
      }
      conditionId = node?.id;
    }

    return {
      label: translate(locale, definition.translationKey),
      activate: () => {
        setStrategyFieldNavigation({ strategyId: strategy.id, parameterKey, fieldIndex, conditionId });
        setConfigCollapsed(false);
        if (window.matchMedia("(max-width: 767px)").matches) setMobilePanel("config");
      },
    };
  }, [catalog, locale, workspace]);


  return (
    <div className="app-frame" lang={locale === "ja" ? "ja" : "zh-Hans"}>
      <h1 className="sr-only">{translate(locale, "page.title")}</h1>
      <a className="skip-link" href="#main-content">{translate(locale, "app.skipToMain")}</a>
      <header className="app-topbar">
        <div className="topbar-brand">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">B</span>
            <span className="brand-name">{translate(locale, "app.name")}</span>
          </div>
        </div>
        {catalog && workspace && (
          <RunActions
            locale={locale}
            availability={availability}
            busy={runBusy}
                stopping={stopping}
                onStop={() => void handleStop()}
            run={workspace.runResponse}
            canReset={Boolean(workspace.runResponse || runError)}
            onReset={handleReset}
            onRun={() => void handleRun()}
          />
        )}
        <div className="topbar-right">
          <LocaleControl locale={locale} onChange={setLocale} />
        </div>
      </header>

      <main id="main-content" className="main-content workbench-main">
        <div className="workbench-context">
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
            <div className="workbench-mobile-views" role="group" aria-label={translate(locale, "workbench.mobile.label")}>
              <button
                className="workbench-mobile-view"
                type="button"
                aria-pressed={mobilePanel === "config"}
                onClick={() => setMobilePanel("config")}
              >
                {translate(locale, "workbench.mobile.config")}
              </button>
              <button
                className="workbench-mobile-view"
                type="button"
                aria-pressed={mobilePanel === "results"}
                onClick={() => setMobilePanel("results")}
              >
                {translate(locale, "workbench.mobile.results")}
              </button>
            </div>
          )}
        </div>

        {catalog && workspace && (
          <div className={`workbench-layout${configCollapsed ? " is-config-collapsed" : ""}`} data-mobile-panel={mobilePanel}>
            <aside id="workbench-config-panel" className="workbench-config" hidden={configCollapsed && mobilePanel !== "config"} aria-label={translate(locale, "workbench.configPanel")}>
              <div className="workbench-config-fixed">
                <div className="shared-settings-block">
                  <button
                    ref={sharedSettingsTriggerRef}
                    className="button shared-settings-summary shared-settings-open-button"
                    type="button"
                    aria-label={translate(locale, "workbench.editSharedSettings")}
                    title={translate(locale, "workbench.editSharedSettings")}
                    aria-haspopup="dialog"
                    aria-describedby="shared-settings-summary-detail"
                    disabled={runBusy}
                    onClick={() => { if (!runSubmissionLocked.current) setSharedSettingsDialogOpen(true); }}
                  >
                    <span className="shared-settings-summary-copy">
                      <strong>{translate(locale, "section.sharedSettings")}</strong>
                      <span className="shared-settings-summary-text" id="shared-settings-summary-detail">
                        <span className="shared-settings-summary-symbol">
                          <span className="summary-emoji" aria-hidden="true">📈</span>{" "}{workspace.draft.shared.run.symbol}
                        </span>
                        <span className="shared-settings-summary-period">
                          <span className="summary-emoji" aria-hidden="true">🗓️</span>{" "}{workspace.draft.shared.run.startDate} → {sharedSummaryEndDate(workspace.draft.shared) ?? "—"}
                        </span>
                        <span className="shared-settings-summary-funding">
                          <span className="summary-emoji" aria-hidden="true">💰</span>{" "}{interpolate(translate(locale, "workbench.funding"), {
                            amount: `${workspace.draft.shared.contribution.amount ?? "—"} ${workspace.draft.shared.currency ?? translate(locale, "unit.currency")}`,
                            day: String(workspace.draft.shared.contribution.day ?? "—"),
                          })}
                        </span>
                      </span>
                    </span>
                  </button>
                  {currentValidation && validationDiagnostics(currentValidation).length > 0 && (
                    <details className="validation-diagnostics config-diagnostics">
                      <summary>{translate(locale, "diagnostics.title")}</summary>
                      <DiagnosticList
                        locale={locale}
                        diagnostics={validationDiagnostics(currentValidation)}
                        fieldAction={fieldActionForDiagnostic}
                      />
                    </details>
                  )}
                  {validationState?.draft === workspace.draft && validationState.error && (
                    <p className="field-error" role="alert">{translate(locale, "run.validationFailed")}</p>
                  )}
                </div>
                <StrategyNavigator
                  busy={runBusy}
                  catalog={catalog}
                  locale={locale}
                  state={workspace}
                  validation={currentValidation}
                  dispatch={dispatch}
                  onAdd={handleAdd}
                  fieldNavigation={strategyFieldNavigation}
                  onFieldNavigationHandled={handleStrategyFieldNavigationHandled}
                />
              </div>
            </aside>
            <WorkbenchDivider
              collapsed={configCollapsed}
              label={translate(locale, configCollapsed ? "workbench.showConfig" : "workbench.hideConfig")}
              onToggle={() => setConfigCollapsed((current) => !current)}
            />
            <section
              id="workbench-results-panel"
              className="workbench-results"
              aria-label={translate(locale, "section.results")}
              hidden={mobilePanel === "config"}
            >
              <section className="results" aria-label={translate(locale, "section.results")}>
                <fieldset className="result-interactions" disabled={runBusy} aria-label={translate(locale, "section.results")}>
                  <ResultViewer locale={locale} state={workspace} dispatch={dispatch} error={runError} busy={runBusy} />
                </fieldset>
              </section>
            </section>
          </div>
        )}
      </main>
      {sharedSettingsDialogOpen && catalog && workspace && (
        <SharedSettingsDialog
          catalog={catalog}
          value={workspace.draft.shared}
          data={workspace.draft.shared.data}
          locale={locale}
          focusFieldKey={sharedSettingsFocusKey}
          onFieldFocusHandled={handleSharedFieldFocusHandled}
          onChange={(value) => dispatch({ type: "shared.change", value })}
          onClose={handleSharedSettingsClosed}
          returnFocusRef={sharedSettingsTriggerRef}
        />
      )}
    </div>
  );
}

export default App;
