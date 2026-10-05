import { useEffect, useState } from "react";

export function useSeriesHighlight(visibleIds: ReadonlySet<string>, selection?: {
  id: string | null; onChange(id: string | null): void;
}) {
  const [state, setState] = useState({ hoveredId: null as string | null, focusedId: null as string | null, selectedId: null as string | null });
  const visible = (id: string | null) => id && visibleIds.has(id) ? id : null;
  const hoveredId = visible(state.hoveredId);
  const focusedId = visible(state.focusedId);
  const selectedId = visible(selection ? selection.id : state.selectedId);
  useEffect(() => {
    if (selection?.id && !visibleIds.has(selection.id)) selection.onChange(null);
  }, [selection, visibleIds]);
  useEffect(() => {
    setState(previous => previous.hoveredId === hoveredId && previous.focusedId === focusedId && previous.selectedId === selectedId
      ? previous : { hoveredId, focusedId, selectedId });
  }, [hoveredId, focusedId, selectedId]);
  function inspect(id: string | null, source: keyof typeof state, pointer = false, touch = false) {
    if (source === "selectedId") selection?.onChange(selectedId === id ? null : id);
    setState(previous => source === "selectedId"
      ? { ...previous, selectedId: selectedId === id ? null : id, focusedId: pointer ? null : previous.focusedId,
          hoveredId: touch ? null : previous.hoveredId }
      : { ...previous, [source]: id });
  }
  return { highlightedId: hoveredId ?? focusedId ?? selectedId, selectedId, inspect };
}
