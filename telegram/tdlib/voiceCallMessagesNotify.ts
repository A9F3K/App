import type { VoiceCallMessageRow } from "./voiceCallMessages.js";

type VoiceCallMessageListener = (
  revision: number,
  message: VoiceCallMessageRow,
) => void;

const listenersByCall = new Map<number, Set<VoiceCallMessageListener>>();

export function onVoiceCallMessage(
  groupCallId: number,
  listener: VoiceCallMessageListener,
): () => void {
  const callId = Math.trunc(groupCallId);
  let set = listenersByCall.get(callId);
  if (!set) {
    set = new Set();
    listenersByCall.set(callId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      listenersByCall.delete(callId);
    }
  };
}

export function emitVoiceCallMessage(
  groupCallId: number,
  revision: number,
  message: VoiceCallMessageRow,
): void {
  const callId = Math.trunc(groupCallId);
  if (!Number.isFinite(callId) || callId <= 0) return;
  const set = listenersByCall.get(callId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(revision, message);
    } catch {
      /* subscriber error must not break ingest */
    }
  }
}
