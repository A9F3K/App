/** Open the Pro Access tariffs dialog from anywhere (AI limit banner, etc.). */
type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeOpenProAccess(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestOpenProAccess(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}
