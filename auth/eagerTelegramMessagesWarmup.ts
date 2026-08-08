import { buildApiUrl } from "../api/_base";

/**
 * Start gateway warmup as soon as auth session says MTProto is linked —
 * before React commits HomeAuthenticatedScreen (which can block effects for seconds).
 */
let inFlight: Promise<void> | null = null;
let lastStartedAt = 0;

export function kickEagerTelegramMessagesWarmup(reason: string): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  // Coalesce with ConnectionProvider's silentWarmup within the same cold start.
  if (inFlight && now - lastStartedAt < 8_000) return;
  lastStartedAt = now;
  const url = buildApiUrl("/api/telegram-messages-warmup");
  inFlight = fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (inFlight) inFlight = null;
    });
  void reason;
}
