import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Catalog, DraftValidationResponse, StrategyPresetId } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { StrategyEditorDialog } from "./StrategyEditorDialog";
import { StrategyToolsDialog } from "./StrategyToolsDialog";
import { StrategyCard } from "./StrategyCard";
import type { WorkspaceAction, WorkspaceState } from "./model";
import { StrategyAddMenu } from "./StrategyAddMenu";

interface StrategyNavigatorProps {
  busy?: boolean;
  catalog: Catalog;
  locale: Locale;
  state: WorkspaceState;
  validation: DraftValidationResponse | null;
  dispatch: Dispatch<WorkspaceAction>;
  onAdd(presetId: StrategyPresetId): void;
  onDuplicate(sourceId: string): void;
  fieldNavigation?: StrategyFieldNavigation | null;
  onFieldNavigationHandled?(): void;
}

type PendingFocus = { strategyId: string } | { addButton: true };

export interface StrategyFieldNavigation {
  strategyId: string;
  parameterKey: string;
  fieldIndex?: number;
  conditionId?: string;
}

export function StrategyNavigator({
  busy = false,
  catalog,
  locale,
  state,
  validation,
  dispatch,
  onAdd,
  onDuplicate,
  fieldNavigation = null,
  onFieldNavigationHandled,
}: StrategyNavigatorProps) {
  const [toolsStrategyId, setToolsStrategyId] = useState<string | null>(null);
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null);
  const [focusFieldKey, setFocusFieldKey] = useState<string | null>(null);
  const [focusFieldIndex, setFocusFieldIndex] = useState<number | undefined>();
  const [focusConditionId, setFocusConditionId] = useState<string | undefined>();
  const cardButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);
  const presets = catalog.presets ?? [];

  const editingStrategy = state.draft.strategies.find((item) => item.id === editingStrategyId);
  const toolsStrategy = state.draft.strategies.find(item => item.id === toolsStrategyId);
  const handleFieldFocusHandled = useCallback(() => {
    setFocusFieldKey(null);
    setFocusFieldIndex(undefined);
    setFocusConditionId(undefined);
  }, []);


  useEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (!pendingFocus) return;
    pendingFocusRef.current = null;
    if ("strategyId" in pendingFocus) {
      cardButtonRefs.current.get(pendingFocus.strategyId)?.focus();
    } else {
      addButtonRef.current?.focus();
    }
  }, [state.draft.strategies]);

  useEffect(() => {
    if (!fieldNavigation || busy) return;
    const target = state.draft.strategies.find((strategy) => strategy.id === fieldNavigation.strategyId);
    if (!target) {
      onFieldNavigationHandled?.();
      return;
    }
    editTriggerRef.current = cardButtonRefs.current.get(target.id) ?? null;
    setFocusFieldKey(fieldNavigation.parameterKey);
    setFocusFieldIndex(fieldNavigation.fieldIndex);
    setFocusConditionId(fieldNavigation.conditionId);
    setEditingStrategyId(target.id);
    onFieldNavigationHandled?.();
  }, [busy, fieldNavigation, onFieldNavigationHandled, state.draft.strategies]);

  const removeStrategy = (id: string, index: number) => {
    if (busy) return;
    const adjacentStrategy = state.draft.strategies[index + 1] ?? state.draft.strategies[index - 1];
    pendingFocusRef.current = adjacentStrategy
      ? { strategyId: adjacentStrategy.id }
      : { addButton: true };
    dispatch({ type: "strategy.remove", id });
  };

  return (
    <section className="strategy-navigator" aria-labelledby="strategy-list-heading">
      <div className="section-heading strategy-navigator-heading">
        <h2 id="strategy-list-heading">{translate(locale, "strategy.listTitle")}</h2>
        <span className="strategy-count" aria-label={`${state.draft.strategies.length}`}>
          {state.draft.strategies.length}
        </span>
        <StrategyAddMenu catalog={catalog} strategies={state.draft.strategies} locale={locale}
          busy={busy} addButtonRef={addButtonRef} onAdd={onAdd} />
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
            const name = translate(locale, preset.nameKey) + (strategy.instanceNumber ? ` ${strategy.instanceNumber}` : "");
            const isRunTarget = strategy.id === state.activeStrategyId;
            const strategyValidation = validation?.strategies?.find(
              (item) => item.strategyId === strategy.id,
            );
            const hasError = strategyValidation?.diagnostics?.some(
              (diagnostic) => diagnostic.severity === "error",
            ) ?? false;
            const summaryId = `strategy-summary-${strategy.id}`;

            return (
              <StrategyCard key={strategy.id} strategy={strategy} name={name} active={isRunTarget}
                busy={busy} hasError={hasError} summaryId={summaryId} locale={locale}
                buttonRef={element => {
                  if (element) cardButtonRefs.current.set(strategy.id, element);
                  else cardButtonRefs.current.delete(strategy.id);
                }}
                onOpen={event => {
                  if (busy) return;
                  dispatch({ type: "strategy.select", id: strategy.id });
                  editTriggerRef.current = event.currentTarget;
                  setFocusFieldKey(null);
                  setFocusFieldIndex(undefined);
                  setFocusConditionId(undefined);
                  setEditingStrategyId(strategy.id);
                }}
                onRemove={() => removeStrategy(strategy.id, index)}
                onTools={() => { if (!busy) setToolsStrategyId(strategy.id); }} />
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
          draft={state.draft}
          onCommit={value => dispatch({ type: "strategy.commit", value })}
          focusFieldKey={focusFieldKey}
          focusFieldIndex={focusFieldIndex}
          focusConditionId={focusConditionId}
          onFieldFocusHandled={handleFieldFocusHandled}
          returnFocusRef={editTriggerRef}
          onClose={() => {
            setEditingStrategyId(null);
            setFocusFieldKey(null);
            setFocusFieldIndex(undefined);
            setFocusConditionId(undefined);
          }}
        />
      )}
      {toolsStrategy && <StrategyToolsDialog key={toolsStrategy.id} locale={locale} busy={busy}
        name={translate(locale, presets.find(item => item.id === toolsStrategy.presetId)?.nameKey ?? "") + (toolsStrategy.instanceNumber ? ` ${toolsStrategy.instanceNumber}` : "")}
        canDuplicate={toolsStrategy.presetId === "composite_dca" && state.draft.strategies.filter(item => item.presetId === "composite_dca").length < (catalog.strategyLimits?.maxCustomInstances ?? 0)}
        onDuplicate={() => onDuplicate(toolsStrategy.id)} onReset={() => dispatch({ type: "strategy.reset", id: toolsStrategy.id })}
        onClose={() => setToolsStrategyId(null)} />}
    </section>
  );
}
