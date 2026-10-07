// Classic is the original palette; the other four are from Color Hunt popular (2026-10-07).
// Source URLs use https://colorhunt.co/palette/<palette>.
export const THEMES = [
  { id: "classic", palette: "253c6d30497d455b8af2842f" },
  { id: "burgundy", palette: "800020f3e6d5fff9f2d45060" },
  { id: "midnight", palette: "0107360d1c4222396ffcf1d0" },
  { id: "blush", palette: "d8a2a2ffdcdcfff9d68ea66b" },
  { id: "forest", palette: "123f362a6b5cc49a45e8dcc4" },
] as const;

export type Theme = typeof THEMES[number]["id"];
export const DEFAULT_THEME: Theme = "classic";
export const THEME_STORAGE_KEY = "stock-etf-backtester.theme.v1";

export function resolveTheme(value: string | null): Theme {
  if (value === "blue") return "classic";
  return THEMES.find(theme => theme.id === value)?.id ?? DEFAULT_THEME;
}
