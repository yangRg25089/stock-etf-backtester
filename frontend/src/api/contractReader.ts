import { isRecord } from "../shared/lib/record";
export { isRecord } from "../shared/lib/record";
import schemasJson from "./generated.schema.json";
import type { DrawdownEpisode, ExecutionSettings, PerformanceAnalysis, PeriodReturn, RunDataContext, RunDataProvenance, RunProgressEvent, RunResponse, RunSnapshot, SearchPeriod, SearchResult, StrategyRun, Trade, TradingCosts } from "./generated";
import { isSuccessfulRunStatus, isTerminalRunStatus } from "./runStatus";

type Schema = boolean | {
  title?: string; description?: string; default?: unknown;
  $ref?: string; type?: string; const?: unknown; enum?: unknown[];
  anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[];
  properties?: Record<string, Schema>; required?: string[];
  additionalProperties?: Schema; items?: Schema;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  minItems?: number; maxItems?: number; pattern?: string; format?: string;
  "x-aggregate-status"?: Record<string, string>;
};
const schemas: Record<string, Schema> = schemasJson;
const patterns = new Map<string, RegExp>();
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const MAX_JSON_VALUES = 2_000_000;
const MAX_JSON_STRING = 65_536;

export function isNumericSearchValue(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
    || !Number.isFinite(Number(value))) return false;
  const [coefficient, exponent = "0"] = value.split(/[eE]/);
  const fractionalPlaces = coefficient.split(".")[1]?.length ?? 0;
  return Math.abs(Number(exponent) - fractionalPlaces) <= 4096;
}

export function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** New snapshots own loaded data in one context; schema-1 files remain readable. */
export function runDataContext(snapshot: RunSnapshot): RunDataContext | null {
  return snapshot.dataContext ?? (snapshot.dataFingerprint ? {
    dataFingerprint: snapshot.dataFingerprint,
    dataProvenance: snapshot.dataProvenance,
    effectiveRun: snapshot.config.shared.run,
    dateAdjustments: snapshot.dateAdjustments,
  } : null);
}

function normalizedProvenance(value: RunDataProvenance = {}) {
  return { sources: value.sources ?? [], calendarAsOf: value.calendarAsOf ?? null, marketDataThrough: value.marketDataThrough ?? null };
}

function validSnapshot(snapshot: RunSnapshot): boolean {
  if (!validExecutionSettings(snapshot.config.shared.execution)) return false;
  const context = runDataContext(snapshot);
  if (!context) return Boolean(snapshot.submissionFingerprint)
    && sameJson(normalizedProvenance(snapshot.dataProvenance), normalizedProvenance()) && !snapshot.dateAdjustments?.length;
  if (snapshot.dataContext && ((snapshot.dataFingerprint !== undefined && snapshot.dataFingerprint !== context.dataFingerprint)
    || (snapshot.dataProvenance !== undefined && !sameJson(normalizedProvenance(snapshot.dataProvenance), normalizedProvenance(context.dataProvenance)))
    || (snapshot.dateAdjustments !== undefined && !sameJson(snapshot.dateAdjustments, context.dateAdjustments ?? [])))) return false;
  const requested = snapshot.config.shared.run;
  const effective = { ...requested, endMode: requested.endMode ?? "fixed" };
  const fields = new Set<string>();
  for (const adjustment of context.dateAdjustments ?? []) {
    if (fields.has(adjustment.field) || adjustment.requestedDate === adjustment.effectiveDate
      || (requested[adjustment.field] !== adjustment.requestedDate
        && (snapshot.submissionFingerprint || requested[adjustment.field] !== adjustment.effectiveDate))) return false;
    fields.add(adjustment.field);
    effective[adjustment.field] = adjustment.effectiveDate;
  }
  return effective.startDate <= effective.endDate
    && sameJson(effective, { ...context.effectiveRun, endMode: context.effectiveRun.endMode ?? "fixed" });
}

export function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

