import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { TELEGRAM_SEND_ERROR_PUBLIC_GROUPS_BANNED } from "../../../shared/telegramSendError";
import { useAuthenticatedHomeSelectedChat } from "../../authenticatedHomeSelectedChat";
import {
  clearMessageChatCompose,
  useMessageChatCompose,
} from "../../messageChatCompose";
import {
  publishOutgoingChatMessage,
  removeOutgoingChatMessage,
} from "../../messageChatOutgoing";
import { editTelegramChatMessage } from "../../telegram/editTelegramChatMessage";
import { sendTelegramChatMessage } from "../../telegram/sendTelegramChatMessage";
import { enrichHistoryMessageDisplay } from "../messages/messageChatHistoryTypes";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import { appWarn } from "../../../shared/appLog";
import { useColors } from "../../theme";
import { GlobalBottomBar } from "../GlobalBottomBar";
import { MessageChatComposePill } from "./MessageChatComposePill";
import { MessageChatComposeStrip } from "../messages/MessageChatComposeStrip";
import { MessageChatPublicGroupsBanModal } from "../messages/MessageChatPublicGroupsBanModal";
import { MESSAGE_CHAT_BOTTOM_COMPOSE_FAB_GAP_PX } from "./messageChatLayout";
import { buildOptimisticOutgoingMessage } from "./optimisticOutgoingMessage";

type Props = {
  /** Pill row inside the open chat overlay (left of the scroll FAB). */
  embedded?: boolean;
  /** Trailing control in the overlay row — typically scroll-to-bottom FAB. */
  trailing?: ReactNode;
  /** Reports measured compose pill height for message list bottom inset. */
  onComposeOverlayHeightChange?: (heightPx: number) => void;
};

export function MessageChatWriteBottomBar({
  embedded = false,
  trailing = null,
  onComposeOverlayHeightChange,
}: Props) {
  const { t } = useAppStrings();
  const colors = useColors();
  const selectedChat = useAuthenticatedHomeSelectedChat();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const compose = useMessageChatCompose(selectedChat?.telegram_chat_id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [publicGroupsBanVisible, setPublicGroupsBanVisible] = useState(false);
  const sendingRef = useRef(false);
  const editPrefillRef = useRef<number | null>(null);

  useEffect(() => {
    if (compose?.edit) {
      if (editPrefillRef.current !== compose.edit.telegram_message_id) {
        editPrefillRef.current = compose.edit.telegram_message_id;
        setDraft(compose.edit.text);
      }
      return;
    }
    editPrefillRef.current = null;
  }, [compose?.edit]);

  const onSubmit = useCallback(
    async (text: string) => {
      if (!selectedChat || !isTelegramMessagesConnected || sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      try {
        if (compose?.edit) {
          const result = await editTelegramChatMessage(
            selectedChat.telegram_chat_id,
            compose.edit.telegram_message_id,
            text,
          );
          if (result.ok) {
            publishOutgoingChatMessage(
              selectedChat.telegram_chat_id,
              enrichHistoryMessageDisplay(result.message),
            );
            clearMessageChatCompose(selectedChat.telegram_chat_id);
            setDraft("");
          } else {
            appWarn("[message-edit]", String(result.error), {
              chatId: selectedChat.telegram_chat_id,
              messageId: compose.edit.telegram_message_id,
            });
          }
          return;
        }

        const replyTarget = compose?.reply ?? null;
        const optimistic = buildOptimisticOutgoingMessage({
          text,
          replyTarget,
        });
        publishOutgoingChatMessage(selectedChat.telegram_chat_id, optimistic);
        clearMessageChatCompose(selectedChat.telegram_chat_id);
        setDraft("");

        const result = await sendTelegramChatMessage(
          selectedChat.telegram_chat_id,
          text,
          replyTarget?.telegram_message_id ?? null,
        );
        if (result.ok) {
          const message =
            replyTarget && !result.message.reply_to
              ? {
                  ...result.message,
                  reply_to: {
                    sender_name: replyTarget.sender_name,
                    sender_user_id: null,
                    text: replyTarget.text,
                  },
                  reply_to_message_id: replyTarget.telegram_message_id,
                }
              : result.message.reply_to_message_id == null && replyTarget
                ? {
                    ...result.message,
                    reply_to_message_id: replyTarget.telegram_message_id,
                  }
                : result.message;
          publishOutgoingChatMessage(
            selectedChat.telegram_chat_id,
            enrichHistoryMessageDisplay(message),
          );
        } else if (result.error === TELEGRAM_SEND_ERROR_PUBLIC_GROUPS_BANNED) {
          removeOutgoingChatMessage(selectedChat.telegram_chat_id, optimistic.telegram_message_id);
          setDraft(text);
          setPublicGroupsBanVisible(true);
        } else {
          removeOutgoingChatMessage(selectedChat.telegram_chat_id, optimistic.telegram_message_id);
          setDraft(text);
          appWarn("[message-send]", String(result.error), {
            chatId: selectedChat.telegram_chat_id,
          });
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [compose, isTelegramMessagesConnected, selectedChat],
  );

  const onDismissCompose = useCallback(() => {
    if (compose?.edit) {
      setDraft("");
    }
  }, [compose?.edit]);

  const canSend = selectedChat != null && isTelegramMessagesConnected && !sending;

  if (selectedChat?.chat_kind === "channel") {
    return null;
  }

  const pill = (
    <MessageChatComposePill
      placeholder={t("messages.chatWrite.placeholderPill")}
      value={draft}
      onChangeText={setDraft}
      onSubmit={canSend ? onSubmit : () => {}}
      sendAccessibilityLabel={t("messages.chatWrite.send")}
      canSend={canSend}
      onHeightChange={embedded ? onComposeOverlayHeightChange : undefined}
    />
  );

  if (embedded) {
    return (
      <View pointerEvents="box-none">
        {compose ? (
          <MessageChatComposeStrip compose={compose} colors={colors} onDismiss={onDismissCompose} />
        ) : null}
        <View
          pointerEvents="box-none"
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            gap: MESSAGE_CHAT_BOTTOM_COMPOSE_FAB_GAP_PX,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>{pill}</View>
          {trailing}
        </View>
        <MessageChatPublicGroupsBanModal
          visible={publicGroupsBanVisible}
          onClose={() => setPublicGroupsBanVisible(false)}
        />
      </View>
    );
  }

  return (
    <View>
      {compose ? (
        <MessageChatComposeStrip compose={compose} colors={colors} onDismiss={onDismissCompose} />
      ) : null}
      <GlobalBottomBar
        placeholderText={t("messages.chatWrite.placeholder")}
        iconRotationDeg={-45}
        sendAccessibilityLabel={t("messages.chatWrite.send")}
        useLocalDraft
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={canSend ? onSubmit : () => {}}
      />
      <MessageChatPublicGroupsBanModal
        visible={publicGroupsBanVisible}
        onClose={() => setPublicGroupsBanVisible(false)}
      />
    </View>
  );
}
