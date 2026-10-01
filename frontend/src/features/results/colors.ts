const RESULT_COLORS = [
  "#147d68",
  "#a65b0f",
  "#7656a6",
  "#9b6210",
  "#a7373a",
  "#087487",
  "#8a4f9e",
  "#4d7c0f",
  "#a54e76",
  "#526b99",
  "#787016",
  "#267b49",
] as const;

export function resultColor(index: number): string {
  return RESULT_COLORS[Math.max(0, index) % RESULT_COLORS.length];
}
