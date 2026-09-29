import { useEffect, useState } from "react";
import { CatalogApiError, fetchCatalog } from "./api/catalog";
import type { Catalog } from "./api/generated";
import { SharedSettingsForm } from "./features/config/SharedSettingsForm";
import { translate, type Locale } from "./i18n/messages";
import { LocaleControl } from "./shared/ui/LocaleControl";

type CatalogState =
  | { status: "loading" }
  | { status: "ready"; value: Catalog }
  | { status: "failed"; error: CatalogApiError };

function App() {
  const [locale, setLocale] = useState<Locale>("ja");
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [retryCount, setRetryCount] = useState(0);

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
        const catalogError =
          error instanceof CatalogApiError
            ? error
            : new CatalogApiError("catalog.fetch_failed");
        setCatalogState({ status: "failed", error: catalogError });
      });
    return () => controller.abort();
  }, [retryCount]);

  return (
    <div className="app-frame" lang={locale === "ja" ? "ja" : "zh-Hans"}>
      <a className="skip-link" href="#main-content">
        {translate(locale, "app.skipToMain")}
      </a>
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
            {translate(locale, "status.empty")}
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

        {catalogState.status === "ready" && (
          <>
            <SharedSettingsForm catalog={catalogState.value} locale={locale} />
            <div className="workspace-grid">
              <section className="strategy-workspace" aria-labelledby="strategy-workspace-heading">
                <div className="section-heading">
                  <div>
                    <h2 id="strategy-workspace-heading">
                      {translate(locale, "section.strategyWorkspace")}
                    </h2>
                    <p className="section-subhead">
                      {translate(locale, "section.strategyWorkspaceHelp")}
                    </p>
                  </div>
                </div>
                <div className="workspace-placeholder" role="status">
                  <span className="placeholder-mark" aria-hidden="true">↗</span>
                  <p>{translate(locale, "section.strategyWorkspaceHelp")}</p>
                </div>
              </section>

              <aside className="strategy-rail" aria-labelledby="catalog-heading">
                <div className="section-heading">
                  <div>
                    <h2 id="catalog-heading">{translate(locale, "catalog.title")}</h2>
                    <p className="section-subhead">
                      {translate(locale, "catalog.count", { count: String(catalogState.value.presets?.length ?? 0) })}
                    </p>
                  </div>
                </div>
                <ul className="preset-catalog">
                  {(catalogState.value.presets ?? []).map((preset) => (
                    <li key={preset.id}>{translate(locale, preset.nameKey)}</li>
                  ))}
                </ul>
              </aside>
            </div>

            <section className="results" aria-labelledby="results-heading">
              <div className="results-heading">
                <div>
                  <h2 id="results-heading">{translate(locale, "section.results")}</h2>
                  <p className="section-subhead">{translate(locale, "section.resultsHelp")}</p>
                </div>
                <button
                  className="button button-small"
                  type="button"
                  disabled
                  aria-label={translate(locale, "export.csvLabel")}
                >
                  ↓ {translate(locale, "export.csv")}
                </button>
              </div>
              <div className="empty-results" role="status" aria-live="polite">
                <span className="empty-mark" aria-hidden="true">⌁</span>
                <div>
                  <strong>{translate(locale, "results.emptyTitle")}</strong>
                  <p>{translate(locale, "results.emptyHelp")}</p>
                </div>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
