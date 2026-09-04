/** Pub/sub for total Telegram unread message count (summed across all chats). */

let totalUnread = 0;
const listeners = new Set<() => void>();

export function getTelegramTotalUnread(): number {
  return totalUnread;
}

export function setTelegramTotalUnread(count: number): void {
  const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (next === totalUnread) return;
  totalUnread = next;
  for (const listener of listeners) listener();
}

export function subscribeTelegramTotalUnread(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Format large counts like Telegram: 1K, 10.4M, etc. */
export function formatTelegramUnreadLabel(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count < 1_000) return String(Math.floor(count));
  if (count < 1_000_000) {
    const k = count / 1_000;
    return k >= 10 ? `${Math.floor(k)}K` : `${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  const m = count / 1_000_000;
  return m >= 10 ? `${Math.floor(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
}
