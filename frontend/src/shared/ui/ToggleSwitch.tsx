interface ToggleSwitchProps {
  id?: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}

export function ToggleSwitch({ id, label, checked, disabled, onChange }: ToggleSwitchProps) {
  return (
    <button id={id} type="button" role="switch" className="parameter-switch condition-enable-switch"
      aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  );
}
