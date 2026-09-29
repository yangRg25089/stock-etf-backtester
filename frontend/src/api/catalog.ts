import type { Catalog, ParameterDefinition, PresetDefinition } from "./generated";

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
    typeof value.translationKey === "string"
  );
}

function isPresetDefinition(value: unknown): value is PresetDefinition {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.nameKey === "string" &&
    typeof value.descriptionKey === "string" &&
    Array.isArray(value.parameterKeys)
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
      };
    }),
  };
}

export function isCatalog(value: unknown): value is Catalog {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !Array.isArray(value.parameters) ||
    !Array.isArray(value.presets) ||
    !value.parameters.every(isParameterDefinition) ||
    !value.presets.every(isPresetDefinition)
  ) {
    return false;
  }

  const parameters = value.parameters as ParameterDefinition[];
  const presets = value.presets as PresetDefinition[];
  const parameterKeys = new Set(parameters.map(({ key }) => key));
  const presetIds = new Set(presets.map(({ id }) => id));
  return (
    parameterKeys.size === parameters.length &&
    presetIds.size === presets.length &&
    presets.every(({ parameterKeys: keys }) => keys.every((key) => parameterKeys.has(key)))
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
