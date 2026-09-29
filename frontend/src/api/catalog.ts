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
  return payload;
}
