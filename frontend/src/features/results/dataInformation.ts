import type { Diagnostic, RunResponse } from "../../api/generated";
import { runDataContext } from "../../api/contractReader";
import { conditionLeaves, conditionParameters } from "../strategies/conditions";
import { numericValue } from "./format";
import { isVolatilityObservation } from "./model";
import { savedResultConfiguration } from "./savedConfiguration";

type DataKind = "vix" | "rate" | "pe";
export interface SavedSeriesCoverage {
  kind: DataKind;
  symbol: string | null;
  available: number;
  total: number | null;
  diagnostics: Diagnostic[];
}

/** Saved daily observations describe coverage; a FALSE signal still has valid data. */
export function savedDataInformation(run: RunResponse) {
  const results = run.result?.strategyRuns ?? [];
  const context = runDataContext(run.snapshot);
  const dates = [...new Set(results.flatMap(result => [
    ...(result.dailyAssets ?? []).map(asset => asset.date),
    ...(result.signals ?? []).filter(signal => signal.signalId === "market.price" && signal.state === "true").map(signal => signal.date),
  ]))].sort();
  const sessions = dates.length || null;
  const calendar = new Set(dates);
  const groups = new Map<string, SavedSeriesCoverage & { observedDates: Set<string> }>();
  const ensure = (kind: DataKind, symbol: string | null) => {
    const key = `${kind}:${symbol ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { kind, symbol, available: 0, total: sessions, diagnostics: [], observedDates: new Set() };
      groups.set(key, group);
    }
    return group;
  };
  const symbol = run.snapshot.config.shared.run.symbol;
  for (const result of results) {
    const relevant = new Set<ReturnType<typeof ensure>>();
    const requireSeries = (kind: DataKind, value: unknown) => relevant.add(ensure(kind, typeof value === "string" ? value : null));
    const { strategy, parameters } = savedResultConfiguration(run, result);
    if (strategy?.rules) {
      for (const side of ["buy", "sell"] as const) {
        for (const node of conditionLeaves(strategy.rules[side], true)) {
          const params = conditionParameters(node);
          if (node.kind === "vix" || (side === "sell" && node.kind === "bollinger")) requireSeries("vix", params["vix.symbol"]);
          else if (node.kind === "rate") requireSeries("rate", params["rate.symbol"]);
          else if (node.kind === "pe") requireSeries("pe", symbol);
        }
      }
    } else {
      if (parameters["vix.buyEnabled"] === true || parameters["exit.enabled"] === true && (parameters["exit.vix.low1"] !== undefined || parameters["exit.bollinger.enabled"] === true)) requireSeries("vix", parameters["vix.symbol"]);
      if (parameters["rate.buyEnabled"] === true) requireSeries("rate", parameters["rate.symbol"]);
      if (parameters["pe.buyEnabled"] === true) requireSeries("pe", symbol);
    }
    for (const signal of result.signals ?? []) {
      const kind: DataKind | null = isVolatilityObservation(signal) ? "vix" : signal.conditionKind === "rate" || signal.signalId.startsWith("rate.") ? "rate"
        : signal.conditionKind === "pe" || signal.signalId.startsWith("pe.") ? "pe" : null;
      if (!kind) continue;
      const sourceSymbol = signal.sourceSymbol ?? (kind === "pe" ? symbol : typeof parameters[`${kind}.symbol`] === "string" ? parameters[`${kind}.symbol`] as string : null);
      const group = ensure(kind, sourceSymbol);
      relevant.add(group);
      if (calendar.has(signal.date) && signal.state !== "unavailable" && numericValue(signal.observedValue) !== null) group.observedDates.add(signal.date);
      group.diagnostics.push(...(signal.diagnostics ?? []));
    }
    for (const group of relevant) {
      group.diagnostics.push(...(result.diagnostics ?? []).filter(diagnostic => {
        const path = diagnostic.fieldPath ?? "";
        const details = diagnostic.details as Record<string, unknown> | undefined;
        return path.includes(`${group.kind}.`) || details?.dataKind === (group.kind === "pe" ? "valuation" : "macro")
          && (!details.symbol || details.symbol === group.symbol);
      }));
    }
  }
  const series = [...groups.values()].map(({ observedDates, ...group }) => ({ ...group, available: observedDates.size,
    diagnostics: group.diagnostics.filter((diagnostic, index, all) => all.findIndex(item => item.code === diagnostic.code
      && item.messageKey === diagnostic.messageKey && item.fieldPath === diagnostic.fieldPath && item.source === diagnostic.source) === index),
  }));
  return { symbol, currency: results.find(result => result.metrics?.currency)?.metrics?.currency ?? results.flatMap(result => result.dailyAssets ?? []).find(asset => asset.currency)?.currency ?? null,
    requested: { start: run.snapshot.config.shared.run.startDate, end: run.snapshot.config.shared.run.endDate },
    actual: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    sources: context?.dataProvenance?.sources ?? [], sessions, series,
  };
}
