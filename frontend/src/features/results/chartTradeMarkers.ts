import type { Trade } from "../../api/generated";

interface MarkerPoint { date: string; x: number; y: number }

export function tradeMarkerPoints(trades: Trade[], points: MarkerPoint[]) {
  const byDate = new Map(points.map(point => [point.date, point]));
  return trades.flatMap((trade, index) => {
    const point = byDate.get(trade.date);
    const price = Number(trade.price);
    if (!point || trade.price === "" || !Number.isFinite(price)) return [];
    const { x, y } = point;
    const direction = trade.side === "buy" ? 1 : -1;
    return [{
      trade, index, price,
      coordinates: `${x},${y + direction * 7} ${x - 3},${y - direction * 4} ${x + 3},${y - direction * 4}`,
    }];
  });
}
