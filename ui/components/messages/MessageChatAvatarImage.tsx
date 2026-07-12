import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image } from "expo-image";
import type { ImageStyle, StyleProp } from "react-native";
import { Platform, StyleSheet } from "react-native";
import { runQueuedNetworkFetch, type NetworkFetchPriority } from "./networkFetchQueue";

function needsAuthenticatedFetch(uri: string): boolean {
  return uri.includes("/api/telegram-messages-avatar");
}

/** Reuse blob URLs so avatar proxy images do not refetch on every list re-render. */
const avatarBlobCache = new Map<string, string>();
const avatarFailedUrls = new Set<string>();
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
  return avatarFailedUrls.has(uri);
}

async function fetchAvatarBlobOnce(uri: string): Promise<string | null> {
  if (!needsAuthenticatedFetch(uri)) return uri;
  if (avatarFailedUrls.has(uri)) return null;
  const cached = avatarBlobCache.get(uri);
  if (cached) return cached;

  const response = await fetch(uri, { method: "GET", credentials: "include" });
  if (!response.ok) {
    if (response.status === 404 || response.status === 403) {
      avatarFailedUrls.add(uri);
      notifyAvatarCacheListeners();
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
  void runQueuedNetworkFetch(() => fetchAvatarBlob(uri), {
    priority: options?.priority ?? "normal",
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

    const cached = readCachedDisplayUri(uri);
    if (cached) {
      setDisplayUri(cached);
      return;
    }

    let cancelled = false;

    void runQueuedNetworkFetch(async () => {
      const next = await fetchAvatarBlob(uri);
      if (!cancelled) {
        if (next) setDisplayUri(next);
        else onErrorRef.current?.(new Error("avatar_unavailable"));
      }
    }, { priority: fetchPriority });

    return () => {
      cancelled = true;
    };
  }, [uri, loadEnabled, fetchPriority, cacheRevision]);

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
