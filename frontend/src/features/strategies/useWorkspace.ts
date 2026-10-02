import { useEffect, useRef, useState } from "react";
import type { Catalog, StrategyPresetId } from "../../api/generated";
import type { WorkspaceState } from "./model";
import { restoreWorkspaceState, saveWorkspaceDraft } from "./workspacePersistence";

export function useWorkspace(catalog: Catalog | null) {
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const nextSequence = useRef(2);

  useEffect(() => {
    if (!catalog) return;
    const restored = restoreWorkspaceState(catalog);
    nextSequence.current = restored.nextStrategySequence;
    setWorkspace(current => current ?? restored.state);
  }, [catalog]);

  const draft = workspace?.draft;
  const activeStrategyId = workspace?.activeStrategyId;
  const nextCustomNumber = workspace?.nextCustomNumber;
  useEffect(() => {
    if (!draft || activeStrategyId === undefined || nextCustomNumber === undefined) return;
    if (!saveWorkspaceDraft({ draft, activeStrategyId, nextCustomNumber }, nextSequence.current)) setSaveFailed(true);
  }, [draft, activeStrategyId, nextCustomNumber]);

  const nextStrategyId = (presetId: StrategyPresetId) => {
    const id = `strategy-${presetId}-${nextSequence.current}`;
    nextSequence.current += 1;
    return id;
  };

  return { workspace, setWorkspace, nextStrategyId, saveFailed };
}
