/**
 * Pro subscription + DLLR top-up payment destination (same treasury for both).
 * Receives native TON and USDT (jetton) on the TON network.
 * Override with EXPO_PUBLIC_PRO_PAYMENT_TON_ADDRESS (set on Vercel for prod).
 */
export const PRO_PAYMENT_TON_ADDRESS_DEFAULT =
  "UQBY1YCIlm0cB00xcyaWV0xd_N-Zcgw_-6gWA3XUUNgM-NF8";

export function resolveProPaymentTonAddress(): string {
  const fromEnv =
    typeof process !== "undefined"
      ? process.env.EXPO_PUBLIC_PRO_PAYMENT_TON_ADDRESS?.trim()
      : "";
  return fromEnv || PRO_PAYMENT_TON_ADDRESS_DEFAULT;
}
