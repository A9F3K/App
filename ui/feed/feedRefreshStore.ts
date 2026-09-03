/** Pub/sub so Feed panel reloads after creating notifications (e.g. wallet top-up). */

let feedRefreshNonce = 0;
const listeners = new Set<() => void>();

export function getFeedRefreshNonce(): number {
  return feedRefreshNonce;
}

export function bumpFeedRefresh(): void {
  feedRefreshNonce += 1;
  for (const listener of listeners) listener();
}

export function subscribeFeedRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
