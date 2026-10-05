/** Expand validated unsigned digits at a decimal point, retaining all zeros. */
export function expandDecimalDigits(digits: string, point: number): string {
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}
