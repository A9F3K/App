const listeners = new Set<() => void>();
let active = false;

export function setChatListBottomLoaderActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const listener of listeners) {
    listener();
  }
}

export function isChatListBottomLoaderActive(): boolean {
  return active;
}

export function subscribeChatListBottomLoaderActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
