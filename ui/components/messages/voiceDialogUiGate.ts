/**
 * Module-level gate so chat-list SSE / heavy home updates can defer while the
 * voice sheet is open or a join is arming — without wiring React context
 * through the whole tree. Docked/joined strip alone must not hold this open.
 */

let voiceDialogOpen = false;
const listeners = new Set<(open: boolean) => void>();

function syncVoiceDialogDocumentFlag(open: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (open) root.setAttribute("data-hsp-voice-dialog", "1");
  else root.removeAttribute("data-hsp-voice-dialog");
}

export function setVoiceDialogUiOpen(open: boolean): void {
  if (voiceDialogOpen === open) return;
  voiceDialogOpen = open;
  syncVoiceDialogDocumentFlag(open);
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
