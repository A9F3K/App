/** Client-safe DLLR display helpers for AI consumption (mirrors server estimateOnDemandUsd). */

export function tokensToDllr(tokens: number, usdPer1kTokens: number): number {
  const t = Math.max(0, Number.isFinite(tokens) ? tokens : 0);
  const rate = usdPer1kTokens > 0 ? usdPer1kTokens : 0.002;
  return Math.round(((t / 1000) * rate) * 1e6) / 1e6;
}

export function formatDllrAmount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toFixed(4);
}
