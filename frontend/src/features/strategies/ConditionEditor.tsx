import { useEffect, useRef, type ReactNode } from "react";
import type { Catalog, ConditionGroup, ConditionKind, Diagnostic, StrategyRules } from "../../api/generated";
import { translate, type Locale } from "../../i18n/messages";
import { ParameterField } from "../../shared/ui/ParameterField";
import { parameterFieldId } from "../../shared/ui/parameterFieldId";
import { ToggleSwitch } from "../../shared/ui/ToggleSwitch";
import { DiagnosticList } from "../runs/DiagnosticList";
import { conditionFieldOwner, conditionLeaves, conditionParameters, createCondition, ruleConditionCount, type ConditionNode } from "./conditions";
import { conditionComparatorSymbol, conditionParameterOperator, formatConditionDisplayRule } from "./conditionExpression";

type Side = "buy" | "sell";
interface ConditionEditorProps {
  catalog: Catalog;
  strategyId: string;
  locale: Locale;
  rules: StrategyRules;
  custom: boolean;
  fixedTrend?: boolean;
  buyContent?: ReactNode;
  sellContent?: ReactNode;
  currency?: string;
  errors: Diagnostic[];
  onChange(value: StrategyRules): void;
}

interface NodeProps extends Omit<ConditionEditorProps, "rules" | "onChange"> {
  node: ConditionNode;
  side: Side;
  depth: number;
  disabled: boolean;
  remaining: number;
  usedKinds: ReadonlySet<ConditionKind>;
  root?: boolean;
  onChange(node: ConditionNode): void;
  onRemove?(restoreFocus: boolean): void;
}

function subtreeIds(node: ConditionNode): string[] {
  return [node.id, ...("kind" in node ? [] : (node.children ?? []).flatMap(subtreeIds))];
}

function CollapsedConditionErrors({ node, errors, catalog, locale }: {
  node: ConditionNode; errors: Diagnostic[]; catalog: Catalog; locale: Locale;
}) {
  if (node.enabled !== false) return null;
  const ids = new Set(subtreeIds(node));
  const diagnostics = errors.filter(error => {
    const id = (error.details as Record<string, unknown> | undefined)?.conditionId;
    return error.severity === "error" && typeof id === "string" && ids.has(id);
  });
  if (!diagnostics.length) return null;
  return <div className="dialog-diagnostics condition-collapsed-errors" role="alert" tabIndex={0}>
    <DiagnosticList diagnostics={diagnostics} locale={locale} fieldLabel={error => {
      const parameter = catalog.parameters?.find(item => error.fieldPath?.endsWith(`.${item.key}`));
      return parameter ? translate(locale, parameter.translationKey) : null;
    }} />
  </div>;
}

function ConditionRuleSummary({ node, side, catalog, locale }: {
  node: Extract<ConditionNode, { kind: ConditionKind }>;
  side: Side;
  catalog: Catalog;
  locale: Locale;
}) {
  const definition = catalog.conditions?.find(item => item.kind === node.kind);
  const rule = side === "buy" ? definition?.buyDisplayRule : definition?.sellDisplayRule;
  if (!rule) return null;
  const formatted = formatConditionDisplayRule(rule, conditionParameters(node), catalog.parameters ?? [], locale);
  return <div className="condition-expression-summary">
    <span className="condition-expression-prefix">{translate(locale, "conditions.triggerPrefix")}</span>
    {formatted.clauses.map((clause, index) => <span className="condition-expression-group" key={`${node.id}-${index}`}>
      {index > 0 && <span className="condition-expression-logic">{translate(locale, `conditions.logic.${formatted.logic.toLowerCase()}`)}</span>}
      <span className="condition-expression-clause">
        <span>{clause.left}</span>{" "}
        <span className="condition-expression-operator" aria-label={clause.spokenOperator}>{clause.operator}</span>{" "}
        <span>{clause.right}</span>
        {clause.sellRatio && <span className="condition-sell-ratio"> · {translate(locale, "conditions.sellTierRatio", { ratio: clause.sellRatio })}</span>}
      </span>
    </span>)}
    {formatted.sellRatio && <span className="condition-sell-ratio condition-rule-sell-ratio">
      {translate(locale, "conditions.sellRatio", { ratio: formatted.sellRatio })}
    </span>}
    {formatted.note && <span className="condition-rule-note">{formatted.note}</span>}
  </div>;
}

function DeleteCondition({ locale, onRemove, disabled }: { locale: Locale; onRemove(restoreFocus: boolean): void; disabled: boolean }) {
  return <button type="button" className="icon-button condition-remove" disabled={disabled}
    aria-label={translate(locale, "conditions.remove")} title={translate(locale, "conditions.remove")} onClick={event => onRemove(event.detail === 0)}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
  </button>;
}

