import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Platform, Text, View } from "react-native";
import { TELEGRAM_THREAD_NO_AVATAR } from "../../../shared/telegramThreadConstants";
import { resolveTelegramDisplayName } from "../../../shared/telegramDisplayName";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { logPageDisplay, chatLogFields } from "../../pageDisplayLog";
import type { ThemeColors } from "../../theme";
import { useTelegram } from "../Telegram";
import { HomeListRowShell } from "../HomeListRowShell";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { specialUserDisplayName } from "./specialTelegramUserDisplay";
import { MessageUnreadCountBadge } from "./MessageUnreadCountBadge";
import { MessageChatPinIcon } from "./MessageChatPinIcon";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import { MessageChatRichText } from "./MessageChatRichText";
import {
  formatMessageChatListPreview,
  isMessageChatActionLive,
} from "./formatMessageChatSubheader";
import { formatMessageChatWallClock } from "./formatMessageChatTime";
import { resolveTelegramThreadAvatarUrl } from "./resolveTelegramThreadAvatarUrl";
import { useElementVisible } from "./useElementVisible";
import { MessageChatOutgoingChecks } from "./MessageChatOutgoingChecks";
import {
  isPrivateChatForReadReceipts,
  resolveOutgoingStatusForDisplay,
  type MessageOutgoingStatus,
} from "./messageChatHistoryTypes";
import {
  MESSAGE_AVATAR_PX,
  MESSAGE_ICON_TEXT_GAP_PX,
  MESSAGE_LINE_HEIGHT_PX,
  MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
  MESSAGE_NAME_TIME_GAP_PX,
  MESSAGE_ROW_HEIGHT_PX,
  MESSAGE_FONT_SIZE_PX,
  formatMessageUnreadCountLabel,
} from "./messageListLayout";
import { MESSAGE_CHAT_CHECKMARK_SIZE_PX } from "./messageChatLayout";

const LIST_ROW_CHECKMARK_SIZE_PX = Math.max(11, MESSAGE_CHAT_CHECKMARK_SIZE_PX - 2);

export type MessageChatActionKind =
  | "typing"
  | "recording_voice"
  | "recording_video"
  | "uploading_photo"
  | "uploading_video"
  | "uploading_file";

export type MessageChatKind = "private" | "group" | "supergroup" | "channel";

export type MessageChatRowData = {
  id: number;
  telegram_chat_id: number;
  title: string;
  subtitle: string;
  subtitle_segments?: FormattedTextSegment[] | null;
  avatar_url: string | null;
  last_message_at: string | null;
  unread_count: number;
  /** @deprecated Unused — unread_count drives the scroll-to-bottom FAB. */
  scroll_below_unread_count?: number;
  peer_user_id?: number | null;
  peer_username?: string | null;
  chat_username?: string | null;
  chat_kind?: MessageChatKind | null;
  member_count?: number | null;
  peer_emoji_status_custom_emoji_id?: string | null;
  peer_accent_color_light?: string | null;
  peer_accent_color_dark?: string | null;
  presence_kind?: "online" | "recently" | "last_week" | "last_month" | "offline" | null;
  presence_at?: string | null;
  chat_action?: MessageChatActionKind | null;
  chat_action_user_id?: number | null;
  chat_action_user_name?: string | null;
  chat_action_expires_at?: string | null;
  last_read_outbox_message_id?: number | null;
  last_message_is_outgoing?: boolean;
  last_message_outgoing_status?: MessageOutgoingStatus | null;
  is_pinned?: boolean;
};

function resolveAvatarUrl(item: MessageChatRowData): string | null {
  return resolveTelegramThreadAvatarUrl(item);
}

