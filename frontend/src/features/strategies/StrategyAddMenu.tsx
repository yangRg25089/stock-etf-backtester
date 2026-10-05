import { useEffect, useRef, useState, type RefObject } from "react";
import type { Catalog, StrategyPresetId } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { canAddStrategy, strategyInstanceLimit, type StrategyDraft } from "./model";

/** The menu owns keyboard movement and dismissal; the navigator owns the draft. */
export function StrategyAddMenu({ catalog, strategies, locale, busy, addButtonRef, onAdd }: {
  catalog: Catalog; strategies: StrategyDraft[]; locale: Locale; busy: boolean;
  addButtonRef: RefObject<HTMLButtonElement>; onAdd(presetId: StrategyPresetId): void;
}) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addContainerRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const menuFocusRef = useRef<"first" | "last" | null>(null);
  const presets = catalog.presets ?? [];
  const addablePresets = presets.filter((preset) => preset.id !== "monthly_dca" && preset.id !== "lump_sum");
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
  return (
    <div ref={addContainerRef} className={`strategy-add${addMenuOpen ? " is-open" : ""}`}
      onKeyDown={(event) => {
        if (busy) return;
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
        disabled={busy}
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
          const count = strategies.filter(strategy => strategy.presetId === item.id).length;
          const maximum = strategyInstanceLimit(catalog);
          const totalLimit = catalog.strategyLimits?.maxTotalInstances;
          const atPresetLimit = maximum === undefined || count >= maximum;
          const atTotalLimit = totalLimit === undefined || strategies.length >= totalLimit;
          const disabled = busy || !canAddStrategy(catalog, strategies, item.id);
          return (
            <button
              key={item.id}
              className="strategy-add-option"
              type="button"
              role="menuitem"
              data-preset-id={item.id}
              disabled={disabled}
              onClick={() => {
                if (busy || !canAddStrategy(catalog, strategies, item.id)) return;
                onAdd(item.id);
                setAddMenuOpen(false);
                addButtonRef.current?.focus();
              }}
            >
              <span>{translate(locale, item.nameKey)}</span>
              {disabled && <small>{translate(locale, atPresetLimit ? "strategy.presetLimitReached" : atTotalLimit ? "strategy.totalLimitReached" : "strategy.presetLimitReached")}</small>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
