import { useMemo } from "react";
import { View, useWindowDimensions } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { useWalletHeldCurrencyRows } from "../../wallet/useWalletHeldCurrencyRows";
import { getInitDataString } from "../telegramWebApp";
import { formatWalletDialogSubtitle } from "../../wallet/formatWalletDialogSubtitle";
import { resolveFloatingDialogInsets } from "../floatingDialogChrome";
import { resolveFloatingDialogDefaultSize } from "../floatingDialogGeometry";
import { FloatingDialogShell } from "../FloatingDialogShell";
import { FloatingDialogStickyHeader } from "../FloatingDialogStickyHeader";
import { ChooseCurrencyTable } from "../swap/ChooseCurrencyTable";

const WALLET_HELD_COLUMNS = ["currency", "balance", "rate"] as const;

type Props = {
  visible: boolean;
  onClose: () => void;
  walletAddress: string;
  displayName: string;
  title?: string;
};

/** Floating dialog listing currencies held on the built-in wallet (non-zero balances only). */
export function WalletCurrenciesDialog({
  visible,
  onClose,
  walletAddress,
  displayName,
  title: titleProp,
}: Props) {
  const { t, tf } = useAppStrings();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const defaultSize = useMemo(
    () => resolveFloatingDialogDefaultSize(windowWidth, windowHeight, "picker"),
    [windowHeight, windowWidth],
  );
  const dialogInsets = resolveFloatingDialogInsets(windowHeight);
  const trimmedWallet = walletAddress.trim() || null;
  const { rows, isLoading, error } = useWalletHeldCurrencyRows(trimmedWallet, visible, getInitDataString());
  const title = titleProp ?? t("home.header.walletCurrenciesTitle");
  const subtitle = formatWalletDialogSubtitle(displayName, walletAddress, t, tf);

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={10070}
      defaultSize={defaultSize}
      minSize={{ width: 300, height: 240 }}
      sizeStorageKey="hsp.walletCurrencies.size.v1"
      movable={false}
      onRequestClose={onClose}
      testId="wallet-currencies"
    >
      <View style={{ flex: 1, minHeight: 0 }}>
        <FloatingDialogStickyHeader
          insets={dialogInsets}
          title={title}
          subtitle={subtitle}
          onClose={onClose}
          closeLabel={t("common.close")}
        />
        <ChooseCurrencyTable
          rows={rows}
          isLoading={isLoading}
          loadError={error}
          columnShellWidthPx={defaultSize.width}
          visibleColumnKeys={WALLET_HELD_COLUMNS}
          prefetchCharts={false}
          listEmptyMessage={t("home.header.walletCurrenciesEmpty")}
        />
      </View>
    </FloatingDialogShell>
  );
}
