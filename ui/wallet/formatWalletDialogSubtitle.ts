import type { AppStringKey } from "../../locales/appStrings";
import { trimWalletAddress, walletAddressHeaderSnippet } from "./walletAddressFormat";

type Translate = (key: AppStringKey) => string;
type TranslateFormat = (
  key: AppStringKey,
  params: Record<string, string>,
) => string;

/** Subtitle for wallet-scoped dialogs: name when set, otherwise address snippet. */
export function formatWalletDialogSubtitle(
  displayName: string,
  walletAddress: string,
  t: Translate,
  tf: TranslateFormat,
): string {
  const trimmed = trimWalletAddress(walletAddress);
  const snippet = walletAddressHeaderSnippet(trimmed);
  const name = displayName.trim();
  const emDash = t("common.emDash");
  if (name && name !== emDash) {
    return tf("wallet.dialogSubtitleNamed", { name, snippet });
  }
  return tf("wallet.dialogSubtitleAddress", { snippet });
}

/** Subtitle for Get — TonConnect external wallet (not the app built-in wallet). */
export function formatConnectedWalletDialogSubtitle(
  walletName: string | null | undefined,
  walletAddress: string | null | undefined,
  t: Translate,
  tf: TranslateFormat,
): string {
  const trimmed = trimWalletAddress(walletAddress ?? "");
  if (!trimmed) {
    return t("get.chooseCurrencyNotConnected");
  }
  const name = walletName?.trim() || t("get.connectedWalletFallbackName");
  return formatWalletDialogSubtitle(name, trimmed, t, tf);
}
