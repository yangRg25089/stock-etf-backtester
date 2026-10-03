import type { Diagnostic } from "../../api/generated";
import type { SharedDraft } from "../config/defaults";

interface DateRange { startDate: string; endDate: string }
interface MarketDateRecovery {
  symbol: string;
  availableFrom: string;
  requested: DateRange | null;
  range: DateRange | null;
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function range(start: unknown, end: unknown): DateRange | null {
  return isoDate(start) && isoDate(end) && start <= end ? { startDate: start, endDate: end } : null;
}

export function marketDateRecovery(diagnostic: Diagnostic): MarketDateRecovery | null {
  if (diagnostic.messageKey !== "market.period_before_listing") return null;
  if (typeof diagnostic.details !== "object" || diagnostic.details === null || Array.isArray(diagnostic.details)) return null;
  const details = diagnostic.details as Record<string, unknown>;
  if (typeof details.symbol !== "string" || !isoDate(details.availableFrom)) return null;
  const suggested = range(details.suggestedStartDate, details.suggestedEndDate);
  return {
    symbol: details.symbol, availableFrom: details.availableFrom,
    requested: range(details.requestedStartDate, details.requestedEndDate),
    range: suggested && suggested.startDate >= details.availableFrom ? suggested : null,
  };
}

export function applyMarketDateRecovery(shared: SharedDraft, recovery: MarketDateRecovery): SharedDraft {
  if (!recovery.range || !recovery.requested || shared.run.symbol !== recovery.symbol ||
    shared.run.startDate !== recovery.requested.startDate || shared.run.endDate !== recovery.requested.endDate) return shared;
  return { ...shared, run: { ...shared.run, ...recovery.range } };
}
