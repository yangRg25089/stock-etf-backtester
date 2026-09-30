import { useEffect, useRef, type RefObject } from "react";
import type { Catalog, Diagnostic, PresetDefinition } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { ParameterField } from "../../shared/ui/ParameterField";
import { parameterFieldId } from "../../shared/ui/parameterFieldId";
import type { StrategyDraft } from "./model";
import { formatStrategySummary } from "./strategySummary";

interface StrategyEditorDialogProps {
  catalog: Catalog;
  strategy: StrategyDraft;
  locale: Locale;
  errors?: Diagnostic[];
  focusFieldKey?: string | null;
  focusFieldIndex?: number;
  onChange(key: string, value: unknown): void;
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
  onChange(key: string, value: unknown): void;
}

function groupedFields(catalog: Catalog, preset: PresetDefinition) {
  const groups = new Map<string, {
    translationKey: string;
    fields: NonNullable<Catalog["parameters"]>;
  }>();
  for (const key of preset.parameterKeys) {
    const definition = catalog.parameters?.find((item) => item.key === key);
    if (!definition) continue;
    const groupId = definition.groupId ?? "general";
    const group = catalog.parameterGroups?.find((item) => item.id === groupId);
    const current = groups.get(groupId) ?? {
      translationKey: group?.translationKey ?? "parameterGroups.general",
      fields: [],
    };
    current.fields.push(definition);
    groups.set(groupId, current);
  }
  return [...groups.entries()];
}

export function StrategyEditorForm({
  catalog,
  strategy,
  preset,
  locale,
  errors,
  onChange,
}: StrategyEditorFormProps) {
  const name = translate(locale, preset.nameKey);
  const groups = groupedFields(catalog, preset);
  const dependencyValues = Object.fromEntries(
    (catalog.parameters ?? []).map((definition) => [
      definition.key,
      Object.hasOwn(strategy.params, definition.key) ? strategy.params[definition.key] : definition.default,
    ]),
  );

  const groupDomId = (groupId: string) => `strategy-parameters-${strategy.id}-${groupId}`;
  const scrollToGroup = (groupId: string) => {
    document.getElementById(groupDomId(groupId))?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <section className="strategy-editor" aria-label={name}>
      <p className="strategy-editor-summary">
        {formatStrategySummary(locale, strategy.presetId, strategy.params)}
      </p>
      {groups.length > 1 && (
        <nav className="strategy-parameter-nav" aria-label={translate(locale, "strategy.parameterGroupNavigation")}>
          {groups.map(([groupId, group]) => (
            <button
              className="button"
              type="button"
              key={groupId}
              aria-controls={groupDomId(groupId)}
              onClick={() => scrollToGroup(groupId)}
            >
              {translate(locale, group.translationKey)}
            </button>
          ))}
        </nav>
      )}
      <fieldset className="strategy-parameters">
        <legend>{translate(locale, "strategy.parameters")}</legend>
        <div className="strategy-parameter-groups">
          {groups.map(([groupId, group]) => (
            <section
              className="strategy-parameter-group"
              id={groupDomId(groupId)}
              key={groupId}
              aria-labelledby={`strategy-parameter-heading-${strategy.id}-${groupId}`}
            >
              <h3 id={`strategy-parameter-heading-${strategy.id}-${groupId}`}>
                {translate(locale, group.translationKey)}
              </h3>
              <div className="strategy-parameter-grid">
                {group.fields.map((definition) => (
                  <ParameterField
                    key={definition.key}
                    id={parameterFieldId(definition.key, strategy.id)}
                    definition={definition}
                    value={strategy.params[definition.key]}
                    locale={locale}
                    dependencyValues={dependencyValues}
                    errors={errors}
                    helperText={definition.key === "accumulation.conditionLogic"
                      ? translate(locale, "strategy.conditionLogicHelp")
                      : undefined}
                    onChange={(value) => onChange(definition.key, value)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </fieldset>
    </section>
  );
}

export function StrategyEditorDialog({
  catalog,
  strategy,
  locale,
  errors = [],
  focusFieldKey = null,
  focusFieldIndex,
  onChange,
  onClose,
  onFieldFocusHandled,
  returnFocusRef,
}: StrategyEditorDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const preset = catalog.presets?.find((item) => item.id === strategy.presetId);

  const closeDialog = () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    returnFocusRef.current?.focus();
    onClose();
  };

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
      const fieldId = parameterFieldId(focusFieldKey, strategy.id);
      const targetId = focusFieldIndex === undefined ? fieldId : `${fieldId}-${focusFieldIndex}`;
      const target = document.getElementById(targetId) ??
        document.getElementById(fieldId) ??
        document.getElementById(`${fieldId}-0`);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "center" });
      onFieldFocusHandled?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusFieldIndex, focusFieldKey, onFieldFocusHandled, strategy.id]);

  if (!preset) return null;

  const name = translate(locale, preset.nameKey);
  const hasError = errors.some((diagnostic) => diagnostic.severity === "error");

  return (
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
            <span className={`status-tag${strategy.enabled ? "" : " is-muted"}`}>
              {translate(locale, strategy.enabled ? "strategy.enabled" : "strategy.disabled")}
            </span>
            <button
              className="button icon-only-button strategy-dialog-close"
              type="button"
              aria-label={translate(locale, "strategy.closeDialog")}
              title={translate(locale, "strategy.closeDialog")}
              onClick={closeDialog}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>
        <div className="strategy-dialog-content">
          <StrategyEditorForm
            catalog={catalog}
            strategy={strategy}
            preset={preset}
            locale={locale}
            errors={errors}
            onChange={onChange}
          />
        </div>
        <footer className="strategy-dialog-footer">
          <button className="button button-primary dialog-done" type="button" onClick={closeDialog}>
            {translate(locale, "workbench.settingsDone")}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
