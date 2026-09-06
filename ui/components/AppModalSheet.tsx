import { type ReactNode, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useAppStrings } from "../../locales/AppStringsContext";
import { layout, typographyFixedRow40Label, useColors } from "../theme";
import {
  floatingDialogBodyTextStyle,
  floatingDialogSectionTextStyle,
  floatingDialogSubtitleTextStyle,
  floatingDialogTitleTextStyle,
  resolveFloatingDialogInsets,
} from "./floatingDialogChrome";
import { FloatingDialogScrollChromeProvider } from "./floatingDialogScrollChrome";
import { FloatingDialogStickyHeader } from "./FloatingDialogStickyHeader";
import { FloatingDialogBody } from "./FloatingDialogBody";
import {
  FloatingDialogShell,
  useFloatingDialogContentSizing,
} from "./FloatingDialogShell";
import {
  resolveFloatingDialogDefaultSize,
  type FloatingDialogSize,
  type FloatingDialogSizeKind,
} from "./floatingDialogGeometry";
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
    ...floatingDialogTitleTextStyle,
    marginBottom: 0,
  },
  titlePrimary: {
    ...floatingDialogTitleTextStyle,
    marginBottom: 0,
  },
  section: {
    ...floatingDialogSectionTextStyle,
    marginBottom: 14,
    marginTop: 8,
  },
  subtitle: {
    ...floatingDialogSubtitleTextStyle,
    marginBottom: 5,
  },
  body: {
    ...floatingDialogBodyTextStyle,
    marginBottom: 12,
  },
  bodySupporting: {
    ...floatingDialogBodyTextStyle,
    marginBottom: 16,
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
  onClose,
  fitContentHeight,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  fitContentHeight: boolean;
}) {
  const { t } = useAppStrings();
  const { height: windowHeight } = useWindowDimensions();
  const insets = resolveFloatingDialogInsets(windowHeight);
  const contentSizing = useFloatingDialogContentSizing();
  const useIntrinsicBody = fitContentHeight || contentSizing;
  const [headerExtendPx, setHeaderExtendPx] = useState(0);

  const header = (
    <FloatingDialogStickyHeader
      insets={insets}
      title={title}
      onClose={onClose}
      closeLabel={t("common.close")}
      onHeightChange={setHeaderExtendPx}
    />
  );

  const bodyPadding = {
    paddingHorizontal: insets.padX,
    paddingTop: insets.bodyPadTop,
    paddingBottom: insets.bodyPadBottom,
  };

  const chrome = (body: ReactNode) => (
    <FloatingDialogScrollChromeProvider headerExtendPx={headerExtendPx}>
      {body}
    </FloatingDialogScrollChromeProvider>
  );

  if (useIntrinsicBody) {
    return chrome(
      <FloatingDialogBody>
        {header}
        <View style={bodyPadding}>
          {children}
          {footer}
        </View>
      </FloatingDialogBody>,
    );
  }

  return chrome(
    <FloatingDialogBody>
      {header}
      <HspScrollColumn
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={bodyPadding}
        scrollbarRightInsetPx={2}
        scrollIndicatorOverlaySeam={false}
        containOverscroll
      >
        {children}
        {footer}
      </HspScrollColumn>
    </FloatingDialogBody>,
  );
}

export function AppModalSheet({
  visible,
  onClose,
  title,
  children,
  footer,
  titleEmphasis: _titleEmphasis = "default",
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
