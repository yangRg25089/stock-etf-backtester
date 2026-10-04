import { useEffect, useRef, useState } from "react";
import type { Catalog, StrategyPresetId } from "../../api/generated";
import type { WorkspaceState } from "./model";
import { restoreWorkspaceState } from "./workspacePersistence";

export function useWorkspace(catalog: Catalog | null) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const nextSequence = useRef(2);

  useEffect(() => {
    if (!catalog) return;
    const restored = restoreWorkspaceState(catalog);
    nextSequence.current = restored.nextStrategySequence;
    setWorkspace(current => current ?? restored.state);
  }, [catalog]);

  const nextStrategyId = (presetId: StrategyPresetId) => {
    let id: string;
    do { id = `strategy-${presetId}-${nextSequence.current++}`; }
    while (workspace?.draft.strategies.some(strategy => strategy.id === id));
    return id;
  };

  return { workspace, setWorkspace, nextStrategyId };
}
