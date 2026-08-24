import { type ReactNode } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAppStrings } from "../../locales/AppStringsContext";
import { layout, typographyFixedRow40Label, typographyRect15, typographySansSemibold, useColors } from "../theme";
import { FloatingDialogCloseButton } from "./FloatingDialogCloseButton";
import { FloatingDialogShell } from "./FloatingDialogShell";
import { HspScrollColumn } from "./HspScrollColumn";

export const appModalSheetStyles = StyleSheet.create({
  overlayBlock: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: layout.contentSideInsetPx,
    paddingVertical: layout.contentSideInsetPx,
  },
  backdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "transparent",
  },
  sheet: {
    width: "100%",
    maxWidth: 380,
    borderWidth: 1,
    borderRadius: 0,
    zIndex: 1,
    ...Platform.select({
      web: { boxSizing: "border-box" as const },
      default: {},
    }),
  },
  sheetBody: {
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  title: {
    marginBottom: 10,
    textAlign: "left",
  },
  /** Primary sheet heading — semibold, left-aligned hierarchy. */
  titlePrimary: {
    marginBottom: 8,
    textAlign: "left",
    fontSize: 17,
    lineHeight: 22,
  },
  body: {
    marginBottom: 12,
    textAlign: "left",
  },
  bodySupporting: {
    marginBottom: 16,
    textAlign: "left",
    fontSize: 14,
    lineHeight: 20,
  },
  hint: {
    marginTop: 12,
    textAlign: "center",
  },
  centerBlock: {
    alignItems: "center",
    marginBottom: 12,
  },
  error: {
    marginBottom: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 12,
    justifyContent: "flex-end",
    marginTop: 8,
  },
  button: {
    minHeight: 40,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButton: {
    minWidth: 100,
  },
  passwordInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === "web" ? 10 : 8,
    minHeight: 40,
  },
  passwordBlock: {
    marginBottom: 12,
    gap: 10,
  },
  qr: {
    width: 220,
    height: 220,
    marginBottom: 12,
    borderRadius: 8,
  },
});

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Stronger left-aligned heading for single-step dialogs (e.g. 2FA password). */
  titleEmphasis?: "default" | "primary";
};

export function AppModalSheet({
  visible,
  onClose,
  title,
  children,
  footer,
  titleEmphasis = "default",
}: Props) {
  const colors = useColors();
  const { t } = useAppStrings();

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={10070}
      defaultSize={{ width: 380, height: 420 }}
      minSize={{ width: 300, height: 240 }}
      sizeStorageKey="hsp.appModalSheet.size.v2"
      offsetStorageKey="hsp.appModalSheet.offset.v2"
      onRequestClose={onClose}
      testId="app-modal"
    >
      <HspScrollColumn
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: 20,
        }}
        scrollbarRightInsetPx={0}
        scrollIndicatorOverlaySeam={false}
        containOverscroll
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            marginBottom: title ? 8 : 0,
            minHeight: 28,
          }}
        >
          <Text
            style={[
              titleEmphasis === "primary"
                ? [typographySansSemibold, appModalSheetStyles.titlePrimary]
                : [typographyRect15, appModalSheetStyles.title],
              {
                color: colors.primary,
                flex: 1,
                minWidth: 0,
                marginBottom: 0,
                paddingRight: 8,
              },
            ]}
          >
            {title}
          </Text>
          <FloatingDialogCloseButton label={t("common.close")} onPress={onClose} />
        </View>
        {children}
        {footer}
      </HspScrollColumn>
    </FloatingDialogShell>
  );
}

export function AppModalSheetBackFooter({
  onClose,
  disabled,
  label,
  extraActions,
}: {
  onClose: () => void;
  disabled?: boolean;
  label: string;
  extraActions?: ReactNode;
}) {
  const colors = useColors();

  return (
    <View style={appModalSheetStyles.actions}>
      <Pressable
        accessibilityRole="button"
        onPress={onClose}
        style={[appModalSheetStyles.button, { backgroundColor: colors.undercover }]}
        disabled={disabled}
        {...(Platform.OS === "web" ? ({ "data-floating-no-drag": "1" } as object) : {})}
      >
        <Text style={[typographyFixedRow40Label, { color: colors.secondary }]}>{label}</Text>
      </Pressable>
      {extraActions}
    </View>
  );
}
