import { useEffect, useMemo, useState } from "react";
import { Platform, Text, View, type StyleProp, type TextStyle } from "react-native";
import { buildApiUrl } from "../../../api/_base";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { typographyRect15, type ThemeColors } from "../../theme";
import { useTelegram } from "../Telegram";
import { formatMessageChatBubbleTime } from "./formatMessageChatBubbleTime";
import { resolveMessageSenderDisplayName } from "./resolveMessageSenderDisplayName";
import type {
  MessageChatContentKind,
  MessageChatHistoryItem,
  MessageChatKind,
  MessageChatReplyPreview,
} from "./messageChatHistoryTypes";
import { isDisplayableMediaMessage, messageShowsOutgoingChecks, resolveMessageOutgoingStatus, resolveOutgoingStatusForDisplay, shouldShowMessageSenderHeader } from "./messageChatHistoryTypes";
import {
  MESSAGE_BUBBLE_BORDER_RADIUS_PX,
  MESSAGE_BUBBLE_FONT_SIZE_PX,
  MESSAGE_BUBBLE_INLINE_EMOJI_SIZE_PX,
  MESSAGE_BUBBLE_LINE_HEIGHT_PX,
  MESSAGE_BUBBLE_META_GAP_PX,
  MESSAGE_BUBBLE_INLINE_META_BASELINE_OFFSET_PX,
  MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX,
  MESSAGE_BUBBLE_PADDING_VERTICAL_PX,
  MESSAGE_BUBBLE_MEDIA_PROGRESS_SLOT_HEIGHT_PX,
  MESSAGE_BUBBLE_REPLY_BAR_WIDTH_PX,
  MESSAGE_BUBBLE_REPLY_BG_ACCENT_ALPHA,
  MESSAGE_BUBBLE_REPLY_MARGIN_BOTTOM_PX,
  MESSAGE_BUBBLE_REPLY_PADDING_PX,
  MESSAGE_BUBBLE_TIME_FONT_SIZE_PX,
  MESSAGE_BUBBLE_TIME_LINE_HEIGHT_PX,
  messageBubbleMediaMetaBottomPx,
  messageChatBubbleTextWebWrapStyle,
} from "./messageChatLayout";
import type { BubbleMetaPlacement } from "./messageChatBubbleMeasure";
import {
  MessageChatMediaContent,
  messageMediaShowsProgressBar,
  resolveMessageMediaDimensions,
} from "./MessageChatMediaContent";
import {
  MessageChatOutgoingChecks,
} from "./MessageChatOutgoingChecks";
import {
  MessageChatCallArrow,
  messageChatCallArrowWidthPx,
} from "./MessageChatCallArrow";
import { formatMessageCallLabel } from "./formatMessageCallLabel";
import { groupSenderDisplayColor } from "./groupSenderColor";
import { MessageChatLinkifiedText } from "./MessageChatLinkifiedText";
import { SpecialTelegramUserName } from "./SpecialTelegramUserName";
import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";

type Props = {
  chatId: number;
  item: MessageChatHistoryItem;
  chatKind: MessageChatKind | null;
  colors: ThemeColors;
  maxWidthPx: number;
  mediaColumnMaxWidthPx?: number;
  metaPlacement?: BubbleMetaPlacement;
  metaReserveWidthPx?: number;
  /** One-line inline text + time; row uses avatar height. */
  compactSingleLine?: boolean;
  onMediaDisplaySizeChange?: (widthPx: number, heightPx: number) => void;
  peerUserId?: number | null;
  selfUserId?: number | null;
  /** Message row is on-screen — unlock inline emoji fetches in bubble text. */
  emojiContentActive?: boolean;
  /**
   * When true, fetch photo/video preview (and stickers) for painted rows.
   * Defaults to {@link emojiContentActive}.
   */
  mediaFetchEnabled?: boolean;
  /**
   * When true, defer full-resolution photo/video until the row enters the media
   * prefetch band (tdesktop nearby preload).
   */
  deferFullMediaFetch?: boolean;
};

function resolveMediaUrl(chatId: number, messageId: number): string {
  return buildApiUrl(
    `/api/telegram-messages-media?chat_id=${chatId}&message_id=${messageId}`,
  );
}

