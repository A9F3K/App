/** Pub/sub for Feed nav unread badge (synced from `/api/feed`). */

let feedUnreadCount = 0;
const listeners = new Set<() => void>();

export function getFeedUnreadCount(): number {
  return feedUnreadCount;
}

export function setFeedUnreadCount(count: number): void {
  const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (next === feedUnreadCount) return;
  feedUnreadCount = next;
  for (const listener of listeners) listener();
}

export function subscribeFeedUnreadCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatFeedUnreadCountLabel(count: number, maxDisplay = 99): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  if (count > maxDisplay) return `${maxDisplay}+`;
  return String(Math.floor(count));
}
