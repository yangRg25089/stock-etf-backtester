import { useEffect, type ReactNode, type RefObject } from "react";

/** Native modal boundary; editors retain validation, draft and commit ownership. */
export function ModalShell({ dialogRef, className, id, labelledBy, describedBy,
  onRequestClose, restoreFocus = false, children }: {
  dialogRef: RefObject<HTMLDialogElement>;
  className: string;
  id?: string;
  labelledBy: string;
  describedBy?: string;
  onRequestClose(): void;
  restoreFocus?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (restoreFocus && (previous instanceof HTMLElement || previous instanceof SVGElement) && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [dialogRef, restoreFocus]);

  return <dialog ref={dialogRef} className={className} id={id} aria-modal="true"
    aria-labelledby={labelledBy} aria-describedby={describedBy}
    onCancel={event => { event.preventDefault(); onRequestClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onRequestClose(); }}>
    {children}
  </dialog>;
}