/** Bound even schema-free parameter/details fields before walking the contract. */
export function isBoundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++count > MAX_JSON_VALUES || entry.depth > 64) return false;
    const item = entry.value;
    if (typeof item === "string" && item.length > MAX_JSON_STRING) return false;
    if (typeof item === "number" && !Number.isFinite(item)) return false;
    if (Array.isArray(item)) {
      if (item.length > 250_000 || count + pending.length + item.length > MAX_JSON_VALUES) return false;
      for (const child of item) pending.push({ value: child, depth: entry.depth + 1 });
    } else if (isRecord(item)) {
      for (const [key, child] of Object.entries(item)) {
        if (UNSAFE_KEYS.has(key) || key.length > 256) return false;
        pending.push({ value: child, depth: entry.depth + 1 });
      }
    } else if (item !== null && !["string", "number", "boolean"].includes(typeof item)) return false;
  }
  return true;
}

function matches(value: unknown, schema: Schema, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof schema === "boolean") return schema;
  if (schema.$ref) {
    const target = schemas[schema.$ref.split("/").at(-1)!];
    return target !== undefined && matches(value, target, depth);
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.anyOf && !schema.anyOf.some(member => matches(value, member, depth))) return false;
  if (schema.oneOf && schema.oneOf.filter(member => matches(value, member, depth)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(member => matches(value, member, depth))) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number": case "integer":
      return typeof value === "number" && Number.isFinite(value)
        && (schema.type !== "integer" || Number.isSafeInteger(value))
        && (schema.minimum === undefined || value >= schema.minimum)
        && (schema.maximum === undefined || value <= schema.maximum);
    case "string": {
      if (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? MAX_JSON_STRING)) return false;
      if (schema.pattern) {
        if (!patterns.has(schema.pattern)) patterns.set(schema.pattern, new RegExp(schema.pattern));
        const decimal = schema.pattern.includes("[-+.]");
        // Decimal JSON can use scientific notation for very small exact values.
        if (decimal ? !isNumericSearchValue(value)
          : !patterns.get(schema.pattern)!.test(value)) return false;
      }
      if (schema.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString().slice(0, 10) !== value)) return false;
      if (schema.format === "date-time" && !isIsoDateTime(value)) return false;
      return true;
    }
    case "array": return Array.isArray(value) && value.length >= (schema.minItems ?? 0)
      && value.length <= (schema.maxItems ?? 250_000) && value.every(item => matches(item, schema.items ?? true, depth + 1));
    case "object": {
      if (!isRecord(value) || (schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
      return Object.entries(value).every(([key, child]) => {
        const definition = schema.properties?.[key] ?? schema.additionalProperties ?? true;
        return matches(child, definition, depth + 1);
      });
    }
    default: return true;
  }
}

export function matchesContract(name: string, value: unknown): boolean {
  const schema = schemas[name];
  return schema !== undefined && isBoundedJson(value) && matches(value, schema);
}

function validResultState(row: Pick<StrategyRun, "status" | "metrics" | "diagnostics">): boolean {
  if (!row.status) return false;
  if (isSuccessfulRunStatus(row.status) && !row.metrics) return false;
  const analysis = row.metrics?.analysis;
  if (analysis && !validAnalysis(analysis)) return false;
  if (!validTradingCosts(row.metrics?.tradingCosts)) return false;
  return !["failed", "unavailable"].includes(row.status) || Boolean(row.diagnostics?.length);
}

function validAnalysis(analysis: PerformanceAnalysis): boolean {
  if (compareDecimals(analysis.riskFreeAnnualRate, -1) <= 0
    || (analysis.annualizedReturn != null && compareDecimals(analysis.annualizedReturn, -1) < 0)
    || [analysis.annualizedVolatility, analysis.turnover, analysis.averageCashRatio].some(value => value != null && compareDecimals(value, 0) < 0)
    || (analysis.averageCashRatio != null && compareDecimals(analysis.averageCashRatio, 1) > 0)) return false;
  return validPeriods(analysis.annualReturns, false) && validPeriods(analysis.monthlyReturns, true)
    && validEpisodes(analysis.drawdownEpisodes);
}

function validPeriods(rows: PeriodReturn[] | null | undefined, monthly: boolean): boolean {
  let previous = 0;
  return (rows ?? []).every(row => {
    const key = row.year * 12 + (row.month ?? 0);
    const belongs = (day: string) => Number(day.slice(0, 4)) === row.year && (!monthly || Number(day.slice(5, 7)) === row.month);
    const valid = (row.month != null) === monthly && key > previous && row.startDate <= row.endDate
      && belongs(row.startDate) && belongs(row.endDate) && compareDecimals(row.priceReturn, -1) >= 0
      && (row.navReturn == null) === (row.unavailableReason != null)
      && (row.navReturn == null || compareDecimals(row.navReturn, -1) >= 0);
    previous = key;
    return valid;
  });
}

