import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Catalog, DraftValidationResponse, StrategyPresetId } from "../../api/generated";
import { interpolate, translate, type Locale } from "../../i18n/messages";
import { StrategyEditorDialog } from "./StrategyEditorDialog";
import { formatStrategySummary } from "./strategySummary";
import type { WorkspaceAction, WorkspaceState } from "./model";

interface StrategyNavigatorProps {
  catalog: Catalog;
  locale: Locale;
  state: WorkspaceState;
  validation: DraftValidationResponse | null;
  dispatch: Dispatch<WorkspaceAction>;
  onAdd(presetId: StrategyPresetId): void;
  fieldNavigation?: StrategyFieldNavigation | null;
  onFieldNavigationHandled?(): void;
}

type PendingFocus = { strategyId: string } | { presetSelector: true };

export interface StrategyFieldNavigation {
  strategyId: string;
  parameterKey: string;
  fieldIndex?: number;
}

export function StrategyNavigator({
  catalog,
  locale,
  state,
  validation,
  dispatch,
  onAdd,
  fieldNavigation = null,
  onFieldNavigationHandled,
}: StrategyNavigatorProps) {
  const [selectedPresetId, setSelectedPresetId] = useState<StrategyPresetId | "">("");
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null);
  const [focusFieldKey, setFocusFieldKey] = useState<string | null>(null);
  const [focusFieldIndex, setFocusFieldIndex] = useState<number | undefined>();
  const cardButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const presetSelectRef = useRef<HTMLSelectElement>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);
  const presets = catalog.presets ?? [];
  const addablePresets = presets.filter((preset) => preset.id !== "monthly_dca" && preset.id !== "lump_sum");
  const addedPresetIds = new Set(state.draft.strategies.map((strategy) => strategy.presetId));
  const editingStrategy = state.draft.strategies.find((item) => item.id === editingStrategyId);
  const editingDiagnostics = editingStrategy
    ? validation?.strategies?.find((item) => item.strategyId === editingStrategy.id)?.diagnostics ?? []
    : [];
  const handleFieldFocusHandled = useCallback(() => {
    setFocusFieldKey(null);
    setFocusFieldIndex(undefined);
  }, []);

  useEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (!pendingFocus) return;
    pendingFocusRef.current = null;
    if ("strategyId" in pendingFocus) {
      cardButtonRefs.current.get(pendingFocus.strategyId)?.focus();
    } else {
      presetSelectRef.current?.focus();
    }
  }, [state.draft.strategies]);

  useEffect(() => {
    if (!fieldNavigation) return;
    const target = state.draft.strategies.find((strategy) => strategy.id === fieldNavigation.strategyId);
    if (!target) {
      onFieldNavigationHandled?.();
      return;
    }
    editTriggerRef.current = cardButtonRefs.current.get(target.id) ?? null;
    setFocusFieldKey(fieldNavigation.parameterKey);
    setFocusFieldIndex(fieldNavigation.fieldIndex);
    setEditingStrategyId(target.id);
    onFieldNavigationHandled?.();
  }, [fieldNavigation, onFieldNavigationHandled, state.draft.strategies]);

  const removeStrategy = (id: string, index: number) => {
    const adjacentStrategy = state.draft.strategies[index + 1] ?? state.draft.strategies[index - 1];
    pendingFocusRef.current = adjacentStrategy
      ? { strategyId: adjacentStrategy.id }
      : { presetSelector: true };
    dispatch({ type: "strategy.remove", id });
  };

  return (
    <section className="strategy-navigator" aria-labelledby="strategy-list-heading">
      <div className="strategy-add">
        <label className="field-label" htmlFor="preset-to-add">{translate(locale, "strategy.addLabel")}</label>
        <div className="strategy-add-select">
          <select
            ref={presetSelectRef}
            className="input"
            id="preset-to-add"
            aria-describedby="strategy-add-help"
            value={selectedPresetId}
            onChange={(event) => setSelectedPresetId(event.target.value as StrategyPresetId | "")}
          >
            <option value="">{translate(locale, "strategy.choosePreset")}</option>
            {addablePresets.map((item) => (
              <option key={item.id} value={item.id} disabled={addedPresetIds.has(item.id)}>{translate(locale, item.nameKey)}</option>
            ))}
          </select>
          <p className="field-hint sr-only" id="strategy-add-help">
            {translate(locale, "strategy.addHelp")}
          </p>
        </div>
        <button
          className="button button-primary icon-only-button add-strategy-button"
          aria-label={translate(locale, "strategy.add")}
          title={translate(locale, "strategy.add")}
          type="button"
          disabled={!selectedPresetId || addedPresetIds.has(selectedPresetId)}
          onClick={() => {
            if (!selectedPresetId || addedPresetIds.has(selectedPresetId)) return;
            onAdd(selectedPresetId);
            setSelectedPresetId("");
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 3v14M3 10h14" /></svg>
        </button>
      </div>

      <div className="section-heading strategy-navigator-heading">
        <h2 id="strategy-list-heading">{translate(locale, "strategy.listTitle")}</h2>
        <span className="strategy-count" aria-label={`${state.draft.strategies.length}`}>
          {state.draft.strategies.length}
        </span>
      </div>

      {state.draft.strategies.length === 0 ? (
        <div className="workspace-placeholder" role="status">
          <span className="placeholder-mark" aria-hidden="true">↗</span>
          <p>{translate(locale, "strategy.noSelection")}</p>
        </div>
      ) : (
        <div className="strategy-card-list">
          {state.draft.strategies.map((strategy, index) => {
            const preset = presets.find((item) => item.id === strategy.presetId);
            if (!preset) return null;
            const name = translate(locale, preset.nameKey);
            const isRunTarget = strategy.id === state.activeStrategyId;
            const strategyValidation = validation?.strategies?.find(
              (item) => item.strategyId === strategy.id,
            );
            const hasError = strategyValidation?.diagnostics?.some(
              (diagnostic) => diagnostic.severity === "error",
            ) ?? false;
            const summaryId = `strategy-summary-${strategy.id}`;

            return (
              <article
                className={`strategy-card strategy-nav-card${isRunTarget ? " is-active" : ""}${strategy.enabled ? "" : " is-disabled"}`}
                key={strategy.id}
              >
                <button
                  ref={(element) => {
                    if (element) cardButtonRefs.current.set(strategy.id, element);
                    else cardButtonRefs.current.delete(strategy.id);
                  }}
                  className="strategy-card-open"
                  type="button"
                  aria-label={interpolate(translate(locale, "strategy.edit"), { name })}
                  aria-describedby={summaryId}
                  aria-haspopup="dialog"
                  aria-controls={`strategy-dialog-${strategy.id}`}
                  onClick={(event) => {
                    editTriggerRef.current = event.currentTarget;
                    setFocusFieldKey(null);
                    setFocusFieldIndex(undefined);
                    setEditingStrategyId(strategy.id);
                  }}
                >
                  <span className="strategy-card-name">{name}</span>
                  <span className="strategy-card-summary" id={summaryId}>
                    {formatStrategySummary(locale, strategy.presetId, strategy.params)}
                  </span>
                </button>
                <div className="strategy-card-actions">
                  {hasError && <span className="strategy-nav-error">{translate(locale, "strategy.hasErrors")}</span>}
                  <button
                    className="strategy-enabled-control strategy-enable-switch"
                    type="button"
                    role="switch"
                    aria-checked={strategy.enabled}
                    aria-label={interpolate(translate(locale, "strategy.toggleEnabled"), { name })}
                    title={translate(locale, strategy.enabled ? "strategy.enabled" : "strategy.disabled")}
                    onClick={() => dispatch({ type: "strategy.enabled", id: strategy.id, value: !strategy.enabled })}
                  >
                    <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
                    <span className="sr-only">{translate(locale, strategy.enabled ? "strategy.enabled" : "strategy.disabled")}</span>
                  </button>
                  <button
                    className="icon-button strategy-remove"
                    type="button"
                    aria-label={interpolate(translate(locale, "strategy.remove"), { name })}
                    title={interpolate(translate(locale, "strategy.remove"), { name })}
                    onClick={() => removeStrategy(strategy.id, index)}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                      <path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" />
                    </svg>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editingStrategy && (
        <StrategyEditorDialog
          key={editingStrategy.id}
          catalog={catalog}
          strategy={editingStrategy}
          locale={locale}
          errors={editingDiagnostics}
          focusFieldKey={focusFieldKey}
          focusFieldIndex={focusFieldIndex}
          onFieldFocusHandled={handleFieldFocusHandled}
          returnFocusRef={editTriggerRef}
          onChange={(key, value) => dispatch({
            type: "strategy.param",
            id: editingStrategy.id,
            key,
            value,
          })}
          onClose={() => {
            setEditingStrategyId(null);
            setFocusFieldKey(null);
            setFocusFieldIndex(undefined);
          }}
        />
      )}
    </section>
  );
}
