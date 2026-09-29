import { useState } from "react";
import type { Catalog, Diagnostic, ParameterDefinition } from "../../api/generated";
import { interpolate, translate, type Locale } from "../../i18n/messages";
import { ParameterField } from "../../shared/ui/ParameterField";

interface SharedSettingsFormProps {
  catalog: Catalog;
  locale: Locale;
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
type SharedValues = Record<SharedFieldKey, unknown>;

export function SharedSettingsForm({
  catalog,
  locale,
  errors = [],
  resolvedLatestEndDate = null,
}: SharedSettingsFormProps) {
  const definitions = new Map((catalog.parameters ?? []).map((definition) => [definition.key, definition]));
  const getDefinition = (key: SharedFieldKey): ParameterDefinition => {
    const definition = definitions.get(key);
    if (!definition) throw new Error(`Catalog is missing shared parameter ${key}`);
    return definition;
  };
  const [values, setValues] = useState<SharedValues>(() =>
    Object.fromEntries(
      SHARED_FIELD_KEYS.map((key) => [key, getDefinition(key).default]),
    ) as SharedValues,
  );
  const [dependencyValues, setDependencyValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      (catalog.parameters ?? []).map(({ key, default: value }) => [key, value]),
    ),
  );
  const latestDefinition = getDefinition("run.endMode");
  const latestMode = latestDefinition.allowedValues?.find((value) => value === "latest");
  const fixedMode = latestDefinition.allowedValues?.find((value) => value === "fixed");
  const isLatest = values["run.endMode"] === latestMode;
  const update = (key: SharedFieldKey, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDependencyValues((current) => ({ ...current, [key]: value }));
  };

  const field = (
    key: SharedFieldKey,
    options: { disabled?: boolean; required?: boolean; value?: unknown } = {},
  ) => (
    <ParameterField
      key={key}
      definition={getDefinition(key)}
      value={Object.hasOwn(options, "value") ? options.value : values[key]}
      locale={locale}
      onChange={(value) => update(key, value)}
      dependencyValues={dependencyValues}
      errors={errors}
      disabled={options.disabled}
      required={options.required}
    />
  );

  return (
    <section className="shared-settings" aria-labelledby="shared-settings-heading">
      <div className="section-heading shared-settings-heading">
        <div>
          <h2 id="shared-settings-heading">{translate(locale, "section.sharedSettings")}</h2>
          <p className="section-subhead">{translate(locale, "section.sharedSettingsHelp")}</p>
        </div>
      </div>
      <div className="shared-settings-grid">
        {field("run.symbol")}
        {field("run.startDate")}
        <div className="end-date-field">
          <div className="field-label-row">
            <span className="field-label-text">{translate(locale, getDefinition("run.endDate").translationKey)}</span>
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
          </div>
          {field("run.endDate", {
            disabled: isLatest,
            required: !isLatest,
            value: isLatest && resolvedLatestEndDate ? resolvedLatestEndDate : values["run.endDate"],
          })}
          <p className="field-hint" aria-live="polite">
            {isLatest && resolvedLatestEndDate
              ? interpolate(translate(locale, "end.resolved"), { date: resolvedLatestEndDate })
              : isLatest
                ? translate(locale, "end.unresolved")
                : translate(locale, "end.fixed")}
          </p>
        </div>
        {field("contribution.amount")}
        {field("contribution.day")}
      </div>
    </section>
  );
}