function MessageChatBubbleTextContent({
  bodyText,
  bodyTextSegments,
  timeLabel,
  outgoingStatus,
  isOutgoing = false,
  colors,
  maxWidthPx,
  textStyle,
  marginTop = 0,
  metaPlacement = "stacked",
  metaReserveWidthPx = 0,
  callIndicator = null,
  emojiContentActive = true,
  chatId,
}: {
  bodyText: string;
  bodyTextSegments?: FormattedTextSegment[] | null;
  timeLabel: string;
  outgoingStatus: ReturnType<typeof resolveMessageOutgoingStatus>;
  isOutgoing?: boolean;
  colors: ThemeColors;
  maxWidthPx: number;
  textStyle: StyleProp<TextStyle>;
  marginTop?: number;
  metaPlacement?: BubbleMetaPlacement;
  metaReserveWidthPx?: number;
  callIndicator?: { outgoing: boolean; successful: boolean } | null;
  emojiContentActive?: boolean;
  chatId: number;
}) {
  if (!bodyText && !timeLabel) return null;

  const timeRow = timeLabel ? (
    <MessageChatBubbleTimeRow
      timeLabel={timeLabel}
      colors={colors}
      outgoingStatus={outgoingStatus}
      isOutgoing={isOutgoing}
      alignSelf={metaPlacement === "stacked" ? "flex-end" : undefined}
      alignWithBodyBaseline={metaPlacement === "inline" || metaPlacement === "lastLine"}
      callIndicator={callIndicator}
    />
  ) : null;

  const metaPadRight =
    metaPlacement === "lastLine" && metaReserveWidthPx > 0
      ? metaReserveWidthPx + MESSAGE_BUBBLE_META_GAP_PX
      : 0;

  if (metaPlacement === "inline" && bodyText && timeLabel) {
    const inlineTextStyle = [
      textStyle,
      { textAlign: "left" as const, flexShrink: 0 },
      Platform.OS === "web" ? ({ whiteSpace: "nowrap", flexGrow: 0 } as object) : null,
    ];
    return (
      <View
        style={{
          marginTop,
          flexDirection: "row",
          alignItems: "baseline",
          alignSelf: "flex-start",
          flexWrap: "nowrap",
        }}
      >
        <MessageChatLinkifiedText
          text={bodyText}
          segments={bodyTextSegments}
          style={inlineTextStyle}
          numberOfLines={1}
          nowrap
          emojiSizePx={MESSAGE_BUBBLE_INLINE_EMOJI_SIZE_PX}
          emojiFetchEnabled={emojiContentActive}
          enrichStandardEmojis={emojiContentActive}
          chatId={chatId}
        />
        <View
          style={{
            marginLeft: MESSAGE_BUBBLE_META_GAP_PX,
            flexShrink: 0,
            ...(Platform.OS === "web"
              ? ({ display: "inline-flex", verticalAlign: "baseline" } as object)
              : { paddingBottom: MESSAGE_BUBBLE_INLINE_META_BASELINE_OFFSET_PX }),
          }}
        >
          {timeRow}
        </View>
      </View>
    );
  }

  if (metaPlacement === "lastLine" && bodyText && timeLabel) {
    return (
      <View
        style={{
          marginTop,
          alignSelf: "flex-start",
          maxWidth: maxWidthPx,
          minWidth: 0,
          position: "relative",
        }}
      >
        <MessageChatLinkifiedText
          text={bodyText}
          segments={bodyTextSegments}
          style={[
            textStyle,
            {
              textAlign: "left",
              paddingRight: metaPadRight,
              ...(Platform.OS === "web" ? ({ boxSizing: "border-box" } as object) : null),
            },
          ]}
          emojiSizePx={MESSAGE_BUBBLE_INLINE_EMOJI_SIZE_PX}
          emojiFetchEnabled={emojiContentActive}
          enrichStandardEmojis={emojiContentActive}
          chatId={chatId}
        />
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            flexDirection: "row",
            justifyContent: "flex-end",
            alignItems: "baseline",
            zIndex: 1,
            pointerEvents: "none",
          }}
        >
          {timeRow}
        </View>
      </View>
    );
  }

  return (
    <View
      style={{
        marginTop,
        alignSelf: "flex-start",
        maxWidth: maxWidthPx,
        minWidth: 0,
      }}
    >
      {bodyText ? (
        <MessageChatLinkifiedText
          text={bodyText}
          segments={bodyTextSegments}
          style={[textStyle, { textAlign: "left" }]}
          emojiSizePx={MESSAGE_BUBBLE_INLINE_EMOJI_SIZE_PX}
          emojiFetchEnabled={emojiContentActive}
          enrichStandardEmojis={emojiContentActive}
          chatId={chatId}
        />
      ) : null}
      {timeRow ? (
        <View
          style={{
            marginTop: bodyText ? 2 : 0,
            alignSelf: "stretch",
            flexDirection: "row",
            justifyContent: "flex-end",
          }}
        >
          {timeRow}
        </View>
      ) : null}
    </View>
  );
}

