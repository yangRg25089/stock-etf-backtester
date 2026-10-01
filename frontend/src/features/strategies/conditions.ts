import type { Catalog, ConditionGroup, ConditionKind, ConditionLeaf, StrategyRules } from "../../api/generated";

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

export function conditionCount(node: ConditionNode | null | undefined): number {
  return !node ? 0 : "kind" in node ? 1 : 1 + (node.children ?? []).reduce((count, child) => count + conditionCount(child), 0);
}

export function ruleConditionCount(rules: StrategyRules): number {
  return conditionCount(rules.buy) + conditionCount(rules.sell);
}

export function createCondition(catalog: Catalog, kind: ConditionKind, side: "buy" | "sell", id: string): ConditionLeaf {
  const metadata = catalog.conditions?.find(item => item.kind === kind);
  if (!metadata) throw new Error(`Missing condition metadata: ${kind}`);
  const keys = side === "buy" ? metadata.buyParameterKeys : metadata.sellParameterKeys;
  const params = Object.fromEntries(keys.map(key => {
    const definition = catalog.parameters?.find(item => item.key === key);
    if (!definition) throw new Error(`Missing parameter metadata: ${key}`);
    return [key, structuredClone(definition.default)];
  }));
  return { type: "condition", id, kind, enabled: true, params };
}

export function conditionFieldOwner(strategyId: string, node: ConditionLeaf): string {
  return node.id === `buy-${node.kind}` ? strategyId : `${strategyId}-${node.id}`;
}
