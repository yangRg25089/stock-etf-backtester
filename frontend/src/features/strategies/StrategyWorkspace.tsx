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

function groupedFields(catalog: Catalog, presetId: StrategyPresetId) {
  const preset = catalog.presets?.find((item) => item.id === presetId);
  const groups = new Map<string, {
    translationKey: string;
    fields: NonNullable<Catalog["parameters"]>;
  }>();
  for (const key of preset?.parameterKeys ?? []) {
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

export function StrategyNavigator({
  catalog,
  locale,
  state,
  validation,
  dispatch,
  onAdd,
}: StrategyWorkspaceProps) {
  const [selectedPresetId, setSelectedPresetId] = useState<StrategyPresetId | "">("");
  const presets = catalog.presets ?? [];

  return (
    <section className="strategy-navigator" aria-labelledby="strategy-list-heading">
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
          {state.draft.strategies.map((strategy) => {
            const preset = presets.find((item) => item.id === strategy.presetId);
            if (!preset) return null;
            const name = translate(locale, preset.nameKey);
            const isActive = strategy.id === state.activeStrategyId;
            const strategyValidation = validation?.strategies?.find(
              (item) => item.strategyId === strategy.id,
            );
            const hasError = strategyValidation?.diagnostics?.some(
              (diagnostic) => diagnostic.severity === "error",
            ) ?? false;
            return (
              <article className={`strategy-card strategy-nav-card${isActive ? " is-active" : ""}`} key={strategy.id}>
                <div className="strategy-card-heading">
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
                  <div className="strategy-card-actions">
                    {hasError && <span className="strategy-nav-error">{translate(locale, "strategy.hasErrors")}</span>}
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
                      <span className="sr-only">
                        {translate(locale, strategy.enabled ? "strategy.enabled" : "strategy.disabled")}
                      </span>
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
                <span className="strategy-card-summary">
                  {strategySummary(locale, strategy.presetId, strategy.params)}
                </span>
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

export function StrategyEditor({
  catalog,
  locale,
  state,
  validation,
  dispatch,
}: Omit<StrategyWorkspaceProps, "onAdd">) {
  const strategy = state.draft.strategies.find((item) => item.id === state.activeStrategyId);
  const preset = strategy && catalog.presets?.find((item) => item.id === strategy.presetId);
  if (!strategy || !preset) {
    return (
      <section className="strategy-editor" aria-labelledby="strategy-editor-heading">
        <h2 id="strategy-editor-heading" className="sr-only">{translate(locale, "section.strategyWorkspace")}</h2>
        <div className="workspace-placeholder" role="status">
          <span className="placeholder-mark" aria-hidden="true">↗</span>
          <p>{translate(locale, "strategy.noSelection")}</p>
        </div>
      </section>
    );
  }

  const name = translate(locale, preset.nameKey);
  const strategyValidation = validation?.strategies?.find((item) => item.strategyId === strategy.id);
  const errors = strategyValidation?.diagnostics ?? [];
  const hasError = errors.some((diagnostic) => diagnostic.severity === "error");
  const dependencyValues = Object.fromEntries(
    (catalog.parameters ?? []).map((definition) => [
      definition.key,
      Object.hasOwn(strategy.params, definition.key) ? strategy.params[definition.key] : definition.default,
    ]),
  );

  return (
    <section className="strategy-editor" aria-labelledby="strategy-editor-heading">
      <div className="strategy-editor-heading">
        <div>
          <h2 id="strategy-editor-heading">{name}</h2>
          <p className="section-subhead">{translate(locale, preset.descriptionKey)}</p>
        </div>
        <span className={`status-tag${strategy.enabled ? "" : " is-muted"}`}>
          {translate(locale, strategy.enabled ? "strategy.enabled" : "strategy.disabled")}
        </span>
      </div>
      <p className="strategy-editor-summary">{strategySummary(locale, strategy.presetId, strategy.params)}</p>
      {hasError && <p className="strategy-card-error">{translate(locale, "strategy.hasErrors")}</p>}
      <fieldset className="strategy-parameters">
        <legend>{translate(locale, "strategy.parameters")}</legend>
        <div className="strategy-parameter-groups">
          {groupedFields(catalog, strategy.presetId).map(([groupId, group]) => (
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
    </section>
  );
}

export function StrategyWorkspace(props: StrategyWorkspaceProps) {
  return (
    <div className="strategy-workspace">
      <StrategyNavigator {...props} />
      <StrategyEditor {...props} />
    </div>
  );
}
