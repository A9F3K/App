import { Platform } from "react-native";

import { WEB_UI_SANS_STACK } from "../fonts";

/** Matches {@link typographyFixedRow30Label} on the Connect Telegram pill label. */
export const TELEGRAM_CONNECT_PILL_LABEL_FONT_SIZE_PX = 15;
export const TELEGRAM_CONNECT_PILL_LABEL_LINE_HEIGHT_PX = 18;

/** 10px | 20px logo | 10px | label | 10px — matches Get undercover button horizontal padding. */
export const TELEGRAM_CONNECT_PILL_LOGO_LEFT_PX = 10;
export const TELEGRAM_CONNECT_PILL_LOGO_SIZE_PX = 20;
export const TELEGRAM_CONNECT_PILL_LOGO_TO_TEXT_GAP_PX = 10;
export const TELEGRAM_CONNECT_PILL_TEXT_RIGHT_PX = 10;

export const TELEGRAM_CONNECT_PILL_CHROME_WIDTH_PX =
  TELEGRAM_CONNECT_PILL_LOGO_LEFT_PX +
  TELEGRAM_CONNECT_PILL_LOGO_SIZE_PX +
  TELEGRAM_CONNECT_PILL_LOGO_TO_TEXT_GAP_PX +
  TELEGRAM_CONNECT_PILL_TEXT_RIGHT_PX;

export function telegramConnectPillWidthFromLabelLinePx(
  textLineWidth: number,
  maxPillWidthPx: number,
): number {
  if (textLineWidth <= 0) return 0;
  const contentWidth = TELEGRAM_CONNECT_PILL_CHROME_WIDTH_PX + Math.ceil(textLineWidth);
  return Math.min(maxPillWidthPx, contentWidth);
}

export function telegramConnectMaxPillWidthInStripPx(
  stripWidth: number,
  chipSizePx: number,
  contentSideInsetPx: number,
): number {
  if (stripWidth <= 0) return Number.POSITIVE_INFINITY;
  return stripWidth - contentSideInsetPx * 2 - chipSizePx * 2;
}

/** Single-line label width (web DOM probe; native should use `Text` `onTextLayout`). */
export function measureTelegramConnectPillLabelLineWidthPx(label: string): number {
  if (!label) return 0;
  if (Platform.OS !== "web" || typeof document === "undefined") return 0;

  const probe = document.createElement("span");
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "nowrap";
  probe.style.fontFamily = WEB_UI_SANS_STACK;
  probe.style.fontSize = `${TELEGRAM_CONNECT_PILL_LABEL_FONT_SIZE_PX}px`;
  probe.style.fontWeight = "400";
  probe.style.lineHeight = `${TELEGRAM_CONNECT_PILL_LABEL_LINE_HEIGHT_PX}px`;
  probe.textContent = label;
  document.body.appendChild(probe);
  const width = Math.ceil(probe.getBoundingClientRect().width);
  document.body.removeChild(probe);
  return width;
}
