import type { Catalog, Diagnostic } from "../../api/generated";
import { SHARED_FIELD_KEYS } from "../config/fieldKeys";
import type { BacktestDraft } from "../strategies/model";
import type { StrategyFieldNavigation } from "../strategies/StrategyWorkspace";
import { marketDateRecovery } from "./dateRecovery";

type DiagnosticTarget =
  | { kind: "period"; labelKey: string; recovery: NonNullable<ReturnType<typeof marketDateRecovery>> }
  | { kind: "shared"; labelKey: string; parameterKey: string }
  | { kind: "strategy"; labelKey: string; navigation: StrategyFieldNavigation };

/** Resolve machine field paths without opening dialogs or changing any draft. */
export function diagnosticTarget(diagnostic: Diagnostic, catalog: Catalog, draft: BacktestDraft): DiagnosticTarget | null {
  const fieldPath = diagnostic.fieldPath;
  if (!fieldPath) return null;
  const recovery = marketDateRecovery(diagnostic);
  if (recovery?.range) return { kind: "period", labelKey: "market.adjust_period", recovery };

  const sharedKey = SHARED_FIELD_KEYS.find(key => key === fieldPath);
  if (sharedKey) {
    const definition = catalog.parameters?.find(item => item.key === sharedKey);
    return definition ? { kind: "shared", parameterKey: sharedKey, labelKey: definition.translationKey } : null;
  }

  const ruleMatch = /^strategies\[(\d+)\]\.rules\.(buy|sell)((?:\.children\[\d+\])*)\.params\.([A-Za-z][A-Za-z0-9_.-]*)$/.exec(fieldPath);
  const match = /^strategies\[(\d+)\]\.params\.([A-Za-z][A-Za-z0-9_.-]*?)(?:\[(\d+)\])?$/.exec(fieldPath);
  if (!match && !ruleMatch) return null;
  const strategy = draft.strategies[Number(ruleMatch?.[1] ?? match?.[1])];
  const parameterKey = ruleMatch?.[4] ?? match?.[2];
  if (!strategy || !parameterKey) return null;
  const fieldIndex = !ruleMatch && match?.[3] !== undefined ? Number(match[3]) : undefined;
  const preset = catalog.presets?.find(item => item.id === strategy.presetId);
  const definition = catalog.parameters?.find(item => item.key === parameterKey);
  if ((!ruleMatch && !preset?.parameterKeys.includes(parameterKey)) || !definition) return null;

  let conditionId: string | undefined;
  if (ruleMatch) {
    let node = strategy.rules?.[ruleMatch[2] as "buy" | "sell"];
    for (const child of ruleMatch[3].matchAll(/children\[(\d+)\]/g)) {
      node = node && !("kind" in node) ? node.children?.[Number(child[1])] : undefined;
    }
    conditionId = node?.id;
  }
  return {
    kind: "strategy", labelKey: definition.translationKey,
    navigation: { strategyId: strategy.id, parameterKey, fieldIndex, conditionId },
  };
}
