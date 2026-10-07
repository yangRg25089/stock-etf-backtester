import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { translate, type Locale } from "../../i18n/messages";

export function TopbarMenu({ locale, busy, children }: {
  locale: Locale; busy: boolean; children: ReactNode | ((openMenu: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const openMenu = () => { if (window.matchMedia("(max-width: 767px)").matches) setOpen(true); };

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767px)");
    const reset = () => {
      setOpen(false);
      if (phone.matches && panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
    };
    phone.addEventListener("change", reset);
    return () => phone.removeEventListener("change", reset);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || trigger.current?.contains(target) || panel.current?.contains(target)) return;
      if (target instanceof Element && target.closest("dialog[open]")) return;
      setOpen(false);
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [open]);

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
