import type { ReturnValue } from "./returnTone";
/** Fixed magnitudes keep equal returns comparable across years and reports. */
export function heatmapIntensity(value: ReturnValue, annual = false): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.min(1, Math.abs(numeric) / (annual ? 0.4 : 0.1)) : 0;
}
