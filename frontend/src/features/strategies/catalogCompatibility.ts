/** Explicit additive input migrations; saved results retain their original version. */
export function compatibleCatalogVersion(saved: unknown, current: string): boolean {
  const additiveVersions = ["catalog-v12", "catalog-v13", "catalog-v14", "catalog-v15", "catalog-v16", "catalog-v17", "catalog-v18"];
  const savedIndex = additiveVersions.indexOf(String(saved));
  const currentIndex = additiveVersions.indexOf(current);
  return saved === current || savedIndex >= 0 && currentIndex > savedIndex;
}
