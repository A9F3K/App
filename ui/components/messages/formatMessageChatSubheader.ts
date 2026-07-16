import { formatAppString, type AppLocale } from "../../../locales/appStrings";
import {
  type FormattedTextSegment,
} from "../../../shared/formattedTextSegments";
import { formatMessageChatMemberCountLabel, formatMessageChatPresenceLabel } from "./formatMessageChatPresence";
import { formatMessageChatRowUsernameLabel } from "./formatTelegramChatRowUsername";
import type { MessageChatRowData } from "./MessageChatRow";
import { isGroupLikeChatRow } from "./isGroupLikeChatRow";
import { resolveMessageDisplaySegments } from "./resolveMessageDisplaySegments";
import { specialUserDisplayName } from "./specialTelegramUserDisplay";

function isChatActionLive(chat: MessageChatRowData): boolean {
  if (!chat.chat_action) return false;
  if (!chat.chat_action_expires_at) return true;
  return Date.parse(chat.chat_action_expires_at) > Date.now();
}

export function isMessageChatActionLive(chat: MessageChatRowData): boolean {
  return isChatActionLive(chat);
}

function chatActionActorName(chat: MessageChatRowData): string {
  const fromAction = chat.chat_action_user_name?.trim();
  if (fromAction) {
    return specialUserDisplayName(chat.chat_action_user_id, fromAction, chat.telegram_chat_id);
  }
  if (chat.peer_user_id != null && !isGroupLikeChatRow(chat)) {
    return specialUserDisplayName(chat.peer_user_id, chat.title, chat.telegram_chat_id);
  }
  if (chat.chat_action_user_id != null) {
    return specialUserDisplayName(chat.chat_action_user_id, chat.title, chat.telegram_chat_id);
  }
  return "";
}

function formatNamedChatAction(
  locale: AppLocale,
  genericKey: Parameters<typeof formatAppString>[1],
  namedKey: Parameters<typeof formatAppString>[1],
  actorName: string,
): string {
  const name = actorName.trim();
  if (name) return formatAppString(locale, namedKey, { name });
  return formatAppString(locale, genericKey);
}

function formatChatActionLabel(chat: MessageChatRowData, locale: AppLocale): string {
  const action = chat.chat_action!;
  const actorName = chatActionActorName(chat);

  if (action === "typing") {
    return formatNamedChatAction(
      locale,
      "messages.chatAction.typing",
      "messages.chatAction.typingNamed",
      actorName,
    );
  }
  if (action === "recording_voice") {
    return formatNamedChatAction(
      locale,
      "messages.chatAction.recordingVoice",
      "messages.chatAction.recordingVoiceNamed",
      actorName,
    );
  }
  if (action === "recording_video") {
    return formatNamedChatAction(
      locale,
      "messages.chatAction.recordingVideo",
      "messages.chatAction.recordingVideoNamed",
      actorName,
    );
  }
  if (action === "uploading_photo") {
    return formatNamedChatAction(
      locale,
      "messages.chatAction.uploadingPhoto",
      "messages.chatAction.uploadingPhotoNamed",
      actorName,
    );
  }
  if (action === "uploading_video") {
    return formatNamedChatAction(
      locale,
      "messages.chatAction.uploadingVideo",
      "messages.chatAction.uploadingVideoNamed",
      actorName,
    );
  }
  if (action === "uploading_file") {
    return formatNamedChatAction(
      locale,
      "messages.chatAction.uploadingFile",
      "messages.chatAction.uploadingFileNamed",
      actorName,
    );
  }

  return formatNamedChatAction(
    locale,
    "messages.chatAction.typing",
    "messages.chatAction.typingNamed",
    actorName,
  );
}

/** Header subheader: live chat action overrides presence / member count. */
export function formatMessageChatSubheaderLabel(chat: MessageChatRowData, locale: AppLocale): string {
  if (isChatActionLive(chat)) {
    return formatChatActionLabel(chat, locale);
  }
  if (isGroupLikeChatRow(chat)) {
    // Same placement/role as private "last seen…": count only under the title.
    return formatMessageChatMemberCountLabel(chat, locale);
  }
  const usernameLabel = formatMessageChatRowUsernameLabel(chat);
  const presence = formatMessageChatPresenceLabel(chat, locale);
  if (usernameLabel && presence) return `${usernameLabel} · ${presence}`;
  if (usernameLabel) return usernameLabel;
  return presence;
}

/** Chat list preview line: typing/recording overrides last message snippet. */
export function formatMessageChatListSubtitle(chat: MessageChatRowData, locale: AppLocale): string {
  if (isChatActionLive(chat)) {
    return formatChatActionLabel(chat, locale);
  }
  return chat.subtitle.trim();
}

/** Chat list preview: group/supergroup/channel rows prefix with @username; private chats show message only. */
export function formatMessageChatListPreview(
  chat: MessageChatRowData,
  locale: AppLocale,
): { text: string; textSegments: FormattedTextSegment[] | null } {
  const subtitle = formatMessageChatListSubtitle(chat, locale);
  const baseSegments = resolveMessageDisplaySegments(subtitle, chat.subtitle_segments);

  if (isChatActionLive(chat) || !subtitle.trim()) {
    return { text: subtitle, textSegments: baseSegments };
  }

  if (!isGroupLikeChatRow(chat)) {
    return { text: subtitle, textSegments: baseSegments };
  }

  const usernameLabel = formatMessageChatRowUsernameLabel(chat);
  if (!usernameLabel) {
    return { text: subtitle, textSegments: baseSegments };
  }

  const prefix = `${usernameLabel}: `;
  if (!baseSegments?.length) {
    const text = `${prefix}${subtitle}`;
    return { text, textSegments: [{ kind: "text", text }] };
  }

  return {
    text: `${prefix}${subtitle}`,
    textSegments: [{ kind: "text", text: prefix }, ...baseSegments],
  };
}
