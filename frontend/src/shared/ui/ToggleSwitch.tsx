import type { ButtonHTMLAttributes } from "react";

interface ToggleSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick" | "aria-checked" | "aria-label" | "type" | "role"> {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}

export function ToggleSwitch({ label, checked, onChange, children,
  className = "parameter-switch condition-enable-switch", ...buttonProps }: ToggleSwitchProps) {
  return (
    <button {...buttonProps} type="button" role="switch" className={className}
      aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      {children}
    </button>
  );
}
