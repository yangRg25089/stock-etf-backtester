import type {
  Catalog,
  Diagnostic,
  ParameterDefinition,
} from "../../api/generated";
import type { ReactNode } from "react";
import { interpolate, translate, type Locale } from "../../i18n/messages";
import { ParameterField } from "../../shared/ui/ParameterField";
import type { SharedDraft } from "./defaults";

interface SharedSettingsFormProps {
  catalog: Catalog;
  value: SharedDraft;
  locale: Locale;
  onChange(value: SharedDraft): void;
  errors?: Diagnostic[];
  resolvedLatestEndDate?: string | null;
}

const SHARED_FIELD_KEYS = [
  "run.symbol",
  "run.startDate",
  "run.endDate",
  "run.endMode",
  "contribution.amount",
  "contribution.day",
] as const;

type SharedFieldKey = (typeof SHARED_FIELD_KEYS)[number];

function getDefinition(catalog: Catalog, key: SharedFieldKey): ParameterDefinition {
  const definition = catalog.parameters?.find((item) => item.key === key);
  if (!definition) throw new Error(`Catalog is missing shared parameter ${key}`);
  return definition;
}

function valueFor(value: SharedDraft, key: SharedFieldKey): unknown {
  switch (key) {
    case "run.symbol":
      return value.run.symbol;
    case "run.startDate":
      return value.run.startDate;
    case "run.endDate":
      return value.run.endDate;
    case "run.endMode":
      return value.run.endMode;
    case "contribution.amount":
      return value.contribution.amount;
    case "contribution.day":
      return value.contribution.day;
  }
}

export function SharedSettingsForm({
  catalog,
  value,
  locale,
  onChange,
  errors = [],
  resolvedLatestEndDate = null,
}: SharedSettingsFormProps) {
  const definitions = new Map((catalog.parameters ?? []).map((definition) => [definition.key, definition]));
  const latestDefinition = getDefinition(catalog, "run.endMode");
  const latestMode = latestDefinition.allowedValues?.find((choice) => choice === "latest");
  const fixedMode = latestDefinition.allowedValues?.find((choice) => choice === "fixed");
  const isLatest = value.run.endMode === latestMode;
  const endHelperText = isLatest && resolvedLatestEndDate
    ? interpolate(translate(locale, "end.resolved"), { date: resolvedLatestEndDate })
    : isLatest
      ? translate(locale, "end.unresolved")
      : translate(locale, "end.fixed");
  const currentValues = Object.fromEntries(
    SHARED_FIELD_KEYS.map((key) => [key, valueFor(value, key)]),
  );
  const dependencyValues = {
    ...Object.fromEntries((catalog.parameters ?? []).map(({ key, default: item }) => [key, item])),
    ...currentValues,
  };

  const update = (key: SharedFieldKey, next: unknown) => {
    if (key === "run.endMode") {
      if (next === "latest" || next === "fixed") {
        onChange({ ...value, run: { ...value.run, endMode: next } });
      }
      return;
    }
    if (key === "run.symbol") {
      onChange({ ...value, run: { ...value.run, symbol: next == null ? "" : String(next) } });
    } else if (key === "run.startDate") {
      onChange({ ...value, run: { ...value.run, startDate: next == null ? "" : String(next) } });
    } else if (key === "run.endDate") {
      onChange({ ...value, run: { ...value.run, endDate: next == null ? null : String(next) } });
    } else if (key === "contribution.amount") {
      onChange({
        ...value,
        contribution: { ...value.contribution, amount: next == null ? null : String(next) },
      });
    } else if (key === "contribution.day") {
      const day = next == null || next === "" ? null : Number(next);
      onChange({ ...value, contribution: { ...value.contribution, day } });
    }
  };

  const field = (
    key: SharedFieldKey,
    options: {
      disabled?: boolean;
      required?: boolean;
      shownValue?: unknown;
      labelAccessory?: ReactNode;
      helperText?: string;
      helperLive?: boolean;
    } = {},
  ) => {
    const definition = definitions.get(key);
    if (!definition) throw new Error(`Catalog is missing shared parameter ${key}`);
    return (
      <ParameterField
        key={key}
        definition={definition}
        value={Object.hasOwn(options, "shownValue") ? options.shownValue : valueFor(value, key)}
        locale={locale}
        onChange={(next) => update(key, next)}
        dependencyValues={dependencyValues}
        errors={errors}
        disabled={options.disabled}
        required={options.required}
        labelAccessory={options.labelAccessory}
        helperText={options.helperText}
        helperLive={options.helperLive}
      />
    );
  };

  return (
    <section className="shared-settings" aria-label={translate(locale, "section.sharedSettings")}>
      <div className="section-heading shared-settings-heading">
        <p className="section-subhead">{translate(locale, "section.sharedSettingsHelp")}</p>
      </div>
      <div className="shared-settings-grid">
        <fieldset className="shared-settings-group shared-settings-asset-group">
          <legend>{translate(locale, "section.sharedSettingsAsset")}</legend>
          <div className="shared-settings-fields shared-settings-fields-asset">
            {field("run.symbol")}
          </div>
        </fieldset>
        <fieldset className="shared-settings-group shared-settings-range-group">
          <legend>{translate(locale, "section.sharedSettingsPeriod")}</legend>
          <div className="shared-settings-fields shared-settings-fields-range">
            {field("run.startDate")}
            {field("run.endDate", {
              disabled: isLatest,
              required: !isLatest,
              shownValue: isLatest && resolvedLatestEndDate
                ? resolvedLatestEndDate
                : value.run.endDate,
              helperText: endHelperText,
              helperLive: true,
              labelAccessory: (
                <label className="latest-toggle">
                  <input
                    type="checkbox"
                    checked={isLatest}
                    disabled={latestMode === undefined || fixedMode === undefined}
                    aria-label={translate(locale, isLatest ? "end.latest" : "end.fixed")}
                    onChange={(event) => update("run.endMode", event.target.checked ? latestMode : fixedMode)}
                  />
                  <span>{translate(locale, "end.latest")}</span>
                </label>
              ),
            })}
          </div>
        </fieldset>
        <fieldset className="shared-settings-group shared-settings-funding-group">
          <legend>{translate(locale, "section.sharedSettingsFunding")}</legend>
          <div className="shared-settings-fields shared-settings-fields-funding">
            {field("contribution.amount", {
              helperText: translate(locale, "field.currencyHelp"),
            })}
            {field("contribution.day")}
          </div>
        </fieldset>
      </div>
    </section>
  );
}
