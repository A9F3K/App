import { buildApiUrl } from "../../../api/_base";
import { bytesLookLikeTgs, bytesLookLikeVideo } from "./loadTgsAnimation";
import { runQueuedNetworkFetch, type NetworkFetchPriority } from "./networkFetchQueue";
import { telegramEmojiDebug } from "./telegramEmojiDebug";

export type TelegramEmojiFetchRef =
  | { kind: "custom"; customEmojiId: string }
  | { kind: "animated"; emoji: string };

export type TelegramEmojiAsset = {
  bytes: Uint8Array;
  mime: string;
};

const bytesCache = new Map<string, TelegramEmojiAsset>();
const unavailableCache = new Set<string>();
const inflightFetches = new Map<string, Promise<TelegramEmojiAsset | null>>();
let fetchGeneration = 0;

function isTransientEmojiHttpStatus(status: number): boolean {
  return status === 403 || status === 429 || status === 502 || status === 503 || status === 504;
}

/** Clear failed-fetch blacklist so emojis retry after Telegram connects or gateway warms up. */
export function resetTelegramEmojiFetchCaches(): void {
  unavailableCache.clear();
  fetchGeneration += 1;
}

export function getTelegramEmojiFetchGeneration(): number {
  return fetchGeneration;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(ref: TelegramEmojiFetchRef): string {
  return ref.kind === "custom" ? `custom:${ref.customEmojiId}` : `animated:${ref.emoji}`;
}

function resolveMime(mime: string, bytes: Uint8Array): string {
  if (mime && mime !== "application/octet-stream") return mime;
  if (bytesLookLikeTgs(bytes)) return "application/x-tgsticker";
  if (bytesLookLikeVideo(bytes)) return "video/webm";
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    if (riff === "RIFF") return "image/webp";
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  return mime || "application/octet-stream";
}

async function fetchTelegramEmojiAssetOnce(
  ref: TelegramEmojiFetchRef,
  key: string,
  options?: { priority?: NetworkFetchPriority },
): Promise<TelegramEmojiAsset | null> {
  const params = new URLSearchParams();
  if (ref.kind === "custom") {
    params.set("custom_emoji_id", ref.customEmojiId);
  } else {
    params.set("emoji", ref.emoji);
  }

  const url = buildApiUrl(`/api/telegram-messages-custom-emoji?${params.toString()}`);
  telegramEmojiDebug.fetchStart(ref, url);
  try {
    return await runQueuedNetworkFetch(async () => {
      let response = await fetch(url, { credentials: "include" });
      if (!response.ok && isTransientEmojiHttpStatus(response.status)) {
        await sleep(800);
        response = await fetch(url, { credentials: "include" });
      }
      const contentType = response.headers.get("Content-Type");
      if (!response.ok) {
        telegramEmojiDebug.fetchHttpResult(ref, response.status, contentType, 0);
        if (response.status === 404 || !isTransientEmojiHttpStatus(response.status)) {
          unavailableCache.add(key);
        }
        return null;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      telegramEmojiDebug.fetchHttpResult(ref, response.status, contentType, bytes.length);
      if (bytes.length === 0) {
        telegramEmojiDebug.fetchEmptyBody(ref);
        unavailableCache.add(key);
        return null;
      }
      const mime = resolveMime(contentType || "", bytes);
      const asset = { bytes, mime };
      bytesCache.set(key, asset);
      return asset;
    }, { priority: options?.priority ?? "normal" });
  } catch (err) {
    telegramEmojiDebug.fetchNetworkError(ref, err);
    return null;
  }
}

export async function fetchTelegramEmojiAsset(
  ref: TelegramEmojiFetchRef,
  options?: { priority?: NetworkFetchPriority },
): Promise<TelegramEmojiAsset | null> {
  const key = cacheKey(ref);
  if (unavailableCache.has(key)) {
    telegramEmojiDebug.fetchUnavailableCached(ref);
    return null;
  }
  const cached = bytesCache.get(key);
  if (cached) {
    telegramEmojiDebug.fetchCacheHit(ref, cached.mime, cached.bytes.length);
    return cached;
  }

  const inflight = inflightFetches.get(key);
  if (inflight) return inflight;

  const promise = fetchTelegramEmojiAssetOnce(ref, key, options).finally(() => {
    inflightFetches.delete(key);
  });
  inflightFetches.set(key, promise);
  return promise;
}

/** @deprecated Use {@link fetchTelegramEmojiAsset}. */
export async function fetchCustomEmojiBytes(customEmojiId: string): Promise<Uint8Array | null> {
  const asset = await fetchTelegramEmojiAsset({ kind: "custom", customEmojiId });
  return asset?.bytes ?? null;
}
