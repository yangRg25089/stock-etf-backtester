import type { ReactNode } from "react";

interface CollapsiblePanelProps {
  id: string;
  title: string;
  expanded: boolean;
  onExpandedChange(expanded: boolean): void;
  children: ReactNode;
  headerActions?: ReactNode;
  alwaysVisible?: ReactNode;
  className?: string;
}

export function CollapsiblePanel({
  id,
  title,
  expanded,
  onExpandedChange,
  children,
  headerActions,
  alwaysVisible,
  className = "",
}: CollapsiblePanelProps) {
  const headingId = `${id}-heading`;
  const toggleId = `${id}-toggle`;
  const contentId = `${id}-content`;

  return (
    <section
      id={id}
      className={`collapsible-panel${className ? ` ${className}` : ""}`}
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <header className="collapsible-panel-header">
        <h3 id={headingId} className="collapsible-panel-heading">
          <button
            id={toggleId}
            className="collapsible-panel-toggle"
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => onExpandedChange(!expanded)}
          >
            <svg className="collapsible-panel-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="m6 3 5 5-5 5" />
            </svg>
            <span>{title}</span>
          </button>
        </h3>
        {headerActions && <div className="collapsible-panel-actions">{headerActions}</div>}
      </header>
      {alwaysVisible && <div className="collapsible-panel-always-visible">{alwaysVisible}</div>}
      <div
        id={contentId}
        className="collapsible-panel-body"
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  );
}
