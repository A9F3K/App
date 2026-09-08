import { Platform, Pressable, Text, View } from "react-native";

import { useAppStrings } from "../../locales/AppStringsContext";
import { FONT_UI_SANS_REGULAR, FONT_UI_SANS_SEMIBOLD, WEB_UI_SANS_STACK } from "../fonts";
import { useColors } from "../theme";
import { useTelegram } from "../components/Telegram";
import { AppModalSheet } from "../components/AppModalSheet";
import { HYPERLINKS_SPACE_LOGO_GREEN } from "../components/HyperlinksSpaceLogo";
import { formatUsd } from "./proAccessStore";

type Props = {
  visible: boolean;
  planLabel: string;
  priceUsd: number;
  cashbackUsd?: number | null;
  onClose: () => void;
};

/**
 * Success celebration after Pro unlocks (DLLR, TonConnect, or direct USDT).
 */
export function ProPaymentSuccessDialog({
  visible,
  planLabel,
  priceUsd,
  cashbackUsd,
  onClose,
}: Props) {
  const colors = useColors();
  const { colorScheme } = useTelegram();
  const lightTheme = colorScheme === "light";
  const { t, tf } = useAppStrings();
  const labelFont = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR;
  const titleFont = Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_SEMIBOLD;
  const green = HYPERLINKS_SPACE_LOGO_GREEN;

  if (!visible) return null;

  return (
    <AppModalSheet
      visible
      onClose={onClose}
      title={t("pro.pay.success.title")}
      fitContentHeight
      sizeStorageKey="hsp.proPaySuccess.size.v1"
      offsetStorageKey="hsp.proPaySuccess.offset.v1"
    >
      <View style={{ alignItems: "center", gap: 14, paddingBottom: 4 }}>
        <View
          style={{
            width: 72,
            height: 72,
            borderRadius: 36,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: lightTheme ? "rgba(0,200,80,0.14)" : "rgba(0,224,90,0.18)",
            borderWidth: 1.5,
            borderColor: green,
            ...(Platform.OS === "web"
              ? ({
                  boxShadow: lightTheme
                    ? `0 0 0 4px rgba(0,200,80,0.08), 0 8px 24px rgba(0,120,40,0.18)`
                    : `0 0 0 4px rgba(0,224,90,0.12), 0 10px 28px rgba(0,224,90,0.22)`,
                } as object)
              : null),
          }}
        >
          <Text
            style={{
              color: green,
              fontSize: 34,
              lineHeight: 38,
              fontWeight: "700",
              fontFamily: titleFont,
            }}
          >
            ✓
          </Text>
        </View>

        <Text
          style={{
            color: colors.secondary,
            fontSize: 14,
            lineHeight: 20,
            textAlign: "center",
            fontFamily: labelFont,
          }}
        >
          {tf("pro.pay.success.body", {
            plan: planLabel,
            price: formatUsd(priceUsd),
          })}
        </Text>

        {cashbackUsd != null && cashbackUsd > 0 ? (
          <View
            style={{
              alignSelf: "stretch",
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: colors.undercover,
              borderWidth: 1,
              borderColor: green,
            }}
          >
            <Text
              style={{
                color: green,
                fontSize: 13,
                lineHeight: 18,
                textAlign: "center",
                fontFamily: labelFont,
                fontWeight: "600",
              }}
            >
              {tf("pro.pay.success.cashback", { cashback: formatUsd(cashbackUsd) })}
            </Text>
          </View>
        ) : null}

        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => ({
            marginTop: 4,
            alignSelf: "stretch",
            paddingHorizontal: 22,
            paddingVertical: 12,
            borderRadius: 12,
            backgroundColor: green,
            opacity: pressed ? 0.88 : 1,
          })}
        >
          <Text
            style={{
              color: "#FFFFFF",
              fontSize: 15,
              fontWeight: "700",
              textAlign: "center",
              fontFamily: titleFont,
            }}
          >
            {t("pro.pay.success.done")}
          </Text>
        </Pressable>
      </View>
    </AppModalSheet>
  );
}
