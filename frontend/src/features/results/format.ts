import type { Locale } from "../../i18n/messages";

function languageTag(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : "zh-CN";
}

function numericValue(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function formatCurrency(
  value: string | number | null | undefined,
  currency: string | null | undefined,
  locale: Locale,
): string {
  const numeric = numericValue(value);
  if (numeric === null) return "—";
  if (!currency) return new Intl.NumberFormat(languageTag(locale), { maximumFractionDigits: 2 }).format(numeric);
  try {
    return new Intl.NumberFormat(languageTag(locale), {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numeric);
  } catch {
    return new Intl.NumberFormat(languageTag(locale), { maximumFractionDigits: 2 }).format(numeric);
  }
}

export function formatPercent(
  value: string | number | null | undefined,
  locale: Locale,
): string {
  const numeric = numericValue(value);
  return numeric === null
    ? "—"
    : new Intl.NumberFormat(languageTag(locale), {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(numeric);
}

export function formatMultiple(
  value: string | number | null | undefined,
  locale: Locale,
): string {
  const numeric = numericValue(value);
  if (numeric === null) return "—";
  return `${new Intl.NumberFormat(languageTag(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(numeric)}×`;
}

export function formatPlainNumber(
  value: string | number | null | undefined,
  locale: Locale,
): string {
  const numeric = numericValue(value);
  return numeric === null
    ? "—"
    : new Intl.NumberFormat(languageTag(locale), { maximumFractionDigits: 2 }).format(numeric);
}
