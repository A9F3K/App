import type { AppLocale } from "../../locales/appStrings";

export function formatSwapUsdCompact(
  value: number | null | undefined,
  locale: AppLocale = "en",
): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  const abs = Math.abs(value);

  if (locale === "ru") {
    if (abs >= 1e12) {
      const scaled = value / 1e12;
      const label = Number.isInteger(scaled) ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
      return `${label} трлн. $ +`;
    }
    if (abs >= 1e9) return `${Math.round(value / 1e9)} млрд. $ +`;
    if (abs >= 1e6) return `${Math.round(value / 1e6)} млн. $ +`;
    if (abs >= 1e3) return `${Math.round(value / 1e3)} тыс. $ +`;
    return `${value.toFixed(2)} $`;
  }

  if (abs >= 1e12) {
    const scaled = value / 1e12;
    const label = Number.isInteger(scaled) ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${label}T$+`;
  }
  if (abs >= 1e9) return `${Math.round(value / 1e9)}b$+`;
  if (abs >= 1e6) return `${Math.round(value / 1e6)}m$`;
  if (abs >= 1e3) return `${Math.round(value / 1e3)}k$`;
  return `${value.toFixed(2)}$`;
}

export function formatSwapTokenPriceUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  if (value >= 0.000001) {
    const fracDigits = Math.min(10, Math.max(4, Math.ceil(-Math.log10(value)) + 1));
    const trimmed = value
      .toFixed(fracDigits)
      .replace(/(\.\d*?)0+$/, "$1")
      .replace(/\.$/, "");
    return `$${trimmed}`;
  }
  return `$${value.toExponential(2)}`;
}

export function formatSwapJettonBalance(balanceRaw: string, decimals: number): string {
  try {
    const raw = BigInt(balanceRaw);
    if (raw === 0n) return "0";
    const scale = 10n ** BigInt(Math.max(0, decimals));
    const whole = raw / scale;
    const frac = raw % scale;
    if (frac === 0n) return whole.toString();

    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (!fracStr) return whole.toString();
    const combined = `${whole}.${fracStr}`;
    const asNum = Number(combined);
    if (Number.isFinite(asNum)) {
      if (asNum >= 1_000_000) return `${Math.round(asNum).toLocaleString()}`;
      if (asNum >= 1) return asNum.toLocaleString(undefined, { maximumFractionDigits: 4 });
      return asNum.toPrecision(4);
    }
    return combined;
  } catch {
    return "—";
  }
}