function validEpisodes(rows: DrawdownEpisode[] | null | undefined): boolean {
  const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86_400_000;
  const peaks = new Set<string>();
  return (rows ?? []).every((row, index, all) => {
    const previous = all[index - 1];
    const order = previous ? compareDecimals(previous.drawdown, row.drawdown) : -1;
    if (peaks.has(row.peakDate) || order > 0 || (previous && order === 0 && previous.peakDate > row.peakDate)) return false;
    peaks.add(row.peakDate);
    return row.peakDate <= row.bottomDate && row.bottomDate <= row.endDate
      && compareDecimals(row.drawdown, -1) >= 0 && compareDecimals(row.drawdown, 0) < 0
      && row.durationDays === days(row.peakDate, row.endDate)
      && (row.state === "recovered" ? row.recoveredDate === row.endDate && row.recoveryDays === days(row.bottomDate, row.endDate)
        : row.recoveredDate == null && row.recoveryDays == null);
  });
}

/** Compare saved decimal values without rounding them through a JS float. */
export function decimalIdentity(value: string | number): string {
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.replace(/^[+-]/, "").split(".");
  const raw = (whole + fraction).replace(/^0+/, "");
  const digits = raw.replace(/0+$/, "");
  return digits ? `${coefficient.startsWith("-") ? "-" : ""}${digits}e${Number(exponent) - fraction.length + raw.length - digits.length}` : "0";
}

export function compareDecimals(left: string | number, right: string | number): number {
  const parts = (value: string | number) => {
    const identity = decimalIdentity(value);
    const [digits, exponent = "0"] = identity.replace(/^-/, "").split("e");
    return { digits, order: digits.length + Number(exponent), sign: identity === "0" ? 0 : identity.startsWith("-") ? -1 : 1 };
  };
  const a = parts(left), b = parts(right);
  if (a.sign !== b.sign) return a.sign - b.sign;
  if (!a.sign) return 0;
  if (a.order !== b.order) return Math.sign(a.order - b.order) * a.sign;
  const length = Math.max(a.digits.length, b.digits.length);
  const x = a.digits.padEnd(length, "0"), y = b.digits.padEnd(length, "0");
  return (x === y ? 0 : x < y ? -1 : 1) * a.sign;
}

function validTradeExplanation(trade: Trade): boolean {
  return [trade.cashBefore, trade.cashAfter, trade.quantityBefore, trade.quantityAfter]
    .every(value => value == null || compareDecimals(value, 0) >= 0)
    && [trade.executionBasePrice, trade.executionPrice].every(value => value == null || compareDecimals(value, 0) > 0)
    && (trade.executionPrice == null || decimalIdentity(trade.executionPrice) === decimalIdentity(trade.price))
    && (trade.grossAmount == null || compareDecimals(trade.grossAmount, 0) > 0)
    && validTradingCosts(trade.tradingCosts);
}

function validTradingCosts(costs?: TradingCosts | null): boolean {
  return costs == null || Object.values(costs).every(value => compareDecimals(value, 0) >= 0);
}

/** Mirror the domain input invariant exactly, without rounding decimal strings. */
export function validExecutionSettings(settings?: ExecutionSettings | null): boolean {
  if (settings == null) return true;
  if (!matchesContract("ExecutionSettings", settings) || [settings.commission, settings.slippagePct, settings.spreadPct].some(value => compareDecimals(value, 0) < 0)) return false;
  const term = (value: string) => { const [digits, exponent = "0"] = decimalIdentity(value).split("e"); return { digits: BigInt(digits), exponent: Number(exponent) }; };
  const slip = term(settings.slippagePct), spread = term(settings.spreadPct);
  const exponent = Math.min(0, slip.exponent, spread.exponent);
  return 2n * slip.digits * 10n ** BigInt(slip.exponent - exponent)
    + spread.digits * 10n ** BigInt(spread.exponent - exponent) < 200n * 10n ** BigInt(-exponent);
}

