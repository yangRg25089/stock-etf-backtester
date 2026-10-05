import { translate, type Locale } from "../../i18n/messages";

export function signalLabel(locale: Locale, signalId: string | null | undefined): string {
  if (!signalId) return "—";
  const [baseSignalId] = signalId.split(":", 1);
  const vixTier = baseSignalId === "vix.exit" ? signalId.match(/\.low([12])(?:$|:)/)?.[1] : undefined;
  const candidates = [
    signalId,
    ...(vixTier ? [`vix.exit.low${vixTier}`] : []),
    ...(baseSignalId !== signalId ? [baseSignalId] : []),
  ];
  for (const candidate of candidates) {
    const key = `trade.signal.${candidate}`;
    const label = translate(locale, key);
    if (label !== key) return label;
  }
  return translate(locale, "trade.signalOther");
}
