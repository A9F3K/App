import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image } from "expo-image";
import type { ImageStyle, StyleProp } from "react-native";
import { Platform, StyleSheet } from "react-native";
import { runQueuedNetworkFetch, type NetworkFetchPriority } from "./networkFetchQueue";
import { isVoiceDialogUiOpen, subscribeVoiceDialogUiOpen } from "./voiceDialogUiGate";

function needsAuthenticatedFetch(uri: string): boolean {
  return uri.includes("/api/telegram-messages-avatar");
}

/** Reuse blob URLs so avatar proxy images do not refetch on every list re-render. */
const avatarBlobCache = new Map<string, string>();
const avatarFailedUrls = new Set<string>();
/** Wall-clock of sticky 404/403 — expire so voice roster can recover after a cold miss. */
const avatarFailedAtMs = new Map<string, number>();
const AVATAR_FAIL_TTL_MS = 45_000;
const inflightAvatarFetches = new Map<string, Promise<string | null>>();
const avatarCacheListeners = new Set<() => void>();
let avatarCacheRevision = 0;

function notifyAvatarCacheListeners(): void {
  avatarCacheRevision += 1;
  for (const listener of avatarCacheListeners) {
    listener();
  }
}

function subscribeAvatarCache(listener: () => void): () => void {
  avatarCacheListeners.add(listener);
  return () => {
    avatarCacheListeners.delete(listener);
  };
}

function getAvatarCacheRevision(): number {
  return avatarCacheRevision;
}

function readCachedDisplayUri(uri: string): string | null {
  if (!needsAuthenticatedFetch(uri)) return uri;
  return avatarBlobCache.get(uri) ?? null;
}

export function isMessageChatAvatarBlobCached(uri: string): boolean {
  return readCachedDisplayUri(uri) != null;
}

export function isMessageChatAvatarFetchFailed(uri: string): boolean {
  if (!avatarFailedUrls.has(uri)) return false;
  const at = avatarFailedAtMs.get(uri) ?? 0;
  if (Date.now() - at > AVATAR_FAIL_TTL_MS) {
    avatarFailedUrls.delete(uri);
    avatarFailedAtMs.delete(uri);
    return false;
  }
  return true;
}

