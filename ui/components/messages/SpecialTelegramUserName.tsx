import { createElement, useEffect, useMemo, type ReactNode } from "react";
import { Platform, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { MessageChatRussianFlagIcon } from "./MessageChatRussianFlagIcon";
import { MessageChatArtSignIcon } from "./MessageChatArtSignIcon";
import { MessageChatPeaceIcon } from "./MessageChatPeaceIcon";
import { MessageChatCrossIcon } from "./MessageChatCrossIcon";
import { MessageChatSIcon } from "./MessageChatSIcon";
import { MessageChatStatusTgsBadge } from "./MessageChatStatusTgsBadge";
import { MessageChatInlineTgsEmoji } from "./MessageChatInlineTgsEmoji";
import { MessageChatRichText } from "./MessageChatRichText";
import {
  SPECIAL_USER_BADGE_GAP_PX,
  SPECIAL_USER_BADGE_SIZE_PX,
  specialUserBadgeKind,
  specialUserDisplayName,
  specialUserShowsShineName,
} from "./specialTelegramUserDisplay";
import { resolveTitleDisplaySegments } from "./resolveMessageDisplaySegments";
import { telegramEmojiDebug } from "./telegramEmojiDebug";

type Props = {
  name: string;
  telegramUserId: number | null | undefined;
  telegramChatId?: number | null;
  emojiStatusCustomEmojiId?: string | null;
  /** When true, fetch/render Telegram emoji status immediately (open thread). */
  emojiStatusPriority?: boolean;
  /** Prefer static WEBP/PNG status over animated TGS/WebM. */
  emojiStatusStatic?: boolean;
  /** Inline title/preview emoji fetches — enabled for visible list rows and open chat. */
  inlineEmojiFetchEnabled?: boolean;
  inlineEmojiFetchPriority?: boolean;
  inlineEmojiSizePx?: number;
  textStyle: TextStyle;
  numberOfLines?: number;
  textAlign?: "left" | "center" | "right";
  containerStyle?: ViewStyle;
};

function webShineNameNode(name: string, color: string | undefined): ReactNode {
  return createElement(
    "span",
    {
      className: "hsp-special-user-name-shine",
      style: color ? ({ ["--hsp-shine-base" as string]: color } as Record<string, string>) : undefined,
    },
    name,
  );
}

function SpecialUserBadge({ kind, size }: { kind: NonNullable<ReturnType<typeof specialUserBadgeKind>>; size: number }) {
  if (kind === "cross") {
    return <MessageChatCrossIcon size={size} />;
  }
  if (kind === "peace_sign") {
    return <MessageChatPeaceIcon size={size} />;
  }
  if (kind === "art_sign") {
    return <MessageChatArtSignIcon size={size} />;
  }
  if (kind === "russian_flag") {
    return <MessageChatRussianFlagIcon size={size} />;
  }
  if (kind === "s_sign") {
    return <MessageChatSIcon size={size} />;
  }
  return <MessageChatStatusTgsBadge size={size} />;
}

export function SpecialTelegramUserName({
  name,
  telegramUserId,
  telegramChatId = null,
  emojiStatusCustomEmojiId,
  emojiStatusPriority = true,
  emojiStatusStatic = false,
  inlineEmojiFetchEnabled = true,
  inlineEmojiFetchPriority = false,
  inlineEmojiSizePx,
  textStyle,
  numberOfLines = 1,
  textAlign = "left",
  containerStyle,
}: Props) {
  const displayName = specialUserDisplayName(telegramUserId, name, telegramChatId);
  const badgeKind = specialUserBadgeKind(telegramUserId, name, telegramChatId);
  const telegramEmojiStatusId = emojiStatusCustomEmojiId?.trim() || null;
  // Telegram shows the premium emoji-status animation instead of the static
  // special badge whenever a custom-emoji status is set.
  const showTelegramEmojiStatus = Boolean(telegramEmojiStatusId);
  const showSpecialBadge = badgeKind != null && !showTelegramEmojiStatus;
  const showBadge = showSpecialBadge || showTelegramEmojiStatus;
  const showShine = specialUserShowsShineName(telegramUserId, name, telegramChatId);
  const shineColor = typeof textStyle.color === "string" ? textStyle.color : undefined;
  const titleSegments = useMemo(() => resolveTitleDisplaySegments(displayName), [displayName]);
  const useRichTitle = Boolean(titleSegments?.length);

  useEffect(() => {
    telegramEmojiDebug.statusBadgeDecision({
      context: "special_telegram_user_name",
      userId: telegramUserId ?? null,
      emojiStatusId: telegramEmojiStatusId,
      showSpecialBadge,
      showTelegramEmojiStatus,
      badgeKind: badgeKind ?? null,
    });
  }, [
    badgeKind,
    showSpecialBadge,
    showTelegramEmojiStatus,
    telegramEmojiStatusId,
    telegramUserId,
  ]);

  const nameContent =
    Platform.OS === "web" && showShine && !useRichTitle
      ? webShineNameNode(displayName, shineColor)
      : displayName;

  const resolvedEmojiSizePx =
    inlineEmojiSizePx ??
    (typeof textStyle.fontSize === "number" ? Math.round(textStyle.fontSize * 1.2) : 18);

  const nameText = useRichTitle ? (
    <MessageChatRichText
      text={displayName}
      segments={titleSegments}
      numberOfLines={numberOfLines}
      emojiSizePx={resolvedEmojiSizePx}
      lowPriorityEmoji={!inlineEmojiFetchPriority}
      emojiFetchEnabled={inlineEmojiFetchEnabled}
      emojiFetchPriority={inlineEmojiFetchPriority}
      style={[
        textStyle,
        {
          textAlign,
          flexShrink: 1,
          minWidth: 0,
        },
        showBadge ? { flex: 0 } : null,
      ]}
    />
  ) : (
    <Text
      numberOfLines={numberOfLines}
      ellipsizeMode="tail"
      style={[
        textStyle,
        {
          textAlign,
          flexShrink: 1,
          minWidth: 0,
        },
        showBadge ? { flex: 0 } : null,
      ]}
    >
      {nameContent}
    </Text>
  );

  if (!showBadge) {
    if (textAlign === "center") {
      return (
        <View style={[{ alignItems: "center", maxWidth: "100%" }, containerStyle]}>
          {nameText}
        </View>
      );
    }
    return nameText;
  }

  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 1,
          minWidth: 0,
          maxWidth: "100%",
        },
        textAlign === "center" ? { alignSelf: "center", justifyContent: "center" } : null,
        containerStyle,
      ]}
    >
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          maxWidth: "100%",
          alignItems: textAlign === "center" ? "center" : undefined,
        }}
      >
        {nameText}
      </View>
      <View style={{ width: SPECIAL_USER_BADGE_GAP_PX, flexShrink: 0 }} />
      <View
        style={{
          width: SPECIAL_USER_BADGE_SIZE_PX,
          height: SPECIAL_USER_BADGE_SIZE_PX,
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {showSpecialBadge && badgeKind ? (
          <SpecialUserBadge kind={badgeKind} size={SPECIAL_USER_BADGE_SIZE_PX} />
        ) : showTelegramEmojiStatus && telegramEmojiStatusId ? (
          <MessageChatInlineTgsEmoji
            customEmojiId={telegramEmojiStatusId}
            sizePx={SPECIAL_USER_BADGE_SIZE_PX}
            priority={emojiStatusPriority}
            fetchEnabled={inlineEmojiFetchEnabled}
            preferStatic={emojiStatusStatic}
            // Never flash the Unicode 🎭 stand-in while the custom status loads —
            // leave the badge slot empty until static/animated bytes paint.
            suppressFallback
          />
        ) : null}
      </View>
    </View>
  );
}
