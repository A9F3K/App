import { useLayoutEffect } from "react";
import { View } from "react-native";

import { AuthenticatedAppShell } from "../components/AuthenticatedAppShell";
import { ChooseCurrencyPanelContent } from "../components/swap/ChooseCurrencyPanelContent";
import { SwapPanelContent } from "../components/SwapPanelContent";
import { useTelegram } from "../components/Telegram";
import {
  openSwapCurrenciesBrowse,
  shouldOpenSwapCurrenciesBrowseOnSwapScreen,
  useSwapCurrencyPicker,
} from "../swap/swapCurrencyPicker";

/** Narrow `/swap`: Currencies list first; selecting a row shows the swap form. */
export function SwapScreen() {
  const pickerMode = useSwapCurrencyPicker();
  const { wallet } = useTelegram();

  useLayoutEffect(() => {
    if (shouldOpenSwapCurrenciesBrowseOnSwapScreen()) {
      openSwapCurrenciesBrowse();
    }
  }, []);

  return (
    <AuthenticatedAppShell>
      <View style={{ flex: 1, width: "100%", minHeight: 0 }}>
        {pickerMode != null ? (
          <ChooseCurrencyPanelContent walletAddress={wallet?.wallet_address ?? null} />
        ) : (
          <SwapPanelContent />
        )}
      </View>
    </AuthenticatedAppShell>
  );
}
