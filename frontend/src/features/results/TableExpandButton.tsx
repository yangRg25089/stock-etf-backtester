import { translate, type Locale } from "../../i18n/messages";

interface TableExpandButtonProps {
  locale: Locale;
  tableName: string;
  controls: string;
  expanded: boolean;
  disabled?: boolean;
  onToggle(): void;
}

export function TableExpandButton({ locale, tableName, controls, expanded, disabled, onToggle }: TableExpandButtonProps) {
  const label = translate(locale, expanded ? "table.restoreHeight" : "table.expandRows", { table: tableName });
  return (
    <button type="button" className="icon-only-button table-expand-button"
      aria-label={label} aria-expanded={expanded} aria-controls={controls}
      title={label} disabled={disabled} onClick={onToggle}>
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d={expanded ? "M3 7h4V3m6 0v4h4M3 13h4v4m6 0v-4h4" : "M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"} />
      </svg>
    </button>
  );
}
