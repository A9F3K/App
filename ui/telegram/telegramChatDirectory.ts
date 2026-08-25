import type { MessageChatRowData } from "../components/messages/MessageChatRow";

/** Latest chat list snapshot for in-app @username / t.me link resolution. */
let chatsByTelegramId = new Map<number, MessageChatRowData>();
let chatsByUsername = new Map<string, MessageChatRowData>();

function normalizeUsername(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().replace(/^@+/, "").toLowerCase();
  return clean && /^[a-z0-9_]{3,}$/.test(clean) ? clean : null;
}

function indexChat(chat: MessageChatRowData): void {
  const id = Number(chat.telegram_chat_id);
  if (!Number.isFinite(id) || id === 0) return;
  chatsByTelegramId.set(id, chat);
  const peer = normalizeUsername(chat.peer_username);
  const chatUser = normalizeUsername(chat.chat_username);
  if (peer) chatsByUsername.set(peer, chat);
  if (chatUser) chatsByUsername.set(chatUser, chat);
}

/** Replace the directory from the live messages chat list. */
export function publishTelegramChatDirectory(rows: MessageChatRowData[]): void {
  const nextById = new Map<number, MessageChatRowData>();
  const nextByUser = new Map<string, MessageChatRowData>();
  for (const row of rows) {
    const id = Number(row.telegram_chat_id);
    if (!Number.isFinite(id) || id === 0) continue;
    nextById.set(id, row);
    const peer = normalizeUsername(row.peer_username);
    const chatUser = normalizeUsername(row.chat_username);
    if (peer) nextByUser.set(peer, row);
    if (chatUser) nextByUser.set(chatUser, row);
  }
  chatsByTelegramId = nextById;
  chatsByUsername = nextByUser;
}

/** Merge/upsert one chat (e.g. after resolve) without wiping the list. */
export function upsertTelegramChatDirectoryEntry(chat: MessageChatRowData): void {
  indexChat(chat);
}

export function findTelegramChatByUsername(username: string): MessageChatRowData | null {
  const key = normalizeUsername(username);
  if (!key) return null;
  return chatsByUsername.get(key) ?? null;
}

export function findTelegramChatById(telegramChatId: number): MessageChatRowData | null {
  const id = Math.trunc(Number(telegramChatId));
  if (!Number.isFinite(id) || id === 0) return null;
  return chatsByTelegramId.get(id) ?? null;
}
