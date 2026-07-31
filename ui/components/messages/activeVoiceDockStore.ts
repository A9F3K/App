/**
 * Cross-panel dock for an active voice call while the messages column is hidden
 * (Swap / Trade / …). MessageChatVoiceBar publishes; HomeAuthenticatedScreen paints.
 */

export type ActiveVoiceDockSnapshot = {
  chatId: number;
  title: string;
  participantCount: number;
  micActive: boolean;
  onOpen: () => void;
  onLeave: () => void;
};

type Listener = () => void;

let snapshot: ActiveVoiceDockSnapshot | null = null;
const listeners = new Set<Listener>();

export function getActiveVoiceDock(): ActiveVoiceDockSnapshot | null {
  return snapshot;
}

export function setActiveVoiceDock(next: ActiveVoiceDockSnapshot | null): void {
  const prev = snapshot;
  if (prev === next) return;
  if (
    prev &&
    next &&
    prev.chatId === next.chatId &&
    prev.title === next.title &&
    prev.participantCount === next.participantCount &&
    prev.micActive === next.micActive &&
    prev.onOpen === next.onOpen &&
    prev.onLeave === next.onLeave
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // ignore
    }
  }
}

export function subscribeActiveVoiceDock(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
