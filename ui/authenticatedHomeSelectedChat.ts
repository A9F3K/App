import { useSyncExternalStore } from "react";
import type { MessageChatRowData } from "./components/messages/MessageChatRow";

const STORAGE_KEY = "hyperlinks_authenticated_home_selected_chat_v1";

export type AuthenticatedHomeHistoryLoadTarget = {
  chatId: number | null;
  generation: number;
};

const HISTORY_LOAD_SNAPSHOT_IDLE: AuthenticatedHomeHistoryLoadTarget = {
  chatId: null,
  generation: 0,
};

function readStoredChat(): MessageChatRowData | null {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const raw = (globalThis as unknown as { localStorage: Storage }).localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const row = parsed as Record<string, unknown>;
      const telegramChatId = Number(row.telegram_chat_id);
      if (!Number.isFinite(telegramChatId)) return null;
      return {
        id: Number(row.id) || 0,
        telegram_chat_id: telegramChatId,
        title: typeof row.title === "string" ? row.title : "",
        subtitle: typeof row.subtitle === "string" ? row.subtitle : "",
        avatar_url: typeof row.avatar_url === "string" ? row.avatar_url : null,
        last_message_at:
          typeof row.last_message_at === "string" || typeof row.last_message_at === "number"
            ? String(row.last_message_at)
            : null,
        unread_count: Number.isFinite(Number(row.unread_count)) ? Number(row.unread_count) : 0,
        scroll_below_unread_count: (() => {
          const raw = Number(row.scroll_below_unread_count);
          return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
        })(),
        peer_user_id: Number.isFinite(Number(row.peer_user_id)) ? Number(row.peer_user_id) : null,
        peer_username:
          typeof row.peer_username === "string" && row.peer_username.trim()
            ? row.peer_username.trim().replace(/^@+/, "")
            : null,
        chat_username:
          typeof row.chat_username === "string" && row.chat_username.trim()
            ? row.chat_username.trim().replace(/^@+/, "")
            : null,
        chat_kind:
          row.chat_kind === "private" ||
          row.chat_kind === "group" ||
          row.chat_kind === "supergroup" ||
          row.chat_kind === "channel"
            ? row.chat_kind
            : null,
        member_count: (() => {
          const raw = Number(row.member_count);
          return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
        })(),
        presence_kind:
          row.presence_kind === "online" ||
          row.presence_kind === "recently" ||
          row.presence_kind === "last_week" ||
          row.presence_kind === "last_month" ||
          row.presence_kind === "offline"
            ? row.presence_kind
            : null,
        presence_at:
          typeof row.presence_at === "string" || typeof row.presence_at === "number"
            ? String(row.presence_at)
            : null,
        chat_action:
          row.chat_action === "typing" ||
          row.chat_action === "recording_voice" ||
          row.chat_action === "recording_video" ||
          row.chat_action === "uploading_photo" ||
          row.chat_action === "uploading_video" ||
          row.chat_action === "uploading_file"
            ? row.chat_action
            : null,
        chat_action_user_id: Number.isFinite(Number(row.chat_action_user_id))
          ? Number(row.chat_action_user_id)
          : null,
        chat_action_user_name:
          typeof row.chat_action_user_name === "string" ? row.chat_action_user_name : null,
        chat_action_expires_at:
          typeof row.chat_action_expires_at === "string" ||
          typeof row.chat_action_expires_at === "number"
            ? String(row.chat_action_expires_at)
            : null,
        last_read_outbox_message_id: (() => {
          const raw = Number(row.last_read_outbox_message_id);
          return Number.isFinite(raw) && raw > 0 ? raw : null;
        })(),
        peer_emoji_status_custom_emoji_id:
          typeof row.peer_emoji_status_custom_emoji_id === "string" &&
          row.peer_emoji_status_custom_emoji_id.trim()
            ? row.peer_emoji_status_custom_emoji_id.trim()
            : null,
        subtitle_segments: Array.isArray(row.subtitle_segments)
          ? (row.subtitle_segments as MessageChatRowData["subtitle_segments"])
          : null,
        is_pinned: Boolean(row.is_pinned),
      };
    }
  } catch {
    /* private mode / SSR / corrupt storage */
  }
  return null;
}

