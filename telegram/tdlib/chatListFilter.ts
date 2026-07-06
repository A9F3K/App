import { specialUserForceIncludedPeerUserIds } from "../../shared/specialTelegramUsers.js";
import {
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
  if (isChatInMainList(chat)) return "positioned";
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
  /** When true, supplementary / forced private chats in the unpositioned tier are included. */
  includeUnpositioned?: boolean;
};

export function shouldIncludeChatInList(
  chat: TdChat,
  options?: ShouldIncludeChatOptions,
): boolean {
  const tier = chatListTier(chat, options);
  if (tier === "pinned" || tier === "positioned") return true;
  if (tier === "unpositioned" && options?.includeUnpositioned) return true;
  return false;
}

export function filterChatsForList(
  chats: TdChat[],
  options?: ShouldIncludeChatOptions,
): TdChat[] {
  return chats.filter((chat) => shouldIncludeChatInList(chat, options));
}
