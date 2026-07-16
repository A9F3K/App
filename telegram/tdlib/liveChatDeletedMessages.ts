/** Pending deleted message ids per user/chat — attached to chat-list payloads for open-chat UI. */

const pendingDeletes = new Map<string, Map<number, Set<number>>>();
const MAX_IDS_PER_CHAT = 200;

function chatDeleteSet(telegramUsername: string, chatId: number): Set<number> {
  let byChat = pendingDeletes.get(telegramUsername);
  if (!byChat) {
    byChat = new Map();
    pendingDeletes.set(telegramUsername, byChat);
  }
  let ids = byChat.get(chatId);
  if (!ids) {
    ids = new Set();
    byChat.set(chatId, ids);
  }
  return ids;
}

export function noteLiveChatMessageDeletes(
  telegramUsername: string,
  chatId: number,
  messageIds: number[],
): boolean {
  const ids = messageIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.trunc(id));
  if (ids.length === 0 || !Number.isFinite(chatId) || chatId === 0) return false;

  const set = chatDeleteSet(telegramUsername, chatId);
  let added = false;
  for (const id of ids) {
    if (!set.has(id)) {
      set.add(id);
      added = true;
    }
  }
  while (set.size > MAX_IDS_PER_CHAT) {
    const first = set.values().next().value;
    if (first == null) break;
    set.delete(first);
  }
  return added;
}

export function peekLiveChatMessageDeletes(
  telegramUsername: string,
  chatId: number,
): number[] {
  const set = pendingDeletes.get(telegramUsername)?.get(chatId);
  if (!set || set.size === 0) return [];
  return [...set];
}

export function clearLiveChatMessageDeletes(
  telegramUsername: string,
  chatId?: number,
): void {
  if (chatId == null) {
    pendingDeletes.delete(telegramUsername);
    return;
  }
  pendingDeletes.get(telegramUsername)?.delete(chatId);
}
