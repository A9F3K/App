import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image } from "expo-image";
import type { ImageStyle, StyleProp } from "react-native";
import { Platform, StyleSheet } from "react-native";
import { runQueuedNetworkFetch, type NetworkFetchPriority } from "./networkFetchQueue";

function needsAuthenticatedFetch(uri: string): boolean {
  return uri.includes("/api/telegram-messages-profile-audio-cover");
}

const coverBlobCache = new Map<string, string>();
const coverFailedUrls = new Set<string>();
const coverFailedAtMs = new Map<string, number>();
const COVER_FAIL_TTL_MS = 45_000;
const inflightCoverFetches = new Map<string, Promise<string | null>>();
const coverCacheListeners = new Set<() => void>();
let coverCacheRevision = 0;

function notifyCoverCacheListeners(): void {
  coverCacheRevision += 1;
  for (const listener of coverCacheListeners) {
    listener();
  }
}

function subscribeCoverCache(listener: () => void): () => void {
  coverCacheListeners.add(listener);
  return () => {
    coverCacheListeners.delete(listener);
  };
}

function getCoverCacheRevision(): number {
  return coverCacheRevision;
}

function readCachedDisplayUri(uri: string): string | null {
  if (!needsAuthenticatedFetch(uri)) return uri;
  return coverBlobCache.get(uri) ?? null;
}

export function prefetchMessageChatProfileAudioCover(
  uri: string,
  options?: { priority?: NetworkFetchPriority },
): void {
  if (!uri || isMessageChatProfileAudioCoverFetchFailed(uri)) return;
  if (readCachedDisplayUri(uri)) return;
  void runQueuedNetworkFetch(() => fetchCoverBlob(uri), {
    priority: options?.priority ?? "normal",
  }).catch(() => {
    /* row onError handles visible failures */
  });
}

export function isMessageChatProfileAudioCoverFetchFailed(uri: string): boolean {
  if (!coverFailedUrls.has(uri)) return false;
  const at = coverFailedAtMs.get(uri) ?? 0;
  if (Date.now() - at > COVER_FAIL_TTL_MS) {
    coverFailedUrls.delete(uri);
    coverFailedAtMs.delete(uri);
    return false;
  }
  return true;
}

async function fetchCoverBlobOnce(uri: string): Promise<string | null> {
  if (!needsAuthenticatedFetch(uri)) return uri;
  if (coverFailedUrls.has(uri)) return null;
  const cached = coverBlobCache.get(uri);
  if (cached) return cached;

  const response = await fetch(uri, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 403) {
      coverFailedUrls.add(uri);
      coverFailedAtMs.set(uri, Date.now());
    }
    return null;
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  coverBlobCache.set(uri, objectUrl);
  notifyCoverCacheListeners();
  return objectUrl;
}

async function fetchCoverBlob(uri: string): Promise<string | null> {
  if (!needsAuthenticatedFetch(uri)) return uri;
  if (coverFailedUrls.has(uri)) return null;
  const cached = coverBlobCache.get(uri);
  if (cached) return cached;

  const inflight = inflightCoverFetches.get(uri);
  if (inflight) return inflight;

  const promise = fetchCoverBlobOnce(uri).finally(() => {
    inflightCoverFetches.delete(uri);
  });
  inflightCoverFetches.set(uri, promise);
  return promise;
}

type Props = {
  uri: string;
  sizePx: number;
  style?: StyleProp<ImageStyle>;
  loadEnabled?: boolean;
  fetchPriority?: NetworkFetchPriority;
  onLoad?: () => void;
  onError?: (error?: unknown) => void;
};

/** Profile playlist covers; API proxy URLs require session cookies on web. */
export function MessageChatProfileAudioCoverImage({
  uri,
  sizePx,
  style,
  loadEnabled = true,
  fetchPriority = "normal",
  onLoad,
  onError,
}: Props) {
  const cacheRevision = useSyncExternalStore(
    subscribeCoverCache,
    getCoverCacheRevision,
    getCoverCacheRevision,
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
    if (cached) setDisplayUri(cached);
  }, [uri, cacheRevision]);

  useEffect(() => {
    if (!loadEnabled) return;
    if (isMessageChatProfileAudioCoverFetchFailed(uri)) return;

    const cached = readCachedDisplayUri(uri);
    if (cached) {
      setDisplayUri(cached);
      return;
    }

    let cancelled = false;

    void runQueuedNetworkFetch(async () => {
      if (cancelled) return;
      const next = await fetchCoverBlob(uri);
      if (!cancelled) {
        if (next) setDisplayUri(next);
        else onErrorRef.current?.(new Error("cover_unavailable"));
      }
    }, { priority: fetchPriority });

    return () => {
      cancelled = true;
    };
  }, [uri, loadEnabled, fetchPriority]);

  if (!displayUri) return null;

  return (
    <Image
      source={{ uri: displayUri }}
      accessibilityIgnoresInvertColors
      onLoad={() => onLoadRef.current?.()}
      onError={(event) => onErrorRef.current?.(event.error ?? "unknown_cover_error")}
      style={[
        { width: sizePx, height: sizePx, borderRadius: 0 },
        Platform.OS === "web"
          ? ({ display: "block", objectFit: "cover" } as const)
          : null,
        style,
      ]}
      {...(Platform.OS === "web"
        ? ({ fetchpriority: fetchPriority === "critical" || fetchPriority === "high" ? "high" : "auto" } as object)
        : {})}
    />
  );
}
