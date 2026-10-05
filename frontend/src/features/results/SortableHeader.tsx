import type { ReactNode } from "react";
import { translate, type Locale } from "../../i18n/messages";
import { nextTableSort, type TableSort, type TableSortDirection } from "./tableSorting";

export function SortableHeader<Key extends string>({ locale, label, sortKey, sort, onSort, disabled = false, firstDirection = "ascending", className }: {
  locale: Locale;
  label: ReactNode;
  sortKey: Key;
  sort: TableSort<Key> | null;
  onSort(sort: TableSort<Key>): void;
  disabled?: boolean;
  firstDirection?: TableSortDirection;
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const nextDirection = active ? sort.direction === "ascending" ? "descending" : "ascending" : firstDirection;
  const labelText = typeof label === "string" ? label : String(label ?? "");
  return <th scope="col" aria-sort={active ? sort.direction : undefined}>
    <button type="button" className={`${className ?? "table-sort"}${active ? " is-sorted" : ""}`} disabled={disabled}
      data-sort-key={sortKey}
      aria-label={translate(locale, "table.sortBy", { column: labelText, direction: translate(locale, `table.${nextDirection}`) })}
      onClick={() => onSort(nextTableSort(sort, sortKey, firstDirection))}>
      {label}<span aria-hidden="true">{active ? sort.direction === "ascending" ? "↑" : "↓" : "↕"}</span>
    </button>
  </th>;
}
