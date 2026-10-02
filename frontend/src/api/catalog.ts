import type { Catalog, ConditionGroup, ConditionLeaf, ParameterDefinition, ParameterGroupDefinition, PresetDefinition, StrategyRules } from "./generated";

export class CatalogApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "CatalogApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParameterDefinition(value: unknown): value is ParameterDefinition {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.type === "string" &&
    "default" in value &&
    Array.isArray(value.applicablePresets) &&
    Array.isArray(value.dependencies) &&
    typeof value.translationKey === "string" &&
    typeof value.groupId === "string"
  );
}

function isParameterGroupDefinition(value: unknown): value is ParameterGroupDefinition {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.translationKey === "string"
  );
}

function isPresetDefinition(value: unknown): value is PresetDefinition {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.nameKey === "string" &&
    typeof value.descriptionKey === "string" &&
    Array.isArray(value.parameterKeys) &&
    (value.searchDimensions === undefined || Array.isArray(value.searchDimensions))
  );
}

function normalizeNumericValue(type: ParameterDefinition["type"], value: unknown): unknown {
  const numericTypes = new Set(["integer", "decimal", "ratio", "percent_point"]);
  if (numericTypes.has(type) && typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && (type !== "integer" || Number.isInteger(parsed))) {
      return parsed;
    }
  }
  if (type === "number_list" && Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string" || item.trim() === "") return item;
      const parsed = Number(item);
      return Number.isFinite(parsed) ? parsed : item;
    });
  }
  return value;
}

function normalizeCatalogNumericValues(catalog: Catalog): Catalog {
  const definitions = new Map((catalog.parameters ?? []).map((item) => [item.key, item]));
  const normalize = (key: string, value: unknown) => {
    const definition = definitions.get(key);
    return definition ? normalizeNumericValue(definition.type, value) : value;
  };
  function normalizeNode(node: ConditionLeaf | ConditionGroup): ConditionLeaf | ConditionGroup {
    return "kind" in node
      ? { ...node, params: Object.fromEntries(Object.entries(node.params ?? {}).map(([key, value]) => [key, normalize(key, value)])) }
      : { ...node, children: node.children?.map(normalizeNode) };
  }
  const normalizeRules = (rules: StrategyRules | null | undefined) => rules ? { buy: rules.buy ? normalizeNode(rules.buy) : null, sell: rules.sell ? normalizeNode(rules.sell) : null } : rules;
  return {
    ...catalog,
    parameters: catalog.parameters?.map((definition) => ({
      ...definition,
      default: normalize(definition.key, definition.default),
    })),
    presets: catalog.presets?.map((preset) => {
      if (!isRecord(preset.defaultParams)) return preset;
      return {
        ...preset,
        defaultParams: Object.fromEntries(
          Object.entries(preset.defaultParams).map(([key, value]) => [key, normalize(key, value)]),
        ),
        defaultRules: normalizeRules(preset.defaultRules),
      };
    }),
  };
}

function hasValidConditions(value: Record<string, unknown>, parameterKeys: Set<string>): boolean {
  if (value.conditions === undefined) return true;
  if (!Array.isArray(value.conditions) || !isRecord(value.conditionLimits)) return false;
  const { maxDepth, maxNodes } = value.conditionLimits;
  if (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1 || typeof maxNodes !== "number" || !Number.isInteger(maxNodes) || maxNodes < 1) return false;
  const definitions = new Map<string, { buy: string[]; sell: string[] }>();
  for (const condition of value.conditions) {
    if (!isRecord(condition) || typeof condition.kind !== "string" || typeof condition.nameKey !== "string" || definitions.has(condition.kind)) return false;
    const buy = condition.buyParameterKeys;
    const sell = condition.sellParameterKeys;
    if (!Array.isArray(buy) || !Array.isArray(sell) || ![...buy, ...sell].every(key => typeof key === "string" && parameterKeys.has(key))) return false;
    definitions.set(condition.kind, { buy, sell });
  }
  for (const preset of value.presets as PresetDefinition[]) {
    if (preset.defaultRules === undefined || preset.defaultRules === null) continue;
    if (!isRecord(preset.defaultRules)) return false;
    const seen = new Set<string>();
    const stack = (["buy", "sell"] as const).flatMap(side => preset.defaultRules?.[side] ? [{ node: preset.defaultRules[side] as unknown, side, depth: 1 }] : []);
    while (stack.length) {
      const { node, side, depth } = stack.pop()!;
      if (!isRecord(node) || typeof node.id !== "string" || !node.id || seen.has(node.id) || depth > maxDepth || seen.size >= maxNodes || typeof node.enabled !== "boolean") return false;
      seen.add(node.id);
      if (node.type === "group") {
        if (!Array.isArray(node.children) || !["AND", "OR"].includes(String(node.operator))) return false;
        stack.push(...node.children.map(child => ({ node: child as unknown, side, depth: depth + 1 })));
      } else {
        const definition = typeof node.kind === "string" ? definitions.get(node.kind) : undefined;
        if (node.type !== "condition" || !definition || !isRecord(node.params) || !Object.keys(node.params).every(key => definition[side].includes(key))) return false;
      }
    }
  }
  return true;
}

export function isCatalog(value: unknown): value is Catalog {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.parameterGroups) ||
    !Array.isArray(value.presets) ||
    !value.parameters.every(isParameterDefinition) ||
    !value.parameterGroups.every(isParameterGroupDefinition) ||
    !value.presets.every(isPresetDefinition)
  ) {
    return false;
  }

  const parameters = value.parameters as ParameterDefinition[];
  const groups = value.parameterGroups as ParameterGroupDefinition[];
  const presets = value.presets as PresetDefinition[];
  const parameterKeys = new Set(parameters.map(({ key }) => key));
  const groupIds = new Set(groups.map(({ id }) => id));
  const groupTranslationKeys = new Set(groups.map(({ translationKey }) => translationKey));
  const presetIds = new Set(presets.map(({ id }) => id));
  return (
    parameterKeys.size === parameters.length &&
    groupIds.size === groups.length &&
    groupTranslationKeys.size === groups.length &&
    parameters.every(({ groupId }) => groupIds.has(groupId)) &&
    presetIds.size === presets.length &&
    presets.every(({ parameterKeys: keys }) => keys.every((key) => parameterKeys.has(key))) &&
    presets.every(preset => (preset.searchDimensions ?? []).every(dimension => {
      if (!isRecord(dimension) || typeof dimension.key !== "string" || !parameterKeys.has(dimension.key) || !Array.isArray(dimension.values) || !dimension.values.length) return false;
      if (dimension.valuesParameterKey == null) return true;
      if (typeof dimension.valuesParameterKey !== "string" || !dimension.valuesParameterKey) return false;
      return preset.parameterKeys.includes(dimension.valuesParameterKey) && parameters.some(parameter =>
        parameter.key === dimension.valuesParameterKey && parameter.type === "number_list");
    })) &&
    hasValidConditions(value, parameterKeys)
  );
}

export async function fetchCatalog(signal?: AbortSignal): Promise<Catalog> {
  let response: Response;
  try {
    response = await fetch("/api/v1/catalog", { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw new CatalogApiError("catalog.fetch_failed");
  }

  if (!response.ok) {
    throw new CatalogApiError("catalog.request_failed", response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CatalogApiError("catalog.invalid_json", response.status);
  }

  if (!isCatalog(payload)) {
    throw new CatalogApiError("catalog.contract_mismatch", response.status);
  }
  return normalizeCatalogNumericValues(payload);
}