function writeStoredChat(chat: MessageChatRowData | null): void {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis) {
      const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
      if (chat == null) ls.removeItem(STORAGE_KEY);
      else ls.setItem(STORAGE_KEY, JSON.stringify(chat));
    }
  } catch {
    /* ignore */
  }
}

let selectedChat: MessageChatRowData | null = null;
/** When false, poll may increase open-chat unread (new messages) but not overwrite scroll-based decreases. */
let openChatFollowingBottom = true;
/** Which pane occupies the wide middle column: message thread vs header menu panel. */
let middleColumnFocus: "chat" | "headerPanel" = "headerPanel";
/** Persisted: restore the opened chat and resume its history on reload. */
let historyLoadChatId: number | null = null;
let historyLoadGeneration = 0;
let historyLoadSnapshot: AuthenticatedHomeHistoryLoadTarget = HISTORY_LOAD_SNAPSHOT_IDLE;
let hydratedFromStorage = false;
const listeners = new Set<() => void>();

function syncHistoryLoadSnapshot(): AuthenticatedHomeHistoryLoadTarget {
  const chatId = historyLoadChatId;
  const generation = historyLoadGeneration;
  if (
    historyLoadSnapshot.chatId !== chatId ||
    historyLoadSnapshot.generation !== generation
  ) {
    historyLoadSnapshot = { chatId, generation };
  }
  return historyLoadSnapshot;
}

function hydrateFromStorageIfNeeded() {
  if (hydratedFromStorage) return;
  hydratedFromStorage = true;
  selectedChat = readStoredChat();
  if (selectedChat && historyLoadGeneration === 0) {
    historyLoadChatId = selectedChat.telegram_chat_id;
    historyLoadGeneration = 1;
    middleColumnFocus = "chat";
    syncHistoryLoadSnapshot();
    void import("./messageChatHistoryCache").then(({ warmChatHistoryCacheFromSession }) => {
      warmChatHistoryCacheFromSession(selectedChat!.telegram_chat_id);
    });
    void import("./messageChatHistoryPrefetch").then(({ prefetchChatHistoryPriority }) => {
      prefetchChatHistoryPriority(selectedChat!);
    });
  }
}

function emit() {
  for (const l of listeners) {
    l();
  }
}

export function selectAuthenticatedHomeChat(chat: MessageChatRowData | null) {
  hydrateFromStorageIfNeeded();
  if (chat == null) {
    historyLoadChatId = null;
    syncHistoryLoadSnapshot();
    selectedChat = null;
    writeStoredChat(null);
    emit();
    return;
  }
  if (
    selectedChat?.telegram_chat_id === chat.telegram_chat_id &&
    selectedChat.title === chat.title &&
    selectedChat.subtitle === chat.subtitle &&
    selectedChat.last_message_at === chat.last_message_at &&
    selectedChat.presence_kind === chat.presence_kind &&
    selectedChat.presence_at === chat.presence_at &&
    selectedChat.chat_action === chat.chat_action &&
    selectedChat.chat_action_user_id === chat.chat_action_user_id &&
    selectedChat.chat_action_user_name === chat.chat_action_user_name &&
    selectedChat.chat_action_expires_at === chat.chat_action_expires_at &&
    selectedChat.last_read_outbox_message_id === chat.last_read_outbox_message_id
  ) {
    return;
  }
  selectedChat = chat;
  writeStoredChat(chat);
  emit();
}

/** Select chat and start (or restart) paginated history load for that chat. */
export function openAuthenticatedHomeChatHistory(chat: MessageChatRowData) {
  hydrateFromStorageIfNeeded();
  selectedChat = chat;
  middleColumnFocus = "chat";
  writeStoredChat(chat);
  historyLoadChatId = chat.telegram_chat_id;
  historyLoadGeneration += 1;
  syncHistoryLoadSnapshot();
  emit();
}

