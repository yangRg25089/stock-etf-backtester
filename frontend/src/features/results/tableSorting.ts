import { compareDecimals, isNumericSearchValue } from "../../api/contractReader";
import type { Locale } from "../../i18n/messages";

export type TableSortDirection = "ascending" | "descending";
export interface TableSort<Key extends string> { key: Key; direction: TableSortDirection }

export function nextTableSort<Key extends string>(current: TableSort<Key> | null, key: Key, firstDirection: TableSortDirection = "ascending"): TableSort<Key> {
  return { key, direction: current?.key === key ? current.direction === "ascending" ? "descending" : "ascending" : firstDirection };
}

function compareValues(left: unknown, right: unknown, locale: Locale): number {
  const leftNumeric = typeof left === "number" || isNumericSearchValue(left);
  const rightNumeric = typeof right === "number" || isNumericSearchValue(right);
  if (leftNumeric && rightNumeric) return compareDecimals(left as string | number, right as string | number);
  return new Intl.Collator(locale, { numeric: true, sensitivity: "base" }).compare(String(left), String(right));
}

/** Sorts a copy and leaves missing values at the bottom in either direction. */
export function sortTableRows<Row, Key extends string>(rows: readonly Row[], sort: TableSort<Key> | null,
  valueFor: (row: Row, key: Key) => unknown, locale: Locale): Row[] {
  if (!sort) return [...rows];
  return rows.map((row, index) => ({ row, index, value: valueFor(row, sort.key) })).sort((left, right) => {
    const a = left.value, b = right.value;
    const aMissing = a == null || a === "", bMissing = b == null || b === "";
    if (aMissing || bMissing) return aMissing === bMissing ? left.index - right.index : aMissing ? 1 : -1;
    const comparison = compareValues(a, b, locale);
    return (sort.direction === "ascending" ? comparison : -comparison) || left.index - right.index;
  }).map(({ row }) => row);
}
