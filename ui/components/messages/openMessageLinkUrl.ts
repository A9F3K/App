import * as Linking from "expo-linking";
import { Platform } from "react-native";
import { openTelegramDeepLink } from "../../telegram/openTelegramDeepLink";
import {
  extractTelegramUsernameFromMention,
  extractTelegramUsernameFromUrl,
  isInAppTelegramUsernameLink,
  openTelegramUsernameInApp,
  tryOpenTelegramEntityInApp,
} from "../../telegram/openTelegramEntityLink";

type TelegramWebAppBridge = {
  openTelegramLink?: (url: string) => void;
};

function getTelegramWebApp(): TelegramWebAppBridge | null {
  if (typeof window === "undefined") return null;
  const tg = (window as { Telegram?: { WebApp?: TelegramWebAppBridge } }).Telegram?.WebApp;
  return tg ?? null;
}

function openExternalMessageLink(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;

  if (/^tg:\/\//i.test(trimmed)) {
    openTelegramDeepLink(trimmed);
    return;
  }

  const webApp = getTelegramWebApp();
  if (webApp?.openTelegramLink && /^https?:\/\/t\.me\//i.test(trimmed)) {
    webApp.openTelegramLink(trimmed);
    return;
  }

  if (Platform.OS === "web" && typeof window !== "undefined") {
    window.open(trimmed, "_blank", "noopener,noreferrer");
    return;
  }

  void Linking.openURL(trimmed);
}

/** Open http(s), t.me, tg://, or @username links — prefer in-app Telegram entities. */
export function openMessageLinkUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;

  void (async () => {
    const mentionUser = extractTelegramUsernameFromMention(trimmed);
    if (mentionUser) {
      await openTelegramUsernameInApp(mentionUser);
      // Never hand public @mentions to Telegram — stay in Hyperlinks Space.
      return;
    }
    if (await tryOpenTelegramEntityInApp(trimmed)) return;
    // Public t.me/@username already attempted above; do not open Telegram for those.
    if (isInAppTelegramUsernameLink(trimmed) || extractTelegramUsernameFromUrl(trimmed)) {
      return;
    }
    openExternalMessageLink(trimmed);
  })();
}
