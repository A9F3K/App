type VoiceRevisionListener = (revision: number) => void;

const listenersByCall = new Map<number, Set<VoiceRevisionListener>>();
const pendingRevisionByCall = new Map<number, number>();
const emitTimerByCall = new Map<number, ReturnType<typeof setTimeout>>();
/** Full `loadGroupCallParticipants` passes — hold SSE until one flush at the end. */
const quietLoadCalls = new Set<number>();

/** Coalesce roster churn lightly; speaking=true always flushes immediately. */
const EMIT_DEBOUNCE_MS = 100;

/** Suppress SSE spam while TDLib floods participant updates during a full load. */
export function beginVoiceParticipantsQuietLoad(groupCallId: number): void {
  const callId = Math.trunc(groupCallId);
  if (!Number.isFinite(callId) || callId <= 0) return;
  quietLoadCalls.add(callId);
}

/** End quiet mode and push the latest pending revision once. */
export function endVoiceParticipantsQuietLoad(groupCallId: number): void {
  const callId = Math.trunc(groupCallId);
  if (!Number.isFinite(callId) || callId <= 0) return;
  quietLoadCalls.delete(callId);
  flushPendingRevision(callId);
}

function flushPendingRevision(groupCallId: number): void {
  const timer = emitTimerByCall.get(groupCallId);
  if (timer) clearTimeout(timer);
  emitTimerByCall.delete(groupCallId);
  const revision = pendingRevisionByCall.get(groupCallId);
  pendingRevisionByCall.delete(groupCallId);
  if (revision == null) return;

  const set = listenersByCall.get(groupCallId);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(revision);
    } catch {
      /* subscriber error must not break ingest */
    }
  }
}

export function onVoiceParticipantsRevision(
  groupCallId: number,
  listener: VoiceRevisionListener,
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

/**
 * Push roster revision to SSE subscribers.
 * `immediate` — flush now (speaking=true pulses are too short to debounce).
 */
export function emitVoiceParticipantsRevision(
  groupCallId: number,
  revision: number,
  options?: { immediate?: boolean },
): void {
  const callId = Math.trunc(groupCallId);
  if (!Number.isFinite(callId) || callId <= 0) return;
  pendingRevisionByCall.set(callId, revision);

  // Speaking pulses must still flush during a full roster load — otherwise green
  // mics freeze for the whole loadGroupCallParticipants window.
  if (options?.immediate) {
    flushPendingRevision(callId);
    return;
  }

  // Hold non-speaking roster churn until quiet load ends (one snapshot).
  if (quietLoadCalls.has(callId)) return;

  if (emitTimerByCall.has(callId)) return;

  const timer = setTimeout(() => {
    flushPendingRevision(callId);
  }, EMIT_DEBOUNCE_MS);
  emitTimerByCall.set(callId, timer);
}