export function MessageChatRow({
  item,
  isLast,
  isActive,
  colors,
  timePendingLabel,
  onPress,
  onPrefetch,
}: {
  item: MessageChatRowData;
  isLast: boolean;
  isActive?: boolean;
  colors: ThemeColors;
  timePendingLabel: string;
  onPress?: () => void;
  onPrefetch?: () => void;
}) {
  const { locale } = useAppStrings();
  const title = item.title.trim();
  const preview = formatMessageChatListPreview(item, locale);
  const subtitle = preview.text;
  const subtitleSegments = useMemo(() => preview.textSegments, [preview.textSegments]);
  const trailing = formatMessageUnreadCountLabel(item.unread_count, item.telegram_chat_id);
  const isPinned = Boolean(item.is_pinned);
  const showPin = isPinned && !trailing;
  const iconUrl = resolveAvatarUrl(item);
  const parsedClock = formatMessageChatWallClock(item.last_message_at);
  const timeLabel = parsedClock || timePendingLabel;
  const gapTitleTime = !!(title && timeLabel.trim());
  const listOutgoingStatus = item.last_message_is_outgoing
    ? resolveOutgoingStatusForDisplay(
        {
          is_outgoing: true,
          outgoing_status: item.last_message_outgoing_status ?? null,
        },
        item.chat_kind,
        item,
      )
    : null;
  const showListOutgoingChecks =
    Boolean(item.last_message_is_outgoing) &&
    !isMessageChatActionLive(item) &&
    (listOutgoingStatus === "delivered" || listOutgoingStatus === "read");
  const listDoubleCheckDelivered = isPrivateChatForReadReceipts(item.chat_kind, item);
  const avatarLogOnceRef = useRef(false);
  const avatarLabel = useMemo(() => {
    const display = specialUserDisplayName(item.peer_user_id, title, item.telegram_chat_id);
    return resolveTelegramDisplayName({
      name: display,
      username: item.peer_username,
      userId: item.peer_user_id,
    });
  }, [item.peer_user_id, item.peer_username, item.telegram_chat_id, title]);
  const avatarInitials = useMemo(() => extractChatAvatarInitials(avatarLabel), [avatarLabel]);
  const { colorScheme } = useTelegram();
  const rowRef = useRef<View>(null);
  const rowInView = useElementVisible(rowRef as RefObject<Element | null>, {
    rootMargin: "120px",
  });
  const avatarLoadEnabled = rowInView || Boolean(isActive);
  const prefetchOnceRef = useRef(false);
  useEffect(() => {
    if (!rowInView || prefetchOnceRef.current) return;
    prefetchOnceRef.current = true;
    onPrefetch?.();
  }, [onPrefetch, rowInView]);
  const showAvatarImage = !!iconUrl;
  const isProxyAvatar = Boolean(iconUrl?.includes("/api/telegram-messages-avatar"));
  const avatarFetchEnabled = !isProxyAvatar || avatarLoadEnabled;

  useEffect(() => {
    if (avatarLogOnceRef.current || !avatarLoadEnabled) return;
    avatarLogOnceRef.current = true;
    logPageDisplay("messages_avatar_source", {
      ...chatLogFields({
        chatId: item.telegram_chat_id,
        peerUserId: item.peer_user_id,
        title: item.title,
      }),
      hasAvatarField: typeof item.avatar_url === "string" && item.avatar_url.length > 0,
      sourceType: item.avatar_url
        ? item.avatar_url === TELEGRAM_THREAD_NO_AVATAR
          ? "no_avatar_marker"
          : item.avatar_url.startsWith("data:")
            ? "data_url"
            : item.avatar_url.startsWith("http://") || item.avatar_url.startsWith("https://")
              ? "absolute_url"
              : "relative_url"
        : "avatar_proxy_endpoint",
      resolvedSource: iconUrl?.startsWith("data:")
        ? "data_url"
        : iconUrl?.includes("/api/telegram-messages-avatar")
          ? "avatar_proxy"
          : iconUrl
            ? "url"
            : "none",
    });
  }, [avatarLoadEnabled, iconUrl, item.avatar_url, item.peer_user_id, item.telegram_chat_id, item.title]);

  const textBase = {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontSize: MESSAGE_FONT_SIZE_PX,
    lineHeight: MESSAGE_LINE_HEIGHT_PX,
    includeFontPadding: false,
    paddingVertical: 0,
  } as const;

  return (
    <HomeListRowShell
      isLast={isLast}
      isActive={isActive}
      colors={colors}
      onPress={onPress}
      onHoverIn={onPrefetch}
    >
      <View
        ref={rowRef}
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: MESSAGE_ROW_HEIGHT_PX,
          width: "100%",
          alignSelf: "stretch",
        }}
      >
      <View
        style={{
          width: MESSAGE_AVATAR_PX,
          height: MESSAGE_AVATAR_PX,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <MessageChatAvatarSlot
          iconUrl={showAvatarImage ? iconUrl : null}
          initials={avatarInitials}
          sizePx={MESSAGE_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          loadEnabled={avatarFetchEnabled}
          fetchPriority={isActive ? "high" : "normal"}
          onLoad={() => {
            logPageDisplay("messages_avatar_load_ok", {
              ...chatLogFields({
                chatId: item.telegram_chat_id,
                peerUserId: item.peer_user_id,
                title: item.title,
              }),
            });
          }}
          onError={(error) => {
            logPageDisplay("messages_avatar_load_error", {
              ...chatLogFields({
                chatId: item.telegram_chat_id,
                peerUserId: item.peer_user_id,
                title: item.title,
              }),
              error: error ?? "unknown_avatar_error",
            });
          }}
        />
      </View>
      <View style={{ width: MESSAGE_ICON_TEXT_GAP_PX }} />
      <View style={{ flex: 1, minWidth: 0, justifyContent: "center" }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            minHeight: MESSAGE_LINE_HEIGHT_PX,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <SpecialTelegramUserName
              name={title}
              telegramUserId={item.peer_user_id ?? null}
              telegramChatId={item.telegram_chat_id}
              emojiStatusCustomEmojiId={item.peer_emoji_status_custom_emoji_id ?? null}
              emojiStatusPriority={true}
              inlineEmojiFetchEnabled={rowInView || Boolean(isActive)}
              inlineEmojiFetchPriority={rowInView || Boolean(isActive)}
              inlineEmojiSizePx={MESSAGE_LIST_INLINE_EMOJI_SIZE_PX}
              textStyle={{
                ...textBase,
                color: colors.primary,
              }}
            />
          </View>
          {gapTitleTime ? <View style={{ width: MESSAGE_NAME_TIME_GAP_PX }} /> : null}
          {showListOutgoingChecks && listOutgoingStatus ? (
            <>
              <MessageChatOutgoingChecks
                status={listOutgoingStatus}
                colors={colors}
                size={LIST_ROW_CHECKMARK_SIZE_PX}
                doubleCheckDelivered={listDoubleCheckDelivered}
              />
              <View style={{ width: 2 }} />
            </>
          ) : null}
          {timeLabel ? (
            <Text
              numberOfLines={1}
              style={{
                ...textBase,
                flexShrink: 0,
                color: colors.accent,
              }}
            >
              {timeLabel}
            </Text>
          ) : null}
        </View>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "flex-start",
            minHeight: MESSAGE_LINE_HEIGHT_PX,
            overflow: "hidden",
          }}
        >
          <View style={{ flex: 1, minWidth: 0, alignSelf: "stretch" }}>
            <MessageChatRichText
              text={subtitle}
              segments={subtitleSegments}
              numberOfLines={1}
              emojiSizePx={MESSAGE_LIST_INLINE_EMOJI_SIZE_PX}
              lowPriorityEmoji
              enrichStandardEmojis
              emojiFetchEnabled={rowInView || Boolean(isActive)}
              emojiFetchPriority={rowInView || Boolean(isActive)}
              style={{
                ...textBase,
                color: colors.secondary,
              }}
            />
          </View>
          {showPin || trailing ? <View style={{ width: MESSAGE_NAME_TIME_GAP_PX }} /> : null}
          {showPin ? <MessageChatPinIcon size={20} color={colors.accent} /> : null}
          {trailing ? <MessageUnreadCountBadge label={trailing} colors={colors} /> : null}
        </View>
      </View>
      </View>
    </HomeListRowShell>
  );
}
