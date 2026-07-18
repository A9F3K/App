import { appLog, appWarn } from "../../../shared/appLog";

const TAG = "[message-media]";

/** Hot-path mount/fetch spam freezes DevTools — enable with `window.__HSP_MEDIA_DEBUG__ = true`. */
const MEDIA_DEBUG =
  typeof window !== "undefined" &&
  Boolean((window as { __HSP_MEDIA_DEBUG__?: boolean }).__HSP_MEDIA_DEBUG__);

function bytesHexPrefix(bytes: Uint8Array, max = 12): string {
  const slice = bytes.subarray(0, Math.min(bytes.length, max));
  return [...slice].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Detect container/format from magic bytes + mime. */
export function describeMediaBytes(bytes: Uint8Array, mime: string): {
  byteLength: number;
  mime: string;
  magicHex: string;
  detectedFormat: string;
  looksLikeJpeg: boolean;
  looksLikePng: boolean;
  looksLikeWebp: boolean;
  looksLikeGif: boolean;
  looksLikeMp4: boolean;
} {
  const magicHex = bytesHexPrefix(bytes);
  const head = magicHex.toLowerCase();
  const normalizedMime = mime.trim().toLowerCase();
  const looksLikeJpeg = head.startsWith("ffd8ff");
  const looksLikePng = head.startsWith("89504e47");
  const looksLikeGif = head.startsWith("47494638");
  const looksLikeWebp = head.length >= 8 && head.startsWith("52494646") && bytes.length >= 12;
  const looksLikeMp4 =
    bytes.length >= 12 &&
    (String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp" ||
      normalizedMime.startsWith("video/"));

  let detectedFormat = "unknown";
  if (looksLikeJpeg) detectedFormat = "jpeg";
  else if (looksLikePng) detectedFormat = "png";
  else if (looksLikeGif) detectedFormat = "gif";
  else if (looksLikeWebp) detectedFormat = "webp";
  else if (looksLikeMp4) detectedFormat = "mp4";
  else if (normalizedMime.startsWith("image/")) detectedFormat = `image:${normalizedMime}`;
  else if (normalizedMime.startsWith("video/")) detectedFormat = `video:${normalizedMime}`;

  return {
    byteLength: bytes.length,
    mime: normalizedMime || "application/octet-stream",
    magicHex,
    detectedFormat,
    looksLikeJpeg,
    looksLikePng,
    looksLikeWebp,
    looksLikeGif,
    looksLikeMp4,
  };
}

export function logMessageMediaDebug(
  event: string,
  details: Record<string, unknown>,
  level: "log" | "warn" = "log",
): void {
  if (level === "warn") {
    appWarn(TAG, event, details);
    return;
  }
  if (!MEDIA_DEBUG) return;
  appLog(TAG, event, details);
}

export function logMessageMediaFetchResult(
  phase: "preview" | "full",
  uri: string,
  response: Response,
  bytes: Uint8Array,
  extra?: Record<string, unknown>,
): void {
  const analysis = describeMediaBytes(bytes, response.headers.get("Content-Type") ?? "");
  logMessageMediaDebug("fetch_result", {
    phase,
    uri,
    httpStatus: response.status,
    ok: response.ok,
    contentType: response.headers.get("Content-Type"),
    contentLength: response.headers.get("Content-Length"),
    ...analysis,
    ...extra,
  });
}

export function logMessageMediaFetchError(
  phase: "preview" | "full",
  uri: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  logMessageMediaDebug(
    "fetch_error",
    {
      phase,
      uri,
      err: err instanceof Error ? err.message : String(err),
      ...extra,
    },
    "warn",
  );
}
