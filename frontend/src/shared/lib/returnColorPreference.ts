import type { Locale } from "../../i18n/messages";

export const RETURN_COLOR_STORAGE_KEY = "stock-etf-backtester.heatmap-palette.v1";
export type ReturnColorPalette = "red-up" | "green-up";
type PaletteStorage = Pick<Storage, "getItem" | "setItem">;

function validPalette(value: unknown): ReturnColorPalette | null {
  return value === "red-up" || value === "green-up" ? value : null;
}

export function defaultReturnColorPalette(locale: Locale): ReturnColorPalette {
  return locale === "zh" ? "red-up" : "green-up";
}

export function resolveReturnColorPalette(locale: Locale, preference: unknown): ReturnColorPalette {
  return validPalette(preference) ?? defaultReturnColorPalette(locale);
}

export function readReturnColorPreference(storage: PaletteStorage | null): ReturnColorPalette | null {
  try {
    return validPalette(storage?.getItem(RETURN_COLOR_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveReturnColorPreference(storage: PaletteStorage | null, palette: ReturnColorPalette): boolean {
  try {
    storage?.setItem(RETURN_COLOR_STORAGE_KEY, palette);
    return storage !== null;
  } catch {
    return false;
  }
}

export function readBrowserReturnColorPreference(): ReturnColorPalette | null {
  try {
    return typeof window === "undefined" ? null : readReturnColorPreference(window.localStorage);
  } catch {
    return null;
  }
}

export function persistBrowserReturnColorPreference(palette: ReturnColorPalette): boolean {
  try {
    return typeof window === "undefined" ? false : saveReturnColorPreference(window.localStorage, palette);
  } catch {
    return false;
  }
}
