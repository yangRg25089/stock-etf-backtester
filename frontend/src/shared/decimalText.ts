/** Expand validated unsigned digits at a decimal point, retaining all zeros. */
export function expandDecimalDigits(digits: string, point: number): string {
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + "0".repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function isNumericSearchValue(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)
    || !Number.isFinite(Number(value))) return false;
  const [coefficient, exponent = "0"] = value.split(/[eE]/);
  const fractionalPlaces = coefficient.split(".")[1]?.length ?? 0;
  return Math.abs(Number(exponent) - fractionalPlaces) <= 4096;
}

/** Compare saved decimal values without rounding them through a JS float. */
export function decimalIdentity(value: string | number): string {
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.replace(/^[+-]/, "").split(".");
  const raw = (whole + fraction).replace(/^0+/, "");
  const digits = raw.replace(/0+$/, "");
  return digits ? `${coefficient.startsWith("-") ? "-" : ""}${digits}e${Number(exponent) - fraction.length + raw.length - digits.length}` : "0";
}

export function compareDecimals(left: string | number, right: string | number): number {
  const parts = (value: string | number) => {
    const identity = decimalIdentity(value);
    const [digits, exponent = "0"] = identity.replace(/^-/, "").split("e");
    return { digits, order: digits.length + Number(exponent), sign: identity === "0" ? 0 : identity.startsWith("-") ? -1 : 1 };
  };
  const a = parts(left), b = parts(right);
  if (a.sign !== b.sign) return a.sign - b.sign;
  if (!a.sign) return 0;
  if (a.order !== b.order) return Math.sign(a.order - b.order) * a.sign;
  const length = Math.max(a.digits.length, b.digits.length);
  const x = a.digits.padEnd(length, "0"), y = b.digits.padEnd(length, "0");
  return (x === y ? 0 : x < y ? -1 : 1) * a.sign;
}
