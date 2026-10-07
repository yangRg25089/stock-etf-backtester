import type { ReturnValue } from "./returnTone";
/** Fixed magnitudes keep equal returns comparable across years and reports. */
export function heatmapIntensity(value: ReturnValue, annual = false): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.min(1, Math.abs(numeric) / (annual ? 0.4 : 0.1)) : 0;
}

export function heatmapCellColor(channels: string, intensity: number, lightnessStart: number, lightnessRange: number): string {
  const boundedIntensity = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0;
  const lightness = Math.max(0, Math.min(100, lightnessStart + boundedIntensity * lightnessRange));
  return `hsl(${channels} ${Number(lightness.toFixed(3))}%)`;
}
