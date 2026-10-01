import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Catalog, DraftValidationResponse, StrategyPresetId } from "../../api/generated";
import { interpolate, translate, type Locale } from "../../i18n/messages";
import { StrategyEditorDialog } from "./StrategyEditorDialog";
import { formatStrategySummary } from "./strategySummary";
import type { WorkspaceAction, WorkspaceState } from "./model";
import { strategyInstanceLimit } from "./model";

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

type PendingFocus = { strategyId: string } | { addButton: true };

export interface StrategyFieldNavigation {
  strategyId: string;
  parameterKey: string;
  fieldIndex?: number;
  conditionId?: string;
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
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [editingStrategyId, setEditingStrategyId] = useState<string | null>(null);
  const [focusFieldKey, setFocusFieldKey] = useState<string | null>(null);
  const [focusFieldIndex, setFocusFieldIndex] = useState<number | undefined>();
  const [focusConditionId, setFocusConditionId] = useState<string | undefined>();
  const cardButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const addContainerRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const menuFocusRef = useRef<"first" | "last" | null>(null);
  const pendingFocusRef = useRef<PendingFocus | null>(null);
  const presets = catalog.presets ?? [];
  const addablePresets = presets.filter((preset) => preset.id !== "monthly_dca" && preset.id !== "lump_sum");

  const editingStrategy = state.draft.strategies.find((item) => item.id === editingStrategyId);
  const handleFieldFocusHandled = useCallback(() => {
    setFocusFieldKey(null);
    setFocusFieldIndex(undefined);
    setFocusConditionId(undefined);
  }, []);

  useEffect(() => {
    if (!addMenuOpen) return;
    const items = addMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (menuFocusRef.current) {
      const index = menuFocusRef.current === "first" ? 0 : (items?.length ?? 1) - 1;
      items?.[index]?.focus();
      menuFocusRef.current = null;
    }
    const dismissOutside = (event: Event) => {
      if (event.target instanceof Node && !addContainerRef.current?.contains(event.target)) setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [addMenuOpen]);

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
    if (!fieldNavigation) return;
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
  }, [fieldNavigation, onFieldNavigationHandled, state.draft.strategies]);

  const removeStrategy = (id: string, index: number) => {
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
      <div ref={addContainerRef} className={`strategy-add${addMenuOpen ? " is-open" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && addMenuOpen) {
            event.preventDefault();
            setAddMenuOpen(false);
            addButtonRef.current?.focus();
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const last = event.key === "ArrowUp" || event.key === "End";
          if (!addMenuOpen) {
            menuFocusRef.current = last ? "last" : "first";
            setAddMenuOpen(true);
            return;
          }
          const items = [...(addMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
          if (!items.length) return;
          const currentIndex = items.findIndex(item => item === document.activeElement);
          const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (currentIndex + (last ? -1 : 1) + items.length) % items.length;
          items[index]?.focus();
        }}>
        <button
          ref={addButtonRef}
          className="button button-primary icon-only-button add-strategy-button"
          aria-label={translate(locale, "strategy.addLabel")}
          title={translate(locale, "strategy.addLabel")}
          aria-expanded={addMenuOpen}
          aria-haspopup="menu"
          aria-controls="strategy-add-menu"
          type="button"
          onClick={() => {
            menuFocusRef.current = addMenuOpen ? null : "first";
            setAddMenuOpen((open) => !open);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M10 3v14M3 10h14" /></svg>
        </button>
        <div
          id="strategy-add-menu"
          ref={addMenuRef}
          className="strategy-add-menu"
          role="menu"
          aria-label={translate(locale, "strategy.choosePreset")}
          hidden={!addMenuOpen}
        >
          <span className="strategy-add-menu-label">{translate(locale, "strategy.choosePreset")}</span>
          {addablePresets.map((item) => {
            const count = state.draft.strategies.filter(strategy => strategy.presetId === item.id).length;
            const maximum = strategyInstanceLimit(catalog, item.id);
            const alreadyAdded = maximum === undefined || count >= maximum;
            return (
              <button
                key={item.id}
                className="strategy-add-option"
                type="button"
                role="menuitem"
                data-preset-id={item.id}
                disabled={alreadyAdded}
                onClick={() => {
                  if (alreadyAdded) return;
                  onAdd(item.id);
                  setAddMenuOpen(false);
                  addButtonRef.current?.focus();
                }}
              >
                <span>{translate(locale, item.nameKey)}</span>
                {alreadyAdded && <small>{translate(locale, "strategy.alreadyAdded")}</small>}
              </button>
            );
          })}
        </div>
      </div>
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
              <article
                className={`strategy-card strategy-nav-card${isRunTarget ? " is-active" : ""}`}
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
                    setFocusConditionId(undefined);
                    setEditingStrategyId(strategy.id);
                  }}
                >
                  <span className="strategy-card-name">{name}</span>
                  <span className="strategy-card-summary" id={summaryId}>
                    {formatStrategySummary(locale, strategy.presetId, strategy.params, strategy.rules)}
                  </span>
                </button>
                <div className="strategy-card-actions">
                  {hasError && <span className="strategy-nav-error">{translate(locale, "strategy.hasErrors")}</span>}
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
    </section>
  );
}
