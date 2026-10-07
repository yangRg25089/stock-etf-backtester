import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Diagnostic, StrategyPresetId } from "./api/generated";
import { useCatalog } from "./app/useCatalog";
import { useWorkbenchLayout } from "./app/useWorkbenchLayout";
import { sharedSummaryEndDate } from "./features/config/summary";
import { SharedSettingsDialog } from "./features/config/SharedSettingsDialog";
import { RunActions } from "./features/runs/RunActions";
import { useRunController, validationDiagnostics } from "./features/runs/useRunController";
import { DiagnosticList, type DiagnosticFieldAction } from "./features/runs/DiagnosticList";
import { applyMarketDateRecovery } from "./features/runs/dateRecovery";
import { diagnosticTarget } from "./features/runs/diagnosticNavigation";
import { SelectedStrategies } from "./features/results/SelectedStrategies";
import { ResultViewer } from "./features/results/ResultViewer";
import { useWorkspace } from "./features/strategies/useWorkspace";
import { StrategyNavigator, type StrategyFieldNavigation } from "./features/strategies/StrategyWorkspace";
import { interpolate, translate, type Locale } from "./i18n/messages";
import { persistBrowserLocalePreference, readBrowserLocalePreference } from "./i18n/localePreference";
import { ThemeControl } from "./shared/ui/ThemeControl";
import { TopbarMenu } from "./shared/ui/TopbarMenu";
import { LocaleControl } from "./shared/ui/LocaleControl";
import { ReturnColorControl } from "./shared/ui/ReturnColorControl";
import { persistBrowserReturnColorPreference, readBrowserReturnColorPreference, resolveReturnColorPalette, type ReturnColorPalette } from "./shared/lib/returnColorPreference";
import { WorkbenchDivider } from "./shared/ui/WorkbenchDivider";
import { PackageControls } from "./features/files/PackageControls";

