/** Client-safe DLLR display helpers for AI consumption (mirrors server estimateOnDemandUsd). */

export function tokensToDllr(tokens: number, usdPer1kTokens: number): number {
  const t = Math.max(0, Number.isFinite(tokens) ? tokens : 0);
  const rate = usdPer1kTokens > 0 ? usdPer1kTokens : 0.002;
  return Math.round(((t / 1000) * rate) * 1e6) / 1e6;
}

export function dllrToTokens(dllr: number, usdPer1kTokens: number): number {
  const rate = usdPer1kTokens > 0 ? usdPer1kTokens : 0.002;
  const d = Number.isFinite(dllr) && dllr > 0 ? dllr : 0;
  return Math.max(1, Math.round((d / rate) * 1000));
}

/** Compact DLLR for UI — never shows dust like 0.0009. */
export function formatDllrAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n <= 0) return "0";
  if (n < 0.01) return "<0.01";
  if (n >= 100) return n.toFixed(0);
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, "");
  return n.toFixed(2).replace(/\.?0+$/, "");
}
