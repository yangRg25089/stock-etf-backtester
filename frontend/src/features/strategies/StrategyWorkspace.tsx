import { useState, type Dispatch } from "react";
import type { Catalog, DraftValidationResponse, StrategyPresetId } from "../../api/generated";
import { interpolate, translate, unitLabel, type Locale } from "../../i18n/messages";
import { ParameterField } from "../../shared/ui/ParameterField";
import type { WorkspaceAction, WorkspaceState } from "./model";

interface StrategyWorkspaceProps {
  catalog: Catalog;
  locale: Locale;
  state: WorkspaceState;
  validation: DraftValidationResponse | null;
  dispatch: Dispatch<WorkspaceAction>;
  onAdd(presetId: StrategyPresetId): void;
}

function strategySummary(
  locale: Locale,
  presetId: StrategyPresetId,
  params: Record<string, unknown>,
): string {
  if (presetId !== "vix_dca") return translate(locale, `presets.${presetId}.description`);
  if (params["vix.buyEnabled"] === false) return translate(locale, "strategy.vixDisabled");
  const maximum = params["accumulation.maxSignalBuysPerMonth"];
  return interpolate(translate(locale, "strategy.vixSummary"), {
    symbol: String(params["vix.symbol"] ?? ""),
    threshold: String(params["vix.buyThreshold"] ?? ""),
    maximum: maximum == null
      ? translate(locale, "strategy.unlimited")
      : `${String(maximum)} ${unitLabel(locale, "count") ?? ""}`.trim(),
  });
}

export function StrategyWorkspace({
  catalog,
  locale,
  state,
  validation,
  dispatch,
  onAdd,
}: StrategyWorkspaceProps) {
  const [selectedPresetId, setSelectedPresetId] = useState<StrategyPresetId | "">("");
  const presets = catalog.presets ?? [];
  const strategies = state.draft.strategies;
  const active = strategies.find((strategy) => strategy.id === state.activeStrategyId) ?? null;
  const preset = active ? presets.find((item) => item.id === active.presetId) ?? null : null;
  const activeValidation = validation?.strategies?.find(
    (item) => item.strategyId === active?.id,
  );
  const activeErrors = activeValidation?.diagnostics ?? [];
  const dependencies = Object.fromEntries(
    (catalog.parameters ?? []).map((definition) => [
      definition.key,
      active && Object.hasOwn(active.params, definition.key)
        ? active.params[definition.key]
        : definition.default,
    ]),
  );

  return (
    <div className="workspace-grid">
      <section className="strategy-workspace" aria-labelledby="strategy-workspace-heading">
        <div className="section-heading">
          <div>
            <h2 id="strategy-workspace-heading">{translate(locale, "section.strategyWorkspace")}</h2>
            <p className="section-subhead">{translate(locale, "section.strategyWorkspaceHelp")}</p>
          </div>
        </div>
        {!active || !preset ? (
          <div className="workspace-placeholder" role="status">
            <span className="placeholder-mark" aria-hidden="true">↗</span>
            <p>{translate(locale, "strategy.noSelection")}</p>
          </div>
        ) : (
          <div className="strategy-editor">
            <div className="strategy-editor-heading">
              <div>
                <h3>{translate(locale, preset.nameKey)}</h3>
                <p className="strategy-summary">
                  {strategySummary(locale, active.presetId, active.params)}
                </p>
              </div>
              <span className={`enabled-tag${active.enabled ? " is-enabled" : ""}`}>
                {translate(locale, active.enabled ? "strategy.enabled" : "strategy.disabled")}
              </span>
            </div>
            <p className="strategy-description">{translate(locale, preset.descriptionKey)}</p>
            <fieldset className="strategy-parameters">
              <legend>{translate(locale, "strategy.parameters")}</legend>
              <div className="strategy-parameter-grid">
                {preset.parameterKeys.map((key) => {
                  const definition = catalog.parameters?.find((item) => item.key === key);
                  if (!definition) return null;
                  return (
                    <ParameterField
                      key={key}
                      definition={definition}
                      value={active.params[key]}
                      locale={locale}
                      dependencyValues={dependencies}
                      errors={activeErrors}
                      onChange={(value) => dispatch({
                        type: "strategy.param",
                        id: active.id,
                        key,
                        value,
                      })}
                    />
                  );
                })}
              </div>
            </fieldset>
          </div>
        )}
      </section>

      <aside className="strategy-rail" aria-labelledby="strategy-list-heading">
        <div className="section-heading">
          <div>
            <h2 id="strategy-list-heading">{translate(locale, "strategy.listTitle")}</h2>
            <p className="section-subhead">
              {translate(locale, "catalog.count", { count: String(presets.length) })}
            </p>
          </div>
        </div>
        <ul className="strategy-list">
          {strategies.map((strategy) => {
            const itemPreset = presets.find((item) => item.id === strategy.presetId);
            if (!itemPreset) return null;
            const name = translate(locale, itemPreset.nameKey);
            const isActive = strategy.id === state.activeStrategyId;
            const diagnostics = validation?.strategies?.find(
              (item) => item.strategyId === strategy.id,
            )?.diagnostics ?? [];
            const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
            return (
              <li className={`strategy-row${isActive ? " is-active" : ""}`} key={strategy.id}>
                <button
                  type="button"
                  className="strategy-select"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => dispatch({ type: "strategy.select", id: strategy.id })}
                >
                  <span className="strategy-row-name">{name}</span>
                  <span className="strategy-row-summary">
                    {strategySummary(locale, strategy.presetId, strategy.params)}
                  </span>
                  {hasError && <span className="row-error">{translate(locale, "strategy.hasErrors")}</span>}
                </button>
                <label className="strategy-enabled-control">
                  <input
                    type="checkbox"
                    checked={strategy.enabled}
                    aria-label={interpolate(translate(locale, "strategy.toggleEnabled"), { name })}
                    onChange={(event) => dispatch({
                      type: "strategy.enabled",
                      id: strategy.id,
                      value: event.target.checked,
                    })}
                  />
                </label>
                <button
                  className="icon-button strategy-remove"
                  type="button"
                  aria-label={interpolate(translate(locale, "strategy.remove"), { name })}
                  onClick={() => dispatch({ type: "strategy.remove", id: strategy.id })}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>

        <div className="strategy-add">
          <label className="field-label" htmlFor="preset-to-add">{translate(locale, "strategy.addLabel")}</label>
          <select
            className="input"
            id="preset-to-add"
            value={selectedPresetId}
            onChange={(event) => setSelectedPresetId(event.target.value as StrategyPresetId | "")}
          >
            <option value="">{translate(locale, "strategy.choosePreset")}</option>
            {presets.map((item) => (
              <option key={item.id} value={item.id}>{translate(locale, item.nameKey)}</option>
            ))}
          </select>
          <button
            className="button add-strategy-button"
            type="button"
            disabled={!selectedPresetId}
            onClick={() => {
              if (!selectedPresetId) return;
              onAdd(selectedPresetId);
              setSelectedPresetId("");
            }}
          >
            + {translate(locale, "strategy.add")}
          </button>
        </div>
      </aside>
    </div>
  );
}