function validSearchPeriod(period: SearchPeriod): boolean {
  return period.startDate <= period.endDate && (period.effectiveStartDate == null) === (period.effectiveEndDate == null)
    && (period.effectiveStartDate == null || period.startDate <= period.effectiveStartDate
      && period.effectiveStartDate <= period.effectiveEndDate! && period.effectiveEndDate! <= period.endDate);
}

function validWalkForwardSearch(search: SearchResult): boolean {
  const windows = search.walkForwardWindows ?? [];
  const oos = search.outOfSample, period = search.outOfSamplePeriod;
  if (!windows.length || !oos || !period || search.trainPeriod || search.testPeriod || period.phase !== "test"
    || !validSearchPeriod(period) || !validResultState(oos) || search.candidates.some(item => item.testResult)
    || search.candidates.some(item => item.candidateId === oos.resultId)
    || !sameJson(windows.flatMap(item => item.candidateIds), search.candidates.map(item => item.candidateId))
    || !sameJson(windows.flatMap(item => item.rankedCandidateIds), search.rankedCandidateIds)
    || period.startDate !== windows[0].testPeriod.startDate || period.endDate !== windows.at(-1)!.testPeriod.endDate) return false;
  for (const [index, window] of windows.entries()) {
    const train = window.trainPeriod, test = window.testPeriod;
    const completed = search.candidates.filter(item => window.candidateIds.includes(item.candidateId) && isSuccessfulRunStatus(item.status));
    if (window.sequence !== index + 1 || !validSearchPeriod(train) || !validSearchPeriod(test) || train.phase !== "train" || test.phase !== "test"
      || train.endDate >= test.startDate || window.selectedCandidateId !== (window.rankedCandidateIds[0] ?? null)
      || new Set(window.rankedCandidateIds).size !== window.rankedCandidateIds.length || window.rankedCandidateIds.length !== completed.length
      || window.rankedCandidateIds.some(id => !completed.some(item => item.candidateId === id))
      || index > 0 && Date.parse(test.startDate) - Date.parse(windows[index - 1].testPeriod.endDate) !== 86_400_000) return false;
  }
  const baselines = search.periodBenchmarks ?? [];
  return baselines.length === 2 && new Set(baselines.map(item => item.id)).size === 2
    && baselines.some(item => item.presetId === "monthly_dca") && baselines.some(item => item.presetId === "lump_sum")
    && baselines.every(item => item.role === "benchmark" && !item.searchResult && sameJson(item.evaluationPeriod, period) && isStrategyRun(item));
}