function App() {
  const topbar = useRef<HTMLElement>(null);
  const [topbarHeight, setTopbarHeight] = useState(55);
  useEffect(() => {
    const node = topbar.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setTopbarHeight(node.getBoundingClientRect().height));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const [locale, setLocale] = useState<Locale>(readBrowserLocalePreference);
  const [returnColorPreference, setReturnColorPreference] = useState<ReturnColorPalette | null>(readBrowserReturnColorPreference);
  const returnPalette = resolveReturnColorPalette(locale, returnColorPreference);
  const { catalog, catalogState, retryCatalog } = useCatalog();
  const { configCollapsed, setConfigCollapsed, mobilePanel, setMobilePanel, revealConfig } = useWorkbenchLayout();
  const [sharedSettingsDialogOpen, setSharedSettingsDialogOpen] = useState(false);
  const [sharedSettingsFocusKey, setSharedSettingsFocusKey] = useState<string | null>(null);
  const [strategyFieldNavigation, setStrategyFieldNavigation] = useState<StrategyFieldNavigation | null>(null);
  const sharedSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const { workspace, setWorkspace, nextStrategyId } = useWorkspace(catalog);
  const {
    dispatch, currentValidation, runError, runBusy, canStop, stopping, availability, dateAdjustments,
    handleRun, handleStop, handleReset, handleImport, isLocked, browserSaveFailed,
  } = useRunController(catalog, workspace, setWorkspace);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : locale;
    document.title = translate(locale, "app.documentTitle");
  }, [locale]);

  const handleLocaleChange = (nextLocale: Locale) => {
    setLocale(nextLocale);
    persistBrowserLocalePreference(nextLocale);
  };

  const handleReturnColorChange = (palette: ReturnColorPalette) => {
    setReturnColorPreference(palette);
    persistBrowserReturnColorPreference(palette);
  };

  const handleAdd = (presetId: StrategyPresetId) => {
    if (isLocked()) return;
    dispatch({ type: "strategy.add", id: nextStrategyId(presetId), presetId });
  };

  const handleDuplicate = (sourceId: string) => {
    if (isLocked()) return;
    const source = workspace?.draft.strategies.find(item => item.id === sourceId);
    if (source) dispatch({ type: "strategy.duplicate", sourceId, id: nextStrategyId(source.presetId) });
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
    if (!catalog || !workspace) return null;
    const target = diagnosticTarget(diagnostic, catalog, workspace.draft);
    if (!target) return null;
    const label = translate(locale, target.labelKey);
    return {
      label,
      actionLabel: target.kind === "period" ? label : undefined,
      activate: () => {
        if (isLocked()) return;
        if (target.kind === "strategy") {
          setStrategyFieldNavigation(target.navigation);
          revealConfig();
          return;
        }
        if (target.kind === "period") {
          const shared = applyMarketDateRecovery(workspace.draft.shared, target.recovery);
          if (shared !== workspace.draft.shared) {
            dispatch({ type: "shared.change", value: shared });
            return;
          }
        }
        setSharedSettingsFocusKey(target.kind === "shared" ? target.parameterKey : "run.startDate");
        setSharedSettingsDialogOpen(true);
      },
    };
  }, [catalog, locale, workspace, isLocked, dispatch, revealConfig]);


  return (
    <div className="app-frame" lang={locale === "zh" ? "zh-Hans" : locale} data-return-palette={returnPalette}
      style={{ "--app-topbar-height": `${topbarHeight}px` } as CSSProperties}>
      <a className="skip-link" href="#main-content">{translate(locale, "app.skipToMain")}</a>
      <header ref={topbar} className="app-topbar">
        <h1 className="sr-only">{translate(locale, "page.title")}</h1>
        <div className="topbar-brand">
          <div className="brand">
            <img className="brand-mark" src="/brand.svg" alt="" aria-hidden="true" />
            <span className="brand-name">{translate(locale, "app.name")}</span>
          </div>
        </div>
        <TopbarMenu locale={locale} busy={runBusy}>
          {openMenu => <>
            {catalog && workspace && (
              <RunActions
                locale={locale}
                availability={availability}
                busy={runBusy}
                canStop={canStop}
                stopping={stopping}
                onStop={() => void handleStop()}
                run={workspace.runResponse}
                canReset={Boolean(workspace.runResponse || runError)}
                onReset={handleReset}
                onRun={() => void handleRun()}
              />
            )}
            <div className="topbar-right">
              {catalog && workspace && <PackageControls catalog={catalog} draft={workspace.draft} locale={locale} busy={runBusy} onImport={handleImport} onError={openMenu} />}
              <ThemeControl locale={locale} />
              <ReturnColorControl locale={locale} palette={returnPalette} onChange={handleReturnColorChange} />
              <LocaleControl locale={locale} onChange={handleLocaleChange} />
            </div>
          </>}
        </TopbarMenu>
        {workspace && <SelectedStrategies
          run={workspace.runResponse}
          ids={workspace.selectedResultIds}
          focusedResultId={workspace.focusedResultId}
          locale={locale}
          busy={runBusy}
          onSelect={id => {
            if (isLocked()) return;
            dispatch({ type: "result.focus", id });
            setMobilePanel("results");
          }}
        />}
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
              <button className="button" type="button" onClick={retryCatalog}>
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
                  onDuplicate={handleDuplicate}
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
              <h2 className="sr-only">{translate(locale, "section.results")}</h2>
              <div className="results">
                <fieldset className="result-interactions" disabled={runBusy} aria-label={translate(locale, "section.results")}>
                  <ResultViewer key={workspace.resultRevision ?? 0} catalog={catalog} locale={locale} state={workspace} dispatch={dispatch} error={runError} busy={runBusy} fieldAction={fieldActionForDiagnostic} />
                </fieldset>
              </div>
            </section>
          </div>
        )}
      </main>
      <footer className="app-footer">© 2026 Ronny Yang · <a href="https://opensource.org/license/mit" target="_blank" rel="noreferrer">MIT License</a></footer>
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
