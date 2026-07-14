import { runQueuedNetworkFetch, type NetworkFetchPriority } from "./networkFetchQueue";
import {
  logMessageMediaDebug,
  logMessageMediaFetchError,
  logMessageMediaFetchResult,
} from "./messageMediaDebug";

export type CachedMessageMedia = {
  bytes: Uint8Array;
  mime: string;
  objectUrl: string;
};

const mediaBlobCache = new Map<string, CachedMessageMedia>();
const inflightMediaFetches = new Map<string, Promise<CachedMessageMedia>>();

/** Keep decoded blobs across row remounts / visibility flicker (tdesktop photo cache). */
export function getCachedMessageMedia(uri: string): CachedMessageMedia | null {
  return mediaBlobCache.get(uri) ?? null;
}

function storeMessageMedia(
  uri: string,
  bytes: Uint8Array,
  mime: string,
): CachedMessageMedia {
  const existing = mediaBlobCache.get(uri);
  if (existing) return existing;
  const objectUrl = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], {
      type: mime || "application/octet-stream",
    }),
  );
  const entry: CachedMessageMedia = { bytes, mime, objectUrl };
  mediaBlobCache.set(uri, entry);
  return entry;
}

async function fetchMessageMediaOnce(
  uri: string,
  phase: "preview" | "full",
  debugContext?: Record<string, unknown>,
): Promise<CachedMessageMedia> {
  const cached = mediaBlobCache.get(uri);
  if (cached) return cached;

  logMessageMediaDebug("fetch_start", { phase, uri, ...debugContext });
  let response: Response;
  try {
    response = await fetch(uri, {
      method: "GET",
      credentials: "include",
    });
  } catch (err) {
    logMessageMediaFetchError(phase, uri, err, debugContext);
    throw err;
  }
  if (!response.ok) {
    logMessageMediaFetchError(phase, uri, new Error(`HTTP_${response.status}`), {
      httpStatus: response.status,
      ...debugContext,
    });
    throw new Error(`HTTP_${response.status}`);
  }
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const mime = (blob.type || response.headers.get("Content-Type") || "").trim();
  logMessageMediaFetchResult(phase, uri, response, bytes, debugContext);
  return storeMessageMedia(uri, bytes, mime);
}

/**
 * Fetch message media into the shared cache. Continues even if a row unmounts so
 * fast scroll does not abort / re-download the same photo (tdesktop-like).
 */
export function fetchCachedMessageMedia(
  uri: string,
  phase: "preview" | "full",
  options?: {
    priority?: NetworkFetchPriority;
    debugContext?: Record<string, unknown>;
  },
): Promise<CachedMessageMedia> {
  const cached = mediaBlobCache.get(uri);
  if (cached) return Promise.resolve(cached);

  const inflight = inflightMediaFetches.get(uri);
  if (inflight) return inflight;

  const priority = options?.priority ?? (phase === "full" ? "high" : "normal");
  const promise = runQueuedNetworkFetch(
    () => fetchMessageMediaOnce(uri, phase, options?.debugContext),
    { priority },
  ).finally(() => {
    inflightMediaFetches.delete(uri);
  });
  inflightMediaFetches.set(uri, promise);
  return promise;
}

/** Remove a bad/thumbnail response so remounts do not hydrate it as full media. */
export function forgetCachedMessageMedia(uri: string): void {
  const entry = mediaBlobCache.get(uri);
  if (!entry) return;
  mediaBlobCache.delete(uri);
  try {
    URL.revokeObjectURL(entry.objectUrl);
  } catch {
    /* already revoked */
  }
}

/** Kick off a background fill of the media cache (viewport prefetch ring). */
export function prefetchMessageMedia(
  uri: string,
  options?: { priority?: NetworkFetchPriority; preview?: boolean },
): void {
  if (!uri || mediaBlobCache.has(uri) || inflightMediaFetches.has(uri)) return;
  const phase = options?.preview ? "preview" : "full";
  void fetchCachedMessageMedia(uri, phase, {
    priority: options?.priority ?? "normal",
  }).catch(() => {
    /* visible row handles failure */
  });
}
