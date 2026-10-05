import type { Catalog, Diagnostic } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { ParameterField } from "../../shared/ui/ParameterField";
import type { SharedDraft } from "./defaults";
import type { SharedFieldKey } from "./fieldKeys";

interface SharedSettingsFormProps {
  catalog: Catalog;
  value: SharedDraft;
  locale: Locale;
  onChange(value: SharedDraft): void;
  errors?: Diagnostic[];
  currency?: string;
}

export function SharedSettingsForm({ catalog, value, locale, onChange, errors = [], currency }: SharedSettingsFormProps) {
  const values: Record<SharedFieldKey, unknown> = {
    "run.symbol": value.run.symbol, "run.startDate": value.run.startDate, "run.endDate": value.run.endDate,
    "contribution.amount": value.contribution.amount, "contribution.day": value.contribution.day,
    "analysis.riskFreeAnnualRatePct": value.analysis?.riskFreeAnnualRatePct,
    "execution.commission": value.execution?.commission,
    "execution.slippagePct": value.execution?.slippagePct,
    "execution.spreadPct": value.execution?.spreadPct,
    "execution.fractionalShares": value.execution?.fractionalShares,
    "execution.capitalGainsTaxEnabled": value.execution?.capitalGainsTaxEnabled,
  };
  const dependencies = { ...Object.fromEntries((catalog.parameters ?? []).map(({ key, default: item }) => [key, item])), ...values };
  const update = (key: SharedFieldKey, next: unknown) => {
    if (key === "run.symbol") {
      const symbol = String(next ?? "").trim().toUpperCase();
      onChange({ ...value, run: { ...value.run, symbol }, currency: catalog.symbolSuggestions?.find(item => item.symbol === symbol)?.currency });
    } else if (key === "run.startDate" || key === "run.endDate") {
      const name = key === "run.startDate" ? "startDate" : "endDate";
      onChange({ ...value, run: { ...value.run, [name]: next == null ? null : String(next) } });
    } else if (key === "contribution.amount") {
      onChange({ ...value, contribution: { ...value.contribution, amount: next == null ? null : String(next) } });
    } else if (key === "analysis.riskFreeAnnualRatePct") {
      onChange({ ...value, analysis: { riskFreeAnnualRatePct: next == null ? null : String(next) } });
    } else if (key.startsWith("execution.")) {
      const name = key.slice("execution.".length);
      onChange({ ...value, execution: { ...value.execution!, [name]: name === "fractionalShares" || name === "capitalGainsTaxEnabled" ? next === true : next == null ? null : String(next) } });
    } else {
      onChange({ ...value, contribution: { ...value.contribution, day: next == null || next === "" ? null : Number(next) } });
    }
  };
  const field = (key: SharedFieldKey) => {
    const definition = catalog.parameters?.find(item => item.key === key);
    if (!definition) throw new Error(`Catalog is missing shared parameter ${key}`);
    return <ParameterField key={key} definition={definition} value={values[key]} locale={locale}
      onChange={next => update(key, next)} dependencyValues={dependencies} errors={errors} required currency={currency ?? value.currency}
      appearance={definition.type === "boolean" ? "switch" : "default"}
      helperText={key === "analysis.riskFreeAnnualRatePct" || key.startsWith("execution.") ? translate(locale, `${definition.translationKey}.help`) : undefined} />;
  };
  return <section className="shared-settings" aria-label={translate(locale, "section.sharedSettings")}>
    <div className="shared-settings-grid">
      <fieldset className="shared-settings-group shared-settings-asset-group">
        <legend>{translate(locale, "section.sharedSettingsAsset")}</legend>
        <div className="shared-settings-fields shared-settings-fields-asset">{field("run.symbol")}</div>
        <div className="etf-quick-choices" aria-label={translate(locale, "field.popularEtfs")}>
          {(catalog.symbolSuggestions ?? []).map(item => <button key={item.symbol} type="button"
            className={`etf-choice${value.run.symbol === item.symbol ? " is-selected" : ""}`}
            aria-pressed={value.run.symbol === item.symbol} title={item.name}
            onClick={() => update("run.symbol", item.symbol)}>{item.symbol}</button>)}
        </div>
      </fieldset>
      <fieldset className="shared-settings-group shared-settings-range-group">
        <legend>{translate(locale, "section.sharedSettingsPeriod")}</legend>
        <div className="shared-settings-fields shared-settings-fields-range">{field("run.startDate")}{field("run.endDate")}</div>
      </fieldset>
      <fieldset className="shared-settings-group shared-settings-funding-group">
        <legend>{translate(locale, "section.sharedSettingsFunding")}</legend>
        <div className="shared-settings-fields shared-settings-fields-funding">{field("contribution.amount")}{field("contribution.day")}</div>
      </fieldset>
      <fieldset className="shared-settings-group shared-settings-analysis-group">
        <legend>{translate(locale, "parameterGroups.analysis")}</legend>
        <div className="shared-settings-fields">{field("analysis.riskFreeAnnualRatePct")}</div>
      </fieldset>
      <fieldset className="shared-settings-group shared-settings-execution-group">
        <legend>{translate(locale, "parameterGroups.execution")}</legend>
        <div className="shared-settings-fields">{field("execution.commission")}{field("execution.slippagePct")}{field("execution.spreadPct")}{field("execution.fractionalShares")}{field("execution.capitalGainsTaxEnabled")}</div>
      </fieldset>
    </div>
  </section>;
}
