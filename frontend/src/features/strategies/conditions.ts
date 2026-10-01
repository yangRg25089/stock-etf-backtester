import type { ConditionGroup, ConditionLeaf } from "../../api/generated";

export type ConditionNode = ConditionLeaf | ConditionGroup;

export function conditionParameters(node: ConditionLeaf | undefined): Record<string, unknown> {
  const params = node?.params;
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

export function conditionLeaves(node: ConditionNode | null | undefined, enabledOnly = false): ConditionLeaf[] {
  if (!node || (enabledOnly && node.enabled === false)) return [];
  if ("kind" in node) return [node];
  return (node.children ?? []).flatMap(child => conditionLeaves(child, enabledOnly));
}
