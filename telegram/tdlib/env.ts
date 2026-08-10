import path from "path";

export function getTdlibDbRoot(): string {
  const root = (process.env.TDLIB_DB_ROOT || path.join(process.cwd(), ".tdlib-data")).trim();
  return path.resolve(root);
}

/**
 * `slim` — persist only MTProto auth on disk; do not mirror chats/messages/files
 * into SQLite (Telegram remains source of truth; fetch on demand into RAM).
 * `full` — classic TDLib Desktop-style local DB (multi-GB per heavy user).
 */
export type TdlibStorageMode = "slim" | "full";

export function getTdlibStorageMode(): TdlibStorageMode {
  const raw = (process.env.TDLIB_STORAGE_MODE || "slim").trim().toLowerCase();
  return raw === "full" ? "full" : "slim";
}

/**
 * `lazy` — only open TDLib when a user hits the API (mass scale).
 * `eager` — restore every on-disk session at gateway boot (legacy).
 */
export type TdlibRestoreMode = "lazy" | "eager";

export function getTdlibRestoreMode(): TdlibRestoreMode {
  const raw = (process.env.TDLIB_RESTORE_MODE || "lazy").trim().toLowerCase();
  return raw === "eager" ? "eager" : "lazy";
}

/** Idle unload disabled when `TDLIB_CLIENT_IDLE=off` or idle ms is 0. */
export function isTdlibClientIdleEnabled(): boolean {
  const flag = (process.env.TDLIB_CLIENT_IDLE || "auto").trim().toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return false;
  return getTdlibClientIdleMs() > 0;
}

/** Close unused in-memory TDLib clients after this idle window (auth stays on disk). */
export function getTdlibClientIdleMs(): number {
  const raw = (process.env.TDLIB_CLIENT_IDLE_MS || "900000").trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 900_000;
  return n;
}

export function getTdlibClientIdleCheckMs(): number {
  const raw = (process.env.TDLIB_CLIENT_IDLE_CHECK_MS || "60000").trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 5_000) return 60_000;
  return n;
}

export function getTdlibUserDir(telegramUsername: string): string {
  const safe = telegramUsername.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getTdlibDbRoot(), safe);
}

export function getGatewayBindHost(): string {
  return (process.env.TDLIB_GATEWAY_HOST || "127.0.0.1").trim();
}

export function getGatewayPort(): number {
  // Railway (and similar) inject PORT; local dev uses TDLIB_GATEWAY_PORT or 8787.
  const raw = process.env.TDLIB_GATEWAY_PORT || process.env.PORT || "8787";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8787;
}

export function getGatewaySecret(): string {
  return (process.env.TDLIB_GATEWAY_SECRET || "dev-local-tdlib-gateway-secret").trim();
}

export function getGatewayBaseUrl(): string {
  const explicit = (process.env.TDLIB_GATEWAY_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  return `http://127.0.0.1:${getGatewayPort()}`;
}

/**
 * Public HTTPS origin browsers use for direct SSE.
 * Prefer `TDLIB_GATEWAY_PUBLIC_URL` when the internal URL differs; else reuse
 * `TDLIB_GATEWAY_URL` when it is already a browser-reachable https origin.
 */
export function getGatewayPublicBaseUrl(): string | null {
  const publicUrl = (process.env.TDLIB_GATEWAY_PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (publicUrl) return publicUrl;
  const base = getGatewayBaseUrl();
  if (/^https:\/\//i.test(base)) return base;
  // Local gateway is fine for local web (and EventSource to localhost).
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(base)) return base;
  return null;
}

export function getTelegramApiCredentials(): { apiId: number; apiHash: string } | null {
  const apiIdRaw = (process.env.TELEGRAM_API_ID || "").trim();
  const apiHash = (process.env.TELEGRAM_API_HASH || "").trim();
  const apiId = Number.parseInt(apiIdRaw, 10);
  if (!apiIdRaw || !Number.isFinite(apiId) || !apiHash) return null;
  return { apiId, apiHash };
}

export function isGatewayConfiguredForApi(): boolean {
  return Boolean(getTelegramApiCredentials()) || Boolean((process.env.TDLIB_GATEWAY_URL || "").trim());
}
