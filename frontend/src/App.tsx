import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogApiError, fetchCatalog } from "./api/catalog";
import type { Catalog, Diagnostic, StrategyPresetId } from "./api/generated";
import { sharedSummaryEndDate } from "./features/config/summary";
import { SharedSettingsDialog } from "./features/config/SharedSettingsDialog";
import { SHARED_FIELD_KEYS } from "./features/config/SharedSettingsForm";
import { RunActions } from "./features/runs/RunActions";
import { useRunController, validationDiagnostics } from "./features/runs/useRunController";
import { DiagnosticList, type DiagnosticFieldAction } from "./features/runs/DiagnosticList";
import { applyMarketDateRecovery, marketDateRecovery } from "./features/runs/dateRecovery";
import { ResultViewer } from "./features/results/ResultViewer";
import { useWorkspace } from "./features/strategies/useWorkspace";
import { StrategyNavigator, type StrategyFieldNavigation } from "./features/strategies/StrategyWorkspace";
import { interpolate, translate, type Locale } from "./i18n/messages";
import { LocaleControl } from "./shared/ui/LocaleControl";
import { WorkbenchDivider } from "./shared/ui/WorkbenchDivider";

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; value: Catalog }
  | { status: "failed"; error: CatalogApiError };

function App() {
  const [locale, setLocale] = useState<Locale>("ja");
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  const [configCollapsed, setConfigCollapsed] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 1279px)").matches,
  );
  const [sharedSettingsDialogOpen, setSharedSettingsDialogOpen] = useState(false);
  const [sharedSettingsFocusKey, setSharedSettingsFocusKey] = useState<string | null>(null);
  const [strategyFieldNavigation, setStrategyFieldNavigation] = useState<StrategyFieldNavigation | null>(null);
  const [mobilePanel, setMobilePanel] = useState<"config" | "results">("results");
  const sharedSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const catalog = catalogState.status === "ready" ? catalogState.value : null;
  const { workspace, setWorkspace, nextStrategyId, saveFailed: draftSaveFailed } = useWorkspace(catalog);
  const {
    dispatch, currentValidation, runError, runBusy, stopping, availability, dateAdjustments,
    handleRun, handleStop, handleReset, isLocked, browserSaveFailed: resultSaveFailed,
  } = useRunController(catalog, workspace, setWorkspace);
  const browserSaveFailed = draftSaveFailed || resultSaveFailed;

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

  const handleAdd = (presetId: StrategyPresetId) => {
    if (isLocked()) return;
    dispatch({ type: "strategy.add", id: nextStrategyId(presetId), presetId });
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
    const recovery = marketDateRecovery(diagnostic);
    if (recovery?.range) {
      const label = translate(locale, "market.adjust_period");
      return { label, actionLabel: label, activate: () => {
        if (isLocked()) return;
        const shared = applyMarketDateRecovery(workspace.draft.shared, recovery);
        if (shared !== workspace.draft.shared) dispatch({ type: "shared.change", value: shared });
        else {
          setSharedSettingsFocusKey("run.startDate");
          setSharedSettingsDialogOpen(true);
        }
      } };
    }

    const sharedKey = SHARED_FIELD_KEYS.find((key) => key === fieldPath);
    if (sharedKey) {
      const definition = catalog.parameters?.find((item) => item.key === sharedKey);
      if (!definition) return null;
      return {
        label: translate(locale, definition.translationKey),
        activate: () => {
          if (isLocked()) return;
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
        if (isLocked()) return;
        setStrategyFieldNavigation({ strategyId: strategy.id, parameterKey, fieldIndex, conditionId });
        setConfigCollapsed(false);
        if (window.matchMedia("(max-width: 767px)").matches) setMobilePanel("config");
      },
    };
  }, [catalog, locale, workspace, isLocked, dispatch]);


  return (
    <div className="app-frame" lang={locale === "ja" ? "ja" : "zh-Hans"}>
      <a className="skip-link" href="#main-content">{translate(locale, "app.skipToMain")}</a>
      <header className="app-topbar">
        <h1 className="sr-only">{translate(locale, "page.title")}</h1>
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
          {browserSaveFailed && <p className="field-error" role="status">{translate(locale, "storage.saveFailed")}</p>}
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
                    onClick={() => { if (!isLocked()) setSharedSettingsDialogOpen(true); }}
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
                  {dateAdjustments.length > 0 && (
                    <p className="shared-date-adjustment" role="status">
                      {dateAdjustments.map((adjustment) => interpolate(translate(locale,
                        adjustment.reason === "indicator_warmup" ? "run.adjustedIndicatorStart" : "run.adjustedMarketStart"),
                      { date: adjustment.effectiveDate })).join(" ")}
                    </p>
                  )}
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
              <div className="results">
                <fieldset className="result-interactions" disabled={runBusy} aria-label={translate(locale, "section.results")}>
                  <ResultViewer locale={locale} state={workspace} dispatch={dispatch} error={runError} busy={runBusy} fieldAction={fieldActionForDiagnostic} />
                </fieldset>
              </div>
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
