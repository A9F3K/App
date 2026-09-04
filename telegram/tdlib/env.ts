import fs from "fs";
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

function safeTdlibUserKey(telegramUsername: string): string {
  return telegramUsername.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function messengerSlotFile(telegramUsername: string): string {
  return path.join(getTdlibDbRoot(), `${safeTdlibUserKey(telegramUsername)}.active-slot`);
}

const messengerSlotMemory = new Map<string, number>();

export function getMessengerSlot(telegramUsername: string): number {
  const key = safeTdlibUserKey(telegramUsername);
  const mem = messengerSlotMemory.get(key);
  if (typeof mem === "number" && mem >= 0) return mem;
  try {
    const raw = fs.readFileSync(messengerSlotFile(telegramUsername), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) {
      messengerSlotMemory.set(key, n);
      return n;
    }
  } catch {
    /* missing file = slot 0 */
  }
  messengerSlotMemory.set(key, 0);
  return 0;
}

export function setMessengerSlot(telegramUsername: string, slot: number): void {
  const n = Number.isFinite(slot) && slot >= 0 ? Math.floor(slot) : 0;
  const key = safeTdlibUserKey(telegramUsername);
  messengerSlotMemory.set(key, n);
  try {
    fs.mkdirSync(getTdlibDbRoot(), { recursive: true });
    fs.writeFileSync(messengerSlotFile(telegramUsername), String(n), "utf8");
  } catch {
    /* best effort */
  }
}

export function messengerSlotDirName(telegramUsername: string, slot: number): string {
  const safe = safeTdlibUserKey(telegramUsername);
  return slot <= 0 ? safe : `${safe}__s${slot}`;
}

/** On-disk TDLib folders for this HSP user (slot 0 is the original directory). */
export function listMessengerSlots(telegramUsername: string): number[] {
  const root = getTdlibDbRoot();
  const safe = safeTdlibUserKey(telegramUsername);
  const found = new Set<number>();
  if (fs.existsSync(path.join(root, safe, "db"))) found.add(0);
  if (!fs.existsSync(root)) return [...found].sort((a, b) => a - b);
  const prefix = `${safe}__s`;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const n = Number.parseInt(entry.name.slice(prefix.length), 10);
    if (!Number.isFinite(n) || n < 1) continue;
    if (fs.existsSync(path.join(root, entry.name, "db"))) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

export function allocateNextMessengerSlot(telegramUsername: string): number {
  const used = new Set(listMessengerSlots(telegramUsername));
  let slot = 0;
  while (used.has(slot)) slot += 1;
  return slot;
}

export function getTdlibUserDir(telegramUsername: string): string {
  const slot = getMessengerSlot(telegramUsername);
  return path.join(getTdlibDbRoot(), messengerSlotDirName(telegramUsername, slot));
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
