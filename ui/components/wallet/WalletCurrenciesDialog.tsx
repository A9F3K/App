import { useCallback, useMemo } from "react";
import { useWindowDimensions } from "react-native";

import { useAppStrings } from "../../../locales/AppStringsContext";
import { openAuthenticatedHomeRightPanel } from "../../authenticatedHomeRightPanel";
import { useWalletHeldCurrencyRows } from "../../wallet/useWalletHeldCurrencyRows";
import { formatWalletDialogSubtitle } from "../../wallet/formatWalletDialogSubtitle";
import type { ChooseCurrencyRow } from "../swap/chooseCurrencyTableTypes";
import { getInitDataString } from "../telegramWebApp";
import { resolveFloatingDialogInsets } from "../floatingDialogChrome";
import { resolveFloatingDialogDefaultSize } from "../floatingDialogGeometry";
import { FloatingDialogShell } from "../FloatingDialogShell";
import { FloatingDialogBody } from "../FloatingDialogBody";
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

  const onWalletAction = useCallback(
    (action: "send" | "swap" | "get", _row: ChooseCurrencyRow) => {
      openAuthenticatedHomeRightPanel(action);
      onClose();
    },
    [onClose],
  );

  return (
    <FloatingDialogShell
      visible={visible}
      zIndex={10070}
      defaultSize={defaultSize}
      minSize={{ width: 300, height: 240 }}
      sizeStorageKey="hsp.walletCurrencies.size.v2"
      offsetStorageKey="hsp.walletCurrencies.offset.v2"
      onRequestClose={onClose}
      testId="wallet-currencies"
    >
      <FloatingDialogBody>
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
          visibleColumnKeys={WALLET_HELD_COLUMNS}
          prefetchCharts={false}
          listEmptyMessage={t("home.header.walletCurrenciesEmpty")}
          contentInsetPx={dialogInsets.padX}
          onWalletAction={onWalletAction}
        />
      </FloatingDialogBody>
    </FloatingDialogShell>
  );
}
