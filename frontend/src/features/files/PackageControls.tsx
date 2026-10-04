import { useEffect, useRef, useState } from "react";
import type { BacktestPackage, Catalog, RunResponse } from "../../api/generated";
import { fetchBacktestPackage, RunApiError } from "../../api/runs";
import { isTerminalRunStatus } from "../../api/runStatus";
import { useWorkbenchShortcut } from "../../shared/ui/useWorkbenchShortcut";
import { translate, type Locale } from "../../i18n/messages";
import type { BacktestDraft } from "../strategies/model";
import { triggerFileDownload } from "../results/exportModel";
import { createStrategyPackage, packageBlob, packageDraft, PackageError, readPackage, readPackageFile, type PackageFile } from "./packageModel";

interface PackageControlsProps {
  catalog: Catalog; draft: BacktestDraft; run: RunResponse | null;
  imported?: BacktestPackage | null; locale: Locale; busy: boolean;
  onImport(file: PackageFile): void;
}

function PackagePreview({ file, catalog, locale, onCancel, onLoad }: {
  file: PackageFile; catalog: Catalog; locale: Locale; onCancel(): void; onLoad(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const draft = packageDraft(file, catalog);
  return <dialog ref={dialog} className="shared-settings-dialog package-preview" aria-modal="true" aria-labelledby="package-preview-title"
    onCancel={event => { event.preventDefault(); onCancel(); }}
    onClick={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="shared-settings-dialog-shell">
      <header className="shared-settings-dialog-heading">
        <h2 id="package-preview-title">{translate(locale, "files.preview")}</h2>
        <button type="button" className="button icon-only-button" onClick={onCancel} aria-label={translate(locale, "files.cancel")}><span aria-hidden="true">×</span></button>
      </header>
      <div className="package-preview-content">
        <strong>{draft.shared.run.symbol}</strong>
        <p>{draft.shared.run.startDate} → {draft.shared.run.endDate}</p>
        <ul>{draft.strategies.map(strategy => <li key={strategy.id}>{translate(locale, catalog.presets?.find(preset => preset.id === strategy.presetId)?.nameKey ?? "")}{strategy.instanceNumber ? ` ${strategy.instanceNumber}` : ""}</li>)}</ul>
        <p className="package-preview-result">{translate(locale, file.type === "backtest" ? "files.withResult" : "files.strategyOnly")}</p>
        <p className="field-help">{translate(locale, "files.replaceNotice")}</p>
      </div>
      <footer className="shared-settings-dialog-footer">
        <button className="button" type="button" onClick={onCancel}>{translate(locale, "files.cancel")}</button>
        <button className="button button-primary" type="button" onClick={onLoad}>{translate(locale, "files.load")}</button>
      </footer>
    </div>
  </dialog>;
}

export function PackageControls({ catalog, draft, run, imported, locale, busy, onImport }: PackageControlsProps) {
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<PackageFile | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  useEffect(() => {
    setPending(false); setPreview(null); setErrorKey(null);
    return () => controller.current?.abort();
  }, [run?.runId, busy, locale]);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  const closePreview = () => { setPreview(null); menu.current?.querySelector("summary")?.focus(); };
  const showError = (error: unknown) => setErrorKey(error instanceof PackageError || error instanceof RunApiError ? error.messageKey : "files.readFailed");

  const exportFile = async (type: "strategy" | "backtest") => {
    if (busy || pending || (type === "backtest" && !run)) return;
    closeMenu(); setErrorKey(null); setPending(true);
    const request = new AbortController();
    controller.current?.abort(); controller.current = request;
    try {
      const file = type === "strategy" ? createStrategyPackage(draft, catalog)
        : readPackage(imported ? { ...imported, exportedAt: new Date().toISOString() }
          : await fetchBacktestPackage(run!.runId, request.signal), catalog);
      if (request.signal.aborted) return;
      const config = packageDraft(file, catalog);
      const symbol = config.shared.run.symbol.replace(/[^A-Za-z0-9._^-]/g, "_");
      triggerFileDownload(packageBlob(file), `${symbol}-${type === "strategy" ? "strategy" : run!.runId}.${type}.json`);
    } catch (error) { if (!request.signal.aborted) showError(error); }
    finally { if (!request.signal.aborted) setPending(false); }
  };

  const importFile = async (file: File | undefined) => {
    if (!file || busy || pending) return;
    setErrorKey(null); setPending(true);
    const request = new AbortController();
    controller.current?.abort(); controller.current = request;
    try {
      const checked = await readPackageFile(file, catalog);
      if (!request.signal.aborted) setPreview(checked);
    } catch (error) { if (!request.signal.aborted) showError(error); }
    finally { if (!request.signal.aborted) setPending(false); }
  };
  const canExportResult = Boolean(run && isTerminalRunStatus(run.status));
  useWorkbenchShortcut("e", !busy && !pending && (canExportResult || draft.strategies.length > 0),
    () => { void exportFile(canExportResult ? "backtest" : "strategy"); });
  useWorkbenchShortcut("i", !busy && !pending, () => { closeMenu(); input.current?.click(); });
  return <div className="package-controls">
    <details ref={menu} className="package-menu">
      <summary aria-label={translate(locale, "files.menu")} title={`${translate(locale, "files.menu")} · Ctrl/⌘ + E / I`}
        aria-disabled={busy || pending} aria-busy={pending}
        onClick={event => { if (busy || pending) event.preventDefault(); }}>
        {pending ? <span className="run-button-spinner" aria-hidden="true" /> : <span aria-hidden="true">⋯</span>}
      </summary>
      <div className="package-menu-options">
        <button type="button" disabled={busy || pending || !draft.strategies.length} aria-keyshortcuts={!canExportResult ? "Control+E Meta+E" : undefined} onClick={() => void exportFile("strategy")}>{translate(locale, "files.exportStrategy")}</button>
        <button type="button" disabled={busy || pending || !canExportResult} aria-keyshortcuts={canExportResult ? "Control+E Meta+E" : undefined} onClick={() => void exportFile("backtest")}>{translate(locale, "files.exportResult")}</button>
        <button type="button" disabled={busy || pending} aria-keyshortcuts="Control+I Meta+I" onClick={() => { closeMenu(); input.current?.click(); }}>{translate(locale, "files.import")}</button>
      </div>
    </details>
    <input ref={input} className="file-import-input" type="file" accept=".json,application/json" hidden
      aria-label={translate(locale, "files.import")}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void importFile(file); }} />
    {errorKey && <div className="package-error" role="alert">
      <span>{translate(locale, errorKey)}</span>
      <button type="button" className="button icon-only-button" onClick={() => setErrorKey(null)} aria-label={translate(locale, "files.dismiss")}><span aria-hidden="true">×</span></button>
    </div>}
    {preview && <PackagePreview file={preview} catalog={catalog} locale={locale} onCancel={closePreview}
      onLoad={() => { onImport(preview); closePreview(); }} />}
  </div>;
}
