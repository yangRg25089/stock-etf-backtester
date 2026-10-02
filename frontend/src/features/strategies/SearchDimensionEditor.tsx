import type { Catalog, Diagnostic, PresetDefinition } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { ParameterField } from "../../shared/ui/ParameterField";
import { parameterFieldId } from "../../shared/ui/parameterFieldId";
import { DiagnosticList } from "../runs/DiagnosticList";

interface Props {
  catalog: Catalog;
  preset: PresetDefinition;
  strategyId: string;
  params: Record<string, unknown>;
  errors: Diagnostic[];
  locale: Locale;
  currency?: string;
  onChange(key: string, value: unknown): void;
}

export function SearchDimensionEditor({ catalog, preset, strategyId, params, errors, locale, currency, onChange }: Props) {
  const dimensions = preset.searchDimensions ?? [];
  const selected = Array.isArray(params["search.dimensions"]) ? params["search.dimensions"] as string[] : [];
  const active = dimensions.filter(dimension => selected.includes(dimension.key));
  const valuesFor = (key: string | null | undefined) => key && Array.isArray(params[key]) ? params[key] as unknown[] : [];
  const count = active.length ? active.reduce((total, dimension) => total * valuesFor(dimension.valuesParameterKey).length, 1) : 0;
  const selectorErrors = errors.filter(item => item.fieldPath?.endsWith(".search.dimensions"));
  const maximum = catalog.parameters?.find(item => item.key === "search.maxCombinations");
  const headingId = `search-dimensions-${strategyId}`;
  return <section className="search-dimension-editor" aria-labelledby={headingId}>
    <h4 id={headingId}>{translate(locale, "parameterGroups.search")}</h4>
    <div className="search-dimension-toggles" role="group" aria-label={translate(locale, "parameters.search.dimensions")}>
      {dimensions.map(dimension => <button key={dimension.key} type="button" className="search-dimension-toggle"
        data-dimension-key={dimension.key} aria-pressed={selected.includes(dimension.key)}
        aria-invalid={selectorErrors.length > 0 || undefined}
        aria-describedby={selectorErrors.length ? `${headingId}-error` : undefined}
        onClick={() => onChange("search.dimensions", selected.includes(dimension.key)
          ? selected.filter(key => key !== dimension.key) : [...selected, dimension.key])}>
        <span aria-hidden="true">{selected.includes(dimension.key) ? "✓" : "+"}</span>
        {translate(locale, dimension.translationKey ?? `parameters.${dimension.key}`)}
      </button>)}
    </div>
    <p className="field-hint">{translate(locale, "search.valuesHelp")}</p>
    {selectorErrors.length > 0 && <div id={`${headingId}-error`}><DiagnosticList diagnostics={selectorErrors} locale={locale} /></div>}
    <div className="search-values-grid">
      {active.map(dimension => {
        const definition = catalog.parameters?.find(item => item.key === dimension.valuesParameterKey);
        return definition && <div className="search-value-card" key={dimension.key}>
          <ParameterField definition={definition} value={params[definition.key]} locale={locale} currency={currency}
            id={parameterFieldId(definition.key, strategyId)} errors={errors} onChange={value => onChange(definition.key, value)} />
        </div>;
      })}
    </div>
    <div className="search-combination-settings">
      <output className="search-combination-count" aria-live="polite">{translate(locale, "search.combinationCount", { count: String(count) })}</output>
      {maximum && <ParameterField definition={maximum} value={params[maximum.key]} locale={locale}
        id={parameterFieldId(maximum.key, strategyId)} errors={errors} onChange={value => onChange(maximum.key, value)} />}
    </div>
  </section>;
}