function LogicConnector({ node, index, locale, disabled, onChange }: { node: ConditionGroup; index: number; locale: Locale; disabled: boolean; onChange(node: ConditionGroup): void }) {
  const operator = node.operator ?? "AND";
  return <div className="condition-logic-connector" data-group-id={node.id}>
    <span className="condition-logic-line" aria-hidden="true" />
    <div className="field-segments" role="radiogroup" aria-label={translate(locale, "conditions.relationship")}>
      {(["AND", "OR"] as const).map(value => <label className="field-segment" key={value} title={translate(locale, value === "AND" ? "strategy.logicAnd" : "strategy.logicOr")}>
        <input type="radio" className="segment-input" name={`logic-${node.id}-${index}`} value={value} aria-label={value}
          checked={operator === value} disabled={disabled} onChange={() => onChange({ ...node, operator: value })} />
        <span>{value}</span>
      </label>)}
    </div>
    <span className="condition-logic-line" aria-hidden="true" />
  </div>;
}

function ConditionNodeEditor(props: NodeProps) {
  const { node, side, depth, root, catalog, strategyId, locale, custom, fixedTrend, errors, remaining, onChange, onRemove } = props;
  const addSelectRef = useRef<HTMLSelectElement>(null);
  const restoreAddFocusRef = useRef(false);
  useEffect(() => {
    if (!restoreAddFocusRef.current) return;
    restoreAddFocusRef.current = false;
    if (addSelectRef.current && !addSelectRef.current.disabled) addSelectRef.current.focus();
  }, [node]);
  const disabled = props.disabled || node.enabled === false;
  const nodeErrors = errors.filter(error => {
    const details = error.details as Record<string, unknown> | undefined;
    return details?.conditionId ? details.conditionId === node.id : !error.fieldPath?.includes(".rules.");
  });
  if ("kind" in node) {
    const metadata = catalog.conditions?.find(item => item.kind === node.kind);
    const keys = side === "buy" ? metadata?.buyParameterKeys : metadata?.sellParameterKeys;
    const params = conditionParameters(node);
    const name = translate(locale, metadata?.nameKey ?? `conditions.${node.kind}`);
    return <section className={`condition-card${disabled ? " is-disabled" : ""}`} data-condition-kind={node.kind} data-condition-id={node.id}>
      {!root && <header className="condition-card-heading">
        <h4>{name}</h4>
        <div className="condition-heading-actions">
          {custom && <ToggleSwitch label={`${translate(locale, `strategy.${side}`)} · ${name}`} checked={node.enabled !== false}
            disabled={props.disabled} onChange={enabled => onChange({ ...node, enabled })} />}
          {onRemove && <DeleteCondition locale={locale} onRemove={onRemove} disabled={props.disabled} />}
        </div>
      </header>}
      {!root && <CollapsedConditionErrors node={node} errors={errors} catalog={catalog} locale={locale} />}
      <ConditionRuleSummary node={node} side={side} catalog={catalog} locale={locale} />
      <div className="strategy-parameter-grid" hidden={disabled}>
        {(keys ?? []).filter(key => !(fixedTrend && side === "sell" && key === "exit.ratio")).map(key => {
          const definition = catalog.parameters?.find(item => item.key === key);
          if (!definition) return null;
          const conditionRule = side === "buy" ? metadata?.buyDisplayRule : metadata?.sellDisplayRule;
          const operator = conditionRule ? conditionParameterOperator(conditionRule, key) : null;
          const label = translate(locale, definition.translationKey);
          const labelText = operator
            ? `${label}${translate(locale, "conditions.comparatorSuffix", { operator: conditionComparatorSymbol(operator) })}`
            : key.endsWith(".period")
              ? `${label}${translate(locale, "conditions.calculationWindowSuffix")}`
              : undefined;
          return <ParameterField key={key} definition={definition} value={params[key]} locale={locale}
            id={parameterFieldId(key, conditionFieldOwner(strategyId, node))} errors={nodeErrors}
            disabled={disabled} respectDependencies={false} currency={props.currency}
            labelText={labelText}
            onChange={value => onChange({ ...node, params: { ...params, [key]: value } })} />;
        })}
      </div>
    </section>;
  }

  const children = node.children ?? [];
  const maxDepth = catalog.conditionLimits?.maxDepth ?? Infinity;
  const hasAvailableKind = (catalog.conditions ?? []).some(item => !props.usedKinds.has(item.kind));
  const canAdd = remaining > 0 && depth < maxDepth && !disabled;
  const canAddGroup = canAdd && hasAvailableKind && remaining > 1 && depth + 1 < maxDepth;
  return <section className={`condition-group${root ? " is-root" : ""}${disabled ? " is-disabled" : ""}`} data-condition-id={node.id}>
    {!root && <header className="condition-card-heading">
      <h4>{translate(locale, "conditions.group")}</h4>
      <div className="condition-heading-actions">
        <ToggleSwitch label={`${translate(locale, `strategy.${side}`)} · ${translate(locale, "conditions.group")}`} checked={node.enabled !== false}
          disabled={props.disabled} onChange={enabled => onChange({ ...node, enabled })} />
        {onRemove && <DeleteCondition locale={locale} onRemove={onRemove} disabled={props.disabled} />}
      </div>
    </header>}
    {!root && <CollapsedConditionErrors node={node} errors={errors} catalog={catalog} locale={locale} />}
    <div className="condition-group-content" hidden={disabled}>
      {children.map((child, index) => <div className="condition-child" key={child.id}>
        {index > 0 && <LogicConnector node={node} index={index} locale={locale} disabled={disabled} onChange={onChange} />}
        <ConditionNodeEditor {...props} node={child} depth={depth + 1} root={false} disabled={disabled}
          onChange={changed => onChange({ ...node, children: children.map(item => item.id === child.id ? changed : item) })}
          onRemove={custom ? restoreFocus => {
            restoreAddFocusRef.current = restoreFocus;
            onChange({ ...node, children: children.filter(item => item.id !== child.id) });
          } : undefined} />
      </div>)}
      {children.length === 0 && <p className="condition-empty">{translate(locale, "conditions.empty")}</p>}
      {custom && <div className="condition-add">
        <label className="sr-only" htmlFor={`condition-add-${node.id}`}>{translate(locale, "conditions.add")}</label>
        <select ref={addSelectRef} id={`condition-add-${node.id}`} className="input condition-add-select" value="" disabled={!canAdd || !hasAvailableKind}
          title={!hasAvailableKind ? translate(locale, "conditions.allAdded") : undefined}
          onChange={event => {
            const value = event.target.value;
            if (!canAdd || !hasAvailableKind || !value || (value === "group" ? !canAddGroup : props.usedKinds.has(value as ConditionKind))) return;
            const id = `${side}-${value}-${crypto.randomUUID()}`;
            const child: ConditionNode = value === "group"
              ? { type: "group", id, enabled: true, operator: "AND", children: [] }
              : createCondition(catalog, value as ConditionKind, side, id);
            onChange({ ...node, children: [...children, child] });
          }}>
          <option value="">＋ {translate(locale, "conditions.add")}</option>
          {(catalog.conditions ?? []).map(item => <option key={item.kind} value={item.kind} disabled={props.usedKinds.has(item.kind)}>{translate(locale, item.nameKey)}</option>)}
          <option value="group" disabled={!canAddGroup}>{translate(locale, "conditions.group")}</option>
        </select>
        {!canAdd && !disabled && <span className="field-hint">{translate(locale, "conditions.limit")}</span>}
        {canAdd && !hasAvailableKind && root && <span className="field-hint">{translate(locale, "conditions.allAdded")}</span>}
      </div>}
    </div>
  </section>;
}

