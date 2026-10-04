import { useEffect } from "react";

type ShortcutKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat" | "defaultPrevented" | "isComposing">;

export function matchesWorkbenchShortcut(event: ShortcutKeyEvent, key: string): boolean {
  return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !event.repeat
    && !event.defaultPrevented && !event.isComposing && event.key.toLowerCase() === key.toLowerCase();
}

/** Global actions never consume typing, native modal keys or an already handled event. */
export function useWorkbenchShortcut(key: string, enabled: boolean, onTrigger: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: KeyboardEvent) => {
      if (!matchesWorkbenchShortcut(event, key) || document.querySelector("dialog[open]")) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      event.preventDefault();
      onTrigger();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled, key, onTrigger]);
}