function MessageChatBubbleTimeRow({
  timeLabel,
  colors,
  outgoingStatus,
  isOutgoing = false,
  alignSelf = "flex-end",
  alignWithBodyBaseline = false,
  lightOnMedia = false,
  callIndicator = null,
}: {
  timeLabel: string;
  colors: ThemeColors;
  outgoingStatus: ReturnType<typeof resolveMessageOutgoingStatus>;
  isOutgoing?: boolean;
  alignSelf?: "flex-end" | "flex-start";
  alignWithBodyBaseline?: boolean;
  lightOnMedia?: boolean;
  callIndicator?: { outgoing: boolean; successful: boolean } | null;
}) {
  const showChecks =
    isOutgoing &&
    (outgoingStatus === "delivered" || outgoingStatus === "read");
  const metaStyle = {
    fontSize: MESSAGE_BUBBLE_TIME_FONT_SIZE_PX,
    lineHeight: MESSAGE_BUBBLE_TIME_LINE_HEIGHT_PX,
    color: lightOnMedia ? "rgba(255,255,255,0.92)" : colors.secondary,
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    includeFontPadding: false,
    ...(alignWithBodyBaseline && Platform.OS === "web"
      ? ({ display: "inline" } as object)
      : null),
  } as const;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf,
        overflow: "visible",
        ...(lightOnMedia && Platform.OS === "web"
          ? ({ textShadow: "0 1px 2px rgba(0,0,0,0.65)" } as object)
          : null),
        ...(alignWithBodyBaseline && Platform.OS === "web"
          ? ({ display: "inline-flex", verticalAlign: "baseline" } as object)
          : null),
        ...(!alignWithBodyBaseline
          ? { minHeight: MESSAGE_BUBBLE_TIME_LINE_HEIGHT_PX }
          : null),
      }}
    >
      {callIndicator ? (
        <View style={{ marginRight: 2, justifyContent: "center" }}>
          <MessageChatCallArrow
            outgoing={callIndicator.outgoing}
            successful={callIndicator.successful}
          />
        </View>
      ) : null}
      <Text style={metaStyle}>{timeLabel}</Text>
      {showChecks ? (
        <MessageChatOutgoingChecks
          status={outgoingStatus!}
          colors={colors}
        />
      ) : null}
    </View>
  );
}

function messageChatOnMediaMetaTextStyle(colors: ThemeColors) {
  return {
    fontSize: MESSAGE_BUBBLE_TIME_FONT_SIZE_PX,
    lineHeight: MESSAGE_BUBBLE_TIME_LINE_HEIGHT_PX,
    color: "rgba(255,255,255,0.92)",
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    ...(Platform.OS === "web" ? ({ textShadow: "0 1px 2px rgba(0,0,0,0.65)" } as object) : null),
  } as const;
}

