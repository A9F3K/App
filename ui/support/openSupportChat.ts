/** Fire-and-forget open of the AI-column Support tab (from Pro payment, etc.). */
type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeOpenSupportChat(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestOpenSupportChat(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}
