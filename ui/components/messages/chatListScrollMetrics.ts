/** Scroll metrics for the home left column (chat list lives inside {@link HspScrollColumn}). */
export type ChatListScrollMetrics = {
  scrollY: number;
  layoutH: number;
};

let currentMetrics: ChatListScrollMetrics = { scrollY: 0, layoutH: 0 };
const listeners = new Set<() => void>();

export function setChatListScrollMetrics(metrics: ChatListScrollMetrics): void {
  if (
    currentMetrics.scrollY === metrics.scrollY &&
    currentMetrics.layoutH === metrics.layoutH
  ) {
    return;
  }
  currentMetrics = metrics;
  for (const listener of listeners) {
    listener();
  }
}

export function getChatListScrollMetrics(): ChatListScrollMetrics {
  return currentMetrics;
}

export function subscribeChatListScrollMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