export function ConditionEditor(props: ConditionEditorProps) {
  const { rules, locale, onChange, catalog, strategyId, custom } = props;
  const remaining = (catalog.conditionLimits?.maxNodes ?? Infinity) - ruleConditionCount(rules);
  return <div className="strategy-rule-sections">
    {(["buy", "sell"] as const).map(side => {
      const node = rules[side];
      const buyContent = side === "buy" ? props.buyContent : props.sellContent;
      const name = node && "kind" in node ? translate(locale, `conditions.${node.kind}`) : null;
      const headingId = `strategy-parameter-heading-${strategyId}-${side === "buy" && node && "kind" in node ? node.kind : side}`;
      return <section key={side} className={`strategy-rule-section${node?.enabled === false || (!node && !buyContent) ? " is-disabled" : ""}`}
        data-rule-side={side} aria-labelledby={headingId}>
        <header className="condition-heading">
          <h3 id={headingId}>{translate(locale, `strategy.${side}`)}{name && <span className="condition-kind-name">{name}</span>}</h3>
          {node && <ToggleSwitch label={translate(locale, `strategy.${side}`)} checked={node.enabled !== false}
            onChange={enabled => onChange({ ...rules, [side]: { ...node, enabled } })} />}
        </header>
        {node && <CollapsedConditionErrors node={node} errors={props.errors} catalog={catalog} locale={locale} />}
        <div className="strategy-rule-content" hidden={node?.enabled === false}>
          {node ? <ConditionNodeEditor {...props} node={node} side={side} depth={1} disabled={false} remaining={remaining}
            usedKinds={new Set(conditionLeaves(node).map(item => item.kind))} root={true} onChange={changed => onChange({ ...rules, [side]: changed })} />
            : buyContent ?? <p className="condition-empty">{translate(locale, side === "sell" && !custom ? "strategy.noSell" : "conditions.empty")}</p>}
          {node && <p className="condition-timing-note">{translate(locale, "conditions.executionTiming")}</p>}
        </div>
      </section>;
    })}
  </div>;
}
