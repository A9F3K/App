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
import { sendTelegramChatPhoto } from "../../telegram/sendTelegramChatPhoto";
import { enrichHistoryMessageDisplay } from "../messages/messageChatHistoryTypes";
import { useTelegramMessagesConnection } from "../../telegram/TelegramMessagesConnectionContext";
import { appWarn } from "../../../shared/appLog";
import { useColors } from "../../theme";
import { GlobalBottomBar } from "../GlobalBottomBar";
import { MessageChatComposePill } from "./MessageChatComposePill";
import { MessageChatComposeStrip } from "../messages/MessageChatComposeStrip";
import { MessageChatComposePhotoPreview } from "./MessageChatComposePhotoPreview";
import { MessageChatPublicGroupsBanModal } from "../messages/MessageChatPublicGroupsBanModal";
import { MESSAGE_CHAT_BOTTOM_COMPOSE_FAB_GAP_PX } from "./messageChatLayout";
import { buildOptimisticOutgoingMessage } from "./optimisticOutgoingMessage";
import {
  readClipboardImageFromPasteEvent,
  revokeComposePendingPhoto,
  type ComposePendingPhoto,
} from "./composeClipboardPhoto";

type Props = {
  /** Pill row inside the open chat overlay (left of the scroll FAB). */
  embedded?: boolean;
  /** Trailing control in the overlay row — typically scroll-to-bottom FAB. */
  trailing?: ReactNode;
  /** Reports measured compose pill height for message list bottom inset. */
  onComposeOverlayHeightChange?: (heightPx: number) => void;
  /** Fired after a message is successfully submitted (draft cleared). */
  onSent?: () => void;
};