async function fetchAvatarBlobOnce(uri: string): Promise<string | null> {
  if (!needsAuthenticatedFetch(uri)) return uri;
  if (avatarFailedUrls.has(uri)) return null;
  const cached = avatarBlobCache.get(uri);
  if (cached) return cached;

  const response = await fetch(uri, { method: "GET", credentials: "include" });
  if (!response.ok) {
    if (response.status === 404 || response.status === 403) {
      // Record the miss but do NOT notify every avatar subscriber — a burst of
      // 404s used to bump cacheRevision and re-run effects for every mounted
      // avatar on the page (chat list + history + voice dialog), freezing the UI.
      // TTL so a cold TDLib miss does not permanently leave voice rows on letters.
      avatarFailedUrls.add(uri);
      avatarFailedAtMs.set(uri, Date.now());
    }
    return null;
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  avatarBlobCache.set(uri, objectUrl);
  notifyAvatarCacheListeners();
  return objectUrl;
}

async function fetchAvatarBlob(uri: string): Promise<string | null> {
  if (!needsAuthenticatedFetch(uri)) return uri;
  if (avatarFailedUrls.has(uri)) return null;
  const cached = avatarBlobCache.get(uri);
  if (cached) return cached;

  const inflight = inflightAvatarFetches.get(uri);
  if (inflight) return inflight;

  const promise = fetchAvatarBlobOnce(uri).finally(() => {
    inflightAvatarFetches.delete(uri);
  });
  inflightAvatarFetches.set(uri, promise);
  return promise;
}

/** Populate the shared avatar blob cache (open-chat prefetch). */
export function prefetchMessageChatAvatar(
  uri: string,
  options?: { priority?: NetworkFetchPriority },
): void {
  if (!uri || isMessageChatAvatarBlobCached(uri) || isMessageChatAvatarFetchFailed(uri)) return;
  const priority = options?.priority ?? "normal";
  // Chat-list avatar storms mid-voice-dialog froze Close after the first green mic.
  if (isVoiceDialogUiOpen() && priority === "normal") return;
  void runQueuedNetworkFetch(() => fetchAvatarBlob(uri), {
    priority,
  }).catch(() => {
    /* row onError handles visible failures */
  });
}

type Props = {
  uri: string;
  sizePx: number;
  style?: StyleProp<ImageStyle>;
  /** Fill the parent slot instead of a fixed pixel box. */
  fill?: boolean;
  /** When false, skip proxy fetch until the row scrolls into view. */
  loadEnabled?: boolean;
  fetchPriority?: NetworkFetchPriority;
  onLoad?: () => void;
  onError?: (error?: unknown) => void;
};

/** Renders chat avatars; API proxy URLs are fetched with session cookies (required on web). */
export function MessageChatAvatarImage({
  uri,
  sizePx,
  style,
  fill = false,
  loadEnabled = true,
  fetchPriority = "normal",
  onLoad,
  onError,
}: Props) {
  const cacheRevision = useSyncExternalStore(
    subscribeAvatarCache,
    getAvatarCacheRevision,
    getAvatarCacheRevision,
  );
  const voiceDialogOpen = useSyncExternalStore(
    subscribeVoiceDialogUiOpen,
    isVoiceDialogUiOpen,
    () => false,
  );
  const [displayUri, setDisplayUri] = useState<string | null>(() => readCachedDisplayUri(uri));
  const onLoadRef = useRef(onLoad);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onLoadRef.current = onLoad;
    onErrorRef.current = onError;
  }, [onLoad, onError]);

  useEffect(() => {
    const cached = readCachedDisplayUri(uri);
    if (cached) {
      setDisplayUri(cached);
    }
  }, [uri, cacheRevision]);

  useEffect(() => {
    if (!loadEnabled) return;
    if (isMessageChatAvatarFetchFailed(uri)) return;
    // Pause list/history avatar HTTP while the voice sheet is open. Voice roster
    // uses high/critical and stays allowed.
    if (isVoiceDialogUiOpen() && fetchPriority === "normal") return;

    const cached = readCachedDisplayUri(uri);
    if (cached) {
      setDisplayUri(cached);
      return;
    }

    let cancelled = false;

    void runQueuedNetworkFetch(async () => {
      if (cancelled) return;
      if (isVoiceDialogUiOpen() && fetchPriority === "normal") return;
      const next = await fetchAvatarBlob(uri);
      if (!cancelled) {
        if (next) setDisplayUri(next);
        else onErrorRef.current?.(new Error("avatar_unavailable"));
      }
    }, { priority: fetchPriority });

    return () => {
      cancelled = true;
    };
    // Intentionally omit cacheRevision — a successful sibling fetch must not
    // re-queue every other avatar's network effect (that froze the voice dialog).
    // voiceDialogOpen: resume normal fetches after the sheet closes.
  }, [uri, loadEnabled, fetchPriority, voiceDialogOpen]);

  if (!displayUri) return null;

  return (
    <Image
      source={{ uri: displayUri }}
      accessibilityIgnoresInvertColors
      onLoad={() => onLoadRef.current?.()}
      onError={(event) => onErrorRef.current?.(event.error ?? "unknown_avatar_error")}
      style={[
        fill
          ? [StyleSheet.absoluteFillObject, { borderRadius: 0 }]
          : { width: sizePx, height: sizePx, borderRadius: 0 },
        Platform.OS === "web"
          ? ({ display: "block", objectFit: "cover" } as const)
          : null,
        style,
      ]}
      contentFit="cover"
    />
  );
}
