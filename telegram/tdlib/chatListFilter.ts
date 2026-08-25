import { specialUserForceIncludedPeerUserIds } from "../../shared/specialTelegramUsers.js";
import {
  isChatInArchiveList,
  isChatInFolderList,
  isChatInMainList,
  isChatPinnedInMainList,
  isPrivateTdChat,
  peerUserIdFromChat,
  type TdChat,
} from "./chatPreview.js";

export type ChatListTier = "pinned" | "positioned" | "unpositioned" | "excluded";

export type ChatListFilterOptions = {
  allowSupplementaryPrivate?: boolean;
};

/** Classify a TDLib chat into list tiers (pinned → positioned → unpositioned tail). */
export function chatListTier(
  chat: TdChat,
  options?: ChatListFilterOptions,
): ChatListTier {
  if (isChatPinnedInMainList(chat)) return "pinned";
  // Main, archive, and folder-only chats belong in the flat list.
  if (isChatInMainList(chat) || isChatInArchiveList(chat) || isChatInFolderList(chat)) {
    return "positioned";
  }
  const peerUserId = peerUserIdFromChat(chat);
  if (peerUserId != null && specialUserForceIncludedPeerUserIds().includes(peerUserId)) {
    return "unpositioned";
  }
  if (options?.allowSupplementaryPrivate && isPrivateTdChat(chat) && peerUserId != null) {
    return "unpositioned";
  }
  return "excluded";
}

export type ShouldIncludeChatOptions = ChatListFilterOptions & {
  /** When false, skip supplementary / forced private chats in the unpositioned tier. */
  includeUnpositioned?: boolean;
};

export function shouldIncludeChatInList(
  chat: TdChat,
  options?: ShouldIncludeChatOptions,
): boolean {
  const tier = chatListTier(chat, { allowSupplementaryPrivate: true, ...options });
  if (tier === "pinned" || tier === "positioned") return true;
  if (tier === "unpositioned") {
    if (options?.includeUnpositioned !== false) return true;
    // Special force-included peers stay in the roster even when supplementary search is off.
    const peerUserId = peerUserIdFromChat(chat);
    return peerUserId != null && specialUserForceIncludedPeerUserIds().includes(peerUserId);
  }
  return false;
}

export function filterChatsForList(
  chats: TdChat[],
  options?: ShouldIncludeChatOptions,
): TdChat[] {
  return chats.filter((chat) => shouldIncludeChatInList(chat, options));
}
