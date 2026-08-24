import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Platform, Pressable, Text, View, type GestureResponderEvent, type TextLayoutEvent } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { useProfileSheet } from "../../profile/ProfileContext";
import { typographyRect15 } from "../../theme";
import type { ThemeColors } from "../../theme";
import { useTelegram } from "../Telegram";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { ProfileOpenHitTarget } from "./ProfileOpenHitTarget";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { MessageChatBubbleBody } from "./MessageChatBubbleBody";
import { formatMessageChatBubbleTime } from "./formatMessageChatBubbleTime";
import type { MessageChatHistoryItem, MessageChatKind } from "./messageChatHistoryTypes";
import {
  isDisplayableMediaMessage,
  messageChatAudioCaptionText,
  messageShowsOutgoingChecks,
  resolveOutgoingStatusForDisplay,
  shouldShowMessageSenderHeader,
} from "./messageChatHistoryTypes";
import {
  measureBubbleInnerContentWidth,
  measureLongestWrappedBodyLineWidth,
  measureMessageBubbleMetaWidthPx,
  measureTextGlyphWidth,
  adjustBubbleLineWidthsForInlineEmoji,
  resolveBubbleMetaPlacementFromLineWidths,
  resolveMessageBubbleLayout,
  type BubbleMetaPlacement,
} from "./messageChatBubbleMeasure";
import {
  MESSAGE_BUBBLE_AVATAR_GAP_PX,
  MESSAGE_BUBBLE_AVATAR_PX,
  MESSAGE_BUBBLE_COMPACT_HEIGHT_PX,
  MESSAGE_BUBBLE_BORDER_RADIUS_PX,
  MESSAGE_BUBBLE_FONT_SIZE_PX,
  MESSAGE_BUBBLE_LINE_HEIGHT_PX,
  MESSAGE_BUBBLE_META_GAP_PX,
  MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX,
  MESSAGE_BUBBLE_PADDING_VERTICAL_PX,
  MESSAGE_BUBBLE_REPLY_BAR_WIDTH_PX,
  MESSAGE_BUBBLE_REPLY_PADDING_PX,
  MESSAGE_CHAT_MEDIA_PREFETCH_PX,
} from "./messageChatLayout";
import { resolveMessageMediaDimensions } from "./MessageChatMediaContent";
import { messageChatOutgoingChecksWidthPx } from "./MessageChatOutgoingChecks";
import { messageChatCallArrowWidthPx } from "./MessageChatCallArrow";
import { formatMessageCallLabel } from "./formatMessageCallLabel";
import { messageChatAudioInnerWidthPx } from "./MessageChatAudioContent";
import type { MessageChatRowData } from "./MessageChatRow";
import { resolveTelegramThreadAvatarUrl } from "./resolveTelegramThreadAvatarUrl";
import { resolveMessageSenderDisplayName } from "./resolveMessageSenderDisplayName";
import { specialUserBadgeExtraWidthPx } from "./specialTelegramUserDisplay";
import {
  canDeleteMessage,
  canEditMessage,
  canReplyToMessage,
} from "./messageChatActionUtils";
import {
  MessageChatMessageContextMenu,
  type MessageContextMenuAnchor,
} from "./MessageChatMessageContextMenu";
import {
  setMessageChatComposeEdit,
  setMessageChatComposeReply,
} from "../../messageChatCompose";
import { removeOutgoingChatMessage } from "../../messageChatOutgoing";
import { deleteTelegramChatMessages } from "../../telegram/deleteTelegramChatMessages";
import { appWarn } from "../../../shared/appLog";
import { useElementVisible } from "./useElementVisible";

function fittedBubbleLayoutFromTextLayout(
  event: TextLayoutEvent,
  columnWidth: number,
  innerMaxWidth: number,
  metaWidthPx: number,
  extraInnerWidthPx: number,
  bodyText: string,
): { width: number; innerWidthPx: number; placement: BubbleMetaPlacement } {
  const lines = event.nativeEvent.lines;
  if (lines.length === 0) {
    return { width: 0, innerWidthPx: 0, placement: "stacked" };
  }
  const trimmed = bodyText.trim();
  const lineWidths = adjustBubbleLineWidthsForInlineEmoji(
    lines.map((line, index, all) => {
      const width = line.width;
      if (all.length === 1 && trimmed.length > 0) {
        const glyphWidth = measureTextGlyphWidth(
          trimmed,
          MESSAGE_BUBBLE_FONT_SIZE_PX,
          MESSAGE_BUBBLE_LINE_HEIGHT_PX,
        );
        if (glyphWidth > 0) return Math.min(width, glyphWidth);
      }
      return width;
    }),
    bodyText,
  );
  const placement = resolveBubbleMetaPlacementFromLineWidths(
    lineWidths,
    innerMaxWidth,
    metaWidthPx,
  );
  let inner = measureBubbleInnerContentWidth(
    lineWidths,
    placement,
    metaWidthPx,
    MESSAGE_BUBBLE_META_GAP_PX,
    trimmed,
  );
  inner = Math.max(inner, extraInnerWidthPx);
  const width = Math.min(
    columnWidth,
    inner + MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX * 2,
  );
  return { width, innerWidthPx: inner, placement };
}

