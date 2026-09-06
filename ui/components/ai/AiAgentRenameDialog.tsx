import { useCallback, useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { layout, typographyRect15, useColors } from "../../theme";

type Props = {
  visible: boolean;
  initialTitle: string;
  onClose: () => void;
  onSave: (title: string) => void;
};

export function AiAgentRenameDialog({ visible, initialTitle, onClose, onSave }: Props) {
  const colors = useColors();
  const { t } = useAppStrings();
  const [value, setValue] = useState(initialTitle);

  useEffect(() => {
    if (visible) setValue(initialTitle);
  }, [visible, initialTitle]);

  const submit = useCallback(() => {
    const next = value.trim();
    if (!next) return;
    onSave(next);
    onClose();
  }, [value, onSave, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              borderColor: colors.highlight,
            },
          ]}
        >
          <Text style={[typographyRect15, { color: colors.primary, marginBottom: 12 }]}>
            {t("ai.agents.renameTitle")}
          </Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            autoFocus
            maxLength={80}
            placeholder={t("ai.agents.newAgent")}
            placeholderTextColor={colors.secondary}
            onSubmitEditing={submit}
            style={[
              styles.input,
              {
                color: colors.primary,
                borderColor: colors.highlight,
                backgroundColor: colors.undercover,
                fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
              },
            ]}
          />
          <View style={styles.row}>
            <Pressable onPress={onClose} style={styles.btn}>
              <Text style={[typographyRect15, { color: colors.secondary }]}>
                {t("common.cancel")}
              </Text>
            </Pressable>
            <Pressable onPress={submit} style={styles.btn}>
              <Text style={[typographyRect15, { color: colors.primary }]}>
                {t("ai.agents.renameSave")}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: layout.contentSideInsetPx,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    width: "100%",
    maxWidth: 360,
    borderWidth: 1,
    padding: 20,
    zIndex: 1,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 16,
  },
  row: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 20,
  },
  btn: {
    paddingVertical: 4,
  },
});
