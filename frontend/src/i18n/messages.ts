import { jaMessages } from "./ja";
import { zhMessages } from "./zh";

export type Locale = "ja" | "zh";

const messages: Record<Locale, Record<string, string>> = { ja: jaMessages, zh: zhMessages };

export function translate(
  locale: Locale,
  key: string,
  values?: Record<string, string>,
): string {
  const message = messages[locale][key] ?? key;
  return values ? interpolate(message, values) : message;
}

export function interpolate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, value),
    template,
  );
}

export function unitLabel(locale: Locale, unit: string | null | undefined): string | null {
  if (!unit) return null;
  if (unit === "symbol" || unit === "date" || unit === "currency") return null;
  const key = `unit.${unit}`;
  const translated = translate(locale, key);
  return translated === key ? unit : translated;
}
