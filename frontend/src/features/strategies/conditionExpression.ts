import type {
  ConditionComparator,
  ConditionDisplayOperand,
  ConditionDisplayRule,
  ParameterDefinition,
} from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";

const COMPARATOR_SYMBOLS: Record<ConditionComparator, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

export function conditionComparatorSymbol(operator: ConditionComparator): string {
  return COMPARATOR_SYMBOLS[operator];
}

export interface FormattedConditionClause {
  left: string;
  operator: string;
  spokenOperator: string;
  right: string;
  sellRatio?: string;
}

export interface FormattedConditionRule {
  logic: "AND" | "OR";
  clauses: FormattedConditionClause[];
  sellRatio?: string;
  note?: string;
}

function formatParameterValue(
  key: string,
  params: Record<string, unknown>,
  definitions: ReadonlyMap<string, ParameterDefinition>,
  locale: Locale,
): string {
  const value = params[key];
  if (value === null || value === undefined || value === "") return "—";
  const definition = definitions.get(key);
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric) && typeof value !== "boolean") {
    const percentage = definition?.type === "ratio" || definition?.unit === "percent_point";
    const displayValue = definition?.type === "ratio" ? numeric * 100 : numeric;
    const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(displayValue);
    return percentage ? `${formatted}%` : formatted;
  }
  return String(value);
}

function formatOperand(
  operand: ConditionDisplayOperand,
  params: Record<string, unknown>,
  definitions: ReadonlyMap<string, ParameterDefinition>,
  locale: Locale,
): string {
  if (operand.parameterKey) {
    return formatParameterValue(operand.parameterKey, params, definitions, locale);
  }
  const values = Object.fromEntries(Object.entries(operand.metricParameters ?? {}).map(([name, key]) => [
    name,
    formatParameterValue(key, params, definitions, locale),
  ]));
  return translate(locale, operand.metricKey ?? "", values);
}

export function formatConditionDisplayRule(
  rule: ConditionDisplayRule,
  params: Record<string, unknown>,
  parameterDefinitions: ParameterDefinition[],
  locale: Locale,
): FormattedConditionRule {
  const definitions = new Map(parameterDefinitions.map(definition => [definition.key, definition]));
  return {
    logic: rule.logic ?? "AND",
    clauses: rule.clauses.map(clause => ({
      left: formatOperand(clause.left, params, definitions, locale),
      operator: conditionComparatorSymbol(clause.operator),
      spokenOperator: translate(locale, `conditions.operator.${clause.operator}`),
      right: formatOperand(clause.right, params, definitions, locale),
      ...(clause.sellTierRatioParameterKey ? {
        sellRatio: formatParameterValue(clause.sellTierRatioParameterKey, params, definitions, locale),
      } : {}),
    })),
    ...(rule.sellRatioParameterKey ? {
      sellRatio: formatParameterValue(rule.sellRatioParameterKey, params, definitions, locale),
    } : {}),
    ...(rule.noteKey ? { note: translate(locale, rule.noteKey) } : {}),
  };
}

export function conditionParameterOperator(
  rule: ConditionDisplayRule,
  parameterKey: string,
): ConditionComparator | null {
  return rule.clauses.find(clause => clause.right.parameterKey === parameterKey)?.operator ?? null;
}
