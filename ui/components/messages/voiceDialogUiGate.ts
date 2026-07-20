/**
 * Module-level gate so chat-list SSE / heavy home updates can defer while the
 * voice dialog is open — without wiring React context through the whole tree.
 */

let voiceDialogOpen = false;
const listeners = new Set<(open: boolean) => void>();

export function setVoiceDialogUiOpen(open: boolean): void {
  if (voiceDialogOpen === open) return;
  voiceDialogOpen = open;
  for (const listener of listeners) {
    try {
      listener(open);
    } catch {
      // ignore
    }
  }
}

export function isVoiceDialogUiOpen(): boolean {
  return voiceDialogOpen;
}

export function subscribeVoiceDialogUiOpen(
  listener: (open: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
