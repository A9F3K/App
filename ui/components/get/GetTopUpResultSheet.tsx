import { useMemo } from "react";
import { Platform, Text, View } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { appLocaleToBcp47 } from "../../../locales/appStrings";
import { FONT_UI_SANS_REGULAR, WEB_UI_SANS_STACK } from "../../fonts";
import { swapTokenDisplaySymbol, type SwapPairToken } from "../../swap/swapPairTypes";
import { useColors } from "../../theme";
import { AppModalSheet } from "../AppModalSheet";
import { floatingDialogBodyTextStyle } from "../floatingDialogChrome";
import { MessageChatInlineTgsEmoji } from "../messages/MessageChatInlineTgsEmoji";

export type GetTopUpResult =
  | {
      kind: "success";
      amount: string;
      token: SwapPairToken;
      walletAddress: string;
      landedAtMs: number;
    }
  | { kind: "failed"; detail?: string }
  | { kind: "cancelled" };

type Props = {
  result: GetTopUpResult | null;
  onClose: () => void;
};

function formatWalletDetail(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return "—";
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-8)}`;
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const colors = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 8,
      }}
    >
      <Text
        style={{
          color: colors.secondary,
          fontSize: 14,
          lineHeight: 20,
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          flex: 1,
          textAlign: "right",
          color: colors.primary,
          fontSize: 14,
          lineHeight: 20,
          fontWeight: "600",
          fontFamily: Platform.OS === "web" ? WEB_UI_SANS_STACK : FONT_UI_SANS_REGULAR,
          ...(mono && Platform.OS === "web"
            ? ({ fontVariantNumeric: "tabular-nums" } as object)
            : null),
        }}
        numberOfLines={2}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function SuccessAnimation({ emoji }: { emoji: string }) {
  return (
    <View
      style={{
        width: 112,
        height: 112,
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "center",
        marginBottom: 8,
      }}
    >
      <MessageChatInlineTgsEmoji
        emoji={emoji}
        sizePx={96}
        fallbackText={emoji}
        priority
        fetchEnabled
      />
    </View>
  );
}

export function GetTopUpResultSheet({ result, onClose }: Props) {
  const { t, tf, locale } = useAppStrings();
  const colors = useColors();

  const timeLabel = useMemo(() => {
    if (!result || result.kind !== "success") return "";
    try {
      return new Date(result.landedAtMs).toLocaleString(appLocaleToBcp47(locale), {
        dateStyle: "medium",
        timeStyle: "medium",
      });
    } catch {
      return new Date(result.landedAtMs).toISOString();
    }
  }, [locale, result]);

  if (!result) return null;

  const title =
    result.kind === "success"
      ? t("get.topUpSuccessTitle")
      : result.kind === "cancelled"
        ? t("get.topUpCancelledTitle")
        : t("get.topUpFailedTitle");

  if (result.kind === "success") {
    const symbol = swapTokenDisplaySymbol(result.token);
    const amountLabel = `${result.amount} ${symbol}`;
    const walletLabel = formatWalletDetail(result.walletAddress);

    return (
      <AppModalSheet
        visible
        onClose={onClose}
        title={title}
        fitContentHeight
        sizeStorageKey="hsp.getTopUpResult.size.v2"
        offsetStorageKey="hsp.getTopUpResult.offset.v2"
      >
        <SuccessAnimation emoji="✅" />
        <Text
          style={{
            ...floatingDialogBodyTextStyle,
            color: colors.secondary,
            textAlign: "center",
            marginBottom: 12,
          }}
        >
          {t("get.topUpSuccessHint")}
        </Text>
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.highlight,
            paddingTop: 4,
          }}
        >
          <DetailRow label={t("get.topUpDetail.amount")} value={amountLabel} />
          <DetailRow label={t("get.topUpDetail.wallet")} value={walletLabel} mono />
          <DetailRow label={t("get.topUpDetail.time")} value={timeLabel} />
        </View>
      </AppModalSheet>
    );
  }

  const body =
    result.kind === "cancelled"
      ? t("get.topUpCancelledBody")
      : result.detail
        ? tf("get.topUpFailedBodyDetail", { detail: result.detail })
        : t("get.topUpFailedBody");

  return (
    <AppModalSheet
      visible
      onClose={onClose}
      title={title}
      fitContentHeight
      sizeStorageKey="hsp.getTopUpResult.size.v2"
      offsetStorageKey="hsp.getTopUpResult.offset.v2"
    >
      <SuccessAnimation emoji={result.kind === "cancelled" ? "⚠️" : "❌"} />
      <Text style={[floatingDialogBodyTextStyle, { color: colors.secondary, textAlign: "center" }]}>
        {body}
      </Text>
    </AppModalSheet>
  );
}
