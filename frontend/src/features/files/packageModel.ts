import type { Catalog } from "../../api/generated";
import { isBoundedJson, isIsoDateTime, isRecord } from "../../api/contractReader";
import { readDraft } from "../strategies/draftReader";
import type { BacktestDraft } from "../strategies/model";
import { compatibleCatalogVersion } from "../strategies/catalogCompatibility";

export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
export interface StrategyPackage {
  format: "stock-etf-backtester"; schemaVersion: 1; type: "strategy";
  exportedAt: string; catalogVersion: string; draft: BacktestDraft;
}
export type PackageFile = StrategyPackage;
export class PackageError extends Error {
  constructor(readonly messageKey: string) { super(messageKey); this.name = "PackageError"; }
}

export function createStrategyPackage(draft: BacktestDraft, catalog: Catalog): StrategyPackage {
  const checked = readDraft(draft, catalog);
  if (!checked) throw new PackageError("files.invalidConfiguration");
  return { format: "stock-etf-backtester", schemaVersion: 1, type: "strategy", exportedAt: new Date().toISOString(), catalogVersion: catalog.version, draft: checked };
}

export function packageDraft(file: PackageFile, catalog: Catalog): BacktestDraft {
  const draft = readDraft(file.draft, catalog);
  if (!draft) throw new PackageError("files.invalidConfiguration");
  return draft;
}

export function readPackage(value: unknown, catalog: Catalog): PackageFile {
  if (!isBoundedJson(value) || !isRecord(value) || value.format !== "stock-etf-backtester") throw new PackageError("files.invalidFormat");
  if (typeof value.schemaVersion !== "number" || value.schemaVersion < 1) throw new PackageError("files.unsupportedVersion");
  if (value.schemaVersion > 1) throw new PackageError("files.newerVersion");
  if (!compatibleCatalogVersion(value.catalogVersion, catalog.version)) throw new PackageError("files.incompatibleCatalog");
  if (!isIsoDateTime(value.exportedAt)) throw new PackageError("files.invalidFormat");
  if (value.type !== "strategy" || Object.keys(value).some(key => !["format", "schemaVersion", "type", "exportedAt", "catalogVersion", "draft"].includes(key))) throw new PackageError("files.invalidFormat");
  const draft = readDraft(value.draft, catalog);
  if (!draft) throw new PackageError("files.invalidConfiguration");
  return { format: "stock-etf-backtester", schemaVersion: 1, type: "strategy", exportedAt: value.exportedAt, catalogVersion: catalog.version, draft };

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
