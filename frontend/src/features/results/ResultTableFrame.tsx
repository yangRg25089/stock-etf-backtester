import { useId, useState, type ReactNode } from "react";
import type { Locale } from "../../i18n/messages";
import { ExpandedTableOverflow } from "./ExpandedTableOverflow";
import { TableExpandButton } from "./TableExpandButton";

interface ResultTableScrollProps {
  children: ReactNode;
  label: string;
  className: string;
  id?: string;
  expanded?: boolean;
}

/** All result tables use this same semantic scroll region and fixed layers. */
export function ResultTableScroll({ children, label, className, id, expanded = false }: ResultTableScrollProps) {
  return <div id={id} className={`data-table-scroll result-table-scroll ${className}${expanded ? " is-height-expanded" : ""}`}
    tabIndex={0} role="region" aria-label={label}>
    {expanded ? <ExpandedTableOverflow>{children}</ExpandedTableOverflow> : children}
  </div>;
}

interface ResultTableFrameProps {
  children: ReactNode;
  locale: Locale;
  title: string;
  label?: string;
  titleId?: string;
  className?: string;
  scrollClassName: string;
  variant?: "standard" | "performance";
  disabled?: boolean;
  emptyContent?: ReactNode;
  footer?: ReactNode;
}

/** Expansion, controls, and scroll geometry have one owner; callers own columns. */
export function ResultTableFrame({ children, locale, title, label = title, titleId, className = "", scrollClassName,
  variant = "standard", disabled = false, emptyContent, footer }: ResultTableFrameProps) {
  const [expanded, setExpanded] = useState(false);
  const scrollId = useId();
  const performance = variant === "performance";
  const Container = performance ? "section" : "div";
  const classes = [performance ? "performance-group" : "table-height-region", className, "result-table-frame", expanded && "is-height-expanded"].filter(Boolean).join(" ");
  return <Container className={classes}>
    <div className={`${performance ? "performance-group-heading" : "table-height-controls"} result-table-heading`}>
      <h4 id={titleId} className={performance ? undefined : "table-height-controls-title"}>{title}</h4>
      <TableExpandButton locale={locale} tableName={title} controls={scrollId} expanded={expanded}
        disabled={disabled} onToggle={() => setExpanded(value => !value)} />
    </div>
    {emptyContent == null ? <ResultTableScroll id={scrollId} label={label} className={scrollClassName} expanded={expanded}>{children}</ResultTableScroll>
      : <div id={scrollId}>{emptyContent}</div>}
    {footer}
  </Container>;
}
