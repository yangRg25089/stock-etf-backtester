import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Catalog, Diagnostic, PresetDefinition, StrategyRules } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { validateDraft } from "../../api/runs";
import { serializeDraftForApi } from "./model";
import { useDialogValidation } from "../../shared/ui/useDialogValidation";
import { DiagnosticList } from "../runs/DiagnosticList";
import { ParameterField } from "../../shared/ui/ParameterField";
import { parameterFieldId } from "../../shared/ui/parameterFieldId";
import { ConditionEditor } from "./ConditionEditor";
import { SearchDimensionEditor } from "./SearchDimensionEditor";
import { conditionFieldOwner, conditionLeaves } from "./conditions";
import type { BacktestDraft, StrategyDraft } from "./model";

interface StrategyEditorDialogProps {
  catalog: Catalog;
  strategy: StrategyDraft;
  locale: Locale;
  draft: BacktestDraft;
  onCommit(value: StrategyDraft): void;
  focusFieldKey?: string | null;
  focusFieldIndex?: number;
  focusConditionId?: string | null;
  onClose(): void;
  onFieldFocusHandled?(): void;
  returnFocusRef: RefObject<HTMLButtonElement>;
}

interface StrategyEditorFormProps {
  catalog: Catalog;
  strategy: StrategyDraft;
  preset: PresetDefinition;
  locale: Locale;
  errors: Diagnostic[];
  currency?: string;
  onChange(key: string, value: unknown): void;
  onRulesChange(value: StrategyRules): void;
}

function groupedFields(catalog: Catalog, preset: PresetDefinition) {
  const groups = new Map<string, { translationKey: string; fields: NonNullable<Catalog["parameters"]> }>();
  for (const key of preset.parameterKeys) {
    if (!((key.startsWith("accumulation.") && key !== "accumulation.conditionLogic") || key.startsWith("scheduled."))) continue;
    const definition = catalog.parameters?.find(item => item.key === key);
    if (!definition) continue;
    const groupId = definition.groupId ?? "general";
    const group = catalog.parameterGroups?.find(item => item.id === groupId);
    const current = groups.get(groupId) ?? { translationKey: group?.translationKey ?? "parameterGroups.general", fields: [] };
    current.fields.push(definition);
    groups.set(groupId, current);
  }
  return [...groups.entries()];
}

export function StrategyEditorForm({ catalog, strategy, preset, locale, errors, currency, onChange, onRulesChange }: StrategyEditorFormProps) {
  const dependencyValues = Object.fromEntries((catalog.parameters ?? []).map(definition => [definition.key,
    Object.hasOwn(strategy.params, definition.key) ? strategy.params[definition.key] : definition.default,
  ]));
  return <section className="strategy-editor" aria-label={translate(locale, preset.nameKey)}>

    <fieldset className="strategy-parameters">
      <legend className="sr-only">{translate(locale, "strategy.parameters")}</legend>
      <div className="strategy-parameter-groups">
        {groupedFields(catalog, preset).map(([groupId, group]) => <section className="strategy-parameter-group" key={groupId}
          aria-labelledby={`strategy-parameter-heading-${strategy.id}-${groupId}`}>
          <h3 id={`strategy-parameter-heading-${strategy.id}-${groupId}`}>{translate(locale, group.translationKey)}</h3>
          <div className="strategy-parameter-grid">
            {group.fields.map(definition => <ParameterField key={definition.key} id={parameterFieldId(definition.key, strategy.id)}
              definition={definition} value={strategy.params[definition.key]} locale={locale} dependencyValues={dependencyValues}
              currency={currency} errors={errors.filter(error => !error.fieldPath?.includes(".rules."))}
              placeholder={definition.key === "accumulation.maxSignalBuysPerMonth" ? translate(locale, "strategy.unlimited") : undefined}
              appearance={definition.type === "boolean" ? "switch" : "default"} onChange={value => onChange(definition.key, value)} />)}
          </div>
        </section>)}
      </div>
      {preset.editorMode === "search" && <SearchDimensionEditor catalog={catalog} preset={preset} strategyId={strategy.id}
        params={strategy.params} errors={errors} locale={locale} currency={currency} onChange={onChange} />}
    </fieldset>
    {strategy.rules && <ConditionEditor catalog={catalog} strategyId={strategy.id} locale={locale} rules={strategy.rules}
      custom={preset.editorMode === "custom" || preset.editorMode === "search"} fixedTrend={preset.id === "ma_trend"}
      currency={currency} errors={errors} onChange={onRulesChange} />}
  </section>;
}

