export type ChatListSyncStatus = {
  inProgress: boolean;
  cachedCount: number;
};

let currentStatus: ChatListSyncStatus | null = null;
const listeners = new Set<() => void>();

export function setChatListSyncStatus(status: ChatListSyncStatus | null): void {
  currentStatus = status;
  for (const listener of listeners) {
    listener();
  }
}

export function getChatListSyncStatus(): ChatListSyncStatus | null {
  return currentStatus;
}

export function isChatListSyncInProgress(): boolean {
  return currentStatus?.inProgress === true;
}

export function subscribeChatListSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
