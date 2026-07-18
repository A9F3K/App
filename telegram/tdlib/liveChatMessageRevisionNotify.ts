type MessageRevisionListener = (revision: number) => void;

type ChatKey = string;

const listenersByChat = new Map<ChatKey, Set<MessageRevisionListener>>();
const pendingRevisionByChat = new Map<ChatKey, number>();
const emitTimerByChat = new Map<ChatKey, ReturnType<typeof setTimeout>>();
const revisionByChat = new Map<ChatKey, number>();

/** Messages persist — coalesce bursts (edits/deletes) lightly. */
const EMIT_DEBOUNCE_MS = 150;

function chatKey(telegramUsername: string, chatId: number): ChatKey {
  return `${telegramUsername.trim().toLowerCase()}:${Math.trunc(chatId)}`;
}

function flushPendingRevision(key: ChatKey): void {
  emitTimerByChat.delete(key);
  const revision = pendingRevisionByChat.get(key);
  pendingRevisionByChat.delete(key);
  if (revision == null) return;

  const set = listenersByChat.get(key);
  if (!set || set.size === 0) return;
  for (const listener of set) {
    try {
      listener(revision);
    } catch {
      /* subscriber error must not break cache updates */
    }
  }
}

export function getLiveChatMessageRevision(
  telegramUsername: string,
  chatId: number,
): number {
  return revisionByChat.get(chatKey(telegramUsername, chatId)) ?? 0;
}

export function onLiveChatMessageRevision(
  telegramUsername: string,
  chatId: number,
  listener: MessageRevisionListener,
): () => void {
  const key = chatKey(telegramUsername, chatId);
  let set = listenersByChat.get(key);
  if (!set) {
    set = new Set();
    listenersByChat.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      listenersByChat.delete(key);
    }
  };
}

/** Bump per-chat history revision and notify SSE subscribers. */
export function bumpLiveChatMessageRevision(
  telegramUsername: string,
  chatId: number,
): number {
  const key = chatKey(telegramUsername, chatId);
  if (!telegramUsername.trim() || !Number.isFinite(chatId) || chatId === 0) {
    return revisionByChat.get(key) ?? 0;
  }
  const next = (revisionByChat.get(key) ?? 0) + 1;
  revisionByChat.set(key, next);
  pendingRevisionByChat.set(key, next);
  if (emitTimerByChat.has(key)) return next;

  const timer = setTimeout(() => {
    flushPendingRevision(key);
  }, EMIT_DEBOUNCE_MS);
  emitTimerByChat.set(key, timer);
  return next;
}

export function clearLiveChatMessageRevisions(telegramUsername: string): void {
  const prefix = `${telegramUsername.trim().toLowerCase()}:`;
  for (const key of [...revisionByChat.keys()]) {
    if (!key.startsWith(prefix)) continue;
    revisionByChat.delete(key);
    pendingRevisionByChat.delete(key);
    const timer = emitTimerByChat.get(key);
    if (timer) {
      clearTimeout(timer);
      emitTimerByChat.delete(key);
    }
  }
}
