import { compareDecimals, isNumericSearchValue } from "../../api/contractReader";
import type { TradingCosts } from "../../api/generated";

export const TRADING_COST_FIELDS = ["commission", "slippageCost", "spreadCost", "capitalGainsTax", "totalTradingCost"] as const satisfies readonly (keyof TradingCosts)[];

export function hasOnlyZeroCosts(costs?: TradingCosts | null): boolean {
  return Boolean(costs && TRADING_COST_FIELDS.every(key => isNumericSearchValue(costs[key]) && compareDecimals(costs[key], 0) === 0));
}
