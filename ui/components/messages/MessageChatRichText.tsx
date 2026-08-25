import { createElement, useEffect, useMemo } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { FormattedTextSegment } from "../../../shared/formattedTextSegments";
import {
  normalizeFormattedTextSegments,
  segmentsContainTelegramEmoji,
  enrichSegmentsWithStandardEmojis,
  isCustomEmojiTextLabel,
} from "../../../shared/formattedTextSegments";
import { openMessageLinkUrl } from "./openMessageLinkUrl";
import { enrichSegmentsWithBotCommands } from "./parseMessageBotCommands";
import { enrichSegmentsWithMentions } from "./enrichMessageMentions";
import { logPageDisplay } from "../../pageDisplayLog";
import {
  enrichServiceChatMessageForCodeSpoilers,
  isTelegramServiceNotificationsChat,
} from "./enrichServiceChatCodeSpoilers";
import { MessageChatSpoilerCode } from "./MessageChatSpoilerCode";
import { messageChatBubbleTextWebWrapStyle, inlineEmojiHostCss } from "./messageChatLayout";
import { MessageChatInlineTgsEmoji } from "./MessageChatInlineTgsEmoji";
import { parseMessageTextLinks } from "./parseMessageTextLinks";
import { telegramEmojiDebug } from "./telegramEmojiDebug";
import { submitChatBotCommand } from "../../telegram/submitChatBotCommand";
import { useAppStrings } from "../../../locales/AppStringsContext";

const MESSAGE_LINK_COLOR = "#3390ec";
const DEFAULT_INLINE_EMOJI_SIZE_PX = 20;

type Props = {
  text: string;
  segments?: FormattedTextSegment[] | null;
  style: StyleProp<TextStyle>;
  linkColor?: string;
  emojiSizePx?: number;
  /** Lower canvas quality + lazy fetch for chat-list rows. */
  lowPriorityEmoji?: boolean;
  /** When false, defer custom/animated emoji network fetches (list rows off-screen). */
  emojiFetchEnabled?: boolean;
  /** Chat-list rows: mirror status-badge fetch gating (row visible / active). */
  emojiFetchPriority?: boolean;
  /** Single-line bubble row: do not break words (inline time + checks). */
  nowrap?: boolean;
  /** Open-chat bubbles: split Unicode into animated emoji fetches. Off for list previews. */
  enrichStandardEmojis?: boolean;
  /** When set, tapping a bot command (e.g. /start) re-sends it to this chat. */
  chatId?: number;
  /** Peer user id — used with chatId to detect Telegram service notifications (777000). */
  peerUserId?: number | null;
  /** Message sender — service login codes also key off sender 777000. */
  senderUserId?: number | null;
  /** Solid fill under login-code white-noise overlay (bubble background). */
  spoilerOverlayColor?: string;
  onBotCommandPress?: (command: string) => void;
} & Pick<TextProps, "numberOfLines">;

function handleRichTextSegmentPress(
  segment: FormattedTextSegment,
  options: { chatId?: number; onBotCommandPress?: (command: string) => void },
): void {
  if (segment.kind === "link") {
    openMessageLinkUrl(segment.url);
    return;
  }
  if (segment.kind === "bot_command") {
    if (options.onBotCommandPress) {
      options.onBotCommandPress(segment.command);
      return;
    }
    if (options.chatId != null) {
      void submitChatBotCommand(options.chatId, segment.command);
    }
  }
}

function flattenSegmentTextForSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function flattenSegmentsForSingleLine(segments: FormattedTextSegment[]): FormattedTextSegment[] {
  return segments.map((segment) => {
    if (segment.kind === "text") {
      return { ...segment, text: flattenSegmentTextForSingleLine(segment.text) };
    }
    if (
      segment.kind === "link" ||
      segment.kind === "bot_command" ||
      segment.kind === "spoiler_code"
    ) {
      return { ...segment, text: flattenSegmentTextForSingleLine(segment.text) };
    }
    return segment;
  });
}