type Props = {
  chat: MessageChatRowData;
  chatKind: MessageChatKind | null;
  item: MessageChatHistoryItem;
  colors: ThemeColors;
  columnWidthPx: number;
  selfUserId?: number | null;
  /** When false, defer emoji/media fetches until open scroll has settled. */
  contentActive?: boolean;
};

export function MessageChatMessageRow({
  chat,
  chatKind,
  item,
  colors,
  columnWidthPx,
  selfUserId = null,
  contentActive = true,
}: Props) {
  const { t } = useAppStrings();
  const { openProfileSheet } = useProfileSheet();
  const iconUrl = resolveTelegramThreadAvatarUrl(chat, item, chatKind);
  const avatarInitials = useMemo(() => {
    const name =
      chatKind === "channel"
        ? chat.title
        : item.sender_name || chat.title;
    return extractChatAvatarInitials(
      resolveMessageSenderDisplayName(name, item.sender_user_id, chat.telegram_chat_id),
    );
  }, [chatKind, chat.title, chat.telegram_chat_id, item.sender_name, item.sender_user_id]);
  const [liveMediaWidthPx, setLiveMediaWidthPx] = useState<number | null>(null);
  const [nativeBubbleLayout, setNativeBubbleLayout] = useState<{
    width: number;
    innerWidthPx: number;
    placement: BubbleMetaPlacement;
  } | null>(null);
  const [actionSheetVisible, setActionSheetVisible] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<MessageContextMenuAnchor | null>(null);
  const lastPointerRef = useRef<MessageContextMenuAnchor | null>(null);
  const bubblePressableRef = useRef<View | null>(null);
  const rowRef = useRef<View | null>(null);
  const { colorScheme } = useTelegram();
  const rowInView = useElementVisible(rowRef as RefObject<Element | null>, {
    rootMargin: "160px",
  });
  // Wider band for photo/video full fetch — tdesktop preloads media ahead of the viewport.
  const mediaNearView = useElementVisible(rowRef as RefObject<Element | null>, {
    rootMargin: `${MESSAGE_CHAT_MEDIA_PREFETCH_PX}px`,
  });
  const isProxyAvatar = Boolean(iconUrl?.includes("/api/telegram-messages-avatar"));
  const avatarFetchEnabled = !isProxyAvatar || rowInView;
  const senderTitle =
    chatKind === "channel"
      ? chat.title
      : resolveMessageSenderDisplayName(
          item.sender_name || chat.title,
          item.sender_user_id,
          chat.telegram_chat_id,
        );
  const profilePeerUserId =
    chatKind === "private"
      ? (chat.peer_user_id ?? item.sender_user_id ?? null)
      : (item.sender_user_id ?? null);
  const openSenderProfile = () => {
    openProfileSheet({
      telegram_chat_id: chat.telegram_chat_id,
      title: senderTitle,
      peer_user_id: profilePeerUserId,
      peer_username: chat.peer_username ?? null,
      chat_username: chat.chat_username ?? null,
      chat_kind: chat.chat_kind ?? chatKind,
      avatar_url: chat.avatar_url,
      peer_emoji_status_custom_emoji_id:
        item.sender_emoji_status_custom_emoji_id ??
        chat.peer_emoji_status_custom_emoji_id ??
        null,
      peer_is_bot: chat.peer_is_bot,
    });
  };

  const bubbleMaxWidth = Math.max(
    0,
    columnWidthPx - MESSAGE_BUBBLE_AVATAR_PX - MESSAGE_BUBBLE_AVATAR_GAP_PX,
  );

  const bubbleInnerMaxWidth = Math.max(
    0,
    bubbleMaxWidth - MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX * 2,
  );

  const isCall = item.content_kind === "call";
  const isAudio = item.content_kind === "audio" && Boolean(item.audio);
  const bodyText = isCall
    ? formatMessageCallLabel(item.is_outgoing, t)
    : isAudio
      ? messageChatAudioCaptionText(item)
      : item.text.trim();
  const timeLabel = formatMessageChatBubbleTime(item.sent_at);
  const outgoingStatusForLayout = resolveOutgoingStatusForDisplay(item, chatKind ?? chat.chat_kind, chat);
  const showOutgoingChecks = messageShowsOutgoingChecks(item, {
    peerUserId: chat.peer_user_id,
    selfUserId,
    chatKind: chatKind ?? chat.chat_kind,
    peerIsBot:
      Boolean(chat.peer_is_bot) ||
      ((chatKind ?? chat.chat_kind) === "private" &&
        Boolean(chat.peer_username?.toLowerCase().endsWith("bot"))),
  });
  const checksWidthPx = showOutgoingChecks
    ? messageChatOutgoingChecksWidthPx(
        outgoingStatusForLayout === "read" ? "read" : "delivered",
      )
    : 0;
  const callArrowWidthPx = messageChatCallArrowWidthPx(isCall);
  const metaWidthPx = measureMessageBubbleMetaWidthPx(
    timeLabel,
    checksWidthPx + callArrowWidthPx,
  );
  const showMedia = isDisplayableMediaMessage(item);
  const hasMediaCaption = showMedia && bodyText.length > 0;
  const isBareMediaMessage = showMedia && !hasMediaCaption && !isCall;
  const { widthPx: mediaWidthPx } = resolveMessageMediaDimensions(
    bubbleInnerMaxWidth,
    item.media_width,
    item.media_height,
    item.content_kind,
  );
  const effectiveMediaWidthPx = liveMediaWidthPx ?? mediaWidthPx;

  const senderDisplayName = resolveMessageSenderDisplayName(
    item.sender_name,
    item.sender_user_id,
    chat.telegram_chat_id,
  );
  const showSenderHeader = shouldShowMessageSenderHeader(chatKind, item);

  const extraInnerWidthPx = useMemo(() => {
    let extra = 0;
    if (isAudio) extra = Math.max(extra, messageChatAudioInnerWidthPx());
    if (showMedia) extra = Math.max(extra, effectiveMediaWidthPx);
    if (showSenderHeader) {
      if (senderDisplayName) {
        extra = Math.max(
          extra,
          measureTextGlyphWidth(
            senderDisplayName,
            MESSAGE_BUBBLE_FONT_SIZE_PX,
            MESSAGE_BUBBLE_LINE_HEIGHT_PX,
          ) + specialUserBadgeExtraWidthPx(item.sender_user_id, senderDisplayName, chat.telegram_chat_id),
        );
      }
    }
    const reply = item.reply_to;
    if (reply) {
      const replyChromePx =
        MESSAGE_BUBBLE_REPLY_BAR_WIDTH_PX + MESSAGE_BUBBLE_REPLY_PADDING_PX * 2;
      const replySenderWidth = measureTextGlyphWidth(
        reply.sender_name,
        MESSAGE_BUBBLE_FONT_SIZE_PX,
        MESSAGE_BUBBLE_LINE_HEIGHT_PX,
      );
      const replyTextWidth = measureLongestWrappedBodyLineWidth(
        reply.text,
        Math.max(0, bubbleInnerMaxWidth - replyChromePx),
      );
      extra = Math.max(
        extra,
        replySenderWidth + replyChromePx,
        replyTextWidth + replyChromePx,
      );
    }
    return extra;
  }, [
    bubbleInnerMaxWidth,
    chat.telegram_chat_id,
    effectiveMediaWidthPx,
    item.reply_to,
    item.sender_name,
    item.sender_user_id,
    isAudio,
    senderDisplayName,
    showMedia,
    showSenderHeader,
  ]);

  useEffect(() => {
    setLiveMediaWidthPx(null);
  }, [item.telegram_message_id, item.content_kind, item.media_width, item.media_height]);

  const webBubbleLayout = useMemo(() => {
    if (Platform.OS !== "web" || bubbleMaxWidth <= 0) return null;
    if (isBareMediaMessage) {
      return {
        width: effectiveMediaWidthPx,
        innerWidthPx: effectiveMediaWidthPx,
        placement: "stacked" as BubbleMetaPlacement,
      };
    }
    const { placement, innerWidthPx } = resolveMessageBubbleLayout(
      bodyText,
      bubbleMaxWidth,
      metaWidthPx,
      extraInnerWidthPx,
    );
    return {
      innerWidthPx,
      width: Math.min(
        bubbleMaxWidth,
        showMedia && hasMediaCaption
          ? Math.max(
              effectiveMediaWidthPx,
              innerWidthPx + MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX * 2,
            )
          : showMedia
            ? Math.max(effectiveMediaWidthPx, innerWidthPx)
            : innerWidthPx + MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX * 2,
      ),
      placement,
    };
  }, [
    bodyText,
    bubbleInnerMaxWidth,
    bubbleMaxWidth,
    checksWidthPx,
    extraInnerWidthPx,
    effectiveMediaWidthPx,
    hasMediaCaption,
    isBareMediaMessage,
    mediaWidthPx,
    metaWidthPx,
    showMedia,
  ]);

  const onMeasureTextLayout = useCallback(
    (event: TextLayoutEvent) => {
      if (Platform.OS === "web" || bubbleMaxWidth <= 0) return;
      const next = fittedBubbleLayoutFromTextLayout(
        event,
        bubbleMaxWidth,
        bubbleInnerMaxWidth,
        metaWidthPx,
        extraInnerWidthPx,
        bodyText,
      );
      if (next.width <= 0) return;
      setNativeBubbleLayout((current) =>
        current?.width === next.width &&
        current.innerWidthPx === next.innerWidthPx &&
        current.placement === next.placement
          ? current
          : next,
      );
    },
    [bodyText, bubbleInnerMaxWidth, bubbleMaxWidth, extraInnerWidthPx, metaWidthPx],
  );

  useEffect(() => {
    setNativeBubbleLayout(null);
  }, [bodyText, bubbleMaxWidth, extraInnerWidthPx, metaWidthPx, timeLabel]);

  const syncTextBubbleLayout = useMemo(() => {
    if (Platform.OS === "web" || bubbleMaxWidth <= 0 || isBareMediaMessage) return null;
    const { placement, innerWidthPx } = resolveMessageBubbleLayout(
      bodyText,
      bubbleMaxWidth,
      metaWidthPx,
      extraInnerWidthPx,
    );
    return {
      innerWidthPx,
      width: Math.min(
        bubbleMaxWidth,
        innerWidthPx + MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX * 2,
      ),
      placement,
    };
  }, [
    bodyText,
    bubbleMaxWidth,
    extraInnerWidthPx,
    isBareMediaMessage,
    metaWidthPx,
  ]);

  const bubbleLayout =
    Platform.OS === "web"
      ? webBubbleLayout
      : isBareMediaMessage
        ? {
            width: effectiveMediaWidthPx,
            innerWidthPx: effectiveMediaWidthPx,
            placement: "stacked" as BubbleMetaPlacement,
          }
        : nativeBubbleLayout ?? syncTextBubbleLayout;
  const metaPlacement = bubbleLayout?.placement ?? "stacked";
  const bubbleContentWidthPx = bubbleInnerMaxWidth;
  const bubbleWidth =
    Platform.OS === "web" && !showMedia ? null : bubbleLayout?.width ?? null;
  const [webTimeOverflowPx, setWebTimeOverflowPx] = useState(0);
  const bubbleFillRef = useRef<View>(null);

  useEffect(() => {
    setWebTimeOverflowPx(0);
  }, [item.telegram_message_id, bodyText, timeLabel]);

  useLayoutEffect(() => {
    if (Platform.OS !== "web" || showMedia) return;
    const node = bubbleFillRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.querySelector !== "function") return;
    const time = node.querySelector("[data-bubble-time]");
    if (!time) return;
    const bubbleRect = node.getBoundingClientRect();
    const timeRect = time.getBoundingClientRect();
    const overflow = Math.ceil(timeRect.right - bubbleRect.right);
    if (overflow > 1) {
      setWebTimeOverflowPx((prev) => prev + overflow + 2);
    }
  }, [
    bodyText,
    bubbleMaxWidth,
    item.telegram_message_id,
    metaPlacement,
    showMedia,
    timeLabel,
    webTimeOverflowPx,
  ]);
  const measureText = bodyText || " ";
  const showChannelBadge = Boolean(item.sender_is_channel) && chatKind !== "channel";
  const isCompactSingleLineRow =
    !showMedia &&
    !isAudio &&
    !item.reply_to &&
    !showSenderHeader &&
    !showChannelBadge &&
    metaPlacement === "inline" &&
    bodyText.length > 0;

  const canReply = canReplyToMessage(item);
  const canEdit = canEditMessage(item, selfUserId, chat.peer_user_id);
  const canDelete = canDeleteMessage(item, selfUserId, chat.peer_user_id);
  const showActionSheet = canReply || canEdit || canDelete;

  const openActionSheet = useCallback(
    (anchor?: MessageContextMenuAnchor | null) => {
      if (!showActionSheet) return;
      if (anchor) {
        setMenuAnchor(anchor);
        setActionSheetVisible(true);
        return;
      }
      if (lastPointerRef.current) {
        setMenuAnchor(lastPointerRef.current);
        setActionSheetVisible(true);
        return;
      }
      bubblePressableRef.current?.measureInWindow((x, y, width, height) => {
        setMenuAnchor({ x: x + width / 2, y: y + height / 2 });
        setActionSheetVisible(true);
      });
    },
    [showActionSheet],
  );

  const capturePointer = useCallback((event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    if (Number.isFinite(pageX) && Number.isFinite(pageY)) {
      lastPointerRef.current = { x: pageX, y: pageY };
    }
  }, []);

  const onBubbleLongPress = useCallback(
    (event: GestureResponderEvent) => {
      if (!showActionSheet) return;
      capturePointer(event);
      openActionSheet({
        x: event.nativeEvent.pageX,
        y: event.nativeEvent.pageY,
      });
    },
    [capturePointer, openActionSheet, showActionSheet],
  );

  const onContextMenu = useCallback(
    (event: GestureResponderEvent & { preventDefault?: () => void }) => {
      if (Platform.OS !== "web" || !showActionSheet) return;
      event.preventDefault?.();
      const { pageX, pageY } = event.nativeEvent;
      openActionSheet({
        x: Number.isFinite(pageX) ? pageX : 0,
        y: Number.isFinite(pageY) ? pageY : 0,
      });
    },
    [openActionSheet, showActionSheet],
  );

  const onReply = useCallback(() => {
    setActionSheetVisible(false);
    setMenuAnchor(null);
    setMessageChatComposeReply(chat.telegram_chat_id, item, {
      chatTitle: chat.title,
      chatKind: chatKind ?? chat.chat_kind ?? null,
      telegramChatId: chat.telegram_chat_id,
      peerUserId: chat.peer_user_id,
      selfUserId,
    });
  }, [chat, chatKind, item, selfUserId]);

  const onEdit = useCallback(() => {
    setActionSheetVisible(false);
    setMenuAnchor(null);
    setMessageChatComposeEdit(chat.telegram_chat_id, item);
  }, [chat.telegram_chat_id, item]);

  const onDelete = useCallback(() => {
    setActionSheetVisible(false);
    setMenuAnchor(null);
    const messageId = Number(item.telegram_message_id);
    if (!Number.isFinite(messageId) || messageId <= 0) return;
    // Optimistic remove — list + cache update immediately.
    removeOutgoingChatMessage(chat.telegram_chat_id, messageId);
    void deleteTelegramChatMessages(chat.telegram_chat_id, [messageId]).then((result) => {
      if (!result.ok) {
        appWarn("[message-delete]", result.error, {
          chatId: chat.telegram_chat_id,
          messageId,
        });
      }
    });
  }, [chat.telegram_chat_id, item.telegram_message_id]);

  if (columnWidthPx <= 0) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          width: "100%",
          alignSelf: "stretch",
          minHeight: MESSAGE_BUBBLE_LINE_HEIGHT_PX,
        }}
      >
        <View style={{ width: MESSAGE_BUBBLE_AVATAR_PX, height: MESSAGE_BUBBLE_AVATAR_PX, flexShrink: 0 }} />
        <View style={{ width: MESSAGE_BUBBLE_AVATAR_GAP_PX }} />
      </View>
    );
  }

  return (
    <View
      ref={rowRef}
      style={{
        flexDirection: "row",
        alignItems: isCompactSingleLineRow ? "center" : "flex-end",
        width: "100%",
        alignSelf: "stretch",
      }}
    >
      <ProfileOpenHitTarget
        label={t("messages.profile.openA11y")}
        onPress={openSenderProfile}
        style={{
          width: MESSAGE_BUBBLE_AVATAR_PX,
          height: MESSAGE_BUBBLE_AVATAR_PX,
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <MessageChatAvatarSlot
          iconUrl={iconUrl}
          initials={avatarInitials}
          sizePx={MESSAGE_BUBBLE_AVATAR_PX}
          colors={colors}
          scheme={colorScheme}
          loadEnabled={avatarFetchEnabled}
          fetchPriority="high"
        />
      </ProfileOpenHitTarget>
      <View style={{ width: MESSAGE_BUBBLE_AVATAR_GAP_PX }} />
        <View
          ref={bubblePressableRef}
          style={{
            alignSelf: "flex-start",
            maxWidth: bubbleMaxWidth,
          }}
        >
          {Platform.OS !== "web" && bubbleMaxWidth > 0 ? (
            <Text
              style={[
                typographyRect15,
                {
                  position: "absolute",
                  opacity: 0,
                  width: bubbleInnerMaxWidth,
                  left: 0,
                  top: 0,
                  zIndex: -1,
                  pointerEvents: "none",
                  fontSize: MESSAGE_BUBBLE_FONT_SIZE_PX,
                  lineHeight: MESSAGE_BUBBLE_LINE_HEIGHT_PX,
                },
              ]}
              onTextLayout={onMeasureTextLayout}
            >
              {measureText}
            </Text>
          ) : null}
          <Pressable
            onLongPress={showActionSheet ? onBubbleLongPress : undefined}
            onContextMenu={showActionSheet ? onContextMenu : undefined}
            delayLongPress={400}
          >
          <View
            ref={bubbleFillRef}
            nativeID={`message-bubble-fill-${item.telegram_message_id}`}
            style={[
              {
                alignSelf: "flex-start",
                ...(showMedia
                  ? {
                      backgroundColor: "transparent",
                      paddingHorizontal: 0,
                      paddingVertical: 0,
                      borderRadius: 0,
                    }
                  : {
                      borderRadius: MESSAGE_BUBBLE_BORDER_RADIUS_PX,
                      paddingLeft: MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX,
                      paddingRight:
                        MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX + webTimeOverflowPx,
                      paddingVertical: isCompactSingleLineRow
                        ? 0
                        : MESSAGE_BUBBLE_PADDING_VERTICAL_PX,
                      ...(isCompactSingleLineRow
                        ? {
                            height: MESSAGE_BUBBLE_COMPACT_HEIGHT_PX,
                            minHeight: MESSAGE_BUBBLE_COMPACT_HEIGHT_PX,
                            justifyContent: "center",
                          }
                        : null),
                      backgroundColor: colors.undercover,
                      overflow: "visible",
                      ...(Platform.OS === "web"
                        ? ({
                            width: "max-content",
                            maxWidth: bubbleMaxWidth,
                            boxSizing: "border-box",
                          } as object)
                        : null),
                    }),
              },
              bubbleWidth != null && bubbleWidth > 0 ? { width: bubbleWidth } : null,
            ]}
          >
            <MessageChatBubbleBody
              chatId={chat.telegram_chat_id}
              item={item}
              chatKind={chatKind}
              colors={colors}
              maxWidthPx={bubbleContentWidthPx}
              mediaColumnMaxWidthPx={bubbleInnerMaxWidth}
              metaPlacement={metaPlacement}
              metaReserveWidthPx={metaWidthPx}
              compactSingleLine={isCompactSingleLineRow}
              onMediaDisplaySizeChange={(widthPx) => setLiveMediaWidthPx(widthPx)}
              peerUserId={chat.peer_user_id}
              selfUserId={selfUserId}
              peerIsBot={
                Boolean(chat.peer_is_bot) ||
                ((chatKind ?? chat.chat_kind) === "private" &&
                  Boolean(chat.peer_username?.toLowerCase().endsWith("bot")))
              }
              emojiContentActive={contentActive && rowInView}
              mediaFetchEnabled={contentActive}
              deferFullMediaFetch={
                // All kinds: full bytes only near the viewport. Painted-but-far
                // rows used to fetch every full JPEG at once and freeze the tab.
                !(contentActive && mediaNearView)
              }
            />
          </View>
          </Pressable>
        </View>
      <MessageChatMessageContextMenu
        visible={actionSheetVisible}
        anchor={menuAnchor}
        colors={colors}
        canEdit={canEdit}
        canDelete={canDelete}
        onClose={() => {
          setActionSheetVisible(false);
          setMenuAnchor(null);
        }}
        onReply={onReply}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </View>
  );
}
