import { useEffect, useState } from "react";
import { translate, type Locale } from "../../i18n/messages";
import { DEFAULT_THEME, resolveTheme, THEMES, THEME_STORAGE_KEY, type Theme } from "./themes";

function initialTheme(): Theme {
  try { return resolveTheme(localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return DEFAULT_THEME; }
}
export function ThemeControl({ locale }: { locale: Locale }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <select className="theme-select" aria-label={translate(locale, "theme.label")} value={theme}
    onChange={event => {
      const next = resolveTheme(event.target.value);
      setTheme(next);
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* The selected theme still works for this session. */ }
    }}>
    {THEMES.map(option => <option key={option.id} value={option.id}>{translate(locale, `theme.${option.id}`)}</option>)}
  </select>;
}
