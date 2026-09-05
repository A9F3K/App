import { useMemo, useState } from "react";
import { Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from "react-native-svg";

import { useAppStrings } from "../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../fonts";
import { FREE_MESSENGER_ACCOUNT_LIMIT } from "../messages/messengerAccountsStore";
import { useColors } from "../theme";
import { FloatingDialogShell } from "../components/FloatingDialogShell";
import { FloatingDialogBody } from "../components/FloatingDialogBody";
import { FloatingDialogStickyHeader } from "../components/FloatingDialogStickyHeader";
import { FloatingDialogScrollChromeProvider } from "../components/floatingDialogScrollChrome";
import { resolveFloatingDialogInsets } from "../components/floatingDialogChrome";
import { resolveFloatingDialogDefaultSize } from "../components/floatingDialogGeometry";
import { HspScrollColumn } from "../components/HspScrollColumn";
import { SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX } from "../scrollIndicatorPx";

const PRO_GRADIENT = ["#7B5CFF", "#E84AC8"] as const;

function LimitBubble({ count }: { count: number }) {
  return (
    <View style={{ width: 72, height: 64, alignItems: "center", justifyContent: "center" }}>
      <Svg width={72} height={64} viewBox="0 0 72 64" style={{ position: "absolute" }}>
        <Defs>
          <LinearGradient id="proLimitBubble" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor={PRO_GRADIENT[0]} />
            <Stop offset="100%" stopColor={PRO_GRADIENT[1]} />
          </LinearGradient>
        </Defs>
        <Path
          d="M10 8h44c5.5 0 10 4.5 10 10v18c0 5.5-4.5 10-10 10H34l-10 10v-10H10c-5.5 0-10-4.5-10-10V18c0-5.5 4.5-10 10-10z"
          fill="url(#proLimitBubble)"
        />
      </Svg>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: -4 }}>
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
          <Circle cx="12" cy="8" r="4" stroke="#fff" strokeWidth={2} />
          <Path
            d="M4 20c0-4 3.6-7 8-7s8 3 8 7"
            stroke="#fff"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </Svg>
        <Text
          style={{
            color: "#fff",
            fontSize: 18,
            fontWeight: "800",
            fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
          }}
        >
          {count}
        </Text>
      </View>
    </View>
  );
}

type Props = {
  visible: boolean;
  onClose: () => void;
  onBuyProAccess: () => void;
};

export function AccountLimitReachedDialog({ visible, onClose, onBuyProAccess }: Props) {
  const colors = useColors();
  const { t, tf } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [headerExtendPx, setHeaderExtendPx] = useState(0);
  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "modal"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={12040}
      defaultSize={defaultSize}
      minSize={{ width: 320, height: 280 }}
      fitContentHeight
      sizeStorageKey="hsp.accountLimit.size.v1"
      onRequestClose={onClose}
      testId="account-limit-reached"
    >
      <FloatingDialogScrollChromeProvider headerExtendPx={headerExtendPx}>
        <FloatingDialogBody>
          <FloatingDialogStickyHeader
            insets={dialogInsets}
            onClose={onClose}
            closeLabel={t("common.close")}
            title={t("pro.limit.title")}
            onHeightChange={setHeaderExtendPx}
          />
          <HspScrollColumn
            style={{ flex: 1, minHeight: 0 }}
            scrollIndicatorOverlaySeam={false}
            containOverscroll
            scrollbarRightInsetPx={SCROLL_INDICATOR_OVERLAY_CHROME_BORDER_INSET_PX}
            indicatorColor={colors.scrollIndicator}
            contentContainerStyle={{
              paddingHorizontal: dialogInsets.padX,
              paddingBottom: 20,
              gap: 16,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                justifyContent: "space-between",
              }}
            >
              <View style={{ flex: 1, paddingRight: 12, paddingTop: 6 }}>
                <Text
                  style={{
                    color: colors.primary,
                    fontSize: 14,
                    lineHeight: 20,
                    fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                  }}
                >
                  {tf("pro.limit.body", { limit: FREE_MESSENGER_ACCOUNT_LIMIT })}
                </Text>
              </View>
              <LimitBubble count={FREE_MESSENGER_ACCOUNT_LIMIT} />
            </View>

            <View
              style={{
                flexDirection: "row",
                borderRadius: 12,
                overflow: "hidden",
                minHeight: 44,
              }}
            >
              <View
                style={{
                  flex: 1,
                  backgroundColor: colors.undercover,
                  paddingHorizontal: 14,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ color: colors.primary, fontWeight: "700", fontSize: 14 }}>
                  {t("pro.limit.free")}
                </Text>
                <Text style={{ color: colors.primary, fontWeight: "700", fontSize: 14 }}>
                  {FREE_MESSENGER_ACCOUNT_LIMIT}
                </Text>
              </View>
              <View
                style={{
                  flex: 1.15,
                  paddingHorizontal: 14,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  ...(Platform.OS === "web"
                    ? ({
                        backgroundImage: `linear-gradient(90deg, ${PRO_GRADIENT[0]}, ${PRO_GRADIENT[1]})`,
                      } as object)
                    : { backgroundColor: PRO_GRADIENT[0] }),
                }}
              >
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                  {t("pro.limit.proAccess")}
                </Text>
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>∞</Text>
              </View>
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={onBuyProAccess}
              style={({ pressed }) => ({
                opacity: pressed ? 0.88 : 1,
                borderRadius: 999,
                paddingVertical: 14,
                alignItems: "center",
                ...(Platform.OS === "web"
                  ? ({
                      backgroundImage: `linear-gradient(90deg, ${PRO_GRADIENT[0]}, ${PRO_GRADIENT[1]})`,
                    } as object)
                  : { backgroundColor: PRO_GRADIENT[0] }),
              })}
            >
              <Text
                style={{
                  color: "#fff",
                  fontSize: 16,
                  fontWeight: "800",
                  fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
                }}
              >
                {t("pro.buyCta")}
              </Text>
            </Pressable>
          </HspScrollColumn>
        </FloatingDialogBody>
      </FloatingDialogScrollChromeProvider>
    </FloatingDialogShell>
  );
}
