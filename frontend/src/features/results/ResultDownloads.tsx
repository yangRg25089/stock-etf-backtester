import type { ReactNode } from "react";
import { usePhoneMenu } from "../../shared/ui/usePhoneMenu";
import { translate, type Locale } from "../../i18n/messages";

export function ResultDownloads({ locale, children }: { locale: Locale; children(openMenu: () => void): ReactNode }) {
  const { open, setOpen, trigger, panel, id, openMenu } = usePhoneMenu();
  return <div className="result-downloads">
    <button ref={trigger} id={`${id}-toggle`} type="button" className="button result-downloads-toggle"
      aria-label={translate(locale, "export.menu")} aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" /></svg>
    </button>
    <div ref={panel} id={id} className={`result-downloads-panel${open ? " is-open" : ""}`}>
      {children(openMenu)}
    </div>
  </div>;
}
