import { useRouter } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

import { AuthenticatedAppShell } from "../components/AuthenticatedAppShell";
import { ChooseCurrencyPanelContent } from "../components/swap/ChooseCurrencyPanelContent";
import { useTelegram } from "../components/Telegram";
import { useChooseCurrencyChrome } from "../swap/chooseCurrencyChrome";

/** Narrow `/swap/currency`: subheader-only on TMA desktop / browser compact; logo header on TMA mobile. */
export function ChooseCurrencyScreen() {
  const router = useRouter();
  const { wallet } = useTelegram();
  const { hideLogoHeader } = useChooseCurrencyChrome();

  const onFilterPress = useCallback(() => {
    // Filter sheet — placeholder for follow-up.
  }, []);

  const onBackPress = useCallback(() => {
    router.back();
  }, [router]);

  const onAfterSelect = useCallback(() => {
    router.back();
  }, [router]);

  return (
    <AuthenticatedAppShell
      showLogoHeader={!hideLogoHeader}
      showBrowserBackButton={!hideLogoHeader}
    >
      <View style={{ flex: 1, width: "100%", minHeight: 0 }}>
        <ChooseCurrencyPanelContent
          onFilterPress={onFilterPress}
          onBackPress={onBackPress}
          onAfterSelect={onAfterSelect}
          walletAddress={wallet?.wallet_address ?? null}
        />
      </View>
    </AuthenticatedAppShell>
  );
}
