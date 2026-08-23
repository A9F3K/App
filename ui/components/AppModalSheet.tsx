import { useEffect, type ReactNode } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { layout, typographyFixedRow40Label, typographyRect15, typographySansSemibold, useColors } from "../theme";
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
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    if (!visible || Platform.OS !== "web" || typeof document === "undefined") return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
    };
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <HspScrollColumn
        style={{ height: windowHeight, width: "100%", minHeight: 0 }}
        contentContainerStyle={{
          flexGrow: 1,
          minHeight: windowHeight,
          justifyContent: "center",
          alignItems: "center",
        }}
        containOverscroll
      >
        <View style={[appModalSheetStyles.overlayBlock, { minHeight: windowHeight }]}>
          <Pressable
            style={appModalSheetStyles.backdropFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
          />
          <View
            style={[
              appModalSheetStyles.sheet,
              appModalSheetStyles.sheetBody,
              {
                backgroundColor: colors.background,
                borderColor: colors.highlight,
              },
            ]}
            {...(Platform.OS === "web"
              ? ({
                  onClick: (e: { stopPropagation?: () => void }) => e.stopPropagation?.(),
                } as object)
              : {})}
            onStartShouldSetResponder={() => true}
          >
            <Text
              style={[
                titleEmphasis === "primary"
                  ? [typographySansSemibold, appModalSheetStyles.titlePrimary]
                  : [typographyRect15, appModalSheetStyles.title],
                { color: colors.primary },
              ]}
            >
              {title}
            </Text>
            {children}
            {footer}
          </View>
        </View>
      </HspScrollColumn>
    </Modal>
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
      >
        <Text style={[typographyFixedRow40Label, { color: colors.secondary }]}>{label}</Text>
      </Pressable>
      {extraActions}
    </View>
  );
}
