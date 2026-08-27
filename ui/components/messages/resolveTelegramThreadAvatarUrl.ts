import { buildApiUrl } from "../../../api/_base";
import { safeTelegramUserIdForLog } from "../../../shared/appLog";
import { TELEGRAM_THREAD_NO_AVATAR } from "../../../shared/telegramThreadConstants";
import type { MessageChatHistoryItem, MessageChatKind } from "./messageChatHistoryTypes";
import type { MessageChatRowData } from "./MessageChatRow";

function resolveStoredAvatarUrl(raw: string | null | undefined): string | null {
  if (!raw || raw === TELEGRAM_THREAD_NO_AVATAR) return null;
  if (raw.startsWith("data:")) return raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return buildApiUrl(raw.startsWith("/") ? raw : `/${raw}`);
}

function validChatIdForAvatar(id: unknown): number | null {
  const chatId = Number(id);
  if (!Number.isFinite(chatId) || chatId === 0) return null;
  return Math.trunc(chatId);
}

function avatarProxyUrl(params: { userId?: number | null; chatId?: number | null }): string | null {
  const query = new URLSearchParams();
  const chatId = validChatIdForAvatar(params.chatId);
  const userId = safeTelegramUserIdForLog(params.userId);
  // Prefer user_id alone so the API never falls back to an unrelated chat photo
  // (voice group / channel) when the peer profile is still cold in TDLib.
  if (userId != null) {
    query.set("user_id", String(userId));
    // Private peer chats use chat_id === user_id; keep that for the safe fallback.
    if (chatId != null && chatId === userId) {
      query.set("chat_id", String(chatId));
    }
  } else if (chatId != null) {
    query.set("chat_id", String(chatId));
  }
  if (!query.toString()) return null;
  return buildApiUrl(`/api/telegram-messages-avatar?${query.toString()}`);
}

/** Avatar for a chat list row or an open-thread message bubble. */
export function resolveTelegramThreadAvatarUrl(
  chat: MessageChatRowData,
  item?: Pick<
    MessageChatHistoryItem,
    "sender_user_id" | "sender_chat_id" | "sender_is_channel" | "is_outgoing"
  > | null,
  chatKind?: MessageChatKind | null,
): string | null {
  const inChannelThread = chatKind === "channel";
  if (chat.avatar_url === TELEGRAM_THREAD_NO_AVATAR) {
    return null;
  }
  const storedChatAvatar = resolveStoredAvatarUrl(chat.avatar_url);

  if (inChannelThread || item?.sender_is_channel) {
    if (storedChatAvatar) return storedChatAvatar;
    return avatarProxyUrl({ chatId: chat.telegram_chat_id });
  }

  if (item) {
    const senderChatId = validChatIdForAvatar(item.sender_chat_id);
    if (senderChatId != null) {
      return avatarProxyUrl({ chatId: senderChatId });
    }

    const senderUserId = safeTelegramUserIdForLog(item.sender_user_id);
    if (senderUserId != null) {
      return avatarProxyUrl({ userId: senderUserId, chatId: validChatIdForAvatar(item.sender_chat_id) });
    }

    if (item.is_outgoing) {
      return null;
    }
  }

  if (storedChatAvatar) return storedChatAvatar;

  const peerUserId = safeTelegramUserIdForLog(chat.peer_user_id);
  if (peerUserId != null) {
    return avatarProxyUrl({ chatId: chat.telegram_chat_id, userId: peerUserId });
  }

  return avatarProxyUrl({ chatId: chat.telegram_chat_id });
}
