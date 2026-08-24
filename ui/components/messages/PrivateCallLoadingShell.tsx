import { Modal, Platform, Text, View } from "react-native";
import { useColors } from "../../theme";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { useTelegram } from "../Telegram";
import { FloatingDialogCloseButton } from "../FloatingDialogCloseButton";
import { MessageChatAvatarSlot } from "./MessageChatAvatarSlot";
import { extractChatAvatarInitials } from "./chatAvatarInitials";
import { resolveTelegramThreadAvatarUrl } from "./resolveTelegramThreadAvatarUrl";
import type { MessageChatRowData } from "./MessageChatRow";

type Props = {
  chat: MessageChatRowData;
  onClose: () => void;
};

/** Instant overlay while the private-call host chunk loads. */
export function PrivateCallLoadingShell({ chat, onClose }: Props) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const { t } = useAppStrings();
  const title = (chat.title ?? "").trim() || t("messages.privateCall.active");
  const avatarUrl = resolveTelegramThreadAvatarUrl(chat);
  const initials = extractChatAvatarInitials(title);

  return (
    <Modal
      visible
      transparent={Platform.OS === "web"}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 24,
        }}
      >
        <FloatingDialogCloseButton
          label={t("common.close")}
          onPress={onClose}
          style={{ position: "absolute", top: 16, right: 16 }}
        />
        <MessageChatAvatarSlot
          iconUrl={avatarUrl}
          initials={initials}
          sizePx={120}
          colors={colors}
          scheme={colorScheme}
          fetchPriority="high"
        />
        <Text
          style={{
            marginTop: 20,
            fontSize: 22,
            fontWeight: "600",
            color: colors.text,
            textAlign: "center",
          }}
        >
          {title}
        </Text>
        <Text
          style={{
            marginTop: 8,
            fontSize: 16,
            color: colors.textSecondary,
            textAlign: "center",
          }}
        >
          {t("messages.privateCall.calling")}
        </Text>
      </View>
    </Modal>
  );
}
