import { Platform, type TextStyle } from "react-native";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import { typographySansSemibold } from "../theme";

export const DIALOG_PAD_X_PX = 20;

const dialogSansRegular: TextStyle = Platform.select({
  web: { fontFamily: WEB_UI_SANS_STACK },
  default: { fontFamily: FONT_UI_SANS_REGULAR },
}) ?? {};

/** Balanced header/body insets that stay readable from phone to desktop. */
export function resolveFloatingDialogInsets(windowHeight: number): {
  padX: number;
  headerPadTop: number;
  headerPadBottom: number;
  bodyPadTop: number;
  bodyPadBottom: number;
} {
  const h = Number.isFinite(windowHeight) && windowHeight > 0 ? windowHeight : 800;
  return {
    padX: DIALOG_PAD_X_PX,
    headerPadTop: Math.max(16, Math.min(24, Math.round(h * 0.022))),
    headerPadBottom: Math.max(10, Math.min(14, Math.round(h * 0.014))),
    bodyPadTop: 8,
    bodyPadBottom: Math.max(20, Math.min(32, Math.round(h * 0.03))),
  };
}

/** Dialog window title — readable, not heavy. */
export const floatingDialogTitleTextStyle: TextStyle = {
  ...dialogSansRegular,
  fontSize: 17,
  lineHeight: 22,
  fontWeight: "400",
  letterSpacing: -0.2,
  textAlign: "left",
  includeFontPadding: false,
};

/** In-dialog section heading (e.g. “Connection methods”, “Theme”). */
export const floatingDialogSectionTextStyle: TextStyle = {
  ...typographySansSemibold,
  fontSize: 16,
  lineHeight: 21,
  letterSpacing: -0.15,
  textAlign: "left",
};

/** Method / subsection label (e.g. “Scan QR”) — regular, below section. */
export const floatingDialogSubtitleTextStyle: TextStyle = {
  ...dialogSansRegular,
  fontSize: 14,
  lineHeight: 19,
  fontWeight: "400",
  letterSpacing: -0.05,
  textAlign: "left",
  includeFontPadding: false,
};

/** Supporting copy under a heading — smaller, muted at call site. */
export const floatingDialogBodyTextStyle: TextStyle = {
  ...dialogSansRegular,
  fontSize: 13,
  lineHeight: 18,
  fontWeight: "400",
  letterSpacing: 0.05,
  textAlign: "left",
  includeFontPadding: false,
};

export const floatingDialogHeaderWebNoDragProps =
  Platform.OS === "web" ? ({ "data-floating-no-drag": "1" } as object) : {};
