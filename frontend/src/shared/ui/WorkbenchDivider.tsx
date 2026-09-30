interface WorkbenchDividerProps {
  collapsed: boolean;
  label: string;
  onToggle(): void;
}

export function WorkbenchDivider({ collapsed, label, onToggle }: WorkbenchDividerProps) {
  return (
    <div className="workbench-divider">
      <button
        className="button workbench-config-toggle icon-only-button"
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={!collapsed}
        aria-controls="workbench-config-panel"
        onClick={onToggle}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d={collapsed ? "m7 5 5 5-5 5" : "m13 5-5 5 5 5"} />
        </svg>
      </button>
    </div>
  );
}
