import { Pressable, View } from "react-native";
import type { ThemeColors } from "../../theme";
import { MessageChatDownIcon } from "./MessageChatDownIcon";
import { MessageUnreadCountBadge } from "./MessageUnreadCountBadge";
import {
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_BADGE_TOP_PX,
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_ICON_BOTTOM_INSET_PX,
  MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
} from "./messageListLayout";

type Props = {
  unreadLabel: string;
  colors: ThemeColors;
  onPress: () => void;
};

/** Bottom-right jump control when scrolled up with many unread messages. */
export function MessageChatScrollToBottomButton({ unreadLabel, colors, onPress }: Props) {
  const outerRadius = MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX / 2;
  const showUnreadBadge = unreadLabel.length > 0;

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
      <View
        style={{
          width: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
          height: MESSAGE_CHAT_SCROLL_TO_BOTTOM_OUTER_PX,
          borderRadius: outerRadius,
          borderWidth: 1,
          borderColor: colors.highlight,
          backgroundColor: colors.undercover,
          alignItems: "center",
          justifyContent: showUnreadBadge ? "flex-end" : "center",
          ...(showUnreadBadge
            ? { paddingBottom: MESSAGE_CHAT_SCROLL_TO_BOTTOM_ICON_BOTTOM_INSET_PX }
            : null),
        }}
      >
        <MessageChatDownIcon color={colors.primary} />
      </View>
    </Pressable>
  );
}
