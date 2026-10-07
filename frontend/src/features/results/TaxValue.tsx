import { compareDecimals, isNumericSearchValue } from "../../api/contractReader";
import { translate, type Locale } from "../../i18n/messages";
import { formatCurrency } from "./format";
export function TaxValue({ value, currency, locale }: {value: string | number | null | undefined; currency?: string | null; locale: Locale}) {
  if (isNumericSearchValue(value) && compareDecimals(value, 0) !== 0) return <>{formatCurrency(value, currency, locale)}</>;
  const label = translate(locale, isNumericSearchValue(value) ? "tax.none" : "tax.notSaved");
  return <span title={label} aria-label={label}>—</span>;
}
