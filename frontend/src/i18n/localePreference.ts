import type { Locale } from "./messages";

export const LOCALE_STORAGE_KEY = "stock-etf-backtester.locale.v1";

type LocaleStorage = Pick<Storage, "getItem" | "setItem">;

function supportedLocale(value: unknown): Locale | null {
  return value === "ja" || value === "zh" || value === "en" ? value : null;
}

function browserLocale(language: string): Locale | null {
  const normalized = language.toLowerCase().replaceAll("_", "-");
  if (/^ja(?:-|$)/.test(normalized)) return "ja";
  if (/^zh(?:-|$)/.test(normalized)) return "zh";
  if (/^en(?:-|$)/.test(normalized)) return "en";
  return null;
}

export function resolveLocale(saved: unknown, languagePreferences: readonly string[]): Locale {
  const stored = supportedLocale(saved);
  if (stored) return stored;
  for (const language of languagePreferences) {
    const detected = browserLocale(language);
    if (detected) return detected;
  }
  return "en";
}

export function readLocalePreference(storage: LocaleStorage | null, languagePreferences: readonly string[]): Locale {
  let saved: string | null = null;
  try {
    saved = storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Storage can be disabled by browser privacy settings.
  }
  return resolveLocale(saved, languagePreferences);
}

export function saveLocalePreference(storage: LocaleStorage | null, locale: Locale): boolean {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
    return storage !== null;
  } catch {
    return false;
  }
}

export function readBrowserLocalePreference(): Locale {
  let storage: LocaleStorage | null = null;
  try {
    if (typeof window !== "undefined") storage = window.localStorage;
  } catch {
    // Continue with the browser language when local storage is unavailable.
  }
  const preferences = typeof navigator === "undefined"
    ? []
    : [...navigator.languages, navigator.language].filter(Boolean);
  return readLocalePreference(storage, preferences);
}

export function persistBrowserLocalePreference(locale: Locale): boolean {
  let storage: LocaleStorage | null = null;
  try {
    if (typeof window !== "undefined") storage = window.localStorage;
  } catch {
    return false;
  }
  return saveLocalePreference(storage, locale);
}
