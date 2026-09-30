import { useRef, type PointerEvent, type KeyboardEvent } from "react";

interface WorkbenchDividerProps {
  width: number;
  onWidthChange(width: number): void;
  label: string;
}

export function WorkbenchDivider({ width, onWidthChange, label }: WorkbenchDividerProps) {
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) => Math.min(420, Math.max(320, value));

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragStart.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    onWidthChange(clamp(dragStart.current.width + event.clientX - dragStart.current.x));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    if (event.key === "ArrowLeft") onWidthChange(clamp(width - step));
    else if (event.key === "ArrowRight") onWidthChange(clamp(width + step));
    else if (event.key === "Home") onWidthChange(320);
    else if (event.key === "End") onWidthChange(420);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className="workbench-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={320}
      aria-valuemax={420}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    >
      <span className="workbench-divider-grip" aria-hidden="true" />
    </div>
  );
}
