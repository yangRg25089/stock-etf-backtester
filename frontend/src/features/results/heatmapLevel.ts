import type { ReturnValue } from "./returnTone";
/** Fixed absolute return thresholds keep colors comparable across years and reports. */
export function heatmapLevel(value: ReturnValue, annual = false): number {
  const numeric = Number(value ?? 0);
  const magnitude = Math.abs(numeric);
  if (!Number.isFinite(magnitude) || magnitude === 0) return 0;
  const scale = annual ? 4 : 1;
  if (magnitude < 0.03 * scale) return 1;
  if (magnitude < 0.08 * scale) return 2;
  if (magnitude < 0.15 * scale) return 3;
  return 4;
}
