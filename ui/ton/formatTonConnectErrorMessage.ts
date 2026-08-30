/** Best-effort human-readable message from TonConnect / wallet errors. */
export function formatTonConnectErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) return message;
  }
  if (typeof error === "string") {
    const message = error.trim();
    if (message) return message;
  }
  const nested = (error as { message?: unknown } | null)?.message;
  if (typeof nested === "string") {
    const message = nested.trim();
    if (message) return message;
  }
  return undefined;
}
