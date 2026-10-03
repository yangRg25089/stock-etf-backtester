export const PRICE_COLOR = "#9c4b0d";

const RESULT_COLORS = [
  "#30497d",
  "#a65b0f",
  "#7656a6",
  "#395cb7",
  "#a7373a",
  "#087487",
  "#8a4f9e",
  "#4d7c0f",
  "#a54e76",
  "#526b99",
  "#787016",
  "#267b49",
  "#263b6b",
  "#753e57",
  "#734f30",
  "#5e4299",
  "#365e69",
  "#9c346c",
  "#435943",
  "#655957",
  "#5d597d",
  "#605c11",
  "#7b3335",
  "#555c63",
] as const;

export function resultColor(index: number): string {
  return RESULT_COLORS[Math.max(0, index) % RESULT_COLORS.length];
}
