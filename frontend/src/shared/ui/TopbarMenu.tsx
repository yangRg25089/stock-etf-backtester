import type { ReactNode } from "react";
import { usePhoneMenu } from "./usePhoneMenu";
import { translate, type Locale } from "../../i18n/messages";

export function TopbarMenu({ locale, busy, children }: {
  locale: Locale; busy: boolean; children: ReactNode | ((openMenu: () => void) => ReactNode);
}) {
  const { open, setOpen, trigger, panel, id, openMenu } = usePhoneMenu();

  return <>
    <button ref={trigger} id={`${id}-toggle`} type="button" className="topbar-menu-toggle"
      aria-label={translate(locale, "app.functionalMenu")} aria-expanded={open} aria-controls={id}
      data-busy={busy} onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d={open ? "m5 5 10 10M15 5 5 15" : "M3 5h14M3 10h14M3 15h14"} /></svg>
      {busy && <span className="topbar-menu-activity" aria-hidden="true" />}
    </button>
    <div ref={panel} id={id} className={`topbar-functions${open ? " is-open" : ""}`}>
      {typeof children === "function" ? children(openMenu) : children}
    </div>
  </>;
}
