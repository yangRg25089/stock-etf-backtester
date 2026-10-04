/** Object-shaped input, excluding null and arrays; deeper validation belongs to callers. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
