import { formatAppString, type AppLocale } from "../../../locales/appStrings";
import { formatMessageChatWallClock } from "./formatMessageChatTime";
import type { MessageChatRowData } from "./MessageChatRow";

function presenceTimeLabel(raw: string | null | undefined): string {
  if (raw == null || raw === "") return "";
  return formatMessageChatWallClock(raw);
}

/** Localized member/subscriber count for group / channel chat headers (like last-seen). */
export function formatMessageChatMemberCountLabel(
  chat: MessageChatRowData,
  locale: AppLocale,
): string {
  const count = chat.member_count;
  if (count == null || count <= 0) return "";
  const formatted = count.toLocaleString(locale === "ru" ? "ru-RU" : "en-US");
  const key =
    chat.chat_kind === "channel"
      ? "messages.chatMemberCount.subscribers"
      : "messages.chatMemberCount.participants";
  return formatAppString(locale, key, { count: formatted });
}
/** Localized presence / last-seen line for private chat headers. */
export function formatMessageChatPresenceLabel(
  chat: MessageChatRowData,
  locale: AppLocale,
): string {
  const kind = chat.presence_kind;
  if (kind === "online") {
    return formatAppString(locale, "messages.chatPresence.online");
  }
  if (kind === "recently") {
    return formatAppString(locale, "messages.chatPresence.recently");
  }
  if (kind === "last_week") {
    return formatAppString(locale, "messages.chatPresence.lastWeek");
  }
  if (kind === "last_month") {
    return formatAppString(locale, "messages.chatPresence.lastMonth");
  }

  const at = chat.presence_at ?? chat.last_message_at;
  const time = presenceTimeLabel(at);
  if (kind === "offline" && time) {
    return formatAppString(locale, "messages.chatPresence.lastSeen", { time });
  }
  if (time) {
    return formatAppString(locale, "messages.chatPresence.lastSeen", { time });
  }
  return formatAppString(locale, "messages.chatPresence.unknown");
}
