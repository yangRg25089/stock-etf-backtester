import { useCallback, useEffect, useId, useRef, useState } from "react";

export function usePhoneMenu() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const openMenu = useCallback(() => { if (window.matchMedia("(max-width: 767px)").matches) setOpen(true); }, []);

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767px)");
    let focusedControl: HTMLElement | null = null;
    const rememberFocus = (event: FocusEvent) => {
      const target = event.target;
      focusedControl = target instanceof HTMLElement && (target === trigger.current || panel.current?.contains(target)) ? target : null;
    };
    const forgetFocus = (event: FocusEvent) => {
      // Hiding a control can blur it before the media-query change arrives.
      if (event.target === focusedControl && (event.relatedTarget || focusedControl?.getClientRects().length)) focusedControl = null;
    };
    const reset = () => {
      const active = document.activeElement === document.body ? focusedControl : document.activeElement;
      setOpen(false);
      if (phone.matches && panel.current?.contains(active)) trigger.current?.focus({ preventScroll: true });
      else if (!phone.matches && active === trigger.current) {
        const controls = panel.current?.querySelectorAll<HTMLElement>("button, input, select, a[href], [tabindex]");
        for (const control of controls ?? []) {
          if (control.matches(":disabled") || control.tabIndex < 0 || control.getClientRects().length === 0) continue;
          control.focus({ preventScroll: true });
          break;
        }
      }
    };
    document.addEventListener("focusin", rememberFocus);
    document.addEventListener("focusout", forgetFocus);
    phone.addEventListener("change", reset);
    return () => {
      document.removeEventListener("focusin", rememberFocus);
      document.removeEventListener("focusout", forgetFocus);
      phone.removeEventListener("change", reset);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || trigger.current?.contains(target) || panel.current?.contains(target)) return;
      // WebKit can focus the surrounding section when a menu button is clicked.
      // The pointer started inside the panel; this ancestor focus is not an exit.
      if (event.type === "focusin" && target instanceof Element && target.contains(panel.current)) return;
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

  return { open, setOpen, trigger, panel, id, openMenu };
}