function resolveSegments(
  text: string,
  segments: FormattedTextSegment[] | null | undefined,
  options?: {
    enrichStandardEmojis?: boolean;
    singleLine?: boolean;
    hideServiceCodes?: boolean;
  },
): FormattedTextSegment[] {
  const normalized = segments ? normalizeFormattedTextSegments(segments) : null;
  const base =
    normalized ??
    (parseMessageTextLinks(text) as FormattedTextSegment[]);
  let resolved: FormattedTextSegment[];
  if (!base.length) {
    resolved = text ? [{ kind: "text", text }] : [];
  } else {
    resolved = enrichSegmentsWithBotCommands(base);
  }
  resolved = enrichSegmentsWithMentions(resolved);
  if (options?.hideServiceCodes) {
    // Prefer full message text so dropped/unknown entity kinds cannot leave
    // login digits only on the plain `text` prop (visible, unspoiled path).
    resolved = enrichServiceChatMessageForCodeSpoilers(text, resolved);
  }
  if (options?.enrichStandardEmojis) {
    resolved = enrichSegmentsWithStandardEmojis(resolved);
  }
  if (options?.singleLine) {
    resolved = flattenSegmentsForSingleLine(resolved);
  }
  return resolved;
}

function textStyleFromProp(style: StyleProp<TextStyle>): TextStyle {
  return StyleSheet.flatten(style) ?? {};
}

function textStyleToDomCss(style: TextStyle, options?: { omitLayout?: boolean }): Record<string, string | number> {
  const css: Record<string, string | number> = {};
  if (style.fontFamily != null) css.fontFamily = String(style.fontFamily);
  if (typeof style.fontSize === "number") css.fontSize = style.fontSize;
  if (typeof style.lineHeight === "number") css.lineHeight = `${style.lineHeight}px`;
  else if (style.lineHeight != null) css.lineHeight = style.lineHeight;
  if (style.color != null) css.color = String(style.color);
  if (style.fontWeight != null) css.fontWeight = style.fontWeight as string | number;
  if (style.textDecorationLine === "underline") css.textDecoration = "underline";
  if (typeof style.paddingRight === "number") css.paddingRight = style.paddingRight;
  if (typeof style.paddingLeft === "number") css.paddingLeft = style.paddingLeft;
  if (typeof style.paddingTop === "number") css.paddingTop = style.paddingTop;
  if (typeof style.paddingBottom === "number") css.paddingBottom = style.paddingBottom;
  if (style.textAlign != null) css.textAlign = style.textAlign;
  if (!options?.omitLayout) {
    if (style.flex != null) css.flex = style.flex as number;
    if (style.minWidth != null) css.minWidth = style.minWidth as number;
    if (typeof style.width === "number") css.width = style.width;
    if (typeof style.maxWidth === "number") css.maxWidth = style.maxWidth;
  }
  return css;
}

function renderTelegramEmojiNode(
  segment: Extract<FormattedTextSegment, { kind: "custom_emoji" | "animated_emoji" }>,
  sizePx: number,
  lowPriority?: boolean,
  fetchEnabled = true,
  fetchPriority?: boolean,
) {
  const textLabel = segment.kind === "custom_emoji" && isCustomEmojiTextLabel(segment.text);
  return (
    <MessageChatInlineTgsEmoji
      customEmojiId={segment.kind === "custom_emoji" ? segment.custom_emoji_id : undefined}
      emoji={segment.kind === "animated_emoji" ? segment.emoji : undefined}
      sizePx={sizePx}
      fallbackText={segment.text}
      lowPriority={lowPriority}
      priority={Boolean(fetchPriority)}
      fetchEnabled={fetchEnabled}
      textLabel={textLabel}
    />
  );
}