export function isStrategyRun(value: unknown): value is StrategyRun {
  if (!matchesContract("StrategyRun", value)) return false;
  const row = value as StrategyRun;
  if (!validResultState(row) || row.trades?.some(trade => !validTradeExplanation(trade))
    || row.dailyAssets?.some(asset => !validTradingCosts(asset.tradingCosts))) return false;
  const period = row.evaluationPeriod;
  if (period && (!validSearchPeriod(period) || [...(row.dailyAssets ?? []), ...(row.trades ?? [])].some(item => item.date < period.startDate || item.date > period.endDate))) return false;
  const search = row.searchResult;
  const candidateIds = new Set(search?.candidates.map(item => item.candidateId));
  const completedIds = new Set(search?.candidates.filter(item => isSuccessfulRunStatus(item.status)).map(item => item.candidateId));
  if (search && (row.presetId !== "grid_search" || search.strategyId !== row.id || search.candidates.length > 10_000
    || new Set(search.dimensions.map(item => item.key)).size !== search.dimensions.length
    || search.dimensions.some(item => !item.values.every(isNumericSearchValue)
      || new Set(item.values.filter(isNumericSearchValue).map(decimalIdentity)).size !== item.values.length)
    || search.totalCandidateCount !== search.candidates.length
    || candidateIds.size !== search.candidates.length
    || search.candidates.some((item, index) => item.sequence !== index + 1 || !validResultState(item) || (item.reusedCalculation && !item.metrics))
    || new Set(search.rankedCandidateIds).size !== search.rankedCandidateIds.length
    || search.rankedCandidateIds.length !== completedIds.size
    || search.rankedCandidateIds.some(id => !completedIds.has(id)))) return false;
  if (search?.optimizationMode === "walk_forward") {
    if (!validWalkForwardSearch(search) || !sameJson(row.metrics ?? null, search.outOfSample?.metrics ?? null)
      || !sameJson(row.evaluationPeriod, search.outOfSamplePeriod)) return false;
  } else if (search?.walkForwardWindows?.length || search?.outOfSample || search?.outOfSamplePeriod) return false;
  else if (search?.optimizationMode === "train_test") {
    const train = search.trainPeriod, test = search.testPeriod;
    if (!train || !test || !validSearchPeriod(train) || !validSearchPeriod(test) || train.phase !== "train" || test.phase !== "test"
      || train.endDate >= test.startDate || search.candidates.some(item => !item.testResult || !validResultState(item.testResult))) return false;
    const testIds = search.candidates.map(item => item.testResult!.resultId);
    if (new Set([...candidateIds, ...testIds]).size !== search.candidates.length * 2) return false;
    const baselines = search.periodBenchmarks ?? [];
    if (baselines.length !== 4 || new Set(baselines.map(item => item.id)).size !== 4
      || baselines.some(item => item.role !== "benchmark" || item.searchResult || !isStrategyRun(item))) return false;
    for (const window of [train, test]) {
      const matching = baselines.filter(item => sameJson(item.evaluationPeriod, window));
      if (matching.length !== 2 || !matching.some(item => item.presetId === "monthly_dca") || !matching.some(item => item.presetId === "lump_sum")) return false;
    }
  } else if (search && (search.trainPeriod || search.testPeriod || search.periodBenchmarks?.length || search.candidates.some(item => item.testResult))) return false;
  return true;
}

export function isRunResponse(value: unknown): value is RunResponse {
  if (!matchesContract("RunResponse", value)) return false;
  const run = value as RunResponse;
  const ids = run.snapshot.config.strategies?.map(item => item.id) ?? [];
  const results = run.result?.strategyRuns ?? [];
  if (run.result) {
    const schema = schemas.RunResult;
    const states = [...new Set(results.map(row => row.status))].sort().join("|");
    const aggregate = typeof schema === "object" ? schema["x-aggregate-status"]?.[states] : undefined;
    if (!aggregate || run.status !== aggregate || run.result.status != null && run.result.status !== aggregate) return false;
  }
  if (isTerminalRunStatus(run.status) && (!results.length || ids.some(id =>
    !results.some(row => row.id === id && row.role === "strategy")))) return false;
  return validSnapshot(run.snapshot) && run.snapshot.runId === run.runId && (!run.result || run.result.runId === run.runId)
    && ids.length > 0 && ids.length <= 32 && new Set(ids).size === ids.length
    && JSON.stringify(ids) === JSON.stringify(run.selectedStrategyIds)
    && new Set(results.map(row => row.id)).size === results.length
    && (runDataContext(run.snapshot) !== null || (!results.some(row => row.metrics) && !isSuccessfulRunStatus(run.status)))
    && results.length <= 34 && results.every(row => isStrategyRun(row)
      && (row.role === "benchmark" || ids.includes(row.id)))
    && (!run.progress || run.progress.completedStrategies <= run.progress.totalStrategies);
}

export function isRunProgressEvent(value: unknown): value is RunProgressEvent {
  if (!matchesContract("RunProgressEvent", value)) return false;
  const event = value as RunProgressEvent;
  if ((event.progress && event.progress.completedStrategies > event.progress.totalStrategies)
    || (isTerminalRunStatus(event.status) && event.progress && event.progress.completedStrategies !== event.progress.totalStrategies)
    || Object.keys(event.strategyStatuses).length > 34 || Object.keys(event.strategySummaries ?? {}).length > 34
    || (isTerminalRunStatus(event.status) && !Object.values(event.strategyStatuses).every(isTerminalRunStatus))) return false;
  return Object.entries(event.strategySummaries ?? {}).every(([id, summary]) => {
    const status = event.strategyStatuses[id];
    return isTerminalRunStatus(status) && validResultState({ status, metrics: summary.metrics, diagnostics: summary.diagnostics });
  });
}
