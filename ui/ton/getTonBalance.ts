const TONAPI = "https://tonapi.io/v2";

/** Nanoton → TON number (lossy float for display only). */
export function fromNanoTon(nano: string | number): number {
  const n = typeof nano === "string" ? BigInt(nano) : BigInt(Math.trunc(nano));
  return Number(n) / 1e9;
}

/** Native TON (GRAM) balance for a friendly / raw address via tonapi.io. */
export async function getTonBalance(address: string): Promise<number> {
  const trimmed = address.trim();
  if (!trimmed) return 0;
  const res = await fetch(`${TONAPI}/accounts/${encodeURIComponent(trimmed)}`);
  if (!res.ok) return 0;
  const data = (await res.json()) as { balance?: number | string };
  return fromNanoTon(data.balance ?? 0);
}
