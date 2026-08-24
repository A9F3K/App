import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Platform, Text, View, type GestureResponderEvent } from "react-native";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
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
import { formatMessageChatListTime } from "./formatMessageChatTime";
import { resolveTelegramThreadAvatarUrl } from "./resolveTelegramThreadAvatarUrl";
import { useElementVisible } from "./useElementVisible";
import { MessageChatOutgoingChecks } from "./MessageChatOutgoingChecks";
import { type MessageOutgoingStatus } from "./messageChatHistoryTypes";
import { resolveChatListOutgoingPreview } from "./resolveChatListOutgoingPreview";
import { MessageChatTypeIcon } from "./MessageChatTypeIcon";
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
import {
  MESSAGE_CHAT_CHECKMARK_SIZE_PX,
  MESSAGE_CHAT_READ_CHECK_COLOR,
} from "./messageChatLayout";
import { MESSAGE_CHAT_ACTIVE_VOICE_RING_COLOR, MESSAGE_CHAT_JOINED_VOICE_RING_COLOR } from "./MessageChatAvatarSlot";

const LIST_ROW_CHECKMARK_SIZE_PX = Math.max(11, MESSAGE_CHAT_CHECKMARK_SIZE_PX - 2);
/** Gap between type glyph and title — keep tight like emoji status spacing. */
const LIST_TYPE_ICON_GAP_PX = 4;

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
  last_read_inbox_message_id?: number | null;
  last_message_is_outgoing?: boolean;
  last_message_outgoing_status?: MessageOutgoingStatus | null;
  last_message_telegram_id?: number | null;
  last_message_sender_user_id?: number | null;
  is_pinned?: boolean;
  pin_order?: string | null;
  list_tier?: "pinned" | "positioned" | "unpositioned" | null;
  /** Active Telegram voice/video chat on this chat. */
  has_active_voice_chat?: boolean;
  voice_chat_group_call_id?: number | null;
  /** This account is joined to the active voice chat (green ring). */
  voice_chat_is_joined?: boolean;
  /** Private peer is a Telegram bot (userTypeBot). */
  peer_is_bot?: boolean;
  /** Message ids recently deleted — open chat should drop them immediately. */
  pending_deleted_message_ids?: number[] | null;
};

function resolveAvatarUrl(item: MessageChatRowData): string | null {
  return resolveTelegramThreadAvatarUrl(item);
}

