import type { Locale } from "../../i18n/messages";

export function languageTag(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : "zh-CN";
}

export function numericValue(value: string | number | null | undefined): number | null {
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

/** Shift the saved Decimal text to percent units without losing precision. */
export function formatExactPercent(value: string | number | null | undefined): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value ?? ""));
  if (!match || !(match[2] + (match[3] ?? "")) || Math.abs(Number(match[4] ?? 0)) > 4096) return "—";
  const digits = match[2] + (match[3] ?? "");
  if (!/[1-9]/.test(digits)) return "0%";
  const point = match[2].length + Number(match[4] ?? 0) + 2;
  const text = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length
    ? digits + "0".repeat(point - digits.length) : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, fraction = ""] = text.split(".");
  const tail = fraction.replace(/0+$/, "");
  return `${match[1] === "-" ? "-" : ""}${whole.replace(/^0+(?=\d)/, "")}${tail ? `.${tail}` : ""}%`;
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

export function formatQuantity(
  value: string | number | null | undefined,
  locale: Locale,
): string {
  const numeric = numericValue(value);
  return numeric === null
    ? "—"
    : new Intl.NumberFormat(languageTag(locale), { maximumFractionDigits: 8 }).format(numeric);
}
