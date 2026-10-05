import type { Locale } from "../../i18n/messages";
import { formatPercent } from "./format";
import { returnTone, type ReturnKind, type ReturnValue } from "./returnTone";

export function ReturnPercent({ value, locale, kind = "return" }: { value?: ReturnValue; locale: Locale; kind?: ReturnKind }) {
  return <span className={`return-value is-${returnTone(value, kind)}`}>{formatPercent(value, locale)}</span>;
}