function eventToAnchor(event: GestureResponderEvent): { x: number; y: number } {
  const x = Number(event.nativeEvent.pageX);
  const y = Number(event.nativeEvent.pageY);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

export function MessageChatRow({
  item,
  isLast,
  isActive,
  prioritizeAvatar,
  colors,
  timePendingLabel,
  onPress,
  onLongPress,
  onAvatarPress,
  onPrefetch,
  onOpenContextMenu,
}: {
  item: MessageChatRowData;
  isLast: boolean;
  isActive?: boolean;
  /** Boost avatar fetch priority for rows at the visual top of the chat-list viewport. */
  prioritizeAvatar?: boolean;
  colors: ThemeColors;
  timePendingLabel: string;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Opens the chat-list context menu (right-click / long-press). */
  onOpenContextMenu?: (anchor: { x: number; y: number }) => void;
  /** Opens peer/chat profile without selecting the row when provided. */
  onAvatarPress?: () => void;
  onPrefetch?: () => void;
}) {
  const { locale, t } = useAppStrings();
  const title = item.title.trim();
  const preview = formatMessageChatListPreview(item, locale);
  const subtitle = preview.text;
  const subtitleSegments = useMemo(() => preview.textSegments, [preview.textSegments]);
  const trailing = formatMessageUnreadCountLabel(item.unread_count, item.telegram_chat_id);
  const isPinned = Boolean(item.is_pinned);
  const showPin = isPinned && !trailing;
  const iconUrl = resolveAvatarUrl(item);
  const parsedClock = formatMessageChatListTime(item.last_message_at, locale);
  const timeLabel = parsedClock || (item.last_message_at ? timePendingLabel : "");
  const showTimeMeta = Boolean(timeLabel.trim());
  const listOutgoing = resolveChatListOutgoingPreview(item);
  const listOutgoingStatus = listOutgoing.status;
  const peerIsBot =
    Boolean(item.peer_is_bot) ||
    (item.chat_kind === "private" &&
      Boolean(item.peer_username?.toLowerCase().endsWith("bot")));
  const showListOutgoingChecks =
    listOutgoing.isOutgoing &&
    !isMessageChatActionLive(item) &&
    (listOutgoingStatus === "delivered" || listOutgoingStatus === "read");
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
  // Initials paint instantly; only priority rows fetch proxy avatars (avoids TDLib storms).
  const avatarLoadEnabled = Boolean(isActive) || Boolean(prioritizeAvatar);
  const prefetchOnceRef = useRef(false);
  useEffect(() => {
    if (!rowInView || prefetchOnceRef.current) return;
    prefetchOnceRef.current = true;
    onPrefetch?.();
  }, [onPrefetch, rowInView]);
  const showAvatarImage = !!iconUrl;
  const isProxyAvatar = Boolean(iconUrl?.includes("/api/telegram-messages-avatar"));
  const avatarFetchEnabled = !isProxyAvatar || avatarLoadEnabled;
  const hasActiveVoice = Boolean(item.has_active_voice_chat);
  const isJoinedVoice = hasActiveVoice && Boolean(item.voice_chat_is_joined);
  const voiceRingColor = isJoinedVoice
    ? MESSAGE_CHAT_JOINED_VOICE_RING_COLOR
    : hasActiveVoice
      ? MESSAGE_CHAT_ACTIVE_VOICE_RING_COLOR
      : undefined;
  const previewIsVoice = hasActiveVoice && !isMessageChatActionLive(item);

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
      onLongPress={(event) => {
        if (onOpenContextMenu) {
          onOpenContextMenu(eventToAnchor(event));
          return;
        }
        onLongPress?.();
      }}
      onContextMenu={
        onOpenContextMenu
          ? (event) => {
              onOpenContextMenu(eventToAnchor(event));
            }
          : undefined
      }
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
          overflow: "visible",
        }}
      >
        {onAvatarPress ? (
          <ProfileOpenHitTarget
            label={t("messages.profile.openA11y")}
            onPress={onAvatarPress}
            style={{ width: MESSAGE_AVATAR_PX, height: MESSAGE_AVATAR_PX }}
          >
            <MessageChatAvatarSlot
              iconUrl={showAvatarImage ? iconUrl : null}
              initials={avatarInitials}
              sizePx={MESSAGE_AVATAR_PX}
              colors={colors}
              scheme={colorScheme}
              loadEnabled={avatarFetchEnabled}
              fetchPriority={isActive || prioritizeAvatar ? "high" : "normal"}
              borderColor={voiceRingColor}
              activeVoiceRing={hasActiveVoice}
              joinedVoiceRing={isJoinedVoice}
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
          </ProfileOpenHitTarget>
        ) : (
          <MessageChatAvatarSlot
            iconUrl={showAvatarImage ? iconUrl : null}
            initials={avatarInitials}
            sizePx={MESSAGE_AVATAR_PX}
            colors={colors}
            scheme={colorScheme}
            loadEnabled={avatarFetchEnabled}
            fetchPriority={isActive || prioritizeAvatar ? "high" : "normal"}
            borderColor={voiceRingColor}
            activeVoiceRing={hasActiveVoice}
            joinedVoiceRing={isJoinedVoice}
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
        )}
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
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                minWidth: 0,
              }}
            >
              <View
                style={{
                  width: MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
                  height: MESSAGE_LIST_INLINE_EMOJI_SIZE_PX,
                  marginRight: LIST_TYPE_ICON_GAP_PX,
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <MessageChatTypeIcon
                  chatKind={item.chat_kind}
                  peerIsBot={peerIsBot}
                  color={colors.secondary}
                  size={MESSAGE_LIST_INLINE_EMOJI_SIZE_PX}
                />
              </View>
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
            </View>
          </View>
          {showTimeMeta || showListOutgoingChecks ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                flexShrink: 0,
                marginLeft: MESSAGE_NAME_TIME_GAP_PX,
              }}
            >
              {showListOutgoingChecks && listOutgoingStatus ? (
                <MessageChatOutgoingChecks
                  status={listOutgoingStatus}
                  colors={colors}
                  size={LIST_ROW_CHECKMARK_SIZE_PX}
                  compact
                />
              ) : null}
              {showTimeMeta ? (
                <Text
                  numberOfLines={1}
                  style={{
                    ...textBase,
                    flexShrink: 0,
                    color: colors.accent,
                    marginLeft: showListOutgoingChecks ? 4 : 0,
                  }}
                >
                  {timeLabel}
                </Text>
              ) : null}
            </View>
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
              chatId={item.telegram_chat_id}
              style={{
                ...textBase,
                color: previewIsVoice ? colors.accent : colors.secondary,
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
