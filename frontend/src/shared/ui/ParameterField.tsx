import type { ChangeEvent } from "react";
import type { Diagnostic, ParameterDefinition } from "../../api/generated";
import {
  interpolate,
  translate,
  unitLabel,
  type Locale,
} from "../../i18n/messages";

interface ParameterFieldProps {
  definition: ParameterDefinition;
  value: unknown;
  locale: Locale;
  onChange(value: unknown): void;
  dependencyValues?: Record<string, unknown>;
  errors?: Diagnostic[];
  disabled?: boolean;
  required?: boolean;
  id?: string;
}

function inputValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
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

export function ParameterField({
  definition,
  value,
  locale,
  onChange,
  dependencyValues = {},
  errors = [],
  disabled = false,
  required,
  id,
}: ParameterFieldProps) {
  const fieldId = id ?? `field-${definition.key.replaceAll(".", "-")}`;
  const label = translate(locale, definition.translationKey);
  const unit = unitLabel(locale, definition.unit);
  const unmetDependencies = (definition.dependencies ?? []).filter(
    (key) => !dependencyIsPresent(dependencyValues[key]),
  );
  const fieldDisabled = disabled || unmetDependencies.length > 0;
  const fieldErrors = errors.filter((error) =>
    error.fieldPath === definition.key || error.fieldPath?.endsWith(`.${definition.key}`),
  );
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const descriptionIds = [
    unmetDependencies.length > 0 ? helpId : null,
    fieldErrors.length > 0 ? errorId : null,
  ]
    .filter((item): item is string => item !== null)
    .join(" ");
  const common = {
    id: fieldId,
    disabled: fieldDisabled,
    "aria-invalid": fieldErrors.length > 0 ? true : undefined,
    "aria-describedby": descriptionIds || undefined,
  };

  const numericProps = {
    min: definition.minimum ?? undefined,
    max: definition.maximum ?? undefined,
    step: definition.step ?? undefined,
    inputMode: inputMode(definition.type),
  };

  let control;
  if (definition.type === "boolean") {
    control = (
      <label className="checkbox-control" htmlFor={fieldId}>
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        />
        <span>{label}</span>
      </label>
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
    const values = Array.isArray(value) ? value : [];
    control = (
      <div className="number-list-control">
        {values.map((item, index) => (
          <div className="number-list-row" key={`${definition.key}-${index}`}>
            <label className="sr-only" htmlFor={`${fieldId}-${index}`}>
              {`${label} ${index + 1}`}
            </label>
            <input
              {...numericProps}
              {...common}
              id={`${fieldId}-${index}`}
              className="input"
              type="number"
              value={inputValue(item)}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const next = [...values];
                next[index] = event.target.value === "" ? "" : Number(event.target.value);
                onChange(next);
              }}
            />
            <button
              type="button"
              className="icon-button"
              disabled={fieldDisabled || values.length <= 1}
              aria-label={interpolate(translate(locale, "field.removeItem"), { field: label })}
              onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            >
              −
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-button"
          disabled={fieldDisabled}
          onClick={() => onChange([...values, ""])}
        >
          + {translate(locale, "field.addItem")}
        </button>
      </div>
    );
  } else {
    const isDate = definition.type === "date";
    const isSymbol = definition.type === "symbol";
    const isInteger = definition.type === "integer";
    control = (
      <div className="unit-field">
        <input
          {...common}
          {...(isInteger || (!isDate && !isSymbol) ? numericProps : {})}
          className="input"
          type={isDate ? "date" : isSymbol ? "text" : "number"}
          value={inputValue(value)}
          required={required ?? (definition.nullable !== true)}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const raw = event.target.value;
            onChange(raw === "" ? null : raw);
          }}
        />
        {unit && <span className="unit-label">{unit}</span>}
      </div>
    );
  }

  return (
    <div className={`field${fieldErrors.length > 0 ? " field-invalid" : ""}`}>
      {definition.type === "boolean" ? (
        control
      ) : (
        <label className="field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      {definition.type !== "boolean" && control}
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
              <span className="diagnostic-code">
                {interpolate(translate(locale, "field.errorCode"), {
                  code: translate(locale, `diagnosticCode.${error.code}`),
                })}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
