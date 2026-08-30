import { useCallback, useMemo, useState } from "react";
import { Platform, PixelRatio, Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { useAppStrings } from "../../../locales/AppStringsContext";
import {
  layout,
  typographyFixedRow30Label,
  useColors,
  welcomeAuthButtonActiveBackground,
  welcomeAuthButtonHoverBackground,
} from "../../theme";
import { floatingDialogSubtitleTextStyle } from "../floatingDialogChrome";
import { useTelegram } from "../Telegram";
import { SwapFilterButton } from "../icons/SwapFilterButton";

/** Matches {@link AuthenticatedHomeLeftNavStrip} total strip height. */
export const CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX = 55;
const STRIP_PADDING_PX = layout.contentSideInsetPx;
const INNER_ROW_HEIGHT_PX = CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX - STRIP_PADDING_PX * 2;

const TITLE_FONT_SIZE_PX = 20;
const TITLE_LINE_HEIGHT_PX = 25;
const TITLE_MIN_FONT_SIZE_PX = 12;
/** Reserve space for back / filter controls overlapping the centered title. */
const TITLE_SIDE_RESERVE_PX = 72;

const BACK_BUTTON_HEIGHT_PX = 30;
const BACK_BUTTON_HORIZONTAL_PADDING_PX = 15;

function titleLineHeightPx(fontSizePx: number): number {
  return Math.round(fontSizePx * (TITLE_LINE_HEIGHT_PX / TITLE_FONT_SIZE_PX));
}

function measureTitleTextWidthPx(text: string, fontSizePx: number): number {
  if (!text) return 0;

  const lineHeightPx = titleLineHeightPx(fontSizePx);

  if (Platform.OS === "web" && typeof document !== "undefined") {
    const probe = document.createElement("span");
    probe.style.position = "fixed";
    probe.style.left = "-9999px";
    probe.style.top = "0";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.whiteSpace = "nowrap";
    probe.style.fontFamily = WEB_UI_SANS_STACK;
    probe.style.fontSize = `${fontSizePx}px`;
    probe.style.fontWeight = "400";
    probe.style.lineHeight = `${lineHeightPx}px`;
    probe.textContent = text;
    document.body.appendChild(probe);
    const width = Math.ceil(probe.getBoundingClientRect().width);
    document.body.removeChild(probe);
    return width;
  }

  return Math.ceil(text.length * fontSizePx * 0.56);
}

function resolveTitleFontSizePx(text: string, availableWidthPx: number): number {
  if (availableWidthPx <= 0 || !text) return TITLE_FONT_SIZE_PX;

  const widthAtMax = measureTitleTextWidthPx(text, TITLE_FONT_SIZE_PX);
  if (widthAtMax <= availableWidthPx) return TITLE_FONT_SIZE_PX;

  const scaled = TITLE_FONT_SIZE_PX * (availableWidthPx / widthAtMax);
  return Math.max(TITLE_MIN_FONT_SIZE_PX, Math.floor(scaled * 10) / 10);
}

function titleWrapContentWidthPx(wrapWidthPx: number, titleAlign: "left" | "center"): number {
  const paddingLeft = titleAlign === "left" ? STRIP_PADDING_PX : TITLE_SIDE_RESERVE_PX;
  const paddingRight = TITLE_SIDE_RESERVE_PX;
  return Math.max(0, wrapWidthPx - paddingLeft - paddingRight);
}

function menuStripRuleThickness(): number {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && window.devicePixelRatio > 0) {
      return 1 / window.devicePixelRatio;
    }
    return 1;
  }
  return PixelRatio.roundToNearestPixel(1 / PixelRatio.get());
}

type Props = {
  onBackPress?: () => void;
  onFilterPress?: () => void;
  showBack?: boolean;
  showFilter?: boolean;
  titleAlign?: "left" | "center";
  /** Overrides default `swap.chooseCurrency.title`. */
  title?: string;
  /** Wallet name or address snippet under the title. */
  subtitle?: string;
};

