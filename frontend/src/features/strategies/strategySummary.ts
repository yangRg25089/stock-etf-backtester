import type { StrategyPresetId, StrategyRules } from "../../api/generated";
import { interpolate, translate, unitLabel, type Locale } from "../../i18n/messages";
import { conditionLeaves, conditionParameters } from "./conditions";

export function formatStrategySummary(
  locale: Locale,
  presetId: StrategyPresetId,
  params: Record<string, unknown>,
  rules?: StrategyRules | null,
): string {
  if (presetId !== "vix_dca") return translate(locale, `presets.${presetId}.description`);
  if (rules) {
    const buy = conditionLeaves(rules.buy, true)[0];
    if (!buy) return translate(locale, "strategy.vixDisabled");
    params = { ...params, ...conditionParameters(buy) };
  }
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
