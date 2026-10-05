import { useEffect, useState } from "react";
import { translate, type Locale } from "../../i18n/messages";

type Theme = "blue" | "mint";
const STORAGE_KEY = "stock-etf-backtester.theme.v1";
function initialTheme(): Theme {
  try { return localStorage.getItem(STORAGE_KEY) === "mint" ? "mint" : "blue"; }
  catch { return "blue"; }
}
export function ThemeControl({ locale }: { locale: Locale }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <button type="button" className="button icon-only-button theme-control" aria-label={translate(locale, `theme.${theme}`)}
    title={translate(locale, `theme.${theme}`)} aria-pressed={theme === "mint"}
    onClick={() => {
      const next = theme === "blue" ? "mint" : "blue";
      setTheme(next);
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The selected theme still works for this session. */ }
    }}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10 2.5a7.5 7.5 0 0 0 0 15Z" fill="currentColor" /></svg>
  </button>;
}
