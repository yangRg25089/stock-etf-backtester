import { translate, type Locale } from "../../i18n/messages";
import type { ReturnColorPalette } from "../lib/returnColorPreference";

export function ReturnColorControl({ locale, palette, onChange }: {
  locale: Locale;
  palette: ReturnColorPalette;
  onChange(palette: ReturnColorPalette): void;
}) {
  return <div className="return-color-control" role="group" aria-label={translate(locale, "returns.colors.label")}>
    {(["red-up", "green-up"] as const).map(choice => <button type="button" key={choice}
      className="return-color-option" aria-pressed={palette === choice} onClick={() => onChange(choice)}
      aria-label={translate(locale, `returns.colors.${choice}`)} title={translate(locale, `returns.colors.${choice}`)}>
      <span className={`return-color-preview is-${choice}`} aria-hidden="true"><span>↑</span><span>↓</span></span>
    </button>)}
  </div>;
}