export function MessageChatWriteBottomBar({
  embedded = false,
  trailing = null,
  onComposeOverlayHeightChange,
  onSent,
}: Props) {
  const { t } = useAppStrings();
  const colors = useColors();
  const selectedChat = useAuthenticatedHomeSelectedChat();
  const { isTelegramMessagesConnected } = useTelegramMessagesConnection();
  const compose = useMessageChatCompose(selectedChat?.telegram_chat_id);
  const [draft, setDraft] = useState("");
  const [pendingPhoto, setPendingPhoto] = useState<ComposePendingPhoto | null>(null);
  const [sending, setSending] = useState(false);
  const [publicGroupsBanVisible, setPublicGroupsBanVisible] = useState(false);
  const sendingRef = useRef(false);
  const editPrefillRef = useRef<number | null>(null);
  const pendingPhotoRef = useRef<ComposePendingPhoto | null>(null);

  useEffect(() => {
    pendingPhotoRef.current = pendingPhoto;
  }, [pendingPhoto]);

  useEffect(() => {
    return () => {
      revokeComposePendingPhoto(pendingPhotoRef.current);
    };
  }, []);

  useEffect(() => {
    if (compose?.edit) {
      if (editPrefillRef.current !== compose.edit.telegram_message_id) {
        editPrefillRef.current = compose.edit.telegram_message_id;
        setDraft(compose.edit.text);
        setPendingPhoto((prev) => {
          revokeComposePendingPhoto(prev);
          return null;
        });
      }
      return;
    }
    editPrefillRef.current = null;
  }, [compose?.edit]);

  const clearPendingPhoto = useCallback(() => {
    setPendingPhoto((prev) => {
      revokeComposePendingPhoto(prev);
      return null;
    });
  }, []);

  const onPasteImage = useCallback(async (event: { clipboardData?: DataTransfer | null }) => {
    if (compose?.edit) return false;
    const photo = await readClipboardImageFromPasteEvent(event);
    if (!photo) return false;
    setPendingPhoto((prev) => {
      revokeComposePendingPhoto(prev);
      return photo;
    });
    return true;
  }, [compose?.edit]);

  const onSubmit = useCallback(
    async (text: string) => {
      if (!selectedChat || !isTelegramMessagesConnected || sendingRef.current) return;
      const photo = pendingPhotoRef.current;
      if (!text.trim() && !photo) return;
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
            onSent?.();
          } else {
            appWarn("[message-edit]", String(result.error), {
              chatId: selectedChat.telegram_chat_id,
              messageId: compose.edit.telegram_message_id,
            });
          }
          return;
        }

        const replyTarget = compose?.reply ?? null;

        if (photo) {
          const optimistic = buildOptimisticOutgoingMessage({
            text,
            replyTarget,
            photo: {
              localUri: photo.previewUri,
              width: photo.width,
              height: photo.height,
            },
          });
          publishOutgoingChatMessage(selectedChat.telegram_chat_id, optimistic);
          clearMessageChatCompose(selectedChat.telegram_chat_id);
          setDraft("");
          setPendingPhoto(null);
          onSent?.();

          const result = await sendTelegramChatPhoto({
            chatId: selectedChat.telegram_chat_id,
            photoBase64: photo.base64,
            caption: text,
            mime: photo.mime,
            replyToMessageId: replyTarget?.telegram_message_id ?? null,
          });
          revokeComposePendingPhoto(photo);
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
                : result.message;
            publishOutgoingChatMessage(
              selectedChat.telegram_chat_id,
              enrichHistoryMessageDisplay(message),
            );
          } else if (result.error === TELEGRAM_SEND_ERROR_PUBLIC_GROUPS_BANNED) {
            removeOutgoingChatMessage(selectedChat.telegram_chat_id, optimistic.telegram_message_id);
            setDraft(text);
            setPendingPhoto(photo);
            setPublicGroupsBanVisible(true);
          } else {
            removeOutgoingChatMessage(selectedChat.telegram_chat_id, optimistic.telegram_message_id);
            setDraft(text);
            setPendingPhoto(photo);
            appWarn("[message-send-photo]", String(result.error), {
              chatId: selectedChat.telegram_chat_id,
            });
          }
          return;
        }

        const optimistic = buildOptimisticOutgoingMessage({
          text,
          replyTarget,
        });
        publishOutgoingChatMessage(selectedChat.telegram_chat_id, optimistic);
        clearMessageChatCompose(selectedChat.telegram_chat_id);
        setDraft("");
        onSent?.();

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
    [compose, isTelegramMessagesConnected, onSent, selectedChat],
  );

  const onDismissCompose = useCallback(() => {
    if (compose?.edit) {
      setDraft("");
    }
  }, [compose?.edit]);

  const canSend =
    selectedChat != null &&
    isTelegramMessagesConnected &&
    !sending &&
    (Boolean(draft.trim()) || pendingPhoto != null);

  if (selectedChat?.chat_kind === "channel") {
    return null;
  }

  const photoPreview = pendingPhoto ? (
    <MessageChatComposePhotoPreview
      previewUri={pendingPhoto.previewUri}
      colors={colors}
      onClear={clearPendingPhoto}
      clearAccessibilityLabel={t("messages.chatWrite.clearPhoto")}
    />
  ) : null;

  const pill = (
    <MessageChatComposePill
      placeholder={t("messages.chatWrite.placeholderPill")}
      value={draft}
      onChangeText={setDraft}
      onSubmit={canSend ? onSubmit : () => {}}
      sendAccessibilityLabel={t("messages.chatWrite.send")}
      canSend={canSend}
      onHeightChange={embedded ? onComposeOverlayHeightChange : undefined}
      onPasteImage={onPasteImage}
      hasPendingPhoto={pendingPhoto != null}
    />
  );

  if (embedded) {
    return (
      <View pointerEvents="box-none">
        {compose ? (
          <MessageChatComposeStrip compose={compose} colors={colors} onDismiss={onDismissCompose} />
        ) : null}
        {photoPreview}
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
      {photoPreview}
      <GlobalBottomBar
        placeholderText={t("messages.chatWrite.placeholder")}
        iconRotationDeg={-45}
        sendAccessibilityLabel={t("messages.chatWrite.send")}
        useLocalDraft
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={canSend ? onSubmit : () => {}}
        onPasteImage={onPasteImage}
        allowEmptySubmit={pendingPhoto != null}
      />
      <MessageChatPublicGroupsBanModal
        visible={publicGroupsBanVisible}
        onClose={() => setPublicGroupsBanVisible(false)}
      />
    </View>
  );
}
