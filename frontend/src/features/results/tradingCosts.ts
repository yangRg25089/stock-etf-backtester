import type { TradingCosts } from "../../api/generated";

export const TRADING_COST_FIELDS = ["commission", "slippageCost", "spreadCost", "capitalGainsTax", "totalTradingCost"] as const satisfies readonly (keyof TradingCosts)[];
