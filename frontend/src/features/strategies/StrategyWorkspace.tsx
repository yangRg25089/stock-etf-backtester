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

  return (
    <section className="strategy-workspace" aria-labelledby="strategy-workspace-heading">
      <div className="section-heading">
        <div>
          <h2 id="strategy-workspace-heading">{translate(locale, "section.strategyWorkspace")}</h2>
          <p className="section-subhead">{translate(locale, "section.strategyWorkspaceHelp")}</p>
        </div>
      </div>

      {strategies.length === 0 ? (
        <div className="workspace-placeholder" role="status">
          <span className="placeholder-mark" aria-hidden="true">↗</span>
          <p>{translate(locale, "strategy.noSelection")}</p>
        </div>
      ) : (
        <div className="strategy-card-list">
          {strategies.map((strategy) => {
            const preset = presets.find((item) => item.id === strategy.presetId);
            if (!preset) return null;
            const name = translate(locale, preset.nameKey);
            const isActive = strategy.id === state.activeStrategyId;
            const strategyValidation = validation?.strategies?.find(
              (item) => item.strategyId === strategy.id,
            );
            const errors = strategyValidation?.diagnostics ?? [];
            const hasError = errors.some((diagnostic) => diagnostic.severity === "error");
            const dependencyValues = Object.fromEntries(
              (catalog.parameters ?? []).map((definition) => [
                definition.key,
                Object.hasOwn(strategy.params, definition.key)
                  ? strategy.params[definition.key]
                  : definition.default,
              ]),
            );
            const groupedFields = new Map<string, {
              translationKey: string;
              fields: NonNullable<Catalog["parameters"]>;
            }>();
            for (const key of preset.parameterKeys) {
              const definition = catalog.parameters?.find((item) => item.key === key);
              if (!definition) continue;
              const groupId = definition.groupId ?? "general";
              const group = catalog.parameterGroups?.find((item) => item.id === groupId);
              const current = groupedFields.get(groupId) ?? {
                translationKey: group?.translationKey ?? "parameterGroups.general",
                fields: [],
              };
              current.fields.push(definition);
              groupedFields.set(groupId, current);
            }

            return (
              <article
                className={`strategy-card${isActive ? " is-active" : ""}`}
                key={strategy.id}
              >
                <div className="strategy-card-heading">
                  <div className="strategy-card-title">
                    <h3 className="strategy-card-name">
                      <button
                        type="button"
                        className="strategy-card-select"
                        aria-current={isActive ? "true" : undefined}
                        onClick={() => dispatch({ type: "strategy.select", id: strategy.id })}
                      >
                        {name}
                      </button>
                    </h3>
                    <span className="strategy-card-summary">
                      {strategySummary(locale, strategy.presetId, strategy.params)}
                    </span>
                  </div>
                  <div className="strategy-card-actions">
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
                      <span>{translate(locale, strategy.enabled ? "strategy.enabled" : "strategy.disabled")}</span>
                    </label>
                    <button
                      className="icon-button strategy-remove"
                      type="button"
                      aria-label={interpolate(translate(locale, "strategy.remove"), { name })}
                      onClick={() => dispatch({ type: "strategy.remove", id: strategy.id })}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <p className="strategy-description">{translate(locale, preset.descriptionKey)}</p>
                {hasError && <p className="strategy-card-error">{translate(locale, "strategy.hasErrors")}</p>}

                <fieldset className="strategy-parameters">
                  <legend>{translate(locale, "strategy.parameters")}</legend>
                  <div className="strategy-parameter-groups">
                    {[...groupedFields.entries()].map(([groupId, group]) => (
                      <section className="strategy-parameter-group" key={groupId} aria-labelledby={`parameters-${strategy.id}-${groupId}`}>
                        <h4 id={`parameters-${strategy.id}-${groupId}`}>{translate(locale, group.translationKey)}</h4>
                        <div className="strategy-parameter-grid">
                          {group.fields.map((definition) => {
                            const key = definition.key;
                            return (
                              <ParameterField
                                key={key}
                                id={`field-${strategy.id}-${key.replaceAll(".", "-")}`}
                                definition={definition}
                                value={strategy.params[key]}
                                locale={locale}
                                dependencyValues={dependencyValues}
                                errors={errors}
                                helperText={key === "accumulation.conditionLogic"
                                  ? translate(locale, "strategy.conditionLogicHelp")
                                  : undefined}
                                onChange={(value) => dispatch({
                                  type: "strategy.param",
                                  id: strategy.id,
                                  key,
                                  value,
                                })}
                              />
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                </fieldset>
              </article>
            );
          })}
        </div>
      )}

      <div className="strategy-add">
        <label className="field-label" htmlFor="preset-to-add">{translate(locale, "strategy.addLabel")}</label>
        <div className="strategy-add-select">
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
          <p className="field-hint">{translate(locale, "strategy.addHelp")}</p>
        </div>
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
    </section>
  );
}
