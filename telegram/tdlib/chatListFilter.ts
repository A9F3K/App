import { specialUserForceIncludedPeerUserIds } from "../../shared/specialTelegramUsers.js";
import { isChatInMainList, isPrivateTdChat, peerUserIdFromChat, type TdChat } from "./chatPreview.js";

export function shouldIncludeChatInList(
  chat: TdChat,
  options?: { allowSupplementaryPrivate?: boolean },
): boolean {
  if (isChatInMainList(chat)) return true;
  // getChat right after getChats(main) often returns before positions are populated.
  const positions = chat.positions;
  if (!Array.isArray(positions) || positions.length === 0) {
    return true;
  }
  const peerUserId = peerUserIdFromChat(chat);
  if (peerUserId != null && specialUserForceIncludedPeerUserIds().includes(peerUserId)) {
    return true;
  }
  if (options?.allowSupplementaryPrivate && isPrivateTdChat(chat) && peerUserId != null) {
    return true;
  }
  return false;
}

export function filterChatsForList(
  chats: TdChat[],
  options?: { allowSupplementaryPrivate?: boolean },
): TdChat[] {
  return chats.filter((chat) => shouldIncludeChatInList(chat, options));
}
