import { Pressable, View } from "react-native";
import type { ThemeColors } from "../../theme";
import { MessageChatDownIcon } from "./MessageChatDownIcon";
import { MessageUnreadCountBadge } from "./MessageUnreadCountBadge";
import {
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_BADGE_TOP_PX,
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_ICON_BOTTOM_INSET_PX,
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_INNER_PX,
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
} from "./messageListLayout";

type Props = {
  unreadLabel: string;
  colors: ThemeColors;
  onPress: () => void;
  /** Wide two-column chat: background shell + undercover icon disc (matches compose pill). */
  composeOverlayStyle?: boolean;
};

/** Bottom-right jump control when scrolled up with many unread messages. */
export function MessageChatScrollToBottomButton({
  unreadLabel,
  colors,
  onPress,
  composeOverlayStyle = false,
}: Props) {
  const innerRadius = MESSAGE_CHAT_SCROLL_TO_BOTTOM_INNER_PX / 2;
  const outerRadius = MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX / 2;
  const showUnreadBadge = unreadLabel.length > 0;
  const iconJustify = showUnreadBadge ? "flex-end" : "center";
  const iconPadding = showUnreadBadge
    ? { paddingBottom: MESSAGE_CHAT_SCROLL_TO_BOTTOM_ICON_BOTTOM_INSET_PX }
    : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Scroll to latest messages"
      style={({ pressed }) => ({
        width: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
        height: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
        opacity: pressed ? 0.88 : 1,
      })}
    >
      {showUnreadBadge ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: MESSAGE_CHAT_SCROLL_TO_BOTTOM_BADGE_TOP_PX,
            left: 0,
            right: 0,
            alignItems: "center",
            zIndex: 2,
          }}
        >
          <MessageUnreadCountBadge label={unreadLabel} colors={colors} />
        </View>
      ) : null}
      {composeOverlayStyle ? (
        <View
          style={{
            width: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
            height: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
            borderRadius: outerRadius,
            borderWidth: 1,
            borderColor: colors.highlight,
            backgroundColor: colors.background,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: MESSAGE_CHAT_SCROLL_TO_BOTTOM_INNER_PX,
              height: MESSAGE_CHAT_SCROLL_TO_BOTTOM_INNER_PX,
              borderRadius: innerRadius,
              backgroundColor: colors.undercover,
              alignItems: "center",
              justifyContent: iconJustify,
              ...iconPadding,
            }}
          >
            <MessageChatDownIcon color={colors.primary} />
          </View>
        </View>
      ) : (
        <View
          style={{
            width: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
            height: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
            borderRadius: outerRadius,
            borderWidth: 1,
            borderColor: colors.highlight,
            backgroundColor: "transparent",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: MESSAGE_CHAT_SCROLL_TO_BOTTOM_INNER_PX,
              height: MESSAGE_CHAT_SCROLL_TO_BOTTOM_INNER_PX,
              borderRadius: innerRadius,
              backgroundColor: "transparent",
              alignItems: "center",
              justifyContent: iconJustify,
              ...iconPadding,
            }}
          >
            <MessageChatDownIcon color={colors.primary} />
          </View>
        </View>
      )}
    </Pressable>
  );
}
