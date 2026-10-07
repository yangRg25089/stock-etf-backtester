import { useEffect, useState } from "react";
import { translate, type Locale } from "../../i18n/messages";
import { APPEARANCE_STORAGE_KEY, effectiveAppearance, resolveAppearance, type Appearance } from "./themes";
function initialMode(): Appearance {
  try { return resolveAppearance(localStorage.getItem(APPEARANCE_STORAGE_KEY)); }
  catch { return "system"; }
}
export function ThemeControl({ locale }: { locale: Locale }) {
  const [mode, setMode] = useState<Appearance>(initialMode);
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const current = effectiveAppearance(mode, systemDark);
  useEffect(() => {
    document.documentElement.dataset.appearance = mode;
    document.documentElement.dataset.theme = current;
  }, [mode, current]);
  const select = (next: Appearance) => {
    setMode(next);
    try { localStorage.setItem(APPEARANCE_STORAGE_KEY, next); } catch { /* Keep the session preference when storage is unavailable. */ }
  };
  return <div className="appearance-controls" role="group" aria-label={translate(locale, "theme.label")}>
    <button type="button" className="button button-secondary appearance-toggle" aria-label={translate(locale, current === "dark" ? "theme.toLight" : "theme.toDark")}
      title={current === "dark" ? "Light" : "Dark"} onClick={() => select(current === "dark" ? "light" : "dark")}><span aria-hidden="true">{current === "dark" ? "☀" : "☾"}</span></button>
    <button type="button" className="button button-secondary" aria-pressed={mode === "system"} aria-label={translate(locale, "theme.auto")} onClick={() => select("system")}>Auto</button>
  </div>;
}
