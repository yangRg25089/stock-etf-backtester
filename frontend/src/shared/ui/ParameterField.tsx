import type { ChangeEvent, InputHTMLAttributes, ReactNode } from "react";
import type { Diagnostic, ParameterDefinition } from "../../api/generated";
import {
  interpolate,
  translate,
  unitLabel,
  type Locale,
} from "../../i18n/messages";
import { parameterFieldId } from "./parameterFieldId";

interface ParameterFieldProps {
  definition: ParameterDefinition;
  value: unknown;
  locale: Locale;
  onChange(value: unknown): void;
  dependencyValues?: Record<string, unknown>;
  errors?: Diagnostic[];
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  id?: string;
  labelAccessory?: ReactNode;
  helperText?: string;
  helperLive?: boolean;
  currency?: string;
  appearance?: "default" | "switch";
  labelText?: string;
  respectDependencies?: boolean;
}

function inputValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function shiftDecimal(value: unknown, places: number): string {
  const raw = inputValue(value);
  if (raw.trim() === "") return raw;
  const number = Number(raw);
  if (!Number.isFinite(number)) return raw;
  // Shift the exponent to avoid artifacts from multiplication, such as 0.29 * 100.
  const [coefficient, exponent = "0"] = String(number).split("e");
  return String(Number(`${coefficient}e${Number(exponent) + places}`));
}

function inputMode(
  type: ParameterDefinition["type"],
): "numeric" | "decimal" | undefined {
  if (type === "integer") return "numeric";
  if (type === "decimal" || type === "ratio" || type === "percent_point") {
    return "decimal";
  }
  return undefined;
}

function dependencyIsPresent(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return value !== null && value !== undefined && value !== "";
}

function describedBy(...ids: Array<string | null | undefined>): string | undefined {
  const value = ids.filter((item): item is string => Boolean(item)).join(" ");
  return value || undefined;
}

interface NumberListControlProps {
  values: unknown[];
  fieldId: string;
  label: string;
  unit: string | null;
  locale: Locale;
  common: InputHTMLAttributes<HTMLInputElement> & { "data-parameter-key": string };
  numericProps: Pick<InputHTMLAttributes<HTMLInputElement>, "min" | "max" | "step" | "inputMode">;
  required: boolean;
  onChange(value: unknown[]): void;
}

