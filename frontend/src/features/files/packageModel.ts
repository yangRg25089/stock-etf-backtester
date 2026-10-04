import type { BacktestPackage, Catalog } from "../../api/generated";
import { isBoundedJson, isIsoDateTime, isRecord, isRunResponse, isStrategyRun, matchesContract, runDataContext, sameJson } from "../../api/contractReader";
import { draftFromRun, readDraft } from "../strategies/draftReader";
import { isTerminalRunStatus } from "../../api/runStatus";
import type { BacktestDraft } from "../strategies/model";
import { compatibleCatalogVersion } from "../strategies/catalogCompatibility";
import { searchOutcomes } from "../../api/searchResults";

export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export interface StrategyPackage {
  format: "stock-etf-backtester"; schemaVersion: 1; type: "strategy";
  exportedAt: string; catalogVersion: string; draft: BacktestDraft;
}
export type PackageFile = StrategyPackage | BacktestPackage;
export class PackageError extends Error {
  constructor(readonly messageKey: string) { super(messageKey); this.name = "PackageError"; }
}

export function createStrategyPackage(draft: BacktestDraft, catalog: Catalog): StrategyPackage {
  const checked = readDraft(draft, catalog);
  if (!checked) throw new PackageError("files.invalidConfiguration");
  return { format: "stock-etf-backtester", schemaVersion: 1, type: "strategy", exportedAt: new Date().toISOString(), catalogVersion: catalog.version, draft: checked };
}

export function packageDraft(file: PackageFile, catalog: Catalog): BacktestDraft {
  const draft = file.type === "strategy" ? readDraft(file.draft, catalog) : draftFromRun(file.result, catalog);
  if (!draft) throw new PackageError("files.invalidConfiguration");
  return draft;
}

export function readPackage(value: unknown, catalog: Catalog): PackageFile {
  if (!isBoundedJson(value) || !isRecord(value) || value.format !== "stock-etf-backtester") throw new PackageError("files.invalidFormat");
  if (typeof value.schemaVersion !== "number" || value.schemaVersion < 1) throw new PackageError("files.unsupportedVersion");
  if (value.schemaVersion > 1) throw new PackageError("files.newerVersion");
  if (!compatibleCatalogVersion(value.catalogVersion, catalog.version)) throw new PackageError("files.incompatibleCatalog");
  if (!isIsoDateTime(value.exportedAt)) throw new PackageError("files.invalidFormat");
  if (value.type === "strategy") {
    if (Object.keys(value).some(key => !["format", "schemaVersion", "type", "exportedAt", "catalogVersion", "draft"].includes(key))) throw new PackageError("files.invalidFormat");
    const draft = readDraft(value.draft, catalog);
    if (!draft) throw new PackageError("files.invalidConfiguration");
    return { format: "stock-etf-backtester", schemaVersion: 1, type: "strategy", exportedAt: value.exportedAt, catalogVersion: catalog.version, draft };
  }
  if (value.type !== "backtest" || !matchesContract("BacktestPackage", value) || !isRunResponse(value.result)) throw new PackageError("files.invalidResult");
  const file = value as BacktestPackage;
  if (!isTerminalRunStatus(file.result.status) || !file.result.result
    || file.catalogVersion !== file.result.snapshot.catalogVersion || file.engineVersion !== file.result.snapshot.engineVersion
    || !sameJson(file.config, file.result.snapshot.config) || !sameJson(file.dataProvenance, runDataContext(file.result.snapshot)?.dataProvenance ?? {})) throw new PackageError("files.invalidResult");
  const searches = file.result.result.strategyRuns?.flatMap(row => row.searchResult ? [row.searchResult] : []) ?? [];
  const candidates = searches.flatMap(searchOutcomes);
  if (searches.some(search => search.candidates.length > 10_000) || Object.keys(file.candidateDetails).length !== candidates.length
    || new Set(candidates.map(row => row.id)).size !== candidates.length) throw new PackageError("files.invalidCandidates");
  for (const row of candidates) {
    const detail = file.candidateDetails[row.id];
    if (!isStrategyRun(detail) || detail.id !== row.id || detail.presetId !== "grid_search" || detail.role !== "strategy"
      || !sameJson(detail.evaluationPeriod ?? null, row.period ?? null)
      || detail.status !== row.outcome.status || !sameJson(detail.metrics ?? null, row.outcome.metrics ?? null)) throw new PackageError("files.invalidCandidates");
  }
  packageDraft(file, catalog);
  return file;
}

export async function readPackageFile(file: Pick<File, "size" | "text">, catalog: Catalog): Promise<PackageFile> {
  if (file.size > MAX_PACKAGE_BYTES) throw new PackageError("files.tooLarge");
  let value: unknown;
  try { value = JSON.parse(await file.text()); }
  catch { throw new PackageError("files.invalidJson"); }
  return readPackage(value, catalog);
}

export function packageBlob(file: PackageFile): Blob {
  const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
  if (blob.size > MAX_PACKAGE_BYTES) throw new PackageError("files.tooLarge");
  return blob;
}
