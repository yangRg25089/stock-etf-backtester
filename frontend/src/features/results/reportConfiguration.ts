import { compareDecimals, isNumericSearchValue } from "../../api/contractReader";
import type { Catalog, ConditionGroup, ConditionLeaf, FrozenStrategyInstance } from "../../api/generated";
import { translate, unitLabel, type Locale } from "../../i18n/messages";
import { formatCurrency, formatPercent, formatPlainNumber } from "./format";
import { conditionLeaves } from "../strategies/conditions";

function objectValues(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parameterText(key: string, value: unknown, catalog: Catalog | null | undefined, locale: Locale, currency?: string | null): string {
  const parameter = catalog?.parameters?.find(item => item.key === key);
  const label = parameter ? translate(locale, parameter.translationKey) : key;
  let formatted: string;
  if (value === null && parameter?.nullable) formatted = translate(locale, "strategy.unlimited");
  else if (typeof value === "boolean") formatted = translate(locale, value ? "field.enabled" : "field.disabled");
  else if (parameter?.type === "ratio") formatted = formatPercent(String(value), locale);
  else if (parameter?.unit === "currency") formatted = `${formatCurrency(String(value), currency, locale)}${currency ? ` ${currency}` : ""}`;
  else if (["integer", "decimal", "percent_point"].includes(parameter?.type ?? "")) {
    const unit = unitLabel(locale, parameter?.unit);
    formatted = `${formatPlainNumber(String(value), locale)}${unit ? ` ${unit}` : ""}`;
  } else {
    const translated = translate(locale, `enum.${String(value)}`);
    formatted = translated === `enum.${String(value)}` ? typeof value === "object" ? JSON.stringify(value) : String(value) : translated;
  }
  return `${label}: ${formatted}`;
}

function conditionLines(node: ConditionLeaf | ConditionGroup | null | undefined, catalog: Catalog | null | undefined, locale: Locale,
  overrides: Record<string, unknown>, currency: string | null | undefined, direction: "buy" | "sell", depth = 0): string[] {
  if (!node || node.enabled === false) return [];
  const indent = "  ".repeat(depth);
  if ("kind" in node) {
    const definition = catalog?.conditions?.find(item => item.kind === node.kind);
    const nameKey = definition?.nameKey ?? `conditions.${node.kind}`;
    const allowed = definition?.[direction === "buy" ? "buyParameterKeys" : "sellParameterKeys"];
    return [indent + translate(locale, nameKey),
      ...Object.entries({ ...objectValues(node.params), ...Object.fromEntries(Object.entries(overrides).filter(([key]) => Object.hasOwn(node.params ?? {}, key))) })
        .filter(([key]) => !catalog?.parameters?.some(item => item.key === key) || !allowed || allowed.includes(key))
        .map(([key, value]) => `${indent}  ${parameterText(key, value, catalog, locale, currency)}`)];
  }
  const children = (node.children ?? []).flatMap(child => conditionLines(child, catalog, locale, overrides, currency, direction, depth + 1));
  return children.length ? [indent + (node.operator ?? "AND"), ...children] : [];
}


export function reportStrategySections(strategy: FrozenStrategyInstance | undefined, overrides: Record<string, unknown>,
  catalog: Catalog | null | undefined, locale: Locale, currency?: string | null) {
  if (!strategy) return [];
  const params = { ...objectValues(strategy.params), ...overrides };
  const hasSignalBuy = strategy.rules ? conditionLeaves(strategy.rules.buy, true).length > 0 : true;
  const limits = Object.entries(params).filter(([key]) => key.startsWith("accumulation.") && key !== "accumulation.conditionLogic"
    && (key !== "accumulation.maxSignalBuysPerMonth" || hasSignalBuy));
  const buy = strategy.rules ? conditionLines(strategy.rules.buy, catalog, locale, overrides, currency, "buy")
    : Object.entries(params).filter(([key]) => !key.startsWith("accumulation.") && !key.startsWith("search.")
      && catalog?.parameters?.some(item => item.key === key && item.applicablePresets.includes(strategy.presetId)))
      .map(([key, value]) => parameterText(key, value, catalog, locale, currency));
  return [
    { title: translate(locale, "parameterGroups.buy_limits"), lines: limits.map(([key, value]) => parameterText(key, value, catalog, locale, currency)) },
    { title: translate(locale, "strategy.buy"), lines: buy },
    { title: translate(locale, "strategy.sell"), lines: conditionLines(strategy.rules?.sell, catalog, locale, overrides, currency, "sell") },
  ].filter(section => section.lines.length);
}

export function reportExecutionLines(execution: unknown, catalog: Catalog | null | undefined, locale: Locale, currency?: string | null) {
  return Object.entries(objectValues(execution)).flatMap(([key, value]) => {
    if (["commission", "slippagePct", "spreadPct"].includes(key) && isNumericSearchValue(value) && compareDecimals(value, 0) === 0) return [];
    if ((key === "capitalGainsTaxEnabled" && value === false) || (key === "fractionalShares" && value === true)) return [];
    if (key === "fractionalShares" && value === false) return [translate(locale, "report.wholeShares")];
    return [parameterText(`execution.${key}`, value, catalog, locale, currency)];
  });
}
