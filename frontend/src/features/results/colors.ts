const RESULT_COLORS = [
  "#147d68",
  "#ba6816",
  "#7656a6",
  "#c47a1f",
  "#a7373a",
  "#0c879b",
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
