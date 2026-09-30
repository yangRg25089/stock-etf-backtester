export function parameterFieldId(key: string, ownerId?: string): string {
  const owner = ownerId ? `${ownerId}-` : "";
  return `field-${owner}${key.replaceAll(".", "-")}`;
}
