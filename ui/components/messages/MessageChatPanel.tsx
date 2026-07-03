import { View } from "react-native";
import { layout, type ThemeColors } from "../../theme";
import { MessageChatHeader } from "./MessageChatHeader";
import { MessageChatMessageList } from "./MessageChatMessageList";
import { MessageSubtreeErrorBoundary } from "./MessageSubtreeErrorBoundary";
import type { MessageChatRowData } from "./MessageChatRow";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
};

/** Wide-layout chat pane (middle column). */
export function MessageChatPanel({ chat, colors }: Props) {
  const columnBleedPx = layout.contentSideInsetPx;

  return (
    <View
      style={{
        flex: 1,
        alignSelf: "stretch",
        minHeight: 0,
        overflow: "visible",
        marginHorizontal: -columnBleedPx,
      }}
    >
      <MessageChatHeader chat={chat} colors={colors} />
      <MessageSubtreeErrorBoundary resetKey={chat.telegram_chat_id}>
        <MessageChatMessageList key={chat.telegram_chat_id} chat={chat} colors={colors} />
      </MessageSubtreeErrorBoundary>
    </View>
  );
}
