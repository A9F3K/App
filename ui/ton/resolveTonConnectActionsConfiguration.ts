/** Telegram mini app link used to return from wallet TWAs after TonConnect actions. */
export const HSP_TMA_RETURN_URL = "https://t.me/HyperlinksSpaceBot" as const;

/**
 * TonConnect action UX defaults for HSP.
 *
 * - Wallet apps still show their own confirm UI.
 * - `returnStrategy: 'back'` returns the user to the browser tab / host app.
 * - `twaReturnUrl` is used when both HSP and the wallet run as Telegram mini apps.
 */
export function resolveTonConnectActionsConfiguration() {
  return {
    modals: ["before"] as const,
    notifications: ["before"] as const,
    returnStrategy: "back" as const,
    twaReturnUrl: HSP_TMA_RETURN_URL,
  };
}
