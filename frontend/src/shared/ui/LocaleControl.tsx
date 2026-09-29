import type { Locale } from "../../i18n/messages";
import { translate } from "../../i18n/messages";

interface LocaleControlProps {
  locale: Locale;
  onChange(locale: Locale): void;
}

export function LocaleControl({ locale, onChange }: LocaleControlProps) {
  return (
    <div className="locale-switch" role="group" aria-label={translate(locale, "locale.label")}>
      <button
        type="button"
        aria-pressed={locale === "ja"}
        onClick={() => onChange("ja")}
      >
        {translate(locale, "locale.ja")}
      </button>
      <button
        type="button"
        aria-pressed={locale === "zh"}
        onClick={() => onChange("zh")}
      >
        {translate(locale, "locale.zh")}
      </button>
    </div>
  );
}
