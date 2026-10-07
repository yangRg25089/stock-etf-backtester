import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Catalog } from "../../api/generated";
import { useWorkbenchShortcut } from "../../shared/ui/useWorkbenchShortcut";
import { translate, type Locale } from "../../i18n/messages";
import { strategyInstanceName } from "../../shared/lib/strategyInstanceName";
import type { BacktestDraft } from "../strategies/model";
import { triggerFileDownload } from "../results/exportModel";
import { createStrategyPackage, packageBlob, packageDraft, PackageError, readPackageFile, type PackageFile } from "./packageModel";

interface PackageControlsProps {
  catalog: Catalog; draft: BacktestDraft; locale: Locale; busy: boolean;
  onImport(file: PackageFile): void;
  onError?(): void;
}

function PackagePreview({ file, catalog, locale, returnFocus, onCancel, onLoad }: {
  file: PackageFile; catalog: Catalog; locale: Locale; returnFocus: RefObject<HTMLButtonElement>; onCancel(): void; onLoad(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const button = returnFocus.current;
    const focusTarget = button?.getClientRects().length ? button
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.showModal();
    return () => {
      node?.close();
      focusTarget?.focus({ preventScroll: true });
    };
  }, [returnFocus]);
  const draft = packageDraft(file, catalog);
  const content = <dialog ref={dialog} className="shared-settings-dialog package-preview" aria-modal="true" aria-labelledby="package-preview-title"
    onCancel={event => { event.preventDefault(); onCancel(); }}
    onClick={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="shared-settings-dialog-shell">
      <div className="shared-settings-dialog-heading">
        <h2 id="package-preview-title">{translate(locale, "files.preview")}</h2>
        <button type="button" className="button icon-only-button" onClick={onCancel} aria-label={translate(locale, "files.cancel")}><span aria-hidden="true">×</span></button>
      </div>
      <div className="package-preview-content">
        <strong>{draft.shared.run.symbol}</strong>
        <p>{draft.shared.run.startDate} → {draft.shared.run.endDate}</p>
        <ul>{draft.strategies.map(strategy => <li key={strategy.id}>{strategyInstanceName(translate(locale, catalog.presets?.find(preset => preset.id === strategy.presetId)?.nameKey ?? ""), strategy.instanceNumber)}</li>)}</ul>
        <p className="package-preview-result">{translate(locale, "files.strategyOnly")}</p>
        <p className="field-help">{translate(locale, "files.replaceNotice")}</p>
      </div>
      <div className="shared-settings-dialog-footer">
        <button className="button" type="button" onClick={onCancel}>{translate(locale, "files.cancel")}</button>
        <button className="button button-primary" type="button" onClick={onLoad}>{translate(locale, "files.load")}</button>
      </div>
    </div>
  </dialog>;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

export function PackageControls({ catalog, draft, locale, busy, onImport, onError }: PackageControlsProps) {
  const input = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<PackageFile | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  useEffect(() => {
    setPending(false); setPreview(null); setErrorKey(null);
    return () => controller.current?.abort();
  }, [busy, locale]);
  const closePreview = () => setPreview(null);
  const showError = (error: unknown) => {
    setErrorKey(error instanceof PackageError ? error.messageKey : "files.readFailed");
    onError?.();
  };

  const exportFile = () => {
    if (busy || pending) return;
    setErrorKey(null); setPending(true);
    try {
      const file = createStrategyPackage(draft, catalog);
      const symbol = file.draft.shared.run.symbol.replace(/[^A-Za-z0-9._^-]/g, "_");
      triggerFileDownload(packageBlob(file), `${symbol}.strategy.json`);
    } catch (error) { showError(error); }
    finally { setPending(false); }
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
  useWorkbenchShortcut("e", !busy && !pending && draft.strategies.length > 0, exportFile);
  useWorkbenchShortcut("i", !busy && !pending, () => input.current?.click());
  return <div className="package-controls">
    <div className="package-actions" role="group" aria-label={translate(locale, "files.menu")} aria-busy={pending}>
      <button className="button package-action" type="button" disabled={busy || pending || !draft.strategies.length} aria-keyshortcuts="Control+E Meta+E" onClick={exportFile} title={translate(locale, "files.exportStrategy")} aria-label={`export · ${translate(locale, "files.exportStrategy")}`}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" /></svg><span>export</span>
      </button>
      <button ref={importButton} className="button package-action" type="button" disabled={busy || pending} aria-keyshortcuts="Control+I Meta+I" onClick={() => input.current?.click()} title={translate(locale, "files.import")} aria-label={`import · ${translate(locale, "files.import")}`}>
        {pending ? <span className="run-button-spinner" aria-hidden="true" /> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3m-4 4 4-4 4 4M3 13v4h14v-4" /></svg>}
        <span>import</span>
      </button>
    </div>
    <input ref={input} className="file-import-input" type="file" accept=".json,application/json" hidden
      aria-label={translate(locale, "files.import")}
      onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; void importFile(file); }} />
    {errorKey && <div className="package-error" role="alert">
      <span>{translate(locale, errorKey)}</span>
      <button type="button" className="button icon-only-button" onClick={() => setErrorKey(null)} aria-label={translate(locale, "files.dismiss")}><span aria-hidden="true">×</span></button>
    </div>}
    {preview && <PackagePreview file={preview} catalog={catalog} locale={locale} returnFocus={importButton} onCancel={closePreview}
      onLoad={() => { onImport(preview); closePreview(); }} />}
  </div>;
}