export function ChooseCurrencySubheader({
  onBackPress,
  onFilterPress,
  showBack = true,
  showFilter = true,
  titleAlign = "center",
  title: titleProp,
  subtitle,
}: Props) {
  const { t } = useAppStrings();
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const [hoverBack, setHoverBack] = useState(false);
  const [titleWrapWidthPx, setTitleWrapWidthPx] = useState(0);
  const lineT = menuStripRuleThickness();
  const title = titleProp ?? t("swap.chooseCurrency.title");

  const onTitleWrapLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number } } }) => {
      const nextWidth = Math.round(event.nativeEvent.layout.width);
      setTitleWrapWidthPx((current) => (current === nextWidth ? current : nextWidth));
    },
    [],
  );

  const titleFontSizePx = useMemo(() => {
    const availableWidthPx = titleWrapContentWidthPx(titleWrapWidthPx, titleAlign);
    return resolveTitleFontSizePx(title, availableWidthPx);
  }, [title, titleAlign, titleWrapWidthPx]);

  const borderLineStyle = useMemo((): ViewStyle => {
    return {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: lineT,
      backgroundColor: colors.highlight,
      zIndex: 1,
    };
  }, [colors.highlight, lineT]);

  const titleStyle: TextStyle[] = [
    styles.title,
    {
      color: colors.primary,
      textAlign: titleAlign,
      fontSize: titleFontSizePx,
      lineHeight: titleLineHeightPx(titleFontSizePx),
    },
  ];

  return (
    <View style={styles.strip}>
      <View style={styles.row}>
        {showBack ? (
          <View style={styles.leftSlot}>
            <Pressable
              onPress={onBackPress}
              accessibilityRole="button"
              accessibilityLabel={t("common.back")}
              onHoverIn={Platform.OS === "web" ? () => setHoverBack(true) : undefined}
              onHoverOut={Platform.OS === "web" ? () => setHoverBack(false) : undefined}
              style={({ pressed }) => {
                const webHover = Platform.OS === "web" && hoverBack;
                let backgroundColor = colors.undercover;
                if (pressed) {
                  backgroundColor = welcomeAuthButtonActiveBackground(colors, colorScheme);
                } else if (webHover) {
                  backgroundColor = welcomeAuthButtonHoverBackground(colors, colorScheme);
                }
                return [
                  styles.backButton,
                  {
                    backgroundColor,
                    opacity: pressed ? 0.92 : 1,
                  },
                ];
              }}
            >
              <Text style={[typographyFixedRow30Label, { color: colors.primary }]} numberOfLines={1}>
                {t("common.back")}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.sideSlotSpacer} />
        )}

        <View
          style={[styles.titleWrap, titleAlign === "left" ? styles.titleWrapLeft : null]}
          onLayout={onTitleWrapLayout}
        >
          <Text style={titleStyle} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={[
                floatingDialogSubtitleTextStyle,
                {
                  color: colors.secondary,
                  textAlign: titleAlign,
                  width: "100%",
                  marginTop: 1,
                },
              ]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {subtitle}
            </Text>
          ) : null}
        </View>

        {showFilter ? (
          <View style={styles.rightSlot}>
            <SwapFilterButton onPress={onFilterPress} />
          </View>
        ) : (
          <View style={styles.sideSlotSpacer} />
        )}
      </View>
      <View pointerEvents="none" style={borderLineStyle} />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    width: "100%",
    alignSelf: "stretch",
    height: CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX,
    paddingTop: STRIP_PADDING_PX,
    paddingBottom: STRIP_PADDING_PX,
    position: "relative",
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: INNER_ROW_HEIGHT_PX,
    width: "100%",
    paddingHorizontal: STRIP_PADDING_PX,
  },
  leftSlot: {
    zIndex: 2,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  rightSlot: {
    zIndex: 2,
    marginLeft: "auto",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  sideSlotSpacer: {
    width: 0,
    minWidth: 0,
    flexShrink: 0,
  },
  backButton: {
    height: BACK_BUTTON_HEIGHT_PX,
    paddingHorizontal: BACK_BUTTON_HORIZONTAL_PADDING_PX,
    justifyContent: "center",
    alignItems: "center",
    alignSelf: "flex-start",
  },
  titleWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    paddingHorizontal: TITLE_SIDE_RESERVE_PX,
    pointerEvents: "none",
  },
  titleWrapLeft: {
    alignItems: "flex-start",
    paddingLeft: STRIP_PADDING_PX,
    paddingRight: TITLE_SIDE_RESERVE_PX,
  },
  title: {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontWeight: "400",
    width: "100%",
    includeFontPadding: false,
    textAlignVertical: "center",
  },
});
