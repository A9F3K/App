/** True when the user dismissed TonConnect / wallet confirmation without signing. */
export function isTonConnectUserRejection(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "";
  const normalized = message.toLowerCase();
  return (
    normalized.includes("reject") ||
    normalized.includes("cancel") ||
    normalized.includes("closed") ||
    normalized.includes("user declines") ||
    normalized.includes("user denied")
  );
}
