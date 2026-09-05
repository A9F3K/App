/**
 * Pro subscription + DLLR top-up payment destination (same treasury for both).
 * Override with EXPO_PUBLIC_PRO_PAYMENT_TON_ADDRESS when needed.
 */
export const PRO_PAYMENT_TON_ADDRESS_DEFAULT =
  "UQDFuzKogL4d5VYZxkFGeIcCwTprgzJWZ5PsqCmRJ9F1iUv3";

export function resolveProPaymentTonAddress(): string {
  const fromEnv =
    typeof process !== "undefined"
      ? process.env.EXPO_PUBLIC_PRO_PAYMENT_TON_ADDRESS?.trim()
      : "";
  return fromEnv || PRO_PAYMENT_TON_ADDRESS_DEFAULT;
}