/** Show header menu panels (swap/smart/…) in the wide middle column. */
export function focusAuthenticatedHomeMiddleColumnOnHeaderPanel() {
  hydrateFromStorageIfNeeded();
  if (middleColumnFocus === "headerPanel") return;
  middleColumnFocus = "headerPanel";
  emit();
}

export function clearAuthenticatedHomeSelectedChat() {
  historyLoadChatId = null;
  selectAuthenticatedHomeChat(null);
}

function getSnapshot() {
  hydrateFromStorageIfNeeded();
  return selectedChat;
}

function getServerSnapshot() {
  return null as MessageChatRowData | null;
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function getAuthenticatedHomeSelectedChatSnapshot(): MessageChatRowData | null {
  hydrateFromStorageIfNeeded();
  return selectedChat;
}

export function useAuthenticatedHomeSelectedChat(): MessageChatRowData | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function getMiddleColumnFocusSnapshot(): "chat" | "headerPanel" {
  hydrateFromStorageIfNeeded();
  return middleColumnFocus;
}

function getMiddleColumnFocusServerSnapshot(): "chat" | "headerPanel" {
  return "headerPanel";
}

export function useAuthenticatedHomeMiddleColumnFocus(): "chat" | "headerPanel" {
  return useSyncExternalStore(
    subscribe,
    getMiddleColumnFocusSnapshot,
    getMiddleColumnFocusServerSnapshot,
  );
}

function getHistoryLoadSnapshot(): AuthenticatedHomeHistoryLoadTarget {
  hydrateFromStorageIfNeeded();
  return syncHistoryLoadSnapshot();
}

function getHistoryLoadServerSnapshot(): AuthenticatedHomeHistoryLoadTarget {
  return HISTORY_LOAD_SNAPSHOT_IDLE;
}

/** Resumes from storage on reload and increments on explicit chat clicks. */
export function useAuthenticatedHomeHistoryLoadTarget(): AuthenticatedHomeHistoryLoadTarget {
  return useSyncExternalStore(
    subscribe,
    getHistoryLoadSnapshot,
    getHistoryLoadServerSnapshot,
  );
}

/** Refresh open chat header meta after history load or live list sync. */
export function patchAuthenticatedHomeSelectedChatGroupMeta(
  chatId: number,
  meta: {
    chat_kind?: MessageChatRowData["chat_kind"];
    member_count?: number | null;
  },
): void {
  hydrateFromStorageIfNeeded();
  if (selectedChat?.telegram_chat_id !== chatId) return;
  const next: MessageChatRowData = { ...selectedChat };
  if (meta.chat_kind !== undefined) {
    next.chat_kind = meta.chat_kind;
    if (
      meta.chat_kind === "group" ||
      meta.chat_kind === "supergroup" ||
      meta.chat_kind === "channel"
    ) {
      next.presence_kind = null;
      next.presence_at = null;
    }
  }
  if (meta.member_count !== undefined) next.member_count = meta.member_count;
  selectedChat = next;
  writeStoredChat(selectedChat);
  emit();
}

/** Keep read-receipt cursor in sync after history loads or live updates. */
export function patchAuthenticatedHomeSelectedChatReadOutbox(messageId: number | null | undefined) {
  hydrateFromStorageIfNeeded();
  const id = Number(messageId);
  if (!Number.isFinite(id) || id <= 0 || selectedChat == null) return;
  const prev = selectedChat.last_read_outbox_message_id;
  if (prev != null && prev >= id) return;
  selectedChat = { ...selectedChat, last_read_outbox_message_id: id };
  writeStoredChat(selectedChat);
  emit();
}

/**
 * Chat-list unread for the open chat: poll may only raise the count (new messages);
 * client scroll marking may lower it until the server catches up.
 */
export function resolveAuthenticatedHomeOpenChatUnread(
  incomingUnread: number,
  chatId: number,
): number {
  hydrateFromStorageIfNeeded();
  const incoming = Math.max(0, Math.trunc(incomingUnread));
  if (selectedChat == null || selectedChat.telegram_chat_id !== chatId) {
    return incoming;
  }
  return incoming > selectedChat.unread_count
    ? incoming
    : selectedChat.unread_count;
}

/** Open-chat unread badge — shared by the chat list preview and scroll-to-bottom FAB. */
export function patchAuthenticatedHomeSelectedChatUnread(count: number): void {
  hydrateFromStorageIfNeeded();
  if (selectedChat == null) return;
  const next = Math.max(0, Math.trunc(count));
  if (selectedChat.unread_count === next) return;
  selectedChat = { ...selectedChat, unread_count: next };
  writeStoredChat(selectedChat);
  emit();
}

export function bumpAuthenticatedHomeSelectedChatUnread(delta: number): void {
  if (!Number.isFinite(delta) || delta <= 0) return;
  hydrateFromStorageIfNeeded();
  if (selectedChat == null) return;
  patchAuthenticatedHomeSelectedChatUnread(selectedChat.unread_count + Math.trunc(delta));
}

/** Open message column is pinned to the latest messages (clears unread on sync). */
export function setAuthenticatedHomeOpenChatFollowingBottom(following: boolean): void {
  openChatFollowingBottom = following;
}

export function isAuthenticatedHomeOpenChatFollowingBottom(): boolean {
  return openChatFollowingBottom;
}

/** @deprecated Use {@link patchAuthenticatedHomeSelectedChatUnread}. */
export function patchAuthenticatedHomeSelectedChatScrollBelowUnread(count: number): void {
  patchAuthenticatedHomeSelectedChatUnread(count);
}

/** @deprecated Use {@link bumpAuthenticatedHomeSelectedChatUnread}. */
export function bumpAuthenticatedHomeSelectedChatScrollBelowUnread(delta: number): void {
  bumpAuthenticatedHomeSelectedChatUnread(delta);
}

/** Refresh stored selection when poll updates the same chat row. */
export function syncAuthenticatedHomeSelectedChat(chats: readonly MessageChatRowData[]) {
  hydrateFromStorageIfNeeded();
  if (selectedChat == null) return;
  const fresh = chats.find((c) => c.telegram_chat_id === selectedChat!.telegram_chat_id);
  if (!fresh) {
    // Poll responses can be partial while the gateway resyncs; keep the open chat selected.
    return;
  }
  if (
    fresh.title !== selectedChat.title ||
    fresh.subtitle !== selectedChat.subtitle ||
    fresh.last_message_at !== selectedChat.last_message_at ||
    fresh.unread_count !== selectedChat.unread_count ||
    fresh.avatar_url !== selectedChat.avatar_url ||
    fresh.peer_username !== selectedChat.peer_username ||
    fresh.chat_username !== selectedChat.chat_username ||
    fresh.peer_emoji_status_custom_emoji_id !== selectedChat.peer_emoji_status_custom_emoji_id ||
    fresh.peer_accent_color_light !== selectedChat.peer_accent_color_light ||
    fresh.peer_accent_color_dark !== selectedChat.peer_accent_color_dark ||
    fresh.chat_kind !== selectedChat.chat_kind ||
    fresh.member_count !== selectedChat.member_count ||
    fresh.presence_kind !== selectedChat.presence_kind ||
    fresh.presence_at !== selectedChat.presence_at ||
    fresh.chat_action !== selectedChat.chat_action ||
    fresh.chat_action_user_id !== selectedChat.chat_action_user_id ||
    fresh.chat_action_user_name !== selectedChat.chat_action_user_name ||
    fresh.chat_action_expires_at !== selectedChat.chat_action_expires_at ||
    fresh.last_read_outbox_message_id !== selectedChat.last_read_outbox_message_id
  ) {
    // Client-side scroll marks unreads down; poll may only raise the count (new messages).
    const resolvedUnread =
      fresh.unread_count > selectedChat.unread_count
        ? fresh.unread_count
        : selectedChat.unread_count;
    selectedChat = { ...fresh, unread_count: resolvedUnread };
    writeStoredChat(selectedChat);
    emit();
  }
}
