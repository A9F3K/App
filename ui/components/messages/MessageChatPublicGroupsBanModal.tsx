import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { openSpamBotChat } from "../../telegram/openSpamBotChat";
import { typographyFixedRow40Label, typographyRect15, useColors } from "../../theme";
import { AppModalSheet, appModalSheetStyles } from "../AppModalSheet";

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function MessageChatPublicGroupsBanModal({ visible, onClose }: Props) {
  const { t } = useAppStrings();
  const colors = useColors();

  const onLearnMore = useCallback(() => {
    onClose();
    void openSpamBotChat();
  }, [onClose]);

  return (
    <AppModalSheet
      visible={visible}
      onClose={onClose}
      title=""
      footer={
        <View style={appModalSheetStyles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={appModalSheetStyles.button}
          >
            <Text style={[typographyFixedRow40Label, { color: colors.accent }]}>
              {t("messages.publicGroupsBan.ok")}
            </Text>
          </Pressable>
        </View>
      }
    >
      <Text
        style={[
          appModalSheetStyles.body,
          { color: colors.primary, marginBottom: 12 },
        ]}
      >
        {t("messages.publicGroupsBan.body")}
      </Text>
      <Pressable accessibilityRole="button" onPress={onLearnMore}>
        <Text style={[typographyRect15, { color: colors.accent, textAlign: "left" }]}>
          {t("messages.publicGroupsBan.learnMore")}
        </Text>
      </Pressable>
    </AppModalSheet>
  );
}
