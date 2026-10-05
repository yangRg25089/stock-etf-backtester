import { translate, type Locale } from "../../../i18n/messages";
import { languageTag as localeTag } from "../format";
import type { AxisSeriesId, SeriesDefinition, IndicatorSeriesDefinition } from "./chartTypes";

export function preciseValue(value: number | null | undefined, locale: Locale, currency?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}${currency ? ` ${currency}` : ""}`;
}

export function formatAxisValue(
  value: number,
  locale: Locale,
  seriesId: AxisSeriesId,
  currency?: string,
): string {
  if (seriesId === "drawdown") {
    return new Intl.NumberFormat(localeTag(locale), {
      maximumFractionDigits: 1,
      style: "percent",
    }).format(value);
  }
  if (seriesId === "index") {
    return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(value);
  }
  if (currency && (seriesId === "price" || seriesId === "totalAsset")) {
    try {
      return new Intl.NumberFormat(localeTag(locale), {
        currency,
        maximumFractionDigits: value < 10 ? 2 : 0,
        style: "currency",
      }).format(value);
    } catch {
      // A malformed currency must not prevent rendering a saved result.
    }
  }
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 2 }).format(value);
}

export function axisTitle(locale: Locale, seriesId: AxisSeriesId, currency?: string, compact = false): string {
  if (compact && seriesId === "vix") return "VIX";
  if (compact && seriesId === "drawdown") return translate(locale, "chart.drawdownAxisShort");
  if (seriesId === "rsi") return translate(locale, "chart.rsiAxis");
  if (seriesId === "index") return translate(locale, "chart.overlayAxis");
  if (seriesId === "totalAsset" && !currency) return translate(locale, "chart.totalAssetAxisPlain");
  if (seriesId === "price" && !currency) return translate(locale, "chart.priceAxisPlain");
  const key = seriesId === "totalAsset"
    ? "chart.totalAssetAxis"
    : seriesId === "drawdown"
      ? "chart.drawdownAxis"
      : seriesId === "price"
        ? "chart.priceAxis"
        : "chart.vixAxis";
  return translate(locale, key, { currency: currency ?? "" });
}

export function seriesLabel(locale: Locale, series: SeriesDefinition | IndicatorSeriesDefinition, currency?: string): string {
  const units = series.id === "totalAsset" || series.id === "price"
    ? currency
    : series.id === "drawdown"
      ? "%"
      : null;
  return `${series.label ?? translate(locale, series.labelKey)}${units ? ` (${units})` : ""}`;
}
