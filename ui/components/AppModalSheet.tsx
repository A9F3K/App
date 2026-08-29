import { type ReactNode, useMemo } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useAppStrings } from "../../locales/AppStringsContext";
import { layout, typographyFixedRow40Label, typographyRect15, typographySansSemibold, useColors } from "../theme";
import { FloatingDialogCloseButton } from "./FloatingDialogCloseButton";
import {
  FloatingDialogShell,
  floatingDialogDragHandleDomProps,
  floatingDialogDragHandleWebStyle,
  useFloatingDialogContentSizing,
} from "./FloatingDialogShell";
import {
  resolveFloatingDialogDefaultSize,
  type FloatingDialogSize,
  type FloatingDialogSizeKind,
} from "./floatingDialogGeometry";
import { HspScrollColumn } from "./HspScrollColumn";
import { SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX } from "../scrollIndicatorPx";

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
  /** Shrink sheet height to the form on first open (short auth / confirm dialogs). */
  fitContentHeight?: boolean;
  minSize?: FloatingDialogSize;
  sizeStorageKey?: string;
  offsetStorageKey?: string;
  sizeKind?: FloatingDialogSizeKind;
};

function AppModalSheetBody({
  title,
  children,
  footer,
  titleEmphasis,
  onClose,
  fitContentHeight,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  titleEmphasis: "default" | "primary";
  onClose: () => void;
  fitContentHeight: boolean;
}) {
  const colors = useColors();
  const { t } = useAppStrings();
  // During the first fit-content measure pass the shell reports contentSizing;
  // keep the same non-flex body after lock so the OTP field is not remounted.
  const contentSizing = useFloatingDialogContentSizing();
  const useIntrinsicBody = fitContentHeight || contentSizing;

  const header = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        marginBottom: title ? 8 : 0,
        minHeight: 28,
        ...floatingDialogDragHandleWebStyle,
      }}
      {...floatingDialogDragHandleDomProps}
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
  );

  // Intrinsic / fit-content sheets must not use HspScrollColumn (flex/height:0 collapses).
  if (useIntrinsicBody) {
    return (
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: 20,
          ...(fitContentHeight && !contentSizing
            ? { flex: 1, minHeight: 0 }
            : null),
        }}
      >
        {header}
        {children}
        {footer}
      </View>
    );
  }

  return (
    <HspScrollColumn
      style={{ flex: 1, minHeight: 0 }}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 20,
      }}
      scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
      scrollIndicatorOverlaySeam={false}
      containOverscroll
    >
      {header}
      {children}
      {footer}
    </HspScrollColumn>
  );
}

export function AppModalSheet({
  visible,
  onClose,
  title,
  children,
  footer,
  titleEmphasis = "default",
  fitContentHeight = false,
  minSize = { width: 300, height: 240 },
  sizeStorageKey = "hsp.appModalSheet.size.v3",
  offsetStorageKey = "hsp.appModalSheet.offset.v3",
  sizeKind = "modal",
}: Props) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, sizeKind),
    [sizeKind, windowHeight, windowWidth],
  );

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={10070}
      defaultSize={defaultSize}
      minSize={minSize}
      sizeStorageKey={sizeStorageKey}
      offsetStorageKey={offsetStorageKey}
      fitContentHeight={fitContentHeight}
      onRequestClose={onClose}
      testId="app-modal"
    >
      <AppModalSheetBody
        title={title}
        footer={footer}
        titleEmphasis={titleEmphasis}
        onClose={onClose}
        fitContentHeight={fitContentHeight}
      >
        {children}
      </AppModalSheetBody>
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
