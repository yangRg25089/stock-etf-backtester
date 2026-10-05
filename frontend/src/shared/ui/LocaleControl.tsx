import type { ChangeEvent } from "react";
import type { Locale } from "../../i18n/messages";
import { translate } from "../../i18n/messages";

interface LocaleControlProps {
  locale: Locale;
  onChange(locale: Locale): void;
}

const LOCALES: Locale[] = ["ja", "zh", "en"];

function isLocale(value: string): value is Locale {
  return LOCALES.some(locale => locale === value);
}

export function LocaleControl({ locale, onChange }: LocaleControlProps) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLocale = event.currentTarget.value;
    if (isLocale(nextLocale)) onChange(nextLocale);
  };

  return (
    <label className="locale-select-control">
      <span className="sr-only">{translate(locale, "locale.label")}</span>
      <select className="locale-select" aria-label={translate(locale, "locale.label")} value={locale} onChange={handleChange}>
        {LOCALES.map(option => <option key={option} value={option}>{translate(locale, `locale.${option}`)}</option>)}
      </select>
    </label>
  );
}
