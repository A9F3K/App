import { View } from "react-native";
import { layout, type ThemeColors } from "../../theme";
import { MessageChatHeader } from "./MessageChatHeader";
import { MessageChatMessageList } from "./MessageChatMessageList";
import { MessageChatVoiceBar } from "./MessageChatVoiceBar";
import { MessageSubtreeErrorBoundary } from "./MessageSubtreeErrorBoundary";
import type { MessageChatRowData } from "./MessageChatRow";

type Props = {
  chat: MessageChatRowData;
  colors: ThemeColors;
};

/** Wide-layout chat pane (middle column). */
export function MessageChatPanel({ chat, colors }: Props) {
  const columnBleedPx = layout.contentSideInsetPx;
  const showVoiceBar = Boolean(chat.has_active_voice_chat);

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
      {showVoiceBar ? (
        <MessageChatVoiceBar
          chatId={chat.telegram_chat_id}
          groupCallId={chat.voice_chat_group_call_id ?? null}
          title={chat.title}
          colors={colors}
        />
      ) : null}
      <MessageSubtreeErrorBoundary resetKey={chat.telegram_chat_id}>
        <MessageChatMessageList key={chat.telegram_chat_id} chat={chat} colors={colors} />
      </MessageSubtreeErrorBoundary>
    </View>
  );
}
