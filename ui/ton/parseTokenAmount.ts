/** Parse a decimal token amount string into base units (bigint). */
export function parseTokenAmountToUnits(raw: string, decimals: number): bigint | null {
  const cleaned = raw.trim().replace(/,/g, "").replace(/\s/g, "");
  if (!cleaned || !/^\d*\.?\d+$/.test(cleaned)) return null;

  const [wholePart, fracPart = ""] = cleaned.split(".");
  if (fracPart.length > decimals) return null;

  const frac = fracPart.padEnd(decimals, "0");
  const digits = `${wholePart || "0"}${frac}`.replace(/^0+/, "") || "0";

  try {
    const value = BigInt(digits);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}