export function StrategyEditorDialog({
  catalog,
  strategy: originalStrategy,
  draft,
  onCommit,
  locale,
  focusFieldKey = null,
  focusFieldIndex,
  focusConditionId,
  onClose,
  onFieldFocusHandled,
  returnFocusRef,
}: StrategyEditorDialogProps) {
  const [strategy, setStrategy] = useState(() => structuredClone(originalStrategy));
  const validation = useDialogValidation();
  const errors = validation.errors;
  const footerErrors = errors.filter(item => !catalog.parameters?.some(parameter => item.fieldPath?.endsWith(`.${parameter.key}`)));
  const dialogRef = useRef<HTMLDialogElement>(null);
  const preset = catalog.presets?.find((item) => item.id === strategy.presetId);
  const closeDialog = () => void validation.attemptClose(dialogRef.current, async signal => {
    const submitted = { ...draft, strategies: draft.strategies.map(item => item.id === strategy.id ? strategy : item) };
    const response = await validateDraft(serializeDraftForApi(submitted), signal);
    return [...(response.diagnostics ?? []), ...(response.strategies?.find(item => item.strategyId === strategy.id)?.diagnostics ?? [])];
  }, () => {
    onCommit(strategy);
    if (dialogRef.current?.open) dialogRef.current.close();
    returnFocusRef.current?.focus();
    onClose();
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    if (!focusFieldKey) return;
    const frame = window.requestAnimationFrame(() => {
      const condition = [...conditionLeaves(strategy.rules?.buy), ...conditionLeaves(strategy.rules?.sell)].find(node => node.id === focusConditionId);
      const fieldId = parameterFieldId(focusFieldKey, condition ? conditionFieldOwner(strategy.id, condition) : strategy.id);
      const targetId = focusFieldIndex === undefined ? fieldId : `${fieldId}-${focusFieldIndex}`;
      const target = document.getElementById(targetId) ??
        document.getElementById(fieldId) ??
        document.getElementById(`${fieldId}-0`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "center" });
      onFieldFocusHandled?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusConditionId, focusFieldIndex, focusFieldKey, onFieldFocusHandled, strategy.id, strategy.rules]);

  if (!preset) return null;

  const name = `${translate(locale, preset.nameKey)}${strategy.instanceNumber ? ` ${strategy.instanceNumber}` : ""}`;
  const hasError = errors.some((diagnostic) => diagnostic.severity === "error");

  const content = (
    <dialog
      ref={dialogRef}
      className="strategy-dialog"
      id={`strategy-dialog-${strategy.id}`}
      aria-modal="true"
      aria-labelledby="strategy-editor-heading"
      aria-describedby="strategy-editor-description"
      onCancel={(event) => {
        event.preventDefault();
        closeDialog();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div className="strategy-dialog-shell">
        <header className="strategy-dialog-heading">
          <div className="strategy-dialog-heading-copy">
            <h2 id="strategy-editor-heading">{name}</h2>
            <p id="strategy-editor-description">{translate(locale, preset.descriptionKey)}</p>
          </div>
          <div className="strategy-dialog-heading-actions">
            {hasError && <span className="strategy-nav-error">{translate(locale, "strategy.hasErrors")}</span>}
            <button
              className="button icon-only-button strategy-dialog-close"
              type="button"
              aria-label={translate(locale, "strategy.closeDialog")}
              title={translate(locale, "strategy.closeDialog")}
              onClick={closeDialog}
              disabled={validation.pending}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>
        <fieldset className="strategy-dialog-content dialog-fields" disabled={validation.pending}>
          <StrategyEditorForm
            catalog={catalog}
            strategy={strategy}
            preset={preset}
            locale={locale}
            errors={errors}
            currency={draft.shared.currency}
            onChange={(key, value) => { validation.clearErrors(); setStrategy(current => ({ ...current, params: { ...current.params, [key]: value } })); }}
            onRulesChange={rules => { validation.clearErrors(); setStrategy(current => ({ ...current, rules })); }}
          />
        </fieldset>
        <footer className="strategy-dialog-footer">
          {footerErrors.length > 0 && <div className="dialog-diagnostics" role="alert" tabIndex={0}><DiagnosticList diagnostics={footerErrors} locale={locale} /></div>}
          <button className="button button-primary dialog-done" type="button" disabled={validation.pending} aria-busy={validation.pending} onClick={closeDialog}>
            {validation.pending && <span className="run-button-spinner" aria-hidden="true" />}
            {translate(locale, "workbench.settingsDone")}
          </button>
        </footer>
      </div>
    </dialog>
  );
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
