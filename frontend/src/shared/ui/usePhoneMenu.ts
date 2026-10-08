import { useCallback, useEffect, useId, useRef, useState } from "react";

export function usePhoneMenu() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const openMenu = useCallback(() => { if (window.matchMedia("(max-width: 767px)").matches) setOpen(true); }, []);

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

  return { open, setOpen, trigger, panel, id, openMenu };
}
