type Listener = () => void;

let refreshNonce = 0;
const listeners = new Set<Listener>();

/** Bump when built-in wallet balances should be re-fetched (e.g. after Get top-up). */
export function bumpWalletBalanceRefresh(): void {
  refreshNonce += 1;
  for (const listener of listeners) {
    listener();
  }
}

export function getWalletBalanceRefreshNonce(): number {
  return refreshNonce;
}

export function subscribeWalletBalanceRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Poll built-in wallet balances for a short window after an external wallet action. */
export function scheduleWalletBalanceRefreshBurst(delaysMs: readonly number[] = [2_000, 8_000, 20_000, 45_000]): void {
  for (const delayMs of delaysMs) {
    setTimeout(() => bumpWalletBalanceRefresh(), delayMs);
  }
}