function replyQuoteAccentBackground(accentColor: string, fallback: string): string {
  const trimmed = accentColor.trim();
  const m6 = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  if (m6) {
    const n = parseInt(m6[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${MESSAGE_BUBBLE_REPLY_BG_ACCENT_ALPHA})`;
  }
  const m3 = /^#?([0-9a-f]{3})$/i.exec(trimmed);
  if (m3) {
    const t = m3[1];
    const r = parseInt(t[0] + t[0], 16);
    const g = parseInt(t[1] + t[1], 16);
    const b = parseInt(t[2] + t[2], 16);
    return `rgba(${r},${g},${b},${MESSAGE_BUBBLE_REPLY_BG_ACCENT_ALPHA})`;
  }
  return fallback;
}

function MessageChatReplyBlock({
  reply,
  colors,
  maxWidthPx,
  telegramChatId,
  emojiContentActive = true,
}: {
  reply: MessageChatReplyPreview;
  colors: ThemeColors;
  maxWidthPx: number;
  telegramChatId: number;
  emojiContentActive?: boolean;
}) {
  const { colorScheme } = useTelegram();
  const barColor = groupSenderDisplayColor(
    reply.sender_user_id,
    null,
    reply.sender_name,
    colorScheme,
    reply.sender_accent_color_light,
    reply.sender_accent_color_dark,
  );
  const replyBackground = replyQuoteAccentBackground(barColor, colors.undercover);

  return (
    <View
      style={{
        maxWidth: maxWidthPx,
        marginBottom: MESSAGE_BUBBLE_REPLY_MARGIN_BOTTOM_PX,
        borderRadius: 0,
        overflow: "hidden",
        backgroundColor: replyBackground,
        position: "relative",
      }}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: MESSAGE_BUBBLE_REPLY_BAR_WIDTH_PX,
          backgroundColor: barColor,
        }}
      />
      <View
        style={{
          paddingTop: MESSAGE_BUBBLE_REPLY_PADDING_PX,
          paddingRight: MESSAGE_BUBBLE_REPLY_PADDING_PX,
          paddingBottom: MESSAGE_BUBBLE_REPLY_PADDING_PX,
          paddingLeft: MESSAGE_BUBBLE_REPLY_PADDING_PX + MESSAGE_BUBBLE_REPLY_BAR_WIDTH_PX,
          minWidth: 0,
        }}
      >
        <SpecialTelegramUserName
          name={reply.sender_name}
          telegramUserId={reply.sender_user_id}
          telegramChatId={telegramChatId}
          emojiStatusCustomEmojiId={reply.sender_emoji_status_custom_emoji_id ?? null}
          emojiStatusPriority
          textStyle={{
            ...typographyRect15,
            fontSize: MESSAGE_BUBBLE_FONT_SIZE_PX,
            lineHeight: MESSAGE_BUBBLE_LINE_HEIGHT_PX,
            fontWeight: "500",
            color: barColor,
            textAlign: "left",
            ...(Platform.OS === "web" ? ({ fontFamily: WEB_UI_SANS_STACK } as object) : null),
          }}
        />
        <MessageChatLinkifiedText
          text={reply.text}
          segments={reply.text_segments}
          numberOfLines={2}
          chatId={telegramChatId}
          emojiSizePx={MESSAGE_BUBBLE_INLINE_EMOJI_SIZE_PX}
          emojiFetchEnabled={emojiContentActive}
          enrichStandardEmojis={emojiContentActive}
          style={[
            typographyRect15,
            {
              fontSize: MESSAGE_BUBBLE_FONT_SIZE_PX,
              lineHeight: MESSAGE_BUBBLE_LINE_HEIGHT_PX,
              fontWeight: "400",
              color: colors.primary,
              textAlign: "left",
            },
            Platform.OS === "web" ? ({ fontFamily: WEB_UI_SANS_STACK } as object) : null,
          ]}
        />
      </View>
    </View>
  );
}

export function MessageChatBubbleBody({
  chatId,
  item,
  chatKind,
  colors,
  maxWidthPx,
  mediaColumnMaxWidthPx,
  metaPlacement = "stacked",
  metaReserveWidthPx = 0,
  compactSingleLine = false,
  onMediaDisplaySizeChange,
  peerUserId = null,
  selfUserId = null,
  emojiContentActive = true,
  mediaFetchEnabled,
  deferFullMediaFetch,
}: Props) {
  const mediaLoadEnabled = mediaFetchEnabled ?? emojiContentActive;
  const deferFullMedia = deferFullMediaFetch ?? !mediaLoadEnabled;
  const { t } = useAppStrings();
  const { colorScheme } = useTelegram();
  const [liveMediaSize, setLiveMediaSize] = useState<{ widthPx: number; heightPx: number } | null>(
    null,
  );
  const timeLabel = formatMessageChatBubbleTime(item.sent_at);
  const outgoingStatus = resolveOutgoingStatusForDisplay(item, chatKind, {
    chat_kind: chatKind,
    telegram_chat_id: chatId,
    peer_user_id: peerUserId,
  });
  const showOutgoingChecks = messageShowsOutgoingChecks(item, { peerUserId, selfUserId });
  const senderDisplayName = resolveMessageSenderDisplayName(
    item.sender_name,
    item.sender_user_id,
    chatId,
  );
  const showSenderHeader = shouldShowMessageSenderHeader(chatKind, item);
  const showChannelBadge = Boolean(item.sender_is_channel) && chatKind !== "channel";
  const contentKind: MessageChatContentKind = item.content_kind ?? "other";
  const isCall = contentKind === "call";
  const bodyText = isCall
    ? formatMessageCallLabel(item.is_outgoing, t)
    : item.text.trim();
  const showMedia = isDisplayableMediaMessage(item);
  const mediaHasProgress = messageMediaShowsProgressBar(contentKind);
  const overlayMediaMeta =
    showMedia &&
    !bodyText &&
    (contentKind === "video" ||
      contentKind === "animation" ||
      contentKind === "photo" ||
      contentKind === "sticker");
  const mediaUrl = showMedia ? resolveMediaUrl(chatId, item.telegram_message_id) : null;
  const callIndicator = isCall
    ? { outgoing: item.is_outgoing, successful: Boolean(item.call_success) }
    : null;
  const replyTo = item.reply_to ?? null;
  const mediaLayoutMaxWidthPx = Math.max(mediaColumnMaxWidthPx ?? maxWidthPx, maxWidthPx);
  const { widthPx: mediaWidthPx, heightPx: mediaHeightPx } = resolveMessageMediaDimensions(
    mediaLayoutMaxWidthPx,
    item.media_width,
    item.media_height,
    contentKind,
  );
  const displayMediaWidthPx = liveMediaSize?.widthPx ?? mediaWidthPx;
  const displayMediaHeightPx = liveMediaSize?.heightPx ?? mediaHeightPx;
  const mediaBlockHeightPx =
    displayMediaHeightPx +
    (mediaHasProgress ? MESSAGE_BUBBLE_MEDIA_PROGRESS_SLOT_HEIGHT_PX : 0);

  useEffect(() => {
    setLiveMediaSize(null);
  }, [item.telegram_message_id, contentKind, mediaUrl]);

  const handleMediaDisplaySizeChange = (widthPx: number, heightPx: number) => {
    setLiveMediaSize((current) =>
      current?.widthPx === widthPx && current?.heightPx === heightPx
        ? current
        : { widthPx, heightPx },
    );
    onMediaDisplaySizeChange?.(widthPx, heightPx);
  };

  const senderColor = groupSenderDisplayColor(
    item.sender_user_id,
    item.sender_chat_id ?? null,
    item.sender_name,
    colorScheme,
    item.sender_accent_color_light,
    item.sender_accent_color_dark,
  );

  const textStyle = useMemo(
    () => [
      typographyRect15,
      {
        fontSize: MESSAGE_BUBBLE_FONT_SIZE_PX,
        lineHeight: MESSAGE_BUBBLE_LINE_HEIGHT_PX,
        fontWeight: "400" as const,
        color: colors.primary,
        includeFontPadding: false,
        ...(Platform.OS === "web"
          ? ({ fontFamily: WEB_UI_SANS_STACK, ...messageChatBubbleTextWebWrapStyle } as object)
          : null),
      },
    ],
    [colors.primary],
  );

  const metaStyle = {
    fontSize: MESSAGE_BUBBLE_TIME_FONT_SIZE_PX,
    lineHeight: MESSAGE_BUBBLE_TIME_LINE_HEIGHT_PX,
    color: colors.secondary,
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
  } as const;

  return (
    <View
      style={{
        maxWidth: maxWidthPx,
        alignSelf: "flex-start",
        width: showMedia && !bodyText ? displayMediaWidthPx : showMedia && bodyText ? mediaWidthPx : undefined,
      }}
    >
      {replyTo ? (
        <MessageChatReplyBlock
          reply={replyTo}
          colors={colors}
          maxWidthPx={maxWidthPx}
          telegramChatId={chatId}
          emojiContentActive={emojiContentActive}
        />
      ) : null}

      {showSenderHeader ? (
        <SpecialTelegramUserName
          name={senderDisplayName}
          telegramUserId={item.sender_user_id}
          telegramChatId={chatId}
          emojiStatusCustomEmojiId={item.sender_emoji_status_custom_emoji_id ?? null}
          emojiStatusPriority
          textStyle={{
            ...typographyRect15,
            fontSize: MESSAGE_BUBBLE_FONT_SIZE_PX,
            lineHeight: MESSAGE_BUBBLE_LINE_HEIGHT_PX,
            fontWeight: "500",
            color: senderColor,
            textAlign: "left",
            ...(Platform.OS === "web" ? ({ fontFamily: WEB_UI_SANS_STACK } as object) : null),
          }}
        />
      ) : null}

      {showChannelBadge ? (
        <Text
          style={[
            metaStyle,
            {
              marginTop: showSenderHeader ? 2 : 0,
              marginBottom: bodyText || showMedia ? 4 : 0,
            },
          ]}
        >
          {t("messages.channelBadge")}
        </Text>
      ) : null}

      {showMedia && mediaUrl ? (
        <View
          style={{
            marginTop: showSenderHeader || showChannelBadge ? 4 : 0,
            marginBottom: bodyText ? 6 : 0,
            position: "relative",
            alignSelf: "flex-start",
            width: displayMediaWidthPx,
            minHeight: mediaBlockHeightPx,
            overflow: "hidden",
            borderRadius: 0,
          }}
        >
          <MessageChatMediaContent
            uri={mediaUrl}
            contentKind={contentKind}
            widthPx={mediaWidthPx}
            heightPx={mediaHeightPx}
            maxWidthPx={mediaLayoutMaxWidthPx}
            colors={colors}
            onDisplaySizeChange={handleMediaDisplaySizeChange}
            mediaFetchEnabled={mediaLoadEnabled}
            deferFullMediaFetch={deferFullMedia}
          />
          {contentKind === "animation" && overlayMediaMeta ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 8,
                top: 6,
                zIndex: 4,
              }}
            >
              <Text style={messageChatOnMediaMetaTextStyle(colors)}>gif</Text>
            </View>
          ) : null}
          {overlayMediaMeta && timeLabel ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                right: MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX,
                bottom: messageBubbleMediaMetaBottomPx(mediaHasProgress),
                zIndex: 4,
              }}
            >
              <MessageChatBubbleTimeRow
                timeLabel={timeLabel}
                colors={colors}
                outgoingStatus={outgoingStatus}
                isOutgoing={showOutgoingChecks}
                alignSelf="flex-end"
                lightOnMedia
                callIndicator={callIndicator}
              />
            </View>
          ) : null}
        </View>
      ) : null}

      {bodyText || (timeLabel && !showMedia) ? (
        <View
          style={
            showMedia && bodyText
              ? {
                  alignSelf: "flex-start",
                  maxWidth: maxWidthPx,
                  marginTop: 4,
                  borderRadius: MESSAGE_BUBBLE_BORDER_RADIUS_PX,
                  paddingHorizontal: MESSAGE_BUBBLE_PADDING_HORIZONTAL_PX,
                  paddingVertical: MESSAGE_BUBBLE_PADDING_VERTICAL_PX,
                  backgroundColor: colors.undercover,
                }
              : undefined
          }
        >
          <MessageChatBubbleTextContent
            bodyText={bodyText}
            bodyTextSegments={item.text_segments}
            timeLabel={showMedia && bodyText ? timeLabel : showMedia ? "" : timeLabel}
            outgoingStatus={outgoingStatus}
            isOutgoing={showOutgoingChecks}
            colors={colors}
            maxWidthPx={maxWidthPx}
            textStyle={textStyle}
            marginTop={
              compactSingleLine
                ? 0
                : showMedia && bodyText
                  ? 0
                  : showSenderHeader || showChannelBadge || showMedia
                    ? 4
                    : 0
            }
            metaPlacement={metaPlacement}
            metaReserveWidthPx={metaReserveWidthPx}
            callIndicator={callIndicator}
            emojiContentActive={emojiContentActive}
            chatId={chatId}
          />
        </View>
      ) : null}
    </View>
  );
}
