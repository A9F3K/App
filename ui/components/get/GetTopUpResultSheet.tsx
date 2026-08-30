import { Text } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { swapTokenDisplaySymbol, type SwapPairToken } from "../../swap/swapPairTypes";
import { AppModalSheet, AppModalSheetBackFooter } from "../AppModalSheet";
import { floatingDialogBodyTextStyle } from "../floatingDialogChrome";

export type GetTopUpResult =
  | { kind: "success"; amount: string; token: SwapPairToken }
  | { kind: "failed"; detail?: string }
  | { kind: "cancelled" };

type Props = {
  result: GetTopUpResult | null;
  onClose: () => void;
};

export function GetTopUpResultSheet({ result, onClose }: Props) {
  const { t, tf } = useAppStrings();

  if (!result) return null;

  const title =
    result.kind === "success"
      ? t("get.topUpSuccessTitle")
      : result.kind === "cancelled"
        ? t("get.topUpCancelledTitle")
        : t("get.topUpFailedTitle");

  const body =
    result.kind === "success"
      ? tf("get.topUpSuccessBody", {
          amount: result.amount,
          symbol: swapTokenDisplaySymbol(result.token),
        })
      : result.kind === "cancelled"
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
      sizeStorageKey="hsp.getTopUpResult.size.v1"
      offsetStorageKey="hsp.getTopUpResult.offset.v1"
      footer={<AppModalSheetBackFooter onClose={onClose} label={t("common.close")} />}
    >
      <Text style={floatingDialogBodyTextStyle}>{body}</Text>
    </AppModalSheet>
  );
}
