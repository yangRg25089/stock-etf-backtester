import { useEffect, useState } from "react";

export function useSeriesHighlight(visibleIds: ReadonlySet<string>) {
  const [state, setState] = useState({ hoveredId: null as string | null, focusedId: null as string | null, selectedId: null as string | null });
  const visible = (id: string | null) => id && visibleIds.has(id) ? id : null;
  const hoveredId = visible(state.hoveredId);
  const focusedId = visible(state.focusedId);
  const selectedId = visible(state.selectedId);
  useEffect(() => {
    setState(previous => previous.hoveredId === hoveredId && previous.focusedId === focusedId && previous.selectedId === selectedId
      ? previous : { hoveredId, focusedId, selectedId });
  }, [hoveredId, focusedId, selectedId]);
  function inspect(id: string | null, source: keyof typeof state, pointer = false) {
    setState(previous => source === "selectedId"
      ? { ...previous, selectedId: previous.selectedId === id ? null : id, focusedId: pointer ? null : previous.focusedId }
      : { ...previous, [source]: id });
  }
  return { highlightedId: hoveredId ?? focusedId ?? selectedId, selectedId, inspect };
}
