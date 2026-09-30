import type { StrategyPresetId } from "../../api/generated";
import { interpolate, translate, unitLabel, type Locale } from "../../i18n/messages";

export function formatStrategySummary(
  locale: Locale,
  presetId: StrategyPresetId,
  params: Record<string, unknown>,
): string {
  if (presetId !== "vix_dca") return translate(locale, `presets.${presetId}.description`);
  if (params["vix.buyEnabled"] === false) return translate(locale, "strategy.vixDisabled");
  const maximum = params["accumulation.maxSignalBuysPerMonth"];
  return interpolate(translate(locale, "strategy.vixSummary"), {
    symbol: String(params["vix.symbol"] ?? ""),
    threshold: String(params["vix.buyThreshold"] ?? ""),
    maximum: maximum == null
      ? translate(locale, "strategy.unlimited")
      : `${String(maximum)} ${unitLabel(locale, "count") ?? ""}`.trim(),
  });
}
