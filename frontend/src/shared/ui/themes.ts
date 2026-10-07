export type Appearance = "system" | "light" | "dark";
export const APPEARANCE_STORAGE_KEY = "stock-etf-backtester.appearance.v2";
export function resolveAppearance(value: string | null): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}
export function effectiveAppearance(mode: Appearance, systemDark: boolean): "light" | "dark" {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}