function RichTextWebRow({
  segments,
  style,
  linkColor,
  emojiSizePx,
  numberOfLines,
  lowPriorityEmoji,
  emojiFetchEnabled = true,
  emojiFetchPriority,
  nowrap = false,
  chatId,
  onBotCommandPress,
  revealCodeLabel,
  spoilerOverlayColor,
}: {
  segments: FormattedTextSegment[];
  style: TextStyle;
  linkColor: string;
  emojiSizePx: number;
  numberOfLines?: number;
  lowPriorityEmoji?: boolean;
  emojiFetchEnabled?: boolean;
  emojiFetchPriority?: boolean;
  nowrap?: boolean;
  chatId?: number;
  onBotCommandPress?: (command: string) => void;
  revealCodeLabel?: string;
  spoilerOverlayColor?: string;
}) {
  const wrapStyle =
    Platform.OS === "web" && !nowrap ? (messageChatBubbleTextWebWrapStyle as TextStyle) : null;
  const textStyle = wrapStyle ? { ...style, ...wrapStyle } : style;
  const nowrapStyle =
    Platform.OS === "web" && nowrap ? ({ whiteSpace: "nowrap" } as TextStyle) : null;
  const resolvedTextStyle = nowrapStyle ? { ...textStyle, ...nowrapStyle } : textStyle;
  const linkStyle = {
    ...resolvedTextStyle,
    color: linkColor,
    textDecorationLine: "underline" as const,
    ...(Platform.OS === "web"
      ? ({
          cursor: "pointer",
          ...(nowrap ? null : messageChatBubbleTextWebWrapStyle),
        } as object)
      : null),
  };

  if (Platform.OS === "web") {
    const singleLine = numberOfLines === 1 || nowrap;
    const listPreviewTruncate = numberOfLines === 1 && !nowrap;
    const inlineWrapStyle = {
      ...messageChatBubbleTextWebWrapStyle,
      whiteSpace: "pre-wrap",
    } as const;
    const baseTextCss = textStyleToDomCss(resolvedTextStyle, { omitLayout: true });
    const rowCss: Record<string, string | number> = listPreviewTruncate
      ? {
          display: "block",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
          maxWidth: "100%",
          textAlign: "left",
          ...baseTextCss,
        }
      : singleLine
        ? {
            display: "inline-block",
            whiteSpace: "nowrap",
            overflow: "visible",
            width: "max-content",
            maxWidth: "none",
            minWidth: "max-content",
            flexShrink: 0,
            textAlign: "left",
            ...baseTextCss,
          }
        : {
            display: "block",
            minWidth: 0,
            maxWidth: "100%",
            textAlign: "left",
            ...baseTextCss,
            ...inlineWrapStyle,
          };

    const emojiHostCss = (textLabel: boolean) =>
      listPreviewTruncate
        ? ({ display: "inline" } as const)
        : inlineEmojiHostCss(emojiSizePx, textLabel);

    const inlineTextCss = singleLine
      ? ({ display: "inline" } as const)
      : ({ display: "inline" } as const);
    const inlineLinkCss = singleLine
      ? ({
          display: "inline",
          color: linkColor,
          textDecoration: "underline",
          cursor: "pointer",
        } as const)
      : ({
          ...baseTextCss,
          color: linkColor,
          textDecoration: "underline",
          cursor: "pointer",
          display: "inline",
          ...inlineWrapStyle,
        } as const);

    return createElement(
      "div",
      { style: rowCss },
      segments.map((segment, index) => {
        if (segment.kind === "text") {
          return createElement("span", { key: index, style: inlineTextCss }, segment.text);
        }
        if (segment.kind === "custom_emoji" || segment.kind === "animated_emoji") {
          if (listPreviewTruncate) {
            return createElement("span", { key: index, style: inlineTextCss }, segment.text);
          }
          const textLabel =
            segment.kind === "custom_emoji" && isCustomEmojiTextLabel(segment.text);
          return createElement(
            "span",
            { key: index, style: emojiHostCss(textLabel) },
            renderTelegramEmojiNode(
              segment,
              emojiSizePx,
              lowPriorityEmoji,
              emojiFetchEnabled,
              emojiFetchPriority,
            ),
          );
        }
        if (segment.kind === "bot_command") {
          return createElement(
            "span",
            {
              key: index,
              style: inlineLinkCss,
              role: "link",
              onClick: () =>
                handleRichTextSegmentPress(segment, { chatId, onBotCommandPress }),
            },
            segment.text,
          );
        }
        if (segment.kind === "spoiler_code") {
          return createElement(MessageChatSpoilerCode, {
            key: index,
            text: segment.text,
            style: { ...baseTextCss, ...inlineTextCss },
            revealLabel: revealCodeLabel,
            overlayBackgroundColor: spoilerOverlayColor,
          });
        }
        return createElement(
          "span",
          {
            key: index,
            style: inlineLinkCss,
            role: "link",
            onClick: () => handleRichTextSegmentPress(segment, { chatId, onBotCommandPress }),
          },
          segment.text,
        );
      }),
    );
  }

  const listPreviewTruncate = numberOfLines === 1 && !nowrap;
  if (listPreviewTruncate) {
    return (
      <Text style={resolvedTextStyle} numberOfLines={1} ellipsizeMode="tail">
        {segments.map((segment, index) => {
          if (segment.kind === "text") {
            return <Text key={index}>{segment.text}</Text>;
          }
          if (segment.kind === "custom_emoji" || segment.kind === "animated_emoji") {
            return <Text key={index}>{segment.text}</Text>;
          }
          if (segment.kind === "bot_command") {
            return (
              <Text
                key={index}
                style={linkStyle}
                onPress={() =>
                  handleRichTextSegmentPress(segment, { chatId, onBotCommandPress })
                }
                accessibilityRole="link"
              >
                {segment.text}
              </Text>
            );
          }
          if (segment.kind === "spoiler_code") {
            return (
              <MessageChatSpoilerCode
                key={index}
                text={segment.text}
                style={resolvedTextStyle}
                revealLabel={revealCodeLabel}
                overlayBackgroundColor={spoilerOverlayColor}
              />
            );
          }
          return (
            <Text
              key={index}
              style={linkStyle}
              onPress={() => handleRichTextSegmentPress(segment, { chatId, onBotCommandPress })}
              accessibilityRole="link"
            >
              {segment.text}
            </Text>
          );
        })}
      </Text>
    );
  }

  const rowStyle: ViewStyle = {
    flexDirection: "row",
    flexWrap: nowrap || numberOfLines === 1 ? "nowrap" : "wrap",
    alignItems: "flex-end",
    overflow: "visible",
    ...(nowrap
      ? { flexGrow: 0, flexShrink: 0, alignSelf: "flex-start" as const }
      : {
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: 0,
          minWidth: 0,
          maxWidth: "100%",
          alignSelf: "stretch",
        }),
  };

  return (
    <View style={rowStyle}>
      {segments.map((segment, index) => {
        if (segment.kind === "text") {
          return (
            <Text key={index} style={resolvedTextStyle} numberOfLines={numberOfLines}>
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === "custom_emoji" || segment.kind === "animated_emoji") {
          return renderTelegramEmojiInline(
            segment,
            emojiSizePx,
            index,
            lowPriorityEmoji,
            emojiFetchEnabled,
            emojiFetchPriority,
          );
        }
        if (segment.kind === "bot_command") {
          return (
            <Text
              key={index}
              style={linkStyle}
              numberOfLines={numberOfLines}
              onPress={() =>
                handleRichTextSegmentPress(segment, { chatId, onBotCommandPress })
              }
              accessibilityRole="link"
            >
              {segment.text}
            </Text>
          );
        }
        if (segment.kind === "spoiler_code") {
          return (
            <MessageChatSpoilerCode
              key={index}
              text={segment.text}
              style={resolvedTextStyle}
              revealLabel={revealCodeLabel}
              overlayBackgroundColor={spoilerOverlayColor}
            />
          );
        }
        return (
          <Text
            key={index}
            style={linkStyle}
            numberOfLines={numberOfLines}
            onPress={() => handleRichTextSegmentPress(segment, { chatId, onBotCommandPress })}
            accessibilityRole="link"
          >
            {segment.text}
          </Text>
        );
      })}
    </View>
  );
}

function renderTelegramEmojiInline(
  segment: Extract<FormattedTextSegment, { kind: "custom_emoji" | "animated_emoji" }>,
  sizePx: number,
  key: number,
  lowPriority?: boolean,
  fetchEnabled = true,
  fetchPriority?: boolean,
) {
  const emojiNode = renderTelegramEmojiNode(
    segment,
    sizePx,
    lowPriority,
    fetchEnabled,
    fetchPriority,
  );
  const textLabel = segment.kind === "custom_emoji" && isCustomEmojiTextLabel(segment.text);

  if (Platform.OS === "web") {
    return createElement(
      "span",
      {
        key,
        style: inlineEmojiHostCss(sizePx, textLabel),
      },
      emojiNode,
    );
  }

  return (
    <Text key={key} style={{ lineHeight: sizePx }}>
      {emojiNode}
    </Text>
  );
}

export function MessageChatRichText({
  text,
  segments,
  style,
  linkColor = MESSAGE_LINK_COLOR,
  emojiSizePx = DEFAULT_INLINE_EMOJI_SIZE_PX,
  numberOfLines,
  lowPriorityEmoji = false,
  emojiFetchEnabled = true,
  emojiFetchPriority,
  nowrap = false,
  enrichStandardEmojis = false,
  chatId,
  peerUserId = null,
  senderUserId = null,
  spoilerOverlayColor,
  onBotCommandPress,
}: Props) {
  const { t } = useAppStrings();
  const singleLine = numberOfLines === 1 || nowrap;
  const hideServiceCodes = isTelegramServiceNotificationsChat(
    chatId,
    peerUserId,
    senderUserId,
  );
  const resolvedSegments = useMemo(
    () =>
      resolveSegments(text, segments, {
        enrichStandardEmojis,
        singleLine,
        hideServiceCodes,
      }),
    [enrichStandardEmojis, hideServiceCodes, segments, singleLine, text],
  );
  const hasTelegramEmoji = segmentsContainTelegramEmoji(resolvedSegments);
  const revealCodeLabel = t("messages.chat.revealCode");

  useEffect(() => {
    telegramEmojiDebug.richTextSegments("message_chat_rich_text", text, resolvedSegments);
    if (!hideServiceCodes) return;
    const spoiled = resolvedSegments.filter((s) => s.kind === "spoiler_code").map((s) => s.text);
    logPageDisplay("messages_service_code_spoiler", {
      chatId: chatId ?? null,
      peerUserId: peerUserId ?? null,
      senderUserId: senderUserId ?? null,
      spoilerCount: spoiled.length,
      sampleSpoilers: spoiled.slice(0, 3),
      textPreview: String(text || "").slice(0, 80),
    });
  }, [resolvedSegments, text, hideServiceCodes, chatId, peerUserId, senderUserId]);

  const hasSpoilerCode = resolvedSegments.some((segment) => segment.kind === "spoiler_code");
  const hasRichContent = resolvedSegments.some(
    (segment) =>
      segment.kind === "link" ||
      segment.kind === "bot_command" ||
      segment.kind === "custom_emoji" ||
      segment.kind === "animated_emoji" ||
      segment.kind === "spoiler_code",
  );
  const flatStyle = textStyleFromProp(style);
  const wrapStyle =
    Platform.OS === "web" && !nowrap ? (messageChatBubbleTextWebWrapStyle as TextStyle) : null;
  const nowrapStyle =
    Platform.OS === "web" && nowrap ? ({ whiteSpace: "nowrap" } as TextStyle) : null;
  const resolvedStyle = [
    style,
    wrapStyle,
    nowrapStyle,
  ];

  if (!hasRichContent) {
    return (
      <Text
        style={resolvedStyle}
        numberOfLines={numberOfLines}
        ellipsizeMode={numberOfLines === 1 ? "tail" : undefined}
      >
        {text}
      </Text>
    );
  }

  if (Platform.OS === "web" && (hasTelegramEmoji || hasSpoilerCode || (singleLine && hasRichContent))) {
    return (
      <RichTextWebRow
        segments={resolvedSegments}
        style={flatStyle}
        linkColor={linkColor}
        emojiSizePx={emojiSizePx}
        numberOfLines={numberOfLines}
        lowPriorityEmoji={lowPriorityEmoji}
        emojiFetchEnabled={emojiFetchEnabled}
        emojiFetchPriority={emojiFetchPriority}
        nowrap={nowrap}
        chatId={chatId}
        onBotCommandPress={onBotCommandPress}
        revealCodeLabel={revealCodeLabel}
        spoilerOverlayColor={spoilerOverlayColor}
      />
    );
  }

  const linkStyle = {
    color: linkColor,
    textDecorationLine: "underline" as const,
    ...(Platform.OS === "web"
      ? ({
          cursor: "pointer",
          ...(nowrap ? null : messageChatBubbleTextWebWrapStyle),
        } as object)
      : null),
  };

  return (
    <Text style={resolvedStyle} numberOfLines={numberOfLines}>
      {resolvedSegments.map((segment, index) => {
        if (segment.kind === "text") {
          return <Text key={index}>{segment.text}</Text>;
        }
        if (segment.kind === "custom_emoji" || segment.kind === "animated_emoji") {
          return renderTelegramEmojiInline(
            segment,
            emojiSizePx,
            index,
            lowPriorityEmoji,
            emojiFetchEnabled,
            emojiFetchPriority,
          );
        }
        if (segment.kind === "spoiler_code") {
          return (
            <MessageChatSpoilerCode
              key={index}
              text={segment.text}
              style={flatStyle}
              revealLabel={revealCodeLabel}
              overlayBackgroundColor={spoilerOverlayColor}
            />
          );
        }
        if (segment.kind === "bot_command") {
          return (
            <Text
              key={index}
              style={linkStyle}
              onPress={() =>
                handleRichTextSegmentPress(segment, { chatId, onBotCommandPress })
              }
              accessibilityRole="link"
            >
              {segment.text}
            </Text>
          );
        }
        return (
          <Text
            key={index}
            style={linkStyle}
            onPress={() => handleRichTextSegmentPress(segment, { chatId, onBotCommandPress })}
            accessibilityRole="link"
          >
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

/** Backward-compatible alias used in bubble layout. */
export function MessageChatLinkifiedText(props: Props) {
  return <MessageChatRichText {...props} />;
}
