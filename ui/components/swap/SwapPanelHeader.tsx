import { useMemo, useState } from "react";
import {
  Platform,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { useAppStrings } from "../../../locales/AppStringsContext";
import { useSwapPairState } from "../../swap/swapPairStore";
import { swapTokenDisplaySymbol } from "../../swap/swapPairTypes";
import {
  layout,
  typographyFixedRow30Label,
  useColors,
  welcomeAuthButtonActiveBackground,
  welcomeAuthButtonHoverBackground,
} from "../../theme";
import { useTelegram } from "../Telegram";
import { CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX } from "./ChooseCurrencySubheader";

const STRIP_PADDING_PX = layout.contentSideInsetPx;
const INNER_ROW_HEIGHT_PX = CHOOSE_CURRENCY_SUBHEADER_HEIGHT_PX - STRIP_PADDING_PX * 2;

const TITLE_FONT_SIZE_PX = 20;
const TITLE_LINE_HEIGHT_PX = 25;
const TITLE_MIN_FONT_SIZE_PX = 12;
const TITLE_SIDE_RESERVE_PX = 96;

const BUTTON_HEIGHT_PX = 30;
const BUTTON_HORIZONTAL_PADDING_PX = 15;

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
  onCurrenciesPress?: () => void;
};

/** Swap form subheader: pair title left, Currencies button right. */
export function SwapPanelHeader({ onCurrenciesPress }: Props) {
  const { t, tf } = useAppStrings();
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const { sellToken, buyToken } = useSwapPairState();
  const [hoverCurrencies, setHoverCurrencies] = useState(false);
  const [titleWrapWidthPx, setTitleWrapWidthPx] = useState(0);
  const lineT = menuStripRuleThickness();

  const title = tf("swap.panel.pairTitle", {
    sell: swapTokenDisplaySymbol(sellToken),
    buy: swapTokenDisplaySymbol(buyToken),
  });

  const titleFontSizePx = useMemo(() => {
    const available = Math.max(
      0,
      titleWrapWidthPx - STRIP_PADDING_PX - TITLE_SIDE_RESERVE_PX,
    );
    return resolveTitleFontSizePx(title, available);
  }, [title, titleWrapWidthPx]);

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
      textAlign: "left",
      fontSize: titleFontSizePx,
      lineHeight: titleLineHeightPx(titleFontSizePx),
    },
  ];

  return (
    <View style={styles.strip}>
      <View style={styles.row}>
        <View
          style={styles.titleWrap}
          onLayout={(event) => {
            const nextWidth = Math.round(event.nativeEvent.layout.width);
            setTitleWrapWidthPx((current) =>
              current === nextWidth ? current : nextWidth,
            );
          }}
        >
          <Text style={titleStyle} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
        </View>

        <View style={styles.rightSlot}>
          <Pressable
            onPress={onCurrenciesPress}
            accessibilityRole="button"
            accessibilityLabel={t("swap.panel.currenciesButton")}
            onHoverIn={
              Platform.OS === "web" ? () => setHoverCurrencies(true) : undefined
            }
            onHoverOut={
              Platform.OS === "web" ? () => setHoverCurrencies(false) : undefined
            }
            style={({ pressed }) => {
              const webHover = Platform.OS === "web" && hoverCurrencies;
              let backgroundColor = colors.undercover;
              if (pressed) {
                backgroundColor = welcomeAuthButtonActiveBackground(
                  colors,
                  colorScheme,
                );
              } else if (webHover) {
                backgroundColor = welcomeAuthButtonHoverBackground(
                  colors,
                  colorScheme,
                );
              }
              return [
                styles.currenciesButton,
                {
                  backgroundColor,
                  opacity: pressed ? 0.92 : 1,
                },
              ];
            }}
          >
            <Text
              style={[typographyFixedRow30Label, { color: colors.primary }]}
              numberOfLines={1}
            >
              {t("swap.panel.currenciesButton")}
            </Text>
          </Pressable>
        </View>
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
    overflow: "visible",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: INNER_ROW_HEIGHT_PX,
    width: "100%",
    paddingHorizontal: STRIP_PADDING_PX,
  },
  rightSlot: {
    zIndex: 2,
    marginLeft: "auto",
    alignItems: "flex-end",
    justifyContent: "center",
  },
  currenciesButton: {
    height: BUTTON_HEIGHT_PX,
    paddingHorizontal: BUTTON_HORIZONTAL_PADDING_PX,
    justifyContent: "center",
    alignItems: "center",
    alignSelf: "flex-end",
  },
  titleWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "flex-start",
    paddingLeft: STRIP_PADDING_PX,
    paddingRight: TITLE_SIDE_RESERVE_PX,
    pointerEvents: "none",
  },
  title: {
    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
    fontWeight: "400",
    width: "100%",
    includeFontPadding: false,
    textAlignVertical: "center",
  },
});