function NumberListControl({ values, fieldId, label, unit, locale, common, numericProps, required, onChange }: NumberListControlProps) {
  return (
    <div className="number-list-control">
      {values.map((item, index) => (
        <div className="number-list-row" key={`${common["data-parameter-key"]}-${index}`}>
          <label className="sr-only" htmlFor={`${fieldId}-${index}`}>
            {`${label} ${index + 1}`}
          </label>
          <div className={`unit-field${unit ? " has-unit" : ""}`}>
            <input
              {...numericProps}
              {...common}
              aria-describedby={describedBy(common["aria-describedby"], unit ? `${fieldId}-${index}-unit` : null)}
              id={`${fieldId}-${index}`}
              className={`input${unit ? " input-with-unit" : ""}`}
              type="number"
              required={required}
              value={inputValue(item)}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const next = [...values];
                next[index] = event.target.value === "" ? "" : Number(event.target.value);
                onChange(next);
              }}
            />
            {unit && <span className="unit-label" id={`${fieldId}-${index}-unit`}>{unit}</span>}
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={common.disabled || values.length <= 1}
            aria-label={interpolate(translate(locale, "field.removeItem"), { field: label })}
            title={interpolate(translate(locale, "field.removeItem"), { field: label })}
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
          >
            −
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        disabled={common.disabled}
        onClick={() => onChange([...values, ""])}
      >
        + {translate(locale, "field.addItem")}
      </button>
    </div>
  );
}

export function ParameterField({
  definition,
  value,
  locale,
  onChange,
  dependencyValues = {},
  errors = [],
  disabled = false,
  required,
  placeholder,
  id,
  labelAccessory,
  helperText,
  helperLive = false,
  currency,
  appearance = "default",
  labelText,
  respectDependencies = true,
}: ParameterFieldProps) {
  const fieldId = id ?? parameterFieldId(definition.key);
  const label = translate(locale, definition.translationKey);
  const isRatio = definition.type === "ratio";
  const unit = isRatio ? unitLabel(locale, "percent_point") : definition.unit === "currency"
    ? currency ?? translate(locale, "unit.currency")
    : unitLabel(locale, definition.unit);
  const unmetDependencies = (respectDependencies ? definition.dependencies ?? [] : []).filter(
    (key) => !dependencyIsPresent(dependencyValues[key]),
  );
  const fieldDisabled = disabled || unmetDependencies.length > 0;
  const optionDescriptionKey = `parameterDescriptions.${definition.key}`;
  const translatedOptionDescription = translate(locale, optionDescriptionKey);
  const optionDescription = ["enum", "enum_list"].includes(definition.type) &&
    translatedOptionDescription !== optionDescriptionKey
    ? translatedOptionDescription
    : undefined;
  const resolvedHelperText = helperText ?? optionDescription ?? (
    definition.unit === "currency" ? translate(locale, "field.currencyHelp") : undefined
  );
  const fieldErrors = errors.filter((error) =>
    error.fieldPath === definition.key || error.fieldPath?.endsWith(`.${definition.key}`),
  );
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const helperId = resolvedHelperText ? `${fieldId}-hint` : null;
  const hasVisibleUnit = Boolean(unit) && ![
    "boolean",
    "enum",
    "enum_list",
  ].includes(definition.type);
  const unitId = hasVisibleUnit && definition.type !== "number_list"
    ? `${fieldId}-unit`
    : null;
  const descriptionIds = [
    unmetDependencies.length > 0 ? helpId : null,
    helperId,
    unitId,
    fieldErrors.length > 0 ? errorId : null,
  ]
    .filter((item): item is string => item !== null)
    .join(" ");
  const common = {
    id: fieldId,
    "data-parameter-key": definition.key,
    disabled: fieldDisabled,
    "aria-invalid": fieldErrors.length > 0 ? true : undefined,
    "aria-describedby": descriptionIds || undefined,
  };
  const labelTargetId = definition.type === "number_list" ? `${fieldId}-0` : fieldId;

  const numericBound = (bound: ParameterDefinition["minimum"]) =>
    bound === null || bound === undefined ? undefined : isRatio ? shiftDecimal(bound, 2) : bound;
  const numericProps = {
    min: numericBound(definition.minimum),
    max: numericBound(definition.maximum),
    step: numericBound(definition.step),
    inputMode: inputMode(definition.type),
  };

  let control;
  if (definition.type === "boolean" && appearance === "switch") {
    control = (
      <button
        {...common}
        className="parameter-switch"
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={value === true}
        onClick={() => onChange(value !== true)}
      >
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        <span className="switch-state">{translate(locale, value === true ? "field.enabled" : "field.disabled")}</span>
      </button>
    );
  } else if (definition.type === "boolean") {
    control = (
      <div className="checkbox-control">
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        />
        <span className="checkbox-state" aria-hidden="true">
          {translate(locale, value === true ? "field.enabled" : "field.disabled")}
        </span>
      </div>
    );
  } else if (definition.type === "enum") {
    control = (
      <select
        {...common}
        className="input"
        value={inputValue(value)}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
      >
        {(definition.allowedValues ?? []).map((choice) => {
          const serialized = String(choice);
          return (
            <option key={serialized} value={serialized}>
              {translate(locale, `enum.${serialized}`)}
            </option>
          );
        })}
      </select>
    );
  } else if (definition.type === "enum_list") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    control = (
      <select
        {...common}
        className="input input-multiselect"
        multiple
        value={selected}
        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
          onChange(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
        }
      >
        {(definition.allowedValues ?? []).map((choice) => {
          const serialized = String(choice);
          return (
            <option key={serialized} value={serialized}>
              {translate(locale, `parameters.${serialized}`)}
            </option>
          );
        })}
      </select>
    );
  } else if (definition.type === "number_list") {
    control = <NumberListControl values={Array.isArray(value) ? value : []} fieldId={fieldId}
      label={label} unit={unit} locale={locale} common={common} numericProps={numericProps}
      required={required ?? (definition.nullable !== true)} onChange={onChange} />;
  } else {
    const isDate = definition.type === "date";
    const isSymbol = definition.type === "symbol";
    const isInteger = definition.type === "integer";
    control = (
      <div className={`unit-field${unit ? " has-unit" : ""}`}>
        <input
          {...common}
          {...(isInteger || (!isDate && !isSymbol) ? numericProps : {})}
          className={`input${unit ? " input-with-unit" : ""}`}
          type={isDate ? "date" : isSymbol ? "text" : "number"}
          value={isRatio ? shiftDecimal(value, 2) : inputValue(value)}
          required={required ?? (definition.nullable !== true)}
          placeholder={placeholder}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const raw = event.target.value;
            onChange(raw === "" ? null : isDate || isSymbol ? raw : Number(isRatio ? shiftDecimal(raw, -2) : raw));
          }}
        />
        {unit && hasVisibleUnit && <span className="unit-label" id={unitId ?? undefined}>{unit}</span>}
      </div>
    );
  }

  return (
    <div className={`field${appearance === "switch" ? " field-switch" : ""}${fieldErrors.length > 0 ? " field-invalid" : ""}`}>
      <div className="field-label-row">
        <label className="field-label" htmlFor={labelTargetId}>
          {labelText ?? label}
        </label>
        {labelAccessory}
      </div>
      {control}
      {resolvedHelperText && (
        <p
          className="field-hint"
          id={helperId ?? undefined}
          aria-live={helperLive ? "polite" : undefined}
        >
          {resolvedHelperText}
        </p>
      )}
      {unmetDependencies.length > 0 && (
        <p className="field-hint" id={helpId}>
          {interpolate(translate(locale, "field.requiredData"), {
            fields: unmetDependencies.map((key) => translate(locale, `parameters.${key}`)).join("、"),
          })}
        </p>
      )}
      {fieldErrors.length > 0 && (
        <div className="field-error" id={errorId}>
          {fieldErrors.map((error, index) => (
            <p key={`${error.code}-${index}`}>
              {translate(locale, error.messageKey)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
